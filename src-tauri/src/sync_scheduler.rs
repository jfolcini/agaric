//! Sync scheduling infrastructure.
//!
//! Provides per-peer mutual exclusion, exponential backoff on failure,
//! debounced change notifications, and periodic resync tracking.
//! Designed to be consumed by a future `SyncDaemon` (issue #382).
//!
//! ## dual schedulers, no coordination
//!
//! This is the **authoritative** sync scheduler. It owns:
//! - per-peer mutexes (no concurrent syncs to the same peer),
//! - per-peer exponential backoff `2s → 4s → … → 60s` (see `MIN_BACKOFF`
//!   / `MAX_BACKOFF` below),
//! - jittered retry timing,
//! - silent rejection of redundant `startSync` IPC calls during a
//!   peer's backoff window.
//!
//! The frontend (`src/hooks/useSyncTrigger.ts`) runs its OWN exponential
//! backoff (`60s → 600s`) — a coarse "wake the scheduler" hint at a much
//! slower cadence. The two schedulers do not coordinate: when this scheduler
//! is mid-backoff, the frontend's `startSync()` call resolves with a quick
//! no-op, then the frontend's own backoff doubles. That dual-layer is a
//! deliberate split: this scheduler is best for *per-peer* retry sizing
//! (it knows which peer failed); the frontend trigger is best for *user-
//! observable* cadence (it doesn't matter which peer failed). Do not add
//! cross-layer coordination here without re-reading both files end-to-end
//! and updating this doc + the matching note in `useSyncTrigger.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::peer_refs::PeerRef;

use rand::RngExt;
use tokio::sync::{Mutex, Notify};

// ---------------------------------------------------------------------------
// Per-peer sync mutex (#387)
// ---------------------------------------------------------------------------

/// Guard returned by [`SyncScheduler::try_lock_peer`].  Releases the
/// per-peer mutex on drop.
pub struct PeerSyncGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    pub peer_id: String,
}

/// RAII guard returned by [`SyncScheduler::begin_session_activity`].
///
/// #2537: marks a *committed* sync session (initiator: connection
/// established and `run_sync_session` about to run; responder: identity
/// verified and the per-peer lock held). While at least one guard is
/// alive, [`SyncScheduler::request_cancel`] will latch the shared cancel
/// flag; with none alive it is a no-op — so a cancel issued when nothing
/// is running can never latch the flag and poison future sessions.
///
/// Dropping the guard decrements the live-session count. The session's
/// own cancel-ownership guard (`CancelGuard` in the daemon) is declared
/// *before* this one, so on unwind the activity count drops to zero
/// first and the flag is cleared last — `request_cancel`'s post-store
/// re-check (see there) then closes the set-after-teardown race.
pub struct SessionActivityGuard<'a> {
    scheduler: &'a SyncScheduler,
}

impl Drop for SessionActivityGuard<'_> {
    fn drop(&mut self) {
        self.scheduler
            .active_sessions
            .fetch_sub(1, Ordering::SeqCst);
    }
}

/// Manages per-peer sync locks, backoff state, and scheduling signals.
pub struct SyncScheduler {
    /// One mutex per peer — prevents concurrent syncs to the same device.
    peer_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,

    /// Backoff state per peer.
    backoff: std::sync::Mutex<HashMap<String, BackoffState>>,

    /// Channels for streaming progress to the frontend.
    channels: std::sync::Mutex<
        HashMap<String, tauri::ipc::Channel<crate::sync_events::SyncProgressUpdate>>,
    >,

    /// #2537: number of sync sessions currently *committed to run*
    /// (initiator sessions past connection establishment; responder
    /// sessions past identity checks + peer lock). Incremented by
    /// [`Self::begin_session_activity`], decremented when the returned
    /// guard drops. Read by [`Self::request_cancel`] so a user cancel
    /// only ever latches the shared flag while a session exists to
    /// consume (and reset) it.
    active_sessions: AtomicUsize,

    /// Fires when local changes are detected (debounced).
    change_notify: Notify,

    /// Debounce window for change-triggered sync.
    pub debounce_window: Duration,

    /// Interval for periodic resync.
    pub resync_interval: Duration,
}

#[derive(Debug, Clone)]
struct BackoffState {
    /// When the peer may next be retried.
    next_retry_at: Instant,
    /// Current backoff duration (doubles on each failure).
    backoff: Duration,
    /// Number of consecutive failures.
    consecutive_failures: u32,
}

/// Initial seed for the per-peer backoff state.
///
/// This is **not** the user-observed first-failure wait. The seed
/// is `1s`, but [`SyncScheduler::record_failure`] doubles the stored
/// backoff *before* it computes `next_retry_at`, so the first call after
/// a clean state advances `state.backoff` from `1s` to `2s`. The
/// observable wait sequence on consecutive failures is therefore:
///
/// ```text
/// failure #: 1   2   3   4    5    6+
/// backoff:   2s  4s  8s  16s  32s  60s  (capped at MAX_BACKOFF)
/// ```
///
/// `1s` exists only as the internal seed that produces `2s` on the first
/// doubling — it is never itself written to `next_retry_at`. The floor on
/// the jittered wall-clock retry is also `MIN_BACKOFF` (1s), which keeps
/// the very first jittered retry from dipping below the seed under
/// adverse jitter.
const MIN_BACKOFF: Duration = Duration::from_secs(1);
/// Cap on the per-peer backoff. Once `state.backoff` reaches `60s` it
/// stays there — every further failure schedules another retry roughly
/// 60s out (±10% jitter).
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(3);
const DEFAULT_RESYNC: Duration = Duration::from_secs(60);

impl SyncScheduler {
    /// Create a new scheduler with default debounce (3 s) and resync (60 s) intervals.
    pub fn new() -> Self {
        Self {
            peer_locks: std::sync::Mutex::new(HashMap::new()),
            backoff: std::sync::Mutex::new(HashMap::new()),
            channels: std::sync::Mutex::new(HashMap::new()),
            active_sessions: AtomicUsize::new(0),
            change_notify: Notify::new(),
            debounce_window: DEFAULT_DEBOUNCE,
            resync_interval: DEFAULT_RESYNC,
        }
    }

    /// Create with custom intervals.
    pub fn with_intervals(debounce_window: Duration, resync_interval: Duration) -> Self {
        Self {
            debounce_window,
            resync_interval,
            ..Self::new()
        }
    }

    // -- Per-peer mutex (#387) -----------------------------------------------

    /// Try to acquire the sync lock for `peer_id` without blocking.
    /// Returns `None` if another sync is already in progress for this peer.
    pub fn try_lock_peer(&self, peer_id: &str) -> Option<PeerSyncGuard> {
        let mutex = {
            let mut locks = self
                .peer_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Arc::clone(
                locks
                    .entry(peer_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        match mutex.try_lock_owned() {
            Ok(guard) => Some(PeerSyncGuard {
                _guard: guard,
                peer_id: peer_id.to_string(),
            }),
            Err(_) => None,
        }
    }

    /// Register a channel for streaming progress to the frontend.
    pub fn register_channel(
        &self,
        peer_id: &str,
        channel: tauri::ipc::Channel<crate::sync_events::SyncProgressUpdate>,
    ) {
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(peer_id.to_string(), channel);
    }

    /// Take the registered channel for a peer, if any.
    pub fn take_channel(
        &self,
        peer_id: &str,
    ) -> Option<tauri::ipc::Channel<crate::sync_events::SyncProgressUpdate>> {
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(peer_id)
    }

    // -- Session activity + targeted cancel (#2537) ---------------------------

    /// Mark a sync session as *live* for cancellation purposes.
    ///
    /// #2537: called by the initiator once a connection is established and
    /// it commits to running `run_sync_session` (the same point at which it
    /// takes ownership of the shared cancel flag), and by the responder once
    /// identity checks pass and the per-peer lock is held. The returned
    /// guard decrements the count on drop.
    pub fn begin_session_activity(&self) -> SessionActivityGuard<'_> {
        self.active_sessions.fetch_add(1, Ordering::SeqCst);
        SessionActivityGuard { scheduler: self }
    }

    /// `true` while at least one sync session is committed/running.
    pub fn has_active_session(&self) -> bool {
        self.active_sessions.load(Ordering::SeqCst) > 0
    }

    /// Request cancellation of the currently-active sync session(s).
    ///
    /// #2537: the shared `cancel` flag used to be latched unconditionally.
    /// With no session running, *nothing* ever reset it — the only resetter
    /// was the initiator-side `CancelGuard`, armed only after an outbound
    /// connection established — so a stray cancel poisoned every subsequent
    /// inbound session ("sync cancelled") until an outbound session burned
    /// itself (recorded as a failure, inflating backoff) just to clear it.
    ///
    /// This method targets live sessions only: the flag is stored **iff** a
    /// session is active (per [`Self::begin_session_activity`]); otherwise
    /// the call is a no-op and returns `false`. After storing, the activity
    /// count is re-checked — if the last session tore down concurrently
    /// (its flag-clearing guard may already have run), the store is undone
    /// so the flag cannot latch with no owner left to reset it.
    ///
    /// Returns `true` iff a cancellation was actually signalled.
    pub fn request_cancel(&self, cancel_flag: &AtomicBool) -> bool {
        if !self.has_active_session() {
            return false;
        }
        // `SeqCst` (not `Release`) is load-bearing: with a release store,
        // the re-check load below may execute while this store still sits
        // in the local store buffer (TSO store→load reordering; likewise
        // unordered in the C++ model, where a release store does not join
        // the SC total order). The re-check could then read a stale
        // non-zero count — skipping the un-latch — while the buffered
        // `true` becomes globally visible AFTER the last owner's guard
        // stored `false`, latching the flag with zero sessions left to
        // reset it. SeqCst orders the store before the re-check load, so:
        //   * re-check sees 0  → our own SeqCst `false` below is final;
        //   * re-check sees ≥1 → that owner's activity decrement had not
        //     run at the re-check, so its `CancelGuard`'s SeqCst `false`
        //     (sequenced after the decrement) is ordered after our `true`
        //     in the flag's modification order.
        // Either way the flag cannot outlive its consumers.
        cancel_flag.store(true, Ordering::SeqCst);
        // Close the check→store race: if every session ended between the
        // check above and the store, the owners' reset guards may have
        // already run — un-latch so the flag never outlives its consumers.
        if !self.has_active_session() {
            cancel_flag.store(false, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// Garbage-collect entries from `peer_locks` whose `Arc::strong_count`
    /// is exactly 1, meaning no `PeerSyncGuard` currently holds the lock.
    ///
    /// `peer_locks` grows monotonically in `try_lock_peer` — each new peer
    /// adds one entry, never removed. At realistic single-user single-digit
    /// paired-peer counts this is dust, but bounded growth is the right
    /// invariant for a long-lived background service.
    ///
    /// **Caller responsibility:** invoke this periodically (hourly is more
    /// than sufficient) from the sync daemon's tick loop, or before
    /// allocating a fresh peer lock if the HashMap has crossed a heuristic
    /// size. The scheduler itself does not spawn a background task — it
    /// stays a passive state machine per its existing convention. The
    /// production caller is the daemon resync tick in
    /// [`crate::sync_daemon::session_supervisor`], which runs this on a coarse
    /// (~hourly) cadence (`RESYNC_TICKS_PER_GC`).
    ///
    /// Returns the number of entries removed (0 if everything is in use).
    pub fn gc_unused_peer_locks(&self) -> usize {
        let mut locks = self
            .peer_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = locks.len();
        locks.retain(|_, arc| Arc::strong_count(arc) > 1);
        before - locks.len()
    }

    /// Test-only accessor: number of entries currently in `peer_locks`.
    #[cfg(test)]
    pub(crate) fn peer_locks_len(&self) -> usize {
        self.peer_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    // -- Exponential backoff (#387) ------------------------------------------

    /// Check whether `peer_id` is allowed to retry now.
    pub fn may_retry(&self, peer_id: &str) -> bool {
        let backoff = self
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match backoff.get(peer_id) {
            None => true,
            Some(state) => Instant::now() >= state.next_retry_at,
        }
    }

    /// Record a sync failure for `peer_id`, advancing the backoff one step.
    ///
    /// The stored state and the wall-clock retry deadline are *two
    /// different views* of the backoff and they intentionally diverge:
    ///
    /// - **Internal `state.backoff` (deterministic).** Doubled on every
    ///   call and capped at [`MAX_BACKOFF`]: `1s → 2s → 4s → 8s → 16s →
    ///   32s → 60s → 60s …`. The leading `1s` is the [`MIN_BACKOFF`]
    ///   seed planted by the `or_insert`; it is overwritten by `2s`
    ///   *inside this very call*, so callers never observe `1s` after
    ///   `record_failure` returns. See on [`MIN_BACKOFF`] for the
    ///   user-visible sequence.
    /// - **Wall-clock `state.next_retry_at` (jittered).** Computed as
    ///   `now + state.backoff * jitter` where `jitter ∈ [0.9, 1.1]`,
    ///   floored at [`MIN_BACKOFF`]. The ±10 % spread prevents multiple
    ///   peers that fail in the same instant from all retrying together.
    ///
    /// Telemetry / logs that read `state.backoff` (e.g. `failure_count`
    /// adjacent to the stored duration) see the deterministic ladder —
    /// the actual retry instant floats by ±10 % around that value, so a
    /// peer with `state.backoff = 8s` may retry anywhere in
    /// `[now + 7.2s, now + 8.8s]`.
    pub fn record_failure(&self, peer_id: &str) {
        let mut backoff = self
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = backoff.entry(peer_id.to_string()).or_insert(BackoffState {
            next_retry_at: Instant::now(),
            backoff: MIN_BACKOFF,
            consecutive_failures: 0,
        });
        state.consecutive_failures += 1;
        // Doubling happens *before* we write `next_retry_at`, so the
        // first call doubles the `MIN_BACKOFF` seed `1s → 2s`. The sequence
        // an external observer sees is therefore 2, 4, 8, 16, 32, 60s — the
        // raw `1s` seed is never the value of a scheduled retry.
        let base = (state.backoff * 2).min(MAX_BACKOFF);
        // ±10 % jitter to spread out simultaneous retries across devices.
        let jitter = rand::rng().random_range(0.9..=1.1);
        let jittered_secs = (base.as_secs_f64() * jitter).max(MIN_BACKOFF.as_secs_f64());
        state.backoff = base; // store the deterministic base for the next doubling
        state.next_retry_at = Instant::now() + Duration::from_secs_f64(jittered_secs);
    }

    /// Record a successful sync, resetting the backoff for `peer_id`.
    pub fn record_success(&self, peer_id: &str) {
        let mut backoff = self
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backoff.remove(peer_id);
    }

    /// Return the current consecutive failure count for a peer (0 if none).
    pub fn failure_count(&self, peer_id: &str) -> u32 {
        let backoff = self
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backoff.get(peer_id).map_or(0, |s| s.consecutive_failures)
    }

    /// Return `(peer_id, consecutive_failures)` pairs for every peer the
    /// scheduler has seen fail at least once. Returns an empty vector when
    /// no peers are in backoff. Used by the materializer status snapshot
    /// To surface sync health without coupling the scheduler
    /// struct into `Materializer`.
    pub fn failure_counts(&self) -> Vec<(String, u32)> {
        let backoff = self
            .backoff
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        backoff
            .iter()
            .filter(|(_, s)| s.consecutive_failures > 0)
            .map(|(id, s)| (id.clone(), s.consecutive_failures))
            .collect()
    }

    // -- Change-triggered debounce (#384) ------------------------------------

    /// Signal that a local change occurred.  Callers (e.g. the materializer
    /// or command handlers) invoke this after writing ops.
    pub fn notify_change(&self) {
        self.change_notify.notify_one();
    }

    /// Wait for a debounced change signal.  Returns after `debounce_window`
    /// of inactivity following at least one `notify_change()` call.
    pub async fn wait_for_debounced_change(&self) {
        // Wait for the first notification.
        self.change_notify.notified().await;
        // Then keep waiting while notifications keep coming within the window.
        loop {
            tokio::select! {
                () = self.change_notify.notified() => {
                    // Another change arrived — restart the window.
                    continue;
                }
                () = tokio::time::sleep(self.debounce_window) => {
                    // Quiet period elapsed — debounce complete.
                    break;
                }
            }
        }
    }

    // -- Periodic resync (#385) -----------------------------------------------

    /// Given a slice of [`PeerRef`] rows, return the peer IDs that are
    /// overdue for a resync (`synced_at` is `None` or older than
    /// `resync_interval`).
    ///
    /// This used to take `&[(String, Option<String>)]`, which
    /// forced Branch C of the daemon loop to clone every paired peer's
    /// `peer_id` and `synced_at` on every 30 s tick just to build the
    /// tuple form. Borrowing the rows directly avoids that round-trip;
    /// we still allocate one `String` per overdue peer in the result
    /// (the daemon needs an owned id), but no per-tick clone of
    /// up-to-date peers.
    pub fn peers_due_for_resync(&self, peers: &[PeerRef]) -> Vec<String> {
        // #109 Phase 2: `synced_at` is now epoch-ms, so the staleness check is
        // plain integer subtraction against the current instant (was an
        // RFC 3339 parse + `chrono::Duration` diff).
        let now_ms = crate::db::now_ms();
        let interval_ms = i64::try_from(self.resync_interval.as_millis()).unwrap_or(i64::MAX);

        peers
            .iter()
            .filter(|p| {
                // Skip peers in backoff
                if !self.may_retry(&p.peer_id) {
                    return false;
                }
                match p.synced_at {
                    None => true,
                    Some(synced_ms) => now_ms - synced_ms > interval_ms,
                }
            })
            .map(|p| p.peer_id.clone())
            .collect()
    }
}

impl Default for SyncScheduler {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_lock_peer_succeeds_first_time() {
        let sched = SyncScheduler::new();
        let guard = sched.try_lock_peer("peer-a");
        assert!(guard.is_some());
        assert_eq!(guard.unwrap().peer_id, "peer-a");
    }

    #[test]
    fn try_lock_peer_fails_when_already_held() {
        let sched = SyncScheduler::new();
        let _held = sched.try_lock_peer("peer-a").unwrap();
        assert!(sched.try_lock_peer("peer-a").is_none());
    }

    #[test]
    fn try_lock_different_peers_independent() {
        let sched = SyncScheduler::new();
        let _a = sched.try_lock_peer("peer-a").unwrap();
        let b = sched.try_lock_peer("peer-b");
        assert!(b.is_some());
    }

    #[test]
    fn lock_released_on_drop() {
        let sched = SyncScheduler::new();
        {
            let _g = sched.try_lock_peer("peer-a").unwrap();
        }
        // Should be available again after drop
        assert!(sched.try_lock_peer("peer-a").is_some());
    }

    // -- gc_unused_peer_locks --------------------------------------

    #[test]
    fn gc_unused_peer_locks_removes_idle_entries() {
        let sched = SyncScheduler::new();
        // Acquire then immediately drop the guard so the HashMap holds the
        // sole strong reference to the Arc.
        {
            let _g = sched.try_lock_peer("p1").unwrap();
        }
        assert_eq!(
            sched.peer_locks_len(),
            1,
            "peer_locks should have 1 entry after try_lock_peer"
        );
        let removed = sched.gc_unused_peer_locks();
        assert_eq!(removed, 1, "GC should remove the idle entry");
        assert_eq!(
            sched.peer_locks_len(),
            0,
            "peer_locks should be empty after GC"
        );
    }

    #[test]
    fn gc_unused_peer_locks_keeps_held_entries() {
        let sched = SyncScheduler::new();
        let guard = sched.try_lock_peer("p1").unwrap();
        // The guard holds a clone of the Arc → strong_count == 2 → keep.
        let removed = sched.gc_unused_peer_locks();
        assert_eq!(
            removed, 0,
            "GC should not remove an entry with a live guard"
        );
        assert_eq!(sched.peer_locks_len(), 1, "entry must still be present");
        // Drop the guard and GC again — now it's idle.
        drop(guard);
        let removed = sched.gc_unused_peer_locks();
        assert_eq!(
            removed, 1,
            "GC should remove the entry once the guard is dropped"
        );
        assert_eq!(sched.peer_locks_len(), 0);
    }

    #[test]
    fn gc_unused_peer_locks_handles_empty_map() {
        let sched = SyncScheduler::new();
        let removed = sched.gc_unused_peer_locks();
        assert_eq!(removed, 0, "empty map GC should return 0");
        assert_eq!(sched.peer_locks_len(), 0);
    }

    #[test]
    fn backoff_starts_at_zero() {
        let sched = SyncScheduler::new();
        assert!(sched.may_retry("peer-a"));
        assert_eq!(sched.failure_count("peer-a"), 0);
    }

    #[test]
    fn record_failure_blocks_immediate_retry() {
        let sched = SyncScheduler::new();
        sched.record_failure("peer-a");
        assert!(!sched.may_retry("peer-a"));
        assert_eq!(sched.failure_count("peer-a"), 1);
    }

    #[test]
    fn record_success_resets_backoff() {
        let sched = SyncScheduler::new();
        sched.record_failure("peer-a");
        sched.record_failure("peer-a");
        assert_eq!(sched.failure_count("peer-a"), 2);
        sched.record_success("peer-a");
        assert!(sched.may_retry("peer-a"));
        assert_eq!(sched.failure_count("peer-a"), 0);
    }

    /// Pin the documented intent — the first `record_failure` call
    /// doubles the `MIN_BACKOFF` seed `1s → 2s`, so the user-observable
    /// first wait is `2s`, not `1s`. The doc-comments on `MIN_BACKOFF` and
    /// `record_failure` describe the `2,4,8,16,32,60` sequence; this test
    /// guards the very first step of that sequence so a future refactor
    /// that "fixes" the apparent off-by-one (e.g. inserting `MIN_BACKOFF`
    /// directly into `next_retry_at` on the first call) would have to
    /// also update the docs.
    #[test]
    fn min_backoff_seed_doubles_to_two_seconds_on_first_failure() {
        let sched = SyncScheduler::new();
        sched.record_failure("peer-a");
        let backoff = sched.backoff.lock().unwrap();
        let state = backoff.get("peer-a").unwrap();
        assert_eq!(
            state.backoff,
            Duration::from_secs(2),
            "first record_failure must double the 1s MIN_BACKOFF seed to 2s"
        );
        assert_eq!(state.consecutive_failures, 1);
    }

    #[test]
    fn backoff_doubles_on_consecutive_failures() {
        let sched = SyncScheduler::new();
        sched.record_failure("peer-a");
        sched.record_failure("peer-a");
        sched.record_failure("peer-a");
        assert_eq!(sched.failure_count("peer-a"), 3);
        // Seed 1s -> 2s -> 4s -> 8s after 3 failures (the 1s seed
        // is never observable; observers see the 2,4,8,... ladder).
        let backoff = sched.backoff.lock().unwrap();
        let state = backoff.get("peer-a").unwrap();
        assert_eq!(state.backoff, Duration::from_secs(8)); // 1*2=2, 2*2=4, 4*2=8
    }

    #[test]
    fn backoff_caps_at_max() {
        let sched = SyncScheduler::new();
        for _ in 0..20 {
            sched.record_failure("peer-a");
        }
        let backoff = sched.backoff.lock().unwrap();
        let state = backoff.get("peer-a").unwrap();
        assert!(state.backoff <= MAX_BACKOFF);
    }

    #[test]
    fn backoff_jitter_stays_within_ten_percent() {
        // Run many iterations to exercise the random jitter range.
        // For a base backoff of 10 s the jittered next_retry_at should
        // always fall within [9 s, 11 s] of `now`.
        let sched = SyncScheduler::new();
        for _ in 0..200 {
            sched.record_success("jitter-peer"); // reset each iteration

            // Drive the deterministic base to exactly 8 s (1→2→4→8)
            // so the *next* record_failure doubles it to 16 s.
            // We can instead just use a single failure: base goes 1→2.
            // Let's drive to a rounder number for clarity:
            //   fail 1: base = 2 s
            //   fail 2: base = 4 s
            //   fail 3: base = 8 s
            //   fail 4: base = 16 s
            for _ in 0..3 {
                sched.record_failure("jitter-peer");
            }
            // After 3 failures the deterministic base is 8 s.
            // The 4th failure will double to 16 s and apply jitter.
            let before = Instant::now();
            sched.record_failure("jitter-peer");
            let after = Instant::now();

            let state = sched.backoff.lock().unwrap();
            let s = state.get("jitter-peer").unwrap();
            let retry_at = s.next_retry_at;
            drop(state);

            // Expected base = 16 s, jitter ∈ [0.9, 1.1] → [14.4 s, 17.6 s]
            let lo = before + Duration::from_secs_f64(16.0 * 0.9 - 0.05);
            let hi = after + Duration::from_secs_f64(16.0 * 1.1 + 0.05);
            assert!(
                retry_at >= lo && retry_at <= hi,
                "jittered retry_at should be within ±10 %% of 16 s base"
            );
        }
    }

    #[tokio::test]
    async fn debounce_fires_after_quiet_period() {
        let sched = Arc::new(SyncScheduler::with_intervals(
            Duration::from_millis(50),
            DEFAULT_RESYNC,
        ));
        let sched2 = Arc::clone(&sched);

        // Notify from a spawned task
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            sched2.notify_change();
        });

        // Should complete within debounce_window + some margin
        let result = tokio::time::timeout(
            Duration::from_millis(200),
            sched.wait_for_debounced_change(),
        )
        .await;
        assert!(result.is_ok());
    }

    /// Test helper: build a `PeerRef` with only the two fields
    /// `peers_due_for_resync` reads (`peer_id`, `synced_at`); the rest
    /// default to None / 0. Keeps the resync tests as terse as the
    /// pre-L-76 tuple form they replaced.
    fn pr(peer_id: &str, synced_at: Option<i64>) -> PeerRef {
        PeerRef {
            peer_id: peer_id.to_string(),
            last_hash: None,
            last_sent_hash: None,
            synced_at,
            reset_count: 0,
            last_reset_at: None,
            cert_hash: None,
            device_name: None,
            last_address: None,
        }
    }

    #[test]
    fn peers_due_for_resync_none_synced() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let peers = vec![pr("peer-a", None), pr("peer-b", None)];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due.len(), 2);
    }

    #[test]
    fn peers_due_for_resync_recent_excluded() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let recent = crate::db::now_ms();
        let peers = vec![pr("peer-a", Some(recent)), pr("peer-b", None)];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due, vec!["peer-b".to_string()]);
    }

    #[test]
    fn peers_due_for_resync_old_included() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let old = crate::db::now_ms() - 120_000;
        let peers = vec![pr("peer-a", Some(old))];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due, vec!["peer-a".to_string()]);
    }

    #[test]
    fn peers_due_for_resync_skips_backed_off() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        sched.record_failure("peer-a");
        let peers = vec![pr("peer-a", None)];
        let due = sched.peers_due_for_resync(&peers);
        assert!(due.is_empty());
    }

    // ======================================================================
    // #458 — sync_scheduler edge cases
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn debounce_rapid_notifications_collapse_to_one() {
        let sched =
            SyncScheduler::with_intervals(Duration::from_millis(50), Duration::from_secs(60));
        let sched = Arc::new(sched);
        let s = sched.clone();

        let handle = tokio::spawn(async move {
            let start = Instant::now();
            s.wait_for_debounced_change().await;
            start.elapsed()
        });

        // Give the spawned task time to start waiting
        tokio::time::sleep(Duration::from_millis(10)).await;

        // Fire 15 rapid notifications within 30ms
        for _ in 0..15 {
            sched.notify_change();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        let elapsed = handle.await.unwrap();
        // Should complete ~50ms after the LAST notification (debounce resets each time)
        assert!(
            elapsed >= Duration::from_millis(50),
            "debounce should wait at least the full window after last notification, got {elapsed:?}"
        );
        // And not too much longer (allow generous margin for CI)
        assert!(
            elapsed < Duration::from_millis(200),
            "debounce should complete within reasonable time, got {elapsed:?}"
        );
    }

    #[test]
    fn peers_due_for_resync_empty_list() {
        let sched = SyncScheduler::new();
        let result = sched.peers_due_for_resync(&[]);
        assert!(
            result.is_empty(),
            "empty peer list should return empty result"
        );
    }

    #[test]
    fn peers_due_for_resync_epoch_zero_is_overdue() {
        // #109 Phase 2: `synced_at` is now epoch-ms, so there is no
        // "unparseable" case; the analogous edge is an ancient timestamp.
        // Epoch 0 (1970) is far older than any resync interval → overdue.
        let sched = SyncScheduler::with_intervals(Duration::from_secs(3), Duration::from_secs(60));
        let peers = vec![pr("PEER_OLD", Some(0))];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due, vec!["PEER_OLD"], "epoch-0 timestamp should be overdue");
    }

    #[test]
    fn peers_due_for_resync_future_timestamp() {
        let sched = SyncScheduler::with_intervals(Duration::from_secs(3), Duration::from_secs(60));
        let future = crate::db::now_ms() + 3_600_000; // +1h
        let peers = vec![pr("PEER_FUTURE", Some(future))];
        let due = sched.peers_due_for_resync(&peers);
        assert!(
            due.is_empty(),
            "future timestamp should NOT be due for resync (now - future is negative)"
        );
    }

    #[test]
    fn peers_due_for_resync_all_backed_off_returns_empty() {
        let sched = SyncScheduler::with_intervals(Duration::from_secs(3), Duration::from_secs(60));
        // Put both peers in backoff
        sched.record_failure("P1");
        sched.record_failure("P2");
        let peers = vec![pr("P1", None), pr("P2", None)];
        let due = sched.peers_due_for_resync(&peers);
        assert!(
            due.is_empty(),
            "all peers in backoff should result in empty resync list"
        );
    }

    // ── Phase 1 — channel registration / handoff ───────────────────────
    //
    // The scheduler holds the per-peer `Channel<SyncProgressUpdate>` set up by
    // `start_sync` so the daemon's `try_sync_with_peer` can hand it off to the
    // orchestrator's event sink. These tests pin the in/out semantics so a
    // future change to the storage shape (e.g. supporting multiple concurrent
    // observers per peer, or moving to a tokio channel) is a deliberate
    // breaking decision.

    fn dummy_channel() -> tauri::ipc::Channel<crate::sync_events::SyncProgressUpdate> {
        // Channel::new requires a callback, but the tests below only exercise
        // register/take — the callback never runs because nothing ever calls
        // `channel.send`. A no-op closure is enough.
        tauri::ipc::Channel::<crate::sync_events::SyncProgressUpdate>::new(|_| Ok(()))
    }

    #[test]
    fn register_then_take_channel_returns_some() {
        let sched = SyncScheduler::new();
        sched.register_channel("PEER1", dummy_channel());
        assert!(
            sched.take_channel("PEER1").is_some(),
            "registered channel must be retrievable"
        );
    }

    #[test]
    fn take_channel_consumes_the_entry() {
        // Take is a one-shot — the orchestrator owns the channel after
        // handoff, so a second take returns None.
        let sched = SyncScheduler::new();
        sched.register_channel("PEER1", dummy_channel());
        assert!(sched.take_channel("PEER1").is_some());
        assert!(
            sched.take_channel("PEER1").is_none(),
            "second take must be empty"
        );
    }

    #[test]
    fn take_channel_for_unknown_peer_returns_none() {
        let sched = SyncScheduler::new();
        assert!(sched.take_channel("PEER_UNKNOWN").is_none());
    }

    #[test]
    fn registering_replaces_prior_channel_for_same_peer() {
        // A second start_sync on the same peer (e.g. user clicks Sync Now
        // twice in quick succession) must not leak the first channel — the
        // newer one wins. Semantics chosen because two concurrent
        // try_lock_peer calls are mutually exclusive, so only one
        // registration is "live" at a time anyway.
        let sched = SyncScheduler::new();
        sched.register_channel("PEER1", dummy_channel());
        sched.register_channel("PEER1", dummy_channel());
        assert!(sched.take_channel("PEER1").is_some());
        assert!(sched.take_channel("PEER1").is_none());
    }

    /// #2537 teardown-race stress: `request_cancel` racing the last owning
    /// session's teardown must never leave the flag latched once the system
    /// is quiescent (no live sessions).
    ///
    /// Reproduces the schedule the SeqCst orderings in `request_cancel` /
    /// the daemon's `CancelGuard` close: canceller checks the count (≥1),
    /// stores `true`; the session concurrently drops its activity guard
    /// (count → 0) then clears the flag on its owning-guard Drop; the
    /// canceller's re-check must either observe the drained count and
    /// un-latch, or the owner's `false` must be ordered after the
    /// canceller's `true`. With `Release` flag stores (store→load
    /// reordering past the re-check), the buffered `true` could land after
    /// the owner's `false` — latching an ownerless flag. This hammers the
    /// window from two threads and asserts the invariant at every
    /// quiescent point.
    #[test]
    fn request_cancel_racing_session_teardown_never_latches_ownerless_flag() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let sched = std::sync::Arc::new(SyncScheduler::new());
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));

        const ROUNDS: usize = 20_000;

        // Session thread: begin activity, then immediately tear down in the
        // production drop order — activity guard first (count → 0), owning
        // cancel-clear second (mirrors `SessionActivityGuard` being declared
        // after `CancelGuard`, so it drops first).
        let session = {
            let sched = sched.clone();
            let flag = flag.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for _ in 0..ROUNDS {
                    let activity = sched.begin_session_activity();
                    drop(activity); // count → 0
                    flag.store(false, Ordering::SeqCst); // owning guard's clear
                }
            })
        };

        // Canceller thread: fire cancels into the churn.
        let canceller = {
            let sched = sched.clone();
            let flag = flag.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for _ in 0..ROUNDS {
                    sched.request_cancel(&flag);
                    std::hint::spin_loop();
                }
            })
        };

        session.join().unwrap();
        canceller.join().unwrap();

        // Quiescent: no live session may exist and the flag must not have
        // latched — there is no owner left to ever reset it.
        assert!(
            !sched.has_active_session(),
            "activity count must drain to zero"
        );
        assert!(
            !flag.load(Ordering::SeqCst),
            "#2537: a cancel racing the last session's teardown must never \
             leave the shared flag latched with no owner left to reset it"
        );
    }
}
