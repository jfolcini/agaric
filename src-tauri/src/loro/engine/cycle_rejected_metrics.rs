//! #1541 cross-session observability for cycle-rejected reparents.
//!
//! When a `MoveBlock` op would make a node an ancestor of itself, Loro's
//! tree CRDT rejects it with `CyclicMoveError` and
//! [`super::apply`]'s `move_block_impl` keeps the node under its current
//! parent. This is *correct* CRDT behaviour (deterministic convergence;
//! SQL follows the engine snapshot) — locally-authored cycles are already
//! blocked by the command-layer guard, so a rejection here almost always
//! means two peers concurrently reparented across each other and the merge
//! produced a transient cycle that one side must drop.
//!
//! The skip is logged with a `tracing::warn!`, but a single warn line is
//! indistinguishable from log noise: an operator asking "are we silently
//! dropping cross-peer reparents?" has nothing to correlate. This module
//! adds a process-global aggregate, mirroring
//! [`super::super::super::sync_protocol::snapshot_fallback_metrics`]: a
//! monotonic count plus the latest occurrence's block id, so a *spike* in
//! rejections (expected on the sync path, not on local edits) is observable
//! rather than buried.
//!
//! **This is observability only** — recording does NOT alter the cycle-skip
//! control flow; the reparent is still skipped identically at the call site.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-global count of cycle-forming reparents rejected by the tree
/// CRDT and skipped. Monotonic; only ever incremented (never reset), which
/// keeps test assertions robust under nextest parallelism.
static CYCLE_REJECTED_COUNT: AtomicU64 = AtomicU64::new(0);

/// Latest cycle-rejected reparent, captured at [`record`]. `None` until the
/// first rejection in this process.
static CYCLE_REJECTED_LAST: Mutex<Option<CycleRejectedLast>> = Mutex::new(None);

/// Snapshot of the most recent cycle-rejected reparent.
#[derive(Clone, Debug)]
pub struct CycleRejectedLast {
    /// 1-based ordinal of this occurrence within the process lifetime.
    pub occurrence: u64,
    /// The block id whose reparent was rejected (it kept its old parent).
    pub block_id: String,
}

/// Record that a cycle-forming reparent for `block_id` was rejected by the
/// tree CRDT and skipped. Increments the process-global counter and
/// captures the occurrence as the new "last". Purely additive — it does NOT
/// alter the cycle-skip control flow.
pub(super) fn record(block_id: &str) {
    // `fetch_add` returns the PREVIOUS value, so this occurrence's ordinal
    // is `prev + 1`, consistent with subsequent `count()` reads.
    let occurrence = CYCLE_REJECTED_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut last) = CYCLE_REJECTED_LAST.lock() {
        *last = Some(CycleRejectedLast {
            occurrence,
            block_id: block_id.to_owned(),
        });
    }
}

/// Current process-global cycle-rejected reparent count. Monotonic.
pub fn count() -> u64 {
    CYCLE_REJECTED_COUNT.load(Ordering::Relaxed)
}

/// The most recent cycle-rejected reparent, or `None` if none has occurred
/// in this process.
pub fn last() -> Option<CycleRejectedLast> {
    CYCLE_REJECTED_LAST.lock().ok().and_then(|g| g.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_count_and_captures_last() {
        // Use relative before/after deltas so the assertion stays robust
        // when other tests record concurrently under nextest.
        let before = count();
        record("block-xyz");
        let after = count();
        assert!(
            after > before,
            "record() must increment the global cycle-rejected count \
             (before={before}, after={after})"
        );
        let last = last().expect("a cycle-rejected occurrence must now be recorded");
        assert!(
            last.occurrence >= after,
            "last.occurrence ({}) must be at least the post-record count ({after})",
            last.occurrence,
        );
        assert!(
            !last.block_id.is_empty(),
            "the captured block_id must be non-empty"
        );
    }
}
