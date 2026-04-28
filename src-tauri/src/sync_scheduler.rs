//! Sync scheduling infrastructure.
//!
//! Provides per-peer mutual exclusion, exponential backoff on failure,
//! debounced change notifications, and periodic resync tracking.
//! Designed to be consumed by a future `SyncDaemon` (REVIEW-LATER #382).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// Manages per-peer sync locks, backoff state, and scheduling signals.
pub struct SyncScheduler {
    /// One mutex per peer — prevents concurrent syncs to the same device.
    peer_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,

    /// Backoff state per peer.
    backoff: std::sync::Mutex<HashMap<String, BackoffState>>,

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
/// L-58: this is **not** the user-observed first-failure wait. The seed
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

    /// L-56: Garbage-collect entries from `peer_locks` whose `Arc::strong_count`
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
    /// stays a passive state machine per its existing convention.
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
    /// L-57: the stored state and the wall-clock retry deadline are *two
    /// different views* of the backoff and they intentionally diverge:
    ///
    /// - **Internal `state.backoff` (deterministic).** Doubled on every
    ///   call and capped at [`MAX_BACKOFF`]: `1s → 2s → 4s → 8s → 16s →
    ///   32s → 60s → 60s …`. The leading `1s` is the [`MIN_BACKOFF`]
    ///   seed planted by the `or_insert`; it is overwritten by `2s`
    ///   *inside this very call*, so callers never observe `1s` after
    ///   `record_failure` returns. See L-58 on [`MIN_BACKOFF`] for the
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
        // L-58: doubling happens *before* we write `next_retry_at`, so the
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
    /// (MAINT-24) to surface sync health without coupling the scheduler
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
                _ = self.change_notify.notified() => {
                    // Another change arrived — restart the window.
                    continue;
                }
                _ = tokio::time::sleep(self.debounce_window) => {
                    // Quiet period elapsed — debounce complete.
                    break;
                }
            }
        }
    }

    // -- Periodic resync (#385) -----------------------------------------------

    /// Given a list of `(peer_id, last_synced_at)` pairs where timestamps
    /// are RFC 3339, return the peer IDs that are overdue for a resync
    /// (synced_at is None or older than `resync_interval`).
    pub fn peers_due_for_resync(&self, peers: &[(String, Option<String>)]) -> Vec<String> {
        let now = chrono::Utc::now();
        let interval = chrono::Duration::from_std(self.resync_interval)
            .unwrap_or(chrono::Duration::seconds(60));

        peers
            .iter()
            .filter(|(peer_id, synced_at)| {
                // Skip peers in backoff
                if !self.may_retry(peer_id) {
                    return false;
                }
                match synced_at {
                    None => true,
                    Some(ts) => {
                        chrono::DateTime::parse_from_rfc3339(ts)
                            .map(|dt| now - dt.with_timezone(&chrono::Utc) > interval)
                            .unwrap_or(true) // unparseable timestamp → resync
                    }
                }
            })
            .map(|(id, _)| id.clone())
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

    // -- L-56: gc_unused_peer_locks --------------------------------------

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

    /// L-58: pin the documented intent — the first `record_failure` call
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
        // L-58: seed 1s -> 2s -> 4s -> 8s after 3 failures (the 1s seed
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

    #[test]
    fn peers_due_for_resync_none_synced() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let peers = vec![("peer-a".to_string(), None), ("peer-b".to_string(), None)];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due.len(), 2);
    }

    #[test]
    fn peers_due_for_resync_recent_excluded() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let recent = chrono::Utc::now().to_rfc3339();
        let peers = vec![
            ("peer-a".to_string(), Some(recent)),
            ("peer-b".to_string(), None),
        ];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due, vec!["peer-b".to_string()]);
    }

    #[test]
    fn peers_due_for_resync_old_included() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        let old = (chrono::Utc::now() - chrono::Duration::seconds(120)).to_rfc3339();
        let peers = vec![("peer-a".to_string(), Some(old))];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(due, vec!["peer-a".to_string()]);
    }

    #[test]
    fn peers_due_for_resync_skips_backed_off() {
        let sched = SyncScheduler::with_intervals(DEFAULT_DEBOUNCE, Duration::from_secs(60));
        sched.record_failure("peer-a");
        let peers = vec![("peer-a".to_string(), None)];
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
            "debounce should wait at least the full window after last notification, got {:?}",
            elapsed
        );
        // And not too much longer (allow generous margin for CI)
        assert!(
            elapsed < Duration::from_millis(200),
            "debounce should complete within reasonable time, got {:?}",
            elapsed
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
    fn peers_due_for_resync_unparseable_timestamp() {
        let sched = SyncScheduler::with_intervals(Duration::from_secs(3), Duration::from_secs(60));
        let peers = vec![("PEER_BAD".to_string(), Some("not-a-date".to_string()))];
        let due = sched.peers_due_for_resync(&peers);
        assert_eq!(
            due,
            vec!["PEER_BAD"],
            "unparseable timestamp should be treated as overdue"
        );
    }

    #[test]
    fn peers_due_for_resync_future_timestamp() {
        let sched = SyncScheduler::with_intervals(Duration::from_secs(3), Duration::from_secs(60));
        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let peers = vec![("PEER_FUTURE".to_string(), Some(future))];
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
        let peers = vec![("P1".to_string(), None), ("P2".to_string(), None)];
        let due = sched.peers_due_for_resync(&peers);
        assert!(
            due.is_empty(),
            "all peers in backoff should result in empty resync list"
        );
    }
}
