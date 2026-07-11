//! Persistent retry queue for failed background materializer tasks.
//!
//! In-memory retries (`run_background` in `consumer.rs`) cover transient WAL
//! lock contention, but a cache-rebuild task that keeps failing past the
//! retry budget would historically be silently dropped — leaving per-block
//! caches permanently stale. This module persists exhausted tasks to
//! `materializer_retry_queue` so a periodic sweeper can re-enqueue them on
//! an exponential backoff.
//!
//! Scope: idempotent per-block tasks (`UpdateFtsBlock`,
//! `ReindexBlockLinks`, `ReindexBlockTagRefs`) AND idempotent global
//! cache rebuilds (`RebuildTagsCache`, `RebuildPagesCache`,
//! `RebuildAgendaCache`, `RebuildProjectedAgendaCache`,
//! `RebuildTagInheritanceCache`, `RebuildPageIds`,
//! `RebuildBlockTagRefsCache`). The latter were silently dropped on
//! queue saturation prior to they're now persisted under the
//! sentinel `block_id = '__GLOBAL__'` so the sweeper re-enqueues them on
//! the same exponential-backoff schedule.
//!
//! Backoff schedule: 1 min → 5 min → 30 min → 1 h (cap).
//!
//! ## Two-tier retry semantics
//!
//! This persistent schedule is the **second tier** of the materializer's
//! retry pipeline. The first tier — the in-memory
//! [`super::consumer::retry_with_backoff`] loop — runs on a much shorter
//! ms-scale budget (foreground: 1 retry × 100 ms; background: 2 retries
//! × 150/300 ms exponential) and clears transient WAL contention before
//! the task ever reaches `materializer_retry_queue`. The handoff:
//!
//! 1. `run_background` invokes the task via `retry_with_backoff` with
//!    its in-memory schedule.
//! 2. On exhaustion (`outcome.succeeded == false`), an idempotent
//!    per-block task is passed to [`record_failure`], which appends or
//!    bumps a row in `materializer_retry_queue`.
//! 3. The boot-time / periodic sweeper reads rows whose
//!    `next_attempt_at <= now()` and re-enqueues them onto the live
//!    background queue, where the first tier runs again.
//!
//! Both tiers are observability-instrumented but otherwise independent:
//! tightening one schedule does not change the other. See the module
//! doc-comment on [`super::consumer`] for the full table.

use crate::error::AppError;
use crate::materializer::MaterializeTask;
use sqlx::SqlitePool;
use std::borrow::Cow;
use std::sync::Arc;
use tracing::instrument;

/// Sentinel literal stored in the `block_id` column for global cache
/// Rebuild tasks. SQLite's `STRICT` mode forbids `NULL` in
/// `PRIMARY KEY` columns, so a literal stand-in is used instead. The
/// sentinel cannot collide with a real ULID block id (ULIDs are
/// 26-char Crockford base32 uppercase; the sentinel is lowercase
/// + underscores).
pub(crate) const GLOBAL_TASK_SENTINEL: &str = "__GLOBAL__";

/// Sentinel literal stored in the `block_id` column for foreground
/// `ApplyOp` failure rows. Mirrors [`GLOBAL_TASK_SENTINEL`]:
/// the composite key for an apply-op failure is
/// `(device_id, seq)`, packed into the `task_kind` column as
/// `"ApplyOp:<seq>:<device_id>"`. The sentinel cannot collide with a
/// real ULID block id (ULIDs are 26-char Crockford base32 uppercase;
/// the sentinel is lowercase + underscores).
pub(crate) const APPLY_OP_TASK_SENTINEL: &str = "__APPLY_OP__";

/// #2541: distinct `last_error` marker for a task persisted because it was
/// SHED at enqueue time (`try_enqueue_background` hit a full channel) — the
/// task never executed, so this is a capacity signal, not an execution
/// failure. [`give_up_reason`] consults the marker to keep shed-driven
/// `attempts` increments from burning the `MAX_ATTEMPTS` give-up budget:
/// under sustained backpressure a task could previously hit the give-up
/// threshold with ZERO executions and be permanently dropped. This is a
/// value-level convention on the existing nullable `last_error` column — no
/// schema change; the `attempts` column still counts every persistence
/// (shed or execution failure), only the give-up guard's interpretation
/// changes.
pub(crate) const SHED_LAST_ERROR: &str = "shed: background queue full (task never executed)";

/// Task kinds that may be persisted to the retry queue.
///
/// Three families:
/// - **Per-block** idempotent tasks (`UpdateFtsBlock`,
///   `ReindexBlockLinks`, `ReindexBlockTagRefs`) — keyed by their
///   real block id.
///   **Global** cache rebuilds — keyed by the
///   [`GLOBAL_TASK_SENTINEL`] literal so the composite primary key
///   `(block_id, task_kind)` enforces dedup naturally without
///   requiring a NULL column.
///   **Foreground apply-op** failures — keyed by the
///   composite `(device_id, seq)` packed into the `task_kind` column
///   as `"ApplyOp:<seq>:<device_id>"`, with `block_id` set to
///   [`APPLY_OP_TASK_SENTINEL`]. Reconstruction requires a fresh
///   `OpRecord` lookup against `op_log` (handled in [`sweep_once`]).
///
/// The enum carries owned data on the apply-op variant, so
/// `RetryKind` is no longer `Copy`. Methods take `&self`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RetryKind {
    // --- Per-block ---
    UpdateFtsBlock,
    ReindexBlockLinks,
    /// Incremental `#[ULID]` tag-ref reindex for a single block.
    ReindexBlockTagRefs,
    /// #676: scoped single-tag `usage_count` refresh. Keyed by `tag_id`
    /// (not a global sentinel) so failures of different tags' refreshes
    /// dedup independently and reconstruct the right scoped task.
    RefreshTagUsageCount,
    // --- Global ---
    /// Mirror of [`MaterializeTask::RebuildTagsCache`].
    RebuildTagsCache,
    /// Mirror of [`MaterializeTask::RebuildPagesCache`].
    RebuildPagesCache,
    /// Mirror of [`MaterializeTask::RebuildPagesCacheCounts`] (#417).
    RebuildPagesCacheCounts,
    /// Mirror of [`MaterializeTask::RebuildAgendaCache`].
    RebuildAgendaCache,
    /// Mirror of [`MaterializeTask::RebuildProjectedAgendaCache`].
    RebuildProjectedAgendaCache,
    /// Mirror of [`MaterializeTask::RebuildTagInheritanceCache`].
    RebuildTagInheritanceCache,
    /// Mirror of [`MaterializeTask::RebuildPageIds`].
    RebuildPageIds,
    /// Mirror of [`MaterializeTask::SetBlockPageId`].
    SetBlockPageId,
    /// Mirror of [`MaterializeTask::RebuildBlockTagRefsCache`].
    RebuildBlockTagRefsCache,
    /// Mirror of [`MaterializeTask::RebuildPageLinkCache`] (SQL-review §H-2).
    RebuildPageLinkCache,
    // --- Foreground apply-op ---
    /// Mirror of a failed [`MaterializeTask::ApplyOp`] task whose
    /// foreground retry budget was exhausted. Identifies the op by
    /// its `(device_id, seq)` coordinates so the sweeper can re-load
    /// the `OpRecord` from `op_log` and re-enqueue onto the
    /// foreground queue. `BatchApplyOps` failures persist one
    /// `ApplyOp` row per record in the batch.
    ApplyOp {
        device_id: String,
        seq: i64,
    },
}

impl RetryKind {
    /// String form of the kind suitable for binding to the
    /// `task_kind` column of `materializer_retry_queue`.
    ///
    /// For unit variants this is a static `&'static str`; for
    /// [`Self::ApplyOp`] this is the dynamic
    /// `"ApplyOp:<seq>:<device_id>"` packing, returned as
    /// [`Cow::Owned`].
    pub(crate) fn task_kind_str(&self) -> Cow<'static, str> {
        match self {
            Self::UpdateFtsBlock => Cow::Borrowed("UpdateFtsBlock"),
            Self::ReindexBlockLinks => Cow::Borrowed("ReindexBlockLinks"),
            Self::ReindexBlockTagRefs => Cow::Borrowed("ReindexBlockTagRefs"),
            Self::RefreshTagUsageCount => Cow::Borrowed("RefreshTagUsageCount"),
            Self::RebuildTagsCache => Cow::Borrowed("RebuildTagsCache"),
            Self::RebuildPagesCache => Cow::Borrowed("RebuildPagesCache"),
            Self::RebuildPagesCacheCounts => Cow::Borrowed("RebuildPagesCacheCounts"),
            Self::RebuildAgendaCache => Cow::Borrowed("RebuildAgendaCache"),
            Self::RebuildProjectedAgendaCache => Cow::Borrowed("RebuildProjectedAgendaCache"),
            Self::RebuildTagInheritanceCache => Cow::Borrowed("RebuildTagInheritanceCache"),
            Self::RebuildPageIds => Cow::Borrowed("RebuildPageIds"),
            Self::SetBlockPageId => Cow::Borrowed("SetBlockPageId"),
            Self::RebuildBlockTagRefsCache => Cow::Borrowed("RebuildBlockTagRefsCache"),
            Self::RebuildPageLinkCache => Cow::Borrowed("RebuildPageLinkCache"),
            Self::ApplyOp { device_id, seq } => Cow::Owned(format!("ApplyOp:{seq}:{device_id}")),
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        // Static-name fast path (covers per-block + global variants).
        match s {
            "UpdateFtsBlock" => return Some(Self::UpdateFtsBlock),
            "ReindexBlockLinks" => return Some(Self::ReindexBlockLinks),
            "ReindexBlockTagRefs" => return Some(Self::ReindexBlockTagRefs),
            "RefreshTagUsageCount" => return Some(Self::RefreshTagUsageCount),
            "RebuildTagsCache" => return Some(Self::RebuildTagsCache),
            "RebuildPagesCache" => return Some(Self::RebuildPagesCache),
            "RebuildPagesCacheCounts" => return Some(Self::RebuildPagesCacheCounts),
            "RebuildAgendaCache" => return Some(Self::RebuildAgendaCache),
            "RebuildProjectedAgendaCache" => return Some(Self::RebuildProjectedAgendaCache),
            "RebuildTagInheritanceCache" => return Some(Self::RebuildTagInheritanceCache),
            "RebuildPageIds" => return Some(Self::RebuildPageIds),
            "SetBlockPageId" => return Some(Self::SetBlockPageId),
            "RebuildBlockTagRefsCache" => return Some(Self::RebuildBlockTagRefsCache),
            "RebuildPageLinkCache" => return Some(Self::RebuildPageLinkCache),
            _ => {}
        }
        // Composite-key path: apply-op failures encoded as
        // `"ApplyOp:<seq>:<device_id>"`. `splitn(3, ':')` keeps the
        // device_id intact even if it contains further `:` chars.
        let mut parts = s.splitn(3, ':');
        match (parts.next(), parts.next(), parts.next()) {
            (Some("ApplyOp"), Some(seq_str), Some(device_id)) if !device_id.is_empty() => {
                let seq: i64 = seq_str.parse().ok()?;
                Some(Self::ApplyOp {
                    device_id: device_id.to_string(),
                    seq,
                })
            }
            _ => None,
        }
    }

    /// True for global cache rebuilds — they ignore the row's
    /// `block_id` column (which holds [`GLOBAL_TASK_SENTINEL`]) when
    /// reconstructing the [`MaterializeTask`].
    pub(crate) fn is_global(&self) -> bool {
        matches!(
            self,
            Self::RebuildTagsCache
                | Self::RebuildPagesCache
                | Self::RebuildPagesCacheCounts
                | Self::RebuildAgendaCache
                | Self::RebuildProjectedAgendaCache
                | Self::RebuildTagInheritanceCache
                | Self::RebuildPageIds
                | Self::RebuildBlockTagRefsCache
                | Self::RebuildPageLinkCache
        )
    }

    /// Reconstruct a [`MaterializeTask`] from the persisted row,
    /// when the variant carries enough information on its own.
    ///
    /// For per-block kinds, `block_id` is the real block id read off
    /// the row. For global kinds, callers pass [`GLOBAL_TASK_SENTINEL`]
    /// (or any string — the value is ignored). For
    /// [`Self::ApplyOp`], reconstruction requires loading the
    /// `OpRecord` from `op_log` (sweep-side concern), so this method
    /// returns `None` for that arm — callers must dispatch on the
    /// variant before invoking [`Self::to_task`].
    pub(crate) fn to_task(&self, block_id: String) -> Option<MaterializeTask> {
        match self {
            Self::UpdateFtsBlock => Some(MaterializeTask::UpdateFtsBlock {
                block_id: Arc::from(block_id),
            }),
            Self::ReindexBlockLinks => Some(MaterializeTask::ReindexBlockLinks {
                block_id: Arc::from(block_id),
            }),
            Self::ReindexBlockTagRefs => Some(MaterializeTask::ReindexBlockTagRefs {
                block_id: Arc::from(block_id),
            }),
            // #676: the persisted `block_id` column holds the tag id for
            // this scoped task (it is NOT global).
            Self::RefreshTagUsageCount => Some(MaterializeTask::RefreshTagUsageCount {
                tag_id: Arc::from(block_id),
            }),
            // Global rebuilds carry no block id; the row's sentinel is
            // discarded on reconstruction.
            Self::RebuildTagsCache => Some(MaterializeTask::RebuildTagsCache),
            Self::RebuildPagesCache => Some(MaterializeTask::RebuildPagesCache),
            Self::RebuildPagesCacheCounts => Some(MaterializeTask::RebuildPagesCacheCounts),
            Self::RebuildAgendaCache => Some(MaterializeTask::RebuildAgendaCache),
            Self::RebuildProjectedAgendaCache => Some(MaterializeTask::RebuildProjectedAgendaCache),
            Self::RebuildTagInheritanceCache => Some(MaterializeTask::RebuildTagInheritanceCache),
            Self::RebuildPageIds => Some(MaterializeTask::RebuildPageIds),
            Self::SetBlockPageId => Some(MaterializeTask::SetBlockPageId {
                block_id: Arc::from(block_id),
            }),
            Self::RebuildBlockTagRefsCache => Some(MaterializeTask::RebuildBlockTagRefsCache),
            Self::RebuildPageLinkCache => Some(MaterializeTask::RebuildPageLinkCache),
            // ApplyOp requires `OpRecord` lookup from `op_log`.
            Self::ApplyOp { .. } => None,
        }
    }

    /// Extract retry kind + persistable `block_id` from a
    /// [`MaterializeTask`] if it is retryable. Returns `None` for
    /// non-retryable tasks (`BatchApplyOps`, `Barrier`,
    /// `RebuildFtsIndex`, `FtsOptimize`, `CleanupOrphanedAttachments`,
    /// `ReindexFtsReferences`, `RemoveFtsBlock`).
    ///
    /// For per-block variants, returns the block id as a `String` for
    /// direct binding to the retry-queue SQL writes; the inbound
    /// `Arc<str>` is materialised once on the failure path (cold),
    /// keeping the hot in-memory task-clone path Arc-only. For global
    /// variants, returns the [`GLOBAL_TASK_SENTINEL`] literal so the
    /// composite PK `(block_id, task_kind)` dedups failures of the
    /// same global task without ambiguity. For foreground apply-op
    /// Variants, returns the [`APPLY_OP_TASK_SENTINEL`]
    /// literal — the per-op identity is encoded in the kind itself
    /// (`device_id` + `seq`) and surfaces via [`Self::task_kind_str`].
    ///
    /// `BatchApplyOps` returns `None` here because a batch failure
    /// must persist *one row per record*, not a single composite —
    /// callers iterate the batch and call [`record_failure`] per
    /// record wrapped as [`MaterializeTask::ApplyOp`].
    pub(crate) fn from_task(task: &MaterializeTask) -> Option<(Self, String)> {
        match task {
            MaterializeTask::UpdateFtsBlock { block_id } => {
                Some((Self::UpdateFtsBlock, block_id.to_string()))
            }
            MaterializeTask::ReindexBlockLinks { block_id } => {
                Some((Self::ReindexBlockLinks, block_id.to_string()))
            }
            MaterializeTask::ReindexBlockTagRefs { block_id } => {
                Some((Self::ReindexBlockTagRefs, block_id.to_string()))
            }
            // #676: persist keyed by `tag_id` (the composite PK
            // `(block_id, task_kind)` dedups per-tag, not globally).
            MaterializeTask::RefreshTagUsageCount { tag_id } => {
                Some((Self::RefreshTagUsageCount, tag_id.to_string()))
            }
            MaterializeTask::RebuildTagsCache => {
                Some((Self::RebuildTagsCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::RebuildPagesCache => {
                Some((Self::RebuildPagesCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::RebuildPagesCacheCounts => Some((
                Self::RebuildPagesCacheCounts,
                GLOBAL_TASK_SENTINEL.to_string(),
            )),
            MaterializeTask::RebuildAgendaCache => {
                Some((Self::RebuildAgendaCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::RebuildProjectedAgendaCache => Some((
                Self::RebuildProjectedAgendaCache,
                GLOBAL_TASK_SENTINEL.to_string(),
            )),
            MaterializeTask::RebuildTagInheritanceCache => Some((
                Self::RebuildTagInheritanceCache,
                GLOBAL_TASK_SENTINEL.to_string(),
            )),
            MaterializeTask::RebuildPageIds => {
                Some((Self::RebuildPageIds, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::SetBlockPageId { block_id } => {
                Some((Self::SetBlockPageId, block_id.to_string()))
            }
            MaterializeTask::RebuildBlockTagRefsCache => Some((
                Self::RebuildBlockTagRefsCache,
                GLOBAL_TASK_SENTINEL.to_string(),
            )),
            MaterializeTask::RebuildPageLinkCache => {
                Some((Self::RebuildPageLinkCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::ApplyOp(record) => Some((
                Self::ApplyOp {
                    device_id: record.device_id.clone(),
                    seq: record.seq,
                },
                APPLY_OP_TASK_SENTINEL.to_string(),
            )),
            _ => None,
        }
    }
}

/// Compute the next attempt timestamp for a task with `attempts` prior
/// failures (including the one we just recorded). Schedule:
///   1 → +1 min, 2 → +5 min, 3 → +30 min, 4+ → +1 hour cap.
pub(crate) fn backoff_delay_for(attempts: i64) -> chrono::Duration {
    match attempts {
        ..=1 => chrono::Duration::minutes(1),
        2 => chrono::Duration::minutes(5),
        3 => chrono::Duration::minutes(30),
        _ => chrono::Duration::hours(1),
    }
}

/// Record a task that failed all in-memory retries. Inserts a new row or
/// updates the existing row (incrementing `attempts`, extending the
/// backoff). Non-retryable tasks are silently ignored.
///
/// Global cache rebuilds (`RebuildTagsCache`, etc.) are
/// recorded with `block_id = '__GLOBAL__'` so the composite PK
/// `(block_id, task_kind)` dedups failures of the same rebuild without
/// requiring a NULL column. Per-block tasks pass through unchanged.
///
/// Implemented as a single `INSERT... ON CONFLICT(block_id,
/// task_kind) DO UPDATE` that increments `attempts` SQL-side via
/// `materializer_retry_queue.attempts + 1` (instead of binding the new
/// value from a prior `SELECT`). This eliminates the SELECT-then-INSERT
/// race where two concurrent failure inserts both observe `prior = None`,
/// both compute `attempts = 1`, and both INSERT — the second triggering
/// `ON CONFLICT` and overwriting with the same `excluded.attempts = 1`,
/// silently losing one increment.
///
/// R3 (#347): the backoff is now folded into the same statement. The
/// previous form learned `attempts` via `RETURNING` and, on the
/// escalation path, issued a *second* non-atomic `UPDATE` to fix
/// `next_attempt_at` — a window where the row was visible to the sweeper
/// with the wrong (too-short) backoff. A `CASE` on the post-increment
/// `attempts + 1` computes the correct delay inline, so the whole
/// failure record is one atomic statement (and one round-trip) for both
/// the first-failure and escalation paths. The `CASE` mirrors
/// [`backoff_delay_for`] step-for-step:
///   attempts 1 → +1 min, 2 → +5 min, 3 → +30 min, 4+ → +1 hour.
///
/// Issue #378: the `DO UPDATE` branch deliberately does NOT assign
/// `created_at`, so the original first-failure timestamp is preserved
/// across every re-failure. Combined with the sweeper no longer
/// pre-clearing the row on enqueue (it leases instead — see
/// [`lease_entry`] / [`sweep_once`]), a fail-on-run task now keeps the
/// SAME row across cycles: `attempts` accumulates (1, 2, 3, …) and
/// `created_at` ages, so both `give_up_reason` triggers
/// (`attempts >= MAX_ATTEMPTS`, `now - created_at >= GIVE_UP_AGE_DAYS`)
/// can finally fire. The `created_at` default (migration 0077) only
/// applies on the INSERT (first-failure) branch.
pub(crate) async fn record_failure(
    pool: &SqlitePool,
    task: &MaterializeTask,
    last_error: &str,
    metrics: &super::metrics::QueueMetrics,
) -> Result<(), AppError> {
    let Some((kind, block_id)) = RetryKind::from_task(task) else {
        return Ok(());
    };
    let kind_string = kind.task_kind_str();
    let kind_str: &str = kind_string.as_ref();

    // #109 Phase 2: next_attempt_at is epoch-ms. The backoff schedule is
    // computed SQL-side from the post-increment attempts count so the
    // INSERT and DO UPDATE branches stay consistent and atomic. The four
    // delay constants are bound from `backoff_delay_for` to keep the
    // schedule defined in exactly one place (the Rust fn) — the
    // `retry_backoff_matches_schedule` test asserts the SQL CASE and the
    // fn agree.
    let now = crate::db::now_ms();
    let d1 = backoff_delay_for(1).num_milliseconds();
    let d2 = backoff_delay_for(2).num_milliseconds();
    let d3 = backoff_delay_for(3).num_milliseconds();
    let d4 = backoff_delay_for(4).num_milliseconds();
    // First-failure INSERT lands attempts = 1 → delay d1.
    let initial_next_attempt = now + d1;

    let row = sqlx::query!(
        "INSERT INTO materializer_retry_queue \
             (block_id, task_kind, attempts, last_error, next_attempt_at) \
         VALUES (?1, ?2, 1, ?3, ?4) \
         ON CONFLICT(block_id, task_kind) DO UPDATE SET \
             attempts = materializer_retry_queue.attempts + 1, \
             last_error = excluded.last_error, \
             next_attempt_at = ?5 + CASE materializer_retry_queue.attempts + 1 \
                 WHEN 1 THEN ?6 \
                 WHEN 2 THEN ?7 \
                 WHEN 3 THEN ?8 \
                 ELSE ?9 \
             END \
         RETURNING attempts AS \"attempts!: i64\", next_attempt_at AS \"next_attempt_at!: i64\"",
        block_id,
        kind_str,
        last_error,
        initial_next_attempt,
        now,
        d1,
        d2,
        d3,
        d4,
    )
    .fetch_one(pool)
    .await?;

    // #2187: bump the pending-retry gauge ONLY on the INSERT (fresh-row)
    // branch. The UPSERT's `RETURNING attempts` disambiguates the two
    // branches: a first-failure INSERT lands `attempts == 1`, while the
    // `DO UPDATE` branch increments an existing row so it always returns
    // `attempts >= 2`. A DO UPDATE did not add a row, so the gauge must
    // not move for it.
    if row.attempts == 1 {
        metrics.note_retry_row_inserted();
    }

    tracing::warn!(
        block_id = %block_id,
        task_kind = kind_str,
        attempts = row.attempts,
        next_attempt_at = %row.next_attempt_at,
        "persisted failed background task to retry queue"
    );
    Ok(())
}

/// Count of pending retry rows — used for observability (via
/// `bg_dropped` / `StatusInfo`).
///
/// I-Materializer-2: visibility tightened from `pub` to `pub(crate)` to
/// match the sibling helpers in this module (`record_failure`,
/// `fetch_due`, `clear_entry`, `task_from_row`, `RetryKind`). Only
/// `sweep_once` and `spawn_sweeper` retain `pub` because they are the
/// documented integration points for the rest of the crate. The
/// `cfg_attr(not(test), allow(dead_code))` keeps lib-only builds quiet
/// while preserving the function for the planned `StatusInfo` wiring;
/// it is exercised by the unit tests in this module.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn pending_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let n = sqlx::query_scalar!("SELECT COUNT(*) as \"n!: i64\" FROM materializer_retry_queue")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

/// Issue #157 sub-item D — give-up trigger thresholds.
///
/// A row hitting either trigger is permanently dropped by the sweeper:
/// the underlying task is no longer retried, the row is deleted, the
/// give-up is logged with the trigger reason, and
/// `metrics.retry_queue_giveup_total` increments. The two triggers exist
/// because they cover different shapes of "this will never succeed":
///
/// - `MAX_ATTEMPTS` bounds the *active* failure case — a task that keeps
///   landing in the retry queue and being re-tried. The 2026-05-19 log
///   spike (8286 warn lines from one permanently-broken op looping every
///   60 s for days) is the canonical example.
/// - `GIVE_UP_AGE_DAYS` bounds the *stale* case — a row whose
///   `next_attempt_at` is so far in the past relative to `created_at`
///   that it has clearly been abandoned (a sync replay against a peer
///   that's been offline for a week, an op that depends on a block the
///   user has since permanently purged, etc.). Without this clock-based
///   trigger, a row with `attempts < MAX_ATTEMPTS` could sit in the
///   queue forever if the sweeper kept hitting transient enqueue
///   failures.
const MAX_ATTEMPTS: i64 = 10;
const GIVE_UP_AGE_DAYS: i64 = 7;

/// Issue #157 sub-item D — return the give-up trigger reason for a row,
/// or `None` if the row should still be retried.
///
/// `attempts` exceeding [`MAX_ATTEMPTS`] takes precedence over age — a
/// permanently-failing task is the canonical case the trigger was
/// designed for, and the metric/log labels are more useful with the
/// failure-count signal when both apply.
///
/// A future `created_at` (clock skew) yields a negative age and is treated
/// as fresh — the conservative bias of the rest of the module.
///
/// #2541: a row whose most recent persistence was a SHED
/// ([`SHED_LAST_ERROR`]) is exempt from the `max_attempts` trigger — its
/// latest `attempts` increments came from queue saturation, not from the
/// task actually running and failing, so dropping it would permanently lose
/// a task that may have ZERO executions. The moment the task runs and fails
/// for real, `record_failure` overwrites `last_error` with the execution
/// error and the trigger arms again. The `age_exceeded` trigger still
/// applies unconditionally: it bounds abandonment by wall clock, which a
/// shed loop should not evade forever.
fn give_up_reason(row: &DueRow) -> Option<&'static str> {
    let last_was_shed = row.last_error.as_deref() == Some(SHED_LAST_ERROR);
    if row.attempts >= MAX_ATTEMPTS && !last_was_shed {
        return Some("max_attempts");
    }
    // #109 Phase 2: created_at is epoch-ms — age is plain integer subtraction.
    let age_ms = crate::db::now_ms() - row.created_at;
    if age_ms >= GIVE_UP_AGE_DAYS * 86_400_000 {
        return Some("age_exceeded");
    }
    None
}

/// One due row ready to be retried.
pub(crate) struct DueRow {
    pub block_id: String,
    pub task_kind: String,
    /// Number of times this task has already been retried — gates the
    /// `MAX_ATTEMPTS` give-up trigger in [`sweep_once`].
    pub attempts: i64,
    /// Epoch-ms timestamp the row was first persisted (#109 Phase 2) — gates
    /// the `GIVE_UP_AGE_DAYS` give-up trigger in [`sweep_once`].
    pub created_at: i64,
    /// The most recent failure recorded by `record_failure`. #2541: read so
    /// [`give_up_reason`] can exempt shed-persisted rows
    /// ([`SHED_LAST_ERROR`]) from the `max_attempts` budget.
    pub last_error: Option<String>,
}

/// Return rows where `next_attempt_at <= now`, up to `limit` entries.
/// Uses the read pool; the sweeper re-enqueues them via the normal
/// background queue path. Cap to avoid flooding the queue.
pub(crate) async fn fetch_due(pool: &SqlitePool, limit: i64) -> Result<Vec<DueRow>, AppError> {
    let now = crate::db::now_ms();
    let rows = sqlx::query!(
        // IX1 (#347): `(block_id, task_kind)` tiebreaker makes the swept
        // order deterministic under `LIMIT` — an equal-`next_attempt_at`
        // pool would otherwise drain in engine-dependent order, starving
        // some rows across sweeps. The trio
        // `(next_attempt_at, block_id, task_kind)` is exactly the covering
        // index `idx_materializer_retry_queue_due` (migration 0063), so
        // the added sort keys are satisfied by the index — no extra sort.
        "SELECT block_id, task_kind, attempts, created_at, last_error \
         FROM materializer_retry_queue \
         WHERE next_attempt_at <= ? \
         ORDER BY next_attempt_at ASC, block_id ASC, task_kind ASC LIMIT ?",
        now,
        limit,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| DueRow {
            block_id: r.block_id,
            task_kind: r.task_kind,
            attempts: r.attempts,
            created_at: r.created_at,
            last_error: r.last_error,
        })
        .collect())
}

/// Delete a retry row after a confirmed, durable successful re-run.
///
/// Issue #378: this is the canonical clear site. It is called from the
/// consumer's *durable-success* path (after the apply/work has been
/// committed) for any task that is retryable
/// ([`RetryKind::from_task`] returns `Some`), and from [`sweep_once`]
/// only on the give-up / unknown-kind retirement paths. The sweeper no
/// longer pre-clears a row on successful *enqueue* — see
/// [`lease_entry`] and the [`sweep_once`] doc-comment for why that broke
/// attempt accumulation and the give-up triggers (the issue #157 / #378
/// infinite-loop pathology).
pub(crate) async fn clear_entry(
    pool: &SqlitePool,
    block_id: &str,
    task_kind: &str,
    metrics: &super::metrics::QueueMetrics,
) -> Result<(), AppError> {
    let result = sqlx::query!(
        "DELETE FROM materializer_retry_queue WHERE block_id = ? AND task_kind = ?",
        block_id,
        task_kind,
    )
    .execute(pool)
    .await?;
    // #2187: floor the pending-retry gauge by however many rows the DELETE
    // actually removed (0 or 1 for this keyed delete).
    metrics.note_retry_rows_deleted(result.rows_affected());
    Ok(())
}

/// Issue #378: clear the retry row for a task that has just completed
/// **durably and successfully** on a sweep-driven re-run.
///
/// This is a thin wrapper over [`clear_entry`] that first checks the
/// task is retryable (so callers on the hot consumer success path can
/// blindly hand it any [`MaterializeTask`] — non-retryable tasks never
/// created a row and are a cheap no-op). It is the ONLY confirmed-success
/// clear site now that [`sweep_once`] leases instead of pre-clearing.
///
/// MUST be called only after the work is committed — clearing before
/// durable success risks losing the retry entry on a crash, trading the
/// old infinite-retry bug for a silent never-retry. See the consumer
/// success-path call sites in `consumer.rs`.
pub(crate) async fn clear_on_success(
    pool: &SqlitePool,
    task: &MaterializeTask,
    metrics: &super::metrics::QueueMetrics,
) -> Result<(), AppError> {
    let Some((kind, block_id)) = RetryKind::from_task(task) else {
        return Ok(());
    };
    // #2187: fast-path skip. The overwhelming majority of tasks never fail,
    // so the retry queue is almost always empty and this per-success DELETE
    // is pure waste. Consult the pending-retry gauge and skip the DELETE
    // entirely when it says there is nothing to clear. The gauge is only
    // ever read to SKIP work, so its bias is safe: a stale-high value costs
    // one idempotent (0-row) DELETE, and a stale-low value self-heals
    // because the periodic sweeper re-clears any leftover row on its next
    // pass (see the gauge's field docs in metrics.rs).
    if !metrics.has_pending_retry_rows() {
        return Ok(());
    }
    clear_entry(pool, &block_id, kind.task_kind_str().as_ref(), metrics).await
}

/// Issue #378: lease a due row by pushing its `next_attempt_at` forward
/// so the sweeper does not re-sweep (double-dispatch) the same row while
/// the just-enqueued re-run is still in flight.
///
/// The lease interval reuses the existing backoff schedule
/// ([`backoff_delay_for`]) keyed on the row's *current* `attempts`. The
/// minimum delay in that schedule is 1 minute, which equals the
/// sweeper's tick interval (`spawn_sweeper`, 60 s), so a leased row is
/// never visible to the very next sweep tick — by which time the
/// re-run's in-memory retry budget (sub-second) has long since resolved
/// and, on failure, `record_failure` has already bumped `next_attempt_at`
/// to its own (longer) backoff. The lease is therefore a lower bound: a
/// subsequent `record_failure` UPSERT overwrites it with the
/// attempts-appropriate delay, and a subsequent `clear_on_success`
/// deletes the row outright.
///
/// Unlike `record_failure`, the lease does NOT touch `attempts`,
/// `last_error`, or `created_at` — it only moves the visibility window so
/// the same in-flight task is not swept twice. Attempt accumulation and
/// `created_at` aging are owned exclusively by `record_failure`.
pub(crate) async fn lease_entry(
    pool: &SqlitePool,
    block_id: &str,
    task_kind: &str,
    attempts: i64,
) -> Result<(), AppError> {
    let next_attempt_at = crate::db::now_ms() + backoff_delay_for(attempts).num_milliseconds();
    sqlx::query!(
        "UPDATE materializer_retry_queue SET next_attempt_at = ? \
         WHERE block_id = ? AND task_kind = ?",
        next_attempt_at,
        block_id,
        task_kind,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Build a [`MaterializeTask`] from a persisted row. Returns `None` for
/// unknown `task_kind` strings (migration-forward safety) **and** for
/// [`RetryKind::ApplyOp`] rows (which need an additional
/// `OpRecord` lookup against `op_log` — handled inside [`sweep_once`]).
///
/// For global rebuild kinds (`RebuildTagsCache`, etc.), the
/// row's `block_id` (which holds [`GLOBAL_TASK_SENTINEL`]) is passed
/// through to `to_task` and ignored on reconstruction. Per-block kinds
/// use the row's real block id.
pub(crate) fn task_from_row(row: &DueRow) -> Option<MaterializeTask> {
    let kind = RetryKind::from_str(&row.task_kind)?;
    kind.to_task(row.block_id.clone())
}

/// Scan the retry queue once: fetch due rows, re-enqueue each via the
/// materializer's normal background queue, and on successful enqueue
/// *lease* the row (push `next_attempt_at` forward) rather than deleting
/// it. Failures to enqueue leave the row in place so the next sweep can
/// try again.
///
/// Issue #378: the row is intentionally NOT cleared on enqueue. The
/// previous pre-clear meant a re-run that then failed re-INSERTed a fresh
/// row (`attempts = 1`, `created_at = now`) every cycle, so attempts
/// never accumulated and the `give_up_reason` triggers could never fire —
/// a permanently-failing task looped forever. Now the row survives the
/// re-enqueue; on failure `record_failure` UPSERTs it (attempts += 1,
/// `created_at` preserved) and on durable success the consumer clears it
/// via [`clear_on_success`]. The give-up / unknown-kind retirement paths
/// below are the only places `sweep_once` itself deletes a row.
///
/// I-Materializer-1: split the pool into `read_pool` (for the `fetch_due`
/// SELECT) and `write_pool` (for the `clear_entry` / `lease_entry`
/// writes) to match the "background tasks use split read/write pools"
/// pattern documented in AGENTS.md. Tests pass the same pool for both
/// arguments.
///
/// Returns the number of rows re-enqueued.
// #647: the retry sweeper is the documented worst-case path (a stuck retry
// row, the 1-hour cache-staleness ceiling) — yet it had no span. This span
// covers a full sweep cycle and records how many rows it re-enqueued on the
// way out (`ret` via `err`/return is the natural place; the count is small
// and non-sensitive). `skip_all` (#632): pools + the Materializer handle
// carry no PII but are not useful in a log line either.
#[instrument(name = "materializer.sweep_once", skip_all, err)]
pub async fn sweep_once(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
) -> Result<usize, AppError> {
    const SWEEP_BATCH_LIMIT: i64 = 64;
    let due = fetch_due(read_pool, SWEEP_BATCH_LIMIT).await?;
    let mut re_enqueued = 0usize;
    for row in &due {
        let apply_op_kind = match RetryKind::from_str(&row.task_kind) {
            Some(RetryKind::ApplyOp { device_id, seq }) => Some((device_id, seq)),
            _ => None,
        };

        // Issue #157 sub-item D — give-up before any further work.
        //
        // #621: ApplyOp rows are exempt. A persisted ApplyOp is a
        // CORRECTNESS hole — the apply cursor's MAX-semantics advance has
        // already leapt past the dropped op's seq, so the boot replay
        // (`seq > cursor`) can never re-cover it; this retry row is the ONLY
        // remaining record that the op was never materialized. Auto-retiring
        // it (10 attempts / 7 days) would leave the op permanently
        // unmaterialized with no recovery net. The row stays on the capped
        // 1-hour backoff schedule until durable success (`clear_on_success`)
        // or an explicit retirement below (op row compacted away /
        // superseded by a later purge). The threshold crossing is still
        // logged so a permanently-failing apply stays operator-visible.
        if let Some(reason) = give_up_reason(row) {
            if apply_op_kind.is_none() {
                tracing::warn!(
                    block_id = %row.block_id,
                    task_kind = %row.task_kind,
                    attempts = row.attempts,
                    created_at = %row.created_at,
                    give_up_reason = reason,
                    "retry queue give-up — task permanently dropped"
                );
                materializer
                    .metrics()
                    .retry_queue_giveup_total
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                clear_entry(
                    write_pool,
                    &row.block_id,
                    &row.task_kind,
                    materializer.metrics(),
                )
                .await?;
                continue;
            }
            tracing::warn!(
                block_id = %row.block_id,
                task_kind = %row.task_kind,
                attempts = row.attempts,
                created_at = %row.created_at,
                give_up_reason = reason,
                "persisted ApplyOp exceeds the give-up thresholds but is kept — \
                 apply ops are correctness, not cache freshness (#621); it stays \
                 on the capped backoff until it applies durably"
            );
        }

        // ApplyOp rows are dispatched to the foreground
        // queue (matching the original task's routing). They need a
        // separate path because (a) `task_from_row` cannot reconstruct
        // them from the row alone — the `OpRecord` must be re-loaded
        // from `op_log` — and (b) `try_enqueue_background` would route
        // to the wrong consumer.
        if let Some((device_id, seq)) = apply_op_kind {
            match try_reenqueue_apply_op(read_pool, materializer, &device_id, seq).await {
                Ok(ApplyOpSweepDisposition::Enqueued) => {
                    // Issue #378: lease (do NOT clear) on successful
                    // enqueue. The row stays so a subsequent failure's
                    // `record_failure` UPSERT finds it and increments
                    // `attempts` (preserving `created_at`); the consumer
                    // clears it via `clear_on_success` only on durable
                    // success. The lease prevents the same in-flight op
                    // being swept twice before it resolves.
                    lease_entry(write_pool, &row.block_id, &row.task_kind, row.attempts).await?;
                    re_enqueued += 1;
                }
                Ok(ApplyOpSweepDisposition::OpRowMissing) => {
                    // #621: permanent — the op_log row is gone (compacted
                    // away or corrupted), so there is nothing left to apply.
                    // Retire the row instead of erroring every sweep forever.
                    tracing::error!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        "retiring persisted ApplyOp row: its op_log row no longer \
                         exists (compacted or corrupted) — the op is permanently \
                         unmaterialized (#621)"
                    );
                    materializer
                        .metrics()
                        .retry_queue_giveup_total
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    clear_entry(
                        write_pool,
                        &row.block_id,
                        &row.task_kind,
                        materializer.metrics(),
                    )
                    .await?;
                }
                Ok(ApplyOpSweepDisposition::SupersededByPurge) => {
                    // #621: a later purge_block targets the same block. The
                    // sweep runs minutes-to-hours after the original failure,
                    // so re-applying now (projections are INSERT OR IGNORE
                    // with no tombstone check, and the engine recreates the
                    // node) would RESURRECT user-destroyed data. The purge
                    // makes this op's effect moot — retire the row.
                    tracing::info!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        "retiring persisted ApplyOp row: a later purge_block \
                         supersedes it — re-applying would resurrect a purged \
                         block (#621)"
                    );
                    clear_entry(
                        write_pool,
                        &row.block_id,
                        &row.task_kind,
                        materializer.metrics(),
                    )
                    .await?;
                }
                Ok(ApplyOpSweepDisposition::SupersededByAncestorPurge) => {
                    // #2212: a later purge_block targeted an ANCESTOR of this
                    // block. The purge cascade physically deleted this block's
                    // subtree with no per-descendant op_log row, so the
                    // same-block purge gate could not see it. Re-applying this
                    // persisted create/edit would resurrect an orphan under a
                    // user-destroyed subtree (or fail the parent_id FK on every
                    // sweep forever). The purge makes this op's effect moot —
                    // retire the row.
                    tracing::info!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        "retiring persisted ApplyOp row: a later purge_block on \
                         an ANCESTOR supersedes it — re-applying would resurrect \
                         an orphan under a purged subtree (#2212)"
                    );
                    clear_entry(
                        write_pool,
                        &row.block_id,
                        &row.task_kind,
                        materializer.metrics(),
                    )
                    .await?;
                }
                Ok(ApplyOpSweepDisposition::SupersededByEdit) => {
                    // #850: a later edit_block on the same block already won
                    // under strict LWW. Re-applying this stale edit now
                    // (`apply_edit_block_via_loro` splices `to_text` and
                    // projects the snapshot) would regress the newer content
                    // in both engine and SQL. The newer edit makes this op's
                    // effect moot — retire the row.
                    tracing::info!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        "retiring persisted ApplyOp row: a later edit_block \
                         supersedes it — re-applying would regress newer \
                         content (#850)"
                    );
                    clear_entry(
                        write_pool,
                        &row.block_id,
                        &row.task_kind,
                        materializer.metrics(),
                    )
                    .await?;
                }
                Err(e) => {
                    tracing::warn!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        error = %e,
                        "failed to re-enqueue  ApplyOp row — will try again next sweep"
                    );
                }
            }
            continue;
        }

        let Some(task) = task_from_row(row) else {
            // Unknown task_kind — drop the row so the table doesn't grow
            // unbounded with orphaned entries from a future version.
            tracing::warn!(
                block_id = %row.block_id,
                task_kind = %row.task_kind,
                "dropping retry row for unknown task_kind"
            );
            clear_entry(
                write_pool,
                &row.block_id,
                &row.task_kind,
                materializer.metrics(),
            )
            .await?;
            continue;
        };
        match materializer.try_enqueue_background(task) {
            Ok(crate::materializer::BackgroundEnqueueOutcome::Enqueued) => {
                // Issue #378: lease (do NOT clear) the row on successful
                // enqueue. Pre-clearing here meant a task that then
                // FAILED on its re-run hit `record_failure`'s INSERT
                // branch every cycle — `attempts` never accumulated and
                // `created_at` never aged, so `give_up_reason` could
                // NEVER fire and a permanently-failing task looped
                // forever (issue #157 / #378). Keeping the row present
                // means a subsequent failure UPSERTs it (attempts += 1,
                // created_at preserved); the consumer clears it via
                // `clear_on_success` only after the re-run succeeds
                // durably. The lease bumps `next_attempt_at` forward so
                // the same in-flight task is not swept twice before it
                // resolves.
                lease_entry(write_pool, &row.block_id, &row.task_kind, row.attempts).await?;
                re_enqueued += 1;
            }
            Ok(crate::materializer::BackgroundEnqueueOutcome::Shed) => {
                // #2541: the queue was full — the task never dispatched, so
                // this is NOT a re-enqueue: do not count it and, crucially,
                // do NOT `lease_entry`. The shed path has already spawned a
                // `record_failure` UPSERT that reschedules the row with the
                // escalated backoff (and the `SHED_LAST_ERROR` marker);
                // leasing here with this sweep's STALE `row.attempts`
                // snapshot raced that UPSERT and could REWIND
                // `next_attempt_at` below the escalated value, re-sweeping
                // the row into the still-saturated queue early.
                tracing::debug!(
                    block_id = %row.block_id,
                    task_kind = %row.task_kind,
                    "retry row shed at re-enqueue (background queue full) — \
                     rescheduled by the shed path's record_failure (#2541)"
                );
            }
            Err(e) => {
                tracing::warn!(
                    block_id = %row.block_id,
                    task_kind = %row.task_kind,
                    error = %e,
                    "failed to re-enqueue retry row — will try again next sweep"
                );
            }
        }
    }
    if re_enqueued > 0 {
        tracing::info!(re_enqueued, "materializer retry queue sweep");
    }
    Ok(re_enqueued)
}

/// #621: what [`try_reenqueue_apply_op`] decided about a persisted ApplyOp
/// row. `Enqueued` is the normal path; the other two are permanent
/// dispositions the caller must retire the retry row for.
#[derive(Debug, PartialEq, Eq)]
enum ApplyOpSweepDisposition {
    /// The record was re-submitted on the foreground queue.
    Enqueued,
    /// The `op_log` row no longer exists (compacted away or corrupted) —
    /// there is nothing left to apply, ever.
    OpRowMissing,
    /// A later `purge_block` op targets the same block; re-applying this op
    /// out of order would resurrect user-destroyed data (the projections are
    /// `INSERT OR IGNORE` with no tombstone/purge check, and the engine
    /// recreates the node).
    SupersededByPurge,
    /// #2212: a later `purge_block` op targets an ANCESTOR of this block. A
    /// purge writes a single op_log row for the subtree ROOT; the descendant
    /// removal is a SQL cascade with NO per-descendant op_log rows, so the
    /// same-block [`Self::SupersededByPurge`] gate can never see it. Re-applying
    /// a persisted create/edit for a child of a purged subtree would resurrect
    /// an orphan under user-destroyed data (or fail the `parent_id` FK on every
    /// sweep forever). Ancestry is reconstructed from the append-only op_log —
    /// per hop: the latest `move_block`'s `new_parent_id` (strict LWW) if the
    /// block was ever moved, else the `create_block` `parent_id` — because the
    /// live `blocks` chain is already gone at sweep time and a create-only
    /// walk would mis-handle moved blocks in both directions.
    SupersededByAncestorPurge,
    /// #850: a later `edit_block` op targets the same block; re-applying this
    /// (stale) op out of order would regress the block's content.
    /// `apply_edit_block_via_loro` splices `to_text` and projects the
    /// snapshot, overwriting the newer content in both engine and SQL.
    SupersededByEdit,
}

/// Re-enqueue a previously-persisted [`MaterializeTask::ApplyOp`]
/// failure onto the foreground queue.
///
/// Steps:
///   1. Load the `OpRecord` from `op_log` by `(device_id, seq)`.
///   2. #621/#850/#2212: gate on op-log supersession — if a later `purge_block`
///      targets the same block OR any ANCESTOR of it (#2212: purge cascades
///      leave no per-descendant op_log row), do NOT re-apply (out-of-order
///      resurrection); and if the swept op is an `edit_block` with a later
///      `edit_block` on the same block, do NOT re-apply (out-of-order content
///      regression).
///   3. Wrap in `Arc` and submit via [`crate::materializer::Materializer::enqueue_foreground`].
///
/// A missing op_log row and a purge-/edit-superseded op are reported as
/// [`ApplyOpSweepDisposition`] values (permanent — the caller retires the
/// row); transient failures (enqueue / probe errors) propagate as `Err` so
/// the row survives for the next sweep.
async fn try_reenqueue_apply_op(
    read_pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
    device_id: &str,
    seq: i64,
) -> Result<ApplyOpSweepDisposition, AppError> {
    let record = sqlx::query_as!(
        crate::op_log::OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
         FROM op_log WHERE device_id = ? AND seq = ?",
        device_id,
        seq,
    )
    .fetch_optional(read_pool)
    .await?;
    let Some(record) = record else {
        return Ok(ApplyOpSweepDisposition::OpRowMissing);
    };

    // #621: out-of-order-sweep guard. The sweep re-applies minutes-to-hours
    // after the original failure, after later ops already applied. If a
    // LATER `purge_block` (materializer LWW order: `created_at, device_id,
    // seq`) targets the same block, re-applying this op would re-insert the
    // purged block in SQL (`INSERT OR IGNORE`, no purge check) and recreate
    // the node in the engine. The op the user observed winning is the purge
    // — drop this one. (`purge_block` is excluded from gating itself only by
    // the strict "later than" comparison: a purge is never superseded by
    // itself.)
    if let Some(block_id) = record.block_id.as_deref() {
        // #621/#850: runtime query() (not the macro) keeps this purge gate
        // adjacent to the edit-gate twin below; both share the LWW predicate.
        // dynamic-sql: parameterized EXISTS; all values bound, no interpolation.
        let superseded: i64 = sqlx::query_scalar(
            "SELECT EXISTS( \
                 SELECT 1 FROM op_log p \
                 WHERE p.op_type = 'purge_block' \
                   AND p.block_id = ?1 \
                   AND (p.created_at > ?2 \
                        OR (p.created_at = ?2 \
                            AND (p.device_id > ?3 \
                                 OR (p.device_id = ?3 AND p.seq > ?4)))) \
             )",
        )
        .bind(block_id)
        .bind(record.created_at)
        .bind(&record.device_id)
        .bind(record.seq)
        .fetch_one(read_pool)
        .await?;
        if superseded != 0 {
            return Ok(ApplyOpSweepDisposition::SupersededByPurge);
        }

        // #2212: ancestor-purge cascade gate. `purge_block` writes a SINGLE
        // op_log row targeting the subtree ROOT; descendant removal is a SQL
        // cascade with NO per-descendant op_log rows. So the same-block purge
        // gate above (`p.block_id = record.block_id`) MISSES the case where an
        // ANCESTOR of this block was purged — this block was physically deleted
        // by that cascade with no op targeting it directly. Re-applying a
        // persisted create/edit for such a child would resurrect an orphan
        // under a user-destroyed subtree (`INSERT OR IGNORE`, no purge check),
        // or fail the `parent_id` FK on every sweep forever.
        //
        // The ancestor chain is ALREADY gone from `blocks` at sweep time (that
        // is the whole point of a purge), so we cannot walk the live `blocks`
        // parent_id chain. Instead we reconstruct the lineage from the
        // append-only op_log. A block's EFFECTIVE parent is NOT necessarily its
        // create-op `parent_id`: a later `move_block` reparents it (payload
        // `new_parent_id`), so a create-only walk would (a) MISS the real
        // ancestor chain of a block moved INTO a later-purged subtree
        // (wrong re-apply → orphan resurrection) and — worse — (b) wrongly
        // retire the record for a block moved OUT of a later-purged subtree
        // (its create parent was purged but the block lives elsewhere and the
        // op SHOULD re-apply). Per hop the effective parent is therefore:
        // the `new_parent_id` of the LATEST `move_block` op for that block
        // (strict LWW order `created_at, device_id, seq` — same total order as
        // the purge predicate below), else the create op's `parent_id`. The
        // CASE/EXISTS split (not COALESCE) is load-bearing: a move to ROOT
        // carries `new_parent_id = null`, which must TERMINATE the chain, not
        // fall back to the stale create parent. We retire the record iff a
        // LATER `purge_block` (the SAME strict LWW predicate as the same-block
        // gate) targets ANY enumerated ancestor.
        //
        // Why this cannot retire a record that should legitimately re-apply:
        // the ancestor set is derived ONLY from THIS block's own effective
        // (move-aware) lineage, so an UNRELATED later purge of a different
        // subtree is never matched (its target is not in the set), and a
        // create whose parent still exists (no ancestor purged) yields an
        // empty EXISTS. The `depth < 100` bound (AGENTS.md invariant #9) +
        // `UNION` dedup guard a corrupted / cyclic parent_id chain (each
        // recursive step emits exactly one row, so the walk is <= 101 rows).
        // If this block's create op was compacted away (and it has no move
        // op), the seed's effective parent is NULL and we conservatively do
        // NOT retire.
        // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
        // dynamic-sql: recursive ancestry CTE + parameterized EXISTS; all values bound, no interpolation.
        let superseded_by_ancestor_purge: i64 = sqlx::query_scalar(
            "WITH RECURSIVE ancestors(id, depth) AS ( \
                 SELECT CASE WHEN EXISTS( \
                             SELECT 1 FROM op_log m \
                              WHERE m.op_type = 'move_block' AND m.block_id = ?1) \
                        THEN (SELECT json_extract(m.payload, '$.new_parent_id') \
                                FROM op_log m \
                               WHERE m.op_type = 'move_block' AND m.block_id = ?1 \
                               ORDER BY m.created_at DESC, m.device_id DESC, m.seq DESC \
                               LIMIT 1) \
                        ELSE (SELECT json_extract(c.payload, '$.parent_id') \
                                FROM op_log c \
                               WHERE c.op_type = 'create_block' AND c.block_id = ?1 \
                               LIMIT 1) \
                        END, 0 \
                 UNION \
                 SELECT CASE WHEN EXISTS( \
                             SELECT 1 FROM op_log m \
                              WHERE m.op_type = 'move_block' AND m.block_id = a.id) \
                        THEN (SELECT json_extract(m.payload, '$.new_parent_id') \
                                FROM op_log m \
                               WHERE m.op_type = 'move_block' AND m.block_id = a.id \
                               ORDER BY m.created_at DESC, m.device_id DESC, m.seq DESC \
                               LIMIT 1) \
                        ELSE (SELECT json_extract(c.payload, '$.parent_id') \
                                FROM op_log c \
                               WHERE c.op_type = 'create_block' AND c.block_id = a.id \
                               LIMIT 1) \
                        END, a.depth + 1 \
                   FROM ancestors a \
                  WHERE a.id IS NOT NULL AND a.depth < 100 \
             ) \
             SELECT EXISTS( \
                 SELECT 1 FROM op_log p \
                 JOIN ancestors anc ON p.block_id = anc.id \
                 WHERE p.op_type = 'purge_block' \
                   AND (p.created_at > ?2 \
                        OR (p.created_at = ?2 \
                            AND (p.device_id > ?3 \
                                 OR (p.device_id = ?3 AND p.seq > ?4)))) \
             )",
        )
        .bind(block_id)
        .bind(record.created_at)
        .bind(&record.device_id)
        .bind(record.seq)
        .fetch_one(read_pool)
        .await?;
        if superseded_by_ancestor_purge != 0 {
            return Ok(ApplyOpSweepDisposition::SupersededByAncestorPurge);
        }

        // #850: the second half of #621's own fix suggestion (the purge half
        // shipped first). When the op being swept is itself an `edit_block`,
        // a LATER `edit_block` on the same block (same strict LWW order:
        // `created_at, device_id, seq`) already won — its content is what the
        // user observed. `apply_edit_block_via_loro` splices `to_text` and
        // projects the snapshot, so re-applying this stale edit now would
        // regress the newer content in both engine and SQL. Drop it. The
        // strict "later than" comparison excludes the op from gating itself
        // (an edit is never superseded by itself), exactly as the purge gate
        // does. Scoped to `op_type = 'edit_block'` on BOTH sides: only a
        // stale edit can be content-regressed by a newer edit, and only a
        // newer edit (not e.g. a delete/restore — whose soft-delete interplay
        // was deliberately deferred from #621) supersedes here.
        if record.op_type == "edit_block" {
            // #850: mirrors the purge gate above.
            // dynamic-sql: parameterized EXISTS; all values bound, no interpolation.
            let superseded_by_edit: i64 = sqlx::query_scalar(
                "SELECT EXISTS( \
                     SELECT 1 FROM op_log e \
                     WHERE e.op_type = 'edit_block' \
                       AND e.block_id = ?1 \
                       AND (e.created_at > ?2 \
                            OR (e.created_at = ?2 \
                                AND (e.device_id > ?3 \
                                     OR (e.device_id = ?3 AND e.seq > ?4)))) \
                 )",
            )
            .bind(block_id)
            .bind(record.created_at)
            .bind(&record.device_id)
            .bind(record.seq)
            .fetch_one(read_pool)
            .await?;
            if superseded_by_edit != 0 {
                return Ok(ApplyOpSweepDisposition::SupersededByEdit);
            }
        }
    }

    materializer
        .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(record)))
        .await?;
    Ok(ApplyOpSweepDisposition::Enqueued)
}

/// Spawn a long-lived task that sweeps the retry queue every 60 seconds
/// and exits when `shutdown_flag` is set.
///
/// I-Materializer-1: takes both pools so `sweep_once` can route SELECTs
/// to the reader pool and DELETEs to the writer pool, mirroring the
/// `cache::*_split` helpers used elsewhere in the materializer.
///
/// # Shutdown-flag coordination (#483 L1)
///
/// `shutdown_flag` is never set to `true` anywhere in the tree — the sweeper
/// relies on process exit to stop (#703 removed the dead managed-state
/// newtype that once wrapped it). This is safe in practice because after
/// `Materializer::shutdown()` the sweeper's `try_enqueue_background` calls
/// short-circuit on the materializer's own shutdown flag and log a `warn!` for
/// any row they attempt to re-enqueue. Convergence requires a restart; the
/// dormant `shutdown_flag` parameter is retained only to keep this signature
/// stable for a future graceful-shutdown path.
pub fn spawn_sweeper(
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    materializer: crate::materializer::Materializer,
    shutdown_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    #[cfg(not(test))]
    let spawn_fn = tauri::async_runtime::spawn;
    #[cfg(test)]
    let spawn_fn = tokio::spawn;
    // Fire-and-forget: the sweeper runs for the app's lifetime. We intentionally
    // discard the JoinHandle — the task stops when `shutdown_flag` flips.
    let _handle = spawn_fn(async move {
        // #2187: seed the pending-retry gauge from an authoritative COUNT(*)
        // BEFORE the first sweep. Rows left by a previous session were never
        // routed through `record_failure` this run, so the incremental gauge
        // starts at 0 and would let the consumer's `clear_on_success`
        // fast-path incorrectly skip clearing them. Seeding recovers the true
        // count; a query error leaves the gauge at 0, which merely re-adds the
        // (already accepted) per-success DELETE cost until the next boot.
        if let Ok(c) = pending_count(&read_pool).await {
            materializer.metrics().seed_pending_retry_rows(c);
        }
        // First pass at boot to drain entries left by a previous session.
        if let Err(e) = sweep_once(&read_pool, &write_pool, &materializer).await {
            tracing::warn!(error = %e, "boot-time retry queue sweep failed");
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        // skip immediate first tick
        interval.tick().await;
        loop {
            interval.tick().await;
            if shutdown_flag.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            if let Err(e) = sweep_once(&read_pool, &write_pool, &materializer).await {
                tracing::warn!(error = %e, "periodic retry queue sweep failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// #2187: a fresh, isolated `QueueMetrics` for unit tests that call the
    /// metrics-threaded retry-queue fns directly (`record_failure`,
    /// `clear_entry`, `clear_on_success`). Each call gets its own instance so
    /// the pending-retry gauge starts at 0 and is not shared across tests.
    fn test_metrics() -> super::super::metrics::QueueMetrics {
        super::super::metrics::QueueMetrics::default()
    }

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[test]
    fn backoff_schedule_escalates_then_caps() {
        assert_eq!(backoff_delay_for(1), chrono::Duration::minutes(1));
        assert_eq!(backoff_delay_for(2), chrono::Duration::minutes(5));
        assert_eq!(backoff_delay_for(3), chrono::Duration::minutes(30));
        assert_eq!(backoff_delay_for(4), chrono::Duration::hours(1));
        assert_eq!(backoff_delay_for(10), chrono::Duration::hours(1));
        // 0 or negative treated as first attempt
        assert_eq!(backoff_delay_for(0), chrono::Duration::minutes(1));
    }

    #[test]
    fn from_task_matches_per_block_and_global_retryable_tasks() {
        // --- Per-block tasks: real block_id flows through ---
        let t = MaterializeTask::UpdateFtsBlock {
            block_id: "B1".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::UpdateFtsBlock, ref id)) if id == "B1"
        ));

        let t = MaterializeTask::ReindexBlockLinks {
            block_id: "B2".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::ReindexBlockLinks, ref id)) if id == "B2"
        ));

        let t = MaterializeTask::ReindexBlockTagRefs {
            block_id: "B3".into(),
        };
        assert!(matches!(
            RetryKind::from_task(&t),
            Some((RetryKind::ReindexBlockTagRefs, ref id)) if id == "B3"
        ));

        // --- Global cache rebuilds: sentinel block_id ---
        for (task, expected_kind) in [
            (
                MaterializeTask::RebuildTagsCache,
                RetryKind::RebuildTagsCache,
            ),
            (
                MaterializeTask::RebuildPagesCache,
                RetryKind::RebuildPagesCache,
            ),
            (
                MaterializeTask::RebuildAgendaCache,
                RetryKind::RebuildAgendaCache,
            ),
            (
                MaterializeTask::RebuildProjectedAgendaCache,
                RetryKind::RebuildProjectedAgendaCache,
            ),
            (
                MaterializeTask::RebuildTagInheritanceCache,
                RetryKind::RebuildTagInheritanceCache,
            ),
            (MaterializeTask::RebuildPageIds, RetryKind::RebuildPageIds),
            (
                MaterializeTask::RebuildBlockTagRefsCache,
                RetryKind::RebuildBlockTagRefsCache,
            ),
        ] {
            let extracted = RetryKind::from_task(&task);
            assert!(
                matches!(
                    &extracted,
                    Some((kind, id)) if *kind == expected_kind && id == GLOBAL_TASK_SENTINEL
                ),
                "global task {task:?} must extract as ({expected_kind:?}, '__GLOBAL__'); got {extracted:?}"
            );
        }

        // --- Truly non-retryable tasks ---
        let t = MaterializeTask::RebuildFtsIndex;
        assert!(
            RetryKind::from_task(&t).is_none(),
            "RebuildFtsIndex is non-retryable (handled by other code paths)"
        );
        let t = MaterializeTask::FtsOptimize;
        assert!(RetryKind::from_task(&t).is_none());
    }

    #[test]
    fn retry_kind_reindex_block_tag_refs_roundtrip() {
        let kind = RetryKind::ReindexBlockTagRefs;
        assert_eq!(kind.task_kind_str(), "ReindexBlockTagRefs");
        assert_eq!(
            RetryKind::from_str("ReindexBlockTagRefs"),
            Some(kind.clone())
        );
        let task = kind.to_task("BLK_RTR".into()).unwrap();
        assert!(matches!(
            task,
            MaterializeTask::ReindexBlockTagRefs { ref block_id } if block_id.as_ref() == "BLK_RTR"
        ));
    }

    /// Round-trip a foreground apply-op failure through
    /// `from_task` → row → `from_str`, asserting the composite-key
    /// packing into `task_kind` is reversible.
    #[test]
    fn retry_kind_apply_op_roundtrip() {
        use crate::op_log::OpRecord;
        let record = OpRecord {
            device_id: "dev-mat-A".into(),
            seq: 42,
            parent_seqs: None,
            hash: "deadbeef".into(),
            op_type: "create_block".into(),
            payload: "{}".into(),
            created_at: 1_736_942_400_000,
            block_id: None,
        };
        let task = MaterializeTask::ApplyOp(Arc::new(record));
        let (kind, sentinel) = RetryKind::from_task(&task).expect("ApplyOp is retryable");
        assert_eq!(sentinel, APPLY_OP_TASK_SENTINEL);
        let kind_str = kind.task_kind_str();
        assert_eq!(kind_str.as_ref(), "ApplyOp:42:dev-mat-A");

        let parsed = RetryKind::from_str(kind_str.as_ref()).unwrap();
        assert_eq!(parsed, kind);
        // ApplyOp cannot reconstruct a task without an op_log lookup.
        assert!(parsed.to_task(sentinel.clone()).is_none());
    }

    /// Malformed apply-op `task_kind` strings (extra
    /// segments, missing seq, non-numeric seq) must not panic and
    /// must yield `None` so the sweeper drops the row as unknown.
    #[test]
    fn retry_kind_from_str_rejects_malformed_apply_op() {
        assert!(RetryKind::from_str("ApplyOp:").is_none());
        assert!(RetryKind::from_str("ApplyOp:notanumber:dev").is_none());
        assert!(RetryKind::from_str("ApplyOp:42:").is_none());
        // Round-trip preserves device_ids that contain `:` because we
        // splitn(3, ':') so the third segment captures everything.
        let kind = RetryKind::from_str("ApplyOp:7:dev:A:B").unwrap();
        assert_eq!(
            kind,
            RetryKind::ApplyOp {
                device_id: "dev:A:B".into(),
                seq: 7
            }
        );
    }

    #[tokio::test]
    async fn record_failure_inserts_row_for_retryable_task() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_R1".into(),
        };
        record_failure(&pool, &task, "boom", &test_metrics())
            .await
            .unwrap();

        let row = sqlx::query!(
            "SELECT attempts, last_error FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_R1",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.attempts, 1);
        assert_eq!(row.last_error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn record_failure_increments_attempts_on_repeat() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_R2".into(),
        };
        let metrics = test_metrics();
        record_failure(&pool, &task, "err1", &metrics)
            .await
            .unwrap();
        record_failure(&pool, &task, "err2", &metrics)
            .await
            .unwrap();
        record_failure(&pool, &task, "err3", &metrics)
            .await
            .unwrap();

        let row = sqlx::query!(
            "SELECT attempts, last_error FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_R2",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.attempts, 3, "attempts must accumulate across failures");
        assert_eq!(
            row.last_error.as_deref(),
            Some("err3"),
            "last_error must be overwritten with the most recent message"
        );
    }

    /// R3 (#347): the backoff folded into the single `ON CONFLICT DO
    /// UPDATE` must produce the SAME `next_attempt_at` schedule the prior
    /// two-statement (UPSERT + follow-up UPDATE) form did, for every step
    /// 1→2→3→4(cap). Asserts `next_attempt_at - now` lands in the
    /// `backoff_delay_for(attempts)` window on each failure, confirming
    /// the SQL `CASE` and the Rust schedule agree and that the escalation
    /// path no longer leaves the row at the too-short first-failure delay.
    #[tokio::test]
    async fn record_failure_backoff_matches_schedule_atomically_r3() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_R3".into(),
        };

        let metrics = test_metrics();
        for expected_attempts in 1..=4_i64 {
            let before = crate::db::now_ms();
            record_failure(&pool, &task, "boom", &metrics)
                .await
                .unwrap();
            let after = crate::db::now_ms();

            let row = sqlx::query!(
                "SELECT attempts AS \"attempts!: i64\", \
                        next_attempt_at AS \"next_attempt_at!: i64\" \
                 FROM materializer_retry_queue \
                 WHERE block_id = ? AND task_kind = ?",
                "BLK_R3",
                "UpdateFtsBlock",
            )
            .fetch_one(&pool)
            .await
            .unwrap();

            assert_eq!(
                row.attempts, expected_attempts,
                "attempts must accumulate atomically"
            );

            let delay = backoff_delay_for(expected_attempts).num_milliseconds();
            // next_attempt_at was computed as `now_inside_sql + delay`,
            // where now_inside_sql is bracketed by [before, after].
            assert!(
                row.next_attempt_at >= before + delay && row.next_attempt_at <= after + delay,
                "step {expected_attempts}: next_attempt_at={} must equal SQL now + {delay}ms \
                 (window [{}, {}])",
                row.next_attempt_at,
                before + delay,
                after + delay,
            );
        }
    }

    #[tokio::test]
    async fn record_failure_ignores_non_retryable_tasks() {
        let (pool, _dir) = test_pool().await;
        // RebuildFtsIndex is non-retryable (no in-memory retry path; handled
        // By FTS optimize logic). Distinct global cache rebuilds
        // which ARE retryable under the GLOBAL_TASK_SENTINEL.
        record_failure(
            &pool,
            &MaterializeTask::RebuildFtsIndex,
            "boom",
            &test_metrics(),
        )
        .await
        .unwrap();

        let n = pending_count(&pool).await.unwrap();
        assert_eq!(
            n, 0,
            "non-retryable tasks must not be persisted to the retry queue"
        );
    }

    #[tokio::test]
    async fn fetch_due_and_clear_entry_round_trip() {
        let (pool, _dir) = test_pool().await;
        // Insert a row with an already-past next_attempt_at
        let past = crate::db::now_ms() - 5 * 60_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_FD",
            "UpdateFtsBlock",
            1_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = fetch_due(&pool, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "due row should be returned");
        assert_eq!(rows[0].block_id, "BLK_FD");
        assert_eq!(rows[0].task_kind, "UpdateFtsBlock");

        clear_entry(&pool, "BLK_FD", "UpdateFtsBlock", &test_metrics())
            .await
            .unwrap();
        let n = pending_count(&pool).await.unwrap();
        assert_eq!(n, 0, "cleared entry should vanish from the queue");
    }

    #[tokio::test]
    async fn fetch_due_skips_future_entries() {
        let (pool, _dir) = test_pool().await;
        let future = crate::db::now_ms() + 3_600_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_F1",
            "UpdateFtsBlock",
            1_i64,
            future,
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = fetch_due(&pool, 10).await.unwrap();
        assert!(
            rows.is_empty(),
            "future-dated entries must not be returned by fetch_due"
        );
    }

    #[tokio::test]
    async fn task_from_row_roundtrip() {
        let row = DueRow {
            block_id: "BLK_TR".into(),
            task_kind: "UpdateFtsBlock".into(),
            attempts: 0,
            created_at: crate::db::now_ms(),
            last_error: None,
        };
        let t = task_from_row(&row).unwrap();
        assert!(
            matches!(t, MaterializeTask::UpdateFtsBlock { ref block_id } if block_id.as_ref() == "BLK_TR")
        );

        let unknown = DueRow {
            block_id: "x".into(),
            task_kind: "SomeFutureTaskKind".into(),
            attempts: 0,
            created_at: crate::db::now_ms(),
            last_error: None,
        };
        assert!(
            task_from_row(&unknown).is_none(),
            "unknown task_kind rows must be silently skipped for migration-forward safety"
        );
    }

    /// Regression: the SQL-side `attempts = materializer_retry_queue.attempts + 1`
    /// increment must be atomic vs. concurrent callers. Two `record_failure`
    /// invocations issued in parallel for the same `(block_id, task_kind)`
    /// MUST produce `attempts == 2` — never `attempts == 1` (which would
    /// happen with the old SELECT-then-INSERT, where both readers see
    /// `prior = None`, both compute `attempts = 1`, and the second
    /// triggers `ON CONFLICT` overwriting with `excluded.attempts = 1`).
    ///
    /// SQLite serialises writers, but the test still pins the invariant
    /// at the SQL level so any future attempt to swap the increment back
    /// to a Rust-side computation gets caught by the join semantics
    /// alone (no need for genuine wall-clock interleaving).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn record_failure_concurrent_calls_accumulate_attempts() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_RACE".into(),
        };

        // Fire two failures back-to-back from independent tasks. The
        // SQL-side increment guarantees the second call observes the
        // first's INSERT/UPDATE atomically.
        let metrics = std::sync::Arc::new(test_metrics());
        let p1 = pool.clone();
        let t1 = task.clone();
        let m1 = metrics.clone();
        let h1 = tokio::spawn(async move { record_failure(&p1, &t1, "err-A", &m1).await });
        let p2 = pool.clone();
        let t2 = task.clone();
        let m2 = metrics.clone();
        let h2 = tokio::spawn(async move { record_failure(&p2, &t2, "err-B", &m2).await });
        h1.await.unwrap().unwrap();
        h2.await.unwrap().unwrap();

        let attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_RACE",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            attempts, 2,
            "SQL-side increment must accumulate across concurrent record_failure calls; \
             a regression to SELECT-then-INSERT would race and drop one increment (attempts == 1)"
        );
    }

    #[tokio::test]
    async fn record_failure_escalates_next_attempt_at() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_EX".into(),
        };

        let metrics = test_metrics();
        record_failure(&pool, &task, "e1", &metrics).await.unwrap();
        let first = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_EX",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        record_failure(&pool, &task, "e2", &metrics).await.unwrap();
        let second = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_EX",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert!(
            second > first,
            "second failure must schedule a later next_attempt_at (got first={first}, second={second})"
        );
    }

    // --- sweeper ---

    /// Issue #378: a due row is re-enqueued by the sweeper and then
    /// cleared by the live background consumer's durable-success path
    /// (`clear_on_success`) — NOT pre-deleted by the sweeper on enqueue.
    /// `Materializer::new` spawns a real background consumer that drains
    /// the re-enqueued `UpdateFtsBlock` (a no-op success on the empty
    /// test DB), so the row is cleared asynchronously after the success.
    /// We poll for that confirmed-success clear. The lease mechanics
    /// (next_attempt_at bump, attempts/created_at untouched, no
    /// double-sweep) are pinned deterministically in
    /// `lease_entry_defers_row_without_touching_attempts_378` and the
    /// full-cycle test, which do not race a live consumer.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_reenqueues_due_rows_then_consumer_clears_them_378() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a due row
        let past = crate::db::now_ms() - 5 * 60_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SW1",
            "UpdateFtsBlock",
            2_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        // #2187: the row was planted via raw SQL, bypassing `record_failure`,
        // so the incremental pending-retry gauge is still 0. Seed it from the
        // real COUNT (mirroring the production boot seed in `spawn_sweeper`)
        // or the consumer's `clear_on_success` fast-path would correctly SKIP
        // the DELETE and the row would never clear.
        let seeded = pending_count(&pool).await.unwrap();
        mat.metrics().seed_pending_retry_rows(seeded);

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 1, "one due row must be re-enqueued");

        // The live consumer drains the re-enqueued task (no-op success on
        // the empty DB) and clears the leased row via clear_on_success.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if pending_count(&pool).await.unwrap() == 0 {
                break;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "issue #378: swept row must be cleared by the consumer's \
                 durable-success path; row never cleared"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        mat.shutdown();
    }

    /// Issue #378 regression — the core bug. Drive the FULL
    /// sweep → run → fail → re-persist cycle against a deterministically
    /// failing task MORE than MAX_ATTEMPTS times and assert:
    ///   1. `attempts` actually ACCUMULATES across cycles (1, 2, 3, …) —
    ///      under the old pre-clear-on-enqueue code it was stuck at 1
    ///      forever, because every re-run re-INSERTed a fresh row.
    ///   2. `created_at` is PRESERVED across cycles (never reset to now).
    ///   3. Give-up FIRES at the bound: once attempts reach MAX_ATTEMPTS
    ///      the sweeper retires (deletes) the row and bumps the give-up
    ///      metric — the loop stops instead of running forever.
    ///
    /// The cycle is simulated at the retry-queue layer because that is
    /// exactly how the live system composes it: the consumer's failure
    /// path calls `record_failure` (UPSERT, attempts += 1) and the
    /// sweeper re-enqueues + leases. We model "the re-run failed again"
    /// as the next `record_failure`, and backdate `next_attempt_at` to
    /// simulate the wall-clock passage between sweeps so `fetch_due`
    /// keeps seeing the row.
    ///
    /// WITHOUT the fix (sweep_once pre-clearing the row on enqueue), step
    /// 1 fails: `record_failure` always hits its INSERT branch, attempts
    /// never exceeds 1, give_up_reason("max_attempts") never fires, and
    /// the row is re-enqueued indefinitely.
    ///
    /// The cycle is driven against the retry-queue layer directly,
    /// composing the exact two writes the live system performs each
    /// cycle: the sweeper's enqueue-time `lease_entry` (the row is kept,
    /// not pre-cleared — the heart of the #378 fix) followed by the
    /// re-run's `record_failure` (the consumer's failure path, UPSERT
    /// attempts += 1). We deliberately do NOT route through the live
    /// background consumer here: `Materializer::new` spawns a real
    /// consumer that would drain the re-enqueued no-op task, succeed, and
    /// `clear_on_success` the row — a real, correct behaviour that this
    /// unit test isolates away from so the fail-on-run cycle is
    /// deterministic. The give-up retirement IS driven through the real
    /// `sweep_once` (the give-up arm deletes without enqueue, so the live
    /// consumer is not involved).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_cycle_accumulates_attempts_and_gives_up_378() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        const BID: &str = "BLK_378_CYCLE";
        const KIND: &str = "UpdateFtsBlock";
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: BID.into(),
        };

        async fn make_due(pool: &SqlitePool) {
            let past = crate::db::now_ms() - 5 * 60_000;
            sqlx::query!(
                "UPDATE materializer_retry_queue SET next_attempt_at = ? \
                 WHERE block_id = ? AND task_kind = ?",
                past,
                BID,
                KIND,
            )
            .execute(pool)
            .await
            .unwrap();
        }

        async fn read_row(pool: &SqlitePool) -> Option<(i64, i64)> {
            sqlx::query!(
                "SELECT attempts AS \"attempts!: i64\", \
                        created_at AS \"created_at!: i64\" \
                 FROM materializer_retry_queue \
                 WHERE block_id = ? AND task_kind = ?",
                BID,
                KIND,
            )
            .fetch_optional(pool)
            .await
            .unwrap()
            .map(|r| (r.attempts, r.created_at))
        }

        // First failure creates the row (attempts == 1).
        record_failure(&pool, &task, "fail-1", mat.metrics())
            .await
            .unwrap();
        let (attempts0, created0) = read_row(&pool)
            .await
            .expect("row exists after first failure");
        assert_eq!(attempts0, 1, "first failure lands attempts == 1");

        // Drive cycles: each iteration models one sweep (lease) + one
        // failed re-run (record_failure) until attempts reach the
        // give-up bound. The row must SURVIVE every lease and accumulate
        // attempts across cycles — this is exactly what the old
        // pre-clear-on-enqueue code broke (attempts stuck at 1 forever).
        let mut expected_attempts = attempts0;
        while expected_attempts < MAX_ATTEMPTS {
            make_due(&pool).await;

            // Sweeper enqueue-time action: lease the row (do NOT clear).
            let (lease_attempts, _) = read_row(&pool).await.expect("row due for lease");
            lease_entry(&pool, BID, KIND, lease_attempts).await.unwrap();
            let (after_lease_attempts, after_lease_created) = read_row(&pool)
                .await
                .expect("leased row must survive the sweep");
            assert_eq!(
                after_lease_attempts, expected_attempts,
                "lease must NOT change attempts; only record_failure does"
            );
            assert_eq!(
                after_lease_created, created0,
                "created_at must be preserved across the lease"
            );

            // The re-run fails again → consumer's record_failure path.
            record_failure(&pool, &task, "fail-loop", mat.metrics())
                .await
                .unwrap();
            expected_attempts += 1;
            let (acc_attempts, acc_created) = read_row(&pool)
                .await
                .expect("row survives the failure UPSERT");
            assert_eq!(
                acc_attempts, expected_attempts,
                "attempts MUST accumulate across cycles (1,2,3,…) — the issue #378 regression"
            );
            assert_eq!(
                acc_created, created0,
                "created_at MUST be preserved across the failure UPSERT (never reset to now)"
            );
        }

        // attempts now == MAX_ATTEMPTS. The next due sweep must GIVE UP:
        // retire (delete) the row and bump the give-up metric, instead of
        // re-enqueuing forever. Driven through the real `sweep_once`.
        assert_eq!(expected_attempts, MAX_ATTEMPTS);
        make_due(&pool).await;
        let re_enqueued = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            re_enqueued, 0,
            "give-up sweep must not count the retired row as re-enqueued"
        );
        assert!(
            read_row(&pool).await.is_none(),
            "give-up MUST retire (delete) the row once attempts reach MAX_ATTEMPTS — \
             the task must stop looping (issue #157 / #378)"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(remaining, 0, "the retired row must be deleted");
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 1,
            "retry_queue_giveup_total must increment exactly once when the cycle gives up"
        );

        mat.shutdown();
    }

    /// Issue #378 — confirmed-success clear. A task that fails once
    /// (creating a row) then SUCCEEDS on retry must leave NO row. We
    /// simulate the consumer's durable-success path by calling
    /// `clear_on_success` (the exact helper the fg/bg consumer success
    /// branches invoke), and assert the row is gone.
    #[tokio::test]
    async fn success_clears_the_row_378() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_378_SUCCESS".into(),
        };

        // #2187: a shared gauge so the failure's INSERT bump is visible to
        // the subsequent `clear_on_success` fast-path check (mirrors the
        // production single-`QueueMetrics` instance).
        let metrics = test_metrics();

        // Fail once — row created, gauge → 1.
        record_failure(&pool, &task, "transient", &metrics)
            .await
            .unwrap();
        assert_eq!(
            pending_count(&pool).await.unwrap(),
            1,
            "failure must create a retry row"
        );
        assert!(
            metrics.has_pending_retry_rows(),
            "#2187: recording a failure must set the pending-retry gauge"
        );

        // Re-run succeeds durably → consumer clears the row, gauge → 0.
        clear_on_success(&pool, &task, &metrics).await.unwrap();
        assert_eq!(
            pending_count(&pool).await.unwrap(),
            0,
            "confirmed durable success must clear the retry row"
        );
        assert!(
            !metrics.has_pending_retry_rows(),
            "#2187: clearing the last row must reset the pending-retry gauge to 0"
        );

        // Idempotent: clearing again (or clearing a task that never had a
        // row) is a harmless no-op.
        clear_on_success(&pool, &task, &metrics).await.unwrap();
        assert_eq!(pending_count(&pool).await.unwrap(), 0);
    }

    /// #2187: the pending-retry gauge gates the per-success DELETE.
    ///   1. With no pending rows, `clear_on_success` issues NO DELETE and
    ///      the gauge stays 0 (the common fast-path skip). We prove the
    ///      DELETE never fires by planting an unrelated row via raw SQL
    ///      (which does NOT bump the gauge) and asserting `clear_on_success`
    ///      leaves it untouched.
    ///   2. A recorded failure bumps the gauge to 1; a subsequent
    ///      `clear_on_success` for that task clears the row and decrements
    ///      the gauge back to 0.
    #[tokio::test]
    async fn clear_on_success_skips_delete_when_gauge_empty_2187() {
        let (pool, _dir) = test_pool().await;
        let metrics = test_metrics();
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_2187".into(),
        };

        // --- Part 1: gauge empty ⇒ clear_on_success skips the DELETE. ---
        // Plant a row for THIS task via raw SQL so the gauge stays 0 (the
        // insert bypassed `record_failure`). If `clear_on_success` honoured
        // its fast-path skip, this row must survive the call.
        let now = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_2187",
            "UpdateFtsBlock",
            1_i64,
            now,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            !metrics.has_pending_retry_rows(),
            "raw INSERT must not move the incremental gauge"
        );

        clear_on_success(&pool, &task, &metrics).await.unwrap();
        assert_eq!(
            pending_count(&pool).await.unwrap(),
            1,
            "#2187: with an empty gauge, clear_on_success must issue NO DELETE — \
             the raw-planted row must survive"
        );
        assert_eq!(
            metrics
                .pending_retry_rows
                .load(std::sync::atomic::Ordering::Relaxed),
            0,
            "#2187: the skipped DELETE must not touch the gauge"
        );

        // --- Part 2: recorded failure bumps gauge; success clears + floors. ---
        let (pool2, _dir2) = test_pool().await;
        let metrics2 = test_metrics();
        record_failure(&pool2, &task, "boom", &metrics2)
            .await
            .unwrap();
        assert_eq!(
            metrics2
                .pending_retry_rows
                .load(std::sync::atomic::Ordering::Relaxed),
            1,
            "#2187: a recorded failure must increment the gauge to 1"
        );

        clear_on_success(&pool2, &task, &metrics2).await.unwrap();
        assert_eq!(
            pending_count(&pool2).await.unwrap(),
            0,
            "#2187: with a non-empty gauge, clear_on_success must delete the row"
        );
        assert_eq!(
            metrics2
                .pending_retry_rows
                .load(std::sync::atomic::Ordering::Relaxed),
            0,
            "#2187: clearing the row must decrement the gauge back to 0"
        );
    }

    /// Issue #378 — `clear_on_success` no-ops for non-retryable tasks
    /// (the hot consumer success path hands it every task).
    #[tokio::test]
    async fn clear_on_success_ignores_non_retryable_378() {
        let (pool, _dir) = test_pool().await;
        // RebuildFtsIndex is non-retryable; from_task returns None.
        clear_on_success(&pool, &MaterializeTask::RebuildFtsIndex, &test_metrics())
            .await
            .unwrap();
        assert_eq!(pending_count(&pool).await.unwrap(), 0);
    }

    /// Issue #378 — `lease_entry` pushes next_attempt_at forward without
    /// touching attempts/created_at, and a leased row drops out of
    /// `fetch_due` until the lease expires.
    #[tokio::test]
    async fn lease_entry_defers_row_without_touching_attempts_378() {
        let (pool, _dir) = test_pool().await;
        let past = crate::db::now_ms() - 5 * 60_000;
        let created = crate::db::now_ms() - 1_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "BLK_378_LEASE",
            "UpdateFtsBlock",
            3_i64,
            created,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Due before the lease.
        assert_eq!(fetch_due(&pool, 10).await.unwrap().len(), 1);

        lease_entry(&pool, "BLK_378_LEASE", "UpdateFtsBlock", 3)
            .await
            .unwrap();

        let row = sqlx::query!(
            "SELECT attempts AS \"attempts!: i64\", \
                    created_at AS \"created_at!: i64\", \
                    next_attempt_at AS \"next_attempt_at!: i64\" \
             FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_378_LEASE",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.attempts, 3, "lease must not change attempts");
        assert_eq!(row.created_at, created, "lease must not change created_at");
        assert!(
            row.next_attempt_at > past,
            "lease must defer next_attempt_at"
        );
        // Not due anymore.
        assert!(
            fetch_due(&pool, 10).await.unwrap().is_empty(),
            "leased row must not be due until the lease expires"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_skips_future_rows() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let future = crate::db::now_ms() + 3_600_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SWF",
            "UpdateFtsBlock",
            1_i64,
            future,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 0, "future-dated rows must NOT be swept");
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(remaining, 1, "future row must remain in the queue");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_drops_unknown_task_kind_rows() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let past = crate::db::now_ms() - 5 * 60_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, next_attempt_at) \
             VALUES (?, ?, ?, ?)",
            "BLK_SWU",
            "SomeFutureTaskKind",
            1_i64,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "unknown task_kind rows are NOT counted as re-enqueued"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "unknown task_kind rows must be dropped so the table does not grow unbounded"
        );
    }

    // --- Issue #157 sub-item D: retry_queue_giveup ---

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_gives_up_on_max_attempts_157_d() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // A due row that has already failed MAX_ATTEMPTS times — the
        // sweeper must give up and delete it, not re-enqueue.
        let past = crate::db::now_ms() - 5 * 60_000;
        let recent_created = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "BLK_GIVEUP_ATTEMPTS",
            "UpdateFtsBlock",
            MAX_ATTEMPTS,
            recent_created,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "give-up rows are NOT counted as re-enqueued — they're permanently dropped"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "give-up row must be deleted (no further retries)"
        );
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 1,
            "retry_queue_giveup_total metric must increment exactly once on max-attempts give-up"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_gives_up_on_age_exceeded_157_d() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // A due row whose `created_at` is older than GIVE_UP_AGE_DAYS —
        // the sweeper must give up and delete it even though `attempts`
        // is still below the cap.
        let past = crate::db::now_ms() - 5 * 60_000;
        let stale_created = crate::db::now_ms() - (GIVE_UP_AGE_DAYS + 1) * 86_400_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "BLK_GIVEUP_AGE",
            "UpdateFtsBlock",
            2_i64,
            stale_created,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 0, "stale rows are permanently dropped, not re-enqueued");
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(remaining, 0, "stale row must be deleted");
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 1,
            "retry_queue_giveup_total metric must increment on age-exceeded give-up"
        );
    }

    /// #2541: [`give_up_reason`] exempts rows whose LATEST persistence was a
    /// shed ([`SHED_LAST_ERROR`]) from the `max_attempts` trigger — those
    /// attempts came from queue saturation, not executions — while a real
    /// execution error at the cap still gives up, and the wall-clock
    /// `age_exceeded` trigger applies even to shed rows.
    #[test]
    fn give_up_reason_exempts_shed_rows_from_max_attempts_2541() {
        let shed_at_cap = DueRow {
            block_id: "B".into(),
            task_kind: "UpdateFtsBlock".into(),
            attempts: MAX_ATTEMPTS,
            created_at: crate::db::now_ms(),
            last_error: Some(SHED_LAST_ERROR.into()),
        };
        assert_eq!(
            give_up_reason(&shed_at_cap),
            None,
            "a shed-persisted row at the attempts cap must NOT be given up"
        );

        let executed_at_cap = DueRow {
            block_id: "B".into(),
            task_kind: "UpdateFtsBlock".into(),
            attempts: MAX_ATTEMPTS,
            created_at: crate::db::now_ms(),
            last_error: Some("boom: real execution failure".into()),
        };
        assert_eq!(
            give_up_reason(&executed_at_cap),
            Some("max_attempts"),
            "a real execution failure at the cap must still give up"
        );

        let stale_shed = DueRow {
            block_id: "B".into(),
            task_kind: "UpdateFtsBlock".into(),
            attempts: MAX_ATTEMPTS,
            created_at: crate::db::now_ms() - (GIVE_UP_AGE_DAYS + 1) * 86_400_000,
            last_error: Some(SHED_LAST_ERROR.into()),
        };
        assert_eq!(
            give_up_reason(&stale_shed),
            Some("age_exceeded"),
            "the wall-clock trigger must still bound abandoned shed rows"
        );
    }

    /// #2541: a due row swept into a SATURATED background queue is a SHED,
    /// not a re-dispatch. `sweep_once` must (a) not count it as re-enqueued
    /// and (b) not `lease_entry` it — the shed path's spawned
    /// `record_failure` reschedules the row with the ESCALATED backoff, and
    /// the old stale-`attempts` lease racing that UPSERT could REWIND
    /// `next_attempt_at`.
    ///
    /// Determinism: the background consumer batch-drains the channel the
    /// moment it is scheduled, so a saturated channel alone races the
    /// consumer. Instead the WRITER is taken hostage with an open
    /// `BEGIN IMMEDIATE` transaction: the consumer dequeues one batch and
    /// then sits in its handler's 5s `busy_timeout` wait — NOT in `recv()` —
    /// while the channel is refilled to capacity. The sweep's
    /// `try_enqueue_background` then deterministically lands in the Full
    /// arm. Single-threaded runtime keeps the enqueue loop unpreemptible.
    #[tokio::test]
    async fn sweep_shed_not_counted_and_backoff_not_rewound_2541() {
        use crate::materializer::{BackgroundEnqueueOutcome, Materializer};
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // A due row with attempts = 1: the old buggy lease would set
        // `next_attempt_at = now + backoff(1) = +1 min`, while the shed
        // path's record_failure escalates to attempts = 2 → +5 min. The gap
        // makes a rewind observable.
        let now = crate::db::now_ms();
        let past = now - 5 * 60_000;
        sqlx::query(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at, last_error) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("BLK_SHED_2541")
        .bind("UpdateFtsBlock")
        .bind(1_i64)
        .bind(now)
        .bind(past)
        .bind("boom")
        .execute(&pool)
        .await
        .unwrap();

        // Take the writer hostage so every consumer write waits on the 5s
        // busy_timeout instead of completing.
        let hostage = crate::db::begin_immediate_logged(&pool, "test_2541_hostage")
            .await
            .unwrap();

        // Wake the consumer with one write-hungry task and yield until it
        // has drained the (1-element) batch and is stuck inside the handler.
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .unwrap();
        // Real-time sleep (not just yields): the consumer's descent into the
        // blocked SQL write crosses sqlx's worker-thread channel, which
        // needs wall-clock time, not only scheduler turns. 250ms is far
        // inside the 5s busy_timeout window the consumer then waits in.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        // Refill the channel to capacity; the consumer is busy, not in
        // `recv()`, so it stays full. The filler is deliberately
        // NON-retryable (`FtsOptimize` — `RetryKind::from_task` is `None`)
        // so filler sheds spawn no `record_failure` writes of their own.
        let mut probe = BackgroundEnqueueOutcome::Enqueued;
        for _ in 0..1100 {
            probe = mat
                .try_enqueue_background(MaterializeTask::FtsOptimize)
                .unwrap();
        }
        assert_eq!(
            probe,
            BackgroundEnqueueOutcome::Shed,
            "precondition: the channel must be saturated before the sweep"
        );

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "#2541: a shed must not be counted as a successful re-enqueue"
        );

        // Release the writer so the shed path's spawned record_failure (and
        // the parked consumer) can complete.
        drop(hostage);

        // Poll until the shed UPSERT lands (attempts 1 → 2, marker set).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let (attempts, last_error, next_attempt_at) = loop {
            let row: (i64, Option<String>, i64) = sqlx::query_as(
                "SELECT attempts, last_error, next_attempt_at \
                 FROM materializer_retry_queue \
                 WHERE block_id = 'BLK_SHED_2541' AND task_kind = 'UpdateFtsBlock'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            if row.0 >= 2 {
                break row;
            }
            assert!(
                std::time::Instant::now() <= deadline,
                "#2541: the shed path's record_failure must UPSERT the row"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        };
        assert_eq!(attempts, 2, "one shed persistence on top of the seed row");
        assert_eq!(
            last_error.as_deref(),
            Some(SHED_LAST_ERROR),
            "#2541: a shed must be recorded with the distinct shed marker"
        );
        // attempts = 2 → the escalated +5 min backoff. A lease keyed on the
        // STALE attempts = 1 snapshot would have rewound this to ~+1 min.
        let min_expected = crate::db::now_ms() + 2 * 60_000;
        assert!(
            next_attempt_at > min_expected,
            "#2541: next_attempt_at must keep the escalated backoff \
             (got {next_attempt_at}, expected > {min_expected}) — the sweeper \
             must not lease/rewind a shed row"
        );
        mat.shutdown();
    }

    /// #2541: the shed exemption end-to-end — a row at the `MAX_ATTEMPTS`
    /// cap whose latest persistence was a shed is swept back onto the (now
    /// free) queue instead of being permanently dropped.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_reenqueues_shed_row_at_attempts_cap_2541() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let now = crate::db::now_ms();
        let past = now - 5 * 60_000;
        sqlx::query(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at, last_error) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("BLK_SHED_CAP_2541")
        .bind("UpdateFtsBlock")
        .bind(MAX_ATTEMPTS)
        .bind(now)
        .bind(past)
        .bind(SHED_LAST_ERROR)
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "#2541: a shed-capped row must be re-enqueued, not given up"
        );
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 0,
            "#2541: shed-driven attempts must not burn the give-up budget"
        );
        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_below_thresholds_still_reenqueues_157_d() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Both triggers below threshold — the row must follow the normal
        // re-enqueue path, not the give-up path. Pins the boundary.
        let past = crate::db::now_ms() - 5 * 60_000;
        let recent_created = crate::db::now_ms() - (GIVE_UP_AGE_DAYS - 1) * 86_400_000;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "BLK_GIVEUP_BORDER",
            "UpdateFtsBlock",
            MAX_ATTEMPTS - 1,
            recent_created,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "below both thresholds: row must be re-enqueued, not given up on"
        );
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 0,
            "retry_queue_giveup_total must stay zero for normal-path rows"
        );
    }

    // --- #621: persisted ApplyOp rows are correctness, not cache freshness ---

    /// Insert a raw op_log row for the ApplyOp sweep tests.
    async fn insert_sweep_op(
        pool: &SqlitePool,
        device_id: &str,
        seq: i64,
        op_type: &str,
        payload: &str,
        block_id: &str,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(seq)
        .bind(format!("hash-{device_id}-{seq}"))
        .bind(op_type)
        .bind(payload)
        .bind(created_at)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #621 (cursor-gap half): an ApplyOp row past BOTH give-up thresholds
    /// must NOT be retired — the apply cursor has already leapt past the
    /// dropped seq, so this row is the only remaining recovery net. The op
    /// payload is deliberately invalid (`{}`) so the re-enqueued apply fails
    /// and `clear_on_success` can never race the row away.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_keeps_apply_op_rows_past_give_up_thresholds_621() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_sweep_op(
            &pool,
            "dev-621",
            1,
            "create_block",
            "{}", // invalid payload → the re-applied op keeps failing
            "BLK621KEEP",
            crate::db::now_ms(),
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let stale_created = crate::db::now_ms() - (GIVE_UP_AGE_DAYS + 1) * 86_400_000;
        let attempts = MAX_ATTEMPTS + 3;
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:1:dev-621",
            attempts,
            stale_created,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "an over-threshold ApplyOp row must still be re-enqueued (#621)"
        );
        let giveups = mat
            .metrics()
            .retry_queue_giveup_total
            .load(Ordering::Relaxed);
        assert_eq!(
            giveups, 0,
            "ApplyOp rows are exempt from the give-up triggers (#621)"
        );
        // Drain the (failing) re-apply, then confirm the row survived.
        mat.flush_foreground().await.unwrap();
        let remaining: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) as \"n!: i64\" FROM materializer_retry_queue \
             WHERE task_kind = 'ApplyOp:1:dev-621'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            remaining, 1,
            "the ApplyOp row must survive until durable success (#621)"
        );
        mat.shutdown();
    }

    /// #621: an ApplyOp row whose op_log row no longer exists (compacted /
    /// corrupted) is permanent — the sweeper retires it instead of erroring
    /// on every sweep forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_when_op_log_row_missing_621() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:42:dev-gone",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 0, "nothing to re-enqueue — the op row is gone");
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "an ApplyOp row without a backing op_log row must be retired (#621)"
        );
        mat.shutdown();
    }

    /// #621 (out-of-order-sweep half): an ApplyOp superseded by a LATER
    /// `purge_block` of the same block must be retired, not re-applied —
    /// re-applying would resurrect user-destroyed data (`INSERT OR IGNORE`
    /// projection with no purge check + engine node recreation).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_superseded_by_purge_621() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        // The failed-then-persisted create, and the later successful purge.
        insert_sweep_op(
            &pool,
            "dev-621p",
            1,
            "create_block",
            r#"{"block_id":"BLK621PURGED","block_type":"content","content":"x","parent_id":null,"position":1}"#,
            "BLK621PURGED",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-621p",
            2,
            "purge_block",
            r#"{"block_id":"BLK621PURGED"}"#,
            "BLK621PURGED",
            t0 + 1000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:1:dev-621p",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 0, "a purge-superseded ApplyOp must not be re-enqueued");
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(remaining, 0, "the superseded row must be retired (#621)");

        // The purged block must NOT have been resurrected.
        let resurrected: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'BLK621PURGED'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            resurrected, 0,
            "sweeping must not re-insert a block a later purge destroyed (#621)"
        );
        mat.shutdown();
    }

    /// #850 (out-of-order-sweep half, mirroring the #621 purge gate): a stale
    /// `edit_block` ApplyOp row that is superseded by a LATER `edit_block` on
    /// the same block must be retired, not re-applied — re-applying would
    /// regress the newer content (`apply_edit_block_via_loro` splices
    /// `to_text` and projects the snapshot, overwriting SQL/engine state).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_superseded_by_later_edit_850() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // The block exists with the NEWER content (what the later edit
        // produced and the user observed). The sweep must preserve it.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) \
             VALUES ('BLK850EDIT', 'content', 'NEW content')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let t0 = crate::db::now_ms() - 60_000;
        // seq 1: the failed-then-persisted STALE edit_block.
        insert_sweep_op(
            &pool,
            "dev-850e",
            1,
            "edit_block",
            r#"{"block_id":"BLK850EDIT","to_text":"STALE content"}"#,
            "BLK850EDIT",
            t0,
        )
        .await;
        // seq 2: the LATER edit_block that already won under strict LWW.
        insert_sweep_op(
            &pool,
            "dev-850e",
            2,
            "edit_block",
            r#"{"block_id":"BLK850EDIT","to_text":"NEW content"}"#,
            "BLK850EDIT",
            t0 + 1000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:1:dev-850e",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "an edit-superseded ApplyOp must not be re-enqueued (#850)"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "the superseded edit row must be retired (#850)"
        );

        // The newer content must be PRESERVED — the stale edit was dropped.
        let content: String =
            sqlx::query_scalar("SELECT content FROM blocks WHERE id = 'BLK850EDIT'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            content, "NEW content",
            "sweeping a stale edit must not regress content a later edit produced (#850)"
        );
        mat.shutdown();
    }

    /// #850 (boundary): the LWW comparison is STRICT — an `edit_block` is
    /// never superseded by ITSELF. With no later edit present, the lone stale
    /// edit row is re-enqueued normally (not retired by the new gate).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_reenqueues_lone_edit_not_self_superseded_850() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        insert_sweep_op(
            &pool,
            "dev-850s",
            1,
            "edit_block",
            r#"{"block_id":"BLK850SOLO","to_text":"only edit"}"#,
            "BLK850SOLO",
            t0,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:1:dev-850s",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "a lone edit (no later edit) must be re-enqueued — the gate is strict (#850)"
        );
        mat.shutdown();
    }

    /// #2212 (a): a persisted child `edit_block` swept AFTER an ANCESTOR was
    /// purged must be RETIRED, not re-applied. A `purge_block` writes a single
    /// op_log row for the subtree root only (the descendant removal is a SQL
    /// cascade with no per-descendant op_log rows), so the same-block purge
    /// gate cannot see it — the ancestor-lineage gate must. Re-applying would
    /// resurrect an orphan under a user-destroyed subtree.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_superseded_by_ancestor_purge_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        // create ANCESTOR (root, parent_id null).
        insert_sweep_op(
            &pool,
            "dev-2212a",
            1,
            "create_block",
            r#"{"block_id":"ANCESTOR2212A","block_type":"content","content":"a","parent_id":null,"position":1}"#,
            "ANCESTOR2212A",
            t0,
        )
        .await;
        // create CHILD under the ancestor.
        insert_sweep_op(
            &pool,
            "dev-2212a",
            2,
            "create_block",
            r#"{"block_id":"CHILD2212A","block_type":"content","content":"c","parent_id":"ANCESTOR2212A","position":1}"#,
            "CHILD2212A",
            t0,
        )
        .await;
        // seq 3: the failed-then-persisted edit of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212a",
            3,
            "edit_block",
            r#"{"block_id":"CHILD2212A","to_text":"edited child"}"#,
            "CHILD2212A",
            t0,
        )
        .await;
        // seq 4: LATER purge of the ANCESTOR — its cascade physically removed
        // the child with NO op_log row targeting the child.
        insert_sweep_op(
            &pool,
            "dev-2212a",
            4,
            "purge_block",
            r#"{"block_id":"ANCESTOR2212A"}"#,
            "ANCESTOR2212A",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:3:dev-2212a",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "an ancestor-purge-superseded ApplyOp must NOT be re-enqueued (#2212)"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "the ancestor-purge-superseded row must be retired (#2212)"
        );
        mat.shutdown();
    }

    /// #2212 (b): an UNRELATED later purge of a DIFFERENT subtree must NOT
    /// retire the record — the ancestry gate matches only purges of THIS
    /// block's own create-op lineage, so a create/edit whose real ancestors
    /// are untouched still re-applies.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_reenqueues_apply_op_when_unrelated_subtree_purged_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        // The block's real lineage: ANCESTOR -> CHILD (never purged).
        insert_sweep_op(
            &pool,
            "dev-2212b",
            1,
            "create_block",
            r#"{"block_id":"ANCESTOR2212B","block_type":"content","content":"a","parent_id":null,"position":1}"#,
            "ANCESTOR2212B",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212b",
            2,
            "create_block",
            r#"{"block_id":"CHILD2212B","block_type":"content","content":"c","parent_id":"ANCESTOR2212B","position":1}"#,
            "CHILD2212B",
            t0,
        )
        .await;
        // seq 3: the failed-then-persisted edit of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212b",
            3,
            "edit_block",
            r#"{"block_id":"CHILD2212B","to_text":"edited child"}"#,
            "CHILD2212B",
            t0,
        )
        .await;
        // seq 4/5: an UNRELATED root and its LATER purge — NOT an ancestor of
        // CHILD2212B.
        insert_sweep_op(
            &pool,
            "dev-2212b",
            4,
            "create_block",
            r#"{"block_id":"UNRELATED2212B","block_type":"content","content":"u","parent_id":null,"position":2}"#,
            "UNRELATED2212B",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212b",
            5,
            "purge_block",
            r#"{"block_id":"UNRELATED2212B"}"#,
            "UNRELATED2212B",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:3:dev-2212b",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "a record whose real lineage is untouched must re-enqueue despite \
             an unrelated later purge (#2212)"
        );
        mat.shutdown();
    }

    /// #2212 (c): the pre-existing SAME-block purge supersession still fires
    /// with the ancestor gate in place — a lineage-carrying create whose OWN
    /// block is later purged is retired via the same-block gate (returned
    /// early, before the ancestor gate is even reached).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_same_block_purge_still_works_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        // Ancestor create present (so the ancestry walk has data), but the
        // purge below targets the CHILD itself, not the ancestor.
        insert_sweep_op(
            &pool,
            "dev-2212c",
            1,
            "create_block",
            r#"{"block_id":"ANCESTOR2212C","block_type":"content","content":"a","parent_id":null,"position":1}"#,
            "ANCESTOR2212C",
            t0,
        )
        .await;
        // seq 2: the failed-then-persisted create of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212c",
            2,
            "create_block",
            r#"{"block_id":"CHILD2212C","block_type":"content","content":"c","parent_id":"ANCESTOR2212C","position":1}"#,
            "CHILD2212C",
            t0,
        )
        .await;
        // seq 3: LATER purge of the CHILD ITSELF (same-block supersession).
        insert_sweep_op(
            &pool,
            "dev-2212c",
            3,
            "purge_block",
            r#"{"block_id":"CHILD2212C"}"#,
            "CHILD2212C",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:2:dev-2212c",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "same-block purge supersession must still retire the row (#2212 regression guard)"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "the same-block-purge-superseded row must be retired (#2212)"
        );
        mat.shutdown();
    }

    /// #2212 (d): a block MOVED INTO a subtree whose root is later purged must
    /// be retired. Its create op's `parent_id` points at the ORIGINAL parent
    /// (never purged); only the latest `move_block`'s `new_parent_id` reaches
    /// the actually-purged ancestor. A create-op-only lineage walk misses this
    /// and re-applies — resurrecting an orphan under user-destroyed data.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_retires_apply_op_when_block_moved_into_purged_subtree_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        // Two roots: the block is created under OLD, then moved under NEW.
        insert_sweep_op(
            &pool,
            "dev-2212d",
            1,
            "create_block",
            r#"{"block_id":"OLDPARENT2212D","block_type":"content","content":"o","parent_id":null,"position":1}"#,
            "OLDPARENT2212D",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212d",
            2,
            "create_block",
            r#"{"block_id":"NEWPARENT2212D","block_type":"content","content":"n","parent_id":null,"position":2}"#,
            "NEWPARENT2212D",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212d",
            3,
            "create_block",
            r#"{"block_id":"CHILD2212D","block_type":"content","content":"c","parent_id":"OLDPARENT2212D","position":1}"#,
            "CHILD2212D",
            t0,
        )
        .await;
        // seq 4: the failed-then-persisted edit of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212d",
            4,
            "edit_block",
            r#"{"block_id":"CHILD2212D","to_text":"edited child"}"#,
            "CHILD2212D",
            t0,
        )
        .await;
        // seq 5: CHILD moved OLDPARENT → NEWPARENT.
        insert_sweep_op(
            &pool,
            "dev-2212d",
            5,
            "move_block",
            r#"{"block_id":"CHILD2212D","new_parent_id":"NEWPARENT2212D","new_position":1}"#,
            "CHILD2212D",
            t0 + 1000,
        )
        .await;
        // seq 6: LATER purge of NEWPARENT — the block's EFFECTIVE (post-move)
        // ancestor. Its cascade physically removed the child.
        insert_sweep_op(
            &pool,
            "dev-2212d",
            6,
            "purge_block",
            r#"{"block_id":"NEWPARENT2212D"}"#,
            "NEWPARENT2212D",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:4:dev-2212d",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 0,
            "a record whose block was MOVED INTO a later-purged subtree must \
             NOT be re-enqueued (#2212 move-aware lineage)"
        );
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "the moved-into-purged-subtree row must be retired (#2212)"
        );
        mat.shutdown();
    }

    /// #2212 (e): a block MOVED OUT of a subtree whose root is later purged
    /// must RE-APPLY. Its create op's `parent_id` points at the purged parent,
    /// but the block lives elsewhere (post-move) — a create-op-only lineage
    /// walk would WRONGLY RETIRE this legitimate record (silent data loss,
    /// strictly worse than a wrong re-apply).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_reenqueues_apply_op_when_block_moved_out_of_purged_subtree_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        insert_sweep_op(
            &pool,
            "dev-2212e",
            1,
            "create_block",
            r#"{"block_id":"OLDPARENT2212E","block_type":"content","content":"o","parent_id":null,"position":1}"#,
            "OLDPARENT2212E",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212e",
            2,
            "create_block",
            r#"{"block_id":"NEWPARENT2212E","block_type":"content","content":"n","parent_id":null,"position":2}"#,
            "NEWPARENT2212E",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212e",
            3,
            "create_block",
            r#"{"block_id":"CHILD2212E","block_type":"content","content":"c","parent_id":"OLDPARENT2212E","position":1}"#,
            "CHILD2212E",
            t0,
        )
        .await;
        // seq 4: the failed-then-persisted edit of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212e",
            4,
            "edit_block",
            r#"{"block_id":"CHILD2212E","to_text":"edited child"}"#,
            "CHILD2212E",
            t0,
        )
        .await;
        // seq 5: CHILD moved OUT: OLDPARENT → NEWPARENT.
        insert_sweep_op(
            &pool,
            "dev-2212e",
            5,
            "move_block",
            r#"{"block_id":"CHILD2212E","new_parent_id":"NEWPARENT2212E","new_position":1}"#,
            "CHILD2212E",
            t0 + 1000,
        )
        .await;
        // seq 6: LATER purge of the ORIGINAL parent — no longer an ancestor.
        insert_sweep_op(
            &pool,
            "dev-2212e",
            6,
            "purge_block",
            r#"{"block_id":"OLDPARENT2212E"}"#,
            "OLDPARENT2212E",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:4:dev-2212e",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "a record whose block was MOVED OUT of the later-purged subtree \
             must re-enqueue — retiring it would silently drop a legitimate \
             edit (#2212 move-aware lineage)"
        );
        mat.shutdown();
    }

    /// #2212 (f): a block moved to ROOT (`new_parent_id = null`) whose ORIGINAL
    /// parent is later purged must RE-APPLY. Guards the COALESCE footgun: a
    /// null `new_parent_id` must terminate the ancestry chain, NOT fall back to
    /// the stale create-op parent (which would wrongly retire the record).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_reenqueues_apply_op_when_block_moved_to_root_2212() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let t0 = crate::db::now_ms() - 60_000;
        insert_sweep_op(
            &pool,
            "dev-2212f",
            1,
            "create_block",
            r#"{"block_id":"OLDPARENT2212F","block_type":"content","content":"o","parent_id":null,"position":1}"#,
            "OLDPARENT2212F",
            t0,
        )
        .await;
        insert_sweep_op(
            &pool,
            "dev-2212f",
            2,
            "create_block",
            r#"{"block_id":"CHILD2212F","block_type":"content","content":"c","parent_id":"OLDPARENT2212F","position":1}"#,
            "CHILD2212F",
            t0,
        )
        .await;
        // seq 3: the failed-then-persisted edit of the CHILD (the swept op).
        insert_sweep_op(
            &pool,
            "dev-2212f",
            3,
            "edit_block",
            r#"{"block_id":"CHILD2212F","to_text":"edited child"}"#,
            "CHILD2212F",
            t0,
        )
        .await;
        // seq 4: CHILD promoted to ROOT (new_parent_id null).
        insert_sweep_op(
            &pool,
            "dev-2212f",
            4,
            "move_block",
            r#"{"block_id":"CHILD2212F","new_parent_id":null,"new_position":1}"#,
            "CHILD2212F",
            t0 + 1000,
        )
        .await;
        // seq 5: LATER purge of the ORIGINAL parent — no longer an ancestor.
        insert_sweep_op(
            &pool,
            "dev-2212f",
            5,
            "purge_block",
            r#"{"block_id":"OLDPARENT2212F"}"#,
            "OLDPARENT2212F",
            t0 + 2000,
        )
        .await;

        let past = crate::db::now_ms() - 5 * 60_000;
        let recent = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO materializer_retry_queue \
                 (block_id, task_kind, attempts, created_at, next_attempt_at) \
             VALUES (?, ?, ?, ?, ?)",
            "__APPLY_OP__",
            "ApplyOp:3:dev-2212f",
            1_i64,
            recent,
            past,
        )
        .execute(&pool)
        .await
        .unwrap();

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(
            n, 1,
            "a record whose block was moved to ROOT must re-enqueue — a null \
             new_parent_id terminates the chain, it does not fall back to the \
             stale create parent (#2212 move-aware lineage)"
        );
        mat.shutdown();
    }

    // --- global cache rebuild persistence ---

    /// Round-trip every persistable cache-rebuild / projection task
    /// through `record_failure` → row → `task_from_row` and assert the
    /// reconstructed task matches the original kind.
    ///
    /// The table below covers EVERY `RetryKind` for which
    /// `is_global() == true` (all 9: the seven original `Rebuild*` global
    /// rebuilds PLUS `RebuildPagesCacheCounts` and `RebuildPageLinkCache`,
    /// which an earlier revision of this test silently omitted — a
    /// `from_task`/`from_str` regression on either would drop the row as
    /// unknown and never retry the rebuild). It also covers the two
    /// per-block kinds that share this persistence path but are NOT global
    /// (`SetBlockPageId`, `RefreshTagUsageCount`), where the real block /
    /// tag id must survive the round-trip rather than being replaced by
    /// the `__GLOBAL__` sentinel.
    ///
    /// The `is_global()`-coverage assertion at the end fails loudly if a
    /// new global variant is added to `is_global()` without a matching row
    /// here, so this table cannot silently fall out of date again.
    #[tokio::test]
    async fn test_global_task_persistence() {
        // (task, expected task_kind string, expected persisted block_id).
        // For global kinds the persisted block_id is the sentinel; for the
        // per-block kinds it is the real id passed in the task.
        let cases: [(MaterializeTask, &str, &str); 11] = [
            // --- global (is_global() == true) ---
            (
                MaterializeTask::RebuildTagsCache,
                "RebuildTagsCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildPagesCache,
                "RebuildPagesCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildPagesCacheCounts,
                "RebuildPagesCacheCounts",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildAgendaCache,
                "RebuildAgendaCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildProjectedAgendaCache,
                "RebuildProjectedAgendaCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildTagInheritanceCache,
                "RebuildTagInheritanceCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildPageIds,
                "RebuildPageIds",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildBlockTagRefsCache,
                "RebuildBlockTagRefsCache",
                GLOBAL_TASK_SENTINEL,
            ),
            (
                MaterializeTask::RebuildPageLinkCache,
                "RebuildPageLinkCache",
                GLOBAL_TASK_SENTINEL,
            ),
            // --- per-block kinds sharing this persistence path (NOT global) ---
            (
                MaterializeTask::SetBlockPageId {
                    block_id: "BLK_SPID".into(),
                },
                "SetBlockPageId",
                "BLK_SPID",
            ),
            (
                MaterializeTask::RefreshTagUsageCount {
                    tag_id: "TAG_RTUC".into(),
                },
                "RefreshTagUsageCount",
                "TAG_RTUC",
            ),
        ];

        // Track which global kinds the table exercises so the coverage
        // assertion below can prove EVERY `is_global()` variant is present.
        let mut covered_global_kinds: Vec<String> = Vec::new();

        for (task, kind_str, expected_block_id) in cases {
            // Note for the coverage check: only record kinds that report
            // `is_global()`. `RetryKind::from_task` returns the kind so we
            // can classify without re-deriving it.
            let (kind, _) = RetryKind::from_task(&task)
                .unwrap_or_else(|| panic!("task {task:?} must be retryable"));
            if kind.is_global() {
                covered_global_kinds.push(kind.task_kind_str().into_owned());
            }

            let (pool, _dir) = test_pool().await;
            record_failure(&pool, &task, "boom-global", &test_metrics())
                .await
                .unwrap();

            // Row landed under the expected block_id with the right kind.
            let row = sqlx::query!(
                "SELECT block_id, task_kind, attempts, last_error, created_at \
                 FROM materializer_retry_queue",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                row.block_id, expected_block_id,
                "task {kind_str} must persist under block_id '{expected_block_id}'"
            );
            assert_eq!(row.task_kind, kind_str);
            assert_eq!(row.attempts, 1);
            assert_eq!(row.last_error.as_deref(), Some("boom-global"));

            // Reconstruction via the sweeper path re-loads to the SAME kind
            // (global kinds discard the sentinel; per-block kinds keep the
            // real id). A `from_str` regression on the two formerly-omitted
            // variants would make `task_from_row` return `None` here.
            let due = DueRow {
                block_id: row.block_id.clone(),
                task_kind: row.task_kind,
                attempts: row.attempts,
                created_at: row.created_at,
                last_error: row.last_error.clone(),
            };
            let reconstructed = task_from_row(&due).unwrap_or_else(|| {
                panic!("task_from_row must reconstruct {kind_str} (regression would drop the row)")
            });
            assert_eq!(
                std::mem::discriminant(&reconstructed),
                std::mem::discriminant(&task),
                "round-trip must produce the same MaterializeTask variant for {kind_str}"
            );
            // Per-block kinds must additionally preserve the real id through
            // the round-trip (the sentinel must NOT leak in).
            match &reconstructed {
                MaterializeTask::SetBlockPageId { block_id } => {
                    assert_eq!(block_id.as_ref(), expected_block_id);
                }
                MaterializeTask::RefreshTagUsageCount { tag_id } => {
                    assert_eq!(tag_id.as_ref(), expected_block_id);
                }
                _ => {}
            }
        }

        // Coverage guard: assert the table above exercised EVERY variant
        // that `is_global()` returns true for. Build the full set of global
        // kinds from the `RetryKind` enum and require each appears in the
        // table. If a future variant is added to `is_global()` without a
        // corresponding row, this fails — no more "all 7" lie.
        let all_global_kinds = [
            RetryKind::RebuildTagsCache,
            RetryKind::RebuildPagesCache,
            RetryKind::RebuildPagesCacheCounts,
            RetryKind::RebuildAgendaCache,
            RetryKind::RebuildProjectedAgendaCache,
            RetryKind::RebuildTagInheritanceCache,
            RetryKind::RebuildPageIds,
            RetryKind::RebuildBlockTagRefsCache,
            RetryKind::RebuildPageLinkCache,
        ];
        for k in &all_global_kinds {
            assert!(
                k.is_global(),
                "enumerated kind {k:?} must report is_global()"
            );
            let name = k.task_kind_str().into_owned();
            assert!(
                covered_global_kinds.contains(&name),
                "is_global() variant {name} is missing from the persistence round-trip table"
            );
        }
        assert_eq!(
            covered_global_kinds.len(),
            all_global_kinds.len(),
            "the round-trip table must cover exactly the set of is_global() variants \
             (covered: {covered_global_kinds:?})"
        );
    }

    /// A global task failing repeatedly walks the same
    /// 1m → 5m → 30m → 1h backoff schedule as per-block tasks.
    /// We assert via `attempts` increments and timestamp monotonicity;
    /// the exact wall-clock delay is enforced by `backoff_delay_for`
    /// (covered separately in `backoff_schedule_escalates_then_caps`).
    #[tokio::test]
    async fn test_global_task_backoff() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildTagsCache;

        let metrics = test_metrics();
        record_failure(&pool, &task, "e1", &metrics).await.unwrap();
        let first_attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let first_next: i64 = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        record_failure(&pool, &task, "e2", &metrics).await.unwrap();
        let second_attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let second_next: i64 = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(first_attempts, 1);
        assert_eq!(second_attempts, 2);
        assert!(
            second_next > first_next,
            "second failure must escalate next_attempt_at (got first={first_next}, second={second_next})"
        );
    }

    /// Two failures of the same global task coalesce into a
    /// single row via the composite PK `(block_id, task_kind)` —
    /// `'__GLOBAL__' + 'RebuildTagsCache'` uniquely identifies the
    /// entry, so the second `record_failure` UPSERTs rather than
    /// inserting a duplicate.
    #[tokio::test]
    async fn test_global_task_dedup() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildAgendaCache;

        let metrics = test_metrics();
        record_failure(&pool, &task, "e1", &metrics).await.unwrap();
        record_failure(&pool, &task, "e2", &metrics).await.unwrap();
        record_failure(&pool, &task, "e3", &metrics).await.unwrap();

        // Exactly one row, attempts == 3 (PK enforces dedup).
        let n = pending_count(&pool).await.unwrap();
        assert_eq!(
            n, 1,
            "PK (block_id, task_kind) must coalesce repeat global failures into one row"
        );

        let row = sqlx::query!(
            "SELECT block_id, task_kind, attempts, last_error \
             FROM materializer_retry_queue",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.block_id, GLOBAL_TASK_SENTINEL);
        assert_eq!(row.task_kind, "RebuildAgendaCache");
        assert_eq!(row.attempts, 3, "attempts must accumulate via UPSERT");
        assert_eq!(row.last_error.as_deref(), Some("e3"));
    }

    /// A per-block `UpdateFtsBlock` failure and a global
    /// `RebuildTagsCache` failure must not collide on the PK — they
    /// land in two distinct rows because `block_id` differs (real ULID
    /// vs. `'__GLOBAL__'`).
    #[tokio::test]
    async fn test_global_and_per_block_tasks_coexist() {
        let (pool, _dir) = test_pool().await;
        let block_task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_PB".into(),
        };
        let metrics = test_metrics();
        record_failure(&pool, &block_task, "blk-err", &metrics)
            .await
            .unwrap();
        record_failure(
            &pool,
            &MaterializeTask::RebuildTagsCache,
            "global-err",
            &metrics,
        )
        .await
        .unwrap();

        let n = pending_count(&pool).await.unwrap();
        assert_eq!(
            n, 2,
            "global and per-block failures must occupy distinct PK slots"
        );
    }

    /// Schema snapshot — pin the post-migration shape of
    /// `materializer_retry_queue` so any accidental future migration
    /// that reverts the column rename or the STRICT modifier surfaces
    /// as a snapshot diff.
    #[tokio::test]
    async fn materializer_retry_queue_schema() {
        let (pool, _dir) = test_pool().await;
        let row: (Option<String>,) =
            sqlx::query_as("SELECT sql FROM sqlite_master WHERE name = 'materializer_retry_queue'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let sql = row.0.unwrap_or_default();
        // STRICT modifier landed in (migration 0044).
        assert!(
            sql.contains("STRICT"),
            "materializer_retry_queue must be a STRICT table; sql={sql}"
        );
        // Task_kind replaced task_type in. Check the column
        // declaration shape directly (avoids matching the inline migration
        // comment that still mentions the old column name historically).
        assert!(
            sql.contains("task_kind"),
            "schema must use task_kind (rename); sql={sql}"
        );
        // Strip line comments before checking — the migration's `--`
        // comment intentionally references `task_type` to document the
        // rename, but the live schema columns must not.
        let sql_no_comments: String = sql
            .lines()
            .map(|l| match l.find("--") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !sql_no_comments.contains("task_type"),
            "live column declarations must not reference task_type after ; sql={sql}"
        );
        // Composite PK shape must remain (block_id, task_kind).
        assert!(
            sql.contains("PRIMARY KEY (block_id, task_kind)"),
            "PK must be (block_id, task_kind); sql={sql}"
        );
    }

    /// SQL-review (migration 0063): the single-column
    /// `idx_materializer_retry_queue_next` from migrations 0028 / 0044
    /// is replaced by the covering index
    /// `idx_materializer_retry_queue_due (next_attempt_at, block_id,
    /// task_kind)`. The sweeper SELECT in `fetch_due` projects
    /// `block_id, task_kind` while filtering and ordering on
    /// `next_attempt_at`, so a leading-prefix + trailing-projection
    /// index lets SQLite satisfy the query from the index alone (no
    /// back-row lookup). This regression guards three invariants:
    ///   1. the old index is gone,
    ///   2. the new index exists,
    ///   3. `EXPLAIN QUERY PLAN` for the sweeper SELECT actually uses
    ///      the new index (so a future planner / schema change that
    ///      silently falls back to a full scan surfaces here).
    #[tokio::test]
    async fn materializer_retry_queue_covering_index_exists() {
        let (pool, _dir) = test_pool().await;

        let legacy = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_materializer_retry_queue_next'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            legacy, 0,
            "migration 0063 must drop the single-column \
             idx_materializer_retry_queue_next (non-covering)"
        );

        let covering = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_materializer_retry_queue_due'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            covering, 1,
            "migration 0063 must create the covering \
             idx_materializer_retry_queue_due (next_attempt_at, block_id, task_kind)"
        );

        // EXPLAIN QUERY PLAN must reference the new index for the
        // sweeper SELECT shape. The bind values are placeholders — the
        // planner only inspects the SQL shape, not the bound data.
        let now = crate::db::now_ms();
        let limit: i64 = 64;
        let plan_rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            "EXPLAIN QUERY PLAN \
             SELECT block_id, task_kind FROM materializer_retry_queue \
             WHERE next_attempt_at <= ? \
             ORDER BY next_attempt_at ASC LIMIT ?",
        )
        .bind(now)
        .bind(limit)
        .fetch_all(&pool)
        .await
        .unwrap();
        let plan_text = plan_rows
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan_text.contains("idx_materializer_retry_queue_due"),
            "sweeper SELECT must use the covering index \
             idx_materializer_retry_queue_due; got plan:\n{plan_text}"
        );
    }
}
