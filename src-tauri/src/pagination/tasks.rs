use sqlx::SqlitePool;

use super::{BlockRow, Cursor, PageRequest, PageResponse, build_page_response};
use crate::error::AppError;

/// List unfinished tasks before a certain date.
///
/// Returns blocks where `todo_state IN ('TODO', 'DOING')` and
/// `(due_date < before_date OR scheduled_date < before_date)`.
/// Ordered by `COALESCE(due_date, scheduled_date) DESC, id DESC`.
///
/// # Admission column vs sort key mismatch (#349, C9)
///
/// The **admission** predicate (`due_date < ?1 OR scheduled_date < ?1`)
/// and the **sort key** (`COALESCE(due_date, scheduled_date)`) are not the
/// same expression — this is deliberate but worth calling out. A task with
/// both columns set is admitted if *either* falls before `before_date`,
/// yet it sorts (and keysets) on `due_date` alone (COALESCE prefers the
/// non-NULL `due_date`). So a task whose `scheduled_date < before_date`
/// but whose `due_date >= before_date` is admitted *and* ordered by its
/// future `due_date`. The keyset cursor stays consistent because it
/// captures the same `COALESCE(...)` value (bound as `?4`) that the
/// `ORDER BY` uses, so pagination never drifts even though the admission
/// gate is broader than the sort key.
pub async fn list_unfinished_tasks(
    pool: &SqlitePool,
    before_date: &str,
    todo_states: &[String],
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_date, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => (Some(1), c.deleted_at.as_deref().unwrap_or(""), &c.id),
        None => (None, "", ""),
    };

    let states_json = serde_json::to_string(todo_states)?;

    let raw_rows = sqlx::query!(
        r#"SELECT b.id as "id!: crate::ulid::BlockId", b.block_type, b.content, b.parent_id as "parent_id: crate::ulid::BlockId", b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id as "page_id: crate::ulid::BlockId", COALESCE(b.due_date, b.scheduled_date) as "sort_date: String"
         FROM blocks b
         WHERE b.deleted_at IS NULL
           AND (b.due_date < ?1 OR b.scheduled_date < ?1)
           AND b.todo_state IN (SELECT value FROM json_each(?2))
           AND (?3 IS NULL OR (COALESCE(b.due_date, b.scheduled_date) < ?4 OR (COALESCE(b.due_date, b.scheduled_date) = ?4 AND b.id < ?5)))
           AND (?7 IS NULL OR b.space_id = ?7)
         ORDER BY COALESCE(b.due_date, b.scheduled_date) DESC, b.id DESC
         LIMIT ?6"#,
        before_date, // ?1
        states_json, // ?2
        cursor_flag, // ?3
        cursor_date, // ?4
        cursor_id,   // ?5
        fetch_limit, // ?6
        space_id,    // ?7
    )
    .fetch_all(pool)
    .await?;

    let mut rows: Vec<BlockRow> = Vec::with_capacity(raw_rows.len());
    let mut sort_dates: Vec<String> = Vec::with_capacity(raw_rows.len());
    for r in raw_rows {
        sort_dates.push(r.sort_date.unwrap_or_default());
        rows.push(BlockRow {
            id: r.id,
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
            position: r.position,
            deleted_at: r.deleted_at,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
        });
    }

    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    if sort_dates.len() > limit_usize {
        sort_dates.truncate(limit_usize);
    }
    let last_sort_date = sort_dates.last().cloned();

    build_page_response(rows, page.limit, move |last| {
        Cursor::for_id_and_deleted_at(last.id.clone().into_string(), last_sort_date)
    })
}
