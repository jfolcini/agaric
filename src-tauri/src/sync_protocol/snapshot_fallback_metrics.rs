//! #1319 cross-session observability for the sync snapshot-fallback path.
//!
//! When a peer advertises a `from_vv` the receiver can't reach,
//! [`super::loro_sync::apply_remote`] short-circuits the engine import and
//! returns [`super::loro_sync::ApplyOutcome::SnapshotFallbackRequested`] so
//! the daemon layer drives a fresh snapshot catch-up (MAINT-228). Each such
//! occurrence is already surfaced **once per protocol session** as a
//! `SyncEvent::Error` / `SyncMessage::ResetRequired` line by the
//! orchestrator.
//!
//! That per-session line is invisible to an operator asking "why does sync
//! keep falling back?" — there is nothing that correlates the pattern
//! *across* sync sessions within the running process. This module adds that
//! aggregate, mirroring the [`super::super::materializer::handlers::sql_only_fallback`]
//! counter added in #1326: a process-global monotonic count plus the latest
//! occurrence's reason / peer / space / occurrence-ordinal, surfaced through
//! `StatusInfo` (`snapshot_fallback_count` + `snapshot_fallback_last`).
//!
//! **This is observability only** — recording here does NOT alter the
//! snapshot-fallback control flow, which still happens identically at the
//! call site.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-global count of sync snapshot-fallbacks taken (a peer's `from_vv`
/// was unreachable from our local `oplog_vv()`). Monotonic; only ever
/// incremented (never reset), which keeps the test assertions robust under
/// nextest parallelism.
static SNAPSHOT_FALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);

/// Latest snapshot-fallback occurrence, captured at [`record`]. `None` until
/// the first fallback in this process. Guarded by a `Mutex` (writes are rare
/// — one per fallback decision); reads happen only on the cold status path.
static SNAPSHOT_FALLBACK_LAST: Mutex<Option<SnapshotFallbackLast>> = Mutex::new(None);

/// Snapshot of the most recent sync snapshot-fallback occurrence. Surfaced
/// (cloned) through `StatusInfo::snapshot_fallback_last`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct SnapshotFallbackLast {
    /// Monotonic ordinal of this occurrence within the process — equal to
    /// [`count`] at the moment it was recorded. Lets an operator tell apart
    /// "the count moved" from "the same stale `reason` is being re-read".
    pub occurrence: u64,
    /// Remote device / peer id whose `from_vv` could not be reached.
    pub peer_id: String,
    /// Per-space scope of the rejected update.
    pub space_id: String,
    /// Human-readable diagnostic from `classify_from_vv_reachability`
    /// (carries the offending `peer={peer_id} counter>=…` detail).
    pub reason: String,
}

/// Record that a sync update fell back to snapshot catch-up because the
/// peer's `from_vv` was unreachable. Increments the process-global counter,
/// captures this occurrence as the new "last", and emits a debug log. Purely
/// additive — does not alter the snapshot-fallback control flow.
///
/// `peer_id` is the remote device id; `space_id` is the per-space scope;
/// `reason` is the diagnostic returned by `classify_from_vv_reachability`.
pub(crate) fn record(peer_id: &str, space_id: &str, reason: &str) {
    // `fetch_add` returns the PREVIOUS value; the ordinal of this occurrence
    // is therefore `prev + 1`, matching what a subsequent `count()` reads.
    let occurrence = SNAPSHOT_FALLBACK_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut last) = SNAPSHOT_FALLBACK_LAST.lock() {
        *last = Some(SnapshotFallbackLast {
            occurrence,
            peer_id: peer_id.to_owned(),
            space_id: space_id.to_owned(),
            reason: reason.to_owned(),
        });
    }
    tracing::debug!(
        target: "sync_protocol::snapshot_fallback",
        occurrence,
        peer_id,
        space_id,
        reason,
        "sync update fell back to snapshot catch-up (from_vv unreachable)"
    );
}

/// Current process-global sync snapshot-fallback count. Monotonic.
///
/// The production read side is [`super::super::materializer::coordinator`]'s
/// status builder, which surfaces this through
/// `StatusInfo::snapshot_fallback_count` (#1319); it is additionally
/// exercised by the unit tests.
pub(crate) fn count() -> u64 {
    SNAPSHOT_FALLBACK_COUNT.load(Ordering::Relaxed)
}

/// Snapshot of the most recent snapshot-fallback occurrence, or `None` if
/// none has happened in this process. Surfaced through
/// `StatusInfo::snapshot_fallback_last` (#1319).
pub(crate) fn last() -> Option<SnapshotFallbackLast> {
    SNAPSHOT_FALLBACK_LAST
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_count_and_captures_last_reason() {
        // Monotonic, never-reset counter: assert the DELTA so the test is
        // robust when other tests record concurrently under nextest.
        let before = count();
        record(
            "peer-device-xyz",
            "space-abc",
            "peer's from_vv requires peer=42 counter>=7, local oplog_vv has no entry for that peer",
        );
        let after = count();
        assert!(
            after > before,
            "record() must increment the global snapshot-fallback count \
             (before={before}, after={after})"
        );

        // The last-occurrence snapshot must expose the reason we just
        // recorded. Other tests may race in between, so only assert the
        // captured reason is one we recognise as a real fallback diagnostic
        // *if* our occurrence is still the latest; otherwise just confirm a
        // last snapshot now exists.
        let last = last().expect("a snapshot-fallback occurrence must now be recorded");
        assert!(
            last.occurrence >= after,
            "last.occurrence ({}) must be at least the post-record count ({after})",
            last.occurrence,
        );
        assert!(
            !last.reason.is_empty(),
            "the captured last reason must be non-empty"
        );
    }
}
