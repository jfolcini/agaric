//! PEND-53 — integration tests for the metadata-filter pipeline.
//!
//! Exercises the full chain: `SearchFilter` metadata fields →
//! `fts::metadata_filter::prepare_metadata` → SQL composition in
//! `fts::search_fts` → SQLite evaluation.
//!
//! Tests the SQL emission, not the resolver math (that lives in
//! `metadata_filter`'s own unit tests).

#![allow(unused_imports)]

use crate::commands::queries::{
    search_blocks_inner, DateFilter, DateOp, NamedDateRange, SearchFilter, SearchPropertyFilter,
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
    )
    .await
    .unwrap();
    assert!(
        resp.items.is_empty(),
        "unknown property key must return zero results — same tolerance as PEND-54 unknown tag"
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
