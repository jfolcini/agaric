use std::sync::Arc;

use async_trait::async_trait;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::loro::shared::LoroState;
use agaric_engine::materializer::Materializer;

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

/// #4502: the production host is the engine's `Materializer`; sync owns the
/// trait, so the impl lives here and the materializer never sees this crate.
#[async_trait]
impl ApplyHost for Materializer {
    fn loro_state(&self) -> Arc<LoroState> {
        Arc::clone(Materializer::loro_state(self))
    }

    async fn enqueue_inbound_sync_rebuilds(
        &self,
        changed_blocks: &[BlockId],
        purged_blocks: &[BlockId],
    ) -> Result<(), AppError> {
        Materializer::enqueue_inbound_sync_rebuilds(self, changed_blocks, purged_blocks).await
    }

    /// #3328: the attachment root, served from the value the app registers
    /// via `Materializer::set_app_data_dir` — the same `OnceLock` the
    /// `CleanupOrphanedAttachments` task reads. Sync-received attachments and
    /// the GC that reconciles them now resolve their directory from one
    /// place instead of two.
    ///
    /// `None` before `set_app_data_dir` runs (and in tests that never call
    /// it); the sync call sites fall back to deriving the root from the pool
    /// in that case, which is the pre-#3328 behaviour.
    fn app_data_dir(&self) -> Option<std::path::PathBuf> {
        Materializer::app_data_dir(self)
    }

    async fn flush(&self) -> Result<(), AppError> {
        Materializer::flush(self).await
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

        async fn flush(&self) -> Result<(), AppError> {
            self.lock().flushes += 1;
            Ok(())
        }
    }
}

/// #3443 — the double's contract, checked against the real host.
///
/// [`test_support::RecordingApplyHost`] stands in for [`Materializer`] across
/// this crate's session and driver tests, and nothing checked that what the
/// double promises is what the materializer delivers. A session relies on
/// three things from its host, and each is asserted on BOTH implementations
/// through one function, so the double cannot drift from the real impl
/// without this reddening:
///
///   * `loro_state()` is one registry, not a fresh one per call — the session
///     reads it at several points of one exchange (`session_state_machine.rs`)
///     and would split its own engine state otherwise;
///   * `flush()` resolves after `enqueue_inbound_sync_rebuilds`, including
///     the #2264 empty import — the session awaits it at the end of every
///     import, so a host whose flush waited on work nothing drains would hang
///     the session where the double reports success;
///   * `app_data_dir()` is `None` for a host with no registered root — the
///     signal `sync_files::app_data_dir_from_pool` falls back on.
///
/// What the real host does with the rebuilds is the engine's to pin
/// (`materializer/tests/cache_rebuild.rs`); this is the port's contract only.
#[cfg(test)]
mod contract_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use agaric_core::ulid::BlockId;
    use agaric_engine::materializer::Materializer;
    use agaric_store::test_support::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::ApplyHost;
    use super::test_support::RecordingApplyHost;

    const CHANGED: &str = "APPLY_HOST_CONTRACT_1";

    async fn exercise<H: ApplyHost>(host: &H) {
        assert!(
            Arc::ptr_eq(&host.loro_state(), &host.loro_state()),
            "loro_state() must hand out one registry, not a fresh one per call"
        );
        assert_eq!(
            host.app_data_dir(),
            None,
            "no root is registered on either host"
        );
        host.enqueue_inbound_sync_rebuilds(&[BlockId::test_id(CHANGED)], &[])
            .await
            .expect("an import with one changed block is accepted");
        host.enqueue_inbound_sync_rebuilds(&[], &[])
            .await
            .expect("an empty import is accepted (#2264)");
        tokio::time::timeout(Duration::from_secs(30), host.flush())
            .await
            .expect("flush() resolves after the rebuilds were enqueued")
            .expect("flush() succeeds");
    }

    async fn pool_with_changed_block() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("contract.db"))
            .await
            .expect("init_pool");
        sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', 'inbound text', 1)")
            .bind(CHANGED)
            .execute(&pool)
            .await
            .expect("seed the changed block");
        (pool, dir)
    }

    #[tokio::test]
    async fn the_double_honours_the_contract() {
        exercise(&RecordingApplyHost::new()).await;
    }

    #[tokio::test]
    async fn the_materializer_honours_the_contract() {
        let (pool, _dir) = pool_with_changed_block().await;
        exercise(&Materializer::new(pool)).await;
    }
}
