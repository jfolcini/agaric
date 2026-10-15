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
///   matching columns, which the statement reads directly.
/// - **Non-reserved keys** are stored as rows in `block_properties` with
///   `(block_id, key)` uniqueness, which the statement joins to `blocks`.
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
    space_id: &str,
    exclude_parent_id: Option<&str>,
    content_non_empty: bool,
    block_type: Option<&str>,
    value_text_in: &[String],
    value_date_range: Option<(&str, &str)>,
    exclude_todo_states: &[String],
) -> Result<PageResponse<BlockRow>, AppError> {
    validate_value_filters(value_text, value_date, value_text_in)?;

    let filters = PropertyFilters {
        value_text,
        value_date,
        sql_op: sql_operator(operator),
        after_id: page.after.as_ref().map(|c| c.id.as_str()),
        space_id,
        exclude_parent_id,
        content_non_empty,
        block_type,
        value_text_in_json: json_array(value_text_in)?,
        value_date_range,
        exclude_todo_states_json: json_array(exclude_todo_states)?,
    };
    let (sql, binds) = query_by_property_sql(key, &filters)?;
    let mut query = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()));
    for value in binds {
        query = query.bind(value);
    }
    let rows = query.bind(page.limit + 1).fetch_all(pool).await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
}

/// Every filter [`query_by_property`] was given, prepared once.
struct PropertyFilters<'a> {
    value_text: Option<&'a str>,
    value_date: Option<&'a str>,
    sql_op: &'static str,
    /// The previous page's last id; `None` on the first page.
    after_id: Option<&'a str>,
    space_id: &'a str,
    /// Matched through `IS NOT` rather than `!=`, so blocks with a NULL parent
    /// survive the filter (the shape `pagination::list_children` uses).
    exclude_parent_id: Option<&'a str>,
    /// `TRIM(content, x'20090a0d')` names space, tab, LF and CR explicitly
    /// because SQLite's bare `TRIM` strips only spaces, and the FE predicate it
    /// replaces was `!content.trim()`.
    content_non_empty: bool,
    block_type: Option<&'a str>,
    /// A JSON array for `json_each(?)` — one string parameter rather than
    /// splatting the vec into `N` placeholders.
    value_text_in_json: Option<String>,
    /// Half-open `[from, to)`: a row whose date equals `to` is excluded,
    /// matching FE date-pickers whose upper bound is exclusive.
    value_date_range: Option<(&'a str, &'a str)>,
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

/// `None` when empty, so the clause is left out (or short-circuits on
/// `?N IS NULL`) instead of parsing an empty array per row.
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

/// The statement [`query_by_property`] runs for one call shape, with its binds
/// in placeholder order; the caller binds the fetch limit last.
///
/// A filter the caller left out adds no SQL (#5426). Only the selective shapes
/// let a value index drive the plan: equality and `value_text_in` on either
/// path, and a range on `due_date` / `scheduled_date`. On the property path
/// every other shape orders by `bp.block_id`, so the plan walks
/// `idx_block_props_key` (key, block_id) in id order and stops at the LIMIT
/// instead of sorting every row the key holds.
fn query_by_property_sql<'a>(
    key: &'a str,
    filters: &'a PropertyFilters<'a>,
) -> Result<(String, Vec<&'a str>), AppError> {
    let cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS;
    let mut binds: Vec<&'a str> = Vec::new();
    let reserved = is_reserved_property_key(key);
    // A reserved key's value lives in its one column, so both value inputs
    // address it; a property row keeps text and dates in separate columns.
    let (mut sql, text_col, date_col) = if reserved {
        let col = reserved_column(key)?;
        (
            format!("SELECT {cols} FROM blocks b WHERE b.{col} IS NOT NULL"),
            format!("b.{col}"),
            format!("b.{col}"),
        )
    } else {
        binds.push(key);
        (
            format!(
                "SELECT {cols} FROM block_properties bp \
                 JOIN blocks b ON b.id = bp.block_id WHERE bp.key = ?"
            ),
            "bp.value_text".to_owned(),
            "bp.value_date".to_owned(),
        )
    };
    let range_may_drive = matches!(key, "due_date" | "scheduled_date");
    push_value_predicates(
        &mut sql,
        &mut binds,
        filters,
        &text_col,
        &date_col,
        range_may_drive,
    );
    push_block_filters(&mut sql, &mut binds, filters);
    let selective = filters.value_text_in_json.is_some()
        || (filters.sql_op == "="
            && (filters.value_text.is_some() || filters.value_date.is_some()));
    let walk = if reserved || selective {
        "b.id"
    } else {
        "bp.block_id"
    };
    sql.push_str(&format!(" ORDER BY {walk} ASC LIMIT ?"));
    Ok((sql, binds))
}

/// The value predicates of [`query_by_property_sql`]. Unless
/// `range_may_drive`, a range is written on `+col` so its index cannot drive
/// the plan: `idx_block_props_date` has no `key` column, and a broad range read
/// every key's dates and sorted them before the LIMIT. The `+` changes no
/// result: both tables are STRICT, so the columns and the binds are all TEXT.
fn push_value_predicates<'a>(
    sql: &mut String,
    binds: &mut Vec<&'a str>,
    filters: &'a PropertyFilters<'a>,
    text_col: &str,
    date_col: &str,
    range_may_drive: bool,
) {
    let range_operand = |col: &str| {
        if range_may_drive {
            col.to_owned()
        } else {
            format!("+{col}")
        }
    };
    let (text_range, date_range) = (range_operand(text_col), range_operand(date_col));
    if let Some(value) = filters.value_text {
        sql.push_str(&value_predicate(text_col, &text_range, filters.sql_op));
        binds.push(value);
    }
    if let Some(value) = filters.value_date {
        sql.push_str(&value_predicate(date_col, &date_range, filters.sql_op));
        binds.push(value);
    }
    if let Some(values) = filters.value_text_in_json.as_deref() {
        sql.push_str(&format!(
            " AND {text_col} IN (SELECT value FROM json_each(?))"
        ));
        binds.push(values);
    }
    if let Some((from, to)) = filters.value_date_range {
        sql.push_str(&format!(" AND {date_range} >= ? AND {date_range} < ?"));
        binds.extend([from, to]);
    }
}

/// The filters on `b` itself. The unary `+` keeps `idx_blocks_space_type` and
/// `idx_blocks_type` out of the plan: without `sqlite_stat1` the planner rates
/// them above the key and value indexes, then reads and sorts every block in
/// the space.
fn push_block_filters<'a>(
    sql: &mut String,
    binds: &mut Vec<&'a str>,
    filters: &'a PropertyFilters<'a>,
) {
    sql.push_str(" AND b.deleted_at IS NULL AND +b.space_id = ?");
    binds.push(filters.space_id);
    if let Some(id) = filters.after_id {
        sql.push_str(" AND b.id > ?");
        binds.push(id);
    }
    if let Some(parent_id) = filters.exclude_parent_id {
        sql.push_str(" AND b.parent_id IS NOT ?");
        binds.push(parent_id);
    }
    if filters.content_non_empty {
        sql.push_str(" AND b.content IS NOT NULL AND TRIM(b.content, x'20090a0d') != ''");
    }
    if let Some(block_type) = filters.block_type {
        sql.push_str(" AND +b.block_type = ?");
        binds.push(block_type);
    }
    if let Some(states) = filters.exclude_todo_states_json.as_deref() {
        sql.push_str(
            " AND (b.todo_state IS NULL OR b.todo_state NOT IN (SELECT value FROM json_each(?)))",
        );
        binds.push(states);
    }
}

/// `col = ?`, `range_col {sql_op} ?` for the ordering operators, and `!=`
/// special-cased (#384).
///
/// A `block_properties` row stores its value in exactly one of `value_text` /
/// `value_date`, leaving the sibling NULL. For `!=`, `NULL != 'X'` is NULL and
/// not TRUE, so the bare predicate would drop every row whose value lives in
/// the other column; `col IS NULL OR` restores them. A reserved column is
/// never NULL here, so the escape changes nothing on that path. The other
/// operators keep the bare shape, where a NULL column correctly fails the
/// comparison.
fn value_predicate(col: &str, range_col: &str, sql_op: &str) -> String {
    match sql_op {
        "=" => format!(" AND {col} = ?"),
        "!=" => format!(" AND ({col} IS NULL OR {col} != ?)"),
        _ => format!(" AND {range_col} {sql_op} ?"),
    }
}

#[cfg(test)]
#[path = "properties_tests.rs"]
mod tests;
