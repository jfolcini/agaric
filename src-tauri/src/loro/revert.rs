//! #2604 — rollback-safe engine-apply wiring: the per-tx revert log and its
//! RAII scope.
//!
//! ## The gap this closes
//!
//! In the command write path, op_log + SQL `blocks` commit atomically in one
//! `BEGIN IMMEDIATE` transaction, but the in-memory Loro engine is mutated
//! OUTSIDE that transaction (`materializer/handlers/loro_apply.rs`, via
//! [`for_space`](crate::loro::registry::LoroEngineRegistry::for_space)). A
//! COMMIT failure (or crash) between the engine apply and the SQL COMMIT leaves
//! the engine AHEAD of committed SQL — the divergence class #2603's
//! crash-injection test pins. For the REMOTE / single-op path
//! ([`apply_op`](crate::materializer::handlers)) that divergence does NOT
//! self-heal at runtime (only a `reproject_blocks_from_engine` recovery pass
//! reconciles it); the LOCAL command path self-heals via boot replay.
//!
//! ## Mechanism (apply-in-place + rewind-on-abort)
//!
//! The engine primitives ([`checkpoint_frontiers`] /
//! [`revert_to_frontier`](crate::loro::engine::LoroEngine::revert_to_frontier))
//! give an `O(1)` capture on the common path and an `O(n)` rewind paid ONLY on
//! the rare abort. This module wires them into the tx lifecycle:
//!
//! 1. The tx owner ([`apply_op`]) ARMS a [`RevertScope`] right after
//!    `BEGIN IMMEDIATE`.
//! 2. Each mutation handler's
//!    [`for_space_recording`](crate::loro::registry::LoroEngineRegistry::for_space_recording)
//!    call records the touched space's pre-op checkpoint into the armed
//!    [`RevertLog`] (first-touch per space).
//! 3. Once the apply has run — STILL under the write lock — the owner
//!    [`detach`](RevertScope::detach)es the checkpoints from the shared log,
//!    disarming it, and makes an explicit commit/abort decision.
//! 4. On SQL COMMIT success the detached checkpoints are dropped (the ops stay);
//!    on abort — an apply error or a failing `commit()` — they
//!    [`revert`](DetachedRevert::revert) every recorded space. A panic between
//!    arming and detaching is caught by the scope's `Drop` safety-net.
//!
//! ## Why a single un-keyed log is sound
//!
//! The log holds AT MOST one in-flight tx's checkpoints, with no per-tx key,
//! because engine mutations are serialised by the caller's `BEGIN IMMEDIATE`
//! write lock: while one tx sits between its `BEGIN IMMEDIATE` and its
//! commit/rollback, no other writer can be in its engine-apply phase. Arming
//! (step 1) to detaching (step 3) both happen inside that lock-held window, so a
//! concurrent writer never observes an armed log that isn't its own. In
//! production [`for_space`] is exclusively a MUTATION chokepoint (every non-test
//! caller is a write handler), so an armed log never records a concurrent
//! reader either. Arming a log that is already armed is a bug (nested write tx)
//! and trips a debug assert.
//!
//! [`checkpoint_frontiers`]: crate::loro::engine::LoroEngine::checkpoint_frontiers
//! [`apply_op`]: crate::materializer::handlers

use loro::Frontiers;
use parking_lot::Mutex;

use crate::loro::registry::SharedEngine;
use crate::space::SpaceId;

/// One recorded rollback checkpoint: the exact engine `Arc` a speculative op was
/// applied through, plus the op-log frontier to rewind it to on abort.
struct RevertEntry {
    space_id: SpaceId,
    /// The very `Arc<Mutex<LoroEngine>>` the op is applied through — held so the
    /// abort path rewinds THIS engine even if the registry entry was since
    /// replaced/removed (a detached engine; see registry "Detached engines").
    engine: SharedEngine,
    frontier: Frontiers,
}

/// Per-tx engine-rollback log (#2604). `Some` == a [`RevertScope`] is armed;
/// `None` == no in-flight rollback-tracked tx (records are dropped).
///
/// Lives on [`LoroState`](crate::loro::shared::LoroState); see the module docs
/// for why one un-keyed slot is sound.
#[derive(Default)]
pub struct RevertLog {
    inner: Mutex<Option<Vec<RevertEntry>>>,
}

impl RevertLog {
    /// A fresh, un-armed log.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Record the FIRST-touch checkpoint for `space_id` iff the log is armed.
    ///
    /// `frontier` is a closure so the `oplog_frontiers()` capture is skipped
    /// entirely when the log is not armed (the LOCAL / replay / rebuild paths)
    /// or when this space was already recorded earlier in the same tx — the
    /// rewind discards ALL ops since the first touch, so a later op must not
    /// overwrite the earlier, earlier-is-safer frontier.
    pub(crate) fn record_first_touch(
        &self,
        space_id: &SpaceId,
        engine: &SharedEngine,
        frontier: impl FnOnce() -> Frontiers,
    ) {
        let mut slot = self.inner.lock();
        let Some(entries) = slot.as_mut() else {
            return; // not armed — no rollback tracking for this call
        };
        if entries.iter().any(|e| &e.space_id == space_id) {
            return; // already captured this space's pre-tx frontier
        }
        entries.push(RevertEntry {
            space_id: space_id.clone(),
            engine: SharedEngine::clone(engine),
            frontier: frontier(),
        });
    }

    /// Arm the log for a new in-flight tx. Debug-asserts it was not already
    /// armed (a nested write tx would violate the single-in-flight invariant).
    fn arm(&self) {
        let mut slot = self.inner.lock();
        debug_assert!(
            slot.is_none(),
            "RevertLog armed while already armed — a nested engine-mutating write \
             tx would break the single-in-flight invariant the un-keyed log relies on"
        );
        *slot = Some(Vec::new());
    }

    /// Take the recorded entries, leaving the log un-armed.
    fn take(&self) -> Option<Vec<RevertEntry>> {
        self.inner.lock().take()
    }
}

/// Rewind every recorded engine to its checkpoint. Shared by the two abort
/// paths: [`DetachedRevert::revert`] (commit/apply failure) and
/// [`RevertScope`]'s panic-net `Drop`.
fn revert_entries(entries: Vec<RevertEntry>) {
    // The `O(n)` `fork_at` rewind is paid ONLY here, and only on the exceptional
    // abort. Any handler's engine guard was already dropped (the guard is
    // `!Send` and released per apply), so re-locking — even during a panic
    // unwind, where inner scopes drop before the outer scope — cannot deadlock.
    // Errors can only be logged, not propagated, from these drop/consume paths.
    for entry in entries {
        let mut engine = entry.engine.lock();
        if let Err(err) = engine.revert_to_frontier(&entry.frontier) {
            tracing::error!(
                space_id = %entry.space_id,
                error = %err,
                "loro: #2604 engine rollback failed on tx abort — engine may be \
                 ahead of committed SQL until the next reproject/replay reconciles it"
            );
        }
    }
}

/// RAII arm guard around a [`RevertLog`] for one tx (#2604).
///
/// Construct with [`arm`](Self::arm) right after `BEGIN IMMEDIATE`. Once the
/// engine apply has run, call [`detach`](Self::detach) — WHILE THE WRITE LOCK IS
/// STILL HELD — to lift the recorded checkpoints out of the shared log for an
/// explicit commit/abort decision. Dropping the scope WITHOUT detaching (only
/// reachable if the owner unwinds mid-apply) reverts as a panic safety-net.
#[must_use = "detach the scope before the SQL commit, or hold it so its Drop reverts on a panic"]
pub struct RevertScope<'a> {
    log: &'a RevertLog,
}

impl<'a> RevertScope<'a> {
    /// Arm the state's [`RevertLog`] for a new in-flight tx.
    pub fn arm(state: &'a crate::loro::shared::LoroState) -> Self {
        state.revert.arm();
        Self { log: &state.revert }
    }

    /// Lift the recorded checkpoints out of the shared log, disarming it, and
    /// return them for the commit/abort decision.
    ///
    /// MUST be called while the caller's `BEGIN IMMEDIATE` write lock is still
    /// held (before the `commit()`/rollback that releases it). Arming then lasts
    /// ONLY from just-after-`BEGIN IMMEDIATE` to this call — entirely within the
    /// lock-held window — so, because engine mutations are serialised by that
    /// write lock, no concurrent writer can ever record into (or observe) a log
    /// that is not its own. Dropping the returned [`DetachedRevert`] keeps the
    /// applied ops (commit path); [`revert`](DetachedRevert::revert) rewinds
    /// them (abort path).
    pub fn detach(self) -> DetachedRevert {
        let entries = self.log.take().unwrap_or_default();
        // `self` drops here; the log is now un-armed, so `Drop` is a no-op.
        DetachedRevert { entries }
    }
}

impl Drop for RevertScope<'_> {
    /// Panic safety-net: reachable only if the owner unwinds between arming and
    /// [`detach`](Self::detach)ing. The normal commit/abort paths detach first,
    /// leaving this a no-op (the log is already un-armed).
    fn drop(&mut self) {
        if let Some(entries) = self.log.take() {
            revert_entries(entries);
        }
    }
}

/// Checkpoints lifted out of a [`RevertScope`] by [`detach`](RevertScope::detach)
/// for an explicit commit/abort decision (#2604).
///
/// Dropping it KEEPS the applied ops — the commit path. [`revert`](Self::revert)
/// rewinds every recorded engine to its pre-tx checkpoint — the abort path.
#[must_use = "drop to keep the ops (commit) or call `revert()` to roll them back (abort)"]
pub struct DetachedRevert {
    entries: Vec<RevertEntry>,
}

impl DetachedRevert {
    /// The abort path: rewind every recorded engine to its pre-tx checkpoint so
    /// it never stays ahead of the rolled-back SQL.
    pub fn revert(self) {
        revert_entries(self.entries);
    }
}
