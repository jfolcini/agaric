use sqlx::SqlitePool;

use super::{build_page_response, ActiveBlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List backlinks — blocks that link *to* `target_id`, paginated.
///
/// Ordered by `bl.source_id ASC` (≡ `b.id`, ULID ≈ chronological).
/// Uses covering index `idx_block_links_target_source(target_id, source_id)`,
/// so the order is index-supplied and no temp B-tree is built (audit #415).
///
/// `space_id` (FEAT-3p4) — when `Some`, restricts the result set to
/// source blocks whose owning page (`b.page_id`)
/// carries `space = ?space_id`. `None` keeps the pre-FEAT-3 behaviour
/// (no filter). See [`crate::space_filter_clause`] for the shared SQL
/// fragment definition.
///
/// MAINT-113 M2 — returns `ActiveBlockRow` because the SQL filters
/// `b.deleted_at IS NULL` on the source block.
pub async fn list_backlinks(
    pool: &SqlitePool,
    target_id: &str,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
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
    //
    // MAINT-113 M2 — `id as "id: crate::ulid::ActiveBlockId"` is the
    // sqlx column-cast hint for the typed-id slot on ActiveBlockRow;
    // sqlx::Type for ActiveBlockId is `transparent` over String so the
    // decode is a free wrap.
    let rows = sqlx::query_as!(
        ActiveBlockRow,
        r#"SELECT b.id as "id: crate::ulid::ActiveBlockId", b.block_type, b.content, b.parent_id as "parent_id: crate::ulid::BlockId", b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id as "page_id: crate::ulid::BlockId"
         FROM block_links bl
         JOIN blocks b ON b.id = bl.source_id
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL
           AND (?2 IS NULL OR bl.source_id > ?3)
           AND (?5 IS NULL OR b.page_id IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?5))
         ORDER BY bl.source_id ASC
         LIMIT ?4"#,
        target_id,   // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
        space_id,    // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.as_str().to_string())
    })
}
