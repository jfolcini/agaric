use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List soft-deleted blocks (trash view), paginated.
///
/// Ordered by `(deleted_at DESC, id ASC)` — most recently deleted first.
/// Excludes conflict blocks (`is_conflict = 0`).
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_del, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => {
            let del = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::Validation("cursor missing deleted_at for trash query".into())
            })?;
            (Some(1), del, &c.id)
        }
        None => (None, "", ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks
         WHERE deleted_at IS NOT NULL AND is_conflict = 0
           AND (?1 IS NULL OR (
                deleted_at < ?2 OR (deleted_at = ?2 AND id > ?3)))
         ORDER BY deleted_at DESC, id ASC
         LIMIT ?4"#,
        cursor_flag, // ?1
        cursor_del,  // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: last.deleted_at.clone(),
        seq: None,
        rank: None,
    })
}
