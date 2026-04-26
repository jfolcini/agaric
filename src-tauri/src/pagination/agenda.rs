use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List blocks for a specific date from the agenda cache, paginated.
///
/// Ordered by `block_id ASC` (ULID ≈ chronological).
/// Uses index `idx_agenda_date(date)`.
///
/// `date` must be in `YYYY-MM-DD` format.
pub async fn list_agenda(
    pool: &SqlitePool,
    date: &str,
    source: Option<&str>,
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
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?2 IS NULL OR ac.source = ?2)
           AND (?3 IS NULL OR b.id > ?4)
         ORDER BY b.id ASC
         LIMIT ?5"#,
        date,        // ?1
        source,      // ?2
        cursor_flag, // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
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

/// List blocks for a date *range* from the agenda cache, paginated.
///
/// When `start_date` and `end_date` are provided, returns blocks whose
/// `agenda_cache.date` falls `BETWEEN start_date AND end_date` (inclusive).
/// Ordered by `(ac.date ASC, b.id ASC)` so results stream chronologically.
/// The cursor carries both `date` (encoded in `deleted_at` field for reuse)
/// and `block_id` for keyset pagination.
pub async fn list_agenda_range(
    pool: &SqlitePool,
    start_date: &str,
    end_date: &str,
    source: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    // For the range query we use a composite cursor: (date, block_id).
    // We stash the cursor date in `deleted_at` and block_id in `id`.
    let (cursor_flag, cursor_date, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => (Some(1), c.deleted_at.as_deref().unwrap_or(""), &c.id),
        None => (None, "", ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date >= ?1 AND ac.date <= ?2
           AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?3 IS NULL OR ac.source = ?3)
           AND (?4 IS NULL OR (ac.date > ?5 OR (ac.date = ?5 AND b.id > ?6)))
         ORDER BY ac.date ASC, b.id ASC
         LIMIT ?7"#,
        start_date,  // ?1
        end_date,    // ?2
        source,      // ?3
        cursor_flag, // ?4
        cursor_date, // ?5
        cursor_id,   // ?6
        fetch_limit, // ?7
    )
    .fetch_all(pool)
    .await?;

    // We need the date from agenda_cache for the cursor. Since BlockRow doesn't
    // carry it, we re-derive it: for due_date source use due_date, for
    // scheduled_date source use scheduled_date, otherwise pick whichever is set.
    // This is a best-effort approach; the cursor just needs to be consistent.
    fn extract_date_for_cursor(b: &BlockRow, source: Option<&str>) -> String {
        match source {
            Some(s) if s.contains("due_date") => b.due_date.clone().unwrap_or_default(),
            Some(s) if s.contains("scheduled_date") => b.scheduled_date.clone().unwrap_or_default(),
            _ => b
                .due_date
                .clone()
                .or_else(|| b.scheduled_date.clone())
                .unwrap_or_default(),
        }
    }

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: Some(extract_date_for_cursor(last, source)),
        seq: None,
        rank: None,
    })
}
