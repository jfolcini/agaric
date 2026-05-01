//! Cursor-paginated query for undated tasks.

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;
use sqlx::SqlitePool;

/// List blocks that have a `todo_state` but no `due_date` and no `scheduled_date`.
///
/// When `space_id` is `Some`, only blocks whose owning page
/// (`COALESCE(b.page_id, b.id)`) carries `space = ?space_id` are returned.
/// `None` keeps the pre-FEAT-3 behaviour (no filter). See
/// [`crate::space_filter_clause`] for the shared SQL fragment definition.
pub async fn list_undated_tasks(
    pool: &SqlitePool,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;
    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // FEAT-3p4 — ?4 (space_id) drives the shared space-filter clause.
    // The literal mirrors `crate::space_filter_clause!` — kept inline here
    // because `sqlx::query_as!` requires a string literal and does not
    // accept `concat!()`. Mirror any change to the filter SQL across
    // every inlined copy.
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM blocks b
         WHERE b.todo_state IS NOT NULL
           AND b.due_date IS NULL
           AND b.scheduled_date IS NULL
           AND b.deleted_at IS NULL
           AND b.is_conflict = 0
           AND (?1 IS NULL OR b.id > ?2)
           AND (?4 IS NULL OR COALESCE(b.page_id, b.id) IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?4))
         ORDER BY b.id ASC
         LIMIT ?3"#,
        cursor_flag, // ?1
        cursor_id,   // ?2
        fetch_limit, // ?3
        space_id,    // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
