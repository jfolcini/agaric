//! Per-space [`LoroEngine`] registry — Phase-1 day-2 deliverable.
//!
//! Phase 1 day-2 lights up the `merge::engine_apply` hook into a real
//! dual-write path.  The hook needs a `LoroEngine` per active space
//! that outlives individual op-applies (otherwise every applied op
//! would start from an empty doc — defeating the purpose).
//!
//! ## Why per-space
//!
//! SPIKE-REPORT.md §4.1 settled on a per-space-doc design: each space
//! owns one [`LoroEngine`] / `LoroDoc`, and ops only mutate the doc
//! whose space they belong to.  Cross-space ops are impossible by
//! construction (every op carries a `block_id` whose owning page
//! resolves to exactly one space — see [`crate::space::resolve_block_space`]).
//!
//! ## Lifetime
//!
//! The registry is built once at bootstrap and held in process-global
//! state ([`crate::loro::shared`]).  Engines are instantiated lazily
//! on first hit per space — the user may have N spaces but only
//! actively touch one or two during a session, so we don't pre-spin
//! engines for unused spaces.
//!
//! ## Concurrency
//!
//! A single top-level `Mutex<HashMap<SpaceId, LoroEngine>>` is the
//! simplest correctness story.  The shadow-apply rate is bounded by
//! human typing / sync cadence — well below the rate at which the
//! coarse-grained lock would matter.  Phase-2 may switch to per-space
//! mutexes if the parity-sampling rate climbs (e.g. during a 100K-op
//! replay) but day-2 keeps it simple.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::AppError;
use crate::loro::engine::LoroEngine;
use crate::space::SpaceId;

/// Lazily-instantiated map of `SpaceId -> LoroEngine`.
///
/// Lookup-or-insert is `for_space`; production callers pass the
/// device's UUID-v4 `device_id` so the engine's Loro `peer_id` is
/// stable across the process lifetime.
pub struct LoroEngineRegistry {
    inner: Mutex<HashMap<SpaceId, LoroEngine>>,
}

impl LoroEngineRegistry {
    /// Construct an empty registry.  Engines are created lazily on
    /// first [`for_space`](Self::for_space) call.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the registry's mutex and ensure an engine for `space_id`
    /// exists.  Returns a `MutexGuard` so the caller can mutate the
    /// engine without dropping the lock between lookup and use.
    ///
    /// The caller-supplied `device_id` becomes the engine's stable
    /// peer id via [`LoroEngine::with_peer_id`].  If two callers race
    /// on the same space, the first wins; subsequent callers see the
    /// engine the first installed (the `device_id` they passed is
    /// ignored, which is fine because the production
    /// `device_id` is process-stable).
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` if [`LoroEngine::with_peer_id`]
    /// rejects the `device_id` — see that function's docs for the
    /// (extremely unlikely) Loro-internal failure mode.
    pub fn for_space<'a>(
        &'a self,
        space_id: &SpaceId,
        device_id: &str,
    ) -> Result<EngineGuard<'a>, AppError> {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        if !guard.contains_key(space_id) {
            let engine = LoroEngine::with_peer_id(device_id)?;
            guard.insert(space_id.clone(), engine);
        }
        Ok(EngineGuard {
            guard,
            key: space_id.clone(),
        })
    }

    /// All [`SpaceId`]s currently registered, in arbitrary order.
    ///
    /// PEND-09 Phase 3 day-5 — used by the sync orchestrator to
    /// enumerate which spaces to push when entering `StreamingOps`.
    /// The returned `Vec` is a snapshot (cloned under the lock); the
    /// caller may iterate without holding the registry mutex.
    /// Concurrent `for_space` calls that lazy-create new engines after
    /// this snapshot are simply not visible to the current sync round
    /// — they will be picked up by the next `HeadExchange`.
    pub fn space_ids(&self) -> Vec<SpaceId> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        guard.keys().cloned().collect()
    }

    /// Number of engines currently held.  Used by tests to assert
    /// per-space isolation.
    pub fn len(&self) -> usize {
        match self.inner.lock() {
            Ok(g) => g.len(),
            Err(poison) => poison.into_inner().len(),
        }
    }

    /// Returns true iff the registry holds zero engines.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Install a pre-built [`LoroEngine`] under `space_id`, replacing
    /// any existing entry.  Used by the boot rehydration pass
    /// ([`crate::loro::snapshot::rehydrate_registry`]) to seed the
    /// registry with engines whose `LoroDoc` has already been imported
    /// from a persisted snapshot, so a subsequent
    /// [`for_space`](Self::for_space) call observes a doc that is not
    /// empty.
    ///
    /// PEND-09 Phase 2 day-6.  Decision rationale (option (c) from the
    /// day-6 spec): keeping `for_space` synchronous and pre-populating
    /// the registry on app boot avoids both the `for_space`-becomes-
    /// async ripple (option (a)) and the `block_in_place` /
    /// `block_on` hack (option (b)).
    pub fn install_engine(&self, space_id: SpaceId, engine: LoroEngine) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        guard.insert(space_id, engine);
    }

    /// Snapshot every registered engine via [`LoroEngine::export_snapshot`]
    /// and return the resulting `(space_id, Result<bytes, AppError>)`
    /// pairs.  Per-engine errors are returned in the inner `Result` so
    /// the caller can decide whether to log + continue (the periodic
    /// scheduler) or abort (a debug "snapshot now" command).
    ///
    /// The export runs while holding the top-level mutex; see the
    /// per-call discussion in
    /// [`crate::loro::snapshot::save_all_engines`] for why that's the
    /// right trade-off at the 5-minute scheduler cadence.
    pub fn snapshot_all_engines(&self) -> Vec<(SpaceId, Result<Vec<u8>, AppError>)> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        guard
            .iter()
            .map(|(space_id, engine)| (space_id.clone(), engine.export_snapshot()))
            .collect()
    }
}

impl Default for LoroEngineRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard returned by [`LoroEngineRegistry::for_space`].  Holds
/// the registry mutex until dropped; deref-mut yields the per-space
/// engine.  This avoids the "lookup, drop lock, re-acquire" pattern
/// that would let another thread mutate the engine between read and
/// write.
pub struct EngineGuard<'a> {
    guard: MutexGuard<'a, HashMap<SpaceId, LoroEngine>>,
    key: SpaceId,
}

impl EngineGuard<'_> {
    /// Mutable access to the engine.  Always succeeds — the constructor
    /// guaranteed the key exists.
    pub fn engine_mut(&mut self) -> &mut LoroEngine {
        self.guard
            .get_mut(&self.key)
            .expect("invariant: for_space inserts before returning the guard")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two valid ULIDs for use as space ids.
    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

    #[test]
    fn empty_registry_starts_with_zero_engines() {
        let r = LoroEngineRegistry::new();
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn for_space_lazily_creates_engine() {
        let r = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        let _guard = r.for_space(&space, "device-1").expect("create engine");
        drop(_guard);
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn for_space_returns_same_engine_on_subsequent_calls() {
        let r = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // First call creates the engine and writes a block.
        {
            let mut g = r.for_space(&space, "device-1").expect("first");
            g.engine_mut()
                .apply_create_block("BLOCK1", "content", "hello", None, 0)
                .expect("create");
        }

        // Second call must observe the same engine — block is still there.
        {
            let mut g = r.for_space(&space, "device-1").expect("second");
            let snap = g
                .engine_mut()
                .read_block("BLOCK1")
                .expect("read")
                .expect("present");
            assert_eq!(snap.content, "hello");
        }

        assert_eq!(r.len(), 1);
    }

    #[test]
    fn install_engine_seeds_registry_so_for_space_returns_pre_built_engine() {
        // PEND-09 Phase 2 day-6 — the boot rehydration pass uses
        // `install_engine` to inject engines whose docs were imported
        // from a persisted snapshot.  A subsequent `for_space` call
        // must observe the pre-built engine (NOT lazy-instantiate a
        // fresh empty one).
        let r = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        let mut prebuilt = LoroEngine::with_peer_id("device-1").expect("prebuilt");
        prebuilt
            .apply_create_block("BLOCK1", "content", "from-snapshot", None, 0)
            .expect("create");
        r.install_engine(space.clone(), prebuilt);
        assert_eq!(r.len(), 1, "install_engine must register the engine");

        // for_space returns the pre-built engine — block is visible.
        let mut g = r.for_space(&space, "device-1").expect("for_space");
        let snap = g
            .engine_mut()
            .read_block("BLOCK1")
            .expect("read")
            .expect("present");
        assert_eq!(
            snap.content, "from-snapshot",
            "for_space must return the installed engine, not a fresh one"
        );
    }

    #[test]
    fn install_engine_replaces_an_existing_engine() {
        // Idempotency contract: a second `install_engine` for the same
        // space replaces the first.  This is what the boot pass relies
        // on if it ever re-runs (e.g. test harness re-init).
        let r = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        let mut first = LoroEngine::with_peer_id("device-1").expect("first");
        first
            .apply_create_block("BLOCK1", "content", "first", None, 0)
            .expect("create");
        r.install_engine(space.clone(), first);

        let mut second = LoroEngine::with_peer_id("device-1").expect("second");
        second
            .apply_create_block("BLOCK2", "content", "second", None, 0)
            .expect("create");
        r.install_engine(space.clone(), second);

        assert_eq!(r.len(), 1, "still one entry after replace");

        // Only the second engine's blocks are visible.
        let mut g = r.for_space(&space, "device-1").expect("for_space");
        assert!(g.engine_mut().read_block("BLOCK1").unwrap().is_none());
        assert!(g.engine_mut().read_block("BLOCK2").unwrap().is_some());
    }

    #[test]
    fn snapshot_all_engines_returns_one_pair_per_space() {
        let r = LoroEngineRegistry::new();
        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);
        {
            let mut g = r.for_space(&a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        {
            let mut g = r.for_space(&b, "device-1").expect("b");
            g.engine_mut()
                .apply_create_block("BLOCK_B", "content", "in B", None, 0)
                .expect("create");
        }

        let pairs = r.snapshot_all_engines();
        assert_eq!(pairs.len(), 2, "two spaces, two snapshot pairs");
        for (_space_id, result) in pairs {
            let bytes = result.expect("export ok");
            assert!(!bytes.is_empty(), "exported snapshot must be non-empty");
        }
    }

    #[test]
    fn distinct_spaces_get_distinct_engines() {
        let r = LoroEngineRegistry::new();
        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);

        {
            let mut g = r.for_space(&a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        {
            let mut g = r.for_space(&b, "device-1").expect("b");
            g.engine_mut()
                .apply_create_block("BLOCK_B", "content", "in B", None, 0)
                .expect("create");
        }

        // Engine A must NOT have BLOCK_B and vice versa.
        {
            let mut g = r.for_space(&a, "device-1").expect("a again");
            assert!(g.engine_mut().read_block("BLOCK_B").unwrap().is_none());
            assert!(g.engine_mut().read_block("BLOCK_A").unwrap().is_some());
        }
        {
            let mut g = r.for_space(&b, "device-1").expect("b again");
            assert!(g.engine_mut().read_block("BLOCK_A").unwrap().is_none());
            assert!(g.engine_mut().read_block("BLOCK_B").unwrap().is_some());
        }

        assert_eq!(r.len(), 2);
    }
}
