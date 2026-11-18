//! #6545 — what local commits changed since the app last told the frontend.
//!
//! Every local commit records its ops here through
//! [`Materializer::dispatch_commit`](super::Materializer::dispatch_commit).
//! One task in the app crate waits on
//! [`ChangeFeed::changed`], lets the background queue settle, takes what is
//! pending and emits it as one `blocks:changed` event, so a view that refetches
//! on the event reads caches the write has already rebuilt.
//!
//! The pending set holds notices, not [`MaterializeTask`](super::MaterializeTask)s:
//! nothing here is run, retried or persisted.

use std::collections::BTreeSet;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tokio::sync::Notify;

/// The frontend's cache groups (`src/hooks/derived-caches.ts`) a local write
/// can stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ChangeDomain {
    /// Links, the graph, the Pages list, the block tree.
    Structure,
    /// Task state, dates, property values.
    Properties,
    /// Property definitions.
    PropertyDefs,
    /// Page and tag names and aliases.
    Names,
    /// Attachment lists and badges.
    Attachments,
}

/// What [`ChangeFeed::take_if_quiet`] hands over.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PendingChanges {
    pub domains: BTreeSet<ChangeDomain>,
    pub block_ids: BTreeSet<String>,
}

impl PendingChanges {
    pub fn is_empty(&self) -> bool {
        self.domains.is_empty() && self.block_ids.is_empty()
    }
}

#[derive(Default)]
struct State {
    /// Calls to [`ChangeFeed::record`] so far.
    writes: u64,
    pending: PendingChanges,
    /// Changes [`ChangeFeed::take_if_quiet`] handed over that
    /// [`ChangeFeed::emitted`] has not yet confirmed sent; only the headless
    /// bridge's `settle` reads it.
    #[cfg(any(test, feature = "test-util"))]
    in_flight: bool,
}

#[derive(Default)]
pub struct ChangeFeed {
    state: Mutex<State>,
    notify: Notify,
}

impl ChangeFeed {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Add one commit's ops, each as its domains and its block id, and wake
    /// the emitting task. A commit of no ops records nothing.
    pub(super) fn record<'a>(
        &self,
        ops: impl IntoIterator<Item = (&'static [ChangeDomain], Option<&'a str>)>,
    ) {
        let mut ops = ops.into_iter().peekable();
        if ops.peek().is_none() {
            return;
        }
        let mut state = self.state();
        state.writes += 1;
        for (domains, block_id) in ops {
            state.pending.domains.extend(domains);
            if let Some(block_id) = block_id {
                state.pending.block_ids.insert(block_id.to_owned());
            }
        }
        drop(state);
        self.notify.notify_one();
    }

    /// Wake the emitting task with nothing new recorded: the lifecycle
    /// rebuild it was holding an event for has fired.
    pub(super) fn wake(&self) {
        self.notify.notify_one();
    }

    /// Resolves once a commit has been recorded since the last time this
    /// resolved, including one recorded before the call.
    pub async fn changed(&self) {
        self.notify.notified().await;
    }

    /// The count to hand [`Self::take_if_quiet`], read before the settle.
    pub fn writes(&self) -> u64 {
        self.state().writes
    }

    /// Everything pending, cleared, unless a commit was recorded since `seen`
    /// was read: that commit may have enqueued its rebuilds behind the settle
    /// that just finished, and its event must follow them.
    pub fn take_if_quiet(&self, seen: u64) -> Option<PendingChanges> {
        let mut state = self.state();
        if state.writes != seen {
            return None;
        }
        let taken = std::mem::take(&mut state.pending);
        #[cfg(any(test, feature = "test-util"))]
        {
            state.in_flight = !taken.is_empty();
        }
        Some(taken)
    }

    /// The changes last taken have been sent.
    #[cfg(any(test, feature = "test-util"))]
    pub fn emitted(&self) {
        self.state().in_flight = false;
    }

    /// Whether every commit recorded so far has been taken and sent.
    #[cfg(any(test, feature = "test-util"))]
    pub fn is_idle(&self) -> bool {
        let state = self.state();
        state.pending.is_empty() && !state.in_flight
    }
}

#[cfg(test)]
mod tests {
    use super::{ChangeDomain, ChangeFeed};

    #[test]
    fn taken_changes_keep_the_feed_busy_until_emitted() {
        let feed = ChangeFeed::default();
        assert!(feed.is_idle(), "a new feed has nothing to send");
        feed.record([(&[ChangeDomain::Structure][..], Some("A"))]);
        assert!(!feed.is_idle(), "a recorded commit is pending");

        assert!(feed.take_if_quiet(feed.writes()).is_some());
        assert!(!feed.is_idle(), "taken but not yet sent");
        feed.emitted();
        assert!(feed.is_idle(), "sent");
    }

    #[test]
    fn commits_merge_into_one_pending_set_that_a_take_clears() {
        let feed = ChangeFeed::default();
        feed.record([(&[ChangeDomain::Structure][..], Some("A"))]);
        feed.record([
            (
                &[ChangeDomain::Structure, ChangeDomain::Names][..],
                Some("A"),
            ),
            (&[ChangeDomain::PropertyDefs][..], None),
        ]);

        let taken = feed.take_if_quiet(feed.writes()).expect("no commit since");

        assert_eq!(
            taken.domains.into_iter().collect::<Vec<_>>(),
            [
                ChangeDomain::Structure,
                ChangeDomain::PropertyDefs,
                ChangeDomain::Names
            ],
            "the domains of both commits, each once"
        );
        assert_eq!(
            taken.block_ids.into_iter().collect::<Vec<_>>(),
            ["A"],
            "the block both commits named, once"
        );
        assert!(
            feed.take_if_quiet(feed.writes())
                .expect("no commit since")
                .is_empty(),
            "a take leaves nothing pending"
        );
    }

    #[test]
    fn a_commit_recorded_during_the_settle_keeps_everything_pending() {
        let feed = ChangeFeed::default();
        feed.record([(&[ChangeDomain::Structure][..], Some("A"))]);
        let seen = feed.writes();
        feed.record([(&[ChangeDomain::Names][..], Some("B"))]);

        assert_eq!(
            feed.take_if_quiet(seen),
            None,
            "the second commit's rebuilds may not have run"
        );
        let taken = feed.take_if_quiet(feed.writes()).expect("no commit since");
        assert_eq!(
            taken.block_ids.into_iter().collect::<Vec<_>>(),
            ["A", "B"],
            "both commits are still pending for the next take"
        );
    }

    #[test]
    fn a_commit_of_no_ops_records_nothing() {
        let feed = ChangeFeed::default();
        feed.record([]);
        assert_eq!(feed.writes(), 0, "nothing to wake the emitter for");
    }
}
