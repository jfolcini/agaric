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
/// When `space_id` is `Some`, the result set is restricted to blocks whose
/// owning page (resolved via `COALESCE(page_id, id)`) carries a `space`
/// property pointing at `space_id`. `None` is the unscoped (pre-FEAT-3)
/// behaviour — every existing callsite that hasn't migrated yet passes
/// `None` and sees identical results. See [`crate::space_filter_clause`]
/// for the shared SQL fragment definition.
///
/// Uses index `idx_blocks_parent_covering(parent_id, deleted_at, position, id)`.
pub async fn list_children(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
        None => (None, 0, ""),
    };

    // FEAT-3 Phase 2 — ?6 (space_id) drives the shared space-filter
    // clause. The literal is mirrored (modulo ?N) by
    // `crate::space_filter_clause!` — kept inline here because
    // `sqlx::query_as!` requires a string literal directly and does not
    // accept `concat!()`. Any change to the filter SQL must touch every
    // inlined copy (list_children, list_by_type, list_trash,
    // fts::search_fts).
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks b
         WHERE parent_id IS ?1 AND deleted_at IS NULL AND is_conflict = 0
           AND (?2 IS NULL OR (
                position > ?3
                OR (position = ?3 AND id > ?4)))
           AND (?6 IS NULL OR COALESCE(b.page_id, b.id) IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?6))
         ORDER BY position ASC, id ASC
         LIMIT ?5"#,
        parent_id,   // ?1
        cursor_flag, // ?2
        cursor_pos,  // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
        space_id,    // ?6
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id_and_position(
            last.id.clone(),
            last.position.unwrap_or(NULL_POSITION_SENTINEL),
        )
    })
}

/// List blocks by `block_type`, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
///
/// When `space_id` is `Some`, only blocks whose owning page
/// (`COALESCE(page_id, id)`) carries `space = ?space_id` are returned.
/// `None` keeps the pre-FEAT-3 behaviour (no filter). See
/// [`crate::space_filter_clause`] for the shared SQL fragment definition.
///
/// Uses index `idx_blocks_type(block_type, deleted_at)`.
pub async fn list_by_type(
    pool: &SqlitePool,
    block_type: &str,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // FEAT-3 Phase 2 — ?5 (space_id) drives the space filter. See the
    // header note on `list_children` for why the clause is inlined
    // rather than composed via `crate::space_filter_clause!`.
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks b
         WHERE block_type = ?1 AND deleted_at IS NULL AND is_conflict = 0
           AND (?2 IS NULL OR id > ?3)
           AND (?5 IS NULL OR COALESCE(b.page_id, b.id) IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?5))
         ORDER BY id ASC
         LIMIT ?4"#,
        block_type,  // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
        space_id,    // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
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
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
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

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
