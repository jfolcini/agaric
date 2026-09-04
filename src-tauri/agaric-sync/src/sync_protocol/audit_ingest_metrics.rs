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
//!   does that and is normal) but "the same device deferred again, and again,
//!   landing nothing in between". So `record_stall` keeps a per-device
//!   *consecutive* count, retired by `note_progress` as soon as anything lands
//!   for that device — including in the very batch that then stalls mid-chain,
//!   which is what keeps the escalation's claim true (#3740) — and escalates to
//!   a single `error!` line once it crosses [`PERSISTENT_STALL_BATCHES`], the
//!   point at which "busy writer" stops being a plausible explanation.
//!
//!   A run also ages out after `STALL_RUN_TTL`. A device that stalls once and
//!   is then retired would otherwise leave its entry in the map forever, and
//!   reappearing months later to stall again would read as `consecutive == 2`
//!   rather than as the fresh busy writer it is (#3740).
//!
//! * **A precondition violated in silence (#3726).** The defer policy is
//!   correct only when each device's records are presented in ascending `seq`;
//!   a higher seq ingested *earlier* in the same batch has already advanced the
//!   frontier past the gap the deferral was supposed to protect. Nothing
//!   enforced that. `record_out_of_order` is the cheap release-mode check the
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
use std::time::{Duration, Instant};

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

/// How long a consecutive-stall run survives without another stall before it is
/// forgotten (#3740).
///
/// The count means "consecutive *pull sessions*", and `SyncScheduler`'s
/// `DEFAULT_RESYNC` puts one of those roughly every 60 s while a peer is
/// connected. Ten minutes is therefore ~10 sessions of silence: long enough that
/// a device stalling on consecutive sessions never has its run reset out from
/// under it, short enough that a device which stalled once, went away and came
/// back reads as a first stall rather than as the second batch of a run. It also
/// bounds [`CONSECUTIVE_STALLS`]: the key is wire-supplied
/// (`OpTransfer.device_id`), so without an age-out the map's growth is limited
/// only by how often a real DB fault can be provoked.
const STALL_RUN_TTL: Duration = Duration::from_secs(600);

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

/// Consecutive stalled batches per op `device_id`, retired by [`note_progress`]
/// and aged out after [`STALL_RUN_TTL`].
///
/// A `BTreeMap` rather than a `HashMap` purely because `BTreeMap::new` is
/// `const` and so can initialise a `static Mutex` without a `OnceLock`. The map
/// holds one entry per device that has stalled *recently*, which is normally
/// zero.
static CONSECUTIVE_STALLS: Mutex<BTreeMap<String, StallRun>> = Mutex::new(BTreeMap::new());

/// One device's live stall run: how many consecutive batches it has stalled,
/// when the last of them happened (for the [`STALL_RUN_TTL`] age-out), and the
/// occurrence itself, so a test can ask about *this* device rather than reading
/// the process-wide [`LAST_STALL`] another test may have overwritten.
#[derive(Debug, Clone)]
struct StallRun {
    at: Instant,
    stall: AuditIngestStall,
}

/// The record `StatusInfo::audit_ingest_last_stall` carries. Defined in
/// `agaric-core` (#4502) so the materializer's status type does not depend on
/// this crate.
pub use agaric_core::sync_status::AuditIngestStall;

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
    record_stall_at(
        remote_device_id,
        op_device_id,
        op_seq,
        error,
        Instant::now(),
        &CONSECUTIVE_STALLS,
        &LAST_STALL,
    )
}

/// [`record_stall`] with the clock and mutable occurrence state passed in, so the
/// [`STALL_RUN_TTL`] age-out is testable without sleeping for ten minutes or
/// sweeping/overwriting another parallel test's process-global entries with a
/// fabricated future timestamp.
fn record_stall_at(
    remote_device_id: &str,
    op_device_id: &str,
    op_seq: i64,
    error: &str,
    now: Instant,
    runs: &Mutex<BTreeMap<String, StallRun>>,
    latest: &Mutex<Option<AuditIngestStall>>,
) -> u32 {
    // `fetch_add` returns the PREVIOUS value; the ordinal of this occurrence is
    // therefore `prev + 1`, matching what a subsequent `stalls()` reads.
    let occurrence = STALLED_DEVICES.fetch_add(1, Ordering::Relaxed) + 1;

    let mut stall = AuditIngestStall {
        occurrence,
        remote_device_id: remote_device_id.to_owned(),
        op_device_id: op_device_id.to_owned(),
        op_seq,
        consecutive: 1,
        error: error.to_owned(),
    };

    let consecutive = match runs.lock() {
        Ok(mut map) => {
            // Age out every run that has gone quiet, this device's included:
            // a run is "consecutive batches", and a device that has not stalled
            // for TTL has not been stalling consecutively. Done on the write
            // path rather than on a timer because this is the only place the
            // map grows (#3740).
            map.retain(|_, run| now.duration_since(run.at) < STALL_RUN_TTL);
            let consecutive = map
                .get(op_device_id)
                .map_or(0, |run| run.stall.consecutive)
                .saturating_add(1);
            stall.consecutive = consecutive;
            map.insert(
                op_device_id.to_owned(),
                StallRun {
                    at: now,
                    stall: stall.clone(),
                },
            );
            consecutive
        }
        // A poisoned mutex must not cost us the count; report the occurrence
        // as a first stall rather than dropping the signal.
        Err(_) => 1,
    };
    publish_latest(latest, stall);

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

/// Publish an occurrence without letting concurrent writers move "latest"
/// backwards.
fn publish_latest(latest: &Mutex<Option<AuditIngestStall>>, stall: AuditIngestStall) {
    if let Ok(mut last) = latest.lock()
        && last
            .as_ref()
            .is_none_or(|previous| previous.occurrence < stall.occurrence)
    {
        // Counter ordinals are allocated before this lock. Concurrent sync
        // sessions can therefore publish out of order; retain the largest
        // ordinal so "latest" cannot move backwards (#3740).
        *last = Some(stall);
    }
}

/// Record that `count` audit records were left for the peer to re-ship.
///
/// Called once per batch with `BatchIngestOutcome::deferred`. A no-op at zero
/// so the counter tracks records actually deferred, not batches inspected.
pub(crate) fn record_deferred(count: usize) {
    record_deferred_with_counter(count, &DEFERRED_RECORDS);
}

/// [`record_deferred`] with its counter passed in, so exact-count and zero
/// assertions do not race the process-global metric under plain parallel
/// `cargo test` (#3740).
fn record_deferred_with_counter(count: usize, counter: &AtomicU64) {
    if count > 0 {
        counter.fetch_add(count as u64, Ordering::Relaxed);
    }
}

/// Retire a device's consecutive-stall run because its frontier moved: a record
/// of its landed in this batch (ingested or already held), or it appeared in the
/// batch with nothing stalling at all.
///
/// This is what keeps [`AuditIngestStall::consecutive`] a measure of a
/// *persistent* condition rather than a lifetime tally: an ordinary busy writer
/// stalls once and the very next session clears it.
///
/// "Something landed" and "nothing stalled" are **not** the same set, which is
/// what #3740 corrected. A device can land three records and then stall
/// mid-chain on the fourth; its frontier advanced, its tail is not being
/// re-downloaded, and it is not the #3727 condition — so the caller retires the
/// run *before* recording that stall, or the escalation would claim the device
/// has been "running without landing anything" while it demonstrably landed
/// something.
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

/// Record that `count` records arrived below the highest `seq` already presented
/// for their device in one batch — the #3726 precondition violation.
///
/// Called **once per device per batch**, not once per record (#3740). The
/// condition it detects is a reordered or parallelised batch — thousands of
/// records over a handful of devices — so a line per record would produce
/// thousands of long `error!` lines in a single session, and a detector that
/// floods the log is close to a detector that is ignored. `record_stall` shows
/// the same restraint by staying at `debug!` below its threshold. The count
/// travels in the line instead, and the process-global counter still moves once
/// per offending record.
///
/// `first_op_seq` / `first_highest_seq_seen` are the first violation for that
/// device: the seq that arrived and what the batch had already presented for it.
/// Logged at `error!` because by the time this fires the frontier may already
/// have stepped over a record we do not hold, and the peer will not offer it
/// again.
pub(crate) fn record_out_of_order(
    remote_device_id: &str,
    op_device_id: &str,
    first_op_seq: i64,
    first_highest_seq_seen: i64,
    count: u64,
) {
    record_out_of_order_with_counter(
        remote_device_id,
        op_device_id,
        first_op_seq,
        first_highest_seq_seen,
        count,
        &OUT_OF_ORDER_RECORDS,
    );
}

/// [`record_out_of_order`] with its counter passed in, so unit tests can assert
/// exact deltas without racing the process-global metric under plain parallel
/// `cargo test` (#3740).
fn record_out_of_order_with_counter(
    remote_device_id: &str,
    op_device_id: &str,
    first_op_seq: i64,
    first_highest_seq_seen: i64,
    count: u64,
    counter: &AtomicU64,
) {
    if count == 0 {
        return;
    }
    counter.fetch_add(count, Ordering::Relaxed);
    tracing::error!(
        target: "sync_protocol::audit_ingest",
        remote_device_id,
        op_device_id,
        count,
        first_op_seq,
        first_highest_seq_seen,
        "#3726: {count} replicated op record(s) for this device arrived out of \
         ascending seq order (first: seq {first_op_seq} after seq \
         {first_highest_seq_seen}). The audit-ingest defer policy only defers \
         records seen AFTER a fault, so the frontier we advertise for this \
         device can now step over a record we failed to write and the peer will \
         never offer it again. Something between collect_ops_for_peer's ORDER BY \
         and this loop reordered the batch"
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
/// expected to stay zero — see `OUT_OF_ORDER_RECORDS`.
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

/// The live stall run for ONE op device, or `None` if it has no run.
///
/// Exists for tests (#3740). [`last`] is process-global and any other test in
/// the binary can overwrite it between the act and the assertion — the reason
/// [`super::snapshot_fallback_metrics`] declines to assert on its own `last()`
/// contents. This is keyed by device, so a test that uses an id unique to itself
/// can assert exactly what it caused, under plain `cargo test` as well as under
/// nextest's per-test process isolation.
///
/// Gated to test builds and the `test-util` feature, since the tests that drive
/// the ingest loop live in the app crate across a crate boundary.
#[cfg(any(test, feature = "test-util"))]
#[must_use]
pub fn stall_run(op_device_id: &str) -> Option<AuditIngestStall> {
    CONSECUTIVE_STALLS
        .lock()
        .ok()
        .and_then(|map| map.get(op_device_id).map(|run| run.stall.clone()))
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

        let counter = AtomicU64::new(0);
        record_deferred_with_counter(4, &counter);
        assert_eq!(
            counter.load(Ordering::Relaxed),
            4,
            "the injected counter pins the exact per-call increment"
        );
    }

    #[test]
    fn record_deferred_is_a_no_op_at_zero() {
        let counter = AtomicU64::new(0);
        record_deferred_with_counter(0, &counter);
        assert_eq!(
            counter.load(Ordering::Relaxed),
            0,
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

        let own = stall_run(&device).expect("this device's run must be recorded");
        let recorded = last().expect("a stall occurrence must now be recorded");
        assert!(
            recorded.occurrence >= own.occurrence,
            "last().occurrence ({}) must not move behind this test's own \
             occurrence ({})",
            recorded.occurrence,
            own.occurrence
        );
        assert!(
            after >= own.occurrence,
            "the accessor includes this occurrence"
        );
        note_progress(&device);
    }

    #[test]
    fn latest_stall_occurrence_never_moves_backwards() {
        let latest = Mutex::new(None);
        let occurrence = |n| AuditIngestStall {
            occurrence: n,
            remote_device_id: "peer-xyz".into(),
            op_device_id: "device-a".into(),
            op_seq: 7,
            consecutive: 1,
            error: "PoolTimedOut".into(),
        };

        publish_latest(&latest, occurrence(2));
        publish_latest(&latest, occurrence(1));
        assert_eq!(
            latest
                .lock()
                .unwrap()
                .as_ref()
                .map(|stall| stall.occurrence),
            Some(2),
            "a later lock acquisition from an older occurrence must not move \
             the status snapshot backwards"
        );
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
        record_out_of_order("peer-xyz", &dev("ooo"), 7, 10, 1);
        let after = OUT_OF_ORDER_RECORDS.load(Ordering::Relaxed);
        assert!(
            after > before,
            "the production wrapper must move its process-global counter \
             (before={before}, after={after})"
        );
    }

    /// One call per device per batch, so the counter has to carry the whole
    /// batch's violations — otherwise throttling the log would silently throttle
    /// the metric with it (#3740).
    #[test]
    fn record_out_of_order_counts_every_record_it_summarises() {
        let counter = AtomicU64::new(0);
        record_out_of_order_with_counter("peer-xyz", &dev("ooo-batch"), 7, 10, 4, &counter);
        assert_eq!(
            counter.load(Ordering::Relaxed),
            4,
            "one summarised line reporting 4 violations must move the counter \
             by exactly 4"
        );
    }

    #[test]
    fn record_out_of_order_is_a_no_op_at_zero() {
        let counter = AtomicU64::new(0);
        record_out_of_order_with_counter("peer-xyz", &dev("ooo-none"), 0, 0, 0, &counter);
        assert_eq!(
            counter.load(Ordering::Relaxed),
            0,
            "a device with no violations must not be reported at all"
        );
    }

    /// #3740 — a run is "consecutive batches", so it must not survive an
    /// arbitrary gap. A device that stalls once, is retired, and reappears much
    /// later reads as a fresh busy writer; and the entry it left behind does not
    /// sit in the map forever, which is what bounds a map whose key comes off
    /// the wire.
    #[test]
    fn a_stall_run_ages_out_after_the_ttl() {
        let device = dev("aged-out");
        let runs = Mutex::new(BTreeMap::new());
        let latest = Mutex::new(None);
        let t0 = Instant::now();
        assert_eq!(
            record_stall_at("peer-xyz", &device, 7, "PoolTimedOut", t0, &runs, &latest,),
            1
        );
        // Still inside the window: this is a genuine consecutive run.
        assert_eq!(
            record_stall_at(
                "peer-xyz",
                &device,
                7,
                "PoolTimedOut",
                t0 + STALL_RUN_TTL / 2,
                &runs,
                &latest,
            ),
            2,
            "two stalls inside the window are consecutive"
        );
        // Past the window: the old run is gone, this is a first stall again.
        assert_eq!(
            record_stall_at(
                "peer-xyz",
                &device,
                7,
                "PoolTimedOut",
                t0 + STALL_RUN_TTL / 2 + STALL_RUN_TTL + Duration::from_secs(1),
                &runs,
                &latest,
            ),
            1,
            "a device that goes quiet for longer than the TTL must read as a \
             fresh busy writer, not as batch two of a run"
        );
    }

    /// The age-out is a sweep, not a per-key expiry: a device that stalled once
    /// and never came back must not keep its entry alive just because nobody
    /// asked about it again.
    #[test]
    fn an_aged_out_run_is_removed_from_the_map() {
        let retired = dev("retired");
        let active = dev("active");
        let runs = Mutex::new(BTreeMap::new());
        let latest = Mutex::new(None);
        let t0 = Instant::now();
        record_stall_at("peer-xyz", &retired, 7, "PoolTimedOut", t0, &runs, &latest);
        assert!(
            runs.lock().unwrap().contains_key(&retired),
            "the first stall must create a live run before its TTL can be tested"
        );

        record_stall_at(
            "peer-xyz",
            &active,
            7,
            "PoolTimedOut",
            t0 + STALL_RUN_TTL + Duration::from_secs(1),
            &runs,
            &latest,
        );
        assert!(
            !runs.lock().unwrap().contains_key(&retired),
            "the retired device's entry must be swept, or the map grows without \
             bound on a wire-supplied key"
        );
    }

    /// The per-device accessor must report the same run the return value does —
    /// it is what the ingest-loop tests assert on instead of the process-global
    /// `last()`.
    #[test]
    fn stall_run_reports_this_devices_own_run() {
        let device = dev("own-run");
        assert!(
            stall_run(&device).is_none(),
            "no run before the first stall"
        );
        record_stall("peer-xyz", &device, 42, "Database(disk is full)");
        record_stall("peer-xyz", &device, 42, "Database(disk is full)");
        let run = stall_run(&device).expect("a run must be recorded");
        assert_eq!(run.consecutive, 2);
        assert_eq!(run.op_seq, 42);
        assert_eq!(run.op_device_id, device);
        assert!(run.error.contains("full"));

        note_progress(&device);
        assert!(
            stall_run(&device).is_none(),
            "progress must retire the run, not just reset its count"
        );
    }
}
