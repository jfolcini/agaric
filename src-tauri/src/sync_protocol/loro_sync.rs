//! PEND-09 Phase 3 day-4 — Loro-based sync push + apply helpers.
//!
//! Day-4 deliverable: **additive**.  The diffy-typed `OpBatch` wire
//! format (`super::types::SyncMessage::OpBatch`) and the `apply_remote_ops`
//! / `compute_ops_to_send` functions in `super::operations` still
//! ship in parallel.  Day-5 (`merge_block_text_only` deletion +
//! `OpBatch` removal) makes this the only path.
//!
//! ## Module layout
//!
//! * [`prepare_outgoing`] — sender side.  Given a peer's last-known
//!   version vector (or `None` for initial sync), produce a
//!   [`super::loro_sync_types::LoroSyncMessage`] carrying either a
//!   full snapshot or an incremental update.
//! * [`apply_remote`] — receiver side.  Given a parsed
//!   [`super::loro_sync_types::LoroSyncMessage`], import the bytes
//!   into the per-space engine and project every changed block into
//!   the SQL `blocks` table inside a single transaction.
//!
//! ## Why feature-gated body
//!
//! The wire types ([`super::loro_sync_types`]) are intentionally NOT
//! feature-gated — day-5 deletes `OpBatch` and the default build
//! needs SOMETHING to keep `SyncMessage` populated through the swing.
//! The push/apply helpers are gated because they touch
//! [`crate::loro::registry::LoroEngineRegistry`] which only compiles
//! under `loro-shadow`.  Day-9 removes the feature gate entirely.
//!
//! ## What's NOT here yet
//!
//! * Transport wiring.  The orchestrator
//!   (`super::orchestrator`) still sends `OpBatch` messages; day-5
//!   swings the dispatch.
//! * `peer_refs.loro_vv_bytes` schema / read.  Day-4 callers pass the
//!   peer's vv as `Option<&[u8]>`; the read-from-SQL piece lands with
//!   the day-4 push wiring (see plan §10.5).
//! * Snapshot-fallback request.  An [`super::loro_sync_types::LoroSyncMessage::Update`]
//!   whose `from_vv` is ahead of the receiver's `oplog_vv` cannot be
//!   imported safely; day-5 receiver dispatch adds the
//!   "request-fresh-snapshot" path.  Today this surfaces as a Loro
//!   import error, which [`apply_remote`] forwards as
//!   [`crate::error::AppError::Validation`].

#[cfg(feature = "loro-shadow")]
use sqlx::SqlitePool;

#[cfg(feature = "loro-shadow")]
use crate::error::AppError;
#[cfg(feature = "loro-shadow")]
use crate::loro::registry::LoroEngineRegistry;
#[cfg(feature = "loro-shadow")]
use crate::space::SpaceId;
#[cfg(feature = "loro-shadow")]
use crate::sync_protocol::loro_sync_types::{LoroSyncMessage, LORO_SYNC_PROTOCOL_VERSION};

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
/// PEND-09 Phase 3 day-4 — sender-side helper.  Day-5 wires this
/// into `super::orchestrator`'s session loop.
#[cfg(feature = "loro-shadow")]
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
/// Returns the [`SpaceId`] the message targeted so the caller can
/// invalidate per-space caches (FE event emission, agenda recompute,
/// etc.) at the materializer boundary.
///
/// Atomicity contract (per
/// `pending/PEND-09-PHASE-3-PLAN.md` §2.4 / §7.3): the engine import
/// happens **before** the SQL transaction.  A crash between the two
/// leaves the engine ahead of SQL; boot crash recovery (day-12+)
/// reconciles by re-running projection over each engine block.
///
/// PEND-09 Phase 3 day-4 — receiver-side helper.  Day-5 wires this
/// into `super::orchestrator`'s session loop.
#[cfg(feature = "loro-shadow")]
pub async fn apply_remote(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    message: LoroSyncMessage,
) -> Result<SpaceId, AppError> {
    use crate::loro::projection::project_block_full_to_sql;

    // Validate protocol version + extract bytes / space_id.
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
            from_vv: _,
            bytes,
        } => {
            if protocol_version != LORO_SYNC_PROTOCOL_VERSION {
                return Err(AppError::Validation(format!(
                    "loro_sync: unsupported update protocol version {protocol_version} \
                     (this build speaks {LORO_SYNC_PROTOCOL_VERSION})",
                )));
            }
            // TODO day-5/day-12: verify peer's `from_vv` is reachable
            // from our current `oplog_vv()`; if not, return a
            // "request-snapshot-fallback" signal instead of
            // forwarding the Loro import error.  See module docstring.
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
    let mut tx = pool.begin().await?;
    for block_id in &changed_blocks {
        let snapshot_opt = {
            let mut guard = registry.for_space(&space_id, device_id)?;
            guard.engine_mut().read_block(block_id.as_str())?
        };
        project_block_full_to_sql(&mut tx, &space_id, block_id, snapshot_opt.as_ref()).await?;
    }
    tx.commit().await?;

    Ok(space_id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "loro-shadow"))]
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
        let returned = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert_eq!(returned, space);

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
        apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");

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
}
