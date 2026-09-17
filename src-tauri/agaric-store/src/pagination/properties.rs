use sqlx::SqlitePool;

use super::{BlockRow, Cursor, PageRequest, PageResponse, build_page_response};
use crate::op::is_reserved_property_key;
use agaric_core::error::AppError;

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
/// # Routing — reserved vs. non-reserved keys
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
/// Adding a fifth reserved column (e.g., `effort`) means updating that helper
/// and `reserved_column` in lockstep.
///
/// # Value filter
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
/// # Multi-value filters
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
/// # Block-type filter
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
/// pass. If the API is ever extended to admit numeric/ref/bool filters, both
/// SQL branches must grow the corresponding columns.
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
    exclude_todo_states: &[String],
) -> Result<PageResponse<BlockRow>, AppError> {
    validate_value_filters(value_text, value_date, value_text_in)?;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };
    let (value_date_from, value_date_to) = match value_date_range {
        Some((from, to)) => (Some(from), Some(to)),
        None => (None, None),
    };

    let filters = PropertyFilters {
        value_text,
        value_date,
        sql_op: sql_operator(operator),
        fetch_limit: page.limit + 1,
        cursor_flag,
        cursor_id,
        space_id,
        exclude_parent_id,
        content_filter_flag: i64::from(content_non_empty),
        block_type,
        value_text_in_json: json_array(value_text_in)?,
        value_date_from,
        value_date_to,
        exclude_todo_states_json: json_array(exclude_todo_states)?,
    };

    let rows = if is_reserved_property_key(key) {
        fetch_reserved_column_rows(pool, reserved_column(key)?, &filters).await?
    } else {
        fetch_property_row_rows(pool, key, &filters).await?
    };

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
}

/// Every value the two SQL branches bind, prepared once.
///
/// The branches differ in which columns they bind against, and so in their
/// `?N` numbering — twelve slots on the reserved-column path, fourteen on the
/// property-row path. They do not differ in what the values are, so a new
/// filter is prepared in one place and spent in two.
struct PropertyFilters<'a> {
    value_text: Option<&'a str>,
    value_date: Option<&'a str>,
    sql_op: &'static str,
    /// `page.limit + 1` — the probe row `build_page_response` trims back off.
    fetch_limit: i64,
    cursor_flag: Option<i64>,
    cursor_id: &'a str,
    /// The space clause mirrors
    /// [`crate::space_filter_canonical::SPACE_FILTER_CANONICAL`], spelled
    /// inline because both branches interpolate `sql_op` and so cannot use the
    /// `query_as!` macro.
    space_id: Option<&'a str>,
    /// Bound through `IS NOT` rather than `!=`, so blocks with a NULL parent
    /// survive the filter (the shape `pagination::list_children` uses).
    exclude_parent_id: Option<&'a str>,
    /// Bound as `0`/`1` so the disabled filter short-circuits inside one
    /// statement instead of forking the text. `TRIM(content, x'20090a0d')`
    /// names space, tab, LF and CR explicitly because SQLite's bare `TRIM`
    /// strips only spaces, and the FE predicate it replaces was `!content.trim()`.
    content_filter_flag: i64,
    block_type: Option<&'a str>,
    /// A JSON array for `json_each(?N)` — one string parameter rather than
    /// splatting the vec into `N` placeholders.
    value_text_in_json: Option<String>,
    /// Half-open `[from, to)`: a row whose date equals `to` is excluded,
    /// matching FE date-pickers whose upper bound is exclusive. Two binds so
    /// each side short-circuits on its own `?N IS NULL`.
    value_date_from: Option<&'a str>,
    value_date_to: Option<&'a str>,
    /// #738 sub-2 — drops rows whose `todo_state` matches, so completed tasks
    /// stop occupying the bounded fetch window and starving overdue TODOs.
    /// `b.todo_state IS NULL OR` keeps blocks that carry a date but no state.
    exclude_todo_states_json: Option<String>,
}

/// At most one value filter may be supplied. Both conflicts are rejected here
/// rather than given a precedence in SQL, because the two branches would then
/// have to agree on that precedence — see the routing docs on
/// [`query_by_property`] for what they each used to do instead.
fn validate_value_filters(
    value_text: Option<&str>,
    value_date: Option<&str>,
    value_text_in: &[String],
) -> Result<(), AppError> {
    if value_text.is_some() && value_date.is_some() {
        return Err(AppError::validation(
            "query_by_property: at most one of value_text / value_date may be supplied".to_string(),
        ));
    }
    if !value_text_in.is_empty() && value_text.is_some() {
        return Err(AppError::validation(
            "query_by_property: value_text_in and value_text are mutually exclusive".to_string(),
        ));
    }
    Ok(())
}

/// The safe string tag to its SQL operator. A closed match, so the caller's
/// string never reaches the statement text — the same discipline
/// [`reserved_column`] applies to the column name.
fn sql_operator(operator: &str) -> &'static str {
    match operator {
        "neq" => "!=",
        "lt" => "<",
        "gt" => ">",
        "lte" => "<=",
        "gte" => ">=",
        _ => "=",
    }
}

/// `None` when empty, so the clause short-circuits on `?N IS NULL` instead of
/// parsing an empty array per row.
pub(super) fn json_array(values: &[String]) -> Result<Option<String>, AppError> {
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(values)?))
}

/// The `blocks` column a reserved key lives in.
///
/// `is_reserved_property_key` decides *that* a key is reserved; this decides
/// *where*. They must move together, so the fall-through returns `Validation`
/// rather than panicking: a missed update surfaces as a clean IPC error.
fn reserved_column(key: &str) -> Result<&'static str, AppError> {
    match key {
        "todo_state" => Ok("todo_state"),
        "priority" => Ok("priority"),
        "due_date" => Ok("due_date"),
        "scheduled_date" => Ok("scheduled_date"),
        _ => Err(AppError::validation(format!(
            "query_by_property: reserved key '{key}' has no column routing — \
             update `is_reserved_property_key` and the match arm in lockstep"
        ))),
    }
}

/// Reserved keys are columns on `blocks`, so there is no join and no `key`
/// bind: the column name carries what `?1` carries on the other path. Twelve
/// slots, and the `?N` order here is independent of the property-row path's.
async fn fetch_reserved_column_rows(
    pool: &SqlitePool,
    col: &'static str,
    filters: &PropertyFilters<'_>,
) -> Result<Vec<BlockRow>, AppError> {
    let sql = format!(
        "SELECT {cols} \
         FROM blocks b \
         WHERE b.{col} IS NOT NULL \
           AND b.deleted_at IS NULL \
           AND (?1 IS NULL OR b.{col} {sql_op} ?1) \
           AND (?2 IS NULL OR b.id > ?3) \
           AND (?5 IS NULL OR b.space_id = ?5) \
           AND (?6 IS NULL OR b.parent_id IS NOT ?6) \
           AND (?7 = 0 OR (b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != '')) \
           AND (?8 IS NULL OR b.block_type = ?8) \
           AND (?9 IS NULL OR b.{col} IN (SELECT value FROM json_each(?9))) \
           AND (?10 IS NULL OR b.{col} >= ?10) \
           AND (?11 IS NULL OR b.{col} < ?11) \
           AND (?12 IS NULL OR b.todo_state IS NULL OR b.todo_state NOT IN (SELECT value FROM json_each(?12))) \
         ORDER BY b.id ASC \
         LIMIT ?4",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
        sql_op = filters.sql_op,
    );
    // One column holds the value, so the caller's two inputs collapse into one
    // bind. No per-column precedence: the boundary has already rejected the
    // case where both are `Some`, which is the only case a precedence could
    // decide.
    let filter_value: Option<&str> = filters.value_text.or(filters.value_date);
    let rows = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(filter_value) // ?1
        .bind(filters.cursor_flag) // ?2
        .bind(filters.cursor_id) // ?3
        .bind(filters.fetch_limit) // ?4
        .bind(filters.space_id) // ?5
        .bind(filters.exclude_parent_id) // ?6
        .bind(filters.content_filter_flag) // ?7
        .bind(filters.block_type) // ?8
        .bind(filters.value_text_in_json.as_deref()) // ?9
        .bind(filters.value_date_from) // ?10
        .bind(filters.value_date_to) // ?11
        .bind(filters.exclude_todo_states_json.as_deref()) // ?12
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Non-reserved keys are rows in `block_properties`, so the key is `?1` and
/// the value predicates address `bp.*`. Fourteen slots, numbered independently
/// of the reserved path's twelve.
async fn fetch_property_row_rows(
    pool: &SqlitePool,
    key: &str,
    filters: &PropertyFilters<'_>,
) -> Result<Vec<BlockRow>, AppError> {
    let (text_pred, date_pred) = value_predicates(filters.sql_op);
    let sql = format!(
        "SELECT {cols} \
         FROM block_properties bp \
         JOIN blocks b ON b.id = bp.block_id \
         WHERE bp.key = ?1 \
           AND b.deleted_at IS NULL \
           AND {text_pred} \
           AND {date_pred} \
           AND (?4 IS NULL OR b.id > ?5) \
           AND (?7 IS NULL OR b.space_id = ?7) \
           AND (?8 IS NULL OR b.parent_id IS NOT ?8) \
           AND (?9 = 0 OR (b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != '')) \
           AND (?10 IS NULL OR b.block_type = ?10) \
           AND (?11 IS NULL OR bp.value_text IN (SELECT value FROM json_each(?11))) \
           AND (?12 IS NULL OR bp.value_date >= ?12) \
           AND (?13 IS NULL OR bp.value_date < ?13) \
           AND (?14 IS NULL OR b.todo_state IS NULL OR b.todo_state NOT IN (SELECT value FROM json_each(?14))) \
         ORDER BY b.id ASC \
         LIMIT ?6",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
    );
    let rows = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(key) // ?1
        .bind(filters.value_text) // ?2
        .bind(filters.value_date) // ?3
        .bind(filters.cursor_flag) // ?4
        .bind(filters.cursor_id) // ?5
        .bind(filters.fetch_limit) // ?6
        .bind(filters.space_id) // ?7
        .bind(filters.exclude_parent_id) // ?8
        .bind(filters.content_filter_flag) // ?9
        .bind(filters.block_type) // ?10
        .bind(filters.value_text_in_json.as_deref()) // ?11
        .bind(filters.value_date_from) // ?12
        .bind(filters.value_date_to) // ?13
        .bind(filters.exclude_todo_states_json.as_deref()) // ?14
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// The `?2` / `?3` value predicates, special-cased for `!=` (#384).
///
/// A `block_properties` row stores its value in exactly one of `value_text` /
/// `value_date`, leaving the sibling NULL. For `!=`, `NULL != 'X'` is NULL and
/// not TRUE, so the bare predicate would drop every row whose value lives in
/// the other column; `col IS NULL OR` restores them. The other operators keep
/// the bare shape, where a NULL column correctly fails the comparison. Only
/// the queried column's predicate is ever active — the boundary guarantees at
/// most one of `?2` / `?3` is non-NULL.
fn value_predicates(sql_op: &str) -> (String, String) {
    if sql_op == "!=" {
        return (
            "(?2 IS NULL OR bp.value_text IS NULL OR bp.value_text != ?2)".to_string(),
            "(?3 IS NULL OR bp.value_date IS NULL OR bp.value_date != ?3)".to_string(),
        );
    }
    (
        format!("(?2 IS NULL OR bp.value_text {sql_op} ?2)"),
        format!("(?3 IS NULL OR bp.value_date {sql_op} ?3)"),
    )
}
