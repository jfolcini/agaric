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

/// #2481 phase 1 — collect the op records to replicate to a peer as
/// append-only **audit metadata** (`SyncMessage::OpLogBatch`).
///
/// For every device frontier we hold in our local op_log — our own device
/// plus any foreign device whose ops we previously replicated — this returns
/// every op the peer lacks, i.e. `seq > the peer's advertised frontier for
/// that device` (or *all* of that device's ops when the peer advertised no
/// frontier for it). The peer's advertised frontiers come from its
/// `HeadExchange.heads` (now extended to every device it holds, #2481).
///
/// Records are returned in `(device_id, seq)` order so the receiver ingests
/// each device's history in seq order — the ordering
/// [`crate::dag::insert_replicated_op`]'s audit-mode parent-gap relaxation
/// relies on to attribute a gap to peer-side compaction.
///
/// `origin` is carried verbatim (it is not part of the hash preimage — see
/// `op-log-format.md`), so cross-device attribution travels with the op. This
/// deliberately includes replicated (`is_replicated = 1`) rows we already hold
/// so a frontier propagates transitively; the records are audit-only on the
/// receiver too, so re-shipping them is safe.
pub async fn collect_ops_for_peer(
    pool: &SqlitePool,
    peer_heads: &[DeviceHead],
) -> Result<Vec<OpTransfer>, AppError> {
    use std::collections::HashMap;

    // Peer's advertised frontier per device. A device the peer did not list
    // maps to 0 ("peer has none of this device's ops"), so every op qualifies.
    let peer_frontier: HashMap<&str, i64> = peer_heads
        .iter()
        .map(|h| (h.device_id.as_str(), h.seq))
        .collect();

    let rows = sqlx::query!(
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, origin \
         FROM op_log \
         ORDER BY device_id ASC, seq ASC",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::new();
    for r in rows {
        let peer_seq = peer_frontier
            .get(r.device_id.as_str())
            .copied()
            .unwrap_or(0);
        if r.seq > peer_seq {
            out.push(OpTransfer {
                device_id: r.device_id,
                seq: r.seq,
                parent_seqs: r.parent_seqs,
                hash: r.hash,
                op_type: r.op_type,
                payload: r.payload,
                created_at: r.created_at,
                origin: r.origin,
            });
        }
    }
    Ok(out)
}

/// #2481 phase 1 — partition op transfers into `OpLogBatch`-sized groups.
///
/// Each returned batch serializes to under `max_bytes` (the caller passes
/// [`crate::sync_constants::LORO_INLINE_MAX_BYTES`]) so it travels inline on
/// the wire, riding the same size discipline as `LoroSync` (#611). Op records
/// are inherently small (a single text edit), so in practice a batch holds
/// many records and no single record approaches the cap; a lone record that
/// somehow exceeds `max_bytes` still ships in its own batch rather than being
/// dropped (it cannot be split further, and the receiver's per-message cap is
/// the backstop).
///
/// Returns an empty `Vec` when there is nothing to replicate (the caller then
/// sends no `OpLogBatch` at all).
pub fn batch_ops_for_wire(records: Vec<OpTransfer>, max_bytes: usize) -> Vec<Vec<OpTransfer>> {
    let mut batches: Vec<Vec<OpTransfer>> = Vec::new();
    let mut current: Vec<OpTransfer> = Vec::new();
    let mut current_bytes: usize = 0;

    for rec in records {
        // Cheap upper-bound estimate of this record's inline JSON footprint:
        // the serialized length plus a small per-element envelope allowance.
        let rec_bytes = serde_json::to_string(&rec).map_or(0, |s| s.len()) + 2;
        if !current.is_empty() && current_bytes + rec_bytes > max_bytes {
            batches.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current_bytes += rec_bytes;
        current.push(rec);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
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
