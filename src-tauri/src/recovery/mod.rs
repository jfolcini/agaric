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

mod attachment_hash_backfill;
mod boot;
mod cache_refresh;
mod draft_recovery;
pub mod replay;
mod sync_inbox;
#[cfg(test)]
mod tests;

pub use attachment_hash_backfill::backfill_attachment_content_hashes;
pub use boot::recover_at_boot;
pub use cache_refresh::refresh_caches_for_recovered_drafts;
pub use draft_recovery::find_prev_edit;
pub use replay::{ReplayReport, replay_unmaterialized_ops};
pub use sync_inbox::replay_sync_inbox;

// L-103 test wrapper: re-export the once-only-guard reset for in-crate
// test code (`integration_tests.rs`) so multi-test runs aren't poisoned
// by the production guard. Test-only by `cfg(test)`; not part of the
// public crate API.
#[cfg(test)]
pub(crate) use boot::reset_recovery_guard;

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
}

impl RecoveryReport {
    /// #1255: did the C-2b op-log replay fail wholesale?
    ///
    /// `replay_errors` is non-empty only when [`replay_unmaterialized_ops`]
    /// returned an `Err` (a corrupted `op_log`, a stuck foreground queue,
    /// or the #412 multi-device hard-abort) — `boot::recover_at_boot`
    /// catches that error and synthesises a `ReplayReport` whose sole
    /// entry is `"replay aborted: …"`. When this is true an UNBOUNDED set
    /// of unmaterialized ops was skipped: the materialized view (blocks /
    /// properties / caches) is behind the canonical `op_log`, so the user
    /// is editing/querying a stale state. (Per-draft failures land in
    /// `draft_errors`, NOT here — those are the deliberate "a single
    /// corrupt draft does not block boot" design and stay non-signalling.)
    ///
    /// The `op_log` remains canonical so nothing is permanently lost, but
    /// writes layered on top of an un-replayed state compound the
    /// divergence — hence this is surfaced to the user, not just logged.
    #[must_use]
    pub fn replay_failed(&self) -> bool {
        !self.replay_errors.is_empty()
    }

    /// Build the durable, user-visible [`RecoveryStatus`] signal from this
    /// report. Returns `degraded = true` exactly when [`Self::replay_failed`]
    /// is true.
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
    /// `true` when the boot op-log replay failed wholesale.
    pub degraded: bool,
    /// The replay error messages (the same as
    /// [`RecoveryReport::replay_errors`]) for diagnostics / the bug-report
    /// bundle. Empty when `degraded` is false.
    pub replay_errors: Vec<String>,
}

/// #1255: managed-state holder for the boot [`RecoveryStatus`].
///
/// Populated exactly once during `setup` (after `recover_at_boot`) and
/// read by the `get_recovery_status` command. Wrapped in a `Mutex` only
/// to satisfy `Send + Sync` for Tauri managed state; it is written once
/// and read-only thereafter.
pub struct RecoveryStatusState(pub std::sync::Mutex<RecoveryStatus>);
