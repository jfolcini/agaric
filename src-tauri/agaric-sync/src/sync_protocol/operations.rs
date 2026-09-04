use sqlx::SqlitePool;

use super::audit_ingest_metrics;
use super::types::*;
use agaric_core::error::AppError;
use agaric_store::peer_refs;

/// #2481 phase 1 — ingest a replicated op record as append-only, hash-verified
/// **audit metadata**.
///
/// #2621 Sync-D: moved down from the app-side `dag.rs` — it decodes an
/// [`OpTransfer`] (an `agaric-sync` type) and threads the transfer-carried
/// `origin` (which `OpRecord::from` drops) into the engine core
/// [`agaric_engine::dag::ingest_replicated_record`], which reuses
/// `insert_remote_op`'s exact verification recipe (blake3 hash check,
/// NUL-rejection gate, `SetProperty` domain validation, idempotent
/// `INSERT OR IGNORE` on `(device_id, seq)`, divergence probe) under the audit
/// parent-gap policy. The stored record is **never applied to state** (state
/// flows exclusively through Loro CRDT sync); the `is_replicated = 1` stamp keeps
/// it out of boot replay, the materializer apply pipeline, and the apply cursor.
pub async fn insert_replicated_op(
    pool: &SqlitePool,
    transfer: &OpTransfer,
) -> Result<bool, AppError> {
    // `OpRecord::from` drops the transfer-carried `origin`, so thread it through
    // explicitly to the engine core.
    let origin = transfer.origin.clone();
    let record: agaric_store::op_log::OpRecord = transfer.clone().into();
    agaric_engine::dag::ingest_replicated_record(pool, &record, &origin).await
}

/// What one pull session's buffered audit batch did on the way into `op_log`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BatchIngestOutcome {
    /// Records newly landed in `op_log`.
    pub ingested: usize,
    /// Records already held (idempotent redelivery — the `INSERT OR IGNORE`
    /// matched an existing `(device_id, seq)`).
    pub already_held: usize,
    /// Records deliberately abandoned: the record *itself* is unusable, so
    /// re-shipping it would fault identically forever. The frontier is
    /// allowed to advance past these.
    pub rejected: usize,
    /// Records left on the peer for the next session because a transient
    /// failure hit their device's chain earlier in this batch. Nothing was
    /// written for them, so the frontier we advertise for that device still
    /// sits below them and the peer re-ships them.
    pub deferred: usize,
    /// #3726 — records presented with a `seq` BELOW one this batch already
    /// presented for the same device, i.e. a violation of the ascending-`seq`
    /// precondition the defer policy needs (see [`ingest_replicated_batch`]).
    ///
    /// Expected to be zero forever. It is counted rather than corrected: by the
    /// time a record arrives out of order the higher seq has already landed and
    /// the frontier has already moved, so there is nothing left to repair here
    /// — only something to report.
    pub out_of_order: usize,
}

/// #3325 — ingest one pull session's buffered audit records, keeping the
/// per-device frontier we will advertise *contiguous* with what we actually
/// hold.
///
/// The subtlety this function exists for is that the frontier is not a cursor
/// anyone maintains. It is derived, after the fact, from the op log itself:
/// [`get_local_heads`] reports `MAX(seq)` per device, and the peer's
/// [`collect_ops_for_peer`] ships exactly `seq > that`. The log's contents
/// *are* the acknowledgement, so any record skipped while a later record from
/// the same device lands is skipped permanently — the next session's
/// `HeadExchange` advertises the higher seq and the peer never offers the gap
/// again. The old loop skipped every failure alike and asserted in a comment
/// that "the puller's frontier for that device does not advance, so it
/// re-ships next session", which holds only when the failing record happens to
/// be the highest seq that device contributed to the batch.
///
/// The two failure classes want opposite treatment, and conflating them is
/// what made the old behaviour wrong in one direction and right in the other:
///
/// * **Transient** ([`AppError::Database`], [`AppError::PoolTimedOut`]) — a
///   busy writer, a cache rebuild the pre-ingest flush did not fully settle.
///   The record is fine and will land next time, so we must NOT advance past
///   it: this device's remaining records are dropped for the session, leaving
///   our `MAX(seq)` for it at the last seq we truly hold. The peer re-offers
///   from the gap. The cost is one deferred session for that device's tail;
///   the alternative is a hole in the log that nothing ever fills. Note that
///   `Database` is taken as transient *unconditionally*, which is right for
///   `SQLITE_BUSY` and wrong for a full disk or a corrupt page — those stall
///   the device forever and re-download its tail every session. #3727 does not
///   change that classification (see below for why) but stops it being
///   invisible: every stall is reported to
///   `audit_ingest_metrics::record_stall`, which keeps a per-device
///   *consecutive* count and escalates to a single `error!` once a device has
///   deferred [`audit_ingest_metrics::PERSISTENT_STALL_BATCHES`] batches
///   running without landing anything — the point at which "busy writer" stops
///   being a plausible explanation. "Without landing anything" is meant
///   literally (#3740): a device that lands records and only then stalls
///   mid-chain has advanced its frontier, so its run is retired at the stall
///   itself and the escalation cannot claim otherwise. The deferred-record total
///   is surfaced through `StatusInfo` alongside it.
/// * **Corrupt** (hash mismatch, NUL byte in a hashed field, `SetProperty`
///   domain violation) — the bytes are unusable and every future re-ship of
///   them is unusable in exactly the same way. Stalling the device here would
///   re-fetch and re-reject the same record every session forever while
///   permanently blocking that device's later ops behind it. So we skip it and
///   let the frontier advance past it, deliberately. The resulting hash-chain
///   discontinuity is already a first-class state on this path:
///   `IngestProfile::Audit` lands an unresolved `parent_seqs` pointer with a
///   `warn!` rather than rejecting it, because peer-side compaction produces
///   legitimate gaps too.
///
/// Skipping the remainder of a stalled device is scoped per `device_id`, never
/// globally — the frontiers are independent, and one busy write must not cost
/// us every other device's records.
///
/// It is NOT order-independent, and that is worth stating plainly rather than
/// glossing. Only records seen *after* the fault are deferred, so a record from
/// the same device carrying a HIGHER seq that was already ingested earlier in
/// the loop has already advanced `MAX(seq)` past the gap — precisely the
/// outcome this function exists to prevent. The policy is therefore correct
/// only under a precondition it does not itself enforce: each device's records
/// must be presented in ascending `seq`. That holds today because
/// [`collect_ops_for_peer`] emits `ORDER BY device_id ASC, seq ASC` and
/// `pending_ingest_records` appends arriving batches in order, preserving it —
/// the same ordering the Audit profile's parent-gap relaxation already depends
/// on. Anything that reorders or parallelises the batch between those two
/// points silently breaks this.
///
/// #3726 makes that precondition **checked** rather than merely documented: the
/// loop tracks the highest `seq` each device has presented and reports any
/// record arriving below it through [`BatchIngestOutcome::out_of_order`] and
/// `audit_ingest_metrics::record_out_of_order`, which emits **one** `error!`
/// per offending device per batch carrying the count (#3740 — the scenario is
/// thousands of records over a handful of devices, and a line each would bury
/// the finding). Three things it deliberately is not:
///
/// * Not a `debug_assert!`. The data loss happens in release builds, where a
///   `debug_assert!` is compiled out — it would trip exactly where the harm
///   cannot occur and stay silent exactly where it can. The check is cheap
///   enough (one `i64` compare and a small map keyed by device) to keep in
///   every build.
/// * Not a defensive sort. Sorting here would make *this call* order-independent
///   while presenting as a global guarantee it cannot give: records are buffered
///   across several `OpLogBatch` messages in `pending_ingest_records`, so any
///   future change that ingested per message instead of per session would leave
///   the cross-call ordering broken and a sort inside this function silently
///   absorbing the evidence. Reporting works per call too — and says so.
/// * Not a behaviour change. An out-of-order record is ingested exactly as it
///   would have been. By the time it arrives the higher seq has already landed
///   and the frontier has already moved past the gap; deferring from that point
///   would only strand the records that could still have filled it.
pub async fn ingest_replicated_batch(
    pool: &SqlitePool,
    records: &[OpTransfer],
    local_device_id: &str,
    remote_device_id: &str,
) -> BatchIngestOutcome {
    ingest_replicated_batch_inner(pool, records, local_device_id, remote_device_id, &|_| None).await
}

/// [`ingest_replicated_batch`] with a synthetic per-record failure injected.
///
/// The policy above turns on *which* error a record produces, and the error
/// that matters most — a transient `SQLITE_BUSY` on one record while its
/// successors succeed — cannot be provoked from outside: a lock held long
/// enough to fault one record faults them all, and `INSERT OR IGNORE` swallows
/// every constraint violation that might otherwise stand in for it. So the
/// seam is explicit. `fault` returns `Some(e)` to fail a record *instead of*
/// writing it, `None` to let the real write proceed.
///
/// Gated to test builds (and the `test-util` feature, since the tests that
/// drive it live in the app crate across a crate boundary), so no production
/// path can reach it.
#[cfg(any(test, feature = "test-util"))]
pub async fn ingest_replicated_batch_with_fault(
    pool: &SqlitePool,
    records: &[OpTransfer],
    local_device_id: &str,
    remote_device_id: &str,
    fault: &(dyn Fn(&OpTransfer) -> Option<AppError> + Sync),
) -> BatchIngestOutcome {
    ingest_replicated_batch_inner(pool, records, local_device_id, remote_device_id, fault).await
}

#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
async fn ingest_replicated_batch_inner(
    pool: &SqlitePool,
    records: &[OpTransfer],
    local_device_id: &str,
    remote_device_id: &str,
    fault: &(dyn Fn(&OpTransfer) -> Option<AppError> + Sync),
) -> BatchIngestOutcome {
    use std::collections::{HashMap, HashSet};

    let mut outcome = BatchIngestOutcome::default();
    // Devices whose chain hit a transient failure this session; their
    // remaining records are left for the peer to re-ship.
    let mut stalled: HashSet<&str> = HashSet::new();
    // Every device this batch presented at all — the complement of `stalled`
    // is the set that made progress, which is what clears a device's
    // consecutive-stall count (#3727).
    let mut seen: HashSet<&str> = HashSet::new();
    // #3740: devices for which something actually LANDED in this batch —
    // ingested, or found already held. Not the complement of `stalled`: a
    // device can land three records and stall on the fourth, and its frontier
    // has moved even though it stalled. That distinction is what the
    // consecutive-stall run is supposed to measure.
    let mut landed: HashSet<&str> = HashSet::new();
    // #3726: the highest `seq` each device has presented SO FAR, which is what
    // the ascending-seq precondition is about. Tracks presentation order, not
    // what landed: a deferred record does not advance the frontier, but a
    // record arriving below it still means the batch was reordered.
    let mut highest_seq: HashMap<&str, i64> = HashMap::new();
    // #3740: out-of-order violations aggregated per device, reported once at
    // the end of the batch rather than once per record. A reordered batch is
    // thousands of records over a handful of devices, and a log line each would
    // bury the finding it is trying to surface.
    let mut out_of_order: HashMap<&str, (i64, i64, u64)> = HashMap::new();

    for record in records {
        let device = record.device_id.as_str();
        seen.insert(device);

        // #3726 — checked before anything else, including the stalled
        // short-circuit: the violation is about the order records were
        // PRESENTED in, so a record skipped by the defer policy is still
        // evidence of it.
        if let Some(&highest) = highest_seq.get(device)
            && record.seq < highest
        {
            outcome.out_of_order += 1;
            out_of_order
                .entry(device)
                .and_modify(|(_, _, count)| *count += 1)
                .or_insert((record.seq, highest, 1));
        }
        highest_seq
            .entry(device)
            .and_modify(|h| *h = (*h).max(record.seq))
            .or_insert(record.seq);

        if stalled.contains(device) {
            outcome.deferred += 1;
            continue;
        }

        let result = match fault(record) {
            Some(e) => Err(e),
            None => insert_replicated_op(pool, record).await,
        };

        match result {
            Ok(true) => {
                outcome.ingested += 1;
                landed.insert(device);
            }
            Ok(false) => {
                outcome.already_held += 1;
                // `already_held` still proves progress since this pull's head
                // exchange: `COLLECT_OPS_FOR_PEER_SQL` offers only `ol.seq >
                // f.seq`, where `f.seq` is the frontier we advertised. If the
                // row is present by insertion time, it landed after that
                // snapshot (for example through an earlier duplicate or a
                // concurrent ingest), so retiring the old no-progress run is
                // sound. Keep this coupled to that query's strict frontier.
                landed.insert(device);
            }
            Err(e @ (AppError::Database(_) | AppError::PoolTimedOut)) => {
                stalled.insert(device);
                outcome.deferred += 1;
                // #3740: if this device already landed a record in THIS batch,
                // its frontier moved, so whatever run it was carrying is over
                // and this stall starts a new one. Retired here, before the
                // stall is counted, and not in the post-loop sweep: the
                // escalation fires from inside `record_stall`, so a reset that
                // happened afterwards would arrive too late to stop an `error!`
                // asserting that the device has been "running without landing
                // anything" in the very batch where it landed something.
                if landed.contains(device) {
                    audit_ingest_metrics::note_progress(device);
                }
                // #3727: aggregate the stall before logging it, so the warn
                // line carries how many batches running this device has now
                // failed to make any progress. One is a busy writer; a run of
                // them is a condition that will not clear on its own, and
                // `record_stall` escalates to `error!` at that point.
                let consecutive = audit_ingest_metrics::record_stall(
                    remote_device_id,
                    device,
                    record.seq,
                    &e.to_string(),
                );
                tracing::warn!(
                    device_id = %local_device_id,
                    remote_device_id = %remote_device_id,
                    op_device_id = %record.device_id,
                    op_seq = record.seq,
                    consecutive,
                    error = %e,
                    "#2481: transient DB error ingesting a replicated op record; \
                     deferring the rest of this device's chain so our advertised \
                     frontier stays contiguous and the peer re-ships from the gap (#3325)"
                );
            }
            Err(e) => {
                outcome.rejected += 1;
                tracing::error!(
                    device_id = %local_device_id,
                    remote_device_id = %remote_device_id,
                    op_device_id = %record.device_id,
                    op_seq = record.seq,
                    error = %e,
                    "#2481: rejecting a corrupt replicated op record; skipping it \
                     permanently (audit-only, not load-bearing for state — a \
                     re-ship would fault identically forever, #3325)"
                );
            }
        }
    }

    // #3727: a device that appeared in this batch and did NOT stall has made
    // progress, which retires any consecutive-stall run it was carrying. Done
    // once per batch per device rather than once per record — a batch is
    // thousands of records over a handful of devices, and the map being probed
    // is normally empty. Devices that stalled *after* landing something were
    // already retired at the stall itself (#3740).
    for device in seen.difference(&stalled) {
        audit_ingest_metrics::note_progress(device);
    }
    // #3726/#3740: one summarised line per offending device, after the loop, so
    // a reordered batch produces a handful of lines rather than one per record.
    for (device, (first_seq, first_highest, count)) in out_of_order {
        audit_ingest_metrics::record_out_of_order(
            remote_device_id,
            device,
            first_seq,
            first_highest,
            count,
        );
    }
    audit_ingest_metrics::record_deferred(outcome.deferred);

    outcome
}

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
    // dynamic-sql: not dynamic — a fixed literal with no interpolation and no
    // bind parameters, predating #646 and untouched by #3326. It takes the
    // runtime form because its row type is supplied by hand
    // (`DeviceHead: FromRow`) rather than inferred by the macro. The marker
    // exists only because the sibling #3326 site below pushes this file's
    // dynamic-site count past its baseline, at which point the hook demands a
    // marker on *every* site in the file.
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
    let local_by_space: HashMap<&agaric_store::space::SpaceId, &[u8]> = local_loro_vvs
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
/// [`crate::sync_protocol::insert_replicated_op`]'s audit-mode parent-gap relaxation
/// relies on to attribute a gap to peer-side compaction.
///
/// `origin` is carried verbatim (it is not part of the hash preimage — see
/// `op-log-format.md`), so cross-device attribution travels with the op. This
/// deliberately includes replicated (`is_replicated = 1`) rows we already hold
/// so a frontier propagates transitively; the records are audit-only on the
/// receiver too, so re-shipping them is safe.
///
/// #3326: the frontier is applied **in SQL** (see
/// `COLLECT_OPS_FOR_PEER_SQL`). Until then this read was
/// `SELECT … FROM op_log` with no `WHERE` — one full materialisation of the
/// whole log, payloads included, on every head exchange with an
/// `op_log_replication`-capable peer — which is every modern peer, on every
/// session: the `DEFAULT_RESYNC` idle tick (60 s) *and* `DEFAULT_DEBOUNCE`
/// (3 s) after each local edit burst. All of it only to throw away, in a Rust
/// loop, everything at or below the peer's frontier — which for a caught-up
/// peer is all of it. The op set returned is unchanged; only the rows SQLite
/// touches to produce it are.
pub async fn collect_ops_for_peer(
    pool: &SqlitePool,
    peer_heads: &[DeviceHead],
) -> Result<Vec<OpTransfer>, AppError> {
    // dynamic-sql: not dynamic — the statement is a `const` so the #3326
    // plan-regression test (`collect_ops_for_peer_seeks_the_frontier_3326`) can
    // run `EXPLAIN QUERY PLAN` over *the exact text production executes*
    // rather than a hand-copied duplicate that could silently drift back to a
    // full scan. `sqlx::query!` only accepts a string literal, so the macro
    // form cannot share its SQL with a test. The statement is exercised (and
    // therefore schema-checked) by that test plus the frontier-parity oracle.
    let rows = sqlx::query_as::<_, OpRow>(COLLECT_OPS_FOR_PEER_SQL)
        .bind(peer_frontier_json(peer_heads)?)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(OpRow::into_transfer).collect())
}

/// The one statement [`collect_ops_for_peer`] runs. Shared with the #3326
/// plan-regression test — see the `dynamic-sql` note at the call site.
///
/// #3326: the frontier lives in SQL. `devices` is the same
/// loose-index-scan emulation [`get_local_heads`] uses (#430) — the distinct
/// `device_id`s by covering-index seek, not a scan. `frontier` pins one
/// `(device_id, seq)` cutoff per device we hold, defaulting to 0 for a device
/// the peer never advertised (so all of its ops qualify, matching the old Rust
/// `unwrap_or(0)`). The final join is a `CROSS JOIN` **on purpose**: it fixes
/// the loop order so the tiny `frontier` drives and `op_log` is only *sought*
/// (`SEARCH … (device_id=? AND seq>?)` on the `(device_id, seq)` PK). Without
/// it the planner picks `op_log` as the outer table and scans the whole log —
/// which is precisely the pre-#3326 behaviour this replaces.
const COLLECT_OPS_FOR_PEER_SQL: &str = "\
WITH RECURSIVE devices(device_id) AS ( \
    SELECT (SELECT device_id FROM op_log ORDER BY device_id LIMIT 1) \
    UNION ALL \
    SELECT (SELECT ol.device_id FROM op_log ol \
              WHERE ol.device_id > devices.device_id \
              ORDER BY ol.device_id LIMIT 1) \
      FROM devices \
     WHERE devices.device_id IS NOT NULL \
), \
frontier(device_id, seq) AS MATERIALIZED ( \
    SELECT d.device_id, \
           COALESCE(( \
               SELECT json_extract(pf.value, '$.s') FROM json_each(?1) pf \
                WHERE json_extract(pf.value, '$.d') = d.device_id \
           ), 0) \
      FROM devices d \
     WHERE d.device_id IS NOT NULL \
) \
SELECT ol.device_id, ol.seq, ol.parent_seqs, ol.hash, ol.op_type, ol.payload, \
       ol.created_at, ol.origin \
  FROM frontier f \
  CROSS JOIN op_log ol \
    ON ol.device_id = f.device_id AND ol.seq > f.seq \
 ORDER BY ol.device_id ASC, ol.seq ASC";

/// Row shape of [`COLLECT_OPS_FOR_PEER_SQL`]. Kept private: the DB↔wire
/// boundary documented on [`OpTransfer`] stays intact — this is the DB side.
#[derive(sqlx::FromRow)]
struct OpRow {
    device_id: String,
    seq: i64,
    parent_seqs: Option<String>,
    hash: String,
    op_type: String,
    payload: String,
    created_at: i64,
    origin: String,
}

impl OpRow {
    fn into_transfer(self) -> OpTransfer {
        OpTransfer {
            device_id: self.device_id,
            seq: self.seq,
            parent_seqs: self.parent_seqs,
            hash: self.hash,
            op_type: self.op_type,
            payload: self.payload,
            created_at: self.created_at,
            origin: self.origin,
        }
    }
}

/// The peer's advertised frontier as the `[{"d": device_id, "s": seq}, …]`
/// JSON array [`COLLECT_OPS_FOR_PEER_SQL`]'s `json_each` expands.
///
/// Routing it through a map first is not incidental: it preserves the exact
/// tie-break the pre-#3326 Rust loop had. That loop built a `HashMap` from
/// `peer_heads`, so a peer that advertised the same `device_id` twice was
/// resolved **last-wins**; a bare array would make `json_each` resolve it
/// first-wins instead, i.e. a different (and lower) cutoff, i.e. a different
/// op set on the wire.
fn peer_frontier_json(peer_heads: &[DeviceHead]) -> Result<String, AppError> {
    use std::collections::HashMap;

    #[derive(serde::Serialize)]
    struct FrontierEntry<'a> {
        d: &'a str,
        s: i64,
    }

    let peer_frontier: HashMap<&str, i64> = peer_heads
        .iter()
        .map(|h| (h.device_id.as_str(), h.seq))
        .collect();
    let entries: Vec<FrontierEntry<'_>> = peer_frontier
        .iter()
        .map(|(&d, &s)| FrontierEntry { d, s })
        .collect();
    Ok(serde_json::to_string(&entries)?)
}

/// Cheap upper-bound estimate of one record's inline JSON footprint, as billed
/// by [`batch_ops_for_wire`]: the serialized record's own length plus a flat
/// `+ 2` per-element envelope allowance, for the bytes a record's own
/// serialization doesn't cover once it sits inside the batch's JSON array
/// (`SyncMessage::OpLogBatch`'s `records` is a plain array, so the overhead is
/// the separating commas plus the enclosing brackets).
///
/// That breakdown is **reconstructed, not recovered**: `git log -S` back to
/// the formula's introduction (#2481/#2495) shows the original comment said
/// only "a small per-element envelope allowance" and never named a split. It
/// is offered as the reading that fits the wire format, not as the author's
/// stated intent.
///
/// It also **deliberately over-provisions**, and that is not a bug to tighten:
/// N records need N-1 commas plus 2 brackets — `N + 1` bytes — where this
/// bills `2N`. An upper bound is what the caller wants, so do not "correct"
/// this to `+ 1`; doing so would turn a bound into an estimate that can be
/// wrong in the direction that overflows the cap.
///
/// Scope of that bound, stated because it is narrower than it reads:
/// `sum(billed_bytes) <= max_bytes` bounds the `records` ARRAY — its commas
/// and brackets — and **not** the `SyncMessage::OpLogBatch` envelope around
/// it (the `"type"` tag, the `records` key, the outer braces, `is_last`).
/// That envelope costs tens of bytes and exceeds the `N-1` surplus for small
/// N, so a batch passing this cap does not imply the serialized MESSAGE fits
/// it. Nothing depends on that implication: `collect_op_batches_for_peer`
/// re-serializes each batch and measures the real thing, failing closed with
/// `map_or(usize::MAX, ..)`. This function is the partitioning heuristic, not
/// the wire-size authority.
///
/// `pub(crate)` rather than private so `protocol_proptest`'s property tests
/// can call the exact function `batch_ops_for_wire` bills against, instead of
/// keeping their own copy of the formula that could silently drift from it
/// (#4525).
///
/// **The `map_or` `Err` arm is dead for today's `OpTransfer` — not merely
/// untested, unreachable.** Every field is a `String`, `i64`, or
/// `Option<String>`, and the struct derives `Serialize` with no custom impl;
/// `serde_json::to_string` can only fail on a map with non-string keys, or a
/// `Serialize` impl that itself returns `Err` (`std::io::Error` can't occur —
/// `to_string` writes into an in-memory buffer). `OpTransfer` has none of
/// those, so this cannot hit `Err` today; it would need a new field of one of
/// those kinds — most plausibly a `HashMap` keyed on something other than
/// `String` — to become reachable again.
///
/// A **non-finite float does NOT belong on that list**, though an earlier
/// revision of this comment said it did. `serde_json`'s value serializer
/// matches on `value.classify()` and writes `null` for
/// `FpCategory::Nan | FpCategory::Infinite` (`ser.rs:169-175`), so adding an
/// `f32`/`f64` field would not reach this arm. The refusal that reasoning
/// generalised from is a different path: `ser.rs:1042` rejects a non-finite
/// float used as a MAP KEY, which is already covered by the non-string-key
/// case above. Recorded rather than silently deleted, because the value of
/// this paragraph is being a checklist someone trusts without re-deriving
/// it, and one wrong entry costs more than the whole list saves.
///
/// `map_or(0, ..)` stays rather than `unwrap`/`expect` regardless: this
/// runs once per record on the sync send path, and a shared billing helper
/// panicking there would take down the whole sync session over what is
/// already a best-effort upper-bound estimate — a record silently mis-billed
/// at 0 bytes is bounded by the oversized-batch tolerance `batch_ops_for_wire`
/// already documents (a lone record ships in its own batch even past
/// `max_bytes`), which is a smaller failure than losing the session.
pub(crate) fn billed_bytes(rec: &OpTransfer) -> usize {
    serde_json::to_string(rec).map_or(0, |s| s.len()) + 2
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
        let rec_bytes = billed_bytes(&rec);
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

#[cfg(test)]
mod collect_ops_for_peer_tests {
    use super::*;
    use agaric_store::test_support::test_pool;
    use sqlx::SqlitePool;

    /// Three devices, distinct payloads / origins / `parent_seqs`, so a
    /// column-mapping slip shows up as an inequality rather than a count
    /// mismatch.
    async fn seed(pool: &SqlitePool) {
        let rows: &[(&str, i64, Option<&str>, &str)] = &[
            ("device-A", 1, None, "user"),
            ("device-A", 2, Some("1"), "user"),
            ("device-A", 3, Some("2"), "agent:mcp"),
            ("device-A", 4, Some("3"), "user"),
            ("device-A", 5, Some("4"), "user"),
            ("device-B", 1, None, "user"),
            ("device-B", 2, Some("1"), "user"),
            ("device-B", 3, Some("2"), "user"),
            ("device-C", 1, None, "agent:gcal"),
        ];
        for (device_id, seq, parent_seqs, origin) in rows {
            sqlx::query(
                "INSERT INTO op_log \
                   (device_id, seq, parent_seqs, hash, op_type, payload, created_at, origin) \
                 VALUES (?1, ?2, ?3, ?4, 'create_block', ?5, ?6, ?7)",
            )
            .bind(device_id)
            .bind(seq)
            .bind(*parent_seqs)
            .bind(format!("hash-{device_id}-{seq}"))
            .bind(format!(r#"{{"block_id":"01JB{device_id}{seq}"}}"#))
            .bind(1_736_942_400_000_i64 + seq)
            .bind(origin)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn head(device_id: &str, seq: i64) -> DeviceHead {
        DeviceHead {
            device_id: device_id.into(),
            seq,
            hash: format!("hash-{device_id}-{seq}"),
        }
    }

    /// The pre-#3326 implementation, preserved verbatim as the oracle
    /// (AGENTS.md § Performance Conventions, "CTE oracle pattern"): full
    /// `op_log` materialisation, frontier applied in a Rust loop.
    async fn full_scan_oracle(pool: &SqlitePool, peer_heads: &[DeviceHead]) -> Vec<OpTransfer> {
        use std::collections::HashMap;

        let peer_frontier: HashMap<&str, i64> = peer_heads
            .iter()
            .map(|h| (h.device_id.as_str(), h.seq))
            .collect();
        let rows = sqlx::query_as::<_, OpRow>(
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, origin \
             FROM op_log \
             ORDER BY device_id ASC, seq ASC",
        )
        .fetch_all(pool)
        .await
        .unwrap();
        rows.into_iter()
            .filter(|r| {
                r.seq
                    > peer_frontier
                        .get(r.device_id.as_str())
                        .copied()
                        .unwrap_or(0)
            })
            .map(OpRow::into_transfer)
            .collect()
    }

    /// #3326 — the shipped statement must reach `op_log` by a
    /// `(device_id, seq)` PK **seek** per device, never by scanning the log.
    ///
    /// This is the regression the issue is about: the plan, not the result.
    /// Reverting `COLLECT_OPS_FOR_PEER_SQL` to the old unfiltered
    /// `SELECT … FROM op_log ORDER BY …` turns the `SEARCH ol` line below into
    /// `SCAN op_log`, and this assertion fails.
    #[tokio::test]
    async fn collect_ops_for_peer_seeks_the_frontier_3326() {
        let (pool, _dir) = test_pool().await;
        seed(&pool).await;

        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {COLLECT_OPS_FOR_PEER_SQL}"
        )))
        .bind(peer_frontier_json(&[head("device-A", 2)]).unwrap())
        .fetch_all(&pool)
        .await
        .unwrap();
        let plan: String = plan
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        // Asserted in two halves rather than as one exact line so a future
        // SQLite reword of the surrounding phrasing does not fail the build
        // for a plan that is still a seek.
        assert!(
            plan.contains("SEARCH ol") && plan.contains("(device_id=? AND seq>?)"),
            "op_log must be reached by a per-device PK range seek; plan was:\n{plan}"
        );
        assert!(
            !plan.contains("SCAN ol"),
            "the outer loop must be the frontier CTE, not op_log; plan was:\n{plan}"
        );
    }

    /// #3326 — pushing the frontier into SQL must not change *which* ops a
    /// peer receives, in any order, for any frontier shape. A miss here means
    /// a peer silently loses audit history.
    #[tokio::test]
    async fn collect_ops_for_peer_matches_the_full_scan_oracle_3326() {
        let (pool, _dir) = test_pool().await;
        seed(&pool).await;

        let cases: Vec<(&str, Vec<DeviceHead>)> = vec![
            ("peer advertised nothing (first-ever sync)", vec![]),
            (
                "peer fully caught up on every device",
                vec![
                    head("device-A", 5),
                    head("device-B", 3),
                    head("device-C", 1),
                ],
            ),
            (
                "peer lags on some devices",
                vec![head("device-A", 2), head("device-B", 3)],
            ),
            (
                "peer advertised only one of our devices",
                vec![head("device-B", 1)],
            ),
            (
                "peer advertised a device we do not hold",
                vec![head("device-Z", 9), head("device-A", 4)],
            ),
            (
                "peer is ahead of our own frontier",
                vec![head("device-A", 99)],
            ),
            ("peer advertised seq 0", vec![head("device-A", 0)]),
            ("peer advertised a negative seq", vec![head("device-A", -7)]),
            (
                // The pre-#3326 `HashMap` collect resolved a duplicated
                // device_id last-wins; `json_each` alone would resolve it
                // first-wins and ship two extra ops.
                "peer advertised the same device twice (last-wins)",
                vec![head("device-A", 1), head("device-A", 4)],
            ),
        ];

        for (label, heads) in cases {
            let expected = full_scan_oracle(&pool, &heads).await;
            let actual = collect_ops_for_peer(&pool, &heads).await.unwrap();
            assert_eq!(
                actual, expected,
                "{label}: SQL-side frontier must select the same ops, in the same order, \
                 as the pre-#3326 full-scan filter"
            );
        }
    }

    /// An empty `op_log` must not trip the `devices` walk's NULL terminator.
    #[tokio::test]
    async fn collect_ops_for_peer_handles_an_empty_op_log_3326() {
        let (pool, _dir) = test_pool().await;
        assert!(collect_ops_for_peer(&pool, &[]).await.unwrap().is_empty());
        assert!(
            collect_ops_for_peer(&pool, &[head("device-A", 3)])
                .await
                .unwrap()
                .is_empty()
        );
    }
}
