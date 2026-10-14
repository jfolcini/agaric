//! #5426: `filtered_blocks_query` resolves property and tag filters as
//! `b.id IN (…)` candidate sets. The correlated-`EXISTS` composition it
//! replaced stays here as the oracle: both must return the same pages for every
//! filter shape, and the new plan must look blocks up by candidate id.

use super::*;
use crate::commands::tests::common::{
    TEST_SPACE_B_ID, TEST_SPACE_ID, assign_all_to_test_space, ensure_test_space_b, insert_block,
    test_pool,
};
use agaric_store::space::SpaceId;

// ---------------------------------------------------------------------------
// Oracle: the composition before #5426, unchanged but for its names
// ---------------------------------------------------------------------------

async fn filtered_blocks_query_exists(
    pool: &SqlitePool,
    property_filters: &[PropertyFilter],
    tag_filters: Option<&TagFilterExpr>,
    block_type: Option<&str>,
    scope: &SpaceScope,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = PageRequest::new(cursor, limit)?;
    let fetch_limit = page.limit + 1;
    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let mut sql = String::from(
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                b.deleted_at, \
                b.todo_state, b.priority, b.due_date, b.scheduled_date, \
                b.page_id \
         FROM blocks b \
         WHERE b.deleted_at IS NULL \
           AND (?1 IS NULL OR b.id > ?2) \
           AND (?4 IS NULL OR b.space_id = ?4) \
           AND (?5 IS NULL OR b.block_type = ?5)",
    );
    let mut next_param: usize = 6;
    let mut prop_binds: Vec<String> = Vec::new();
    sql.push_str(&property_filters_sql_exists(
        property_filters,
        &mut next_param,
        &mut prop_binds,
    )?);
    let mut tag_binds: Vec<String> = Vec::new();
    if let Some(tf) = tag_filters
        && (!tf.tag_ids.is_empty() || !tf.prefixes.is_empty())
    {
        sql.push_str(&tag_filter_sql_exists(tf, &mut next_param, &mut tag_binds));
    }
    sql.push_str(" ORDER BY b.id ASC LIMIT ?3");
    assert_eq!(
        next_param - 6,
        prop_binds.len() + tag_binds.len(),
        "oracle placeholder index drifted from its bind count"
    );

    let mut q = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(cursor_flag)
        .bind(cursor_id)
        .bind(fetch_limit)
        .bind(scope.space_id().as_str())
        .bind(block_type);
    for v in &prop_binds {
        q = q.bind(v);
    }
    for v in &tag_binds {
        q = q.bind(v);
    }
    let rows = q.fetch_all(pool).await?;
    pagination::build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
}

fn property_filters_sql_exists(
    property_filters: &[PropertyFilter],
    next_param: &mut usize,
    binds: &mut Vec<String>,
) -> Result<String, AppError> {
    let mut frag = String::new();
    for pf in property_filters {
        if pf.key.trim().is_empty() {
            return Err(AppError::validation(
                "filtered_blocks_query: property filter key must not be empty".into(),
            ));
        }
        let reserved_col = if is_reserved_property_key(&pf.key) {
            match pf.key.as_str() {
                "todo_state" => Some("todo_state"),
                "priority" => Some("priority"),
                "due_date" => Some("due_date"),
                "scheduled_date" => Some("scheduled_date"),
                _ => {
                    return Err(AppError::validation(format!(
                        "filtered_blocks_query: reserved key '{}' has no column routing",
                        pf.key
                    )));
                }
            }
        } else {
            None
        };

        if let Some(col) = reserved_col {
            frag.push_str(&reserved_column_predicate_sql(pf, col, next_param, binds)?);
            continue;
        }

        let key_param = *next_param;
        *next_param += 1;
        binds.push(pf.key.clone());

        let value_pred = property_value_predicate_sql(pf, "bp", next_param, binds)?;

        frag.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM block_properties bp \
                          WHERE bp.block_id = b.id \
                            AND bp.key = ?{key_param}{value_pred})",
        ));
    }
    Ok(frag)
}

fn tag_filter_sql_exists(
    tf: &TagFilterExpr,
    next_param: &mut usize,
    binds: &mut Vec<String>,
) -> String {
    let mode = tf.mode.to_lowercase();
    let conjunction = if mode == "and" { " AND " } else { " OR " };

    let mut clauses: Vec<String> = Vec::new();
    for tag_id in &tf.tag_ids {
        let p = *next_param;
        *next_param += 1;
        binds.push(tag_id.clone());
        let mut union_arms = vec![
            format!("SELECT 1 FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id = ?{p}"),
            format!(
                "SELECT 1 FROM block_tag_refs btr WHERE btr.source_id = b.id AND btr.tag_id = ?{p}"
            ),
        ];
        if tf.include_inherited {
            union_arms.push(format!(
                "SELECT 1 FROM block_tag_inherited bti WHERE bti.block_id = b.id AND bti.tag_id = ?{p}"
            ));
        }
        clauses.push(format!("EXISTS ({})", union_arms.join(" UNION ALL ")));
    }
    for prefix in &tf.prefixes {
        let p = *next_param;
        *next_param += 1;
        let escaped = format!("{}%", agaric_core::sql_utils::escape_like(prefix));
        binds.push(escaped);
        let mut union_arms = vec![
            format!(
                "SELECT 1 FROM tags_cache tc \
                     JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                     WHERE bt.block_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
            ),
            format!(
                "SELECT 1 FROM tags_cache tc \
                     JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
                     WHERE btr.source_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
            ),
        ];
        if tf.include_inherited {
            union_arms.push(format!(
                "SELECT 1 FROM tags_cache tc \
                     JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
                     WHERE bti.block_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
            ));
        }
        clauses.push(format!("EXISTS ({})", union_arms.join(" UNION ALL ")));
    }
    format!(" AND ({})", clauses.join(conjunction))
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const TAG_WORK: &str = "FBP_TAG_WORK";
const TAG_WORKOUT: &str = "FBP_TAG_WORKOUT";
const TAG_HOME: &str = "FBP_TAG_HOME";
const TAG_PERCENT: &str = "FBP_TAG_PERCENT";
const TAG_FIFTY: &str = "FBP_TAG_FIFTY";
const PAGE: &str = "FBP_PAGE";
const OTHER_SPACE_BLOCK: &str = "FBP_OTHER";
const DELETED_BLOCK: &str = "FBP_C24";

/// Small enough that most shapes span several pages, so the cursor is exercised.
const PAGE_LIMIT: i64 = 3;
const MAX_PAGES: usize = 30;

const TEXT_PROP: &str = "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)";
const DATE_PROP: &str = "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)";
const DIRECT_TAG: &str = "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)";
const TAG_REF: &str = "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)";
const INHERITED_TAG: &str =
    "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)";

async fn exec(pool: &SqlitePool, sql: &'static str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(pool).await.unwrap();
}

/// Content blocks `FBP_C00..=FBP_C24` under one page, each carrying a
/// rule-derived mix of text / number / date properties, reserved columns,
/// direct tags, inline tag refs and inherited tags (a block can hold the same
/// tag twice, directly and by ref). `FBP_C24` is deleted and `FBP_OTHER` lives
/// in another space; both match many filters and must never be returned.
async fn seed_corpus(pool: &SqlitePool) {
    for (tag, name) in [
        (TAG_WORK, "work"),
        (TAG_WORKOUT, "Workout"),
        (TAG_HOME, "home"),
        (TAG_PERCENT, "50%_off"),
        (TAG_FIFTY, "50 cents"),
    ] {
        insert_block(pool, tag, "tag", name, None, None).await;
        exec(
            pool,
            "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, 0, '2025-01-01T00:00:00Z')",
            &[tag, name],
        )
        .await;
    }
    insert_block(pool, PAGE, "page", "page", None, None).await;
    exec(pool, TEXT_PROP, &[PAGE, "status", "open"]).await;
    exec(pool, DIRECT_TAG, &[PAGE, TAG_WORK]).await;

    for i in 0..=24_u32 {
        seed_content_block(pool, i).await;
    }
    exec(
        pool,
        "UPDATE blocks SET deleted_at = 1 WHERE id = ?",
        &[DELETED_BLOCK],
    )
    .await;

    ensure_test_space_b(pool).await;
    insert_block(pool, OTHER_SPACE_BLOCK, "content", "other", None, None).await;
    exec(pool, TEXT_PROP, &[OTHER_SPACE_BLOCK, "status", "open"]).await;
    exec(pool, DIRECT_TAG, &[OTHER_SPACE_BLOCK, TAG_WORK]).await;
    exec(pool, INHERITED_TAG, &[OTHER_SPACE_BLOCK, TAG_HOME, PAGE]).await;
    exec(
        pool,
        "UPDATE blocks SET todo_state = 'TODO', priority = '1', space_id = ? WHERE id = ?",
        &[TEST_SPACE_B_ID, OTHER_SPACE_BLOCK],
    )
    .await;

    assign_all_to_test_space(pool).await;
}

async fn seed_content_block(pool: &SqlitePool, i: u32) {
    let id = format!("FBP_C{i:02}");
    let id = id.as_str();
    insert_block(pool, id, "content", id, Some(PAGE), Some(i64::from(i) + 1)).await;

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
            let date = format!("2025-03-{i:02}");
            exec(pool, DATE_PROP, &[id, "kind", date.as_str()]).await;
        }
        _ => {}
    }
    if i % 3 == 0 {
        let deadline = format!("2025-01-{:02}", i + 1);
        exec(pool, DATE_PROP, &[id, "deadline", deadline.as_str()]).await;
    }

    let todo_state = match i % 4 {
        1 => Some("TODO"),
        3 => Some("DONE"),
        _ => None,
    };
    let priority = match i % 3 {
        1 => Some("1"),
        2 => Some("2"),
        _ => None,
    };
    let due_date = (i % 6 == 0).then(|| format!("2025-02-{:02}", i + 1));
    let scheduled_date = (i % 7 == 0).then_some("2025-04-01");
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

    for (applies, sql, tag) in [
        (i % 3 == 0, DIRECT_TAG, TAG_WORK),
        (i % 4 == 0, DIRECT_TAG, TAG_HOME),
        (i == 5, DIRECT_TAG, TAG_PERCENT),
        (i == 6, DIRECT_TAG, TAG_FIFTY),
        (i % 5 == 0, TAG_REF, TAG_WORK),
        (i % 7 == 0, TAG_REF, TAG_WORKOUT),
    ] {
        if applies {
            exec(pool, sql, &[id, tag]).await;
        }
    }
    for (applies, tag) in [(i % 2 == 1, TAG_HOME), (i % 6 == 0, TAG_PERCENT)] {
        if applies {
            exec(pool, INHERITED_TAG, &[id, tag, PAGE]).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Filter shapes
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Shape {
    props: Vec<PropertyFilter>,
    tags: Option<TagFilterExpr>,
    block_type: Option<&'static str>,
    /// Rows across every page, so a corpus that drifts into matching nothing
    /// cannot make the two queries agree vacuously.
    expected_rows: usize,
}

fn shape(props: Vec<PropertyFilter>, tags: Option<TagFilterExpr>, expected_rows: usize) -> Shape {
    Shape {
        props,
        tags,
        block_type: None,
        expected_rows,
    }
}

fn presence(key: &str) -> PropertyFilter {
    PropertyFilter {
        key: key.to_owned(),
        value_text: None,
        value_text_in: Vec::new(),
        value_date: None,
        value_date_range: None,
        operator: "eq".to_owned(),
    }
}

fn text(key: &str, operator: &str, value: &str) -> PropertyFilter {
    PropertyFilter {
        value_text: Some(value.to_owned()),
        operator: operator.to_owned(),
        ..presence(key)
    }
}

fn text_in(key: &str, values: &[&str]) -> PropertyFilter {
    PropertyFilter {
        value_text_in: values.iter().copied().map(String::from).collect(),
        ..presence(key)
    }
}

fn date(key: &str, operator: &str, value: &str) -> PropertyFilter {
    PropertyFilter {
        value_date: Some(value.to_owned()),
        operator: operator.to_owned(),
        ..presence(key)
    }
}

fn date_range(key: &str, from: &str, to: &str) -> PropertyFilter {
    PropertyFilter {
        value_date_range: Some((from.to_owned(), to.to_owned())),
        ..presence(key)
    }
}

fn tags(ids: &[&str], prefixes: &[&str], mode: &str, include_inherited: bool) -> TagFilterExpr {
    TagFilterExpr {
        tag_ids: ids.iter().copied().map(String::from).collect(),
        prefixes: prefixes.iter().copied().map(String::from).collect(),
        mode: mode.to_owned(),
        include_inherited,
    }
}

fn shapes() -> Vec<Shape> {
    let mut all = vec![
        shape(vec![presence("status")], None, 13),
        shape(vec![text("status", "eq", "open")], None, 7),
        shape(vec![text("status", "neq", "open")], None, 6),
        shape(vec![text("kind", "neq", "x")], None, 10),
        shape(vec![text("status", "lt", "e")], None, 6),
        shape(vec![text_in("status", &["open", "done"])], None, 13),
        shape(vec![date("deadline", "eq", "2025-01-04")], None, 1),
        shape(vec![date("kind", "neq", "2025-03-02")], None, 14),
        shape(vec![date("deadline", "gte", "2025-01-10")], None, 5),
        shape(
            vec![date_range("deadline", "2025-01-01", "2025-01-13")],
            None,
            4,
        ),
        shape(vec![text("todo_state", "eq", "TODO")], None, 6),
        shape(vec![text_in("priority", &["1", "2"])], None, 16),
        shape(vec![text("priority", "neq", "1")], None, 8),
        shape(
            vec![date_range("due_date", "2025-02-01", "2025-02-20")],
            None,
            4,
        ),
        shape(vec![date("due_date", "lt", "2025-02-10")], None, 2),
        shape(vec![presence("scheduled_date")], None, 4),
        shape(vec![presence("status"), presence("deadline")], None, 4),
        shape(vec![], Some(tags(&[TAG_WORK], &[], "or", false)), 12),
        shape(
            vec![],
            Some(tags(&[TAG_WORK, TAG_HOME], &[], "or", false)),
            15,
        ),
        shape(
            vec![],
            Some(tags(&[TAG_WORK, TAG_HOME], &[], "and", false)),
            3,
        ),
        shape(
            vec![],
            Some(tags(&[TAG_WORK, TAG_HOME], &[], "AND", true)),
            8,
        ),
        shape(vec![], Some(tags(&[TAG_HOME], &[], "or", true)), 18),
        shape(vec![], Some(tags(&[], &["work"], "or", false)), 14),
        shape(vec![], Some(tags(&[], &["50%"], "or", true)), 5),
        shape(vec![], Some(tags(&[TAG_WORK], &["home"], "and", true)), 8),
        shape(vec![], Some(tags(&[TAG_WORKOUT], &["50"], "xor", false)), 6),
        shape(
            vec![presence("status")],
            Some(tags(&[TAG_WORK], &[], "or", false)),
            7,
        ),
        shape(
            vec![text("status", "eq", "open"), presence("due_date")],
            Some(tags(&[TAG_HOME], &["work"], "and", true)),
            2,
        ),
    ];
    for (props, tags, block_type, expected_rows) in [
        (vec![], None, "page", 2),
        (vec![], None, "content", 24),
        (vec![], None, "tag", 5),
        (vec![presence("status")], None, "content", 12),
        (vec![], Some(tags(&[TAG_WORK], &[], "or", false)), "page", 1),
    ] {
        all.push(Shape {
            props,
            tags,
            block_type: Some(block_type),
            expected_rows,
        });
    }
    all
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pushdown_pages_match_the_exists_oracle_for_every_filter_shape() {
    let (pool, _dir) = test_pool().await;
    seed_corpus(&pool).await;
    let scope = SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID));

    for shape in shapes() {
        let mut cursor: Option<String> = None;
        let mut rows = 0;
        for _ in 0..MAX_PAGES {
            let pushdown = filtered_blocks_query_inner(
                &pool,
                shape.props.clone(),
                shape.tags.clone(),
                shape.block_type.map(String::from),
                &scope,
                cursor.clone(),
                Some(PAGE_LIMIT),
            )
            .await
            .unwrap();
            let oracle = filtered_blocks_query_exists(
                &pool,
                &shape.props,
                shape.tags.as_ref(),
                shape.block_type,
                &scope,
                cursor.clone(),
                Some(PAGE_LIMIT),
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(&pushdown).unwrap(),
                serde_json::to_value(&oracle).unwrap(),
                "{shape:?}: the pushdown and the EXISTS oracle disagree on the page after {cursor:?}"
            );
            rows += pushdown.items.len();
            if !pushdown.has_more {
                break;
            }
            cursor = pushdown.next_cursor;
        }
        assert_eq!(
            rows, shape.expected_rows,
            "{shape:?}: the corpus must match exactly this many rows"
        );
    }
}

/// Without `sqlite_stat1` (a fresh database, or this test pool) the planner
/// must still drive from the candidate sets rather than walk the space.
#[tokio::test]
async fn pushdown_plan_looks_blocks_up_by_candidate_id() {
    let (pool, _dir) = test_pool().await;
    seed_corpus(&pool).await;

    for (props, tag_filter) in [
        (vec![presence("status")], None),
        (vec![text("status", "eq", "open")], None),
        (vec![text_in("status", &["open", "done"])], None),
        (
            vec![date_range("deadline", "2025-01-01", "2025-01-13")],
            None,
        ),
        (vec![], Some(tags(&[TAG_WORK, TAG_HOME], &[], "or", true))),
        (vec![], Some(tags(&[], &["work"], "and", true))),
        (
            vec![presence("status")],
            Some(tags(&[TAG_WORK, TAG_HOME], &[], "and", false)),
        ),
    ] {
        let (sql, binds) = filtered_blocks_sql(&props, tag_filter.as_ref(), None, None).unwrap();
        let mut q = sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {sql}"
        )))
        .bind(TEST_SPACE_ID)
        .bind(PAGE_LIMIT + 1);
        for v in &binds {
            q = q.bind(v);
        }
        let plan: Vec<String> = q
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, _, _, detail)| detail)
            .collect();

        assert!(
            plan.iter()
                .any(|step| step == "SEARCH b USING INDEX sqlite_autoindex_blocks_1 (id=?)"),
            "{props:?} {tag_filter:?}: blocks must be looked up by candidate id; plan: {plan:#?}"
        );
        assert!(
            !plan
                .iter()
                .any(|step| step.contains("CORRELATED") || step.contains("TEMP B-TREE")),
            "{props:?} {tag_filter:?}: no per-row subquery and no sort of the space; plan: {plan:#?}"
        );
        if !props.is_empty() {
            assert!(
                plan.iter()
                    .any(|step| step.starts_with("SEARCH bp")
                        && step.contains("idx_block_props_key")),
                "{props:?}: the property id set must come from a key index; plan: {plan:#?}"
            );
        }
    }
}
