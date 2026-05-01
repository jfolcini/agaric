use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List backlinks — blocks that link *to* `target_id`, paginated.
///
/// Ordered by `b.id ASC` (ULID ≈ chronological).
/// Uses index `idx_block_links_target(target_id)`.
///
/// `space_id` (FEAT-3p4) — when `Some`, restricts the result set to
/// source blocks whose owning page (`COALESCE(b.page_id, b.id)`)
/// carries `space = ?space_id`. `None` keeps the pre-FEAT-3 behaviour
/// (no filter). See [`crate::space_filter_clause`] for the shared SQL
/// fragment definition.
pub async fn list_backlinks(
    pool: &SqlitePool,
    target_id: &str,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // FEAT-3p4 — ?5 (space_id) drives the shared space-filter clause.
    // The literal mirrors `crate::space_filter_clause!` — kept inline
    // here because `sqlx::query_as!` requires a string literal and does
    // not accept `concat!()`. Mirror any change to the filter SQL
    // across every inlined copy.
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM block_links bl
         JOIN blocks b ON b.id = bl.source_id
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?2 IS NULL OR b.id > ?3)
           AND (?5 IS NULL OR COALESCE(b.page_id, b.id) IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?5))
         ORDER BY b.id ASC
         LIMIT ?4"#,
        target_id,   // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
        space_id,    // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
