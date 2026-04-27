//! Helpers for computing block sibling positions in the `blocks` table.
//!
//! Centralises the "next sibling position, excluding the
//! [`NULL_POSITION_SENTINEL`]" lookup that merge-conflict copies and
//! recurrence siblings both need (BUG-24). Keeping it here avoids
//! drift between `merge::resolve::create_conflict_copy` and
//! `recurrence::compute::handle_recurrence`.

use sqlx::{Executor, Sqlite};

use crate::error::AppError;
use crate::pagination::NULL_POSITION_SENTINEL;

/// Compute the next available sibling position under `parent_id`,
/// excluding rows that already carry [`NULL_POSITION_SENTINEL`].
///
/// Returns `MAX(position) + 1` among living, non-sentinel siblings, or
/// `1` when there are no such siblings (`MAX` returns NULL, treated as
/// `0`). Callers are responsible for handling the sentinel case
/// up-front (originals positioned at the sentinel keep the sentinel;
/// originals with `position = None` adopt the sentinel) — this helper
/// is only called when the original block sits at a real, non-sentinel
/// position.
///
/// `parent_id` is `Option<&str>` so that top-level blocks (NULL parent)
/// match correctly under `parent_id IS ?`.
///
/// BUG-24: sentinel-bearing siblings (e.g. NULL-position tag children
/// stored under the same parent) are excluded from the `MAX` scan to
/// prevent `i64::MAX + 1` overflow.
pub(crate) async fn next_sibling_position_excluding_sentinel<'e, E>(
    executor: E,
    parent_id: Option<&str>,
) -> Result<i64, AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    let max_pos: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(position) FROM blocks \
         WHERE parent_id IS ? AND deleted_at IS NULL AND position != ?",
    )
    .bind(parent_id)
    .bind(NULL_POSITION_SENTINEL)
    .fetch_one(executor)
    .await?;
    Ok(max_pos.unwrap_or(0) + 1)
}
