//! #2031 observability hook for the post-commit descendant fan-out.
//!
//! After the apply tx commits,
//! [`super::apply::dispatch_restore_descendants`] and
//! [`super::apply::dispatch_delete_descendants`] fan the descendant
//! cohort out to the per-space Loro engine. Each helper **absorbs every
//! failure with `warn`/`trace` + early-return** rather than persisting an
//! exhausted-retry row (like `fg_apply_dropped` does) — a malformed root
//! payload, a `resolve_block_space` error, or a missing space leaves SQL
//! deleted/restored while the engine stays divergent until the next full
//! boot replay reconciles it.
//!
//! That skip was previously invisible (only a log line). This module
//! makes it *observable* without changing any control flow: a
//! process-global counter (incremented at every divergence-leaving skip
//! site) that a nonzero value of signals the engine may be diverged from
//! SQL on this run. It mirrors the sibling
//! [`super::sql_only_fallback`] counter shape — process-global static,
//! [`count`] accessor, surfaced through `StatusInfo` by the
//! coordinator's status builder.
//!
//! Unlike `fg_apply_dropped` (a per-`QueueMetrics`-instance atomic), the
//! fan-out helpers are free functions with no `QueueMetrics` handle, so
//! the process-global static (the `sql_only_fallback` pattern) is the
//! reachable mirror.

use std::sync::atomic::{AtomicU64, Ordering};

/// Process-global count of descendant fan-out skips that left the engine
/// potentially divergent from SQL. Monotonic; only ever incremented.
static DESCENDANT_FANOUT_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Record that a descendant fan-out path skipped/aborted, leaving the
/// engine potentially divergent. Increments the global counter. Purely
/// additive — does not alter control flow; the caller still emits its own
/// `warn!`/`trace!` line for triage.
pub(crate) fn record() {
    DESCENDANT_FANOUT_DROPPED.fetch_add(1, Ordering::Relaxed);
}

/// Current process-global descendant-fanout-dropped count. Monotonic.
///
/// The production read side is [`super::super::coordinator`]'s status
/// builder, which surfaces this through
/// `StatusInfo::descendant_fanout_dropped` (#2031); it is additionally
/// exercised by the unit tests.
pub(crate) fn count() -> u64 {
    DESCENDANT_FANOUT_DROPPED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_count_monotonically() {
        let before = count();
        record();
        // Monotonic: the counter only ever increases, so `>` is robust
        // even when other tests record concurrently under nextest.
        assert!(
            count() > before,
            "record() must increment the global descendant-fanout-dropped count"
        );
    }
}
