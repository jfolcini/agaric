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
//! (`apply_op`, in the app-layer `materializer::handlers`) that divergence does NOT
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
//! 1. The tx owner ARMS the log right after `BEGIN IMMEDIATE` — the REMOTE
//!    single-op path (`apply_op`) via a [`RevertScope`], the LOCAL command
//!    path via the app-layer `CommandTx::arm_engine_rollback`,
//!    which detaches inside its own commit/rollback/`Drop` rather than a scope.
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
//! concurrent writer never observes an armed log that isn't its own. The log
//! records only through
//! [`for_space_recording`](crate::loro::registry::LoroEngineRegistry::for_space_recording),
//! whose callers are write handlers; a sync import goes through
//! [`with_engine`](crate::loro::registry::LoroEngineRegistry::with_engine) and
//! other readers through plain
//! [`for_space`](crate::loro::registry::LoroEngineRegistry::for_space), neither
//! of which records, so an armed log never records a concurrent reader
//! either. The engine writes that follow a commit record into a log of their
//! own ([`write_engines`](crate::loro::delta::write_engines)), never this one. Arming a log that is already armed is a bug (nested write tx)
//! and panics in every build: the un-keyed log would silently merge two txs'
//! checkpoints and rewind the wrong one on abort.
//!
//! [`checkpoint_frontiers`]: crate::loro::engine::LoroEngine::checkpoint_frontiers

use std::sync::Arc;

use loro::Frontiers;
use parking_lot::Mutex;

use crate::loro::registry::{DirtySpaces, SharedEngine};
use agaric_store::space::SpaceId;

/// One recorded rollback checkpoint: the exact engine `Arc` a speculative op was
/// applied through, plus the op-log frontier to rewind it to on abort.
struct RevertEntry {
    space_id: SpaceId,
    /// The very `Arc<Mutex<LoroEngine>>` the op is applied through — held so the
    /// abort path rewinds THIS engine even if the registry entry was since
    /// replaced/removed (a detached engine; see registry "Detached engines").
    engine: SharedEngine,
    frontier: Frontiers,
    /// The engine's encoded version vector at `frontier`: what
    /// [`DetachedRevert::deltas`] exports the transaction's update from (#6521).
    since: Vec<u8>,
    /// The dirty set of the registry `engine` came from.
    dirty: Arc<DirtySpaces>,
}

/// An engine's position before a transaction's first write to it, captured
/// under the engine lock by
/// [`for_space_recording`](crate::loro::registry::LoroEngineRegistry::for_space_recording).
pub(crate) struct Checkpoint {
    pub(crate) frontier: Frontiers,
    pub(crate) since: Vec<u8>,
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
    /// `checkpoint` is a closure so the capture is skipped
    /// entirely when the log is not armed (the LOCAL / replay / rebuild paths)
    /// or when this space was already recorded earlier in the same tx — the
    /// rewind discards ALL ops since the first touch, so a later op must not
    /// overwrite the earlier, earlier-is-safer frontier.
    pub(crate) fn record_first_touch(
        &self,
        space_id: &SpaceId,
        engine: &SharedEngine,
        dirty: &Arc<DirtySpaces>,
        checkpoint: impl FnOnce() -> Checkpoint,
    ) {
        let mut slot = self.inner.lock();
        let Some(entries) = slot.as_mut() else {
            return; // not armed — no rollback tracking for this call
        };
        if entries.iter().any(|e| &e.space_id == space_id) {
            return; // already captured this space's pre-tx frontier
        }
        let Checkpoint { frontier, since } = checkpoint();
        entries.push(RevertEntry {
            space_id: space_id.clone(),
            engine: SharedEngine::clone(engine),
            frontier,
            since,
            dirty: Arc::clone(dirty),
        });
    }

    /// Arm the log for a new in-flight tx. Panics if it was already armed (a
    /// nested write tx would violate the single-in-flight invariant).
    ///
    /// `pub` (not `pub(crate)`) so the app-crate LOCAL command path
    /// (`db::command_tx`) can arm the log directly across the crate boundary
    /// (#2621, wave E1).
    pub fn arm(&self) {
        let mut slot = self.inner.lock();
        assert!(
            slot.is_none(),
            "RevertLog armed while already armed — a nested engine-mutating write \
             tx would break the single-in-flight invariant the un-keyed log relies on"
        );
        *slot = Some(Vec::new());
    }

    /// Lift the recorded checkpoints out of the log, disarming it, for an
    /// explicit commit/abort decision — the direct-`RevertLog` counterpart of
    /// [`RevertScope::detach`] used by the LOCAL command path
    /// (the app-layer `CommandTx`), which arms the log itself rather
    /// than through a `RevertScope`.
    ///
    /// Like [`RevertScope::detach`], MUST be called while the caller's
    /// `BEGIN IMMEDIATE` write lock is still held. If the log was never armed
    /// (a non-engine tx) the returned [`DetachedRevert`] is empty and both
    /// dropping it and calling `revert` are no-ops.
    ///
    /// `pub` (not `pub(crate)`) so the app-crate LOCAL command path
    /// (`db::command_tx`) can lift the checkpoints directly across the crate
    /// boundary (#2621, wave E1).
    pub fn detach(&self) -> DetachedRevert {
        DetachedRevert {
            entries: self.take().unwrap_or_default(),
        }
    }

    /// Take the recorded entries, leaving the log un-armed.
    fn take(&self) -> Option<Vec<RevertEntry>> {
        self.inner.lock().take()
    }
}

/// Rewind every recorded engine to its checkpoint and mark its space dirty.
/// Shared by the two abort paths: [`DetachedRevert::revert`] (commit/apply
/// failure) and [`RevertScope`]'s panic-net `Drop`.
fn revert_entries(entries: Vec<RevertEntry>) {
    // The `O(n)` `fork_at` rewind is paid ONLY here, and only on the exceptional
    // abort. Any handler's engine guard was already dropped (the guard is
    // `!Send` and released per apply), so re-locking — even during a panic
    // unwind, where inner scopes drop before the outer scope — cannot deadlock.
    // Errors can only be logged, not propagated, from these drop/consume paths.
    for entry in entries {
        {
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
        // #6521: a snapshot pass may have exported this engine with the
        // rolled-back writes in it. Marked after the rewind, so whichever
        // stamp that pass captured is the older one: the space stays dirty and
        // the next pass saves the engine as it now is.
        entry.dirty.mark(&entry.space_id);
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
        Self::arm_log(&state.revert)
    }

    /// Arm `log` for a new in-flight tx: the state's shared log, or a log of
    /// the caller's own for engine writes that reach
    /// [`for_space_recording`](crate::loro::registry::LoroEngineRegistry::for_space_recording)
    /// with it directly.
    pub fn arm_log(log: &'a RevertLog) -> Self {
        log.arm();
        Self { log }
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
        self.log.detach()
        // `self` drops here; the log is now un-armed, so `Drop` is a no-op.
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

    /// The Loro update each recorded engine gained since its checkpoint: what
    /// the transaction saves in `loro_doc_delta` before it commits (#6521).
    ///
    /// An engine the transaction read and did not write yields nothing. Nor
    /// does one `registry` no longer holds: the purge of a space evicts its
    /// engine and deletes its saved rows in the same transaction.
    pub(crate) fn deltas(
        &self,
        registry: &crate::loro::registry::LoroEngineRegistry,
    ) -> Result<Vec<(SpaceId, Vec<u8>)>, agaric_core::error::AppError> {
        let mut deltas = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            if !registry.holds(&entry.space_id, &entry.engine) {
                continue;
            }
            let engine = entry.engine.lock();
            if engine.checkpoint_frontiers() == entry.frontier {
                continue;
            }
            deltas.push((
                entry.space_id.clone(),
                engine.export_update_since(&entry.since)?,
            ));
        }
        Ok(deltas)
    }
}

#[cfg(test)]
mod tests {
    use super::RevertLog;

    #[test]
    #[should_panic(expected = "RevertLog armed while already armed")]
    fn arming_an_armed_log_panics() {
        let log = RevertLog::new();
        log.arm();
        log.arm();
    }

    #[test]
    fn detach_disarms_so_the_next_tx_can_arm() {
        let log = RevertLog::new();
        log.arm();
        drop(log.detach());
        log.arm();
    }
}
