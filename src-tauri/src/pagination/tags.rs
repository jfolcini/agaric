use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List blocks that carry a specific tag, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).  Excludes soft-deleted and
/// conflict blocks, consistent with `eval_tag_query`.
/// Uses index `idx_block_tags_tag(tag_id)`.
pub async fn list_by_tag(
    pool: &SqlitePool,
    tag_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM block_tags bt
         JOIN blocks b ON b.id = bt.block_id
         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?2 IS NULL OR b.id > ?3)
         ORDER BY b.id ASC
         LIMIT ?4"#,
        tag_id,      // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
