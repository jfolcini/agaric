//! #1057 observability hook for the materializer's SQL-only fallback path.
//!
//! The engine-routed apply handlers in [`super::loro_apply`]
//! (`apply_*_via_loro`) early-return into the `apply_*_sql_only`
//! projection fallbacks whenever either:
//!
//! - [`crate::loro::shared::get`] is `None` (the Loro engine is
//!   uninitialised — test scaffolding without
//!   `crate::loro::shared::install_for_test`), or
//! - [`crate::space::resolve_block_space`] misses (the block's space
//!   cannot be resolved — orphan block, no `space` ancestor, pre-FEAT-3
//!   row, fresh page-create with no SetProperty(space) yet).
//!
//! **In production both arms are unreachable** — `init` runs at boot, and
//! space resolution succeeds on every well-formed op. So a fallback there
//! is a silent bug. This module makes each fallback *observable* without
//! changing any control flow: a process-global counter (incremented at
//! every fallback site) plus a debug log. A nonzero [`count`] in
//! production signals an unexpected engine-uninit or space-resolution
//! miss that warrants investigation.
//!
//! The log uses `debug!` (not `warn!`): the SQL-only path is the DEFAULT
//! for the ~55 materializer / recovery / sync_daemon tests that don't
//! call `install_for_test`, so a `warn!` would spam the test suite.
//! Production observability comes from the counter plus the debug log.

use std::sync::atomic::{AtomicU64, Ordering};

/// Why an `apply_*_via_loro` handler fell back to its `apply_*_sql_only`
/// path. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SqlOnlyFallbackReason {
    /// `crate::loro::shared::get()` returned `None` — the Loro engine is
    /// uninitialised.
    EngineUninit,
    /// `crate::space::resolve_block_space(...)` returned `None` — the
    /// block's space could not be resolved.
    SpaceUnresolved,
}

/// Process-global count of SQL-only fallbacks taken. Monotonic; only ever
/// incremented (never reset), which keeps the test assertions robust under
/// nextest parallelism.
static SQL_ONLY_FALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);

/// Record that the `op` handler fell back to its SQL-only path for
/// `reason`. Increments the global counter and emits a debug log. Purely
/// additive — does not alter control flow.
pub(crate) fn record(op: &'static str, reason: SqlOnlyFallbackReason) {
    SQL_ONLY_FALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
    tracing::debug!(
        target: "materializer::sql_only_fallback",
        op,
        ?reason,
        "materializer apply fell back to the sql_only path"
    );
}

/// Current process-global SQL-only fallback count. Monotonic.
///
/// The read side is exercised by the unit + integration tests today; the
/// `cfg_attr(not(test), allow(dead_code))` keeps lib-only builds quiet
/// while preserving it as the production observability read API (#1057).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn count() -> u64 {
    SQL_ONLY_FALLBACK_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_count_monotonically() {
        let before = count();
        record("test_op", SqlOnlyFallbackReason::SpaceUnresolved);
        // Monotonic: the counter only ever increases, so `>` is robust
        // even when other tests record concurrently under nextest.
        assert!(
            count() > before,
            "record() must increment the global fallback count"
        );
    }

    #[test]
    fn reason_variants_format_distinctly() {
        let engine = format!("{:?}", SqlOnlyFallbackReason::EngineUninit);
        let space = format!("{:?}", SqlOnlyFallbackReason::SpaceUnresolved);
        assert_ne!(
            engine, space,
            "the two fallback reasons must Debug-format distinctly"
        );
    }
}
