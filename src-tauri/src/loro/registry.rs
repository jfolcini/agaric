//! Per-space [`LoroEngine`] registry.
//!
//! The `merge::engine_apply` hook needs a `LoroEngine` per active
//! space that outlives individual op-applies (otherwise every applied
//! op would start from an empty doc — defeating the purpose).
//!
//! ## Why per-space
//!
//! Each space owns one [`LoroEngine`] / `LoroDoc`, and ops only
//! mutate the doc whose space they belong to. Cross-space ops are
//! impossible by construction (every op carries a `block_id` whose
//! owning page resolves to exactly one space — see
//! [`crate::space::resolve_block_space`]).
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
//! simplest correctness story. The apply rate is bounded by human
//! typing / sync cadence — well below the rate at which the
//! coarse-grained lock would matter. A future iteration could switch
//! to per-space mutexes if benchmarks show contention.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use loro::{ExportMode, LoroDoc};

use crate::error::AppError;
use crate::loro::engine::LoroEngine;
use crate::space::SpaceId;

/// Lazily-instantiated map of `SpaceId -> LoroEngine`.
///
/// Lookup-or-insert is `for_space`; production callers pass the
/// device's UUID-v4 `device_id` so the engine's Loro `peer_id` is
/// stable across the process lifetime.
///
/// Issue #157 sub-item I — `dirty_count` is a conservative
/// modification proxy used by the `loro_snapshot_if_dirty`
/// maintenance job to gate periodic snapshot persistence. Every call
/// to [`for_space`](Self::for_space) bumps the counter (so any code
/// path that *might* mutate an engine is counted, including
/// read-only `for_space` calls — over-counts are harmless because the
/// extra snapshot is idempotent). [`save_all_engines`] resets the
/// counter to 0 after a successful walk so subsequent ticks observe
/// "clean" until the next mutation.
pub struct LoroEngineRegistry {
    inner: Mutex<HashMap<SpaceId, LoroEngine>>,
    /// Issue #157 sub-item I — see struct-level docstring.
    dirty_count: AtomicUsize,
    /// #607 review: monotone counter bumped by [`clear`](Self::clear).
    ///
    /// `save_all_engines` collects O(1) doc handles, drops the registry
    /// lock, then persists each export with its own awaited INSERT. A
    /// snapshot-RESET (`apply_snapshot` + `reload_registry_from_db`) that
    /// lands inside that collect→write span would otherwise let the saver
    /// re-persist PRE-reset engine state into the freshly wiped
    /// `loro_doc_state` (the #779 resurrection, via the periodic tick or
    /// the `RunEvent::Exit` save). The saver captures this generation
    /// before collecting handles and re-checks it before every write —
    /// a mismatch means the handles predate a reset and must not be
    /// persisted.
    generation: AtomicU64,
}

impl LoroEngineRegistry {
    /// Construct an empty registry.  Engines are created lazily on
    /// first [`for_space`](Self::for_space) call.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            dirty_count: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
        }
    }

    /// #607 review: current clear-generation. See the field docs —
    /// `save_all_engines` uses this to detect a registry [`clear`](Self::clear)
    /// (snapshot RESET) racing its collect→write span.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Issue #157 sub-item I — current dirty-engines proxy count.
    /// Returns the number of [`for_space`](Self::for_space) calls
    /// since the last [`clear_dirty`](Self::clear_dirty). The
    /// `loro_snapshot_if_dirty` maintenance job uses
    /// `dirty_count() > 0` as its predicate so it skips the
    /// snapshot pass on a quiescent session.
    pub fn dirty_count(&self) -> usize {
        self.dirty_count.load(Ordering::Acquire)
    }

    /// Issue #157 sub-item I — reset the dirty proxy counter to 0.
    /// Called from [`crate::loro::snapshot::save_all_engines`] after
    /// a successful snapshot pass so the next tick observes "clean"
    /// until the next [`for_space`](Self::for_space) call.
    pub fn clear_dirty(&self) {
        self.dirty_count.store(0, Ordering::Release);
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
        // Issue #157 sub-item I — `for_space` is the chokepoint
        // every mutation path goes through, so a per-call increment
        // is the simplest "engines have changed since last save"
        // proxy. Over-counts (a read-only `for_space` call also
        // bumps the counter); the extra snapshot the daemon may then
        // fire is idempotent so the false positive is harmless.
        self.dirty_count.fetch_add(1, Ordering::Relaxed);
        Ok(EngineGuard {
            guard,
            key: space_id.clone(),
        })
    }

    /// All [`SpaceId`]s currently registered, in arbitrary order.
    ///
    /// Used by the sync orchestrator to enumerate which spaces to
    /// push when entering `StreamingOps`. The returned `Vec` is a
    /// snapshot (cloned under the lock); the caller may iterate
    /// without holding the registry mutex. Concurrent `for_space`
    /// calls that lazy-create new engines after this snapshot are
    /// simply not visible to the current sync round — they will be
    /// picked up by the next `HeadExchange`.
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
    /// any existing entry. Used by the boot rehydration pass
    /// ([`crate::loro::snapshot::rehydrate_registry`]) to seed the
    /// registry with engines whose `LoroDoc` has already been imported
    /// from a persisted snapshot, so a subsequent
    /// [`for_space`](Self::for_space) call observes a doc that is not
    /// empty. Keeping `for_space` synchronous and pre-populating the
    /// registry on app boot avoids both the
    /// `for_space`-becomes-async ripple and the `block_in_place` /
    /// `block_on` hack.
    pub fn install_engine(&self, space_id: SpaceId, engine: LoroEngine) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        guard.insert(space_id, engine);
    }

    /// Drop every registered engine (#607).
    ///
    /// Used by [`crate::loro::snapshot::reload_registry_from_db`] after a
    /// snapshot RESET (`apply_snapshot`) wiped `loro_doc_state`: the live
    /// engines still hold the pre-reset CRDT lineage and must be dropped so
    /// neither the periodic `save_all_engines` tick nor the `RunEvent::Exit`
    /// save can persist stale state over the post-reset SQL. Subsequent
    /// [`for_space`](Self::for_space) calls lazy-create fresh empty engines,
    /// exactly like a first boot.
    ///
    /// Holding the single registry mutex makes the swap atomic with respect
    /// to concurrent appliers: an `engine_apply` racing this call either
    /// lands on the pre-clear engine (whose state is dropped — same outcome
    /// as the op arriving pre-reset) or lazy-creates a fresh post-reset one.
    pub fn clear(&self) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        guard.clear();
        // Bump the generation WHILE holding the lock so any saver that
        // collected handles before this clear observes the new value on
        // its next check (see the `generation` field docs).
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Snapshot every registered engine via [`LoroEngine::export_snapshot`]
    /// and return the resulting `(space_id, Result<bytes, AppError>)`
    /// pairs.  Per-engine errors are returned in the inner `Result` so
    /// the caller can decide whether to log + continue (the periodic
    /// scheduler) or abort (a debug "snapshot now" command).
    ///
    /// ## Issue #153 — export runs OUTSIDE the registry mutex
    ///
    /// The top-level mutex serialises *every* engine apply (the
    /// materializer's hot path goes through [`for_space`](Self::for_space)).
    /// Previously this method ran [`LoroEngine::export_snapshot`] for each
    /// space while holding that lock, so an O(spaces x export) serialization
    /// pass blocked all applies for its duration. To keep the lock window
    /// O(spaces) instead, we:
    ///
    /// 1. collect a [`LoroDoc`] *handle* per space under the lock —
    ///    [`LoroEngine::doc_handle`] is an O(1) reference clone, NOT a
    ///    deep copy, so this neither serialises nor doubles memory;
    /// 2. drop the guard;
    /// 3. run the (comparatively slow) snapshot export on each handle with
    ///    the lock released, so concurrent applies are not blocked.
    ///
    /// Because a `LoroDoc` handle shares the underlying document, an apply
    /// that lands on the same space *after* the lock is dropped but
    /// *before* its export runs is simply included in that snapshot — a
    /// strictly fresher (still consistent) point-in-time export. The
    /// snapshot watermark in [`crate::loro::snapshot::save_all_engines`] is
    /// already a conservative lower bound that tolerates this.
    pub fn snapshot_all_engines(&self) -> Vec<(SpaceId, Result<Vec<u8>, AppError>)> {
        // Phase 1: collect O(1) doc handles under the lock, then release it.
        let handles: Vec<(SpaceId, LoroDoc)> = {
            let guard = match self.inner.lock() {
                Ok(g) => g,
                Err(poison) => poison.into_inner(),
            };
            guard
                .iter()
                .map(|(space_id, engine)| (space_id.clone(), engine.doc_handle()))
                .collect()
        };

        // Phase 2: export each handle with the registry lock released.
        handles
            .into_iter()
            .map(|(space_id, doc)| {
                let bytes = doc
                    .export(ExportMode::Snapshot)
                    .map_err(|e| AppError::Validation(format!("loro: export snapshot: {e}")));
                (space_id, bytes)
            })
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

    /// Issue #157 sub-item I — `for_space` bumps the dirty proxy
    /// counter; `clear_dirty` resets it to 0. Pins the counter
    /// transitions the `loro_snapshot_if_dirty` predicate relies on.
    #[test]
    fn dirty_count_bumps_on_for_space_and_clears_on_clear_dirty_157_i() {
        let r = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        assert_eq!(
            r.dirty_count(),
            0,
            "fresh registry must report dirty_count == 0"
        );

        let _ = r
            .for_space(&space, "device-AAAA")
            .expect("for_space must succeed");
        assert_eq!(
            r.dirty_count(),
            1,
            "for_space must bump dirty_count from 0 to 1"
        );

        let _ = r
            .for_space(&space, "device-AAAA")
            .expect("for_space must succeed");
        assert_eq!(
            r.dirty_count(),
            2,
            "subsequent for_space must continue incrementing dirty_count"
        );

        r.clear_dirty();
        assert_eq!(
            r.dirty_count(),
            0,
            "clear_dirty must reset dirty_count to 0"
        );
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
        // The boot rehydration pass uses `install_engine` to inject
        // engines whose docs were imported from a persisted snapshot.
        // A subsequent `for_space` call must observe the pre-built
        // engine (NOT lazy-instantiate a fresh empty one).
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

    /// #607 — `clear` drops every engine; a subsequent `for_space`
    /// lazy-creates a FRESH empty engine (no pre-clear content leaks).
    #[test]
    fn clear_drops_all_engines_and_for_space_recreates_fresh_607() {
        let r = LoroEngineRegistry::new();
        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);
        {
            let mut g = r.for_space(&a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "pre-reset", None, 0)
                .expect("create");
        }
        {
            let _ = r.for_space(&b, "device-1").expect("b");
        }
        assert_eq!(r.len(), 2);

        r.clear();
        assert_eq!(r.len(), 0, "clear must drop every engine");
        assert!(r.is_empty());

        // Lazy re-creation yields a fresh engine without the old block.
        let mut g = r.for_space(&a, "device-1").expect("a again");
        assert!(
            g.engine_mut().read_block("BLOCK_A").unwrap().is_none(),
            "post-clear engine must NOT contain pre-clear content"
        );
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

    /// Issue #153 — the snapshot exported with the registry lock released
    /// must round-trip to the engine's exact state. Imports each exported
    /// snapshot into a fresh engine and asserts the block created before
    /// the snapshot is present, proving the post-lock export sees real
    /// document state (not an empty/aliased doc).
    #[test]
    fn snapshot_all_engines_export_round_trips() {
        let r = LoroEngineRegistry::new();
        let a = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = r.for_space(&a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "round-trip", None, 0)
                .expect("create");
        }

        let pairs = r.snapshot_all_engines();
        assert_eq!(pairs.len(), 1);
        let (_space_id, bytes) = pairs.into_iter().next().expect("one pair");
        let bytes = bytes.expect("export ok");

        let mut fresh = LoroEngine::new();
        fresh.import(&bytes).expect("import snapshot");
        assert!(
            fresh.read_block("BLOCK_A").expect("read").is_some(),
            "snapshot exported outside the lock must contain pre-snapshot state",
        );
    }

    /// Issue #153 — the registry mutex must NOT be held while the
    /// per-space snapshot export runs. `snapshot_all_engines` collects
    /// O(1) `LoroDoc` handles under the lock, drops it, then exports.
    /// This drives a real export pass on a worker thread while the main
    /// thread concurrently hammers `for_space`/`space_ids` (both of which
    /// take the registry mutex); if the export still held the lock for its
    /// duration this would serialise, but the assertion is simply that
    /// every operation completes — i.e. no deadlock and no panic from a
    /// poisoned/aliased guard.
    #[test]
    fn snapshot_export_does_not_hold_registry_lock() {
        use std::sync::Arc;
        use std::thread;

        let r = Arc::new(LoroEngineRegistry::new());
        let a = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = r.for_space(&a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "concurrent", None, 0)
                .expect("create");
        }

        let snapshotter = {
            let r = Arc::clone(&r);
            thread::spawn(move || {
                for _ in 0..50 {
                    let pairs = r.snapshot_all_engines();
                    assert_eq!(pairs.len(), 1);
                    assert!(pairs[0].1.is_ok(), "export must succeed");
                }
            })
        };

        // Concurrently take the registry mutex via for_space + space_ids.
        for _ in 0..50 {
            let _ = r.space_ids();
            let mut g = r.for_space(&a, "device-1").expect("for_space");
            assert!(g.engine_mut().read_block("BLOCK_A").unwrap().is_some());
        }

        snapshotter.join().expect("snapshot thread finished");
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
