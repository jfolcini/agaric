//! #1571 durable observability for swallowed engine-apply divergence.
//!
//! [`super::engine_apply`] mirrors every applied op onto the per-space
//! `LoroEngine`. It is the shared dispatcher for the post-commit
//! Restore/Delete descendant-cohort fan-out
//! (`materializer::handlers::apply::dispatch_restore_descendants` /
//! `dispatch_delete_descendants`), which synthesises a per-descendant
//! payload and applies it one block id at a time AFTER the SQL apply
//! transaction has already committed.
//!
//! Because the SQL tx is already committed by the time the fan-out runs,
//! an `engine_apply` failure there cannot be rolled back — the op log /
//! SQL `blocks` table (the source of truth) and the per-space LoroDoc
//! silently diverge. The original handling only emitted a free-text
//! `tracing::warn!`, leaving no durable, machine-detectable signal: a
//! health check could not observe the drift without scraping log text.
//!
//! This module makes each swallowed failure observable WITHOUT changing
//! any control flow (the dispatch stays non-fatal, commit ordering is
//! untouched). It mirrors the
//! [`super::super::materializer::handlers::sql_only_fallback`] and
//! [`crate::sync_protocol::snapshot_fallback_metrics`] precedents:
//!
//! - a process-global monotonic [`AtomicU64`] counter, incremented on
//!   every swallowed failure, readable via [`count`]; and
//! - a structured `tracing::warn!` carrying a STABLE dedicated marker
//!   (`target: "merge::engine_divergence"` plus the
//!   `engine_apply_diverged` message) so log-based health checks have a
//!   stable field to match on.
//!
//! A nonzero [`count`] in production signals that the engine and the SQL
//! source of truth have drifted and a reconcile/replay is warranted.

use std::sync::atomic::{AtomicU64, Ordering};

/// Process-global count of swallowed `engine_apply` divergences (the SQL
/// tx committed but the per-space LoroDoc mirror failed and was skipped).
/// Monotonic; only ever incremented (never reset), which keeps the test
/// assertions robust under nextest parallelism.
static ENGINE_DIVERGENCE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Stable `tracing` target for the dedicated divergence event. Log-based
/// health checks match on this; it is part of the module's contract and
/// must stay stable.
pub(crate) const DIVERGENCE_TARGET: &str = "merge::engine_divergence";

/// Record that an `engine_apply` mirror failed AFTER the SQL apply
/// transaction committed and was swallowed (skipped, not propagated).
/// Increments the global counter and emits a dedicated, structured
/// `warn!` with a stable marker. Purely additive — does NOT alter the
/// engine-apply control flow or commit ordering.
///
/// `op_id` is the caller-supplied op identity; for the cohort fan-out it
/// carries a `#cohort/<block_id>` suffix so triage can tell descendant
/// fan-out drift apart from a primary op's drift. `op_type` is the op
/// type string. `detail` is the swallow reason (registry lookup failure
/// or engine apply error) rendered as text.
pub(crate) fn record(op_id: &str, op_type: &str, detail: &str) {
    // `fetch_add` returns the PREVIOUS value; the occurrence ordinal is
    // therefore `prev + 1`, matching the value a subsequent `count()`
    // read observes.
    let occurrence = ENGINE_DIVERGENCE_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    tracing::warn!(
        target: DIVERGENCE_TARGET,
        counter = occurrence,
        op_id,
        op_type,
        detail,
        "engine_apply_diverged"
    );
}

/// Current process-global engine-divergence count. Monotonic.
///
/// This is the durable signal a health check (or test) reads to detect
/// that the engine mirror drifted from the SQL source of truth. Exposed
/// for a future health-check / status surface (mirroring
/// `sql_only_fallback::count`); currently only the unit tests read it, so
/// it is allowed to be otherwise-unused for now.
#[allow(dead_code)]
pub(crate) fn count() -> u64 {
    ENGINE_DIVERGENCE_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_count_monotonically() {
        let before = count();
        record("dev/7#cohort/blk-1", "DeleteBlock", "engine apply error");
        // Monotonic: the counter only ever increases, so `>` is robust
        // even when other tests record concurrently under nextest.
        assert!(
            count() > before,
            "record() must increment the global divergence count \
             (before={before})"
        );
    }
}
