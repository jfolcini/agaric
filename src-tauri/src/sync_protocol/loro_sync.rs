//! Loro-based sync push + apply helpers.
//!
//! ## Module layout
//!
//! * [`prepare_outgoing`] — sender side. Given a peer's last-known
//!   version vector (or `None` for initial sync), produce a
//!   [`super::loro_sync_types::LoroSyncMessage`] carrying either a
//!   full snapshot or an incremental update.
//! * [`apply_remote`] — receiver side. Given a parsed
//!   [`super::loro_sync_types::LoroSyncMessage`], import the bytes
//!   into the per-space engine and project every changed block into
//!   the SQL `blocks` table inside a single transaction.  Returns an
//!   [`ApplyOutcome`] discriminating between successful import and a
//!   snapshot-fallback request (see below).
//!
//! ## Snapshot-fallback path (MAINT-228)
//!
//! Before importing a [`LoroSyncMessage::Update`], [`apply_remote`]
//! verifies that the peer's declared `from_vv` is **reachable** from
//! our current `oplog_vv()`: for every `(peer_id, counter)` entry in
//! `from_vv`, our local vv has an entry for the same `peer_id` with a
//! counter `>=` the peer's.  If any entry is missing or our counter
//! lags, the update cannot be applied without losing ops — Loro would
//! otherwise surface this as an opaque decode error from
//! `import_with_changed_blocks`.
//!
//! On a miss, [`apply_remote`] short-circuits **before** the engine
//! import and returns [`ApplyOutcome::SnapshotFallbackRequested`].  The
//! orchestrator translates that into a [`super::types::SyncMessage::ResetRequired`],
//! which the daemon layer's snapshot catch-up sub-flow
//! ([`crate::sync_daemon::snapshot_transfer`]) already handles —
//! identical to the first-time-pairing / log-compacted path.
//!
//! ## TODOs
//!
//! * `peer_refs.loro_vv_bytes` schema / read. Callers pass the peer's
//!   vv as `Option<&[u8]>`; the read-from-SQL piece lands with the
//!   push wiring.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::loro::registry::LoroEngineRegistry;
use crate::space::SpaceId;
use crate::sync_protocol::loro_sync_types::{LoroSyncMessage, LORO_SYNC_PROTOCOL_VERSION};
use loro::VersionVector;

/// Outcome of [`apply_remote`].  Discriminates between a successful
/// engine import and a `from_vv`-unreachable snapshot-fallback signal.
///
/// MAINT-228: callers (the orchestrator) must `match` on this to
/// decide whether to transition into `Complete` (after a successful
/// import) or `ResetRequired` (to trigger the snapshot catch-up
/// sub-flow at the daemon layer).
#[derive(Debug, Clone)]
pub enum ApplyOutcome {
    /// The message was imported into the engine (and, for Update /
    /// Snapshot variants, projected into SQL).  Carries the targeted
    /// [`SpaceId`] so the caller can invalidate per-space caches.
    Imported(SpaceId),
    /// The message was a [`LoroSyncMessage::Update`] whose `from_vv`
    /// is not reachable from our current `oplog_vv()` — applying the
    /// delta would yield an incoherent CRDT state.  The engine import
    /// was **not** attempted; callers should request a fresh snapshot
    /// from the peer (the orchestrator translates this into
    /// [`super::types::SyncMessage::ResetRequired`]).
    SnapshotFallbackRequested {
        /// Per-space scope of the rejected message.
        space_id: SpaceId,
        /// Human-readable reason — surfaced in `SyncEvent::Error` /
        /// `SyncMessage::ResetRequired::reason` for log + telemetry.
        reason: String,
    },
}

/// Internal: classify whether a peer's `from_vv` (encoded) is
/// reachable from our local `oplog_vv()` (encoded).
///
/// "Reachable" — for every `(peer_id, counter)` entry in the peer's
/// vv, our local vv has an entry for the same `peer_id` with a
/// counter `>=` the peer's.  An entry the peer has at counter `c > 0`
/// that we lack entirely is **also** unreachable (we have zero ops
/// from that peer, the peer believes we have `c`).
///
/// Returns `Ok(None)` for reachable; `Ok(Some(reason))` for
/// unreachable with a human-readable diagnostic.  Decode failures on
/// either side surface as [`AppError::Validation`] — a malformed vv
/// on the wire is a protocol error, distinct from a clean miss.
fn classify_from_vv_reachability(
    local_encoded: &[u8],
    peer_encoded: &[u8],
) -> Result<Option<String>, AppError> {
    let local_vv = VersionVector::decode(local_encoded).map_err(|e| {
        AppError::Validation(format!(
            "loro_sync: decode local oplog_vv for reachability check: {e}",
        ))
    })?;
    let peer_vv = VersionVector::decode(peer_encoded).map_err(|e| {
        AppError::Validation(format!(
            "loro_sync: decode peer from_vv for reachability check: {e}",
        ))
    })?;

    // VersionVector derefs to FxHashMap<PeerID, Counter>; the
    // contract is "every peer entry in `peer_vv` must be matched by
    // an entry in `local_vv` whose counter is >=".  A `0` counter on
    // the peer side carries no ops and is trivially reachable; treat
    // it as a no-op to avoid spurious misses against fresh peers.
    for (peer_id, &peer_counter) in peer_vv.iter() {
        if peer_counter == 0 {
            continue;
        }
        match local_vv.get(peer_id) {
            Some(&local_counter) if local_counter >= peer_counter => continue,
            Some(&local_counter) => {
                return Ok(Some(format!(
                    "peer's from_vv requires peer={peer_id} counter>={peer_counter}, \
                     local oplog_vv has counter={local_counter}",
                )));
            }
            None => {
                return Ok(Some(format!(
                    "peer's from_vv requires peer={peer_id} counter>={peer_counter}, \
                     local oplog_vv has no entry for that peer",
                )));
            }
        }
    }
    Ok(None)
}

/// Build the next outgoing [`LoroSyncMessage`] for `space_id`.
///
/// * `peer_vv == None` — initial sync; the sender produces a full
///   snapshot via [`crate::loro::engine::LoroEngine::export_snapshot`].
///   Receiver's [`apply_remote`] imports unconditionally.
/// * `peer_vv == Some(vv)` — incremental sync; the sender produces
///   an update covering ops added since the peer's vv via
///   [`crate::loro::engine::LoroEngine::export_update_since`].  The
///   receiver imports against its existing engine state.
///
/// `device_id` is the sender's own [`crate::device`] identity — the
/// registry uses it to lazy-instantiate the engine if this is the
/// first call for `space_id` since process boot.  Production callers
/// pass the process-stable UUID-v4 from `crate::device`.
///
/// Sender-side helper.
pub async fn prepare_outgoing(
    registry: &LoroEngineRegistry,
    space_id: &SpaceId,
    device_id: &str,
    peer_vv: Option<&[u8]>,
) -> Result<LoroSyncMessage, AppError> {
    let mut guard = registry.for_space(space_id, device_id)?;
    let engine = guard.engine_mut();
    match peer_vv {
        None => {
            // Initial sync — full snapshot.
            let bytes = engine.export_snapshot()?;
            Ok(LoroSyncMessage::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: space_id.clone(),
                bytes,
            })
        }
        Some(vv) => {
            // Incremental — export only ops since `vv`.
            let bytes = engine.export_update_since(vv)?;
            Ok(LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: space_id.clone(),
                from_vv: vv.to_vec(),
                bytes,
            })
        }
    }
}

/// Apply an incoming [`LoroSyncMessage`] to the local engine and
/// project the changed blocks to SQL.
///
/// Returns an [`ApplyOutcome`]:
///
/// * [`ApplyOutcome::Imported`] — engine import + SQL projection
///   succeeded; the carried [`SpaceId`] lets the caller invalidate
///   per-space caches (FE event emission, agenda recompute, etc.).
/// * [`ApplyOutcome::SnapshotFallbackRequested`] (MAINT-228) — the
///   message was a [`LoroSyncMessage::Update`] whose `from_vv` is
///   ahead of (or concurrent with) our `oplog_vv()`.  The engine
///   import is **not** attempted; the caller MUST request a fresh
///   snapshot from the peer (orchestrator emits
///   [`super::types::SyncMessage::ResetRequired`] for this).
///
/// Atomicity contract: the engine import happens **before** the SQL
/// transaction. A crash between the two leaves the engine ahead of
/// SQL; boot crash recovery reconciles by re-running projection over
/// each engine block.
pub async fn apply_remote(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    message: LoroSyncMessage,
) -> Result<ApplyOutcome, AppError> {
    use crate::loro::projection::{
        project_block_full_to_sql, reproject_block_properties_from_engine,
    };

    // Validate protocol version + extract bytes / space_id.  For
    // Update, also gate the import on the MAINT-228 reachability
    // check — if the peer's `from_vv` is unreachable from our local
    // `oplog_vv()`, short-circuit with `SnapshotFallbackRequested`
    // instead of letting `import_with_changed_blocks` surface an
    // opaque Loro decode error.
    let (space_id, bytes) = match message {
        LoroSyncMessage::Snapshot {
            protocol_version,
            space_id,
            bytes,
        } => {
            if protocol_version != LORO_SYNC_PROTOCOL_VERSION {
                return Err(AppError::Validation(format!(
                    "loro_sync: unsupported snapshot protocol version {protocol_version} \
                     (this build speaks {LORO_SYNC_PROTOCOL_VERSION})",
                )));
            }
            (space_id, bytes)
        }
        LoroSyncMessage::Update {
            protocol_version,
            space_id,
            from_vv,
            bytes,
        } => {
            if protocol_version != LORO_SYNC_PROTOCOL_VERSION {
                return Err(AppError::Validation(format!(
                    "loro_sync: unsupported update protocol version {protocol_version} \
                     (this build speaks {LORO_SYNC_PROTOCOL_VERSION})",
                )));
            }
            // MAINT-228: verify peer's `from_vv` is reachable from
            // our current `oplog_vv()`.  Read the local vv off the
            // engine BEFORE the import — and BEFORE any SQL tx — so
            // a miss returns without side-effects.
            let local_vv_bytes: Vec<u8> = {
                let mut guard = registry.for_space(&space_id, device_id)?;
                guard.engine_mut().version_vector()
            };
            match classify_from_vv_reachability(&local_vv_bytes, &from_vv)? {
                None => {
                    // Reachable — fall through to the import.
                }
                Some(reason) => {
                    return Ok(ApplyOutcome::SnapshotFallbackRequested { space_id, reason });
                }
            }
            (space_id, bytes)
        }
    };

    // Phase 1 — import bytes into the engine, capture changed blocks.
    let changed_blocks: Vec<crate::ulid::BlockId> = {
        let mut guard = registry.for_space(&space_id, device_id)?;
        guard.engine_mut().import_with_changed_blocks(&bytes)?
    };

    // Phase 2 — project each changed block to SQL in a single tx.
    // Per the plan: read each block's snapshot from the engine OUTSIDE
    // the tx (releasing the mutex between reads and the SQL write so
    // we don't hold both at once), then run the projections inside the
    // tx.  This is a per-block read -> per-block write pattern; if a
    // benchmark shows contention it can swap to "snapshot all blocks,
    // drop guard, then write everything" — same correctness shape.
    let mut tx = crate::db::begin_immediate_logged(pool, "sync_apply_remote").await?;
    for block_id in &changed_blocks {
        // Read both the core snapshot and the full property set under the
        // guard, then drop it before the SQL writes — same
        // read-under-guard-then-write-in-tx shape as `read_block`, so we
        // never hold the engine mutex across the tx write.
        let (snapshot_opt, props) = {
            let mut guard = registry.for_space(&space_id, device_id)?;
            let engine = guard.engine_mut();
            let snap = engine.read_block(block_id.as_str())?;
            let props = engine.read_all_properties(block_id.as_str())?;
            (snap, props)
        };
        project_block_full_to_sql(&mut tx, &space_id, block_id, snapshot_opt.as_ref()).await?;
        // Re-project the block's properties (PEND-76 F1): mirrors remote
        // SetProperty / DeleteProperty changes into `block_properties`.
        reproject_block_properties_from_engine(&mut tx, block_id, &props).await?;
    }
    tx.commit().await?;

    Ok(ApplyOutcome::Imported(space_id))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::engine::LoroEngine;
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const SPACE_A: &str = "01HZ00000000000000000000SP";
    const BLOCK_A: &str = "01HZ00000000000000000000A1";
    const BLOCK_B: &str = "01HZ00000000000000000000B2";
    const BLOCK_C: &str = "01HZ00000000000000000000C3";
    const BLOCK_D: &str = "01HZ00000000000000000000D4";
    const BLOCK_E: &str = "01HZ00000000000000000000E5";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("loro_sync_test.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// `prepare_outgoing(None)` → Snapshot variant carrying the full
    /// engine state.  Initial-sync invariant.
    #[tokio::test]
    async fn prepare_outgoing_with_no_peer_vv_returns_snapshot() {
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Seed the engine with one block so the snapshot has a payload.
        {
            let mut g = registry.for_space(&space, "device-S").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "hello", None, 0)
                .expect("create");
        }

        let msg = prepare_outgoing(&registry, &space, "device-S", None)
            .await
            .expect("prepare_outgoing");

        match msg {
            LoroSyncMessage::Snapshot {
                protocol_version,
                space_id,
                bytes,
            } => {
                assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
                assert_eq!(space_id, space);
                assert!(!bytes.is_empty(), "snapshot bytes must be non-empty");
            }
            other => panic!("expected Snapshot, got {other:?}"),
        }
    }

    /// `prepare_outgoing(Some(vv))` → Update variant carrying only the
    /// post-vv ops.  Mirrors the engine's `export_update_since`
    /// invariant: receiver re-creates the post-vv blocks but not the
    /// pre-vv ones (it has those already).
    #[tokio::test]
    async fn prepare_outgoing_with_peer_vv_returns_update() {
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Apply 3 ops, capture vv, apply 2 more.
        let vv_after_first_batch = {
            let mut g = registry.for_space(&space, "device-S").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "first", None, 0)
                .expect("create A");
            e.apply_create_block(BLOCK_B, "content", "second", None, 1)
                .expect("create B");
            e.apply_create_block(BLOCK_C, "content", "third", None, 2)
                .expect("create C");
            let vv = e.version_vector();
            e.apply_create_block(BLOCK_D, "content", "fourth", None, 3)
                .expect("create D");
            e.apply_create_block(BLOCK_E, "content", "fifth", None, 4)
                .expect("create E");
            vv
        };

        let msg = prepare_outgoing(&registry, &space, "device-S", Some(&vv_after_first_batch))
            .await
            .expect("prepare_outgoing");

        let (from_vv, delta_bytes) = match msg {
            LoroSyncMessage::Update {
                protocol_version,
                space_id,
                from_vv,
                bytes,
            } => {
                assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
                assert_eq!(space_id, space);
                assert!(!bytes.is_empty(), "update bytes must be non-empty");
                (from_vv, bytes)
            }
            other => panic!("expected Update, got {other:?}"),
        };
        assert_eq!(
            from_vv, vv_after_first_batch,
            "Update.from_vv must echo the peer-vv passed by the caller"
        );

        // Verify the delta carries D and E but NOT A/B/C: import into
        // a receiver that already has A/B/C.
        let mut receiver = LoroEngine::with_peer_id("device-S").expect("rcv");
        receiver
            .apply_create_block(BLOCK_A, "content", "first", None, 0)
            .expect("rcv create A");
        receiver
            .apply_create_block(BLOCK_B, "content", "second", None, 1)
            .expect("rcv create B");
        receiver
            .apply_create_block(BLOCK_C, "content", "third", None, 2)
            .expect("rcv create C");
        assert!(receiver.read_block(BLOCK_D).unwrap().is_none());
        assert!(receiver.read_block(BLOCK_E).unwrap().is_none());

        receiver.import(&delta_bytes).expect("import delta");
        assert!(receiver.read_block(BLOCK_D).unwrap().is_some());
        assert!(receiver.read_block(BLOCK_E).unwrap().is_some());
    }

    /// Apply A's snapshot to a fresh B; assert B's engine sees the
    /// blocks A had.  Engine-level convergence after a Snapshot
    /// import.
    #[tokio::test]
    async fn apply_remote_imports_snapshot_into_engine() {
        let (pool, _dir) = fresh_pool().await;

        // Build A and produce a Snapshot message.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
        }
        let msg = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare");

        // Apply on B (fresh registry).
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        match outcome {
            ApplyOutcome::Imported(returned) => assert_eq!(returned, space),
            ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                panic!("expected Imported, got SnapshotFallbackRequested: {reason}")
            }
        }

        // B's engine now sees BLOCK_A.
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        let snap = g
            .engine_mut()
            .read_block(BLOCK_A)
            .expect("read")
            .expect("BLOCK_A must be present after import");
        assert_eq!(snap.content, "from-A");
    }

    /// `apply_remote` writes the projected `blocks` row to SQL.
    /// SQL-level convergence end-to-end through the helper.
    #[tokio::test]
    async fn apply_remote_projects_changed_blocks_to_sql() {
        let (pool, _dir) = fresh_pool().await;

        // Build A and produce a Snapshot message.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 7)
                .expect("create");
        }
        let msg = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare");

        // Apply on B (fresh registry, fresh DB).
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported(ref s) if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // SQL now has the projected `blocks` row.
        let row: (String, String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
        assert_eq!(row.0, BLOCK_A);
        assert_eq!(row.1, "content");
        assert_eq!(row.2, "from-A");
        assert_eq!(row.3, None);
        assert_eq!(row.4, 7);
    }

    /// PEND-76 F1 regression (end-to-end): an inbound sync that
    /// re-projects an already-materialised block must NOT cascade-wipe
    /// that block's tags / properties. The bug was `INSERT OR REPLACE`,
    /// which deletes the `blocks` row first so the `ON DELETE CASCADE`
    /// FKs delete `block_tags` / `block_properties`; the fix is an
    /// upsert that updates only the core columns.
    #[tokio::test]
    async fn apply_remote_does_not_wipe_existing_block_derived_state() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Pre-seed B's SQL with the state a prior sync had materialised:
        // block X plus a tag-block, a tag edge, and a property row.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'old', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // A second, SQL-only property that A's engine will NOT carry — under
        // the new authoritative-replace semantics it must be swept by the
        // inbound re-projection (proves the behavior isn't just "re-affirm").
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'sql_only', 'should-be-swept')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .execute(&pool)
            .await
            .unwrap();

        // A edits X's content and sends a snapshot.  A's engine carries
        // the same `effort` property B already materialised (both are
        // derived from the same CRDT) — so the inbound property
        // re-projection (PEND-76 F1) re-affirms the row rather than
        // sweeping it.  The point of this test is that the *core* upsert
        // does not cascade-wipe the block's derived tags/properties.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "edited-by-A", None, 0)
                .expect("create");
            e.apply_set_property(BLOCK_A, "effort", Some("3"))
                .expect("set effort");
        }
        let msg = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare");

        // B applies the inbound snapshot.
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported(ref s) if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // Content updated from the inbound edit.
        let content: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch content");
        assert_eq!(
            content.0, "edited-by-A",
            "content must update from the inbound edit"
        );

        // block_tags survive — this is the load-bearing F1 cascade-wipe
        // guard: tags are untouched by property re-projection, so if the
        // core upsert had deleted the `blocks` row, the `ON DELETE CASCADE`
        // would have taken `block_tags` to 0.
        let tag_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch tag count");
        assert_eq!(
            tag_count.0, 1,
            "block_tags must survive the inbound sync (F1)"
        );

        // Engine-backed property is re-affirmed; the SQL-only property
        // (absent from A's engine) is swept by the authoritative replace.
        let prop_keys: Vec<(String,)> =
            sqlx::query_as("SELECT key FROM block_properties WHERE block_id = ? ORDER BY key")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch prop keys");
        let keys: Vec<String> = prop_keys.into_iter().map(|r| r.0).collect();
        assert_eq!(
            keys,
            vec!["effort".to_string()],
            "engine-backed `effort` survives; SQL-only `sql_only` is swept by re-projection"
        );
    }

    /// A Snapshot envelope with `protocol_version != 1` must be
    /// rejected before any engine import — wire-format-version
    /// invariant.
    #[tokio::test]
    async fn apply_remote_rejects_unsupported_protocol_version() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Hand-craft a Snapshot with a bumped protocol_version. The
        // bytes payload doesn't matter — apply_remote MUST reject
        // before importing.
        let bad_snapshot = LoroSyncMessage::Snapshot {
            protocol_version: 99,
            space_id: space.clone(),
            bytes: vec![0xff, 0xff, 0xff],
        };
        let err = apply_remote(&pool, &registry, "device-B", bad_snapshot)
            .await
            .expect_err("must reject unsupported protocol_version");
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("99") && msg.contains("protocol version"),
                    "error must mention the rejected version, got: {msg}"
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }

        // Same check for Update.
        let bad_update = LoroSyncMessage::Update {
            protocol_version: 99,
            space_id: space.clone(),
            from_vv: vec![],
            bytes: vec![0xff],
        };
        let err = apply_remote(&pool, &registry, "device-B", bad_update)
            .await
            .expect_err("must reject unsupported protocol_version (Update)");
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("99") && msg.contains("protocol version"),
                    "error must mention the rejected version, got: {msg}"
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // MAINT-228 — `from_vv` reachability check + snapshot-fallback
    // -----------------------------------------------------------------

    /// Happy-path: peer's `from_vv` is exactly our current
    /// `oplog_vv()`.  Reachability passes; `apply_remote` performs the
    /// engine import and returns `ApplyOutcome::Imported`.
    ///
    /// Locks the wire-shape pin for MAINT-228 normal flow — every
    /// in-band incremental sync between two peers that have been
    /// continuously paired hits this path.
    #[tokio::test]
    async fn apply_remote_update_with_reachable_from_vv_imports() {
        let (pool, _dir) = fresh_pool().await;

        // Build A with one block, capture B's vv (== A's vv before
        // the next op), then A adds a second block; A exports the
        // delta with `from_vv = b_vv`.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "first", None, 0)
                .expect("create A");
        }
        // Mirror A's pre-second-op state into B so B's local vv
        // exactly matches the `from_vv` A will use.
        let registry_b = LoroEngineRegistry::new();
        let snap_msg = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare snapshot");
        let snap_outcome = apply_remote(&pool, &registry_b, "device-B", snap_msg)
            .await
            .expect("apply snapshot");
        assert!(
            matches!(snap_outcome, ApplyOutcome::Imported(_)),
            "seed snapshot must import cleanly, got {snap_outcome:?}"
        );

        let b_vv: Vec<u8> = {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().version_vector()
        };
        assert!(!b_vv.is_empty(), "B's vv must be non-empty after import");

        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut()
                .apply_create_block(BLOCK_B, "content", "second", None, 1)
                .expect("create B");
        }
        let update = prepare_outgoing(&registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare update");

        let outcome = apply_remote(&pool, &registry_b, "device-B", update)
            .await
            .expect("apply update");
        match outcome {
            ApplyOutcome::Imported(s) => assert_eq!(s, space),
            ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                panic!("reachable from_vv must Imported, got SnapshotFallbackRequested: {reason}")
            }
        }

        // B's engine actually advanced — BLOCK_B is now visible.
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B3");
        assert!(
            g.engine_mut()
                .read_block(BLOCK_B)
                .expect("read B")
                .is_some(),
            "BLOCK_B must be visible after a reachable Update is imported",
        );
    }

    /// Miss-path: peer's `from_vv` claims ops from a peer we have
    /// never heard of (counter > 0 for an unknown peer).  Reachability
    /// fails; `apply_remote` returns `SnapshotFallbackRequested`
    /// **without** attempting the engine import.
    ///
    /// MAINT-228 invariant.  Pre-fix the engine raised an opaque Loro
    /// decode error from `import_with_changed_blocks`; the new path
    /// emits a typed fallback signal the orchestrator can route to
    /// the snapshot catch-up sub-flow.
    #[tokio::test]
    async fn apply_remote_update_with_unreachable_from_vv_requests_fallback() {
        let (pool, _dir) = fresh_pool().await;

        // B starts fresh (vv is empty / contains only its own peer
        // at counter 0).  We then hand B an Update whose `from_vv`
        // claims a third peer's ops at a non-zero counter — B has
        // no entry for that peer, so the import would lose context.
        let registry_b = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Construct a `from_vv` that includes a phantom peer with a
        // non-zero counter.  Use a real LoroEngine with a distinct
        // device_id to manufacture the encoded vv; this matches the
        // production wire shape (a postcard-encoded VersionVector).
        let phantom_vv_bytes: Vec<u8> = {
            let mut phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom engine");
            phantom
                .apply_create_block(BLOCK_C, "content", "phantom-op", None, 0)
                .expect("phantom op");
            phantom.version_vector()
        };

        // The `bytes` payload must be syntactically a valid Update
        // body so that, if the reachability check were ever
        // bypassed, the test would loudly fail on the import call
        // rather than coincidentally pass.  Use an Update produced by
        // the phantom engine itself against a known prior vv.
        let payload_bytes: Vec<u8> = {
            let phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom payload");
            let empty_vv = phantom.version_vector();
            // Produce a delta from the *initial* empty vv — even if
            // this is somehow imported, it does not contain the ops
            // referenced by `phantom_vv_bytes`, so the assertion
            // below ("BLOCK_C not present on B") still pins the
            // "import NOT attempted" invariant.
            phantom
                .export_update_since(&empty_vv)
                .unwrap_or_else(|_| vec![0u8])
        };

        let unreachable_update = LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            from_vv: phantom_vv_bytes,
            bytes: payload_bytes,
        };

        let outcome = apply_remote(&pool, &registry_b, "device-B", unreachable_update)
            .await
            .expect("apply_remote must NOT error on unreachable from_vv — it must return the typed fallback variant");

        match outcome {
            ApplyOutcome::SnapshotFallbackRequested {
                space_id: returned_space,
                reason,
            } => {
                assert_eq!(returned_space, space);
                assert!(
                    reason.contains("from_vv") || reason.contains("oplog_vv"),
                    "reason should mention the vv mismatch context, got: {reason}"
                );
            }
            ApplyOutcome::Imported(_) => {
                panic!("unreachable from_vv MUST NOT report Imported")
            }
        }

        // Side-effect-free guarantee: the import was NOT attempted.
        // B's engine has no entry for BLOCK_C (the phantom's op).
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        assert!(
            g.engine_mut().read_block(BLOCK_C).expect("read C").is_none(),
            "BLOCK_C must NOT be present on B — the engine import must be skipped on a fallback miss",
        );

        // Same guarantee at the SQL layer.
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("count rows");
        assert_eq!(
            row_count, 0,
            "no blocks must be projected to SQL when fallback is requested",
        );
    }

    /// Miss-path corner: peer has us **behind** on a peer we DO
    /// share — same peer_id in both vvs, peer's counter is strictly
    /// greater than ours.  Reachability must reject.
    #[tokio::test]
    async fn apply_remote_update_with_behind_counter_requests_fallback() {
        let (pool, _dir) = fresh_pool().await;

        // A and B share device-A as a peer, but A is 2 ops ahead.
        // B receives an Update whose `from_vv` echoes A's full vv —
        // since B's vv has device-A at counter 0 (B has no ops from
        // A), the reachability check must fail.
        let registry_a = LoroEngineRegistry::new();
        let registry_b = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
                .expect("a1");
            e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
                .expect("a2");
        }
        let a_vv: Vec<u8> = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut().version_vector()
        };
        // A produces a third op then an Update whose from_vv == its
        // *pre-third-op* vv (which B does not have).
        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A3");
            g.engine_mut()
                .apply_create_block(BLOCK_D, "content", "a3", None, 2)
                .expect("a3");
        }
        let update = prepare_outgoing(&registry_a, &space, "device-A", Some(&a_vv))
            .await
            .expect("prepare update");

        let outcome = apply_remote(&pool, &registry_b, "device-B", update)
            .await
            .expect("apply_remote must return fallback variant cleanly");

        assert!(
            matches!(outcome, ApplyOutcome::SnapshotFallbackRequested { .. }),
            "behind-on-shared-peer from_vv must yield SnapshotFallbackRequested, got {outcome:?}",
        );

        // Engine import was skipped — none of A's blocks landed.
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        let e = g.engine_mut();
        for blk in [BLOCK_A, BLOCK_B, BLOCK_D] {
            assert!(
                e.read_block(blk).expect("read").is_none(),
                "{blk} must NOT be present after a fallback miss",
            );
        }
    }

    /// Unit-test the reachability classifier in isolation against
    /// hand-built version vectors — three cases:
    ///  - exact match  → reachable
    ///  - local ahead  → reachable
    ///  - local behind → unreachable (with diagnostic)
    ///  - peer mentions an unknown peer at counter==0 → reachable
    ///    (no-op entries do not gate reachability)
    #[tokio::test]
    async fn classify_from_vv_reachability_cases() {
        // Build two engines + extract their encoded vvs at known
        // states.  Using real engines avoids hand-rolling postcard.
        let mut e_local = LoroEngine::with_peer_id("device-L").expect("L");
        let mut e_peer = LoroEngine::with_peer_id("device-L").expect("peer-L"); // same peer_id

        // Local: 2 ops.  Peer (echo): 2 ops too → exact match.
        for (eng, prefix) in [(&mut e_local, "l"), (&mut e_peer, "p")] {
            eng.apply_create_block(BLOCK_A, "content", &format!("{prefix}1"), None, 0)
                .expect("op1");
            eng.apply_create_block(BLOCK_B, "content", &format!("{prefix}2"), None, 1)
                .expect("op2");
        }
        let local_vv = e_local.version_vector();
        let peer_vv_eq = e_peer.version_vector();
        assert!(
            classify_from_vv_reachability(&local_vv, &peer_vv_eq)
                .expect("decode")
                .is_none(),
            "exact match must be reachable",
        );

        // Local ahead: local has 3 ops, peer still at 2.
        e_local
            .apply_create_block(BLOCK_C, "content", "l3", None, 2)
            .expect("l3");
        let local_vv_ahead = e_local.version_vector();
        assert!(
            classify_from_vv_reachability(&local_vv_ahead, &peer_vv_eq)
                .expect("decode")
                .is_none(),
            "local ahead must be reachable (we have everything peer claims)",
        );

        // Local behind: peer has 4 ops, local still at 3.
        e_peer
            .apply_create_block(BLOCK_C, "content", "p3", None, 2)
            .expect("p3");
        e_peer
            .apply_create_block(BLOCK_D, "content", "p4", None, 3)
            .expect("p4");
        let peer_vv_ahead = e_peer.version_vector();
        let miss = classify_from_vv_reachability(&local_vv_ahead, &peer_vv_ahead)
            .expect("decode")
            .expect("local-behind must be unreachable");
        assert!(
            miss.contains("counter") || miss.contains("peer"),
            "diagnostic should mention peer/counter, got: {miss}",
        );
    }

    // -----------------------------------------------------------------
    // PEND-76 F1 — inbound property re-projection (end-to-end).
    // -----------------------------------------------------------------

    /// Seed the `property_definitions` rows the re-projection consults to
    /// recover SQL types for the typed-column assertions below.
    async fn seed_property_defs(pool: &SqlitePool) {
        // `INSERT OR REPLACE` so these test-chosen types win over any
        // builtin seed (e.g. migration 0014 seeds `effort` as `select`).
        for (key, value_type) in [
            ("note", "text"),
            ("effort", "number"),
            ("done", "boolean"),
            ("due", "date"),
        ] {
            sqlx::query(
                "INSERT OR REPLACE INTO property_definitions (key, value_type, created_at) \
                 VALUES (?, ?, '2026-01-01T00:00:00Z')",
            )
            .bind(key)
            .bind(value_type)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// A remote engine sets several typed properties on a block; after
    /// `apply_remote`, each `block_properties` row carries the correct
    /// typed column (text/number/boolean/date), recovered from
    /// `property_definitions`.
    #[tokio::test]
    async fn apply_remote_reprojects_typed_properties_to_sql() {
        let (pool, _dir) = fresh_pool().await;
        seed_property_defs(&pool).await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Build A: create a block and set typed properties (string form,
        // mirroring the engine's single-string storage).
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.apply_set_property(BLOCK_A, "note", Some("hello"))
                .expect("set note");
            e.apply_set_property(BLOCK_A, "effort", Some("3.14"))
                .expect("set effort");
            e.apply_set_property(BLOCK_A, "done", Some("true"))
                .expect("set done");
            e.apply_set_property(BLOCK_A, "due", Some("2026-01-01"))
                .expect("set due");
        }
        let msg = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare");

        // Apply on B.
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported(ref s) if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // Each property landed in the right typed column.
        let note: (Option<String>, Option<f64>, Option<i64>) = sqlx::query_as(
            "SELECT value_text, value_num, value_bool FROM block_properties \
             WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch note");
        assert_eq!(note, (Some("hello".into()), None, None));

        let effort: (Option<f64>, Option<String>) = sqlx::query_as(
            "SELECT value_num, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch effort");
        assert_eq!(effort, (Some(3.14), None));

        let done: (Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT value_bool, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'done'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch done");
        assert_eq!(done, (Some(1), None));

        let due: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT value_date, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'due'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch due");
        assert_eq!(due, (Some("2026-01-01".into()), None));
    }

    /// A property present after a first sync, then removed on the remote
    /// (engine `apply_delete_property`), must have its `block_properties`
    /// row gone after a second `apply_remote`.  Pins remote-delete
    /// propagation via the authoritative-replace DELETE.
    #[tokio::test]
    async fn apply_remote_reproject_removes_deleted_property_on_resync() {
        let (pool, _dir) = fresh_pool().await;
        seed_property_defs(&pool).await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.apply_set_property(BLOCK_A, "note", Some("hello"))
                .expect("set note");
        }
        let registry_b = LoroEngineRegistry::new();

        // First sync: B materialises the `note` property.
        let msg1 = prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare 1");
        apply_remote(&pool, &registry_b, "device-B", msg1)
            .await
            .expect("apply 1");
        let count_before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count before");
        assert_eq!(count_before, 1, "note must be present after first sync");

        // A deletes the property, then re-syncs (incremental update).
        let b_vv: Vec<u8> = {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().version_vector()
        };
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_delete_property(BLOCK_A, "note")
                .expect("delete note");
        }
        let msg2 = prepare_outgoing(&registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare 2");
        apply_remote(&pool, &registry_b, "device-B", msg2)
            .await
            .expect("apply 2");

        let count_after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count after");
        assert_eq!(
            count_after, 0,
            "note row must be gone after the remote deletes it and re-syncs"
        );
    }
}
