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

mod boot;
mod cache_refresh;
mod draft_recovery;
pub mod replay;
#[cfg(test)]
mod tests;

pub use boot::recover_at_boot;
pub use cache_refresh::refresh_caches_for_recovered_drafts;
pub use draft_recovery::find_prev_edit;
pub use replay::{replay_unmaterialized_ops, ReplayReport};

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
}
