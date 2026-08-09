//! #3726 / #3727 — cross-session observability for the audit op-log ingest
//! path ([`super::ingest_replicated_batch`]).
//!
//! That function makes two decisions whose failure modes are silent, and this
//! module is what makes them audible. Both are **observability only**: nothing
//! here changes the ingest control flow, which is unchanged from #3325.
//!
//! * **Deferral that never clears (#3727).** A transient ingest failure defers
//!   the rest of that device's chain so the `MAX(seq)` frontier we advertise
//!   cannot step over a record we did not write. `AppError::Database` is taken
//!   as transient *unconditionally*, which is right for `SQLITE_BUSY` and
//!   wrong for a full disk, a read-only mount, an I/O error or a corrupt
//!   `op_log` page. Under one of those the defer policy becomes a permanent
//!   stall: every session the peer re-ships that device's whole tail, the
//!   first record faults identically, the rest are deferred, and nothing
//!   lands — forever, while the pull itself reports success. The only prior
//!   signal was a per-record `tracing::warn!` that nothing aggregates.
//!
//!   The distinguishing signal is not "a record was deferred" (one busy write
//!   does that and is normal) but "the same device deferred again, and again".
//!   So [`record_stall`] keeps a per-device *consecutive* count, reset by
//!   [`note_progress`] the moment that device makes any progress, and escalates
//!   to a single `error!` line once it crosses
//!   [`PERSISTENT_STALL_BATCHES`] — the point at which "busy writer" stops
//!   being a plausible explanation.
//!
//! * **A precondition violated in silence (#3726).** The defer policy is
//!   correct only when each device's records are presented in ascending `seq`;
//!   a higher seq ingested *earlier* in the same batch has already advanced the
//!   frontier past the gap the deferral was supposed to protect. Nothing
//!   enforced that. [`record_out_of_order`] is the cheap release-mode check the
//!   issue asked for: it does not reorder anything (see
//!   [`super::ingest_replicated_batch`] for why a defensive sort was rejected),
//!   it reports that the invariant the policy rests on has been broken.
//!
//! Shape follows the [`super::snapshot_fallback_metrics`] precedent (#1319):
//! process-global monotonic counters plus the latest occurrence, surfaced
//! through `StatusInfo` so the condition is answerable from the status
//! endpoint rather than by scraping per-session log lines.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Consecutive batches a device may stall before the stall is reported as
/// persistent rather than as a passing busy writer.
///
/// Three, not one: a single `SQLITE_BUSY` is the case the defer policy was
/// designed for and is not news. Three consecutive pull sessions in which the
/// *same* device's chain faulted on its first record and made no progress is
/// not a busy writer any more — it is the #3727 condition (full disk,
/// read-only mount, corrupt page), and the tail being re-downloaded and
/// discarded grows with every session it persists.
pub const PERSISTENT_STALL_BATCHES: u32 = 3;

/// Process-global count of audit records left for the peer to re-ship because
/// a transient failure hit their device's chain (`BatchIngestOutcome::deferred`
/// summed over every batch). Monotonic; never reset, which keeps the delta
/// assertions in the tests robust under nextest parallelism.
static DEFERRED_RECORDS: AtomicU64 = AtomicU64::new(0);

/// Process-global count of *stall events* — one per device whose chain was
/// deferred in a batch, as opposed to [`DEFERRED_RECORDS`], which counts the
/// records that deferral cost. Monotonic.
static STALLED_DEVICES: AtomicU64 = AtomicU64::new(0);

/// Process-global count of audit records presented out of ascending-`seq`
/// order for their device — the #3726 precondition violation. Monotonic.
///
/// This is expected to be zero forever. A non-zero value means something
/// between `collect_ops_for_peer`'s `ORDER BY device_id ASC, seq ASC` and the
/// ingest loop reordered or parallelised the batch, and that the deferral
/// policy has therefore already been able to leave a permanent hole in a
/// device's replicated history.
static OUT_OF_ORDER_RECORDS: AtomicU64 = AtomicU64::new(0);

/// Latest stall occurrence, captured at [`record_stall`]. `None` until the
/// first stall in this process. Guarded by a `Mutex` (writes are rare — at
/// most one per device per pull session); reads happen only on the cold status
/// path.
static LAST_STALL: Mutex<Option<AuditIngestStall>> = Mutex::new(None);

/// Consecutive stalled batches per op `device_id`, reset by [`note_progress`].
///
/// A `BTreeMap` rather than a `HashMap` purely because `BTreeMap::new` is
/// `const` and so can initialise a `static Mutex` without a `OnceLock`. The map
/// holds one entry per device *currently* stalling, which is normally zero and
/// is bounded by the device count regardless.
static CONSECUTIVE_STALLS: Mutex<BTreeMap<String, u32>> = Mutex::new(BTreeMap::new());

/// Snapshot of the most recent audit-ingest stall. Surfaced (cloned) through
/// `StatusInfo::audit_ingest_last_stall`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct AuditIngestStall {
    /// Monotonic ordinal of this stall within the process — equal to
    /// [`stalls`] at the moment it was recorded. Lets an operator tell apart
    /// "a new stall happened" from "the same stale record is being re-read".
    pub occurrence: u64,
    /// Remote device / peer that shipped the batch.
    pub remote_device_id: String,
    /// The op-log device whose chain stalled (usually *not* the peer that
    /// shipped it — frontiers propagate transitively).
    pub op_device_id: String,
    /// The `seq` that faulted. Everything above it in that device's chain was
    /// deferred.
    pub op_seq: i64,
    /// How many consecutive batches this device has now stalled without making
    /// progress. `1` is an ordinary busy writer; a value at or above
    /// [`PERSISTENT_STALL_BATCHES`] is the #3727 permanent-stall condition.
    pub consecutive: u32,
    /// The classified-as-transient error, rendered.
    pub error: String,
}

/// Record that a device's chain stalled on a transient ingest failure, and
/// return how many consecutive batches it has now stalled for.
///
/// Escalates to `error!` once the consecutive count reaches
/// [`PERSISTENT_STALL_BATCHES`]: at that point the "transient" classification
/// is not holding up and the device's audit history is not advancing. The
/// per-record `warn!` at the call site is deliberately left alone — it carries
/// the single-occurrence detail, this carries the pattern.
pub(crate) fn record_stall(
    remote_device_id: &str,
    op_device_id: &str,
    op_seq: i64,
    error: &str,
) -> u32 {
    // `fetch_add` returns the PREVIOUS value; the ordinal of this occurrence is
    // therefore `prev + 1`, matching what a subsequent `stalls()` reads.
    let occurrence = STALLED_DEVICES.fetch_add(1, Ordering::Relaxed) + 1;

    let consecutive = match CONSECUTIVE_STALLS.lock() {
        Ok(mut map) => {
            let n = map.entry(op_device_id.to_owned()).or_insert(0);
            *n = n.saturating_add(1);
            *n
        }
        // A poisoned mutex must not cost us the count; report the occurrence
        // as a first stall rather than dropping the signal.
        Err(_) => 1,
    };

    if let Ok(mut last) = LAST_STALL.lock() {
        *last = Some(AuditIngestStall {
            occurrence,
            remote_device_id: remote_device_id.to_owned(),
            op_device_id: op_device_id.to_owned(),
            op_seq,
            consecutive,
            error: error.to_owned(),
        });
    }

    if consecutive >= PERSISTENT_STALL_BATCHES {
        tracing::error!(
            target: "sync_protocol::audit_ingest",
            occurrence,
            remote_device_id,
            op_device_id,
            op_seq,
            consecutive,
            error,
            "#3727: this device's replicated op-log tail has now been deferred \
             {consecutive} batches running without landing anything — the failure \
             classified as transient is not clearing (full disk? read-only mount? \
             corrupt op_log page?). Its audit history is frozen at the seq below \
             the fault and its whole tail is being re-downloaded and discarded \
             every session"
        );
    } else {
        tracing::debug!(
            target: "sync_protocol::audit_ingest",
            occurrence,
            remote_device_id,
            op_device_id,
            op_seq,
            consecutive,
            error,
            "#3727: audit ingest deferred a device's chain on a transient failure"
        );
    }

    consecutive
}

/// Record that `count` audit records were left for the peer to re-ship.
///
/// Called once per batch with `BatchIngestOutcome::deferred`. A no-op at zero
/// so the counter tracks records actually deferred, not batches inspected.
pub(crate) fn record_deferred(count: usize) {
    if count > 0 {
        DEFERRED_RECORDS.fetch_add(count as u64, Ordering::Relaxed);
    }
}

/// Clear a device's consecutive-stall count because it made progress in this
/// batch (something landed, or was already held, and nothing stalled).
///
/// This is what keeps [`AuditIngestStall::consecutive`] a measure of a
/// *persistent* condition rather than a lifetime tally: an ordinary busy writer
/// stalls once and the very next session clears it.
pub(crate) fn note_progress(op_device_id: &str) {
    if let Ok(mut map) = CONSECUTIVE_STALLS.lock()
        && map.remove(op_device_id).is_some()
    {
        tracing::debug!(
            target: "sync_protocol::audit_ingest",
            op_device_id,
            "#3727: a previously stalled device's audit ingest made progress; \
             consecutive-stall count cleared"
        );
    }
}

/// Record that a record arrived below the highest `seq` already presented for
/// its device — the #3726 precondition violation.
///
/// `highest_seq_seen` is what the batch had already presented for that device
/// when `op_seq` arrived. Logged at `error!` because by the time this fires the
/// frontier may already have stepped over a record we do not hold, and the
/// peer will not offer it again.
pub(crate) fn record_out_of_order(
    remote_device_id: &str,
    op_device_id: &str,
    op_seq: i64,
    highest_seq_seen: i64,
) {
    OUT_OF_ORDER_RECORDS.fetch_add(1, Ordering::Relaxed);
    tracing::error!(
        target: "sync_protocol::audit_ingest",
        remote_device_id,
        op_device_id,
        op_seq,
        highest_seq_seen,
        "#3726: replicated op records for this device arrived out of ascending \
         seq order (seq {op_seq} after seq {highest_seq_seen}). The audit-ingest \
         defer policy only defers records seen AFTER a fault, so the frontier we \
         advertise for this device can now step over a record we failed to write \
         and the peer will never offer it again. Something between \
         collect_ops_for_peer's ORDER BY and this loop reordered the batch"
    );
}

/// Total audit records deferred in this process. Monotonic.
///
/// Read in production by the status builder
/// (`materializer::coordinator`), which surfaces it as
/// `StatusInfo::audit_ingest_deferred`.
pub fn deferred_records() -> u64 {
    DEFERRED_RECORDS.load(Ordering::Relaxed)
}

/// Total device-stall events in this process. Monotonic.
pub fn stalls() -> u64 {
    STALLED_DEVICES.load(Ordering::Relaxed)
}

/// Total out-of-order audit records seen in this process. Monotonic, and
/// expected to stay zero — see [`OUT_OF_ORDER_RECORDS`].
pub fn out_of_order_records() -> u64 {
    OUT_OF_ORDER_RECORDS.load(Ordering::Relaxed)
}

/// The most recent audit-ingest stall, or `None` if none has happened in this
/// process. Surfaced through `StatusInfo::audit_ingest_last_stall`.
///
/// Named `last` rather than `last_stall` deliberately: `scripts/check-metric-provable.mjs`
/// recognises a module as a metrics module by its `count`/`last`/`total`/`snapshot`
/// accessor, and it is that recognition which puts the three counters above
/// under the firing-test and production-emit rules. A descriptive name here
/// would take them back out of the guard's enumeration — a silent miss, which
/// is the exact failure mode #3727 asks this module to remove.
pub fn last() -> Option<AuditIngestStall> {
    LAST_STALL.lock().ok().and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique device id per test, so the shared process-global
    /// consecutive-stall map cannot make these tests order-dependent under
    /// nextest's in-process parallelism.
    fn dev(tag: &str) -> String {
        format!("device-{tag}-{:?}", std::thread::current().id())
    }

    /// Read a counter by its STATIC name rather than through its accessor, so
    /// the assertion below names the metric the way
    /// `scripts/check-metric-provable.mjs` matches evidence on (`\bNAME\b`).
    /// The accessors are checked alongside, which also pins them to the static
    /// they claim to report.
    #[test]
    fn record_deferred_moves_the_deferred_counter() {
        // Monotonic, never-reset counters: assert the DELTA so concurrent
        // tests recording in the same binary cannot break this.
        let before = DEFERRED_RECORDS.load(Ordering::Relaxed);
        assert_eq!(deferred_records(), before, "the accessor reads the static");
        record_deferred(4);
        let after = DEFERRED_RECORDS.load(Ordering::Relaxed);
        assert!(
            after > before,
            "record_deferred must move the process-global deferred count \
             (before={before}, after={after})"
        );
        assert!(
            after - before >= 4,
            "record_deferred(4) must add at least 4 (before={before}, after={after})"
        );
    }

    #[test]
    fn record_deferred_is_a_no_op_at_zero() {
        let before = DEFERRED_RECORDS.load(Ordering::Relaxed);
        record_deferred(0);
        assert_eq!(
            DEFERRED_RECORDS.load(Ordering::Relaxed),
            before,
            "a batch that deferred nothing must not move the counter"
        );
    }

    #[test]
    fn record_stall_moves_the_stall_counter_and_captures_the_occurrence() {
        let device = dev("stall");
        let before = STALLED_DEVICES.load(Ordering::Relaxed);
        assert_eq!(stalls(), before, "the accessor reads the static");
        let consecutive = record_stall("peer-xyz", &device, 7, "PoolTimedOut");
        let after = STALLED_DEVICES.load(Ordering::Relaxed);
        assert!(
            after > before,
            "record_stall must move the process-global stall count \
             (before={before}, after={after})"
        );
        assert_eq!(consecutive, 1, "a first stall is one consecutive batch");

        let recorded = last().expect("a stall occurrence must now be recorded");
        assert!(
            recorded.occurrence >= after,
            "last().occurrence ({}) must be at least the post-record count ({after})",
            recorded.occurrence
        );
        note_progress(&device);
    }

    /// The signal #3727 is actually about: the same device stalling batch after
    /// batch. `consecutive` must climb to the persistent threshold, and a
    /// single successful batch must put it back to a first stall.
    #[test]
    fn consecutive_stalls_climb_until_the_device_makes_progress() {
        let device = dev("persistent");
        let mut consecutive = 0;
        for _ in 0..PERSISTENT_STALL_BATCHES {
            consecutive = record_stall("peer-xyz", &device, 7, "Database(disk is full)");
        }
        assert_eq!(
            consecutive, PERSISTENT_STALL_BATCHES,
            "a device that stalls on every batch must reach the persistent-stall \
             threshold rather than reading as a fresh busy writer each time"
        );

        note_progress(&device);
        assert_eq!(
            record_stall("peer-xyz", &device, 7, "PoolTimedOut"),
            1,
            "progress must reset the consecutive count, or an ordinary busy \
             writer eventually reads as a permanent stall"
        );
        note_progress(&device);
    }

    #[test]
    fn note_progress_on_a_device_that_never_stalled_is_harmless() {
        note_progress(&dev("never-stalled"));
        assert_eq!(
            record_stall("peer-xyz", &dev("never-stalled"), 1, "PoolTimedOut"),
            1
        );
        note_progress(&dev("never-stalled"));
    }

    #[test]
    fn record_out_of_order_moves_the_out_of_order_counter() {
        let before = OUT_OF_ORDER_RECORDS.load(Ordering::Relaxed);
        assert_eq!(
            out_of_order_records(),
            before,
            "the accessor reads the static"
        );
        record_out_of_order("peer-xyz", &dev("ooo"), 7, 10);
        let after = OUT_OF_ORDER_RECORDS.load(Ordering::Relaxed);
        assert!(
            after > before,
            "record_out_of_order must move the process-global out-of-order count \
             (before={before}, after={after})"
        );
    }
}
