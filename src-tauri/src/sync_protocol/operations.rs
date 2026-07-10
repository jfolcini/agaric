use sqlx::SqlitePool;

use super::types::*;
use crate::error::AppError;
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

/// Check whether a full reset is required for sync with a remote peer —
/// **own-lineage-loss detection in Loro version-vector space** (#2502).
///
/// Returns `true` only when the peer's advertised per-space version vectors
/// claim, for **our own current-epoch Loro `PeerID`** (`own_peer_id`), a
/// counter *higher* than our local engine can produce for some space — i.e.
/// the peer has observed ops **we authored** that our own Loro doc no longer
/// contains (log/history loss, vault restored from an older backup, a
/// snapshot reset that dropped our tail). In that situation a delta replay is
/// impossible and the daemon layer falls back to snapshot catch-up.
///
/// # Why this replaced the op-log-seq lookup (#2502, #87 §10.5)
///
/// This check previously resolved the peer's advertised op-log `(device_id,
/// seq)` head for our own device against the local `op_log`. Post-#490-M1 the
/// op_log is strictly device-local and, since #2481, also carries *foreign*
/// device frontiers as append-only audit metadata — so op-log seqs are an
/// audit/replication cursor, **not** a state-causality signal. Making a state
/// reset decision from them conflated the two jobs and produced the #602
/// forever-backoff bug. #2502 retires the op-log-seq lookup entirely: state
/// causality is judged **only** from Loro VVs. This is the streamer-side,
/// handshake-time complement to the receiver-side
/// [`crate::sync_protocol::loro_sync::apply_remote`] reachability gate
/// (→ `SnapshotFallbackRequested`); both funnel into the single
/// `ResetRequired` → snapshot-catch-up recovery path.
///
/// # Why only *our own* peer id
///
/// The peer being ahead of us for *other* peer ids is normal and expected
/// (they simply hold more state — we pull it, no reset). A reset is warranted
/// only when the peer is ahead of us for **our own** contributions, because
/// those can only have come from us and their absence locally means we lost
/// our own tail. Restricting the comparison to `own_peer_id` is also what
/// keeps a post-reset device from looping: a snapshot reset mints a
/// *new*-epoch `PeerID` starting at counter 0, so no peer has advertised it
/// yet, and our abandoned pre-reset identity (a different peer id) is
/// deliberately ignored here.
///
/// `local_loro_vvs` are our current per-space engine VVs
/// (`session_state_machine::collect_local_loro_vvs`); `peer_loro_vvs` are the
/// peer's advertised `HeadExchange.loro_vvs`. A space the peer advertises but
/// we lack locally is treated as local counter `0`. A peer counter of `0`
/// carries no ops and is skipped (matching the receiver-side gate).
pub fn check_reset_required(
    own_peer_id: loro::PeerID,
    local_loro_vvs: &[SpaceVersionVector],
    peer_loro_vvs: &[SpaceVersionVector],
) -> Result<bool, AppError> {
    use std::collections::HashMap;

    // Index our local per-space vv bytes for O(1) lookup by space.
    let local_by_space: HashMap<&crate::space::SpaceId, &[u8]> = local_loro_vvs
        .iter()
        .map(|s| (&s.space_id, s.vv.as_slice()))
        .collect();

    for peer_svv in peer_loro_vvs {
        let peer_vv = loro::VersionVector::decode(&peer_svv.vv).map_err(|e| {
            AppError::validation(format!(
                "check_reset_required: decode peer loro_vv for space {}: {e}",
                peer_svv.space_id.as_str()
            ))
        })?;
        // Our own contribution the peer claims to have seen for this space.
        let peer_own = peer_vv.get(&own_peer_id).copied().unwrap_or(0);
        if peer_own == 0 {
            continue; // peer has none of our ops for this space — trivially ok
        }

        // Our own contribution we can actually produce for this space. A space
        // we do not hold locally reads as 0 (we authored nothing there that we
        // still have), so any positive peer claim is a genuine loss.
        let local_own = match local_by_space.get(&peer_svv.space_id) {
            Some(bytes) => {
                let local_vv = loro::VersionVector::decode(bytes).map_err(|e| {
                    AppError::validation(format!(
                        "check_reset_required: decode local loro_vv for space {}: {e}",
                        peer_svv.space_id.as_str()
                    ))
                })?;
                local_vv.get(&own_peer_id).copied().unwrap_or(0)
            }
            None => 0,
        };

        if peer_own > local_own {
            return Ok(true);
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
