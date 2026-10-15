//! #5426: `query_by_property` runs one static statement per call shape. The
//! `?N IS NULL OR` statements it replaced stay here as the oracle: both must
//! return the same pages for every value predicate, operator, reserved key and
//! filter, and each value predicate must narrow its index.

use super::*;
use crate::test_support::{TEST_SPACE_ID, ensure_test_space, insert_block, test_pool};

// ---------------------------------------------------------------------------
// Oracle: the statements before #5426, unchanged but for their names
// ---------------------------------------------------------------------------

struct OracleFilters<'a> {
    value_text: Option<&'a str>,
    value_date: Option<&'a str>,
    sql_op: &'static str,
    fetch_limit: i64,
    cursor_flag: Option<i64>,
    cursor_id: &'a str,
    space_id: Option<&'a str>,
    exclude_parent_id: Option<&'a str>,
    content_filter_flag: i64,
    block_type: Option<&'a str>,
    value_text_in_json: Option<String>,
    value_date_from: Option<&'a str>,
    value_date_to: Option<&'a str>,
    exclude_todo_states_json: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn query_by_property_oracle(
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

    let filters = OracleFilters {
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
        fetch_reserved_column_rows_oracle(pool, reserved_column(key)?, &filters).await?
    } else {
        fetch_property_row_rows_oracle(pool, key, &filters).await?
    };

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
}

async fn fetch_reserved_column_rows_oracle(
    pool: &SqlitePool,
    col: &'static str,
    filters: &OracleFilters<'_>,
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

async fn fetch_property_row_rows_oracle(
    pool: &SqlitePool,
    key: &str,
    filters: &OracleFilters<'_>,
) -> Result<Vec<BlockRow>, AppError> {
    let (text_pred, date_pred) = value_predicates_oracle(filters.sql_op);
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

fn value_predicates_oracle(sql_op: &str) -> (String, String) {
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

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const PAGE: &str = "QBP_PAGE";
const PAGE_TWO: &str = "QBP_PAGE2";
const DELETED_BLOCK: &str = "QBP_C22";
const OTHER_SPACE: &str = "QBP_SPACE_B";
const OTHER_SPACE_BLOCK: &str = "QBP_OTHER";

/// Small enough that most shapes span several pages, so the cursor is exercised.
const PAGE_LIMIT: i64 = 3;
const MAX_PAGES: usize = 30;

const TEXT_PROP: &str = "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)";
const DATE_PROP: &str = "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)";

async fn exec(pool: &SqlitePool, sql: &'static str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(pool).await.unwrap();
}

/// Content blocks `QBP_C00..=QBP_C23` under two pages, each carrying a
/// rule-derived mix of text / number / date properties and reserved columns;
/// some have whitespace-only content. `QBP_C22` is deleted and `QBP_OTHER`
/// lives in another space; both match many shapes and must never be returned.
async fn seed_corpus(pool: &SqlitePool) {
    insert_block(pool, PAGE, "page", "page", None, None).await;
    insert_block(pool, PAGE_TWO, "page", "page two", None, None).await;
    exec(pool, TEXT_PROP, &[PAGE, "status", "open"]).await;
    exec(pool, DATE_PROP, &[PAGE, "deadline", "2025-01-05"]).await;
    exec(
        pool,
        "UPDATE blocks SET due_date = '2025-02-03', priority = '1' WHERE id = ?",
        &[PAGE],
    )
    .await;

    for i in 0..24_u32 {
        seed_content_block(pool, i).await;
    }
    exec(
        pool,
        "UPDATE blocks SET deleted_at = 1 WHERE id = ?",
        &[DELETED_BLOCK],
    )
    .await;

    insert_block(pool, OTHER_SPACE_BLOCK, "content", "other", None, None).await;
    exec(pool, TEXT_PROP, &[OTHER_SPACE_BLOCK, "status", "open"]).await;
    exec(
        pool,
        DATE_PROP,
        &[OTHER_SPACE_BLOCK, "deadline", "2025-01-04"],
    )
    .await;
    exec(
        pool,
        "UPDATE blocks SET todo_state = 'TODO', due_date = '2025-02-03' WHERE id = ?",
        &[OTHER_SPACE_BLOCK],
    )
    .await;

    ensure_test_space(pool).await;
    exec(pool, "UPDATE blocks SET space_id = ?", &[TEST_SPACE_ID]).await;
    insert_block(pool, OTHER_SPACE, "page", "space b", None, None).await;
    exec(pool, "INSERT INTO spaces (id) VALUES (?)", &[OTHER_SPACE]).await;
    exec(
        pool,
        "UPDATE blocks SET space_id = ? WHERE id IN (?, ?)",
        &[OTHER_SPACE, OTHER_SPACE, OTHER_SPACE_BLOCK],
    )
    .await;
}

async fn seed_content_block(pool: &SqlitePool, i: u32) {
    let id = format!("QBP_C{i:02}");
    let id = id.as_str();
    let content = if i % 6 == 4 { " \t\n" } else { id };
    let parent = if i < 20 { PAGE } else { PAGE_TWO };
    insert_block(
        pool,
        id,
        "content",
        content,
        Some(parent),
        Some(i64::from(i) + 1),
    )
    .await;

    if i % 2 == 0 {
        let status = if i % 4 == 0 { "open" } else { "done" };
        exec(pool, TEXT_PROP, &[id, "status", status]).await;
    }
    // `kind` holds a different value type per block, for the `neq` semantics.
    match i % 5 {
        0 => exec(pool, TEXT_PROP, &[id, "kind", "x"]).await,
        1 => {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_num) VALUES (?, 'kind', ?)",
            )
            .bind(id)
            .bind(f64::from(i))
            .execute(pool)
            .await
            .unwrap();
        }
        2 => {
            let kind = format!("2025-03-{i:02}");
            exec(pool, DATE_PROP, &[id, "kind", kind.as_str()]).await;
        }
        _ => {}
    }
    if i % 3 == 0 {
        let deadline = format!("2025-01-{:02}", i + 1);
        exec(pool, DATE_PROP, &[id, "deadline", deadline.as_str()]).await;
    }
    if i % 2 == 1 {
        let rank = format!("r{i:02}");
        exec(pool, TEXT_PROP, &[id, "rank", rank.as_str()]).await;
    }

    let todo_state = match i % 4 {
        0 => Some("DONE"),
        1 => Some("TODO"),
        2 => Some("DOING"),
        _ => None,
    };
    let priority = match i % 3 {
        1 => Some("1"),
        2 => Some("2"),
        _ => None,
    };
    let due_date = (i % 2 == 0).then(|| format!("2025-02-{:02}", i + 1));
    let scheduled_date = (i % 5 == 0).then(|| format!("2025-04-{:02}", i + 1));
    sqlx::query(
        "UPDATE blocks SET todo_state = ?, priority = ?, due_date = ?, scheduled_date = ? \
         WHERE id = ?",
    )
    .bind(todo_state)
    .bind(priority)
    .bind(due_date)
    .bind(scheduled_date)
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

// ---------------------------------------------------------------------------
// Call shapes
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Shape {
    key: &'static str,
    value_text: Option<&'static str>,
    value_date: Option<&'static str>,
    operator: &'static str,
    exclude_parent_id: Option<&'static str>,
    content_non_empty: bool,
    block_type: Option<&'static str>,
    value_text_in: Vec<String>,
    value_date_range: Option<(&'static str, &'static str)>,
    exclude_todo_states: Vec<String>,
    /// Rows across every page, so a corpus that drifts into matching nothing
    /// cannot make the two statements agree vacuously.
    expected_rows: usize,
}

fn presence(key: &'static str, expected_rows: usize) -> Shape {
    Shape {
        key,
        value_text: None,
        value_date: None,
        operator: "eq",
        exclude_parent_id: None,
        content_non_empty: false,
        block_type: None,
        value_text_in: Vec::new(),
        value_date_range: None,
        exclude_todo_states: Vec::new(),
        expected_rows,
    }
}

fn text(
    key: &'static str,
    operator: &'static str,
    value: &'static str,
    expected_rows: usize,
) -> Shape {
    Shape {
        value_text: Some(value),
        operator,
        ..presence(key, expected_rows)
    }
}

fn date(
    key: &'static str,
    operator: &'static str,
    value: &'static str,
    expected_rows: usize,
) -> Shape {
    Shape {
        value_date: Some(value),
        operator,
        ..presence(key, expected_rows)
    }
}

fn text_in(key: &'static str, values: &[&str], expected_rows: usize) -> Shape {
    Shape {
        value_text_in: strings(values),
        ..presence(key, expected_rows)
    }
}

fn date_range(
    key: &'static str,
    from: &'static str,
    to: &'static str,
    expected_rows: usize,
) -> Shape {
    Shape {
        value_date_range: Some((from, to)),
        ..presence(key, expected_rows)
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().copied().map(String::from).collect()
}

fn shapes() -> Vec<Shape> {
    vec![
        presence("status", 12),
        text("status", "eq", "open", 7),
        text("status", "neq", "open", 5),
        text("kind", "neq", "x", 9),
        date("kind", "neq", "2025-03-02", 13),
        text("rank", "lt", "r11", 5),
        text("rank", "gt", "r11", 6),
        text("rank", "lte", "r11", 6),
        text("rank", "gte", "r11", 7),
        date("deadline", "eq", "2025-01-10", 1),
        date("deadline", "lt", "2025-01-10", 4),
        date("deadline", "gt", "2025-01-10", 4),
        date("deadline", "lte", "2025-01-10", 5),
        date("deadline", "gte", "2025-01-10", 5),
        text_in("status", &["open", "done"], 12),
        text_in("status", &["done"], 5),
        date_range("deadline", "2025-01-01", "2025-01-13", 5),
        // An unrecognised operator falls back to `eq`.
        text("status", "like", "open", 7),
        presence("todo_state", 17),
        text("todo_state", "eq", "TODO", 6),
        text("todo_state", "neq", "TODO", 11),
        text_in("todo_state", &["TODO", "DOING"], 11),
        presence("priority", 16),
        text("priority", "eq", "1", 8),
        text("priority", "gt", "1", 8),
        presence("due_date", 12),
        date("due_date", "eq", "2025-02-05", 1),
        date("due_date", "lt", "2025-02-10", 6),
        date("due_date", "gte", "2025-02-10", 6),
        date_range("due_date", "2025-02-01", "2025-02-12", 7),
        presence("scheduled_date", 5),
        date_range("scheduled_date", "2025-04-01", "2025-04-12", 3),
        Shape {
            exclude_parent_id: Some(PAGE),
            ..presence("status", 2)
        },
        Shape {
            content_non_empty: true,
            ..presence("due_date", 9)
        },
        Shape {
            block_type: Some("page"),
            ..presence("status", 1)
        },
        Shape {
            block_type: Some("content"),
            ..presence("due_date", 11)
        },
        // The due panel's overdue read.
        Shape {
            content_non_empty: true,
            exclude_todo_states: strings(&["DONE"]),
            ..date_range("due_date", "0001-01-01", "2025-02-20", 5)
        },
        Shape {
            exclude_todo_states: strings(&["DONE", "DOING"]),
            ..presence("deadline", 5)
        },
    ]
}

async fn run(pool: &SqlitePool, shape: &Shape, page: &PageRequest) -> PageResponse<BlockRow> {
    query_by_property(
        pool,
        shape.key,
        shape.value_text,
        shape.value_date,
        shape.operator,
        page,
        TEST_SPACE_ID,
        shape.exclude_parent_id,
        shape.content_non_empty,
        shape.block_type,
        &shape.value_text_in,
        shape.value_date_range,
        &shape.exclude_todo_states,
    )
    .await
    .unwrap()
}

async fn run_oracle(
    pool: &SqlitePool,
    shape: &Shape,
    page: &PageRequest,
) -> PageResponse<BlockRow> {
    query_by_property_oracle(
        pool,
        shape.key,
        shape.value_text,
        shape.value_date,
        shape.operator,
        page,
        Some(TEST_SPACE_ID),
        shape.exclude_parent_id,
        shape.content_non_empty,
        shape.block_type,
        &shape.value_text_in,
        shape.value_date_range,
        &shape.exclude_todo_states,
    )
    .await
    .unwrap()
}

/// The plan of the statement `shape` runs on its first page, one step each.
async fn plan(pool: &SqlitePool, shape: &Shape) -> Vec<String> {
    let filters = PropertyFilters {
        value_text: shape.value_text,
        value_date: shape.value_date,
        sql_op: sql_operator(shape.operator),
        after_id: None,
        space_id: TEST_SPACE_ID,
        exclude_parent_id: shape.exclude_parent_id,
        content_non_empty: shape.content_non_empty,
        block_type: shape.block_type,
        value_text_in_json: json_array(&shape.value_text_in).unwrap(),
        value_date_range: shape.value_date_range,
        exclude_todo_states_json: json_array(&shape.exclude_todo_states).unwrap(),
    };
    let (sql, binds) = query_by_property_sql(shape.key, &filters).unwrap();
    let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(format!(
        "EXPLAIN QUERY PLAN {sql}"
    )));
    for value in binds {
        query = query.bind(value);
    }
    query
        .bind(PAGE_LIMIT + 1)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn query_by_property_pages_match_the_oracle_for_every_shape() {
    let (pool, _dir) = test_pool().await;
    seed_corpus(&pool).await;

    for shape in shapes() {
        let mut cursor: Option<String> = None;
        let mut rows = 0;
        for _ in 0..MAX_PAGES {
            let page = PageRequest::new(cursor.clone(), Some(PAGE_LIMIT)).unwrap();
            let statement = run(&pool, &shape, &page).await;
            let oracle = run_oracle(&pool, &shape, &page).await;
            assert_eq!(
                serde_json::to_value(&statement).unwrap(),
                serde_json::to_value(&oracle).unwrap(),
                "{shape:?}: the statement and the oracle disagree on the page after {cursor:?}"
            );
            rows += statement.items.len();
            if !statement.has_more {
                break;
            }
            cursor = statement.next_cursor;
        }
        assert_eq!(
            rows, shape.expected_rows,
            "{shape:?}: the corpus must match exactly this many rows"
        );
    }
}

/// Without `sqlite_stat1` (a fresh database, or this test pool) each selective
/// shape must still narrow its value index, and no `blocks` index that walks the
/// whole space may drive the plan.
#[tokio::test]
async fn query_by_property_plan_narrows_the_value_index() {
    let (pool, _dir) = test_pool().await;
    seed_corpus(&pool).await;

    for (shape, step) in [
        (
            text("status", "eq", "open", 7),
            "idx_block_props_key_text (key=? AND value_text=?)",
        ),
        (
            text_in("status", &["open", "done"], 12),
            "idx_block_props_key_text (key=? AND value_text=?)",
        ),
        (
            date("deadline", "eq", "2025-01-10", 1),
            "idx_block_props_date (value_date=?)",
        ),
        (
            text("todo_state", "eq", "TODO", 6),
            "idx_blocks_todo (todo_state=?)",
        ),
        (
            text_in("todo_state", &["TODO", "DOING"], 11),
            "idx_blocks_todo (todo_state=?)",
        ),
        (
            date_range("due_date", "2025-02-01", "2025-02-12", 7),
            "idx_blocks_due (due_date>? AND due_date<?)",
        ),
        (date("due_date", "lt", "2025-02-10", 6), "idx_blocks_due ("),
        (
            date_range("scheduled_date", "2025-04-01", "2025-04-12", 3),
            "idx_blocks_scheduled (scheduled_date>? AND scheduled_date<?)",
        ),
    ] {
        let steps = plan(&pool, &shape).await;
        assert!(
            steps.iter().any(|s| s.contains(step)),
            "{shape:?}: the value predicate must narrow `{step}`; plan: {steps:#?}"
        );
    }

    for shape in shapes() {
        let steps = plan(&pool, &shape).await;
        assert!(
            !steps
                .iter()
                .any(|s| s.contains("idx_blocks_space_type") || s.contains("idx_blocks_type")),
            "{shape:?}: a space or block-type index must not drive the plan; plan: {steps:#?}"
        );
    }
}

/// A range on a property key, `neq` and presence walk `idx_block_props_key`
/// in id order and stop at the LIMIT, with and without `sqlite_stat1`: a value
/// index would read every match (for a date, every key's) and sort it first.
#[tokio::test]
async fn query_by_property_plan_walks_id_order_for_unselective_property_shapes() {
    let (pool, _dir) = test_pool().await;
    seed_corpus(&pool).await;
    let unselective = || {
        let mut all = vec![
            presence("status", 12),
            text("status", "neq", "open", 5),
            date("kind", "neq", "2025-03-02", 13),
            date_range("deadline", "2025-01-01", "2025-01-13", 5),
            Shape {
                exclude_todo_states: strings(&["DONE", "DOING"]),
                ..presence("deadline", 5)
            },
        ];
        for (operator, rank_rows, deadline_rows) in
            [("lt", 5, 4), ("gt", 6, 4), ("lte", 6, 5), ("gte", 7, 5)]
        {
            all.push(text("rank", operator, "r11", rank_rows));
            all.push(date("deadline", operator, "2025-01-10", deadline_rows));
        }
        all
    };

    for stats in ["without sqlite_stat1", "after ANALYZE"] {
        if stats == "after ANALYZE" {
            sqlx::query("ANALYZE").execute(&pool).await.unwrap();
        }
        for shape in unselective() {
            let steps = plan(&pool, &shape).await;
            assert!(
                steps
                    .iter()
                    .any(|s| s.starts_with("SEARCH bp") && s.contains("idx_block_props_key (key=?")),
                "{shape:?} {stats}: the plan must walk idx_block_props_key; plan: {steps:#?}"
            );
            assert!(
                !steps.iter().any(|s| s.contains("idx_block_props_key_text")
                    || s.contains("idx_block_props_date")
                    || s.contains("TEMP B-TREE")),
                "{shape:?} {stats}: no value index may drive and nothing may be sorted; \
                 plan: {steps:#?}"
            );
        }
    }
}
