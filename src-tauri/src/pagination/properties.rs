use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;
use crate::op::is_reserved_property_key;

/// Query blocks by property key and optional value, with cursor pagination.
///
/// Returns blocks that have a row in `block_properties` matching the given
/// `key`.  When `value_text` is `Some`, only rows whose `value_text` matches
/// the supplied value (using the given `operator`) are included.  Excludes
/// soft-deleted and conflict blocks, consistent with other listing queries.
///
/// `operator` is one of: `"eq"`, `"neq"`, `"lt"`, `"gt"`, `"lte"`, `"gte"`.
/// It defaults to `"eq"` for any unrecognised value.
///
/// Ordered by `b.id ASC` (ULID ≈ chronological).
///
/// # Routing — reserved vs. non-reserved keys (L-29)
///
/// The function has two distinct query paths and the routing decision is
/// made by [`crate::op::is_reserved_property_key`]:
///
/// - **Reserved keys** are stored as columns directly on the `blocks` table
///   (not in `block_properties`). The reserved set is exactly four keys —
///   `todo_state`, `priority`, `due_date`, `scheduled_date` — backed by the
///   matching columns. The first branch below routes the query against
///   those columns.
/// - **Non-reserved keys** are stored as rows in `block_properties` with
///   `(block_id, key)` uniqueness. The second branch joins
///   `block_properties` to `blocks`.
///
/// **Source of truth** for the reserved-key set: `op::is_reserved_property_key`.
/// If a fifth reserved column is ever added (e.g., `effort`), that helper
/// must be updated AND the `match col { … }` arm below must gain the new
/// case. The fall-through arm now returns `AppError::Validation` instead of
/// panicking via `unreachable!()` so a missed update surfaces as a clean
/// runtime error rather than crashing the IPC.
///
/// # Value precedence (related: L-23)
///
/// On the reserved-column path, `value_date` takes precedence over
/// `value_text` for date-typed columns (`due_date`, `scheduled_date`),
/// otherwise `value_text` takes precedence. On the non-reserved path,
/// both `value_text` and `value_date` are bound and the SQL evaluates
/// both filters with the same operator — silent precedence emerges from
/// the underlying row's typed value. See L-23 for the unresolved
/// non-reserved precedence concern.
pub async fn query_by_property(
    pool: &SqlitePool,
    key: &str,
    value_text: Option<&str>,
    value_date: Option<&str>,
    operator: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // Convert from safe string tag to SQL operator via match — prevents injection.
    let sql_op = match operator {
        "neq" => "!=",
        "lt" => "<",
        "gt" => ">",
        "lte" => "<=",
        "gte" => ">=",
        _ => "=", // default to equality
    };

    let rows = if is_reserved_property_key(key) {
        // Reserved keys live as columns on the blocks table, not in block_properties.
        // L-29: explicit Validation on a missed-update fall-through instead of
        // `unreachable!()` so a future reserved-key addition without the matching
        // column-routing update surfaces as a clean runtime error rather than a panic.
        let col = match key {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            "scheduled_date" => "scheduled_date",
            _ => {
                return Err(AppError::Validation(format!(
                    "query_by_property: reserved key '{key}' has no column routing — \
                     update `is_reserved_property_key` and the match arm in lockstep"
                )));
            }
        };
        let sql = format!(
            "SELECT id, block_type, content, parent_id, position, \
                    deleted_at, is_conflict, conflict_type, \
                    todo_state, priority, due_date, scheduled_date, \
                    page_id \
             FROM blocks \
             WHERE {col} IS NOT NULL \
               AND deleted_at IS NULL \
               AND is_conflict = 0 \
               AND (?1 IS NULL OR {col} {sql_op} ?1) \
               AND (?2 IS NULL OR id > ?3) \
             ORDER BY id ASC \
             LIMIT ?4"
        );
        // For date columns, use value_date; for text columns, use value_text.
        let filter_value: Option<&str> = match col {
            "due_date" | "scheduled_date" => value_date.or(value_text),
            _ => value_text.or(value_date),
        };
        sqlx::query_as::<_, BlockRow>(&sql)
            .bind(filter_value)
            .bind(cursor_flag)
            .bind(cursor_id)
            .bind(fetch_limit)
            .fetch_all(pool)
            .await?
    } else {
        // Dynamic SQL needed because sqlx::query_as! macro cannot interpolate operators.
        let sql = format!(
            "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                    b.deleted_at, b.is_conflict, b.conflict_type, \
                    b.todo_state, b.priority, b.due_date, b.scheduled_date, \
                    b.page_id \
             FROM block_properties bp \
             JOIN blocks b ON b.id = bp.block_id \
             WHERE bp.key = ?1 \
               AND b.deleted_at IS NULL \
               AND b.is_conflict = 0 \
               AND (?2 IS NULL OR bp.value_text {sql_op} ?2) \
               AND (?3 IS NULL OR bp.value_date {sql_op} ?3) \
               AND (?4 IS NULL OR b.id > ?5) \
             ORDER BY b.id ASC \
             LIMIT ?6"
        );
        sqlx::query_as::<_, BlockRow>(&sql)
            .bind(key) // ?1
            .bind(value_text) // ?2
            .bind(value_date) // ?3
            .bind(cursor_flag) // ?4
            .bind(cursor_id) // ?5
            .bind(fetch_limit) // ?6
            .fetch_all(pool)
            .await?
    };

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
