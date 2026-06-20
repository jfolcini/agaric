use sqlx::{Sqlite, SqlitePool};
use std::sync::Arc;

use super::pool::begin_immediate_logged;

/// Command-layer transaction wrapper that couples a `BEGIN IMMEDIATE`
/// SQLite transaction to the materializer-dispatch calls that must fire
/// after it commits.
///
/// (phase A): every write-path command previously repeated the
/// same three-step dance —
///
/// ```text
/// let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
/// // ... work ...
/// tx.commit().await?;
/// materializer.dispatch_background_or_warn(&op_record);
/// ```
///
/// This pattern appears in ~54 command-layer sites (35 raw
/// `begin_with("BEGIN IMMEDIATE")` + 19 already using
/// [`begin_immediate_logged`]) and pairs with 22 post-commit
/// `dispatch_background_or_warn` calls. Two failure modes are easy to
/// introduce and hard to review for:
///
/// 1. **Pre-commit dispatch.** Firing the background task before
///    `tx.commit().await?` can expose the not-yet-committed op-record to
///    the materializer. A follow-up commit failure then leaves the
///    materializer chasing an op that never lands.
/// 2. **Missing dispatch.** Forgetting the `dispatch_background_or_warn`
///    call leaves caches (`tags_cache`, `pages_cache`, FTS, block_links,
///    block_tag_inherited) stale until the next touch. Session 495's
///    H-5 / H-6 fixes were both in this class.
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
        })
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
    /// typical for batch operations such as [`crate::commands::history::revert_ops_inner`].
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
        self.take_inner().commit().await?;
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
        self.take_inner().commit().await?;
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
}
