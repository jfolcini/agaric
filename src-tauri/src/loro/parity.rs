//! In-memory parity-logging ring buffer for shadow-mode dual-write.
//!
//! Phase 1 day-1 deliverable.  Records the last N parity events
//! (default 1024) so the developer running with
//! `--features loro-shadow` can inspect the diffy-vs-Loro divergence
//! in real time without committing to a database table yet.
//!
//! ## Why in-memory first
//!
//! SPIKE-REPORT.md §6 item 6 — "Either a new SQLite table
//! (`merge_parity_log`) or an in-memory ring buffer flushed
//! periodically".  Day-1 picks the in-memory ring as the cheaper
//! starting point so the apply path has somewhere to write today.
//! The persistent sink (with retention policy, free-text divergence
//! capture, columns aligned to the day-3 bucket A/B/C/D taxonomy)
//! is a later Phase-1 day's deliverable.
//!
//! ## Concurrency
//!
//! `ShadowParitySampler` is `Send + Sync` via an internal `Mutex`.
//! The merge layer's call sites are not on a tight inner loop —
//! one parity event per applied op is the rate, and ops apply at
//! human typing / sync cadence.  A lock-free SPSC ring is overkill;
//! the simple Mutex is enough until benchmarking shows otherwise.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Default ring buffer capacity.  1024 events buffers ~the last
/// 30-60 seconds of typical interactive work; tune as the
/// shadow-mode dual-write rate firms up.
pub const DEFAULT_RING_CAPACITY: usize = 1024;

/// One observation of the diffy-vs-Loro divergence (or agreement)
/// for a single applied op.
#[derive(Debug, Clone)]
pub struct ParityEvent {
    /// Caller-supplied identity for the op being mirrored.  In
    /// production this will be the op_log row's `(device_id, seq)`
    /// composite or the `hash` column; Phase-1 day-1 doesn't
    /// constrain the shape.
    pub op_id: String,
    /// The space ULID this op belongs to — same partition key the
    /// `LoroEngineRegistry` uses to pick the per-space engine.
    /// Day-4 added: lets the persistent sink record the space
    /// without re-resolving the block on flush.
    pub space_id: String,
    /// The diffy op_type (`"create_block"` / `"edit_block"` / …).
    /// Day-4 added: matches the `op_log.op_type` column so the
    /// flushed sink rows can be `GROUP BY op_type` for per-op-type
    /// divergence rates without re-parsing the payload.
    pub op_type: String,
    /// The diffy result, stringified for log readability.  The
    /// authoritative form (full `MergeOutcome`) is captured
    /// elsewhere; this is a compact summary suitable for tail-N
    /// debugging.
    pub diffy_result: String,
    /// The Loro result, stringified the same way as `diffy_result`.
    pub loro_result: String,
    /// Whether the two summaries match.  The semantics of "match"
    /// are caller-defined — for many op types it's a simple string
    /// equality; for `edit_block` it's the post-merge content
    /// equality after canonicalising line endings.
    pub r#match: bool,
    /// Wall-clock timestamp in milliseconds-since-Unix-epoch.
    /// Day-4 changed the unit from seconds to ms so the value
    /// matches `SystemTime::now().duration_since(UNIX_EPOCH).as_millis()`
    /// (what `merge::shadow_apply` already populates) and the
    /// `merge_parity_log.created_at` column convention.
    pub timestamp: i64,
    /// Phase-3 day-9 hard-coded this to `true` (the cutover module
    /// retired alongside the `loro-shadow` feature gate; the engine
    /// is the only path now).  The column survives in the schema for
    /// back-compat with rows written under day-14's runtime flip
    /// (auth = 0 vs 1) so `parity_report` keeps rendering both eras.
    pub loro_authoritative: bool,
}

/// Bounded ring buffer of parity events.
///
/// Push is O(1) amortised (the underlying `VecDeque` reuses its
/// allocation once it reaches capacity).  Recent events are at the
/// back of the deque; calling `snapshot()` returns a `Vec` ordered
/// oldest-first.
pub struct ShadowParitySampler {
    inner: Mutex<RingState>,
    capacity: usize,
}

struct RingState {
    events: VecDeque<ParityEvent>,
    /// Number of events ever pushed (including those evicted).
    /// Useful for "how many ops have we observed total?" without
    /// keeping the full history.
    total_pushed: u64,
    /// Number of `match = false` events seen.  Kept as a running
    /// counter so the divergence rate over the lifetime of the
    /// process is one cheap read away.
    total_diverged: u64,
}

impl ShadowParitySampler {
    /// Construct with the default capacity.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_RING_CAPACITY)
    }

    /// Construct with an explicit capacity.  Capacity must be > 0;
    /// a zero-capacity ring is a no-op surface and would silently
    /// drop every event.
    pub fn with_capacity(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            inner: Mutex::new(RingState {
                events: VecDeque::with_capacity(cap),
                total_pushed: 0,
                total_diverged: 0,
            }),
            capacity: cap,
        }
    }

    /// Record one parity event.  When the ring is full, evicts the
    /// oldest event before pushing the new one.
    ///
    /// Mutex contention: see module docs — one push per applied
    /// op at human typing / sync cadence is well below the rate at
    /// which Mutex acquisition would matter.
    pub fn record(&self, event: ParityEvent) {
        let mut state = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        state.total_pushed = state.total_pushed.saturating_add(1);
        if !event.r#match {
            state.total_diverged = state.total_diverged.saturating_add(1);
        }
        if state.events.len() >= self.capacity {
            state.events.pop_front();
        }
        state.events.push_back(event);
    }

    /// Snapshot the ring's current contents, oldest-first.  Cheap
    /// clone of the underlying `Vec`; safe to call from a debug
    /// command or test harness.
    pub fn snapshot(&self) -> Vec<ParityEvent> {
        let state = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        state.events.iter().cloned().collect()
    }

    /// Drain the ring's current contents, oldest-first, leaving the
    /// ring empty.  Used by the persistent sink (`parity_sink::
    /// flush_to_sqlite`) so events that have been written to SQLite
    /// don't get flushed twice.
    ///
    /// Lifetime counters (`total_pushed`, `total_diverged`) are NOT
    /// reset — they're cumulative since process start, not "since
    /// last drain".  A future "snapshot stats" command exposes them
    /// alongside whatever the ring currently holds.
    pub fn drain(&self) -> Vec<ParityEvent> {
        let mut state = match self.inner.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        let cap = state.events.capacity();
        // `std::mem::take` would replace with `VecDeque::default()`
        // (capacity 0); that costs us the pre-allocated buffer the
        // ring relies on for its O(1) push amortisation.  Construct
        // a fresh `VecDeque` with the same capacity instead.
        let drained = std::mem::replace(&mut state.events, VecDeque::with_capacity(cap));
        drained.into_iter().collect()
    }

    /// Total number of events ever pushed (including evicted ones).
    pub fn total_pushed(&self) -> u64 {
        match self.inner.lock() {
            Ok(g) => g.total_pushed,
            Err(poison) => poison.into_inner().total_pushed,
        }
    }

    /// Total number of `match = false` events ever seen.  Divide by
    /// `total_pushed()` for a lifetime divergence rate.
    pub fn total_diverged(&self) -> u64 {
        match self.inner.lock() {
            Ok(g) => g.total_diverged,
            Err(poison) => poison.into_inner().total_diverged,
        }
    }

    /// Configured ring capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

impl Default for ShadowParitySampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(op_id: &str, m: bool) -> ParityEvent {
        ParityEvent {
            op_id: op_id.into(),
            space_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            op_type: "create_block".into(),
            diffy_result: "diffy".into(),
            loro_result: "loro".into(),
            r#match: m,
            timestamp: 0,
            loro_authoritative: false,
        }
    }

    #[test]
    fn ring_evicts_oldest_when_full() {
        let s = ShadowParitySampler::with_capacity(2);
        s.record(ev("a", true));
        s.record(ev("b", true));
        s.record(ev("c", true));
        let snap = s.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].op_id, "b");
        assert_eq!(snap[1].op_id, "c");
        assert_eq!(s.total_pushed(), 3);
    }

    #[test]
    fn diverged_counter_tracks_match_false_only() {
        let s = ShadowParitySampler::with_capacity(8);
        s.record(ev("a", true));
        s.record(ev("b", false));
        s.record(ev("c", false));
        s.record(ev("d", true));
        assert_eq!(s.total_pushed(), 4);
        assert_eq!(s.total_diverged(), 2);
    }

    #[test]
    fn zero_capacity_clamps_to_one() {
        let s = ShadowParitySampler::with_capacity(0);
        assert_eq!(s.capacity(), 1);
        s.record(ev("a", true));
        s.record(ev("b", true));
        let snap = s.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].op_id, "b");
    }

    /// Day-4: `drain` returns oldest-first and empties the ring while
    /// preserving the lifetime counters.  The persistent sink
    /// (`parity_sink::flush_to_sqlite`) relies on both halves of this
    /// contract — the order so the SQLite rows land in chronological
    /// order, the empty-ring postcondition so events aren't flushed
    /// twice.
    #[test]
    fn drain_returns_oldest_first_and_empties_ring() {
        let s = ShadowParitySampler::with_capacity(8);
        s.record(ev("a", true));
        s.record(ev("b", false));
        s.record(ev("c", true));

        let drained = s.drain();
        assert_eq!(drained.len(), 3);
        assert_eq!(drained[0].op_id, "a");
        assert_eq!(drained[1].op_id, "b");
        assert_eq!(drained[2].op_id, "c");

        // Ring is empty after drain.
        assert!(s.snapshot().is_empty());

        // Lifetime counters are preserved.
        assert_eq!(s.total_pushed(), 3);
        assert_eq!(s.total_diverged(), 1);

        // Subsequent record + drain works against the fresh buffer.
        s.record(ev("d", true));
        let next = s.drain();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].op_id, "d");
    }
}
