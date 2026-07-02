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
//! ## Concurrency (#2205)
//!
//! Locking is sharded per space so CRDT work on DIFFERENT spaces runs
//! concurrently — peer B's sync of space Y no longer waits behind peer
//! A's export of space X (the pre-#2205 single
//! `Mutex<HashMap<SpaceId, LoroEngine>>` serialized every engine
//! operation process-wide, and #2188 made the long CPU-bound
//! export/import passes hold that one lock inside `block_in_place`):
//!
//! * an **outer map mutex** — `Mutex<HashMap<SpaceId,
//!   Arc<Mutex<LoroEngine>>>>` — guards only the map structure
//!   (lookup / lazy-insert / replace / clear). It is held for
//!   O(1)-per-entry map work only, NEVER while an engine lock is being
//!   acquired or held, and NEVER across CRDT work;
//! * one **inner engine mutex per space** — held for the duration of a
//!   single engine operation, including the CPU-bound export/import
//!   passes running under `block_in_place` (#2188). Same-space
//!   operations therefore serialize exactly as before.
//!
//! ### Lock discipline
//!
//! No path in this module ever holds two locks at once: every method
//! clones the per-space `Arc` out of the map, **drops the outer
//! guard**, and only then locks the engine. No path locks two engines
//! simultaneously either. Preserve both properties when extending this
//! module — together they make lock-order cycles structurally
//! impossible. (If a future path genuinely must hold two engine locks,
//! acquire them in `SpaceId` order and document it here.)
//!
//! ### Detached engines (clear / install_engine races)
//!
//! Callers hold an owned, `Arc`-backed engine guard ([`EngineGuard`]),
//! so an engine can outlive its map entry: a
//! [`clear`](LoroEngineRegistry::clear) (snapshot RESET) or an
//! [`install_engine`](LoroEngineRegistry::install_engine) replacement
//! racing an in-flight engine operation detaches that engine from the
//! map. The in-flight operation completes against the detached engine,
//! whose state drops with the last `Arc` clone. The outcome is
//! identical to the op having completed immediately BEFORE the
//! clear/replace under the old whole-map mutex — its engine state is
//! discarded either way — and a detached engine can never be
//! re-inserted: [`for_space`](LoroEngineRegistry::for_space) only ever
//! lazy-creates FRESH engines via a get-or-insert performed atomically
//! under the outer lock.
//!
//! ### Poisoning
//!
//! `parking_lot` mutexes (no poisoning) replace the previous
//! `std::sync::Mutex` + `PoisonError::into_inner` recovery. Behaviour
//! is identical: this module always continued straight through poison,
//! which is exactly what a non-poisoning mutex does.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use loro::{ExportMode, LoroDoc};
use parking_lot::lock_api::ArcMutexGuard;
use parking_lot::{Mutex, RawMutex};

use crate::error::AppError;
use crate::loro::engine::LoroEngine;
use crate::space::SpaceId;

/// A per-space engine slot: the map stores `Arc<Mutex<LoroEngine>>` so
/// the (long) engine critical section is taken WITHOUT the map lock —
/// see the module-level Concurrency section (#2205).
type SharedEngine = Arc<Mutex<LoroEngine>>;

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
///
/// [`save_all_engines`]: crate::loro::snapshot::save_all_engines
pub struct LoroEngineRegistry {
    /// Outer map lock (#2205). Guards ONLY the `SpaceId -> Arc` map;
    /// engine work happens under the per-space inner mutex with this
    /// lock released. See the module-level lock discipline.
    inner: Mutex<HashMap<SpaceId, SharedEngine>>,
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
    /// #792 — the Loro peer-id epoch every lazily-created engine derives
    /// its `PeerID` from (see [`crate::loro::engine::peer_id_for_epoch`]).
    ///
    /// `0` (the constructor default and the lifetime value for any vault
    /// that never went through a snapshot RESET) reproduces the legacy
    /// `peer_id_from_device_id` mapping exactly. Loaded from
    /// `app_settings` at boot (`crate::loro::peer_epoch::load_peer_epoch`)
    /// and refreshed by `reload_registry_from_db` right after a RESET
    /// bumps the persisted value — so post-reset engines mint ops under a
    /// FRESH peer id instead of forking the `(peer, counter)` space
    /// against this device's pre-reset ops still held by peers.
    peer_epoch: AtomicU64,
}

impl LoroEngineRegistry {
    /// Construct an empty registry.  Engines are created lazily on
    /// first [`for_space`](Self::for_space) call.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            dirty_count: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
            peer_epoch: AtomicU64::new(0),
        }
    }

    /// #792 — current peer-id epoch. See the field docs.
    pub fn peer_epoch(&self) -> u64 {
        self.peer_epoch.load(Ordering::Acquire)
    }

    /// #792 — install the peer-id epoch subsequent engine constructions
    /// derive their `PeerID` from. Called at boot (with the
    /// `app_settings` value) and by `reload_registry_from_db` after a
    /// snapshot RESET bumped the persisted epoch. Engines already held
    /// by the registry are NOT re-keyed — the RESET path clears them in
    /// the same breath, and a healthy boot sets the epoch before any
    /// engine exists.
    pub fn set_peer_epoch(&self, epoch: u64) {
        self.peer_epoch.store(epoch, Ordering::Release);
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

    /// Get-or-lazily-create the engine for `space_id` and lock it,
    /// returning an owned RAII guard ([`EngineGuard`]) the caller can
    /// mutate the engine through.
    ///
    /// #2205 — the outer map mutex is held only for the get-or-insert
    /// (performed atomically, so racing callers can never install two
    /// engines for one space) and is dropped BEFORE this method blocks
    /// on the per-space engine mutex. Engine work on other spaces —
    /// including CPU-bound export/import under `block_in_place` (#2188)
    /// — is therefore never blocked by this call; only same-space
    /// operations serialize, on the engine's own lock.
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
    pub fn for_space(&self, space_id: &SpaceId, device_id: &str) -> Result<EngineGuard, AppError> {
        let shared: SharedEngine = {
            let mut map = self.inner.lock();
            if let Some(existing) = map.get(space_id) {
                Arc::clone(existing)
            } else {
                // #792: salt the deterministic peer id with the registry's
                // current epoch so an engine lazily created after a snapshot
                // RESET never reuses the pre-reset PeerID (epoch 0 == the
                // legacy mapping, unchanged for never-reset vaults).
                //
                // Construction is O(1) (an empty LoroDoc), so doing it
                // under the map lock is cheap and keeps check+insert
                // atomic — no two racing callers can each install an
                // engine for the same space.
                let engine = LoroEngine::with_peer_id_epoch(device_id, self.peer_epoch())?;
                let shared: SharedEngine = Arc::new(Mutex::new(engine));
                map.insert(space_id.clone(), Arc::clone(&shared));
                shared
            }
            // Outer map guard drops HERE — before the engine lock below.
        };
        // Issue #157 sub-item I — `for_space` is the chokepoint
        // every mutation path goes through, so a per-call increment
        // is the simplest "engines have changed since last save"
        // proxy. Over-counts (a read-only `for_space` call also
        // bumps the counter); the extra snapshot the daemon may then
        // fire is idempotent so the false positive is harmless.
        self.dirty_count.fetch_add(1, Ordering::Relaxed);
        // Block on the PER-SPACE lock only (#2205). `lock_arc` returns an
        // owned guard that keeps the engine alive even if the map entry is
        // concurrently removed (`clear`) or replaced (`install_engine`) —
        // see "Detached engines" in the module docs.
        Ok(EngineGuard {
            guard: shared.lock_arc(),
        })
    }

    /// Read-only per-space Loro version vector, **without** bumping
    /// `dirty_count`.
    ///
    /// Incremental sync (#87 §10.5) advertises these vvs in `HeadExchange`
    /// on every initiated session. Routing that read through
    /// [`Self::for_space`] would bump the dirty counter (it is the mutation
    /// chokepoint and over-counts read-only calls) and arm a spurious full
    /// **disk** snapshot of every space on each otherwise-quiescent session
    /// — directly counterproductive for a path whose purpose is to *cut*
    /// snapshot churn. This accessor never lazily creates an engine: an
    /// unregistered space returns `None`, and the sender falls back to a
    /// full snapshot for it. #2205: the read takes the per-space engine
    /// lock (with the map lock already released), so it waits only on
    /// in-flight work for THIS space, never on other spaces'.
    pub fn loro_vv(&self, space_id: &SpaceId) -> Option<Vec<u8>> {
        let shared = { self.inner.lock().get(space_id).map(Arc::clone) }?;
        Some(shared.lock().version_vector())
    }

    /// All [`SpaceId`]s currently registered, in arbitrary order.
    ///
    /// Used by the sync orchestrator to enumerate which spaces to
    /// push when entering `StreamingOps`. The returned `Vec` is a
    /// snapshot (cloned under the map lock); the caller may iterate
    /// without holding any registry lock. Concurrent `for_space`
    /// calls that lazy-create new engines after this snapshot are
    /// simply not visible to the current sync round — they will be
    /// picked up by the next `HeadExchange`.
    pub fn space_ids(&self) -> Vec<SpaceId> {
        self.inner.lock().keys().cloned().collect()
    }

    /// Number of engines currently held.  Used by tests to assert
    /// per-space isolation.
    pub fn len(&self) -> usize {
        self.inner.lock().len()
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
    ///
    /// #2205 — an in-flight engine operation holding the REPLACED
    /// entry's guard completes against the detached engine (whose state
    /// then drops), exactly as if it had finished before this call under
    /// the old whole-map mutex. See "Detached engines" in the module docs.
    pub fn install_engine(&self, space_id: SpaceId, engine: LoroEngine) {
        self.inner
            .lock()
            .insert(space_id, Arc::new(Mutex::new(engine)));
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
    /// #2205 — this needs only the outer MAP lock, so it never waits on
    /// (nor deadlocks with) an in-flight engine operation. An
    /// `engine_apply` racing this call either
    /// * already holds its engine guard — the engine is detached from
    ///   the map, the op completes against it, and the engine state
    ///   drops with the guard (same outcome as the op having landed
    ///   just BEFORE the clear under the old whole-map mutex: the
    ///   pre-reset state is discarded either way), or
    /// * arrives at `for_space` after the clear — it lazy-creates a
    ///   fresh post-reset engine.
    ///
    /// A detached engine is never re-inserted (`for_space`'s
    /// get-or-insert is atomic under the map lock and only creates
    /// FRESH engines), and the generation bump below happens while the
    /// map lock is held, so `save_all_engines`' pre-collect generation
    /// capture vs. re-check-per-write protocol still detects any clear
    /// that lands after its handle collection.
    pub fn clear(&self) {
        let mut map = self.inner.lock();
        map.clear();
        // Bump the generation WHILE holding the map lock so any saver that
        // collected handles before this clear observes the new value on
        // its next check (see the `generation` field docs).
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Snapshot every registered engine via `LoroDoc::export` and
    /// return the resulting `(space_id, Result<bytes, AppError>)`
    /// pairs.  Per-engine errors are returned in the inner `Result` so
    /// the caller can decide whether to log + continue (the periodic
    /// scheduler) or abort (a debug "snapshot now" command).
    ///
    /// ## Issue #153 / #2205 — exports run with NO registry lock held
    ///
    /// 1. collect the `(SpaceId, Arc<Mutex<LoroEngine>>)` pairs under
    ///    the map lock (O(spaces) pointer clones) and drop it — the
    ///    space SET is an atomic cut of the map;
    /// 2. per space, take THAT engine's lock only for the O(1)
    ///    [`LoroEngine::doc_handle`] reference-clone (waiting, at most,
    ///    for an in-flight operation on that one space) and release it;
    /// 3. run the (comparatively slow) snapshot export on each handle
    ///    with no lock held at all, so concurrent applies — even to the
    ///    space being exported — are never blocked.
    ///
    /// ## Consistency contract
    ///
    /// Each returned snapshot is **internally consistent** for its
    /// space and at-least-as-fresh-as the collect instant: a `LoroDoc`
    /// handle shares the underlying document, so an apply that lands
    /// after its engine-lock release but before its export is simply
    /// included — a strictly fresher point-in-time export. There is
    /// **no cross-space atomic cut**: space A's snapshot and space B's
    /// may reflect different instants. This is the SAME contract the
    /// pre-#2205 code had (since #153 the exports already ran after the
    /// registry lock was dropped, so cross-space skew already existed);
    /// the sole production caller,
    /// [`crate::loro::snapshot::save_all_engines`], tolerates it by
    /// construction — its `applied_through_seq` watermark is a
    /// conservative per-space lower bound read BEFORE the collect, and
    /// its generation re-check before every write handles a racing
    /// [`clear`](Self::clear).
    pub fn snapshot_all_engines(&self) -> Vec<(SpaceId, Result<Vec<u8>, AppError>)> {
        // Phase 1: clone the Arc handles under the map lock, then release it
        // (no engine lock is taken while the map lock is held — see the
        // module-level lock discipline).
        let engines: Vec<(SpaceId, SharedEngine)> = {
            let map = self.inner.lock();
            map.iter()
                .map(|(space_id, shared)| (space_id.clone(), Arc::clone(shared)))
                .collect()
        };

        // Phase 2: per space, lock the engine ONLY for the O(1) doc-handle
        // clone, then export with no locks held.
        engines
            .into_iter()
            .map(|(space_id, shared)| {
                let doc: LoroDoc = shared.lock().doc_handle();
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

/// Owned RAII guard returned by [`LoroEngineRegistry::for_space`].
///
/// Holds the **per-space engine mutex** (#2205 — NOT the registry map
/// mutex, which was already released) until dropped; `engine_mut`
/// yields the engine. Holding one lock across the whole
/// lookup-and-mutate span avoids the "lookup, drop lock, re-acquire"
/// pattern that would let another thread mutate the engine between
/// read and write — same-space callers serialize on this guard.
///
/// The guard is `Arc`-backed ([`ArcMutexGuard`]), so it keeps its
/// engine alive even if the registry entry is concurrently removed or
/// replaced — see "Detached engines" in the module docs. Like the
/// `std::sync::MutexGuard` it replaced, it is `!Send`: it cannot be
/// held across an `.await`, which callers rely on to keep engine
/// critical sections synchronous.
pub struct EngineGuard {
    guard: ArcMutexGuard<RawMutex, LoroEngine>,
}

impl EngineGuard {
    /// Mutable access to the engine.
    pub fn engine_mut(&mut self) -> &mut LoroEngine {
        &mut self.guard
    }
}

// Compile-time tripwire: `EngineGuard` must stay `!Send`. Callers rely on
// it to keep engine critical sections synchronous — the guard can never be
// held across an `.await` (#2188 reactor stalls), which is what lets the
// CPU-bound export/import passes hold it inside `block_in_place` safely.
// `ArcMutexGuard` silently becomes `Send` if parking_lot's `send_guard`
// feature is ever enabled anywhere in the workspace (cargo feature
// unification), so pin the property here: if `EngineGuard: Send` ever
// holds, the `<EngineGuard as AmbiguousIfSend<_>>` lookup below matches
// two impls and this stops compiling. (Inlined expansion of
// `static_assertions::assert_not_impl_any!(EngineGuard: Send)` — no new
// dependency.)
const _: fn() = || {
    trait AmbiguousIfSend<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfSend<()> for T {}
    struct Invalid;
    impl<T: ?Sized + Send> AmbiguousIfSend<Invalid> for T {}
    let _ = <EngineGuard as AmbiguousIfSend<_>>::some_item;
};

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

    /// #792 — engines lazily created by `for_space` derive their PeerID
    /// from the registry's peer-id epoch: epoch 0 (the default) is the
    /// legacy mapping; a bumped epoch yields a fresh peer id so a
    /// post-snapshot-RESET engine never forks the (peer, counter) space.
    #[test]
    fn for_space_derives_peer_id_from_registry_epoch_792() {
        use crate::loro::engine::{peer_id_for_epoch, peer_id_from_device_id};

        let r = LoroEngineRegistry::new();
        assert_eq!(r.peer_epoch(), 0, "fresh registry defaults to epoch 0");

        // Epoch 0: byte-for-byte the legacy mapping.
        let a = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = r.for_space(&a, "device-792").expect("a");
            assert_eq!(
                g.engine_mut().peer_id(),
                peer_id_from_device_id("device-792"),
                "epoch 0 must keep the legacy peer id (existing vaults)"
            );
        }

        // Bumped epoch (a RESET happened): the next lazily-created
        // engine mints under the fresh, salted peer id.
        r.set_peer_epoch(3);
        r.clear(); // the RESET path clears in the same breath
        {
            let mut g = r.for_space(&a, "device-792").expect("a again");
            let got = g.engine_mut().peer_id();
            assert_eq!(got, peer_id_for_epoch("device-792", 3));
            assert_ne!(
                got,
                peer_id_from_device_id("device-792"),
                "the pre-reset peer id must be retired"
            );
        }
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

    /// Issue #153 — no registry lock may be held while the per-space
    /// snapshot export runs. `snapshot_all_engines` collects Arc handles
    /// under the map lock, locks each engine only for the O(1) doc-handle
    /// clone, then exports lock-free. This drives a real export pass on a
    /// worker thread while the main thread concurrently hammers
    /// `for_space`/`space_ids` (which take the engine and map locks); if
    /// the export still held either lock for its duration this would
    /// serialise, but the assertion is simply that every operation
    /// completes — i.e. no deadlock and no panic from a poisoned/aliased
    /// guard.
    #[test]
    fn snapshot_export_does_not_hold_registry_lock() {
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

        // Concurrently take the registry locks via for_space + space_ids.
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

    // -----------------------------------------------------------------
    // #2205 — per-space lock sharding
    // -----------------------------------------------------------------

    /// #2205 — engine work on one space must NOT block engine access to
    /// a DIFFERENT space. Deterministic pin: the main thread acquires
    /// and HOLDS space A's engine guard; a worker thread then completes
    /// a full `for_space` + create + read on space B while A's guard is
    /// still held. Under the pre-#2205 whole-map mutex the worker's
    /// `for_space` would block until A's guard dropped and the
    /// `recv_timeout` below would fail.
    #[test]
    fn engine_guard_on_one_space_does_not_block_another_space_2205() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let r = Arc::new(LoroEngineRegistry::new());
        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);

        // Hold space A's engine guard for the whole test body.
        let mut guard_a = r.for_space(&a, "device-1").expect("hold A");
        guard_a
            .engine_mut()
            .apply_create_block("BLOCK_A", "content", "held", None, 0)
            .expect("create A");

        let (tx, rx) = mpsc::channel();
        let worker = {
            let r = Arc::clone(&r);
            let b = b.clone();
            thread::spawn(move || {
                // Full lazy-create + apply + read on space B — must
                // complete while space A's guard is held elsewhere.
                let mut g = r.for_space(&b, "device-1").expect("b in worker");
                g.engine_mut()
                    .apply_create_block("BLOCK_B", "content", "concurrent", None, 0)
                    .expect("create B");
                let snap = g
                    .engine_mut()
                    .read_block("BLOCK_B")
                    .expect("read")
                    .expect("present");
                tx.send(snap.content).expect("send");
            })
        };

        let content = rx.recv_timeout(Duration::from_secs(30)).expect(
            "space-B engine op must complete while space-A's guard is held — \
             a timeout means engine access is still serialized across spaces \
             (#2205 regression)",
        );
        assert_eq!(content, "concurrent");

        // Space A's guard was valid throughout.
        assert!(
            guard_a
                .engine_mut()
                .read_block("BLOCK_A")
                .unwrap()
                .is_some()
        );
        drop(guard_a);
        worker.join().expect("worker");
        assert_eq!(r.len(), 2);
    }

    /// #2205 — sustained concurrent import/export traffic on two
    /// DIFFERENT spaces (real `LoroEngine` ops on a multi-thread tokio
    /// runtime, mirroring the production sync daemon shape): both tasks
    /// make progress, every exported snapshot round-trips, and neither
    /// space's engine ends up with the other's blocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_import_export_on_two_spaces_2205() {
        const ROUNDS: usize = 20;

        let r = Arc::new(LoroEngineRegistry::new());

        let spawn_traffic = |space: SpaceId, prefix: &'static str| {
            let r = Arc::clone(&r);
            tokio::task::spawn_blocking(move || {
                for i in 0..ROUNDS {
                    let id = format!("{prefix}{i:03}");
                    // Apply + export under ONE per-space guard (the
                    // production export path holds the engine lock across
                    // the encode, #2188).
                    let bytes = {
                        let mut g = r.for_space(&space, "device-1").expect("for_space");
                        let engine = g.engine_mut();
                        engine
                            .apply_create_block(&id, "content", &id, None, 0)
                            .expect("create");
                        engine.export_snapshot().expect("export")
                    };
                    // Import round-trip into a fresh engine — pins that the
                    // concurrently-produced export is internally consistent.
                    let mut probe = LoroEngine::new();
                    probe.import(&bytes).expect("import");
                    assert!(
                        probe.read_block(&id).expect("read").is_some(),
                        "exported snapshot must contain the block just created"
                    );
                }
            })
        };

        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);
        let task_a = spawn_traffic(a.clone(), "A");
        let task_b = spawn_traffic(b.clone(), "B");
        task_a.await.expect("space-A traffic task");
        task_b.await.expect("space-B traffic task");

        // Every block landed in ITS OWN space's engine and nowhere else.
        let mut g = r.for_space(&a, "device-1").expect("a final");
        for i in 0..ROUNDS {
            assert!(
                g.engine_mut()
                    .read_block(&format!("A{i:03}"))
                    .unwrap()
                    .is_some()
            );
            assert!(
                g.engine_mut()
                    .read_block(&format!("B{i:03}"))
                    .unwrap()
                    .is_none()
            );
        }
        drop(g);
        let mut g = r.for_space(&b, "device-1").expect("b final");
        for i in 0..ROUNDS {
            assert!(
                g.engine_mut()
                    .read_block(&format!("B{i:03}"))
                    .unwrap()
                    .is_some()
            );
            assert!(
                g.engine_mut()
                    .read_block(&format!("A{i:03}"))
                    .unwrap()
                    .is_none()
            );
        }
    }

    /// #2205 — sharding must NOT weaken same-space exclusion: two
    /// threads hammer ONE space, each performing a multi-step
    /// apply + read-back sequence under a single guard. Any
    /// interleaving inside the critical section would break the
    /// `before + 1` live-count invariant; afterwards the engine holds
    /// every block from both threads (no torn/lost writes).
    #[test]
    fn same_space_ops_stay_serialized_2205() {
        use std::thread;

        const PER_THREAD: usize = 25;

        let r = Arc::new(LoroEngineRegistry::new());
        let space = SpaceId::from_trusted(SPACE_A);

        let workers: Vec<_> = (0..2)
            .map(|t| {
                let r = Arc::clone(&r);
                let space = space.clone();
                thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        let id = format!("T{t}B{i:02}");
                        let mut g = r.for_space(&space, "device-1").expect("for_space");
                        let engine = g.engine_mut();
                        let before = engine.live_block_ids().expect("live").len();
                        engine
                            .apply_create_block(&id, "content", &id, None, 0)
                            .expect("create");
                        // Still under the guard: exactly ONE block was
                        // added, and it is ours — an interleaved writer
                        // inside the critical section would break this.
                        let after = engine.live_block_ids().expect("live").len();
                        assert_eq!(
                            after,
                            before + 1,
                            "same-space critical section must be exclusive"
                        );
                        let snap = engine
                            .read_block(&id)
                            .expect("read")
                            .expect("own write visible under the same guard");
                        assert_eq!(snap.content, id);
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().expect("worker");
        }

        let mut g = r.for_space(&space, "device-1").expect("final");
        assert_eq!(
            g.engine_mut().live_block_ids().expect("live").len(),
            2 * PER_THREAD,
            "every block from both threads must land (no lost updates)"
        );
        assert_eq!(r.len(), 1, "still exactly one engine for the space");
    }

    /// #2205 — `snapshot_all_engines` racing concurrent writers on two
    /// spaces: every pass completes (no deadlock), returns BOTH spaces
    /// (the space set is an atomic cut of the map), and every exported
    /// snapshot is internally consistent — it imports cleanly into a
    /// fresh engine and contains its space's seed block.
    #[test]
    fn snapshot_all_engines_during_concurrent_writes_2205() {
        use std::sync::atomic::AtomicBool;
        use std::thread;

        let r = Arc::new(LoroEngineRegistry::new());
        let a = SpaceId::from_trusted(SPACE_A);
        let b = SpaceId::from_trusted(SPACE_B);
        for (space, seed) in [(&a, "SEED_A"), (&b, "SEED_B")] {
            let mut g = r.for_space(space, "device-1").expect("seed");
            g.engine_mut()
                .apply_create_block(seed, "content", seed, None, 0)
                .expect("create seed");
        }

        let stop = Arc::new(AtomicBool::new(false));
        let writers: Vec<_> = [(a.clone(), "WA"), (b.clone(), "WB")]
            .into_iter()
            .map(|(space, prefix)| {
                let r = Arc::clone(&r);
                let stop = Arc::clone(&stop);
                thread::spawn(move || {
                    let mut i = 0usize;
                    while !stop.load(Ordering::Relaxed) {
                        let id = format!("{prefix}{i:04}");
                        let mut g = r.for_space(&space, "device-1").expect("for_space");
                        g.engine_mut()
                            .apply_create_block(&id, "content", &id, None, 0)
                            .expect("create");
                        i += 1;
                    }
                })
            })
            .collect();

        for _ in 0..20 {
            let pairs = r.snapshot_all_engines();
            assert_eq!(
                pairs.len(),
                2,
                "snapshot pass must contain every registered space"
            );
            let mut seen = Vec::new();
            for (space_id, bytes) in pairs {
                let bytes = bytes.expect("export must succeed mid-write");
                let mut probe = LoroEngine::new();
                probe
                    .import(&bytes)
                    .expect("snapshot taken during concurrent writes must import cleanly");
                let seed = if space_id.as_str() == SPACE_A {
                    "SEED_A"
                } else {
                    "SEED_B"
                };
                assert!(
                    probe.read_block(seed).expect("read").is_some(),
                    "snapshot must contain its space's pre-existing seed block"
                );
                seen.push(space_id.as_str().to_string());
            }
            seen.sort();
            assert_eq!(seen, vec![SPACE_A.to_string(), SPACE_B.to_string()]);
        }

        stop.store(true, Ordering::Relaxed);
        for w in writers {
            w.join().expect("writer");
        }
    }

    /// #2205 — `clear` during an in-flight `for_space` operation:
    /// `clear` must not block on the held ENGINE guard (it needs only
    /// the MAP lock — under the pre-#2205 whole-map mutex this exact
    /// schedule deadlocked), the in-flight op completes against the
    /// detached engine without panicking, the map is empty immediately
    /// after the clear, and the detached engine never reappears.
    #[test]
    fn clear_races_inflight_for_space_op_2205() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let r = Arc::new(LoroEngineRegistry::new());
        let a = SpaceId::from_trusted(SPACE_A);

        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let worker = {
            let r = Arc::clone(&r);
            let a = a.clone();
            thread::spawn(move || {
                let mut g = r.for_space(&a, "device-1").expect("for_space");
                g.engine_mut()
                    .apply_create_block("BLOCK_PRE", "content", "pre-clear", None, 0)
                    .expect("create pre-clear");
                held_tx.send(()).expect("signal guard held");
                release_rx.recv().expect("wait for clear to finish");
                // `clear()` has run: this engine is now detached from the
                // map. The in-flight op must still complete cleanly.
                g.engine_mut()
                    .apply_create_block("BLOCK_POST", "content", "post-clear", None, 0)
                    .expect("create on detached engine");
                let snap = g
                    .engine_mut()
                    .read_block("BLOCK_POST")
                    .expect("read")
                    .expect("present on detached engine");
                assert_eq!(snap.content, "post-clear");
            })
        };

        held_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("worker must acquire the engine guard");

        // Run clear() on a helper thread so a regression (clear blocking
        // on the held engine guard) fails the recv_timeout instead of
        // hanging the test.
        let generation_before = r.generation();
        let (cleared_tx, cleared_rx) = mpsc::channel();
        {
            let r = Arc::clone(&r);
            thread::spawn(move || {
                r.clear();
                cleared_tx.send(()).expect("signal cleared");
            });
        }
        cleared_rx.recv_timeout(Duration::from_secs(30)).expect(
            "clear must not block on an in-flight engine guard (#2205) — \
             a timeout means clear waits for engine operations again",
        );
        assert_eq!(r.len(), 0, "map is empty immediately after clear");
        assert_eq!(
            r.generation(),
            generation_before + 1,
            "clear must bump the generation (#607 saver protocol)"
        );

        // Let the in-flight op finish against the detached engine.
        release_tx.send(()).expect("release worker");
        worker.join().expect("in-flight op completes without panic");

        // The detached engine must NOT have been re-inserted, and a fresh
        // for_space lazy-creates an empty post-clear engine.
        assert_eq!(r.len(), 0, "detached engine must not reappear after its op");
        let mut g = r.for_space(&a, "device-1").expect("fresh post-clear");
        assert!(
            g.engine_mut().read_block("BLOCK_PRE").unwrap().is_none(),
            "post-clear engine must not contain pre-clear content"
        );
        assert!(
            g.engine_mut().read_block("BLOCK_POST").unwrap().is_none(),
            "detached-engine writes must not leak into the fresh engine"
        );
    }
}
