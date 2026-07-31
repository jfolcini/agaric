//! #535 — boot replay of leftover write-ahead Loro-sync inbox slots.
//!
//! [`apply_remote`](agaric_sync::sync_protocol::loro_sync::apply_remote) durably
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

use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_engine::loro::registry::LoroEngineRegistry;

/// Replay every leftover row in `loro_sync_inbox`, oldest first.
///
/// Re-runs the sync import+project path (which deletes the replayed rows
/// in-tx on success). Errors are logged and collected; processing continues
/// with the remaining rows — the same "log + continue" philosophy the op-log
/// replay and draft-recovery steps use, so a single poison slot cannot block
/// boot.
///
/// # Batched per space (#3164)
///
/// Within a chunk, the rows of ONE space are replayed as a single batch:
/// `LoroDoc::import_batch` for all of that space's blobs (one detached oplog
/// append per blob, then ONE re-attach ⇒ ONE diff event — see
/// `LoroEngine::import_batch_with_changed_purged_tagscope` for the citation),
/// one union projection, and one transaction that clears every slot in the
/// batch. That collapses N imports + N projections + N write transactions
/// into ~2 per space per chunk. Measured on the 205-row test below: 0.95s →
/// 0.48s wall.
///
/// This does not weaken #535 ("a slot is deleted IFF its projection
/// committed"): the union projection and ALL of the batch's slot DELETEs share
/// one transaction, which commits or rolls back as a unit, and the (non-
/// transactional) engine import happens strictly before that transaction
/// opens — so an import failure clears nothing at all. See
/// `agaric_sync::sync_protocol::loro_sync::replay_inbox_batch` for the full
/// argument and for the per-slot fallback that keeps one poison blob from
/// stranding its space's other slots.
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
/// inside `replay_inbox_batch`, not here). The cursor advances over a whole
/// chunk before any of its batches run (#3164), which is the same guarantee:
/// nothing in the chunk is re-fetched, whatever each batch's outcome.
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
    // #3226: slots moved to durable quarantine during this walk.
    let mut quarantined: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    // #2541: accumulate the per-row changed / tombstone-purged block ids so
    // the inbound cache/FTS fan-out fires exactly once after the walk (sets:
    // the same block can recur across slots; the fan-out is per-id).
    let mut changed_all: HashSet<agaric_core::ulid::BlockId> = HashSet::new();
    let mut purged_all: HashSet<agaric_core::ulid::BlockId> = HashSet::new();
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

        // #3164: rows of the SAME space are replayed as ONE batch (one
        // `import_batch`, one union projection, one tx). Group in first-seen
        // space order, preserving id order inside each group — the batch gate
        // walks a group's blobs in that order against a cumulative version
        // base, so a single peer's linear dep chain still passes.
        let mut groups: Vec<(
            String,
            Vec<agaric_sync::sync_protocol::loro_sync::InboxSlot>,
        )> = Vec::new();

        for row in rows {
            // Advance the cursor past this row BEFORE attempting it so a
            // poison slot (left in place on error) can never be re-fetched
            // into the next chunk — see fn docs.
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
            let tombstone_purged: Vec<agaric_core::ulid::BlockId> = match row.purged_ids.as_deref()
            {
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

            let slot = agaric_sync::sync_protocol::loro_sync::InboxSlot {
                id: row.id,
                bytes: row.bytes,
                tombstone_purged,
            };
            match groups.iter_mut().find(|(s, _)| *s == row.space_id) {
                Some((_, slots)) => slots.push(slot),
                None => groups.push((row.space_id, vec![slot])),
            }
        }

        // Replay each space's slots as one batch. A batch is all-or-nothing at
        // the SQL layer (projection + slot deletes share a tx), and falls back
        // to a per-slot walk internally if the batched engine import fails —
        // so a single poison blob still cannot strand its space's other slots
        // (#3164; #535 unchanged: a slot is cleared iff its projection landed).
        for (space_id, slots) in groups {
            let slot_count = slots.len();
            match agaric_sync::sync_protocol::loro_sync::replay_inbox_batch(
                pool, registry, device_id, &space_id, slots,
            )
            .await
            {
                Ok(outcome) => {
                    replayed += outcome.replayed;
                    // #3226: slots this batch moved to `loro_sync_quarantine`.
                    // Counted separately from `replayed` (nothing was projected)
                    // and from `errors` (they are no longer retried). The boot
                    // report gets the authoritative figure from the quarantine
                    // census in `boot.rs`; this is the per-space log line.
                    quarantined += outcome.quarantined;
                    changed_all.extend(outcome.changed);
                    purged_all.extend(outcome.purged);
                    for err in &outcome.errors {
                        tracing::error!(
                            space_id = %space_id,
                            error = %err,
                            "sync-inbox replay failed for a slot — leaving it for a later boot"
                        );
                    }
                    errors.extend(outcome.errors);
                }
                Err(e) => {
                    // Infra-level failure (e.g. the pool went away) — the
                    // batch cleared nothing, so every one of its slots stays
                    // for a later boot. Log + continue with the next space,
                    // exactly as the per-row walk did on a row error.
                    tracing::error!(
                        space_id = %space_id,
                        slots = slot_count,
                        error = %e,
                        "sync-inbox batch replay failed — leaving the batch's slots \
                         for a later boot"
                    );
                    errors.push(format!("space {space_id} ({slot_count} slots): {e}"));
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
    let changed: Vec<agaric_core::ulid::BlockId> = changed_all.into_iter().collect();
    let purged: Vec<agaric_core::ulid::BlockId> = purged_all.into_iter().collect();
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

    if replayed > 0 || quarantined > 0 || !errors.is_empty() {
        tracing::info!(
            replayed,
            quarantined,
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
    use agaric_engine::loro::engine::LoroEngine;
    use agaric_store::space::SpaceId;
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
    /// distinct `(peer, counter)` lineage. Reusing one peer id across
    /// independently-built FRESH engines would make later imports collide
    /// with already-known ops (same peer+counter ⇒ same op), so
    /// `import_with_changed_blocks` would report no changed blocks and those
    /// rows would clear without ever projecting.
    ///
    /// This is for the SINGLE-slot tests below. The multi-chunk test seeds via
    /// [`chained_update_blobs`] instead, which gets per-row distinctness from
    /// one peer's ascending counters rather than from 205 distinct peers
    /// (#3165) — see that helper for why the distinct-peer shape was wrong.
    fn snapshot_with_block(block_id: &str, peer_id: &str) -> Vec<u8> {
        let mut e = LoroEngine::with_peer_id(peer_id).expect("engine");
        e.apply_create_block(block_id, "content", "payload", None, 0)
            .expect("create");
        e.export_snapshot().expect("export")
    }

    /// Build `count` inbox blobs as ONE remote peer's linear op chain, each
    /// blob an incremental update carrying exactly one new block (#3165).
    ///
    /// Returns `(parent_id, block_ids, blobs)`; `blobs[i]` is the sole
    /// carrier of `block_ids[i]`, and `blobs[0]` additionally carries the
    /// common parent every seeded block hangs under.
    ///
    /// ## Why not `snapshot_with_block` per row
    ///
    /// The pre-#3165 seeding called [`snapshot_with_block`] once per row with
    /// a distinct `device-{i}` peer id. Each such snapshot is a FRESH engine
    /// with empty deps, so importing 205 of them into one doc produced a
    /// 205-wide frontier of mutually-concurrent branches plus 205 root
    /// siblings — a shape production cannot reach: frontier width tracks the
    /// number of concurrent PEERS, not the number of queued messages, and
    /// real inbox leftovers come from one or two peers inside the #535 crash
    /// window. That artificial shape put `find_common_ancestor` (superlinear
    /// in frontier width) and the sibling reprojection (#3162) at their worst
    /// case, so the test's runtime was dominated by its own seeding rather
    /// than by the walk it asserts (#3161).
    ///
    /// ## Why the chunk-boundary assertion is unweakened
    ///
    /// Each blob is an `ExportMode::updates` delta over the version vector
    /// captured before that iteration's create, so it carries ONLY the ops
    /// minted for that one block — not a cumulative snapshot. Row `i` is
    /// therefore still the only row from which `block_ids[i]` can be
    /// projected: a walk that stopped at the chunk boundary would leave the
    /// blocks of the tail rows absent from SQL, exactly as before. The blobs
    /// still replay independently (distinct `(peer, counter)` ops in
    /// ascending causal order — the id-ascending walk visits them in the
    /// order they were minted), so no row clears without projecting.
    ///
    /// Children are APPENDED under a common parent rather than prepended at
    /// `TreeParentId::Root`, so no create shifts an existing sibling's rank.
    fn chained_update_blobs(count: usize) -> (String, Vec<String>, Vec<Vec<u8>>) {
        // Outside the `0..count` range `block_id_for` covers, so it can never
        // collide with a child id.
        let parent_id = block_id_for(999_999);
        let mut engine = LoroEngine::with_peer_id("device-A").expect("engine");
        // Baseline vv of the still-empty doc, so blob 0 carries the parent
        // create as well as the first child's.
        let mut since = engine.version_vector();
        engine
            .apply_create_block(&parent_id, "content", "parent", None, 0)
            .expect("create parent");

        let mut block_ids = Vec::with_capacity(count);
        let mut blobs = Vec::with_capacity(count);
        for i in 0..count {
            let bid = block_id_for(i);
            // `i` == the parent's current child count ⇒ append, no rank shift.
            engine
                .apply_create_block_at(&bid, "content", "payload", Some(&parent_id), i)
                .expect("create child");
            blobs.push(engine.export_update_since(&since).expect("export update"));
            since = engine.version_vector();
            block_ids.push(bid);
        }
        (parent_id, block_ids, blobs)
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
        // #3165: one peer, one linear dep chain — 205 ROWS, not 205 concurrent
        // peers. `blobs[i]` is still the sole carrier of `block_ids[i]`.
        let (parent_id, block_ids, blobs) = chained_update_blobs(row_count);
        assert_eq!(blobs.len(), row_count, "one blob per seeded row");
        for bytes in &blobs {
            seed_inbox(&pool, space.as_str(), bytes, None).await;
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
        // The common parent (carried by the FIRST row) is projected too, and
        // every seeded block is a live child of it — so the per-block counts
        // above are 205 DISTINCT rows, not one block counted 205 times.
        let children: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE parent_id = ? AND deleted_at IS NULL",
        )
        .bind(&parent_id)
        .fetch_one(&pool)
        .await
        .expect("count children");
        assert_eq!(
            children,
            i64::try_from(row_count).expect("row_count fits i64"),
            "every seeded block must be projected as a live child of the common parent"
        );

        // #3165: the replayed doc's frontier must stay NARROW. One peer, one
        // linear dep chain ⇒ exactly one frontier tip, regardless of how many
        // rows were queued. If this ever widens, the seeding drifted back to
        // the artificial mutually-concurrent shape.
        let mut guard = registry
            .for_space(&space, "device-B")
            .expect("engine for space");
        assert_eq!(
            guard.engine_mut().checkpoint_frontiers().len(),
            1,
            "replayed doc must have a width-1 frontier (single-peer dep chain)"
        );
    }

    /// ADVERSARIAL (#3164 review) — the case the change's own tests do NOT
    /// cover: the batched engine import SUCCEEDS and the projection
    /// transaction then FAILS.
    ///
    /// The author's partial-failure test relies on `import_batch`'s up-front
    /// `decode_import_blob_meta` pass rejecting the whole batch
    /// (`loro-internal-1.13.6/src/loro.rs:1409`), so in that test nothing ever
    /// reaches the engine and the tx never opens. This test drives the other
    /// half of claim 4: the engine is genuinely AHEAD of SQL (all blobs
    /// imported) when the Phase-2 tx aborts. #535 requires that ZERO slots be
    /// cleared — the engine-ahead-of-SQL state with every slot still present is
    /// exactly what a later boot heals.
    ///
    /// The abort is injected with a `BEFORE INSERT ON blocks` trigger, which
    /// fails Pass A of the projection *inside* the tx, after the import.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_batch_tx_failure_after_successful_import_clears_nothing_3164_review() {
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let (_parent_id, block_ids, blobs) = chained_update_blobs(3);
        for bytes in &blobs {
            seed_inbox(&pool, space.as_str(), bytes, None).await;
        }

        // Make every projection write to `blocks` abort — the import is
        // untouched, so the failure lands strictly INSIDE the Phase-2 tx.
        sqlx::query(
            "CREATE TRIGGER adversarial_block_insert_abort BEFORE INSERT ON blocks \
             BEGIN SELECT RAISE(ABORT, 'adversarial: projection tx must fail'); END",
        )
        .execute(&pool)
        .await
        .expect("install abort trigger");

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("a failing projection must not fail the boot walk");
        assert_eq!(
            replayed, 0,
            "no slot may be counted as replayed when every projection aborted"
        );

        // The import really happened — otherwise this test would be vacuously
        // asserting an import failure rather than a post-import tx failure.
        {
            let mut guard = registry
                .for_space(&space, "device-B")
                .expect("engine for space A");
            assert!(
                guard
                    .engine_mut()
                    .read_block(&block_ids[0])
                    .expect("read")
                    .is_some(),
                "precondition: the batched import must have landed in the engine, \
                 so the failure under test is the TX, not the import"
            );
        }

        // #535 direction: nothing projected ⇒ nothing cleared.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(
            remaining,
            i64::try_from(blobs.len()).expect("blob count fits i64"),
            "a rolled-back projection must leave EVERY slot of the batch behind"
        );
        let projected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(
            projected, 0,
            "the aborted tx must have rolled back every block row"
        );
    }

    /// #3164 happy path — every row of a space replays in ONE batch: all
    /// blocks projected, ALL slots deleted.
    ///
    /// The 205-row test above proves the batched walk crosses chunk
    /// boundaries; this pins the single-chunk batch itself, and in particular
    /// that batching did not turn "N slots cleared" into "the last slot
    /// cleared" (the shape a mis-scoped in-tx DELETE would produce).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_batch_clears_every_slot_of_a_space_3164() {
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let (parent_id, block_ids, blobs) = chained_update_blobs(4);
        for bytes in &blobs {
            seed_inbox(&pool, space.as_str(), bytes, None).await;
        }

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay");
        assert_eq!(replayed, 4, "every slot in the batch must be replayed");

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(
            remaining, 0,
            "a committed batch must clear ALL of its slots"
        );

        for bid in &block_ids {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
                .bind(bid)
                .fetch_one(&pool)
                .await
                .expect("count block");
            assert_eq!(n, 1, "block {bid} must be projected by the batched replay");
        }
        let children: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE parent_id = ? AND deleted_at IS NULL",
        )
        .bind(&parent_id)
        .fetch_one(&pool)
        .await
        .expect("count children");
        assert_eq!(children, 4, "all four blocks must land under the parent");
    }

    /// #3164 / #535 — a batch in which ONE row cannot be imported must leave
    /// EXACTLY that row's slot behind, and clear every other row's.
    ///
    /// This is the invariant batching puts at risk: "a slot is deleted IFF its
    /// projection committed". The undecodable blob makes `import_batch` fail
    /// (its up-front `decode_import_blob_meta` pass rejects the whole batch),
    /// which must delete nothing and then fall back to a per-slot replay. The
    /// assertions below check BOTH directions of the IFF — no slot survives
    /// whose blocks are in SQL, and no slot is deleted whose blocks are not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_batch_partial_failure_preserves_535_invariant_3164() {
        let (pool, _dir) = test_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let (_parent_id, block_ids, blobs) = chained_update_blobs(3);
        // Poison blob: not a Loro blob at all, so neither the batch import nor
        // the per-slot fallback can ever project it.
        let poison: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01];

        seed_inbox(&pool, space.as_str(), &blobs[0], None).await;
        seed_inbox(&pool, space.as_str(), &blobs[1], None).await;
        seed_inbox(&pool, space.as_str(), &poison, None).await;
        seed_inbox(&pool, space.as_str(), &blobs[2], None).await;

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("a poison slot must never fail the boot walk");
        assert_eq!(
            replayed, 3,
            "the three healthy slots must replay; the poison slot must not be counted"
        );

        // Direction 1 — the poison slot SURVIVES (its projection never landed).
        let survivors: Vec<Vec<u8>> = sqlx::query_scalar("SELECT bytes FROM loro_sync_inbox")
            .fetch_all(&pool)
            .await
            .expect("survivors");
        assert_eq!(
            survivors.len(),
            1,
            "exactly the un-importable slot must be left for a later boot"
        );
        assert_eq!(
            survivors[0], poison,
            "the surviving slot must be the poison one, not a healthy row"
        );

        // Direction 2 — every CLEARED slot's blocks really are in SQL.
        for bid in &block_ids {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
                .bind(bid)
                .fetch_one(&pool)
                .await
                .expect("count block");
            assert_eq!(
                n, 1,
                "block {bid} came from a slot that was deleted, so it MUST be projected"
            );
        }
    }

    /// #3164 — rows of DIFFERENT spaces in the same chunk are batched
    /// separately; a batch must never import one space's blob into another's
    /// engine, and every space's slots must clear.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_batches_each_space_separately_3164() {
        let (pool, _dir) = test_pool().await;
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted("01HZ000000000000000000SPB0");

        let (_parent, a_ids, a_blobs) = chained_update_blobs(2);
        let b_id = block_id_for(500);
        let b_blob = snapshot_with_block(&b_id, "device-space-B");

        // Interleave so the chunk is not accidentally already grouped.
        seed_inbox(&pool, space_a.as_str(), &a_blobs[0], None).await;
        seed_inbox(&pool, space_b.as_str(), &b_blob, None).await;
        seed_inbox(&pool, space_a.as_str(), &a_blobs[1], None).await;

        let registry = LoroEngineRegistry::new();
        let mat = Materializer::new(pool.clone());
        let replayed = replay_sync_inbox(&pool, &registry, "device-B", &mat)
            .await
            .expect("replay");
        assert_eq!(replayed, 3, "both spaces' slots must replay");

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "every space's slots must be cleared");

        for bid in a_ids.iter().chain(std::iter::once(&b_id)) {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
                .bind(bid)
                .fetch_one(&pool)
                .await
                .expect("count block");
            assert_eq!(n, 1, "block {bid} must be projected");
        }

        // Space B's engine must hold ONLY space B's block — proof the grouping
        // routed each batch to its own per-space engine (#2205).
        let mut guard = registry
            .for_space(&space_b, "device-B")
            .expect("engine for space B");
        assert!(
            guard
                .engine_mut()
                .read_block(&b_id)
                .expect("read b")
                .is_some(),
            "space B's engine must hold its own block"
        );
        assert!(
            guard
                .engine_mut()
                .read_block(&a_ids[0])
                .expect("read a")
                .is_none(),
            "space B's engine must NOT have imported space A's blob"
        );
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
