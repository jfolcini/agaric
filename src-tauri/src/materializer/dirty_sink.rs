//! #643 — integration-agnostic "dirty data" seam between the
//! materializer's apply pipeline and downstream consumers (today: the
//! GCal push connector).
//!
//! ## Why a trait
//!
//! Before #643 the materializer's `apply_op` path named
//! `gcal_push::dirty_producer::{BlockDateSnapshot, snapshot_for_op,
//! compute_dirty_event}` directly: the core pipeline computed a
//! GCal-specific *dirty event* and handed it to the connector. That
//! coupled the materializer to one integration — the dirty-date mapping
//! (which property keys matter, the `[today, today + MAX_WINDOW_DAYS]`
//! window clamp, the old/new date split) lived in the wrong layer.
//!
//! [`DirtySink`] inverts the dependency. The materializer hands the sink
//! the *raw materialized data it already has* — the op [`OpRecord`] and a
//! pre-mutation [`DirtySnapshot`] captured inside the apply transaction —
//! and lets the sink compute whatever it needs behind the trait. The
//! materializer no longer names any `gcal_push::*` type in its internal
//! pipeline (`consumer.rs`, `handlers/`); the GCal-specific computation
//! lives wholly in `gcal_push` via its `impl DirtySink`.
//!
//! ## The two entry points
//!
//! 1. **Remote-op pipeline** (`consumer.rs` → `handlers/apply.rs`,
//!    `handlers/task_handlers.rs`): the consumer threads an
//!    `Arc<OnceLock<Arc<dyn DirtySink>>>`. Inside the apply tx it calls
//!    [`DirtySink::snapshot_for_op`] (a pre-mutation read) only when
//!    [`DirtySink::is_active`] — most installs never enable GCal, so the
//!    extra SELECT is skipped. After the tx commits it batches the
//!    `(record, snapshot)` pairs into [`DirtySink::notify`].
//!
//! 2. **Local-command path** (FEAT-5i, `commands/blocks/*`,
//!    `commands/properties.rs`, …): those handlers already hold the
//!    block id and snapshot the block themselves, then call
//!    [`Materializer::notify_gcal_for_op`](super::Materializer::notify_gcal_for_op).
//!    That public method funnels into [`DirtySink::notify`] through the
//!    same seam.
//!
//! ## Opaque snapshot
//!
//! The pipeline must capture a pre-mutation snapshot *before*
//! `apply_op_tx` runs (the mutation can clear the old value) and replay
//! it to the sink *after* commit. The materializer does not know — and
//! must not know — what that snapshot contains. [`DirtySnapshot`] is an
//! opaque `Box<dyn Any + Send>`: the sink produces it in
//! [`DirtySink::snapshot_for_op`] and downcasts it back in
//! [`DirtySink::notify`]. A sink that cannot match its own snapshot type
//! is a programmer error.

use crate::error::AppError;
use crate::op_log::OpRecord;
use std::any::Any;
use std::sync::Arc;

/// Opaque, integration-specific pre-mutation snapshot.
///
/// The materializer carries this between [`DirtySink::snapshot_for_op`]
/// (capture, inside the apply tx) and [`DirtySink::notify`] (replay,
/// after commit) without inspecting it. The concrete sink owns both the
/// boxing and the downcast.
pub type DirtySnapshot = Box<dyn Any + Send>;

/// One buffered `(op record, pre-mutation snapshot)` pair awaiting
/// post-commit emission.
///
/// The `record` is `Arc<OpRecord>` so the single-op apply path threads
/// it through as a cheap refcount bump rather than deep-cloning the
/// record's owned `String` payloads (PEND-25 L2 carried forward).
pub struct DirtyNotification {
    pub record: Arc<OpRecord>,
    pub snapshot: DirtySnapshot,
}

/// Integration-agnostic destination for "this op may have changed
/// projected state" signals emitted by the materializer's apply
/// pipeline.
///
/// Implemented in `gcal_push` for the GCal connector; the materializer
/// holds it as `Arc<dyn DirtySink + Send + Sync>` behind an `OnceLock`
/// set once at wiring time (see
/// [`Materializer::set_dirty_sink`](super::Materializer::set_dirty_sink)).
#[async_trait::async_trait]
pub trait DirtySink: Send + Sync {
    /// Whether this sink wants snapshots/notifications at all.
    ///
    /// The pipeline peeks this before paying for the pre-mutation
    /// snapshot SELECT (`snapshot_for_op`). A sink that is wired but
    /// dormant (e.g. GCal connected but with nothing to push) may still
    /// return `true`; the cost of a skipped snapshot is one extra
    /// in-memory default, so the predicate exists purely to spare the
    /// SELECT on the common "no integration wired" path. Defaults to
    /// `true` for sinks that always want the data.
    fn is_active(&self) -> bool {
        true
    }

    /// Capture the integration-specific pre-mutation snapshot for
    /// `record`, reading from the in-flight apply transaction `conn`.
    ///
    /// MUST run BEFORE `apply_op_tx` mutates the row, inside the same
    /// transaction, so the snapshot reflects the pre-image (the mutation
    /// may clear the value the sink needs). Errors propagate SQL
    /// failures only.
    async fn snapshot_for_op(
        &self,
        conn: &mut sqlx::SqliteConnection,
        record: &OpRecord,
    ) -> Result<DirtySnapshot, AppError>;

    /// Emit for every buffered `(record, snapshot)` pair.
    ///
    /// Callers MUST invoke this only AFTER the apply transaction has
    /// committed so the sink observes durable state. Fire-and-forget:
    /// the sink coalesces / dispatches internally and never blocks the
    /// apply path.
    fn notify(&self, events: Vec<DirtyNotification>);
}
