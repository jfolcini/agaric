//! Process-global Loro engine state — the [`LoroEngineRegistry`]
//! holder that outlives individual op-applies.
//!
//! ## Why a process global
//!
//! `crate::merge::shadow_apply` (Phase 3 day-10 — collapsed to a thin
//! engine dispatcher; see the module doc) is called from
//! `merge::apply.rs`, which runs inside the merge orchestrator's
//! async function.  That function does not (and should not) take an
//! `AppHandle` parameter — the merge layer has been kept
//! tauri-agnostic for testability.  But the engine state must persist
//! across calls so successive ops mutate the same Loro doc (otherwise
//! every op would start from an empty engine).
//!
//! A `OnceLock<ShadowState>` is the simplest correctness story:
//! initialise once at bootstrap (see `crate::run` → `app.manage(...)`
//! sequence), read by reference from `shadow_apply`, never re-init.
//! Tests use [`ShadowState::install_for_test`] to drop the once-lock
//! invariant inside test-only code paths.
//!
//! ## Lifetime
//!
//! Created in `crate::run` immediately after the device_id is known
//! (the registry's `for_space` call requires a `device_id`).  Lives
//! for the rest of the process.
//!
//! ## Phase 3 day-10 — sampler field removed
//!
//! Pre-day-10 this struct also held a [`crate::loro::parity::ShadowParitySampler`]
//! — the in-memory ring buffer that fed the day-4 SQLite parity sink.
//! Day-10 deleted the sampler + sink + the `merge_parity_log` table
//! (the diffy-vs-Loro comparison surface lost meaning when Loro
//! became authoritative).  `ShadowState` is now a thin wrapper around
//! the registry.  The struct name is preserved for compile-time
//! continuity across the ~30-site reference graph; a future cleanup
//! pass may rename it to `LoroState` / `EngineState`.

use std::sync::OnceLock;

use crate::loro::registry::LoroEngineRegistry;

/// The process-global engine state.  `None` until [`init`] runs at
/// bootstrap; `Some(...)` thereafter.
static GLOBAL: OnceLock<ShadowState> = OnceLock::new();

/// Bundle of process-global Loro state.  One instance per process.
///
/// Phase 3 day-10 — collapsed to just the registry.  The struct
/// remains a struct (rather than a type alias for `LoroEngineRegistry`)
/// so adding future fields (per-space stats, op counters, etc.)
/// doesn't require a global field-access rewrite.
pub struct ShadowState {
    pub registry: LoroEngineRegistry,
}

impl ShadowState {
    /// Construct a fresh, empty state.  Engines are created lazily on
    /// first hit per space.
    pub fn new() -> Self {
        Self {
            registry: LoroEngineRegistry::new(),
        }
    }
}

impl Default for ShadowState {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialise the process-global state.  Idempotent — a second call
/// is a no-op (the first install wins).  Called unconditionally from
/// `crate::run`'s `app.setup` closure (Phase 3 day-9 retired the
/// `loro-shadow` feature gate that previously gated the call site).
///
/// Returns `true` if this call performed the initialisation, `false`
/// if a previous call already did.
pub fn init() -> bool {
    GLOBAL.set(ShadowState::new()).is_ok()
}

/// Read-only access to the global engine state.  Returns `None` if
/// [`init`] has not been called yet — callers must treat that as
/// "engine state unavailable, skip the dispatch".
pub fn get() -> Option<&'static ShadowState> {
    GLOBAL.get()
}

/// Test-only shim — install a fresh `ShadowState` if the global is
/// empty.  Each test process has its own static, so test isolation
/// across `cargo nextest` is preserved by nextest's per-test process
/// model.  Within a single test binary, multiple tests share the
/// same install; that's fine because each test uses distinct
/// `(space_id, block_id)` pairs.
#[cfg(test)]
pub fn install_for_test() -> &'static ShadowState {
    let _ = GLOBAL.set(ShadowState::new());
    GLOBAL
        .get()
        .expect("install_for_test: state must be present")
}
