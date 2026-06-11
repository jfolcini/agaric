use sqlx::{Sqlite, SqlitePool};
use std::sync::Arc;

use super::pool::begin_immediate_logged;

/// Command-layer transaction wrapper that couples a `BEGIN IMMEDIATE`
/// SQLite transaction to the materializer-dispatch calls that must fire
/// after it commits.
///
/// MAINT-112 (phase A): every write-path command previously repeated the
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
/// MAINT-112 phase B added a second dispatch variant —
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
/// PEND-25 L2 + L9: the inner `OpRecord` is held as `Arc<OpRecord>` so
/// command sites that need both the dispatch queue and a post-commit
/// `notify_gcal_for_op` borrow can share one record via refcount
/// instead of deep-cloning. The enqueue methods accept
/// `impl Into<Arc<OpRecord>>` so the existing call sites that hand off
/// a freshly-built `OpRecord` by value continue to compile unchanged
/// (the blanket `impl<T> From<T> for Arc<T>` makes the conversion
/// transparent).
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
    inner: sqlx::Transaction<'static, Sqlite>,
    /// Op records to dispatch to the materializer once the transaction
    /// commits successfully. FIFO order — `commit_and_dispatch` drains
    /// them in enqueue order.
    pending: Vec<PendingDispatch>,
    /// Label used by [`begin_immediate_logged`] for slow-acquire logs.
    /// Stored here only so diagnostic code (future: a debug-assert on
    /// Drop with a pending queue) can name the originating command.
    #[expect(
        dead_code,
        reason = "stored for a planned Drop-time debug-assert that names the originating command"
    )]
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
            inner,
            pending: Vec::new(),
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
    /// PEND-25 L9: accepts `impl Into<Arc<OpRecord>>` so callers can pass
    /// either a fresh `OpRecord` by value (Rust's blanket
    /// `impl<T> From<T> for Arc<T>` does the wrap) or an existing
    /// `Arc<OpRecord>` they need to share with a post-commit borrow
    /// (e.g. `materializer.notify_gcal_for_op(&op_record, ...)`).
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
    /// PEND-25 L9: see [`Self::enqueue_background`] — same `Into<Arc<…>>`
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
    /// Returns the number of dispatches that fired. Dispatch failures
    /// are logged at warn level and do not surface here.
    pub async fn commit_and_dispatch(
        mut self,
        materializer: &crate::materializer::Materializer,
    ) -> Result<usize, sqlx::Error> {
        self.inner.commit().await?;
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
        self.inner.commit().await?;
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
        self.inner.rollback().await
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

impl std::ops::Deref for CommandTx {
    type Target = sqlx::Transaction<'static, Sqlite>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl std::ops::DerefMut for CommandTx {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}
