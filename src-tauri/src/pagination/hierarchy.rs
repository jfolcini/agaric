use sqlx::SqlitePool;

use super::{
    build_page_response, BlockRow, Cursor, PageRequest, PageResponse, NULL_POSITION_SENTINEL,
};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Paginated queries
// ---------------------------------------------------------------------------
//
// Each query uses the `(?N IS NULL OR <keyset-condition>)` pattern so that a
// single SQL statement handles both the first-page (no cursor) and subsequent
// (with cursor) cases.  When `cursor_flag` is NULL the keyset condition
// short-circuits; when it is 1 the condition is evaluated normally.
// This eliminates the duplicated if/else branches that the original code had.

/// List children of `parent_id` (or top-level blocks when `None`), paginated.
///
/// Ordered by `(position ASC, id ASC)`.  Blocks that formerly had `NULL`
/// position (e.g. tag children) now store `NULL_POSITION_SENTINEL` and sort
/// *after* all positioned blocks.
///
/// Uses index `idx_blocks_parent_covering(parent_id, deleted_at, position, id)`.
pub async fn list_children(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
        None => (None, 0, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE parent_id IS ?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR (
                position > ?3
                OR (position = ?3 AND id > ?4)))
         ORDER BY position ASC, id ASC
         LIMIT ?5"#,
        parent_id,   // ?1
        cursor_flag, // ?2
        cursor_pos,  // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List blocks by `block_type`, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Uses index `idx_blocks_type(block_type, deleted_at)`.
pub async fn list_by_type(
    pool: &SqlitePool,
    block_type: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE block_type = ?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR id > ?3)
         ORDER BY id ASC
         LIMIT ?4"#,
        block_type,  // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List conflict blocks, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Returns only non-deleted blocks with `is_conflict = 1`.
pub async fn list_conflicts(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE is_conflict = 1 AND deleted_at IS NULL
           AND (?1 IS NULL OR id > ?2)
         ORDER BY id ASC
         LIMIT ?3"#,
        cursor_flag, // ?1
        cursor_id,   // ?2
        fetch_limit, // ?3
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}
