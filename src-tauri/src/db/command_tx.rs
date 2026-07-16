use sqlx::{Sqlite, SqlitePool};
use std::sync::Arc;

use super::begin_immediate_logged;

/// Command-layer transaction wrapper that couples a `BEGIN IMMEDIATE`
/// SQLite transaction to the materializer-dispatch calls that must fire
/// after it commits.
///
/// Without this wrapper, every write-path command has to repeat the same
/// three-step dance —
///
/// ```text
/// let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
/// // ... work ...
/// tx.commit().await?;
/// materializer.dispatch_background_or_warn(&op_record);
/// ```
///
/// That pattern recurs across the command layer, pairing each mutation with
/// a post-commit background dispatch. Two failure modes are easy to
/// introduce and hard to review for:
///
/// 1. **Pre-commit dispatch.** Firing the background task before
///    `tx.commit().await?` can expose the not-yet-committed op-record to
///    the materializer. A follow-up commit failure then leaves the
///    materializer chasing an op that never lands.
/// 2. **Missing dispatch.** Forgetting the `dispatch_background_or_warn`
///    call leaves caches (`tags_cache`, `pages_cache`, FTS, block_links,
///    block_tag_inherited) stale until the next touch.
///
/// `CommandTx` closes both by construction:
///
/// - Opening a transaction is a single call — [`CommandTx::begin_immediate`]
///   — that also takes the [`SLOW_ACQUIRE_WARN_MS`] timing log for free.
/// - Callers [`enqueue_background`](CommandTx::enqueue_background) the op
///   records that need post-commit dispatch *during* the transaction.
///   The records are held on the `CommandTx` value, not sent to the
///   materializer yet.
/// - The only way to commit is via [`commit_and_dispatch`](
///   CommandTx::commit_and_dispatch) or the explicit
///   [`commit_without_dispatch`](CommandTx::commit_without_dispatch)
///   escape hatch. Both commit the inner `sqlx::Transaction` first, and
///   only then (if the commit succeeded) drain the pending queue into
///   `Materializer::dispatch_background_or_warn` in enqueue order.
/// - Dropping the `CommandTx` without calling either commit method
///   rolls back the transaction (via `sqlx::Transaction`'s own `Drop`)
///   and discards the pending queue. No dispatches fire on rollback.
///
/// Existing `*_in_tx` helpers that take `&mut sqlx::Transaction<'_,
/// Sqlite>` do **not** need signature changes: `CommandTx` implements
/// [`Deref`] and [`DerefMut`] to the inner transaction, so Rust's
/// deref-coercion-on-reborrow rule lets callers keep writing
/// `append_local_op_in_tx(&mut cmd_tx, ...)` at the function-call site —
/// the `&mut CommandTx` → `&mut sqlx::Transaction<'_, Sqlite>` coercion
/// applies automatically. (Explicit `&mut *cmd_tx` also works if
/// the reader wants the coercion to be visible.) The `_in_tx` suffix is
/// preserved deliberately — it is load-bearing for grep + code review
/// and every call site keeps its familiar shape.
///
/// Phase B added a second dispatch variant —
/// [`CommandTx::enqueue_edit_background`] — for the one `edit_block`
/// caller (`crud::edit_block_inner`) that needs the `block_type` hint.
/// `dispatch_op` (foreground + background) is not yet wrapped; the
/// single in-tree caller is in a different context (remote-op apply)
/// and does not pair with a `CommandTx` transaction.
///
/// A post-commit dispatch queued by [`CommandTx::enqueue_background`]
/// or [`CommandTx::enqueue_edit_background`]. Drained by
/// [`CommandTx::commit_and_dispatch`] in FIFO order. Dispatch failures
/// follow the `_or_warn` convention — logged via
/// `dispatch_background_or_warn` / a direct `logger.warn` path for the
/// `Edit` variant, never propagated to the caller.
///
/// + L9: the inner `OpRecord` is held as `Arc<OpRecord>` so
///   command sites that need both the dispatch queue and another
///   post-commit borrow can share one record via refcount
///   instead of deep-cloning. The enqueue methods accept
///   `impl Into<Arc<OpRecord>>` so the existing call sites that hand off
///   a freshly-built `OpRecord` by value continue to compile unchanged
///   (the blanket `impl<T> From<T> for Arc<T>` makes the conversion
///   transparent).
enum PendingDispatch {
    /// Plain op dispatch — invokes [`Materializer::dispatch_background_or_warn`].
    Background(Arc<crate::op_log::OpRecord>),
    /// Edit-op dispatch with a `block_type` hint — invokes
    /// [`Materializer::dispatch_edit_background`] and warns on error.
    /// The materializer uses the hint to pick a narrower cache-rebuild
    /// fan-out for content vs. tag vs. page edits.
    EditBackground {
        record: Arc<crate::op_log::OpRecord>,
        block_type: String,
    },
    /// Lifecycle-op (`delete_block` / `restore_block` / `purge_block`)
    /// dispatch with a `block_type` hint — invokes
    /// [`Materializer::dispatch_lifecycle_background`] and warns on error.
    /// #2037 pt2: the hint lets the materializer skip the
    /// `RebuildTagsCache` + `RebuildPagesCache` rebuilds when the deleted /
    /// restored / purged block is CONTENT (their caches are scoped to
    /// page/tag blocks and a content block's lifecycle cannot change them).
    LifecycleBackground {
        record: Arc<crate::op_log::OpRecord>,
        block_type: String,
    },
}

pub struct CommandTx {
    /// The live `BEGIN IMMEDIATE` transaction. `'static` because
    /// `pool.begin_with(...)` internally clones the pool handle.
    ///
    /// Wrapped in `Option` purely so the finalizing methods
    /// (`commit_and_dispatch`, `commit_without_dispatch`, `rollback`) can
    /// `take()` the transaction out and call its by-value
    /// `commit()`/`rollback()`. `sqlx::Transaction` consumes `self`, but a
    /// type with a manual `Drop` impl (added for issue #654) cannot have a
    /// field moved out of it directly (E0509) — `Option::take` moves out of
    /// the `Option`, not out of `self`, which is allowed. It is `Some` for
    /// the entire useful life of the value and only becomes `None` once one
    /// of the consuming finalizers has run (after which the value is gone).
    inner: Option<sqlx::Transaction<'static, Sqlite>>,
    /// Op records to dispatch to the materializer once the transaction
    /// commits successfully. FIFO order — `commit_and_dispatch` drains
    /// them in enqueue order.
    pending: Vec<PendingDispatch>,
    /// Set to `true` the instant `self.inner.commit()` returns `Ok` inside
    /// [`commit_and_dispatch`](Self::commit_and_dispatch) or
    /// [`commit_without_dispatch`](Self::commit_without_dispatch). It is
    /// the discriminator the [`Drop`] debug-assert uses to tell the
    /// genuine bug ("the inner transaction was committed but its enqueued
    /// dispatches were never drained") apart from a *legitimate*
    /// rollback-drop.
    ///
    /// This flag is load-bearing for correctness, not just diagnostics:
    /// many command sites enqueue a dispatch and only *then* run further
    /// fallible `await?` work before `commit_and_dispatch` (e.g.
    /// `create_blocks_batch_inner`, `restore_blocks_by_ids_inner`). When such
    /// a call returns `Err`, the `?` drops the `CommandTx` with `pending`
    /// non-empty *on purpose* — the transaction rolls back and the queued
    /// records must be discarded. That drop must NOT trip the assert, and
    /// it does not, because `committed` is still `false`.
    committed: bool,
    /// Label used by [`begin_immediate_logged`] for slow-acquire logs, and
    /// named by the [`Drop`] debug-assert below so a leaked
    /// post-commit dispatch can be traced back to its originating command.
    label: &'static str,
    /// #2604 — engine-rollback handle for the LOCAL command path. `Some` when
    /// this tx was opened via [`arm_engine_rollback`](Self::arm_engine_rollback):
    /// it holds the `LoroState` whose per-tx [`RevertLog`] was armed, so the
    /// engine mutations this command applies in place can be rewound if the tx
    /// aborts. `None` for non-engine txs (attachments, drafts, PRAGMA, …), whose
    /// commit/rollback/drop paths then skip the rollback logic entirely.
    ///
    /// [`RevertLog`]: crate::loro::revert::RevertLog
    revert: Option<Arc<crate::loro::shared::LoroState>>,
}

impl CommandTx {
    /// Open a new `BEGIN IMMEDIATE` transaction with slow-acquire logging.
    ///
    /// `label` mirrors [`begin_immediate_logged`] — a stable,
    /// human-readable tag like `"undo_page_op"` so slow writes can be
    /// filtered per-command in the tracing output.
    pub async fn begin_immediate(
        pool: &SqlitePool,
        label: &'static str,
    ) -> Result<Self, sqlx::Error> {
        let inner = begin_immediate_logged(pool, label).await?;
        Ok(Self {
            inner: Some(inner),
            pending: Vec::new(),
            committed: false,
            label,
            revert: None,
        })
    }

    /// #2604 — arm rollback-safe engine apply for this tx (the LOCAL command
    /// path). Call once, right after opening the tx and BEFORE the first engine
    /// mutation, on any command that applies ops in place via
    /// `apply_op_projected(.., advance_cursor=false)` or a direct
    /// `for_space_recording`.
    ///
    /// Arms `state`'s [`RevertLog`](crate::loro::revert::RevertLog) so the
    /// mutation handlers capture each touched space's pre-op checkpoint, and
    /// stashes the `Arc<LoroState>` so the finalizers
    /// ([`commit_and_dispatch`](Self::commit_and_dispatch) /
    /// [`commit_without_dispatch`](Self::commit_without_dispatch) /
    /// [`rollback`](Self::rollback)) and the abort/panic `Drop` can detach and
    /// rewind. Arming happens under the `BEGIN IMMEDIATE` write lock this tx
    /// already holds, so it observes an un-armed log (single-in-flight).
    pub fn arm_engine_rollback(&mut self, state: &Arc<crate::loro::shared::LoroState>) {
        state.revert.arm();
        self.revert = Some(Arc::clone(state));
    }

    /// Queue an op record for post-commit background dispatch.
    ///
    /// The record is held on the `CommandTx` value and forwarded to
    /// `Materializer::dispatch_background_or_warn` only if
    /// [`commit_and_dispatch`](Self::commit_and_dispatch) succeeds. If
    /// the transaction is rolled back or committed via
    /// [`commit_without_dispatch`](Self::commit_without_dispatch), the
    /// queued records are discarded.
    ///
    /// Multiple records may be enqueued from the same transaction —
    /// typical for batch operations such as `commands::history::revert_ops_inner`.
    ///
    /// Accepts `impl Into<Arc<OpRecord>>` so callers can pass
    /// either a fresh `OpRecord` by value (Rust's blanket
    /// `impl<T> From<T> for Arc<T>` does the wrap) or an existing
    /// `Arc<OpRecord>` they need to share with a post-commit borrow.
    pub fn enqueue_background(&mut self, record: impl Into<Arc<crate::op_log::OpRecord>>) {
        self.pending
            .push(PendingDispatch::Background(record.into()));
    }

    /// Queue an `edit_block` op record with a `block_type` hint for
    /// post-commit dispatch.
    ///
    /// Invokes [`Materializer::dispatch_edit_background`] during
    /// `commit_and_dispatch`. Dispatch failures are logged at warn level
    /// (matching the `_or_warn` convention used for the plain
    /// [`enqueue_background`](Self::enqueue_background) variant) rather
    /// than propagated — the op itself has already committed, so a
    /// missed cache rebuild is recoverable and non-fatal.
    ///
    /// `block_type` is the post-edit type ("content" / "page" / "tag")
    /// the materializer uses to pick a narrower rebuild fan-out.
    ///
    /// See [`Self::enqueue_background`] — same `Into<Arc<…>>`
    /// shape so the callsite reads identically regardless of whether the
    /// record is owned or already shared.
    pub fn enqueue_edit_background(
        &mut self,
        record: impl Into<Arc<crate::op_log::OpRecord>>,
        block_type: impl Into<String>,
    ) {
        self.pending.push(PendingDispatch::EditBackground {
            record: record.into(),
            block_type: block_type.into(),
        });
    }

    /// Queue a lifecycle op record (`delete_block` / `restore_block` /
    /// `purge_block`) with a `block_type` hint for post-commit dispatch.
    ///
    /// Invokes [`Materializer::dispatch_lifecycle_background`] during
    /// `commit_and_dispatch`. Dispatch failures are logged at warn level
    /// (matching the `_or_warn` convention) rather than propagated — the op
    /// has already committed, so a missed cache rebuild is recoverable.
    ///
    /// #2037 pt2: `block_type` is the deleted / restored / purged block's
    /// type ("content" / "page" / "tag"). For "content" the materializer
    /// drops the `RebuildTagsCache` + `RebuildPagesCache` rebuilds from the
    /// fan-out; any other value keeps the full set. Same `Into<…>` shape as
    /// [`Self::enqueue_background`].
    pub fn enqueue_lifecycle_background(
        &mut self,
        record: impl Into<Arc<crate::op_log::OpRecord>>,
        block_type: impl Into<String>,
    ) {
        self.pending.push(PendingDispatch::LifecycleBackground {
            record: record.into(),
            block_type: block_type.into(),
        });
    }

    /// Commit the transaction, then drain the pending queue into the
    /// materializer in enqueue order.
    ///
    /// If `commit()` fails, no dispatches fire and the error is
    /// propagated. This is the desired behaviour — a failed commit means
    /// the op records never landed in `op_log`, so the materializer must
    /// not be told about them.
    ///
    /// # Enqueue-then-`await?`-then-commit contract
    ///
    /// The common command shape is: open a `CommandTx`,
    /// [`enqueue_background`](Self::enqueue_background) one or more op
    /// records, run *further* fallible `await?` work, and only then call
    /// `commit_and_dispatch` (see `create_blocks_batch_inner` and
    /// `restore_blocks_by_ids_inner`, both of which enqueue inside a loop
    /// and keep awaiting more queries afterwards). If any of that later
    /// `await?` returns `Err`, the `?` drops the `CommandTx` *before*
    /// reaching this method: the inner transaction rolls back and the
    /// queued records are discarded by design — **no dispatch fires on the
    /// `Err` path**. Enqueuing is therefore always safe before fallible
    /// work; a record only ever reaches the materializer once the commit
    /// here has succeeded. (The legitimate rollback-with-pending drop emits
    /// a `tracing::debug!` for observability — see the [`Drop`] impl,
    /// issue #1316.)
    ///
    /// Returns the number of dispatches that fired. Dispatch failures
    /// are logged at warn level and do not surface here.
    pub async fn commit_and_dispatch(
        mut self,
        materializer: &crate::materializer::Materializer,
    ) -> Result<usize, sqlx::Error> {
        // #2604 — detach the engine-rollback checkpoints WHILE the write lock is
        // still held (before the commit below releases it). On a commit failure
        // we rewind the in-place engine apply so it never stays ahead of the
        // rolled-back SQL; on success we drop the checkpoints and keep the ops.
        let pending_revert = self.revert.take().map(|state| state.revert.detach());
        if let Err(e) = self.take_inner().commit().await {
            if let Some(pending) = pending_revert {
                pending.revert();
            }
            return Err(e);
        }
        drop(pending_revert); // commit succeeded — keep the applied ops
        // Commit succeeded: from here the Drop assert (below) is armed.
        // We must drain `pending` before this method returns, or the
        // assert will fire — which is exactly its job.
        self.committed = true;
        let drained = std::mem::take(&mut self.pending);
        let count = drained.len();
        for entry in drained {
            match entry {
                PendingDispatch::Background(record) => {
                    materializer.dispatch_background_or_warn(&record);
                }
                PendingDispatch::EditBackground { record, block_type } => {
                    if let Err(e) = materializer.dispatch_edit_background(&record, &block_type) {
                        tracing::warn!(
                            op_type = %record.op_type,
                            seq = record.seq,
                            device_id = %record.device_id,
                            block_type = %block_type,
                            error = %e,
                            "failed to dispatch edit background cache task"
                        );
                    }
                }
                PendingDispatch::LifecycleBackground { record, block_type } => {
                    if let Err(e) = materializer.dispatch_lifecycle_background(&record, &block_type)
                    {
                        tracing::warn!(
                            op_type = %record.op_type,
                            seq = record.seq,
                            device_id = %record.device_id,
                            block_type = %block_type,
                            error = %e,
                            "failed to dispatch lifecycle background cache task"
                        );
                    }
                }
            }
        }
        Ok(count)
    }

    /// Commit the transaction without firing any dispatches.
    ///
    /// Escape hatch for test fixtures and maintenance commands that
    /// don't participate in the materializer pipeline (e.g., direct
    /// SQLite PRAGMA writes, migration markers). Pending records are
    /// discarded silently.
    pub async fn commit_without_dispatch(mut self) -> Result<(), sqlx::Error> {
        // #2604 — same detach-under-lock + revert-on-abort as `commit_and_dispatch`.
        let pending_revert = self.revert.take().map(|state| state.revert.detach());
        if let Err(e) = self.take_inner().commit().await {
            if let Some(pending) = pending_revert {
                pending.revert();
            }
            return Err(e);
        }
        drop(pending_revert); // commit succeeded — keep the applied ops
        self.committed = true;
        self.pending.clear();
        Ok(())
    }

    /// Explicitly roll back the transaction and discard pending
    /// dispatches.
    ///
    /// Identical in effect to dropping the `CommandTx` without
    /// committing, but surfaces any rollback error to the caller.
    pub async fn rollback(mut self) -> Result<(), sqlx::Error> {
        self.pending.clear();
        // #2604 — explicit abort: rewind any in-place engine apply to its pre-tx
        // checkpoints (no-op when this tx was not rollback-armed).
        if let Some(state) = self.revert.take() {
            state.revert.detach().revert();
        }
        self.take_inner().rollback().await
    }

    /// Move the live `sqlx::Transaction` out of `self` so it can be
    /// committed or rolled back by value.
    ///
    /// Only the three consuming finalizers call this, and each calls it at
    /// most once, so `inner` is always `Some` here. After the call `inner`
    /// is `None`; the finalizer then drops `self`, and the [`Drop`] impl
    /// (which never touches `inner`) runs the debug-assert and finishes.
    fn take_inner(&mut self) -> sqlx::Transaction<'static, Sqlite> {
        self.inner
            .take()
            .expect("CommandTx inner transaction taken twice — finalizer called more than once")
    }

    /// Number of op records currently queued for post-commit dispatch.
    ///
    /// Useful in tests that want to assert exactly how many cache
    /// rebuilds a command will schedule. Counts both
    /// [`enqueue_background`](Self::enqueue_background) and
    /// [`enqueue_edit_background`](Self::enqueue_edit_background)
    /// entries.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

impl Drop for CommandTx {
    /// Debug-time guard that the post-commit dispatch queue is never
    /// silently abandoned *after a successful commit*.
    ///
    /// Invariant: once `self.inner.commit()` has returned `Ok` (tracked by
    /// `self.committed`), every enqueued [`PendingDispatch`] must have been
    /// drained — either fired (`commit_and_dispatch`) or explicitly
    /// discarded (`commit_without_dispatch`). Both methods do exactly that
    /// immediately after the commit, so a `committed` `CommandTx` reaching
    /// `Drop` with a non-empty `pending` can only mean a *future* code path
    /// committed the inner transaction (e.g. via `DerefMut` +
    /// `inner.commit()`) and let the value drop without draining. That is
    /// The silent-missing-dispatch bug set out to make
    /// impossible; the assert turns it into a loud panic under
    /// `cfg(debug_assertions)`.
    ///
    /// Why this is gated on `committed` rather than asserting
    /// `pending.is_empty()` unconditionally: many command sites
    /// (`create_blocks_batch_inner`, `restore_blocks_by_ids_inner`, …)
    /// `enqueue_background` and then run further fallible `await?` work
    /// before `commit_and_dispatch`. An error there drops the `CommandTx`
    /// with `pending` populated *by design* — the transaction rolls back
    /// and the queue is correctly discarded. Such a drop has
    /// `committed == false`, so it does not (and must not) trip the assert.
    /// A `tracing::debug!` (issue #1316) now records that legitimate
    /// rollback-with-pending drop so the path is observable in dev logs.
    ///
    /// In release builds `debug_assert!` compiles out entirely, so this
    /// `Drop` is a no-op there beyond running the inner transaction's own
    /// `Drop` (rollback) as before.
    fn drop(&mut self) {
        debug_assert!(
            !self.committed || self.pending.is_empty(),
            "CommandTx '{}' dropped with {} pending dispatches after a successful commit",
            self.label,
            self.pending.len(),
        );
        // #1316: dev-time observability for the LEGITIMATE counterpart of the
        // assert above. When an enqueue-then-`await?`-then-`commit_and_dispatch`
        // command returns `Err` before committing, the `?` drops the
        // `CommandTx` with `committed == false && !pending.is_empty()` on
        // purpose — the inner transaction rolls back and the queued records are
        // correctly discarded, never dispatched. That is silent by design;
        // this `debug!` gives it a signal so the rollback-with-pending path is
        // traceable in dev logs without changing any behaviour.
        if !self.committed && !self.pending.is_empty() {
            tracing::debug!(
                label = %self.label,
                pending = self.pending.len(),
                "CommandTx rolled back (dropped uncommitted) with pending dispatches — discarding by design"
            );
        }
        // #2604 — engine-rollback panic/early-return net. The three finalizers
        // (`commit_and_dispatch` / `commit_without_dispatch` / `rollback`) all
        // `take()` `self.revert` before their work, so reaching `Drop` with it
        // still `Some` means the tx is aborting WITHOUT a finalizer — a
        // `?`-propagated error or a panic between `arm_engine_rollback` and the
        // finalizer. The inner `sqlx::Transaction`'s own `Drop` (below) rolls the
        // SQL back; here we rewind the in-place engine apply to match, so the
        // engine never stays ahead of the rolled-back SQL. `detach().revert()` is
        // sync and re-locks only already-released per-space engine guards, so it
        // is safe from `Drop`, including during a panic unwind.
        if let Some(state) = self.revert.take() {
            state.revert.detach().revert();
        }
    }
}

impl std::ops::Deref for CommandTx {
    type Target = sqlx::Transaction<'static, Sqlite>;

    /// Deref to the live transaction. `inner` is `Some` for the entire
    /// span in which a `CommandTx` is usable — it only becomes `None`
    /// inside a consuming finalizer (`commit_*` / `rollback`), after which
    /// the value is gone and cannot be deref'd again. So this `expect`
    /// cannot fire through any sound use of the API.
    fn deref(&self) -> &Self::Target {
        self.inner
            .as_ref()
            .expect("CommandTx deref'd after its transaction was finalized")
    }
}

impl std::ops::DerefMut for CommandTx {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_mut()
            .expect("CommandTx deref'd after its transaction was finalized")
    }
}

#[cfg(test)]
mod tests {
    //! Drop-time debug-assert coverage (issue #654).
    //!
    //! These tests live in `command_tx.rs` rather than the `db::tests`
    //! block because they need to reach the module-private `committed` /
    //! `pending` fields to *synthesise* the post-commit-with-leftover-queue
    //! state. That state is unreachable through the public API — both
    //! commit methods drain `pending` the moment they set `committed` — so
    //! forcing it here is the only way to exercise the assert's failing arm.
    //! The happy-path / rollback / error-path behaviour the assert must
    //! NOT trip on is covered end-to-end by the `command_tx_*` tests in
    //! `db::tests`.
    use super::*;
    use crate::op_log::OpRecord;
    use sqlx::sqlite::SqlitePoolOptions;

    fn fake_op_record() -> OpRecord {
        OpRecord {
            device_id: "DEV".to_string(),
            seq: 1,
            parent_seqs: None,
            hash: "0".repeat(64),
            op_type: "create_block".to_string(),
            payload: "{}".to_string(),
            created_at: 0,
            block_id: None,
        }
    }

    /// A bare in-memory SQLite pool — enough to open a real
    /// `BEGIN IMMEDIATE` transaction. No migrations needed: the Drop
    /// assert is about the in-memory `pending`/`committed` state, not any
    /// table.
    async fn bare_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool should open")
    }

    /// The genuine bug class: the inner transaction was committed but the
    /// enqueued dispatches were never drained. Synthesised by committing
    /// `inner` and flipping `committed` by hand WITHOUT clearing `pending`
    /// (i.e. simulating a future refactor that commits via `DerefMut` and
    /// forgets to dispatch). The Drop assert must fire.
    ///
    /// `#[should_panic]` only catches the panic in debug builds, where
    /// `debug_assert!` is active. The test is gated on `debug_assertions`
    /// so a `--release` test run (where the assert compiles out and no
    /// panic occurs) does not spuriously fail the `should_panic`
    /// expectation.
    #[cfg(debug_assertions)]
    #[tokio::test]
    #[should_panic(expected = "dropped with 1 pending dispatches after a successful commit")]
    async fn drop_after_commit_with_pending_trips_assert_654() {
        let pool = bare_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_leaked_dispatch")
            .await
            .unwrap();
        tx.enqueue_background(fake_op_record());

        // Simulate the regression: commit the inner tx, mark committed, but
        // leave `pending` populated (the real commit methods would drain it
        // here). Dropping `tx` at end of scope must panic via the assert.
        tx.inner.take().unwrap().commit().await.unwrap();
        tx.committed = true;
        // `tx` drops here → Drop runs → debug_assert! fires.
    }

    /// A successfully *and correctly* committed `CommandTx` (queue drained
    /// by `commit_and_dispatch`) must drop cleanly — no panic. This is the
    /// false-positive guard for the assert: the happy path stays silent.
    #[tokio::test]
    async fn drop_after_clean_commit_does_not_trip_assert_654() {
        use crate::materializer::Materializer;

        let pool = bare_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut tx = CommandTx::begin_immediate(&pool, "test_clean_commit")
            .await
            .unwrap();
        tx.enqueue_background(fake_op_record());
        assert_eq!(tx.pending_len(), 1, "enqueue should populate pending");

        // `commit_and_dispatch` consumes `tx`, commits, sets `committed`,
        // and drains `pending` to zero before the value drops — so the
        // Drop assert sees `committed == true && pending.is_empty()` and
        // stays silent.
        let dispatched = tx
            .commit_and_dispatch(&materializer)
            .await
            .expect("commit_and_dispatch should succeed");
        assert_eq!(dispatched, 1, "the enqueued record should have dispatched");
        // No panic on drop ⇒ test passes.
    }

    /// #1316: the LEGITIMATE rollback-with-pending path. A `CommandTx` that
    /// enqueues a dispatch and is then dropped WITHOUT committing (the
    /// enqueue-then-`await?`-then-commit `Err` shape) must drop cleanly —
    /// `committed == false`, so the Drop assert does not fire, the inner
    /// transaction rolls back, and the queued record is discarded by design
    /// (no dispatch, no panic). The `tracing::debug!` added in #1316 is a
    /// pure side-channel and does not change this behaviour; we assert the
    /// observable contract: drop is silent (no panic) and nothing was
    /// dispatched.
    #[tokio::test]
    async fn drop_uncommitted_with_pending_does_not_dispatch_or_panic_1316() {
        let pool = bare_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_rollback_with_pending")
            .await
            .unwrap();
        tx.enqueue_background(fake_op_record());
        assert_eq!(tx.pending_len(), 1, "enqueue should populate pending");
        assert!(!tx.committed, "no commit method was called");

        // Drop without committing — simulates an `await?` returning `Err`
        // after the enqueue but before `commit_and_dispatch`. The inner
        // `sqlx::Transaction` rolls back via its own Drop; the pending queue
        // is discarded; no materializer is even involved, so no dispatch can
        // fire. The Drop debug-assert must NOT trip (committed == false).
        drop(tx);
        // Reaching here ⇒ no panic. The queued record was discarded, never
        // dispatched.
    }

    /// A DELETE that FAILS mid-transaction must roll back the ENTIRE
    /// `CommandTx` — including any op-log row appended earlier in the same
    /// transaction. This mirrors the real write-path command shape: append
    /// the op record, then mutate projected state; if that mutation errors
    /// the caller `?`-returns, the `CommandTx` drops uncommitted, and NOTHING
    /// (neither the op-log append nor the failed delete) may persist.
    ///
    /// The failure is induced with a `BEFORE DELETE` trigger that
    /// `RAISE(ABORT, …)` — a deterministic "delete fails" that does not
    /// depend on any particular production schema constraint (a poisoned
    /// transaction). We assert the op-log append is visible *inside* its own
    /// transaction (so the row genuinely reached the DB) and is *gone* after
    /// the rollback (so the append did not leak).
    #[tokio::test]
    async fn delete_failure_rolls_back_op_log_append() {
        use crate::db::init_pool;
        use tempfile::TempDir;

        const DEV: &str = "rollback-dev";
        const SEQ: i64 = 42;

        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();

        // Arrange an undeletable row: any DELETE against it aborts.
        sqlx::query("CREATE TABLE undeletable (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO undeletable (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER undeletable_guard BEFORE DELETE ON undeletable \
             BEGIN SELECT RAISE(ABORT, 'deletes forbidden'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Act: within ONE CommandTx, append an op-log row, then attempt the
        // forbidden delete. The `?` operator bubbles the delete error out of
        // the async block, dropping the CommandTx uncommitted — exactly what
        // a real command does when a projected-state write fails.
        let result: Result<(), sqlx::Error> = async {
            let mut tx = CommandTx::begin_immediate(&pool, "test_delete_rollback").await?;

            sqlx::query(
                "INSERT INTO op_log (seq, device_id, op_type, payload, created_at, hash) \
                 VALUES (?, ?, 'CreateBlock', '{}', '0', 'deadbeef')",
            )
            .bind(SEQ)
            .bind(DEV)
            .execute(&mut **tx)
            .await?;

            // The append IS visible inside its own still-open transaction:
            // the row really was written, so a later disappearance can only
            // be the rollback (not a silently-skipped insert).
            let in_tx: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ? AND seq = ?")
                    .bind(DEV)
                    .bind(SEQ)
                    .fetch_one(&mut **tx)
                    .await?;
            assert_eq!(in_tx, 1, "op-log append must be visible within its own tx");

            // This delete aborts via the trigger; `?` returns Err and drops
            // `tx` WITHOUT committing.
            sqlx::query("DELETE FROM undeletable WHERE id = 1")
                .execute(&mut **tx)
                .await?;

            tx.commit_without_dispatch().await?;
            Ok(())
        }
        .await;

        assert!(
            result.is_err(),
            "the forbidden delete must surface an error, forcing rollback"
        );

        // Assert: the transaction rolled back, so the earlier op-log append
        // did NOT persist.
        let persisted: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ? AND seq = ?")
                .bind(DEV)
                .bind(SEQ)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            persisted, 0,
            "a failed delete must roll back the op-log append (nothing persists)"
        );
    }
}
