use sqlx::SqlitePool;

use super::types::*;
use crate::db::ReadPool;
use crate::error::AppError;
use crate::op_log;
use crate::peer_refs;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------
//
// The orchestrator's streaming-phase payload is `LoroSyncMessage`
// (delta or full snapshot of the per-space `LoroDoc`); Loro's CRDT
// import converges concurrent edits. See
// `sync_protocol::loro_sync::{prepare_outgoing, apply_remote}` for the
// push/apply helpers.

/// Get the latest `(device_id, seq, hash)` per device in the op log.
///
/// #430: computed via a **loose-index-scan emulation** rather than the old
/// `(device_id, seq) IN (SELECT device_id, MAX(seq) … GROUP BY device_id)`.
/// SQLite cannot index-skip a `MAX`-per-group over the `(device_id, seq)` PK,
/// so the old form did a full covering-index SCAN of `op_log` (+ a temp B-tree
/// and bloom filter) on every sync session and the reset path — `O(op_log)`,
/// which grows with vault size between compactions. The recursive CTE instead
/// walks the *distinct* `device_id`s by index seek (`device_id > ? ORDER BY
/// device_id LIMIT 1`, terminating on the NULL produced when none is greater),
/// and reads each device's head row with a PK-range seek
/// (`WHERE device_id = ? ORDER BY seq DESC LIMIT 1`) — turning the full scan
/// into `O(devices · log n)` index seeks (device count is small). The head is
/// pulled via correlated subqueries (not a JOIN) so the planner drives from the
/// tiny `devices` CTE and only *seeks* `op_log`, rather than choosing to SCAN
/// `op_log` as the join's outer table. Results are identical: `seq` is unique
/// per device under the PK, so each device contributes exactly one head.
pub async fn get_local_heads(pool: &SqlitePool) -> Result<Vec<DeviceHead>, AppError> {
    let heads = sqlx::query_as::<_, DeviceHead>(
        "WITH RECURSIVE devices(device_id) AS ( \
             SELECT (SELECT device_id FROM op_log ORDER BY device_id LIMIT 1) \
             UNION ALL \
             SELECT (SELECT ol.device_id FROM op_log ol \
                       WHERE ol.device_id > devices.device_id \
                       ORDER BY ol.device_id LIMIT 1) \
               FROM devices \
              WHERE devices.device_id IS NOT NULL \
         ) \
         SELECT \
             d.device_id AS device_id, \
             (SELECT ol.seq  FROM op_log ol \
                WHERE ol.device_id = d.device_id ORDER BY ol.seq DESC LIMIT 1) AS seq, \
             (SELECT ol.hash FROM op_log ol \
                WHERE ol.device_id = d.device_id ORDER BY ol.seq DESC LIMIT 1) AS hash \
           FROM devices d \
          WHERE d.device_id IS NOT NULL \
          ORDER BY d.device_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(heads)
}

/// Check whether a full reset is required for sync with a remote peer.
///
/// Returns `true` only when the remote advertises a head for **our own
/// device** (`local_device_id`) that our op log can no longer satisfy —
/// i.e. the peer claims to have observed ops we authored, but we have
/// lost that history (log compacted past the peer's frontier, vault
/// restored from an older backup, …). In that situation a delta replay
/// is impossible and the daemon layer falls back to snapshot catch-up.
///
/// # Why only own-device heads (#602)
///
/// Post-#490-M1 the local `op_log` is strictly device-local: the only
/// writer is `op_log::append_local_op*` (the local command path), and
/// inbound sync lands remote state via the Loro engine import + SQL
/// projection + write-ahead inbox
/// ([`crate::sync_protocol::loro_sync::import_and_project`]) — it never
/// inserts the peer's ops into our `op_log`. Resolving a *remote*
/// device's advertised `(device_id, seq)` against the local `op_log` is
/// therefore unconditionally `NotFound` the moment that peer has made
/// any local edit, which degenerated EVERY session between two edited
/// Devices into `ResetRequired` → stale-snapshot refusal →
/// backoff, forever (issue #602). Remote-frontier staleness is instead
/// detected where it can be answered correctly: the Loro version-vector
/// reachability gate in [`crate::sync_protocol::loro_sync::apply_remote`]
/// (→ `SnapshotFallbackRequested` → `ResetRequired`).
///
/// A `seq <= 0` claim means "I have observed none of your ops" and is
/// trivially satisfiable — never a reset condition ([`get_local_heads`]
/// only ever advertises seqs `>= 1`, but synthetic/legacy peers send 0).
///
/// TODO(#87 plan §10.5): once per-peer version vectors are persisted
/// (`peer_refs.loro_vv_bytes`) and the orchestrator sends incremental
/// `Update`s, head/reset detection should move to vv comparison
/// entirely and this op-log-seq check can be retired from the
/// handshake.
pub async fn check_reset_required(
    pool: &SqlitePool,
    local_device_id: &str,
    remote_heads: &[DeviceHead],
) -> Result<bool, AppError> {
    for head in remote_heads {
        // #602: the local op_log can only validly answer questions about
        // ops THIS device authored — skip every other device's head.
        if head.device_id != local_device_id {
            continue;
        }
        // "Zero ops observed" is trivially covered.
        if head.seq <= 0 {
            continue;
        }
        // I-Core-8: wrap to typed read-pool — caller is in write context
        match op_log::get_op_by_seq(&ReadPool(pool.clone()), &head.device_id, head.seq).await {
            Ok(_) => {}
            Err(AppError::NotFound(_)) => return Ok(true),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

/// Complete a sync session — update peer_refs with the final hashes.
pub async fn complete_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_received_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    peer_refs::update_on_sync(pool, peer_id, last_received_hash, last_sent_hash).await
}

/// In-transaction variant of [`complete_sync`].
///
/// Composes with [`peer_refs::upsert_peer_ref_in_tx`]
/// inside a single `BEGIN IMMEDIATE` so the post-session bookkeeping
/// pair (ensure peer row + record final hashes) commits atomically.
/// A crash or error between the two writes rolls both back, leaving
/// the next session with consistent peer-ref state.
pub async fn complete_sync_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
    last_received_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    peer_refs::update_on_sync_in_tx(tx, peer_id, last_received_hash, last_sent_hash).await
}
