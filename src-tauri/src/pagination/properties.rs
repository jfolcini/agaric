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
///
/// # Multi-value filters (PEND-35 Tier 3.4)
///
/// `value_text_in` is an alternative to `value_text` for set-membership
/// checks: when non-empty, rows are filtered by `value IN (...)` against
/// the `block_properties.value_text` column (non-reserved path) or the
/// matching reserved column (reserved-key path, e.g. `b.todo_state IN
/// (...)`). The values are bound as a JSON array via `json_each(?N)` so
/// SQLite parses a single string parameter rather than splatting the
/// vec into `N` placeholders. When empty, behaviour is identical to the
/// pre-Tier-3.4 path.
///
/// `value_text_in` and `value_text` are mutually exclusive — supplying
/// both is rejected with [`AppError::Validation`]. Precedence: when
/// `value_text_in` is non-empty, it wins; `value_text` must be `None`.
///
/// `value_date_range` filters on `[from, to)` (half-open: rows with
/// `value_date == to` are excluded). The shape mirrors typical FE
/// date-range pickers where the "to" represents an exclusive upper
/// bound (e.g. "due before 2026-02-01" excludes rows on Feb 1). On the
/// reserved-key path, the range is applied to the matching column
/// (e.g. `b.due_date`); for `due_date` / `scheduled_date`, prefer
/// `value_date_range` over `value_text_in`.
///
/// # Block-type filter (PEND-35 Tier 3.4)
///
/// `block_type` is a simple equality push-down on `b.block_type` — when
/// `Some`, only rows whose block matches are returned. `None` is the
/// unfiltered (pre-Tier-3.4) behaviour.
///
/// # Value-filter type coverage (#349, C9)
///
/// The scalar value filter only consults the **text** (`value_text`) and
/// **date** (`value_date`) columns — never `value_num`, `value_ref`, or
/// `value_bool`. This is intentional and not a gap: the public command API
/// only exposes `value_text` / `value_date` inputs to callers, so a query
/// targeting a number/ref/bool property simply has no value predicate to
/// pass. If the API is ever extended to admit numeric/ref/bool filters,
/// the `filter_value` routing here (and the reserved/non-reserved SQL
/// branches) must grow the corresponding columns.
#[allow(clippy::too_many_arguments)]
pub async fn query_by_property(
    pool: &SqlitePool,
    key: &str,
    value_text: Option<&str>,
    value_date: Option<&str>,
    operator: &str,
    page: &PageRequest,
    space_id: Option<&str>,
    exclude_parent_id: Option<&str>,
    content_non_empty: bool,
    block_type: Option<&str>,
    value_text_in: &[String],
    value_date_range: Option<(&str, &str)>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // L-23: reject conflicting value filters at the boundary so both
    // routing branches behave identically wrt the value-filter contract.
    if value_text.is_some() && value_date.is_some() {
        return Err(AppError::Validation(
            "query_by_property: at most one of value_text / value_date may be supplied".to_string(),
        ));
    }

    // PEND-35 Tier 3.4 — `value_text_in` is an alternative to
    // `value_text`. Allowing both would require choosing precedence in
    // SQL; rejecting at the boundary keeps the contract single-shape.
    if !value_text_in.is_empty() && value_text.is_some() {
        return Err(AppError::Validation(
            "query_by_property: value_text_in and value_text are mutually exclusive".to_string(),
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

    // PEND-35 Tier 1.5 — `content_non_empty` is bound as `0/1` so the
    // `(?N = 0 OR …)` short-circuit produces the same plan as the
    // pre-PEND-35 path when the filter is disabled.
    let content_filter_flag: i64 = i64::from(content_non_empty);

    // PEND-35 Tier 3.4 — `value_text_in` is bound as a JSON array via
    // `json_each(?N)` so the unfiltered path passes a NULL and the
    // `(?N IS NULL OR …)` short-circuit produces the same plan as
    // pre-Tier-3.4. The non-empty path serialises once per call.
    let value_text_in_json: Option<String> = if value_text_in.is_empty() {
        None
    } else {
        Some(serde_json::to_string(value_text_in)?)
    };

    // PEND-35 Tier 3.4 — `value_date_range` is split into two binds so
    // each side participates in the `(?N IS NULL OR …)` short-circuit.
    // Half-open `[from, to)` semantics: a row whose date equals `to`
    // is EXCLUDED — matches typical FE date-pickers where the upper
    // bound is exclusive.
    let (value_date_from, value_date_to): (Option<&str>, Option<&str>) = match value_date_range {
        Some((from, to)) => (Some(from), Some(to)),
        None => (None, None),
    };

    // FEAT-3p4 — both branches gain the `(?N IS NULL OR
    // b.page_id IN (...))` space-filter clause. The
    // literal mirrors `crate::space_filter_canonical::SPACE_FILTER_CANONICAL` — kept inline
    // because both branches are dynamic SQL (the `{sql_op}`
    // interpolation precludes the `query_as!` macro). The `b.` alias is
    // introduced on the reserved-column branch so the same clause shape
    // applies to both queries.
    //
    // PEND-35 Tier 1.5 — both branches additionally gain
    // `(?N IS NULL OR b.parent_id IS NOT ?N)` and
    // `(?N = 0 OR (b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != ''))`.
    // The `IS NOT` form on `parent_id` keeps NULL parents in the
    // result set regardless of the filter (matches the `IS ?N` shape
    // used by `pagination::list_children`). The content filter is
    // encoded as a `0/1` int bind so the unfiltered path (`flag = 0`)
    // produces the same plan as pre-PEND-35. `TRIM(content, x'20090a0d')`
    // strips space (0x20), tab (0x09), LF (0x0a), and CR (0x0d) so a
    // whitespace-only block is treated identically to NULL / `''` —
    // matching the legacy FE predicate `!b.content?.trim()`. SQLite's
    // bare `TRIM()` only strips spaces, so the explicit char set is
    // required to cover the FE-equivalent set.
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
        // PEND-35 Tier 3.4 — three new clauses on the reserved-key path:
        //   ?8  block_type equality push-down
        //   ?9  value_text_in (JSON array; bound against `b.{col}`
        //       because `bp.value_text` does not exist on this path)
        //   ?10/?11  value_date_range half-open `[from, to)`
        //       (applied against `b.{col}` so a query on `due_date`
        //       binds the range to the date column directly)
        // MAINT-229: shared with BLOCK_ROW_RUNTIME_SELECT — alias variant for value/null routing
        let sql = format!(
            "SELECT {cols} \
             FROM blocks b \
             WHERE b.{col} IS NOT NULL \
               AND b.deleted_at IS NULL \
               AND (?1 IS NULL OR b.{col} {sql_op} ?1) \
               AND (?2 IS NULL OR b.id > ?3) \
               AND (?5 IS NULL OR b.page_id IN ( \
                    SELECT bp.block_id FROM block_properties bp \
                    WHERE bp.key = 'space' AND bp.value_ref = ?5)) \
               AND (?6 IS NULL OR b.parent_id IS NOT ?6) \
               AND (?7 = 0 OR (b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != '')) \
               AND (?8 IS NULL OR b.block_type = ?8) \
               AND (?9 IS NULL OR b.{col} IN (SELECT value FROM json_each(?9))) \
               AND (?10 IS NULL OR b.{col} >= ?10) \
               AND (?11 IS NULL OR b.{col} < ?11) \
             ORDER BY b.id ASC \
             LIMIT ?4",
            cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
            col = col,
            sql_op = sql_op,
        );
        // For date columns, use value_date; for text columns, use value_text.
        let filter_value: Option<&str> = match col {
            "due_date" | "scheduled_date" => value_date.or(value_text),
            _ => value_text.or(value_date),
        };
        sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(filter_value) // ?1
            .bind(cursor_flag) // ?2
            .bind(cursor_id) // ?3
            .bind(fetch_limit) // ?4
            .bind(space_id) // ?5
            .bind(exclude_parent_id) // ?6
            .bind(content_filter_flag) // ?7
            .bind(block_type) // ?8
            .bind(value_text_in_json.as_deref()) // ?9
            .bind(value_date_from) // ?10
            .bind(value_date_to) // ?11
            .fetch_all(pool)
            .await?
    } else {
        // Dynamic SQL needed because sqlx::query_as! macro cannot interpolate operators.
        // PEND-35 Tier 3.4 — three new clauses on the non-reserved path:
        //   ?10  block_type equality push-down on `b.block_type`
        //   ?11  value_text_in (JSON array) bound against `bp.value_text`
        //   ?12/?13  value_date_range half-open `[from, to)` against `bp.value_date`
        // MAINT-229: shared with BLOCK_ROW_RUNTIME_SELECT — alias variant for value/null routing
        // #384: `neq` must not silently drop rows whose value lives in the
        // OTHER value column. A `block_properties` row stores its value in
        // exactly one of value_text / value_date, leaving the other NULL.
        // For `!=`, `NULL != 'X'` evaluates to NULL (not TRUE), so the bare
        // `(?N IS NULL OR bp.col != ?N)` predicate would exclude a row whose
        // queried value is in the sibling column. Adding `bp.col IS NULL OR`
        // restores those rows for the neq case. The L-23 boundary guarantees
        // at most one of ?2/?3 is non-NULL, so only the queried column's
        // predicate is ever active; the inactive one short-circuits via
        // `?N IS NULL`. eq/lt/gt/lte/gte keep the original `(?N IS NULL OR
        // col {op} ?N)` shape — for those operators a NULL column correctly
        // fails the predicate (a NULL value should not equal/order-compare
        // equal to a non-NULL target).
        let (text_pred, date_pred): (String, String) = if sql_op == "!=" {
            (
                "(?2 IS NULL OR bp.value_text IS NULL OR bp.value_text != ?2)".to_string(),
                "(?3 IS NULL OR bp.value_date IS NULL OR bp.value_date != ?3)".to_string(),
            )
        } else {
            (
                format!("(?2 IS NULL OR bp.value_text {sql_op} ?2)"),
                format!("(?3 IS NULL OR bp.value_date {sql_op} ?3)"),
            )
        };
        let sql = format!(
            "SELECT {cols} \
             FROM block_properties bp \
             JOIN blocks b ON b.id = bp.block_id \
             WHERE bp.key = ?1 \
               AND b.deleted_at IS NULL \
               AND {text_pred} \
               AND {date_pred} \
               AND (?4 IS NULL OR b.id > ?5) \
               AND (?7 IS NULL OR b.page_id IN ( \
                    SELECT bp_sp.block_id FROM block_properties bp_sp \
                    WHERE bp_sp.key = 'space' AND bp_sp.value_ref = ?7)) \
               AND (?8 IS NULL OR b.parent_id IS NOT ?8) \
               AND (?9 = 0 OR (b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != '')) \
               AND (?10 IS NULL OR b.block_type = ?10) \
               AND (?11 IS NULL OR bp.value_text IN (SELECT value FROM json_each(?11))) \
               AND (?12 IS NULL OR bp.value_date >= ?12) \
               AND (?13 IS NULL OR bp.value_date < ?13) \
             ORDER BY b.id ASC \
             LIMIT ?6",
            cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
        );
        sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(key) // ?1
            .bind(value_text) // ?2
            .bind(value_date) // ?3
            .bind(cursor_flag) // ?4
            .bind(cursor_id) // ?5
            .bind(fetch_limit) // ?6
            .bind(space_id) // ?7
            .bind(exclude_parent_id) // ?8
            .bind(content_filter_flag) // ?9
            .bind(block_type) // ?10
            .bind(value_text_in_json.as_deref()) // ?11
            .bind(value_date_from) // ?12
            .bind(value_date_to) // ?13
            .fetch_all(pool)
            .await?
    };

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
}
