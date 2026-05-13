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
pub async fn get_local_heads(pool: &SqlitePool) -> Result<Vec<DeviceHead>, AppError> {
    let heads = sqlx::query_as::<_, DeviceHead>(
        "SELECT device_id, seq, hash FROM op_log \
         WHERE (device_id, seq) IN \
           (SELECT device_id, MAX(seq) FROM op_log GROUP BY device_id) \
         ORDER BY device_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(heads)
}

/// Check whether a full reset is required for sync with a remote peer.
///
/// Returns `true` if the remote advertises a `(device_id, seq)` that we no
/// longer have in our op log (e.g. after compaction).
pub async fn check_reset_required(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<bool, AppError> {
    for head in remote_heads {
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
/// PEND-24 M2: composes with [`peer_refs::upsert_peer_ref_in_tx`]
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
