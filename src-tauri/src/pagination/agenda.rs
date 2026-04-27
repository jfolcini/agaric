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
///
/// **H-8 fix:** the cursor must encode `ac.date` (the actual sort key used
/// by the SQL `ORDER BY` / `WHERE`), not `b.due_date` / `b.scheduled_date`.
/// When an `agenda_cache` row's source is e.g. a custom property, the
/// `ac.date` is unrelated to either column on `blocks`, so deriving the
/// cursor date from `BlockRow` would drift and cause page boundaries to
/// skip or duplicate entries. We therefore fetch `ac.date` alongside the
/// block columns and stash it verbatim in `Cursor::deleted_at`.
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

    // Use a raw `query!` (rather than `query_as!(BlockRow, …)`) so we can
    // also project `ac.date` — which is what `ORDER BY` keys on — and use
    // it directly to populate the cursor instead of guessing from
    // `b.due_date` / `b.scheduled_date`.
    let raw_rows = sqlx::query!(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id, ac.date as "ac_date: String"
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

    // Split each raw row into (BlockRow, ac_date) so we can carry the
    // agenda_cache date through to the cursor. The two vectors stay
    // index-aligned by construction.
    let mut rows: Vec<BlockRow> = Vec::with_capacity(raw_rows.len());
    let mut ac_dates: Vec<String> = Vec::with_capacity(raw_rows.len());
    for r in raw_rows {
        ac_dates.push(r.ac_date);
        rows.push(BlockRow {
            id: r.id,
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
            position: r.position,
            deleted_at: r.deleted_at,
            is_conflict: r.is_conflict,
            conflict_type: r.conflict_type,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
        });
    }

    // Pre-trim `ac_dates` to the page size so its `.last()` aligns with
    // whatever row `build_page_response` will treat as the last kept row.
    // `build_page_response` truncates `rows` itself when it exceeds `limit`.
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    if ac_dates.len() > limit_usize {
        ac_dates.truncate(limit_usize);
    }
    let last_ac_date = ac_dates.last().cloned();

    build_page_response(rows, page.limit, move |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: last_ac_date,
        seq: None,
        rank: None,
    })
}
