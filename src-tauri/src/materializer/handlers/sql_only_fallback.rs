//! #1057 observability hook for the materializer's SQL-only fallback path.
//!
//! The engine-routed apply handlers in [`super::loro_apply`]
//! (`apply_*_via_loro`) early-return into the `apply_*_sql_only`
//! projection fallbacks when
//! [`crate::space::resolve_block_space`] misses (the block's space
//! cannot be resolved — orphan block, no `space` ancestor, pre-spaces
//! row, fresh page-create with no SetProperty(space) yet).
//!
//! #2249/#2250: this is now the ONLY fallback trigger. The old
//! `EngineUninit` arm ("the process-global registry was never
//! initialised" — i.e. test scaffolding that skipped
//! `install_for_test`) was deleted when engine state moved from a
//! `OnceLock` global to an explicit `&LoroState` parameter threaded
//! down the apply path: an uninitialised engine is unrepresentable, so
//! tests can no longer silently exercise the SQL-only projection while
//! believing they cover the production engine path (the false-drift
//! class behind #891).
//!
//! **In production this arm should be unreachable** — space resolution
//! succeeds on every well-formed op. A fallback here is a silent bug.
//! This module makes each fallback *observable* without changing any
//! control flow: a process-global counter (incremented at every
//! fallback site) plus a debug log. A nonzero [`count`] in production
//! signals an unexpected space-resolution miss that warrants
//! investigation.
//!
//! The log uses `debug!` (not `warn!`): the SQL-only path is still the
//! expected route for the many materializer / recovery / sync_daemon
//! tests that thread synthetic ops over bare-block fixtures with no
//! space chain, so a `warn!` would spam the test suite. Production
//! observability comes from the counter plus the debug log.

use std::sync::atomic::{AtomicU64, Ordering};

/// Why an `apply_*_via_loro` handler fell back to its `apply_*_sql_only`
/// path. See the module docs.
///
/// #2249/#2250: `EngineUninit` is GONE. Engine state is threaded into
/// every `apply_*_via_loro` handler as a required `&LoroState`
/// parameter, so "registry not initialised yet" is unrepresentable —
/// the whole class of tests silently exercising the SQL-only fallback
/// instead of the production engine path (the #891 false-drift source)
/// is structurally impossible. Two genuinely-legitimate triggers remain,
/// both intrinsic to the per-space CRDT model + the #1257 "LOCAL path
/// engine-applies but boot-replay owns cursor" reconciliation contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SqlOnlyFallbackReason {
    /// `crate::space::resolve_block_space(...)` returned `None` — the
    /// block's space could not be resolved (orphan block, no `space`
    /// ancestor, pre-spaces row, or a fresh page-create with no
    /// `SetProperty(space)` yet).
    SpaceUnresolved,
    /// The op's space resolved, but the block it targets — or a related
    /// block the engine op requires (a MoveBlock's target parent) — is
    /// absent from THAT space's engine tree. Two legitimate causes, both
    /// impossible to represent as a single per-space engine mutation:
    ///
    /// * **#1257 reconciliation window** — an earlier op for the block
    ///   was projected SQL-only (e.g. created before its space resolved),
    ///   so the engine never saw it; the LOCAL path does not advance the
    ///   apply cursor, so boot-replay re-applies the full log and
    ///   reconciles the engine.
    /// * **Cross-space move** — the target parent lives in a DIFFERENT
    ///   space's tree, which the block's own single-space engine cannot
    ///   reference; SQL is authoritative for the reparent and each
    ///   space's engine converges on replay.
    EngineMissingTarget,
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
/// The production read side is [`super::super::coordinator`]'s status
/// builder, which surfaces this through `StatusInfo::sql_only_fallback_count`
/// (#1326); it is additionally exercised by the unit + integration tests.
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

    /// #2250 — compile-time-ish pin that the fallback reasons stay
    /// confined to the genuinely-legitimate triggers: the retired
    /// `EngineUninit` arm ("the process-global registry was never
    /// initialised") must NOT come back. The match is exhaustive, so
    /// reintroducing a silent "engine not initialised" projection
    /// alternative would require extending this enum (and failing this
    /// test). Both remaining variants are intrinsic to the per-space CRDT
    /// model, not test scaffolding.
    #[test]
    fn fallback_reasons_are_the_two_legitimate_triggers() {
        for reason in [
            SqlOnlyFallbackReason::SpaceUnresolved,
            SqlOnlyFallbackReason::EngineMissingTarget,
        ] {
            // Exhaustive match: adding an illegitimate variant (e.g. a
            // resurrected `EngineUninit`) fails to compile here.
            match reason {
                SqlOnlyFallbackReason::SpaceUnresolved
                | SqlOnlyFallbackReason::EngineMissingTarget => {}
            }
        }
        assert_eq!(
            format!("{:?}", SqlOnlyFallbackReason::SpaceUnresolved),
            "SpaceUnresolved"
        );
        assert_eq!(
            format!("{:?}", SqlOnlyFallbackReason::EngineMissingTarget),
            "EngineMissingTarget"
        );
    }
}
