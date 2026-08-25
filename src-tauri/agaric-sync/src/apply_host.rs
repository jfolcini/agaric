use std::sync::Arc;

use async_trait::async_trait;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::loro::shared::LoroState;

/// #2621 (agaric-sync inversion): the narrow apply/materialize surface the sync
/// layer needs from the app-side `Materializer` coordinator, expressed as a
/// trait so the sync modules depend DOWN on this abstraction instead of UP on
/// the concrete `Materializer` (which itself depends down on sync).
#[async_trait]
pub trait ApplyHost: Send + Sync + std::fmt::Debug {
    /// The per-space Loro registry the session syncs against.
    fn loro_state(&self) -> Arc<LoroState>;
    /// Fan out the debounced inbound-sync cache rebuilds for the changed /
    /// purged blocks of an inbound import.
    async fn enqueue_inbound_sync_rebuilds(
        &self,
        changed_blocks: &[BlockId],
        purged_blocks: &[BlockId],
    ) -> Result<(), AppError>;
    /// Enqueue the fixed full-vault cache-rebuild task set after a snapshot
    /// restore replaces vault state wholesale.
    async fn enqueue_post_snapshot_rebuilds(&self) -> Result<(), AppError>;
    /// Await both foreground and background materialize queues draining.
    async fn flush(&self) -> Result<(), AppError>;

    /// The app data directory whose `attachments/` subtree the sync layer
    /// writes received attachments into, or `None` when the host has no
    /// registered root.
    ///
    /// #3328 — why this belongs on the port. The sync layer writes
    /// attachments; the app-side `Materializer` reads them back (its
    /// `CleanupOrphanedAttachments` task walks `attachments/` and reconciles
    /// it against the `attachments` table). Those two must address the SAME
    /// tree, yet the sync side used to derive its root independently, by
    /// asking SQLite for its own database file and taking the parent
    /// directory ([`crate::sync_files::app_data_dir_from_pool`]). That
    /// encoded `db_path.parent() == materializer.app_data_dir()` in no type
    /// and no test — it held only because `lib.rs` happens to build the DB
    /// path as `app_data_dir.join("notes.db")`.
    ///
    /// Anything that relocates the database relative to the app data
    /// directory — a `db/` subdirectory, a custom-DB-path or external-vault
    /// setting, an Android variant whose DB sandbox is not where user files
    /// live — would silently point the sync writer at one tree and the
    /// attachment GC at another, with no compile-time or test signal. The
    /// symptom surfaces much later, as attachments missing after a sync.
    /// Routing the root through the port makes the app the single authority
    /// for it, the same way it already is for the Loro registry above.
    ///
    /// Defaulted to `None` so pool-only test harnesses (and
    /// `test_support::RecordingApplyHost`) need not carry a filesystem root; the
    /// production impl returns the value `lib.rs` registers. Call sites treat
    /// `None` as "fall back to deriving it from the pool" — see
    /// `app_data_dir_from_pool`, which documents that fallback and is why
    /// this is `Option` rather than a required method.
    fn app_data_dir(&self) -> Option<std::path::PathBuf> {
        None
    }
}

/// A recording, side-effect-free [`ApplyHost`] for tests.
///
/// # Why this lives here rather than in one test module
///
/// `agaric-sync` ships the [`ApplyHost`] trait but no implementation — the only one is
/// app-side, on `Materializer`. That means anything in this crate that needs a
/// `SyncOrchestrator` needs the app crate too, which is the coupling #3120 is trying to
/// remove. A reusable double breaks that: any test in this crate can now stand up a
/// real orchestrator without reaching up a layer.
///
/// It is deliberately inert. Materialization is not what a sync test is asserting, and
/// a double that did real work would make failures ambiguous between the two. What it
/// does instead is *record*, so a test that cares whether the session fanned out cache
/// rebuilds can assert on that rather than infer it.
#[cfg(any(test, feature = "test-util"))]
pub mod test_support {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use agaric_core::error::AppError;
    use agaric_core::ulid::BlockId;
    use agaric_engine::loro::shared::LoroState;

    use super::ApplyHost;

    /// One recorded [`ApplyHost::enqueue_inbound_sync_rebuilds`] call.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct InboundRebuild {
        pub changed_blocks: Vec<BlockId>,
        pub purged_blocks: Vec<BlockId>,
    }

    /// Everything the double saw, in call order.
    #[derive(Debug, Default)]
    struct Calls {
        inbound_rebuilds: Vec<InboundRebuild>,
        post_snapshot_rebuilds: usize,
        flushes: usize,
    }

    /// An [`ApplyHost`] that owns its own Loro engine state and records every call.
    ///
    /// Each instance holds a distinct [`LoroState`], which is what lets two
    /// orchestrators run in one test process as genuinely separate devices — the same
    /// property production gets from each device owning its own materializer.
    #[derive(Default)]
    pub struct RecordingApplyHost {
        loro: Arc<LoroState>,
        calls: Mutex<Calls>,
    }

    // `LoroState` is not `Debug` (it wraps live CRDT engines), but `ApplyHost` requires
    // it, so report the call tallies — the part a failing test would want to see —
    // rather than pretending to render the engine.
    impl std::fmt::Debug for RecordingApplyHost {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            let calls = self.lock();
            f.debug_struct("RecordingApplyHost")
                .field("inbound_rebuilds", &calls.inbound_rebuilds.len())
                .field("post_snapshot_rebuilds", &calls.post_snapshot_rebuilds)
                .field("flushes", &calls.flushes)
                .finish_non_exhaustive()
        }
    }

    impl RecordingApplyHost {
        #[must_use]
        pub fn new() -> Self {
            Self::default()
        }

        /// Build a double over an existing engine state, for a test that needs to seed
        /// spaces into the registry before the session runs.
        #[must_use]
        pub fn with_loro_state(loro: Arc<LoroState>) -> Self {
            Self {
                loro,
                calls: Mutex::new(Calls::default()),
            }
        }

        /// Every inbound-rebuild fan-out this host was asked for, in order.
        ///
        /// # Panics
        /// If the internal mutex was poisoned by a panic in another thread.
        #[must_use]
        pub fn inbound_rebuilds(&self) -> Vec<InboundRebuild> {
            self.lock().inbound_rebuilds.clone()
        }

        /// How many times a post-snapshot rebuild set was enqueued.
        ///
        /// # Panics
        /// If the internal mutex was poisoned by a panic in another thread.
        #[must_use]
        pub fn post_snapshot_rebuild_count(&self) -> usize {
            self.lock().post_snapshot_rebuilds
        }

        /// How many times the session awaited a materialize flush.
        ///
        /// # Panics
        /// If the internal mutex was poisoned by a panic in another thread.
        #[must_use]
        pub fn flush_count(&self) -> usize {
            self.lock().flushes
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, Calls> {
            self.calls.lock().expect("recording apply host poisoned")
        }
    }

    #[async_trait]
    impl ApplyHost for RecordingApplyHost {
        fn loro_state(&self) -> Arc<LoroState> {
            Arc::clone(&self.loro)
        }

        async fn enqueue_inbound_sync_rebuilds(
            &self,
            changed_blocks: &[BlockId],
            purged_blocks: &[BlockId],
        ) -> Result<(), AppError> {
            self.lock().inbound_rebuilds.push(InboundRebuild {
                changed_blocks: changed_blocks.to_vec(),
                purged_blocks: purged_blocks.to_vec(),
            });
            Ok(())
        }

        async fn enqueue_post_snapshot_rebuilds(&self) -> Result<(), AppError> {
            self.lock().post_snapshot_rebuilds += 1;
            Ok(())
        }

        async fn flush(&self) -> Result<(), AppError> {
            self.lock().flushes += 1;
            Ok(())
        }
    }
}
