use sqlx::SqlitePool;

use super::{ActiveBlockRow, Cursor, PageRequest, PageResponse, build_page_response};
use crate::error::AppError;

/// List blocks for a specific date from the agenda cache, paginated.
///
/// Ordered by `block_id ASC` (ULID ≈ chronological).
///
/// Driven by the `agenda_cache` primary key `(date, block_id)`: the leading
/// `date` column serves the equality lookup and the trailing `block_id`
/// serves the keyset order. (#349: the old `idx_agenda_date(date)` index
/// was dropped in migration 0045 as redundant with this PK's leading
/// column — do not cite it.)
///
/// `date` must be in `YYYY-MM-DD` format.
///
/// `space_id` — when `Some`, restricts the result set to blocks
/// whose owning page (`b.page_id`) carries `space = ?space_id`.
/// `None` keeps the pre- behaviour (no filter). See
/// [`crate::space_filter_canonical::SPACE_FILTER_CANONICAL`] for the shared
/// SQL fragment definition.
pub async fn list_agenda(
    pool: &SqlitePool,
    date: &str,
    source: Option<&str>,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // ?6 (space_id) drives the shared space-filter clause.
    // The literal mirrors `crate::space_filter_canonical::SPACE_FILTER_CANONICAL` — kept inline here
    // because `sqlx::query_as!` requires a string literal and does not
    // accept `concat!()`. Mirror any change to the filter SQL across
    // every inlined copy.
    let rows = sqlx::query_as!(
        ActiveBlockRow,
        r#"SELECT b.id as "id: crate::ulid::ActiveBlockId", b.block_type, b.content, b.parent_id as "parent_id: crate::ulid::BlockId", b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id as "page_id: crate::ulid::BlockId"
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date = ?1 AND b.deleted_at IS NULL
           AND (?2 IS NULL OR ac.source = ?2)
           AND (?3 IS NULL OR b.id > ?4)
           AND (?6 IS NULL OR b.space_id = ?6)
         ORDER BY b.id ASC
         LIMIT ?5"#,
        date,        // ?1
        source,      // ?2
        cursor_flag, // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
        space_id,    // ?6
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.as_str().to_string())
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
    space_id: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    // For the range query we use a composite cursor: (date, block_id).
    // We stash the cursor date in `deleted_at` and block_id in `id`.
    let (cursor_flag, cursor_date, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => (Some(1), c.deleted_at.as_deref().unwrap_or(""), &c.id),
        None => (None, "", ""),
    };

    // Use a raw `query!` (rather than `query_as!(ActiveBlockRow, …)`) so we
    // can also project `ac.date` — which is what `ORDER BY` keys on — and
    // use it directly to populate the cursor instead of guessing from
    // `b.due_date` / `b.scheduled_date`.
    //
    // ?8 (space_id) drives the shared space-filter clause.
    // Mirrors `crate::space_filter_canonical::SPACE_FILTER_CANONICAL` — kept inline because
    // `sqlx::query!` requires a string literal directly.
    let raw_rows = sqlx::query!(
        r#"SELECT b.id as "id!: crate::ulid::BlockId", b.block_type, b.content, b.parent_id as "parent_id: crate::ulid::BlockId", b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id as "page_id: crate::ulid::BlockId", ac.date as "ac_date: String"
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date >= ?1 AND ac.date <= ?2
           AND b.deleted_at IS NULL
           AND (?3 IS NULL OR ac.source = ?3)
           AND (?4 IS NULL OR (ac.date > ?5 OR (ac.date = ?5 AND b.id > ?6)))
           AND (?8 IS NULL OR b.space_id = ?8)
         ORDER BY ac.date ASC, b.id ASC
         LIMIT ?7"#,
        start_date,  // ?1
        end_date,    // ?2
        source,      // ?3
        cursor_flag, // ?4
        cursor_date, // ?5
        cursor_id,   // ?6
        fetch_limit, // ?7
        space_id,    // ?8
    )
    .fetch_all(pool)
    .await?;

    // Carry the agenda_cache `date` *on each row* (a local pairing struct)
    // rather than in a parallel index-aligned Vec. This keeps the cursor
    // key co-located with its row, so `build_page_response`'s own
    // truncation governs both the row set and the cursor source — there is
    // no second collection to keep in lockstep. The boundary cast
    // `ActiveBlockRow::from_block_row_unchecked` is safe here because the
    // SQL filter pins `b.deleted_at IS NULL`.
    let rows: Vec<AgendaRangeRow> = raw_rows
        .into_iter()
        .map(|r| AgendaRangeRow {
            ac_date: r.ac_date,
            block: ActiveBlockRow::from_block_row_unchecked(super::BlockRow {
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
            }),
        })
        .collect();

    // Build the page over the paired rows so the next-cursor is derived
    // from the last *kept* row's own `ac_date` — `build_page_response`
    // applies the page-size truncation, and the closure reads the cursor
    // date straight off that row.
    let paged = build_page_response(rows, page.limit, |last| {
        Cursor::for_id_and_deleted_at(
            last.block.id.as_str().to_string(),
            Some(last.ac_date.clone()),
        )
    })?;

    // Unwrap the pairing struct back to the public `ActiveBlockRow` shape,
    // preserving `next_cursor` / `has_more` / `total_count` verbatim.
    Ok(PageResponse {
        items: paged.items.into_iter().map(|r| r.block).collect(),
        next_cursor: paged.next_cursor,
        has_more: paged.has_more,
        total_count: paged.total_count,
    })
}

/// Pairs an [`ActiveBlockRow`] with the `agenda_cache.date` that ordered it,
/// so the keyset cursor for [`list_agenda_range`] reads its date straight off
/// the row instead of from a parallel index-aligned Vec (#1662).
///
/// Internal-only: it is unwrapped back to `ActiveBlockRow` before
/// [`list_agenda_range`] returns, so it never reaches the wire. It derives
/// `Serialize` / `specta::Type` purely to satisfy the `build_page_response`
/// bound while it flows through the shared helper.
#[derive(serde::Serialize, specta::Type)]
struct AgendaRangeRow {
    block: ActiveBlockRow,
    ac_date: String,
}
