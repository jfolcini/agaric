//! Owned Loro engine state — the [`LoroEngineRegistry`] holder that
//! outlives individual op-applies.
//!
//! ## Ownership (#2249 — no process global)
//!
//! `LoroState` used to live in a private `static GLOBAL:
//! OnceLock<LoroState>` read via `shared::get()`. That global forced
//! engine-path integration tests onto `cargo nextest` (one process per
//! test — the shared registry raced under plain `cargo test`, #1079),
//! leaked an `EngineUninit` fallback arm into every `apply_*_via_loro`
//! handler, and made boot ordering a hand-sequenced comment
//! (`shared::init()` before recovery replay).
//!
//! The state is now an ordinary value threaded explicitly:
//!
//! * **Production** — `crate::run` constructs ONE `Arc<LoroState>` at
//!   the top of setup, BEFORE the materializer or recovery exist, so
//!   boot ordering holds by construction (constructor argument, not
//!   sequencing). The same `Arc` is
//!   - held by the [`Materializer`](crate::materializer::Materializer)
//!     (its consumers thread it into `apply_op` / `apply_op_tx` →
//!     `apply_*_via_loro`, and LOCAL command paths reach it through the
//!     `&Materializer` they already carry),
//!   - registered as Tauri managed state (`app.manage(Arc<LoroState>)`)
//!     for the `RunEvent::Exit` snapshot save,
//!   - captured by the maintenance jobs and the periodic snapshot task.
//! * **Tests** — construct a fresh `LoroState` (or let
//!   `Materializer::new` build one) per test. Isolation is per-instance
//!   now, so engine-path tests run safely under plain `cargo test` in
//!   one process across threads; the nextest-only constraint is gone.
//!
//! `crate::merge::engine_apply` stays Tauri-agnostic: it takes
//! `&LoroState` as a parameter and never touches an `AppHandle`.

use crate::loro::registry::LoroEngineRegistry;

/// Bundle of engine state. Production holds exactly one instance for
/// the process lifetime (inside an `Arc`); tests construct one per
/// test for isolation.
///
/// Wraps the registry in a struct so future fields (per-space stats,
/// op counters, etc.) don't require a field-access rewrite at every
/// call site.
pub struct LoroState {
    pub registry: LoroEngineRegistry,
}

impl LoroState {
    /// Construct fresh, empty state. Engines are created lazily on
    /// first hit per space.
    pub fn new() -> Self {
        Self {
            registry: LoroEngineRegistry::new(),
        }
    }
}

impl Default for LoroState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::SpaceId;
    use crate::ulid::BlockId;

    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    /// #2249 — two `LoroState` instances in ONE process are fully
    /// independent: writes through one registry are invisible to the
    /// other. This (together with its sibling below, running
    /// concurrently in the same test binary under plain `cargo test`)
    /// pins that per-test isolation no longer depends on
    /// process-per-test scheduling (the old nextest-only constraint,
    /// #1079).
    #[test]
    fn separate_states_are_isolated_in_one_process_a() {
        let state_a = LoroState::new();
        let state_b = LoroState::new();
        let space = SpaceId::from_trusted(SPACE);
        let block = BlockId::from_trusted("01HZ00000000000000000ISOA1");

        {
            let mut g = state_a
                .registry
                .for_space(&space, "device-a")
                .expect("for_space a");
            g.engine_mut()
                .apply_create_block(block.as_str(), "content", "only in A", None, 0)
                .expect("create in A");
        }
        let mut g = state_b
            .registry
            .for_space(&space, "device-b")
            .expect("for_space b");
        assert!(
            g.engine_mut()
                .read_block(block.as_str())
                .expect("read")
                .is_none(),
            "state B must not observe state A's writes"
        );
    }

    /// #2249 — sibling of the test above; both mutate the SAME space id
    /// through DIFFERENT `LoroState` instances and run concurrently in
    /// one process under plain `cargo test`. Under the retired
    /// process-global registry this exact shape raced (#1079).
    #[test]
    fn separate_states_are_isolated_in_one_process_b() {
        let state = LoroState::new();
        let space = SpaceId::from_trusted(SPACE);
        let block = BlockId::from_trusted("01HZ00000000000000000ISOB1");

        let mut g = state
            .registry
            .for_space(&space, "device-b")
            .expect("for_space");
        g.engine_mut()
            .apply_create_block(block.as_str(), "content", "fresh", None, 0)
            .expect("create");
        let snap = g
            .engine_mut()
            .read_block(block.as_str())
            .expect("read")
            .expect("present");
        assert_eq!(snap.content, "fresh");
        drop(g);
        assert_eq!(
            state.registry.len(),
            1,
            "a fresh per-test registry holds exactly the engines this test created"
        );
    }
}
