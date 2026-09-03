//! Crash recovery at boot — runs before any user-visible UI.
//!
//! # Recovery contract
//!
//! [`recover_at_boot`] **MUST** be called exactly once at application start-up,
//! **before** any user operations (edits, syncs, compactions) are allowed. It
//! assumes exclusive write access to the database and is **not** safe to run
//! concurrently with normal user operations.
//!
//! # Recovery sequence
//!
//! 1. Deletes any `log_snapshots` rows with `status = 'pending'` (incomplete
//!    snapshots from a prior crash).
//! 2. **C-2b — boot-time op-log replay.** Walks
//!    `op_log WHERE seq > materializer_apply_cursor.materialized_through_seq`
//!    and re-enqueues each row through the materializer foreground queue
//!    so any ops dropped by a mid-flight crash or `fg_apply_dropped`
//!    event get re-applied. Drains the foreground queue via a Barrier
//!    before continuing so step 3 sees a fully-applied state.
//! 3. Walks `block_drafts` and, for each row, checks whether a corresponding
//!    `edit_block` or `create_block` op already exists in `op_log` after the
//!    draft's `updated_at` timestamp. If not, the draft was never flushed and a
//!    synthetic `edit_block` op is created to recover it.
//! 4. All draft rows are deleted regardless of whether they were recovered or
//!    already flushed.
//!
//! If recovery of an individual draft fails, the error is captured in
//! [`RecoveryReport::draft_errors`] and processing continues with the remaining
//! drafts. This ensures a single corrupt draft cannot block the entire boot
//! sequence.

use serde::{Deserialize, Serialize};
use specta::Type;

mod attachment_blob_backfill;
mod attachment_hash_backfill;
mod boot;
mod cache_refresh;
mod draft_recovery;
pub mod replay;
mod sync_inbox;
#[cfg(test)]
mod tests;

pub use attachment_blob_backfill::backfill_attachment_blobs;
pub use attachment_hash_backfill::backfill_attachment_content_hashes;
pub use boot::recover_at_boot;
pub use cache_refresh::refresh_caches_for_recovered_drafts;
pub use draft_recovery::find_prev_edit;
pub use replay::{ReplayReport, replay_unmaterialized_ops};
pub use sync_inbox::replay_sync_inbox;

// Test wrapper: re-export the once-only-guard reset for in-crate
// test code (`integration_tests.rs`) so multi-test runs aren't poisoned
// by the production guard. Gated on `cfg(test)` / the dev-only `test-util`
// feature (#4499); no release build carries it.
#[cfg(any(test, feature = "test-util"))]
pub use boot::reset_recovery_guard;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Summary returned by [`recover_at_boot`] for observability / logging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReport {
    /// Number of `log_snapshots` rows with `status = 'pending'` that were deleted.
    pub pending_snapshots_deleted: u64,
    /// Block IDs whose drafts were recovered as synthetic `edit_block` ops.
    pub drafts_recovered: Vec<String>,
    /// Number of draft rows that already had a matching op and just needed deletion.
    pub drafts_already_flushed: u64,
    /// Wall-clock duration of the entire recovery pass, in milliseconds.
    pub duration_ms: u64,
    /// Non-fatal errors encountered while recovering individual drafts.
    /// Each entry is `"block_id: error message"`.
    pub draft_errors: Vec<String>,
    /// C-2b: number of ops re-enqueued through the materializer foreground
    /// queue at boot. Includes ops that were already idempotently applied
    /// — see `ReplayReport::ops_replayed` for the details.
    pub ops_replayed: u64,
    /// C-2b: ops the replay pass skipped without enqueuing (reserved for
    /// future per-record idempotency detection). Always 0 today.
    pub ops_skipped_idempotent: u64,
    /// C-2b: non-fatal errors encountered during replay enqueue.
    pub replay_errors: Vec<String>,
    /// #535: number of leftover write-ahead `loro_sync_inbox` slots replayed
    /// (re-imported + re-projected, then cleared) at boot. Non-zero means a
    /// prior crash interrupted the apply-remote durability window.
    pub sync_inbox_replayed: u64,
    /// #3226: leftover `loro_sync_inbox` slots this boot MOVED to
    /// `loro_sync_quarantine` after they stayed unresolved across
    /// [`QUARANTINE_AFTER_BOOTS`](crate::sync_protocol::loro_sync_quarantine::QUARANTINE_AFTER_BOOTS)
    /// boot replays. Disjoint from `sync_inbox_replayed` — nothing of a
    /// quarantined slot was projected. The bytes are preserved verbatim (#535);
    /// only the retrying stopped.
    pub sync_inbox_quarantined: u64,
    /// #3226: how many blobs sit in `loro_sync_quarantine` after this boot —
    /// i.e. the standing backlog of inbound content that never reached the
    /// projection and is no longer being retried. Non-zero means a user-visible
    /// diagnostic exists: see
    /// [`list_quarantined_slots`](crate::sync_protocol::loro_sync_quarantine::list_quarantined_slots).
    pub sync_inbox_quarantine_pending: u64,
}

impl RecoveryReport {
    /// #1255: were unmaterialized ops LEFT UNAPPLIED by the C-2b op-log
    /// replay?
    ///
    /// # What `replay_errors` actually holds (#3311)
    ///
    /// The vector carries two structurally different kinds of entry, and
    /// only the first means "the materialized view is behind the op-log":
    ///
    /// 1. **Ops not applied.** `"replay aborted: …"` — synthesised by
    ///    `boot::recover_at_boot` when [`replay_unmaterialized_ops`]
    ///    returned an `Err` (a corrupted `op_log`, a stuck foreground
    ///    queue, or the #412 multi-device hard-abort), and `"enqueue: …"`
    ///    — a record that failed to reach the foreground queue. In both
    ///    cases ops were skipped and the cursor did not advance past them.
    /// 2. **Reprojection degraded.** Entries prefixed
    ///    `replay::REPROJECT_DEGRADED_PREFIX` arrive on the `Ok` path: every op
    ///    applied and the cursor advanced past all of them; a per-group
    ///    engine read / `pool.acquire()` / dense-reproject failure left one
    ///    sibling group's SQL `position` ranks stale, which self-heals on
    ///    that group's next move/create. Nothing is missing or unapplied.
    ///
    /// This predicate is true only for kind 1. Before #3311 it was
    /// `!replay_errors.is_empty()`, so a single transient reproject failure
    /// raised the same user-facing "recent edits may not appear yet" banner
    /// as a wholesale abort — and, conversely, an operator could not tell
    /// the two apart. Kind-2 entries stay in `replay_errors` for the logs
    /// and the bug-report bundle.
    ///
    /// (Per-draft failures land in `draft_errors`, NOT here — those are the
    /// deliberate "a single corrupt draft does not block boot" design and
    /// stay non-signalling.)
    ///
    /// When this is true an UNBOUNDED set of unmaterialized ops was skipped,
    /// so the user is editing/querying a stale state. The `op_log` remains
    /// canonical so nothing is permanently lost, but writes layered on top
    /// of an un-replayed state compound the divergence — hence this is
    /// surfaced to the user, not just logged.
    #[must_use]
    pub fn replay_failed(&self) -> bool {
        self.replay_errors
            .iter()
            .any(|e| !e.starts_with(replay::REPROJECT_DEGRADED_PREFIX))
    }

    /// Build the durable, user-visible [`RecoveryStatus`] signal from this
    /// report. Returns `degraded = true` exactly when [`Self::replay_failed`]
    /// is true — i.e. NOT for a report that carries only degraded-reprojection
    /// diagnostics (#3311).
    #[must_use]
    pub fn to_status(&self) -> RecoveryStatus {
        RecoveryStatus {
            degraded: self.replay_failed(),
            replay_errors: self.replay_errors.clone(),
        }
    }
}

/// #1255: name of the Tauri event emitted once at boot when the C-2b
/// op-log replay failed wholesale. The frontend listens for this and
/// shows a persistent "data may be incomplete" banner; it also backfills
/// the state via the `get_recovery_status` command for the late-mount
/// case (the listener registers after boot has already emitted).
pub const EVENT_RECOVERY_DEGRADED: &str = "recovery:degraded";

/// #1255: durable, user-visible boot-recovery status.
///
/// Emitted as the [`EVENT_RECOVERY_DEGRADED`] payload AND returned by the
/// `get_recovery_status` command so a frontend that mounts after boot can
/// still discover the degraded state. `degraded = true` means the boot
/// op-log replay failed and the materialized view may be incomplete/stale
/// — the app is still usable (the `op_log` is canonical) but the user
/// should be warned before layering more writes on top.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct RecoveryStatus {
    /// `true` when the boot op-log replay left ops unapplied — see
    /// [`RecoveryReport::replay_failed`].
    pub degraded: bool,
    /// The replay error messages (the same as
    /// [`RecoveryReport::replay_errors`]) for diagnostics / the bug-report
    /// bundle. #3311: this can be non-empty while `degraded` is false — a
    /// degraded end-of-replay reprojection is reported here but does not
    /// raise the user-visible signal.
    pub replay_errors: Vec<String>,
}

/// #1255: managed-state holder for the boot [`RecoveryStatus`].
///
/// Populated exactly once during `setup` (after `recover_at_boot`) and
/// read by the `get_recovery_status` command. Wrapped in a `Mutex` only
/// to satisfy `Send + Sync` for Tauri managed state; it is written once
/// and read-only thereafter.
pub struct RecoveryStatusState(pub std::sync::Mutex<RecoveryStatus>);

/// #3311 — the replay-failure SIGNAL, as distinct from the replay-error
/// DIAGNOSTICS. Lives inline (rather than in `tests.rs`) because it is a
/// pure unit test over [`RecoveryReport`] with no DB or materializer.
#[cfg(test)]
mod replay_signal_tests {
    use super::*;

    fn report_with(errors: &[&str]) -> RecoveryReport {
        RecoveryReport {
            pending_snapshots_deleted: 0,
            drafts_recovered: Vec::new(),
            drafts_already_flushed: 0,
            duration_ms: 0,
            draft_errors: Vec::new(),
            ops_replayed: 4000,
            ops_skipped_idempotent: 0,
            replay_errors: errors.iter().map(|s| (*s).to_string()).collect(),
            sync_inbox_replayed: 0,
            sync_inbox_quarantined: 0,
            sync_inbox_quarantine_pending: 0,
        }
    }

    /// A `"reproject degraded (…)"` entry rides in on the `Ok` path: every
    /// op applied and the cursor advanced past all of them, and only one
    /// sibling group's SQL positions are stale. It must NOT raise the
    /// user-visible degraded signal (which tells the user "recent edits may
    /// not appear yet … avoid making large edits").
    #[test]
    fn reproject_degraded_entry_alone_does_not_signal_replay_failure() {
        let report = report_with(&[
            "reproject degraded (01ARZ3NDEKTSV4RRFFQ69G5FAV/<root>, sql reproject): db is locked",
        ]);
        assert!(
            !report.replay_failed(),
            "a degraded end-of-replay reprojection is not a replay failure (#3311)"
        );
        assert!(
            !report.to_status().degraded,
            "to_status must not mark the session degraded for a reproject-only report"
        );
        assert_eq!(
            report.to_status().replay_errors.len(),
            1,
            "the entry is still reported for diagnostics / the bug-report bundle"
        );
    }

    /// The other arm: entries that mean ops were NOT applied must still
    /// raise the signal. `"replay aborted: …"` is synthesised by
    /// `boot::recover_at_boot`'s `Err` arm; `"enqueue: …"` is pushed by
    /// `replay_unmaterialized_ops` when a record never reached the queue.
    #[test]
    fn unapplied_op_entries_still_signal_replay_failure() {
        for entry in [
            "replay aborted: op_log spans 2 devices but the materializer apply cursor \
             is a single global scalar",
            "enqueue: channel closed",
        ] {
            let report = report_with(&[entry]);
            assert!(
                report.replay_failed(),
                "`{entry}` means ops were left unapplied and must signal failure"
            );
            assert!(
                report.to_status().degraded,
                "`{entry}` must mark the session degraded"
            );
        }
    }

    /// A wholesale abort mixed with degraded-reprojection diagnostics still
    /// signals: the filter is "any entry that is not a degraded reproject",
    /// not "the first entry".
    #[test]
    fn abort_mixed_with_degraded_entries_still_signals() {
        let report = report_with(&[
            "reproject degraded (01ARZ3NDEKTSV4RRFFQ69G5FAV/<root>, engine read): boom",
            "enqueue: channel closed",
        ]);
        assert!(
            report.replay_failed(),
            "one unapplied-op entry must not be masked by degraded-reproject entries"
        );
    }

    /// A clean report signals nothing.
    #[test]
    fn empty_replay_errors_does_not_signal() {
        let report = report_with(&[]);
        assert!(!report.replay_failed(), "a clean replay is not a failure");
        assert!(!report.to_status().degraded, "and not degraded");
    }
}
