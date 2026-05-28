//! Persistent retry queue for failed background materializer tasks (BUG-22, PEND-03).
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
//! queue saturation prior to PEND-03 — they're now persisted under the
//! sentinel `block_id = '__GLOBAL__'` so the sweeper re-enqueues them on
//! the same exponential-backoff schedule.
//!
//! Backoff schedule: 1 min → 5 min → 30 min → 1 h (cap).
//!
//! ## Two-tier retry semantics (MAINT-148h)
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

/// Sentinel literal stored in the `block_id` column for global cache
/// rebuild tasks (PEND-03). SQLite's `STRICT` mode forbids `NULL` in
/// `PRIMARY KEY` columns, so a literal stand-in is used instead. The
/// sentinel cannot collide with a real ULID block id (ULIDs are
/// 26-char Crockford base32 uppercase; the sentinel is lowercase
/// + underscores).
pub(crate) const GLOBAL_TASK_SENTINEL: &str = "__GLOBAL__";

/// Sentinel literal stored in the `block_id` column for foreground
/// `ApplyOp` failure rows (PEND-24 H1). Mirrors [`GLOBAL_TASK_SENTINEL`]:
/// the composite key for an apply-op failure is
/// `(device_id, seq)`, packed into the `task_kind` column as
/// `"ApplyOp:<seq>:<device_id>"`. The sentinel cannot collide with a
/// real ULID block id (ULIDs are 26-char Crockford base32 uppercase;
/// the sentinel is lowercase + underscores).
pub(crate) const APPLY_OP_TASK_SENTINEL: &str = "__APPLY_OP__";

/// Task kinds that may be persisted to the retry queue.
///
/// Three families:
/// - **Per-block** idempotent tasks (`UpdateFtsBlock`,
///   `ReindexBlockLinks`, `ReindexBlockTagRefs`) — keyed by their
///   real block id.
/// - **Global** cache rebuilds (PEND-03) — keyed by the
///   [`GLOBAL_TASK_SENTINEL`] literal so the composite primary key
///   `(block_id, task_kind)` enforces dedup naturally without
///   requiring a NULL column.
/// - **Foreground apply-op** failures (PEND-24 H1) — keyed by the
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
    /// UX-250: incremental `#[ULID]` tag-ref reindex for a single block.
    ReindexBlockTagRefs,
    // --- Global (PEND-03) ---
    /// Mirror of [`MaterializeTask::RebuildTagsCache`].
    RebuildTagsCache,
    /// Mirror of [`MaterializeTask::RebuildPagesCache`].
    RebuildPagesCache,
    /// Mirror of [`MaterializeTask::RebuildAgendaCache`].
    RebuildAgendaCache,
    /// Mirror of [`MaterializeTask::RebuildProjectedAgendaCache`].
    RebuildProjectedAgendaCache,
    /// Mirror of [`MaterializeTask::RebuildTagInheritanceCache`].
    RebuildTagInheritanceCache,
    /// Mirror of [`MaterializeTask::RebuildPageIds`].
    RebuildPageIds,
    /// Mirror of [`MaterializeTask::RebuildBlockTagRefsCache`].
    RebuildBlockTagRefsCache,
    /// Mirror of [`MaterializeTask::RebuildPageLinkCache`] (SQL-review §H-2).
    RebuildPageLinkCache,
    // --- Foreground apply-op (PEND-24 H1) ---
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
            Self::RebuildTagsCache => Cow::Borrowed("RebuildTagsCache"),
            Self::RebuildPagesCache => Cow::Borrowed("RebuildPagesCache"),
            Self::RebuildAgendaCache => Cow::Borrowed("RebuildAgendaCache"),
            Self::RebuildProjectedAgendaCache => Cow::Borrowed("RebuildProjectedAgendaCache"),
            Self::RebuildTagInheritanceCache => Cow::Borrowed("RebuildTagInheritanceCache"),
            Self::RebuildPageIds => Cow::Borrowed("RebuildPageIds"),
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
            "RebuildTagsCache" => return Some(Self::RebuildTagsCache),
            "RebuildPagesCache" => return Some(Self::RebuildPagesCache),
            "RebuildAgendaCache" => return Some(Self::RebuildAgendaCache),
            "RebuildProjectedAgendaCache" => return Some(Self::RebuildProjectedAgendaCache),
            "RebuildTagInheritanceCache" => return Some(Self::RebuildTagInheritanceCache),
            "RebuildPageIds" => return Some(Self::RebuildPageIds),
            "RebuildBlockTagRefsCache" => return Some(Self::RebuildBlockTagRefsCache),
            "RebuildPageLinkCache" => return Some(Self::RebuildPageLinkCache),
            _ => {}
        }
        // Composite-key path: PEND-24 H1 apply-op failures encoded as
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
            // Global rebuilds carry no block id; the row's sentinel is
            // discarded on reconstruction.
            Self::RebuildTagsCache => Some(MaterializeTask::RebuildTagsCache),
            Self::RebuildPagesCache => Some(MaterializeTask::RebuildPagesCache),
            Self::RebuildAgendaCache => Some(MaterializeTask::RebuildAgendaCache),
            Self::RebuildProjectedAgendaCache => Some(MaterializeTask::RebuildProjectedAgendaCache),
            Self::RebuildTagInheritanceCache => Some(MaterializeTask::RebuildTagInheritanceCache),
            Self::RebuildPageIds => Some(MaterializeTask::RebuildPageIds),
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
    /// variants (PEND-24 H1), returns the [`APPLY_OP_TASK_SENTINEL`]
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
            MaterializeTask::RebuildTagsCache => {
                Some((Self::RebuildTagsCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
            MaterializeTask::RebuildPagesCache => {
                Some((Self::RebuildPagesCache, GLOBAL_TASK_SENTINEL.to_string()))
            }
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
/// PEND-03: global cache rebuilds (`RebuildTagsCache`, etc.) are
/// recorded with `block_id = '__GLOBAL__'` so the composite PK
/// `(block_id, task_kind)` dedups failures of the same rebuild without
/// requiring a NULL column. Per-block tasks pass through unchanged.
///
/// L-11: Implemented as a single `INSERT ... ON CONFLICT(block_id,
/// task_kind) DO UPDATE` that increments `attempts` SQL-side via
/// `materializer_retry_queue.attempts + 1` (instead of binding the new
/// value from a prior `SELECT`). This eliminates the SELECT-then-INSERT
/// race where two concurrent failure inserts both observe `prior = None`,
/// both compute `attempts = 1`, and both INSERT — the second triggering
/// `ON CONFLICT` and overwriting with the same `excluded.attempts = 1`,
/// silently losing one increment. The backoff schedule depends on
/// `attempts`, so we use `RETURNING attempts` to learn the actual
/// post-update value and (only on the escalation path) issue a
/// follow-up `UPDATE` to set the correct `next_attempt_at`. The
/// common-case first failure stays at one round-trip; the escalation
/// case is two round-trips, matching the previous SELECT+INSERT cost.
pub(crate) async fn record_failure(
    pool: &SqlitePool,
    task: &MaterializeTask,
    last_error: &str,
) -> Result<(), AppError> {
    let Some((kind, block_id)) = RetryKind::from_task(task) else {
        return Ok(());
    };
    let kind_string = kind.task_kind_str();
    let kind_str: &str = kind_string.as_ref();

    // Optimistic next_attempt_at for the INSERT (first-failure) case.
    // The DO UPDATE side reuses this value verbatim; if the SQL-side
    // increment escalates `attempts` past 1 we follow up below to fix
    // it to the correct backoff step.
    let initial_next_attempt = (chrono::Utc::now() + backoff_delay_for(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let attempts_after = sqlx::query_scalar!(
        "INSERT INTO materializer_retry_queue \
             (block_id, task_kind, attempts, last_error, next_attempt_at) \
         VALUES (?, ?, 1, ?, ?) \
         ON CONFLICT(block_id, task_kind) DO UPDATE SET \
             attempts = materializer_retry_queue.attempts + 1, \
             last_error = excluded.last_error, \
             next_attempt_at = ? \
         RETURNING attempts AS \"attempts!: i64\"",
        block_id,
        kind_str,
        last_error,
        initial_next_attempt,
        initial_next_attempt,
    )
    .fetch_one(pool)
    .await?;

    // For the escalation path (attempts > 1) the optimistic
    // `backoff_delay_for(1)` is too short. Recompute against the
    // actual `attempts_after` returned by the UPSERT and patch the row.
    let next_attempt = if attempts_after > 1 {
        let escalated = (chrono::Utc::now() + backoff_delay_for(attempts_after))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query!(
            "UPDATE materializer_retry_queue SET next_attempt_at = ? \
             WHERE block_id = ? AND task_kind = ?",
            escalated,
            block_id,
            kind_str,
        )
        .execute(pool)
        .await?;
        escalated
    } else {
        initial_next_attempt
    };

    tracing::warn!(
        block_id = %block_id,
        task_kind = kind_str,
        attempts = attempts_after,
        next_attempt_at = %next_attempt,
        "persisted failed background task to retry queue"
    );
    Ok(())
}

/// Count of pending retry rows — used for observability (MAINT-24 via
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
/// An unparseable `created_at` is treated as fresh (no age give-up).
/// This matches the conservative bias of the rest of the module: if the
/// row was written by a future schema variant the sweeper doesn't
/// understand, defer to it rather than dropping it.
fn give_up_reason(row: &DueRow) -> Option<&'static str> {
    if row.attempts >= MAX_ATTEMPTS {
        return Some("max_attempts");
    }
    let Ok(created) = chrono::DateTime::parse_from_rfc3339(&row.created_at) else {
        return None;
    };
    let age = chrono::Utc::now().signed_duration_since(created.with_timezone(&chrono::Utc));
    if age >= chrono::Duration::days(GIVE_UP_AGE_DAYS) {
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
    /// RFC 3339 timestamp the row was first persisted — gates the
    /// `GIVE_UP_AGE_DAYS` give-up trigger in [`sweep_once`].
    pub created_at: String,
}

/// Return rows where `next_attempt_at <= now`, up to `limit` entries.
/// Uses the read pool; the sweeper re-enqueues them via the normal
/// background queue path. Cap to avoid flooding the queue.
pub(crate) async fn fetch_due(pool: &SqlitePool, limit: i64) -> Result<Vec<DueRow>, AppError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows = sqlx::query!(
        "SELECT block_id, task_kind, attempts, created_at FROM materializer_retry_queue \
         WHERE next_attempt_at <= ? \
         ORDER BY next_attempt_at ASC LIMIT ?",
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
        })
        .collect())
}

/// Delete a retry row after a successful re-run.
pub(crate) async fn clear_entry(
    pool: &SqlitePool,
    block_id: &str,
    task_kind: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "DELETE FROM materializer_retry_queue WHERE block_id = ? AND task_kind = ?",
        block_id,
        task_kind,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Build a [`MaterializeTask`] from a persisted row. Returns `None` for
/// unknown `task_kind` strings (migration-forward safety) **and** for
/// PEND-24 H1 [`RetryKind::ApplyOp`] rows (which need an additional
/// `OpRecord` lookup against `op_log` — handled inside [`sweep_once`]).
///
/// PEND-03: for global rebuild kinds (`RebuildTagsCache`, etc.), the
/// row's `block_id` (which holds [`GLOBAL_TASK_SENTINEL`]) is passed
/// through to `to_task` and ignored on reconstruction. Per-block kinds
/// use the row's real block id.
pub(crate) fn task_from_row(row: &DueRow) -> Option<MaterializeTask> {
    let kind = RetryKind::from_str(&row.task_kind)?;
    kind.to_task(row.block_id.clone())
}

/// Scan the retry queue once: fetch due rows, re-enqueue each via the
/// materializer's normal background queue, and on successful enqueue
/// delete the row. Failures to enqueue leave the row in place so the next
/// sweep can try again.
///
/// I-Materializer-1: split the pool into `read_pool` (for the `fetch_due`
/// SELECT) and `write_pool` (for the `clear_entry` DELETE) to match the
/// "background tasks use split read/write pools" pattern documented in
/// AGENTS.md. Tests pass the same pool for both arguments.
///
/// Returns the number of rows re-enqueued.
pub async fn sweep_once(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
) -> Result<usize, AppError> {
    const SWEEP_BATCH_LIMIT: i64 = 64;
    let due = fetch_due(read_pool, SWEEP_BATCH_LIMIT).await?;
    let mut re_enqueued = 0usize;
    for row in &due {
        // Issue #157 sub-item D — give-up before any further work.
        // Checked before the ApplyOp special-case below so a permanently
        // failing apply op is also retired by the same triggers.
        if let Some(reason) = give_up_reason(row) {
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
            clear_entry(write_pool, &row.block_id, &row.task_kind).await?;
            continue;
        }

        // PEND-24 H1: ApplyOp rows are dispatched to the foreground
        // queue (matching the original task's routing). They need a
        // separate path because (a) `task_from_row` cannot reconstruct
        // them from the row alone — the `OpRecord` must be re-loaded
        // from `op_log` — and (b) `try_enqueue_background` would route
        // to the wrong consumer.
        if let Some(RetryKind::ApplyOp { device_id, seq }) = RetryKind::from_str(&row.task_kind) {
            match try_reenqueue_apply_op(read_pool, materializer, &device_id, seq).await {
                Ok(()) => {
                    clear_entry(write_pool, &row.block_id, &row.task_kind).await?;
                    re_enqueued += 1;
                }
                Err(e) => {
                    tracing::warn!(
                        block_id = %row.block_id,
                        task_kind = %row.task_kind,
                        error = %e,
                        "failed to re-enqueue PEND-24 H1 ApplyOp row — will try again next sweep"
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
            clear_entry(write_pool, &row.block_id, &row.task_kind).await?;
            continue;
        };
        match materializer.try_enqueue_background(task) {
            Ok(()) => {
                // Re-enqueued. Clear the row — the consumer will re-persist
                // the entry with incremented attempts if it fails again.
                clear_entry(write_pool, &row.block_id, &row.task_kind).await?;
                re_enqueued += 1;
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

/// PEND-24 H1: re-enqueue a previously-persisted [`MaterializeTask::ApplyOp`]
/// failure onto the foreground queue.
///
/// Steps:
///   1. Load the `OpRecord` from `op_log` by `(device_id, seq)`.
///   2. Wrap in `Arc` and submit via [`crate::materializer::Materializer::enqueue_foreground`].
///
/// If the op_log row is missing (e.g. compacted / corrupted), the row
/// is treated as orphaned by the caller (via the unknown-task_kind
/// drop path) — but in practice op_log compaction never deletes rows,
/// so a missing row indicates a deeper corruption that needs operator
/// attention. We surface it as a hard error here so the sweeper logs
/// it at warn level instead of silently dropping the retry row.
async fn try_reenqueue_apply_op(
    read_pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
    device_id: &str,
    seq: i64,
) -> Result<(), AppError> {
    let record = sqlx::query_as!(
        crate::op_log::OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
         FROM op_log WHERE device_id = ? AND seq = ?",
        device_id,
        seq,
    )
    .fetch_optional(read_pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "op_log row missing for ApplyOp retry ({device_id}, {seq})"
        ))
    })?;
    materializer
        .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(record)))
        .await
}

/// Spawn a long-lived task that sweeps the retry queue every 60 seconds
/// and exits when `shutdown_flag` is set.
///
/// I-Materializer-1: takes both pools so `sweep_once` can route SELECTs
/// to the reader pool and DELETEs to the writer pool, mirroring the
/// `cache::*_split` helpers used elsewhere in the materializer.
#[cfg(not(tarpaulin_include))]
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

        // --- Global cache rebuilds (PEND-03): sentinel block_id ---
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
                "global task {:?} must extract as ({:?}, '__GLOBAL__'); got {:?}",
                task,
                expected_kind,
                extracted
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

    /// PEND-24 H1: round-trip a foreground apply-op failure through
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
            created_at: "2025-01-15T12:00:00Z".into(),
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

    /// PEND-24 H1: malformed apply-op `task_kind` strings (extra
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
        record_failure(&pool, &task, "boom").await.unwrap();

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
        record_failure(&pool, &task, "err1").await.unwrap();
        record_failure(&pool, &task, "err2").await.unwrap();
        record_failure(&pool, &task, "err3").await.unwrap();

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

    #[tokio::test]
    async fn record_failure_ignores_non_retryable_tasks() {
        let (pool, _dir) = test_pool().await;
        // RebuildFtsIndex is non-retryable (no in-memory retry path; handled
        // by FTS optimize logic). Distinct from PEND-03 global cache rebuilds
        // which ARE retryable under the GLOBAL_TASK_SENTINEL.
        record_failure(&pool, &MaterializeTask::RebuildFtsIndex, "boom")
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
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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

        clear_entry(&pool, "BLK_FD", "UpdateFtsBlock")
            .await
            .unwrap();
        let n = pending_count(&pool).await.unwrap();
        assert_eq!(n, 0, "cleared entry should vanish from the queue");
    }

    #[tokio::test]
    async fn fetch_due_skips_future_entries() {
        let (pool, _dir) = test_pool().await;
        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        let t = task_from_row(&row).unwrap();
        assert!(
            matches!(t, MaterializeTask::UpdateFtsBlock { ref block_id } if block_id.as_ref() == "BLK_TR")
        );

        let unknown = DueRow {
            block_id: "x".into(),
            task_kind: "SomeFutureTaskKind".into(),
            attempts: 0,
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        assert!(
            task_from_row(&unknown).is_none(),
            "unknown task_kind rows must be silently skipped for migration-forward safety"
        );
    }

    /// L-11 regression: the SQL-side `attempts = materializer_retry_queue.attempts + 1`
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
        let p1 = pool.clone();
        let t1 = task.clone();
        let h1 = tokio::spawn(async move { record_failure(&p1, &t1, "err-A").await });
        let p2 = pool.clone();
        let t2 = task.clone();
        let h2 = tokio::spawn(async move { record_failure(&p2, &t2, "err-B").await });
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
            "L-11: SQL-side increment must accumulate across concurrent record_failure calls; \
             a regression to SELECT-then-INSERT would race and drop one increment (attempts == 1)"
        );
    }

    #[tokio::test]
    async fn record_failure_escalates_next_attempt_at() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_EX".into(),
        };

        record_failure(&pool, &task, "e1").await.unwrap();
        let first = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            "BLK_EX",
            "UpdateFtsBlock",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        record_failure(&pool, &task, "e2").await.unwrap();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_reenqueues_due_rows_and_removes_them() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Insert a due row
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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

        let n = sweep_once(&pool, &pool, &mat).await.unwrap();
        assert_eq!(n, 1, "one due row must be re-enqueued");
        // Clear: after re-enqueue, row is deleted (consumer will re-add on failure).
        let remaining = pending_count(&pool).await.unwrap();
        assert_eq!(
            remaining, 0,
            "swept row must be deleted after successful enqueue"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_skips_future_rows() {
        use crate::materializer::Materializer;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let future = (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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

        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let recent_created =
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let stale_created = (chrono::Utc::now() - chrono::Duration::days(GIVE_UP_AGE_DAYS + 1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sweep_once_below_thresholds_still_reenqueues_157_d() {
        use crate::materializer::Materializer;
        use std::sync::atomic::Ordering;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Both triggers below threshold — the row must follow the normal
        // re-enqueue path, not the give-up path. Pins the boundary.
        let past = (chrono::Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let recent_created = (chrono::Utc::now() - chrono::Duration::days(GIVE_UP_AGE_DAYS - 1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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

    // --- PEND-03: global cache rebuild persistence ---

    /// PEND-03: round-trip a global cache rebuild through `record_failure`
    /// → row → `task_from_row` and assert the reconstructed task matches
    /// the original. Repeats for all 7 global variants so adding a new
    /// `MaterializeTask::Rebuild*Cache` arm forces a corresponding
    /// `RetryKind` arm or the test surfaces the gap.
    #[tokio::test]
    async fn test_global_task_persistence() {
        let cases: [(MaterializeTask, &str); 7] = [
            (MaterializeTask::RebuildTagsCache, "RebuildTagsCache"),
            (MaterializeTask::RebuildPagesCache, "RebuildPagesCache"),
            (MaterializeTask::RebuildAgendaCache, "RebuildAgendaCache"),
            (
                MaterializeTask::RebuildProjectedAgendaCache,
                "RebuildProjectedAgendaCache",
            ),
            (
                MaterializeTask::RebuildTagInheritanceCache,
                "RebuildTagInheritanceCache",
            ),
            (MaterializeTask::RebuildPageIds, "RebuildPageIds"),
            (
                MaterializeTask::RebuildBlockTagRefsCache,
                "RebuildBlockTagRefsCache",
            ),
        ];

        for (task, kind_str) in cases {
            let (pool, _dir) = test_pool().await;
            record_failure(&pool, &task, "boom-global").await.unwrap();

            // Row landed under the GLOBAL_TASK_SENTINEL with the right kind.
            let row = sqlx::query!(
                "SELECT block_id, task_kind, attempts, last_error, created_at \
                 FROM materializer_retry_queue",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                row.block_id, GLOBAL_TASK_SENTINEL,
                "global task {kind_str} must persist under '__GLOBAL__'"
            );
            assert_eq!(row.task_kind, kind_str);
            assert_eq!(row.attempts, 1);
            assert_eq!(row.last_error.as_deref(), Some("boom-global"));

            // Reconstruction via the sweeper path discards the sentinel
            // and yields the original variant.
            let due = DueRow {
                block_id: row.block_id,
                task_kind: row.task_kind,
                attempts: row.attempts,
                created_at: row.created_at,
            };
            let reconstructed = task_from_row(&due).unwrap();
            assert_eq!(
                std::mem::discriminant(&reconstructed),
                std::mem::discriminant(&task),
                "round-trip must produce the same MaterializeTask variant"
            );
        }
    }

    /// PEND-03: a global task failing repeatedly walks the same
    /// 1m → 5m → 30m → 1h backoff schedule as per-block tasks.
    /// We assert via `attempts` increments and timestamp monotonicity;
    /// the exact wall-clock delay is enforced by `backoff_delay_for`
    /// (covered separately in `backoff_schedule_escalates_then_caps`).
    #[tokio::test]
    async fn test_global_task_backoff() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildTagsCache;

        record_failure(&pool, &task, "e1").await.unwrap();
        let first_attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let first_next: String = sqlx::query_scalar!(
            "SELECT next_attempt_at FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        record_failure(&pool, &task, "e2").await.unwrap();
        let second_attempts: i64 = sqlx::query_scalar!(
            "SELECT attempts FROM materializer_retry_queue \
             WHERE block_id = ? AND task_kind = ?",
            GLOBAL_TASK_SENTINEL,
            "RebuildTagsCache",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let second_next: String = sqlx::query_scalar!(
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

    /// PEND-03: two failures of the same global task coalesce into a
    /// single row via the composite PK `(block_id, task_kind)` —
    /// `'__GLOBAL__' + 'RebuildTagsCache'` uniquely identifies the
    /// entry, so the second `record_failure` UPSERTs rather than
    /// inserting a duplicate.
    #[tokio::test]
    async fn test_global_task_dedup() {
        let (pool, _dir) = test_pool().await;
        let task = MaterializeTask::RebuildAgendaCache;

        record_failure(&pool, &task, "e1").await.unwrap();
        record_failure(&pool, &task, "e2").await.unwrap();
        record_failure(&pool, &task, "e3").await.unwrap();

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

    /// PEND-03: a per-block `UpdateFtsBlock` failure and a global
    /// `RebuildTagsCache` failure must not collide on the PK — they
    /// land in two distinct rows because `block_id` differs (real ULID
    /// vs. `'__GLOBAL__'`).
    #[tokio::test]
    async fn test_global_and_per_block_tasks_coexist() {
        let (pool, _dir) = test_pool().await;
        let block_task = MaterializeTask::UpdateFtsBlock {
            block_id: "BLK_PB".into(),
        };
        record_failure(&pool, &block_task, "blk-err").await.unwrap();
        record_failure(&pool, &MaterializeTask::RebuildTagsCache, "global-err")
            .await
            .unwrap();

        let n = pending_count(&pool).await.unwrap();
        assert_eq!(
            n, 2,
            "global and per-block failures must occupy distinct PK slots"
        );
    }

    /// PEND-03: schema snapshot — pin the post-migration shape of
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
        // STRICT modifier landed in PEND-03 (migration 0044).
        assert!(
            sql.contains("STRICT"),
            "materializer_retry_queue must be a STRICT table; sql={sql}"
        );
        // task_kind replaced task_type in PEND-03. Check the column
        // declaration shape directly (avoids matching the inline migration
        // comment that still mentions the old column name historically).
        assert!(
            sql.contains("task_kind"),
            "schema must use task_kind (PEND-03 rename); sql={sql}"
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
            "live column declarations must not reference task_type after PEND-03; sql={sql}"
        );
        // Composite PK shape must remain (block_id, task_kind).
        assert!(
            sql.contains("PRIMARY KEY (block_id, task_kind)"),
            "PK must be (block_id, task_kind); sql={sql}"
        );
    }

    /// SQL-review M-4 (migration 0063): the single-column
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
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let limit: i64 = 64;
        let plan_rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(
            "EXPLAIN QUERY PLAN \
             SELECT block_id, task_kind FROM materializer_retry_queue \
             WHERE next_attempt_at <= ? \
             ORDER BY next_attempt_at ASC LIMIT ?",
        )
        .bind(&now)
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
