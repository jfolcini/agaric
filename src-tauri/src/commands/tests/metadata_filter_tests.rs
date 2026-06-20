//! integration tests for the metadata-filter pipeline.
//!
//! Exercises the full chain: `SearchFilter` metadata fields →
//! `fts::metadata_filter::prepare_metadata` → SQL composition in
//! `fts::search_fts` → SQLite evaluation.
//!
//! Tests the SQL emission, not the resolver math (that lives in
//! `metadata_filter`'s own unit tests).

use crate::commands::queries::{
    DateFilter, DateOp, NamedDateRange, SearchFilter, SearchPropertyFilter, search_blocks_inner,
};
use crate::db::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;

async fn pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let p = init_pool(dir.path().join("test.db").as_path())
        .await
        .unwrap();
    (p, dir)
}

/// Seed a single content block with todo_state / priority / dates and
/// a corresponding FTS row.
#[allow(clippy::too_many_arguments)]
async fn seed_block_with_metadata(
    pool: &SqlitePool,
    block_id: &str,
    content: &str,
    todo_state: Option<&str>,
    priority: Option<&str>,
    due_date: Option<&str>,
    scheduled_date: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, todo_state, priority, due_date, scheduled_date, page_id) \
         VALUES (?, 'content', ?, NULL, 0, ?, ?, ?, ?, NULL)",
    )
    .bind(block_id)
    .bind(content)
    .bind(todo_state)
    .bind(priority)
    .bind(due_date)
    .bind(scheduled_date)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind(block_id)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_text)
        .execute(pool)
        .await
        .unwrap();
}

/// Seed a property with a non-text typed value (one of
/// `value_num` / `value_date` / `value_ref`). The `exactly_one_value`
/// CHECK on `block_properties` (migration 0062) means the caller
/// picks exactly one column.
async fn seed_property_num(pool: &SqlitePool, block_id: &str, key: &str, value_num: f64) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_num) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_num)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_date)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_property_ref(pool: &SqlitePool, block_id: &str, key: &str, value_ref: &str) {
    // value_ref FKs to blocks(id); seed a placeholder target block
    // first so the FK constraint is satisfied. Tests pass the
    // already-uppercased ULID.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'content', 'target', NULL, 999, NULL)",
    )
    .bind(value_ref)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_ref)
        .execute(pool)
        .await
        .unwrap();
}

// ULID-shaped IDs (26 chars, Crockford alphabet).
const B_TODO_P1: &str = "01HQBLMTA00000000000000001";
const B_TODO_P2: &str = "01HQBLMTA00000000000000002";
const B_DOING_P1: &str = "01HQBLMTA00000000000000003";
const B_DONE: &str = "01HQBLMTA00000000000000004";
const B_NOSTATE: &str = "01HQBLMTA00000000000000005";

async fn seed_corpus(pool: &SqlitePool) {
    seed_block_with_metadata(
        pool,
        B_TODO_P1,
        "alpha task one",
        Some("TODO"),
        Some("1"),
        Some("2026-05-18"),
        Some("2026-05-20"),
    )
    .await;
    seed_block_with_metadata(
        pool,
        B_TODO_P2,
        "alpha task two",
        Some("TODO"),
        Some("2"),
        Some("2026-06-01"),
        None,
    )
    .await;
    seed_block_with_metadata(
        pool,
        B_DOING_P1,
        "alpha task three",
        Some("DOING"),
        Some("1"),
        Some("2026-05-10"),
        Some("2026-05-15"),
    )
    .await;
    seed_block_with_metadata(
        pool,
        B_DONE,
        "alpha task four done",
        Some("DONE"),
        Some("3"),
        Some("2026-04-01"),
        None,
    )
    .await;
    seed_block_with_metadata(
        pool,
        B_NOSTATE,
        "alpha task five no state",
        None,
        None,
        None,
        None,
    )
    .await;

    seed_property(pool, B_TODO_P1, "status", "blocked").await;
    seed_property(pool, B_TODO_P1, "assignee", "alice").await;
    seed_property(pool, B_TODO_P2, "status", "ready").await;
    seed_property(pool, B_DOING_P1, "status", "blocked").await;
    seed_property(pool, B_DONE, "archived", "true").await;
}

#[tokio::test]
async fn state_filter_in_list() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            state_filter: vec!["TODO".into(), "DOING".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_DONE));
    assert!(!ids.contains(&B_NOSTATE));
}

#[tokio::test]
async fn state_filter_none_matches_is_null() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            state_filter: vec!["none".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![B_NOSTATE]);
}

#[tokio::test]
async fn state_and_priority_filter_compose() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            state_filter: vec!["TODO".into(), "DOING".into()],
            priority_filter: vec!["1".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_TODO_P2));
    assert!(!ids.contains(&B_DONE));
}

#[tokio::test]
async fn due_filter_op_form_lt() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            due_filter: Some(DateFilter::Op {
                op: DateOp::Lt,
                date: "2026-05-15".into(),
            }),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // due_date < 2026-05-15: B_DOING_P1 (2026-05-10) and B_DONE
    // (2026-04-01). B_NOSTATE has NULL due_date and must NOT match
    // (the SQL emits `IS NOT NULL`).
    assert!(ids.contains(&B_DOING_P1));
    assert!(ids.contains(&B_DONE));
    assert!(!ids.contains(&B_NOSTATE));
    assert!(!ids.contains(&B_TODO_P1));
}

#[tokio::test]
async fn due_filter_named_none_routes_to_is_null() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::None)),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![B_NOSTATE]);
}

#[tokio::test]
async fn property_filter_include_value_text() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "blocked".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_TODO_P2));
    assert!(!ids.contains(&B_DONE));
}

#[tokio::test]
async fn property_filter_include_empty_value_matches_key_presence() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: String::new(), // any value
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // Every block that has a `status` property — regardless of value.
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_DONE));
    assert!(!ids.contains(&B_NOSTATE));
}

#[tokio::test]
async fn property_filter_exclude_routes_to_not_exists() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            excluded_property_filters: vec![SearchPropertyFilter {
                key: "archived".into(),
                value: "true".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // Every block except B_DONE (which has archived=true).
    assert!(!ids.contains(&B_DONE));
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(ids.contains(&B_DOING_P1));
    assert!(ids.contains(&B_NOSTATE));
}

#[tokio::test]
async fn property_filter_and_compose_across_keys() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![
                SearchPropertyFilter {
                    key: "status".into(),
                    value: "blocked".into(),
                },
                SearchPropertyFilter {
                    key: "assignee".into(),
                    value: "alice".into(),
                },
            ],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // Only B_TODO_P1 has both: status=blocked AND assignee=alice.
    assert_eq!(ids, vec![B_TODO_P1]);
}

#[tokio::test]
async fn compound_filter_state_priority_property() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            state_filter: vec!["TODO".into()],
            priority_filter: vec!["1".into()],
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "blocked".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // Only B_TODO_P1: state=TODO ∧ priority=1 ∧ status=blocked.
    assert_eq!(ids, vec![B_TODO_P1]);
}

#[tokio::test]
async fn unknown_property_key_returns_zero_results() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "nonexistent_key".into(),
                value: "x".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        resp.items.is_empty(),
        "unknown property key must return zero results — same tolerance as  unknown tag"
    );
}

// =====================================================================
// `not-state:` / `not-priority:` proper inversion
// =====================================================================

#[tokio::test]
async fn excluded_state_filter_includes_no_state_rows() {
    // The design: `not-state:DONE` returns blocks with no
    // state AT ALL, in addition to blocks whose state isn't DONE.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            excluded_state_filter: vec!["DONE".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // B_DONE is excluded; all other states + the NO_STATE block are
    // included (NULL-inclusive inversion).
    assert!(!ids.contains(&B_DONE), "DONE block must be excluded");
    assert!(
        ids.contains(&B_NOSTATE),
        "no-state block must be included (NULL-inclusive)"
    );
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(ids.contains(&B_DOING_P1));
}

#[tokio::test]
async fn excluded_state_none_sentinel_excludes_null_state() {
    // `not-state:none` means "exclude blocks with no state set" —
    // the inverse of `state:none`.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            excluded_state_filter: vec!["none".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(!ids.contains(&B_NOSTATE), "no-state block must be excluded");
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_DONE));
}

#[tokio::test]
async fn excluded_state_combines_with_state_filter() {
    // `state:TODO not-state:DONE` is redundant (state IS TODO already
    // excludes DONE) but must still return the TODO blocks.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            state_filter: vec!["TODO".into()],
            excluded_state_filter: vec!["DONE".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(!ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_DONE));
    assert!(!ids.contains(&B_NOSTATE));
}

#[tokio::test]
async fn excluded_priority_inverts_priority_values() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            excluded_priority_filter: vec!["1".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    // No P1 blocks; everything else (including no-priority rows).
    assert!(!ids.contains(&B_TODO_P1));
    assert!(!ids.contains(&B_DOING_P1));
    assert!(ids.contains(&B_TODO_P2));
    assert!(ids.contains(&B_DONE));
    assert!(ids.contains(&B_NOSTATE));
}

// =====================================================================
// `prop:KEY=VALUE` four-column matching
// =====================================================================

#[tokio::test]
async fn prop_filter_matches_value_num_column() {
    // Block with a numeric property `priority=1` stored in value_num.
    // V1 missed this entirely (value_text-only);
    // matches across all four columns with type coercion.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    seed_property_num(&pool, B_TODO_P1, "score", 1.0).await;
    seed_property_num(&pool, B_TODO_P2, "score", 2.0).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "score".into(),
                value: "1".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![B_TODO_P1],
        "must match the value_num=1 block only"
    );
}

#[tokio::test]
async fn prop_filter_matches_value_date_column() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    seed_property_date(&pool, B_DOING_P1, "deadline", "2026-05-17").await;
    seed_property_date(&pool, B_DONE, "deadline", "2026-06-01").await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "deadline".into(),
                value: "2026-05-17".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![B_DOING_P1]);
}

#[tokio::test]
async fn prop_filter_matches_value_ref_column_case_insensitive() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let target = "01HQBLMTA000000000000000FF";
    seed_property_ref(&pool, B_TODO_P1, "author", target).await;
    // Lowercased user input must still match (ULIDs are normalised
    // to uppercase per Agaric convention).
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "author".into(),
                value: target.to_ascii_lowercase(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec![B_TODO_P1]);
}

#[tokio::test]
async fn prop_filter_text_value_still_matches_value_text() {
    // Regression guard: v1 `value_text`-only behaviour is preserved
    // for arbitrary string values.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    // status=blocked is already seeded for B_TODO_P1 + B_DOING_P1.
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "blocked".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&B_TODO_P1));
    assert!(ids.contains(&B_DOING_P1));
    assert!(!ids.contains(&B_TODO_P2));
}

#[tokio::test]
async fn prop_filter_numeric_value_does_not_match_text_column() {
    // `prop:status=1` must NOT match `status=blocked` even though
    // SQLite's text-vs-numeric affinity rules are nuanced. The
    // four-column OR keeps each branch type-safe.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "1".into(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        resp.items.is_empty(),
        "no row has status=1 (numeric); v1 returned the same empty set"
    );
}

#[tokio::test]
async fn invalid_due_filter_surfaces_typed_error() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            due_filter: Some(DateFilter::Op {
                op: DateOp::Eq,
                date: "2026-13-99".into(),
            }),
            ..Default::default()
        },
        None,
    )
    .await;
    let err = result.unwrap_err();
    match err {
        crate::error::AppError::Validation(msg) => {
            assert!(
                msg.starts_with("InvalidDateFilter:"),
                "expected InvalidDateFilter prefix, got: {msg}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}
