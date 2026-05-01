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
/// # Value filter (L-23)
///
/// At most one of `value_text` / `value_date` may be supplied. Passing
/// both simultaneously is rejected with [`AppError::Validation`] at the
/// boundary because the two query branches would otherwise apply
/// different precedence rules:
///
/// - **Reserved-column path:** routed to a single column, so the SQL
///   could only bind one of the two values; historically `value_date`
///   silently won for date-typed columns and `value_text` for the
///   others, dropping the other input without warning.
/// - **Non-reserved path:** SQL ANDs both `bp.value_text {op} ?` and
///   `bp.value_date {op} ?`, intersecting the filters — which almost
///   always returns an empty set because a `block_properties` row
///   stores its value in exactly one of the two columns.
///
/// Two precedence rules in one function depending on the routing
/// branch is a downstream-bug shape; rejecting the conflict at the
/// boundary keeps the contract uniform.
pub async fn query_by_property(
    pool: &SqlitePool,
    key: &str,
    value_text: Option<&str>,
    value_date: Option<&str>,
    operator: &str,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // L-23: reject conflicting value filters at the boundary so both
    // routing branches behave identically wrt the value-filter contract.
    if value_text.is_some() && value_date.is_some() {
        return Err(AppError::Validation(
            "query_by_property: at most one of value_text / value_date may be supplied".to_string(),
        ));
    }

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

    // FEAT-3p4 — both branches gain the `(?N IS NULL OR
    // COALESCE(b.page_id, b.id) IN (...))` space-filter clause. The
    // literal mirrors `crate::space_filter_clause!` — kept inline
    // because both branches are dynamic SQL (the `{sql_op}`
    // interpolation precludes the `query_as!` macro). The `b.` alias is
    // introduced on the reserved-column branch so the same clause shape
    // applies to both queries.
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
            "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                    b.deleted_at, b.is_conflict, b.conflict_type, \
                    b.todo_state, b.priority, b.due_date, b.scheduled_date, \
                    b.page_id \
             FROM blocks b \
             WHERE b.{col} IS NOT NULL \
               AND b.deleted_at IS NULL \
               AND b.is_conflict = 0 \
               AND (?1 IS NULL OR b.{col} {sql_op} ?1) \
               AND (?2 IS NULL OR b.id > ?3) \
               AND (?5 IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                    SELECT bp.block_id FROM block_properties bp \
                    WHERE bp.key = 'space' AND bp.value_ref = ?5)) \
             ORDER BY b.id ASC \
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
            .bind(space_id)
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
               AND (?7 IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                    SELECT bp_sp.block_id FROM block_properties bp_sp \
                    WHERE bp_sp.key = 'space' AND bp_sp.value_ref = ?7)) \
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
            .bind(space_id) // ?7
            .fetch_all(pool)
            .await?
    };

    build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}
