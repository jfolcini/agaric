//! #535 — boot replay of leftover write-ahead Loro-sync inbox slots.
//!
//! [`apply_remote`](crate::sync_protocol::loro_sync::apply_remote) durably
//! INSERTs each inbound message's raw bytes into `loro_sync_inbox` BEFORE
//! importing them into the engine, and DELETEs the row inside the SAME tx as
//! the SQL projection. A crash in that window leaves a row behind: the engine
//! (and the periodically-persisted `loro_doc_state`) may be ahead of SQL, but
//! `op_log` never carries remote Loro-only data, so the op-log replay step
//! cannot reconstruct it. This step re-runs the import+project for each
//! leftover slot, which both reconciles SQL and clears the slot.
//!
//! Re-import is idempotent (Loro import is idempotent; SQL projections are
//! upserts), so replaying a slot whose projection had actually committed
//! before the crash — or replaying the same slot across two boots — is safe.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::loro::registry::LoroEngineRegistry;
use crate::materializer::Materializer;

/// Replay every leftover row in `loro_sync_inbox`, oldest first.
///
/// For each row, re-runs the sync import+project path (which deletes the row
/// in-tx on success). Per-row errors are logged and collected; processing
/// continues with the remaining rows — the same "log + continue" philosophy
/// the op-log replay and draft-recovery steps use, so a single poison slot
/// cannot block boot.
///
/// # Inbound cache/FTS fan-out (#2541)
///
/// The live inbound path always follows `import_and_project` with
/// [`Materializer::enqueue_inbound_sync_rebuilds`] (see
/// `session_state_machine.rs`) because the per-block projection does NOT
/// refresh the derived read caches or the FTS index. This boot replay runs
/// the SAME import+project, so it owes the same fan-out: the per-row
/// `(changed, purged)` sets are accumulated (deduped) across the whole walk
/// and `enqueue_inbound_sync_rebuilds` is fired ONCE at the end. No other
/// boot step compensates — `cache_refresh` covers recovered-draft ids only,
/// and the `lib.rs` FTS rebuild fires only when the index is empty — so
/// skipping this left remote content invisible to search until an unrelated
/// full rebuild. A fan-out enqueue failure is non-fatal (logged), matching
/// the live path's convention: the projections have already committed.
///
/// # Bounded memory (#1574)
///
/// Each inbox row carries a *raw Loro-sync blob* (`bytes`), so the table can
/// hold many multi-KB-to-MB payloads after a crash storm. A single
/// `.fetch_all` would materialize EVERY blob into one `Vec` at boot — an OOM
/// risk. This walks the table in id-ascending chunks of
/// [`REPLAY_CHUNK_SIZE`](crate::recovery::replay::REPLAY_CHUNK_SIZE) (reusing
/// the op-log replay's bound), so at most one chunk's worth of blobs is
/// resident at a time. The walk is re-read by `id > last_seen` each chunk
/// (stateless across chunks — no offset cursor to drift), mirroring
/// [`crate::recovery::replay::replay_unmaterialized_ops`].
///
/// `last_seen` advances past every row we *attempt*, whether it succeeded
/// (row deleted in-tx) or errored (row left as a poison slot for a later
/// boot). Without this, a poison row at the chunk head would be re-fetched
/// forever — an infinite boot loop. Advancing the cursor unconditionally
/// makes the walk monotonic: each row is attempted exactly once per boot,
/// preserving the #792/#1054 poison-slot semantics (drop-or-leave is decided
/// inside `replay_inbox_row`, not here).
///
/// # Purged-space tolerance (#1574)
///
/// A row whose `space_id` no longer exists in the `spaces` registry (the
/// space block was purged after the crash but before this replay) does NOT
/// wedge boot: `import_and_project` stamps `blocks.space_id` via a
/// `(SELECT id FROM spaces WHERE id = ?)` subquery (loro projection #708), so
/// the FK can never fire — the blocks import with a NULL `space_id` and the
/// inbox row is cleared. We emit one `tracing::warn!` per purged-space row so
/// the condition is visible in logs rather than silent.
///
/// Returns the number of slots successfully replayed (and thereby cleared).
pub async fn replay_sync_inbox(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    materializer: &Materializer,
) -> Result<u64, AppError> {
    use crate::recovery::replay::REPLAY_CHUNK_SIZE;
    use std::collections::HashSet;

    let mut replayed: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    // #2541: accumulate the per-row changed / tombstone-purged block ids so
    // the inbound cache/FTS fan-out fires exactly once after the walk (sets:
    // the same block can recur across slots; the fan-out is per-id).
    let mut changed_all: HashSet<crate::ulid::BlockId> = HashSet::new();
    let mut purged_all: HashSet<crate::ulid::BlockId> = HashSet::new();
    // FIFO by the AUTOINCREMENT id (authoritative insert order). Start below
    // the smallest possible id (1) so the first chunk includes every row.
    let mut last_seen: i64 = 0;

    // Walk the inbox in id-ascending chunks so at most `REPLAY_CHUNK_SIZE`
    // raw blobs are resident at once (#1574). Re-read by `id > last_seen`
    // each iteration — stateless across chunks, exactly like the op-log walk.
    loop {
        let rows = sqlx::query!(
            "SELECT id, space_id, bytes, purged_ids FROM loro_sync_inbox \
             WHERE id > ? ORDER BY id ASC LIMIT ?",
            last_seen,
            REPLAY_CHUNK_SIZE,
        )
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            break;
        }

        for row in rows {
            // Advance the cursor past this row BEFORE attempting it so a
            // poison slot (left in place by `replay_inbox_row` on error)
            // can never be re-fetched into the next chunk — see fn docs.
            last_seen = last_seen.max(row.id);

            // #1574: surface a purged/unregistered target space. This does
            // NOT block the replay — `import_and_project` tolerates it (the
            // blocks land with a NULL `space_id`); we only log so the
            // condition is observable rather than silent.
            let space_exists: Option<i64> = sqlx::query_scalar!(
                r#"SELECT 1 as "exists!: i64" FROM spaces WHERE id = ?"#,
                row.space_id,
            )
            .fetch_optional(pool)
            .await?;
            if space_exists.is_none() {
                tracing::warn!(
                    inbox_id = row.id,
                    space_id = %row.space_id,
                    "#1574: sync-inbox slot targets a purged/unregistered space — \
                     replaying anyway; projected blocks will land space-less (NULL \
                     space_id) until the space block re-syncs"
                );
            }

            // #2292: decode this row's durable purged-id tombstone (a JSON
            // array written by the crashed apply BEFORE its projection tx).
            // NULL → no purge delta → empty set. A malformed tombstone must
            // NOT wedge boot: log + fall back to empty (the pre-#2292 additive
            // behaviour), never propagate the parse error out of the walk.
            let tombstone_purged: Vec<crate::ulid::BlockId> = match row.purged_ids.as_deref() {
                None => Vec::new(),
                Some(json) => match serde_json::from_str(json) {
                    Ok(ids) => ids,
                    Err(e) => {
                        tracing::warn!(
                            inbox_id = row.id,
                            space_id = %row.space_id,
                            error = %e,
                            "#2292: sync-inbox slot has an unparseable purged_ids \
                             tombstone — re-sweeping nothing from it (additive \
                             fallback still applies)"
                        );
                        Vec::new()
                    }
                },
            };

            match crate::sync_protocol::loro_sync::replay_inbox_row(
                pool,
                registry,
                device_id,
                &row.space_id,
                &row.bytes,
                row.id,
                &tombstone_purged,
            )
            .await
            {
                Ok((changed, purged)) => {
                    replayed += 1;
                    changed_all.extend(changed);
                    purged_all.extend(purged);
                }
                Err(e) => {
                    tracing::error!(
                        inbox_id = row.id,
                        space_id = %row.space_id,
                        error = %e,
                        "sync-inbox replay failed for a slot — leaving it for a later boot"
                    );
                    errors.push(format!("inbox {}: {e}", row.id));
                }
            }
        }
    }

    // #2541: fire the inbound cache/FTS fan-out ONCE for everything the walk
    // imported — the exact rebuild set the live path enqueues after each
    // import (`enqueue_inbound_sync_rebuilds` short-circuits when both sets
    // are empty, #2264). Non-fatal: the projections committed in-tx above,
    // so an enqueue failure (queue closed at shutdown) must not fail boot —
    // log and continue, mirroring the live orchestrator's convention.
    let changed: Vec<crate::ulid::BlockId> = changed_all.into_iter().collect();
    let purged: Vec<crate::ulid::BlockId> = purged_all.into_iter().collect();
    if let Err(e) = materializer
        .enqueue_inbound_sync_rebuilds(&changed, &purged)
        .await
    {
        tracing::warn!(
            error = %e,
            changed = changed.len(),
            purged = purged.len(),
            "#2541: failed to enqueue the inbound cache/FTS fan-out after the \
             sync-inbox replay — derived caches/FTS may be stale until the \
             next inbound sync or local mutation"
        );
    }

    if replayed > 0 || !errors.is_empty() {
        tracing::info!(
            replayed,
            errors = errors.len(),
            "#535: replayed leftover Loro-sync inbox slots at boot"
        );
    }

    Ok(replayed)
}

// ---------------------------------------------------------------------------
// Tests (#1574 — chunked streaming replay + purged-space tolerance)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::engine::LoroEngine;
    use crate::space::SpaceId;
    use tempfile::TempDir;

    const SPACE_A: &str = "01HZ00000000000000000000SP";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("sync_inbox_test.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Deterministically build a valid 26-char ULID-shaped block id from a
    /// counter, using only Crockford-base32 digits (`0-9`, `A`). The exact
    /// id value is irrelevant to the test — only that each is distinct and
    /// the engine accepts it as a tree-node key.
    fn block_id_for(n: usize) -> String {
        // `01HZ` (4) + 22 padded chars = 26.
        format!("01HZ{n:0>22}")
    }

    /// Produce a valid Loro snapshot blob containing a single fresh block.
    ///
    /// Each snapshot is exported from an engine with a DISTINCT `peer_id`
    /// (derived from `block_id`) so Loro treats each block's create op as a
    /// distinct `(peer, counter)` lineage. Reusing one peer id across all
    /// snapshots would make later imports collide with already-known ops
    /// (same peer+counter ⇒ same op), so `import_with_changed_blocks` would
    /// report no changed blocks and those rows would clear without ever
    /// projecting — masking, not exercising, the chunked walk.
    fn snapshot_with_block(block_id: &str, peer_id: &str) -> Vec<u8> {
        let mut e = LoroEngine::with_peer_id(peer_id).expect("engine");
        e.apply_create_block(block_id, "content", "payload", None, 0)
            .expect("create");
        e.export_snapshot().expect("export")
    }

    /// #2292: `purged_ids` is the durable purge tombstone (JSON array of block
    /// ids), or `None` for a non-purge slot (the overwhelmingly common case,
    /// and what the pre-#2292 write-ahead path always stored).
    async fn seed_inbox(pool: &SqlitePool, space_id: &str, bytes: &[u8], purged_ids: Option<&str>) {
        sqlx::query(
            "INSERT INTO loro_sync_inbox (space_id, bytes, purged_ids, created_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(space_id)
        .bind(bytes)
        .bind(purged_ids)
        .bind(crate::db::now_ms())
        .execute(pool)
        .await
        .expect("seed inbox");
    }

    /// #1574: seed MORE than one chunk's worth of inbox rows
    /// (`REPLAY_CHUNK_SIZE + 5`) and assert every row replays (blocks
    /// projected) and is deleted — proving the id-ascending chunked walk
    /// covers the whole table without a single `.fetch_all` of all blobs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_streams_all_rows_across_multiple_chunks_1574() {
        use crate::recovery::replay::REPLAY_CHUNK_SIZE;
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // 205 — spans 2 chunks.
        let row_count = usize::try_from(REPLAY_CHUNK_SIZE).expect("chunk size fits usize") + 5;
        let mut block_ids = Vec::with_capacity(row_count);
        for i in 0..row_count {
            let bid = block_id_for(i);
            let bytes = snapshot_with_block(&bid, &format!("device-{i}"));
            seed_inbox(&pool, space.as_str(), &bytes, None).await;
            block_ids.push(bid);
        }

        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            before,
            i64::try_from(row_count).expect("row_count fits i64"),
            "all rows seeded"
        );

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay_sync_inbox");
        assert_eq!(
            replayed,
            u64::try_from(row_count).expect("row_count fits u64"),
            "every seeded slot must be replayed via the chunked walk"
        );

        // The whole table is cleared (each row deleted in its projection tx).
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(remaining, 0, "all replayed slots must be cleared");

        // Every block — including ones that only the SECOND chunk carried —
        // is projected into SQL, proving the walk advanced past chunk one.
        for bid in &block_ids {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
                .bind(bid)
                .fetch_one(&pool)
                .await
                .expect("count block");
            assert_eq!(n, 1, "block {bid} must be projected after chunked replay");
        }
    }

    /// #1574: an inbox row whose `space_id` is NOT in the `spaces` registry
    /// (the space was purged after the crash) must NOT wedge boot. The row
    /// is replayed (block imported), the slot cleared, and the projected
    /// block lands space-less (NULL `space_id`) per the FK-safe projection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_tolerates_purged_space_row_1574() {
        let (pool, _dir) = test_pool().await;
        // A space id that is deliberately ABSENT from the `spaces` table.
        let purged = SpaceId::from_trusted("01HZ0000000000000000PURGED");
        let bid = block_id_for(7);
        let bytes = snapshot_with_block(&bid, "device-purged");
        seed_inbox(&pool, purged.as_str(), &bytes, None).await;

        // Sanity: the target space really is unregistered.
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM spaces WHERE id = ?")
            .bind(purged.as_str())
            .fetch_optional(&pool)
            .await
            .expect("query spaces");
        assert!(exists.is_none(), "precondition: space must be purged");

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay must NOT wedge boot on a purged space");
        assert_eq!(replayed, 1, "the purged-space slot must still be replayed");

        // Slot cleared (drop, not wedge).
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the purged-space slot must be cleared");

        // The block is projected, but with a NULL space_id (FK-safe subquery).
        let space_id: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
                .bind(&bid)
                .fetch_one(&pool)
                .await
                .expect("block must be projected");
        assert!(
            space_id.is_none(),
            "a purged-space block must land space-less (NULL space_id), not error"
        );
    }

    /// #2292: a non-purge slot (NULL `purged_ids`) replays exactly as before —
    /// the block is projected and the slot cleared, with the new column path
    /// decoding NULL to an empty tombstone (no Pass-D sweep triggered).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_null_purged_ids_slot_behaves_as_before_2292() {
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let bid = block_id_for(3);
        let bytes = snapshot_with_block(&bid, "device-null");

        // Explicit NULL tombstone — the common non-purge write-ahead slot.
        seed_inbox(&pool, space.as_str(), &bytes, None).await;

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay");
        assert_eq!(replayed, 1, "the non-purge slot must replay");

        let projected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(&bid)
            .fetch_one(&pool)
            .await
            .expect("count block");
        assert_eq!(
            projected, 1,
            "the block must be projected on a NULL-tombstone replay"
        );
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the NULL-tombstone slot must be cleared");
    }

    /// #2541: the boot sync-inbox replay must fire the SAME inbound
    /// cache/FTS fan-out the live path runs after `apply_remote`. A slot
    /// whose snapshot carries new content for an already-FTS-indexed block
    /// must leave the FTS row reflecting the NEW content after
    /// `replay_sync_inbox` + `flush_background`. Pre-fix, the changed set
    /// was discarded (`Ok(_changed)`) and the FTS row stayed stale forever —
    /// no other boot step reconciles it (`cache_refresh` covers recovered
    /// drafts only; the `lib.rs` full rebuild fires only on an EMPTY index).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_fires_inbound_fts_fanout_for_changed_blocks_2541() {
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let bid = block_id_for(9);

        // The block already exists in SQL with OLD content, and is already
        // FTS-indexed with that OLD content (as after a previous session).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'old payload', NULL, 0)",
        )
        .bind(&bid)
        .execute(&pool)
        .await
        .expect("seed block");
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, 'old payload')")
            .bind(&bid)
            .execute(&pool)
            .await
            .expect("seed fts");

        // The crashed inbound slot carries the block with NEW content
        // ("payload" — what `snapshot_with_block` writes).
        let bytes = snapshot_with_block(&bid, "device-fts");
        seed_inbox(&pool, space.as_str(), &bytes, None).await;

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay");
        assert_eq!(replayed, 1, "the slot must replay");

        // The projection itself upserted the base row…
        let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(&bid)
            .fetch_one(&pool)
            .await
            .expect("block content");
        assert_eq!(content, "payload", "projection must upsert the new content");

        // …and the fan-out's per-block `UpdateFtsBlock` (enqueued from the
        // accumulated changed set) must reconcile the FTS row once the
        // background queue drains. `update_fts_block` deletes-then-inserts,
        // so exactly one row remains for the block.
        mat.flush_background().await.expect("flush background");
        let stripped: String =
            sqlx::query_scalar("SELECT stripped FROM fts_blocks WHERE block_id = ?")
                .bind(&bid)
                .fetch_one(&pool)
                .await
                .expect("fts row");
        assert_eq!(
            stripped, "payload",
            "#2541: boot sync-inbox replay must fan out UpdateFtsBlock for \
             changed blocks — the FTS row must reflect the imported content"
        );
        mat.shutdown();
    }
}
