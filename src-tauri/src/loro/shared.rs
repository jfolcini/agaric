//! Process-global shadow-mode state — the [`LoroEngineRegistry`] +
//! [`ShadowParitySampler`] pair that outlives individual op-applies.
//!
//! ## Why a process global
//!
//! `crate::merge::shadow_apply` is called from `merge::apply.rs`, which
//! runs inside the merge orchestrator's async function.  That function
//! does not (and should not) take an `AppHandle` parameter — the
//! merge layer has been kept tauri-agnostic for testability.  But the
//! shadow state must persist across calls so successive ops mutate the
//! same Loro doc (otherwise every op would start from an empty engine
//! and parity would be meaningless).
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
//! for the rest of the process.  Phase 3 day-9 retired the
//! `loro-shadow` feature gate; this module compiles unconditionally.

use std::sync::OnceLock;

use crate::loro::parity::ShadowParitySampler;
use crate::loro::registry::LoroEngineRegistry;

/// The process-global shadow-mode state.  `None` until
/// [`init`] runs at bootstrap; `Some(...)` thereafter.
static GLOBAL: OnceLock<ShadowState> = OnceLock::new();

/// Bundle of shadow-mode shared state.  One instance per process.
pub struct ShadowState {
    pub registry: LoroEngineRegistry,
    pub sampler: ShadowParitySampler,
}

impl ShadowState {
    /// Construct a fresh, empty shadow state.  Engines are created
    /// lazily on first hit per space.
    pub fn new() -> Self {
        Self {
            registry: LoroEngineRegistry::new(),
            sampler: ShadowParitySampler::new(),
        }
    }
}

impl Default for ShadowState {
    fn default() -> Self {
        Self::new()
    }
}

/// Initialise the process-global shadow state.  Idempotent — a second
/// call is a no-op (the first install wins).  Called unconditionally
/// from `crate::run`'s `app.setup` closure (Phase 3 day-9 retired the
/// `loro-shadow` feature gate that previously gated the call site).
///
/// Returns `true` if this call performed the initialisation, `false`
/// if a previous call already did.
pub fn init() -> bool {
    GLOBAL.set(ShadowState::new()).is_ok()
}

/// Read-only access to the global shadow state.  Returns `None` if
/// [`init`] has not been called yet — callers must treat that as
/// "shadow mode unavailable, skip the dual-write".
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
