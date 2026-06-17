//! #1280 — DB-level tests for the advanced-query engine.
//!
//! Seeds blocks (varied tags / state / dates / space) into a fresh
//! migrated pool, builds [`AdvancedQueryRequest`]s with [`FilterExpr`]
//! trees, and asserts the matched id set, pagination, cursor resume, and
//! `total_count`. Validation tests cover depth-exceeded, unsupported leaf,
//! and the empty-filter (all-in-space) case.

use super::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::filters::FilterExpr;
use crate::filters::primitive::{DatePredicate, FilterPrimitive};
use crate::query::engine::MAX_LIMIT;
use sqlx::SqlitePool;
use std::collections::BTreeSet;
use tempfile::TempDir;

const SPACE: &str = "01SPACE00000000000000000A";
const OTHER_SPACE: &str = "01SPACE00000000000000000B";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a content block with explicit metadata columns.
#[allow(clippy::too_many_arguments)]
async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    space_id: Option<&str>,
    block_type: &str,
    todo_state: Option<&str>,
    due_date: Option<&str>,
    position: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, space_id, todo_state, due_date, position) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(format!("content {id}"))
    .bind(space_id)
    .bind(todo_state)
    .bind(due_date)
    .bind(position)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    // The tag block must exist (FK) — insert a tag-typed block, ignore dupes.
    sqlx::query("INSERT OR IGNORE INTO blocks (id, block_type, space_id) VALUES (?, 'tag', ?)")
        .bind(tag_id)
        .bind(SPACE)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

const TAG_RED: &str = "01TAGRED0000000000000000R";
const TAG_BLUE: &str = "01TAGBLUE000000000000000B";

/// Seed a small fixture:
///   B1 — space A, todo TODO,  tag RED,            due 2026-03-01, pos 1
///   B2 — space A, todo DONE,  tag RED + BLUE,     due 2026-03-05, pos 2
///   B3 — space A, todo TODO,  tag BLUE,           due NULL,       pos 3
///   B4 — space A, todo NULL,  (no tags),          due 2026-01-01, pos 4
///   BX — space B, todo TODO,  tag RED,            due 2026-03-01, pos 1
async fn seed(pool: &SqlitePool) {
    // `blocks.space_id` is an FK to a block id; insert the space blocks first.
    // The space block itself is unscoped (`space_id` NULL) so it does not
    // self-reference before it exists and stays out of `b.space_id = ?`
    // results.
    for sp in [SPACE, OTHER_SPACE] {
        // A 'page' block must satisfy `page_id = id` (migration 0073 CHECK).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, page_id, space_id) VALUES (?, 'page', ?, NULL)",
        )
        .bind(sp)
        .bind(sp)
        .execute(pool)
        .await
        .unwrap();
        // `blocks.space_id` REFERENCES `spaces(id)` (migration 0089); register
        // the space block in the registry before any member references it.
        sqlx::query("INSERT INTO spaces (id) VALUES (?)")
            .bind(sp)
            .execute(pool)
            .await
            .unwrap();
    }
    insert_block(
        pool,
        "01B1000000000000000000000",
        Some(SPACE),
        "content",
        Some("TODO"),
        Some("2026-03-01"),
        Some(1),
    )
    .await;
    insert_block(
        pool,
        "01B2000000000000000000000",
        Some(SPACE),
        "content",
        Some("DONE"),
        Some("2026-03-05"),
        Some(2),
    )
    .await;
    insert_block(
        pool,
        "01B3000000000000000000000",
        Some(SPACE),
        "content",
        Some("TODO"),
        None,
        Some(3),
    )
    .await;
    insert_block(
        pool,
        "01B4000000000000000000000",
        Some(SPACE),
        "content",
        None,
        Some("2026-01-01"),
        Some(4),
    )
    .await;
    insert_block(
        pool,
        "01BX000000000000000000000",
        Some(OTHER_SPACE),
        "content",
        Some("TODO"),
        Some("2026-03-01"),
        Some(1),
    )
    .await;

    insert_tag(pool, "01B1000000000000000000000", TAG_RED).await;
    insert_tag(pool, "01B2000000000000000000000", TAG_RED).await;
    insert_tag(pool, "01B2000000000000000000000", TAG_BLUE).await;
    insert_tag(pool, "01B3000000000000000000000", TAG_BLUE).await;
    insert_tag(pool, "01BX000000000000000000000", TAG_RED).await;
}

fn req(filter: FilterExpr) -> AdvancedQueryRequest {
    AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter,
        sort: Vec::new(),
        cursor: None,
        limit: None,
        fulltext: None,
        group_by: None,
    }
}

fn leaf(p: FilterPrimitive) -> FilterExpr {
    FilterExpr::Leaf { primitive: p }
}

fn ids(resp: &AdvancedQueryResponse) -> BTreeSet<String> {
    resp.rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

#[tokio::test]
async fn empty_filter_returns_all_blocks_in_space() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Default filter = And{children:[]} = TRUE.
    let request = req(default_filter());
    let resp = compile_and_run(&pool, request).await.unwrap();

    // All content blocks in SPACE (B1..B4) + the RED tag block (also in SPACE).
    // The tag block is a real block in the space, so it is returned too.
    let got = ids(&resp);
    assert!(got.contains("01B1000000000000000000000"));
    assert!(got.contains("01B2000000000000000000000"));
    assert!(got.contains("01B3000000000000000000000"));
    assert!(got.contains("01B4000000000000000000000"));
    // The other-space block is excluded.
    assert!(!got.contains("01BX000000000000000000000"));
    // total_count is computed on the first page and matches row count.
    assert_eq!(resp.total_count, Some(i64::try_from(got.len()).unwrap()));
    assert!(!resp.has_more);
}

#[tokio::test]
async fn single_leaf_tag_filters_to_tagged_blocks() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(
        &pool,
        req(leaf(FilterPrimitive::Tag {
            tag: TAG_RED.to_string(),
        })),
    )
    .await
    .unwrap();

    // RED-tagged blocks in SPACE: B1, B2 (BX is in OTHER_SPACE).
    assert_eq!(
        ids(&resp),
        set(&["01B1000000000000000000000", "01B2000000000000000000000"])
    );
    assert_eq!(resp.total_count, Some(2));
}

#[tokio::test]
async fn and_of_two_leaves_intersects() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // tag RED AND state TODO → only B1.
    let f = FilterExpr::And {
        children: vec![
            leaf(FilterPrimitive::Tag {
                tag: TAG_RED.to_string(),
            }),
            leaf(FilterPrimitive::State {
                values: vec!["TODO".to_string()],
                is_null: false,
                exclude: false,
            }),
        ],
    };
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    assert_eq!(ids(&resp), set(&["01B1000000000000000000000"]));
}

#[tokio::test]
async fn or_of_two_leaves_unions() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // tag RED OR tag BLUE → B1, B2, B3.
    let f = FilterExpr::Or {
        children: vec![
            leaf(FilterPrimitive::Tag {
                tag: TAG_RED.to_string(),
            }),
            leaf(FilterPrimitive::Tag {
                tag: TAG_BLUE.to_string(),
            }),
        ],
    };
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    assert_eq!(
        ids(&resp),
        set(&[
            "01B1000000000000000000000",
            "01B2000000000000000000000",
            "01B3000000000000000000000"
        ])
    );
}

#[tokio::test]
async fn not_complements_within_space() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // NOT (state TODO) → blocks whose state is not TODO: B2 (DONE), B4 (NULL),
    // plus the RED tag block (state NULL). Crucially B1, B3 (TODO) excluded.
    let f = FilterExpr::Not {
        child: Box::new(leaf(FilterPrimitive::State {
            values: vec!["TODO".to_string()],
            is_null: false,
            exclude: false,
        })),
    };
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    let got = ids(&resp);
    assert!(got.contains("01B2000000000000000000000"));
    assert!(got.contains("01B4000000000000000000000"));
    assert!(!got.contains("01B1000000000000000000000"));
    assert!(!got.contains("01B3000000000000000000000"));
}

#[tokio::test]
async fn date_leaf_due_before() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // due-date Before 2026-03-01 → only B4 (2026-01-01). NULL due (B3) is
    // guarded out by the `IS NOT NULL` predicate.
    let f = leaf(FilterPrimitive::DueDate {
        predicate: DatePredicate::Before {
            date: "2026-03-01".to_string(),
        },
    });
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    assert_eq!(ids(&resp), set(&["01B4000000000000000000000"]));
}

#[tokio::test]
async fn pagination_page_through_equals_one_big_page() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // One big page (limit covers everything).
    let mut big = req(default_filter());
    big.limit = Some(50);
    let big_resp = compile_and_run(&pool, big).await.unwrap();
    let all: Vec<String> = big_resp
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    assert!(!big_resp.has_more);

    // Page through with limit 2.
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut first = true;
    loop {
        let mut page = req(default_filter());
        page.limit = Some(2);
        page.cursor = cursor.clone();
        let resp = compile_and_run(&pool, page).await.unwrap();
        // total_count present on first page only.
        if first {
            assert_eq!(resp.total_count, Some(i64::try_from(all.len()).unwrap()));
            first = false;
        } else {
            assert_eq!(resp.total_count, None);
        }
        for r in &resp.rows {
            collected.push(r.block.id.as_str().to_string());
        }
        if resp.has_more {
            cursor = resp.next_cursor.clone();
            assert!(cursor.is_some());
        } else {
            assert!(resp.next_cursor.is_none());
            break;
        }
    }

    assert_eq!(
        collected, all,
        "page-through order/content must equal one big page"
    );
    // No duplicates / omissions.
    let uniq: BTreeSet<&String> = collected.iter().collect();
    assert_eq!(
        uniq.len(),
        collected.len(),
        "no duplicate rows across pages"
    );
}

#[tokio::test]
async fn sort_by_position_ascending_with_cursor_resume() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let make = |cursor: Option<String>| AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: leaf(FilterPrimitive::State {
            values: vec!["TODO".to_string(), "DONE".to_string()],
            is_null: true,
            exclude: false,
        }),
        sort: vec![SortKey {
            source: SortSource::Column {
                name: SortColumn::Position,
            },
            desc: false,
        }],
        cursor,
        limit: Some(2),
        fulltext: None,
        group_by: None,
    };

    let p1 = compile_and_run(&pool, make(None)).await.unwrap();
    assert!(p1.has_more);
    let first_ids: Vec<String> = p1
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();

    let p2 = compile_and_run(&pool, make(p1.next_cursor.clone()))
        .await
        .unwrap();
    let second_ids: Vec<String> = p2
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();

    // The content blocks have positions 1..4; sorted ascending B1,B2,B3,B4.
    // The tag block has NULL position → sorts last. Page 1 = B1,B2.
    assert_eq!(first_ids[0], "01B1000000000000000000000");
    assert_eq!(first_ids[1], "01B2000000000000000000000");
    // No overlap between pages.
    let s1: BTreeSet<_> = first_ids.iter().collect();
    let s2: BTreeSet<_> = second_ids.iter().collect();
    assert!(s1.is_disjoint(&s2), "cursor resume must not repeat rows");
}

#[tokio::test]
async fn sort_by_last_edited_desc() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Seed op_log so B3 is most-recently edited, B1 oldest.
    let insert_oplog = |bid: &'static str, seq: i64, ms: i64| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
                 VALUES ('dev', ?, ?, 'edit', '{}', ?, ?)",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(ms)
            .bind(bid)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    insert_oplog("01B1000000000000000000000", 1, 1000).await;
    insert_oplog("01B2000000000000000000000", 2, 2000).await;
    insert_oplog("01B3000000000000000000000", 3, 3000).await;

    let request = AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: FilterExpr::Or {
            children: vec![
                leaf(FilterPrimitive::Tag {
                    tag: TAG_RED.to_string(),
                }),
                leaf(FilterPrimitive::Tag {
                    tag: TAG_BLUE.to_string(),
                }),
            ],
        },
        sort: vec![SortKey {
            source: SortSource::Column {
                name: SortColumn::LastEdited,
            },
            desc: true,
        }],
        cursor: None,
        limit: Some(50),
        fulltext: None,
        group_by: None,
    };
    let resp = compile_and_run(&pool, request).await.unwrap();
    let order: Vec<String> = resp
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    // B3 (3000) > B2 (2000) > B1 (1000).
    assert_eq!(
        order,
        vec![
            "01B3000000000000000000000".to_string(),
            "01B2000000000000000000000".to_string(),
            "01B1000000000000000000000".to_string(),
        ]
    );
}

#[tokio::test]
async fn score_is_none_in_structural_only_pr() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    let resp = compile_and_run(&pool, req(default_filter())).await.unwrap();
    assert!(resp.rows.iter().all(|r| r.score.is_none()));
}

// ── Validation ──────────────────────────────────────────────────────────

#[tokio::test]
async fn depth_exceeded_is_rejected() {
    let (pool, _d) = test_pool().await;

    // Build a tree deeper than MAX_DEPTH via nested Not.
    let mut f = leaf(FilterPrimitive::State {
        values: vec!["TODO".to_string()],
        is_null: false,
        exclude: false,
    });
    for _ in 0..(FilterExpr::MAX_DEPTH + 2) {
        f = FilterExpr::Not { child: Box::new(f) };
    }
    let err = compile_and_run(&pool, req(f)).await.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "depth-exceeded must be a Validation error, got {err:?}"
    );
}

#[tokio::test]
async fn unsupported_leaf_orphan_is_rejected() {
    let (pool, _d) = test_pool().await;

    // Orphan is a Pages-only physical leaf — not in QUERY_ALLOWED_KEYS.
    let err = compile_and_run(&pool, req(leaf(FilterPrimitive::Orphan)))
        .await
        .unwrap_err();
    match err {
        AppError::Validation(msg) => assert!(
            msg.contains("orphan"),
            "rejection message should name the offending key, got: {msg}"
        ),
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[tokio::test]
async fn unsupported_leaf_nested_in_and_is_rejected() {
    let (pool, _d) = test_pool().await;

    // A supported leaf AND an unsupported one → whole tree rejected.
    let f = FilterExpr::And {
        children: vec![
            leaf(FilterPrimitive::State {
                values: vec!["TODO".to_string()],
                is_null: false,
                exclude: false,
            }),
            leaf(FilterPrimitive::Stub),
        ],
    };
    let err = compile_and_run(&pool, req(f)).await.unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn limit_out_of_range_is_rejected() {
    let (pool, _d) = test_pool().await;
    let mut request = req(default_filter());
    request.limit = Some(0);
    assert!(matches!(
        compile_and_run(&pool, request).await.unwrap_err(),
        AppError::Validation(_)
    ));

    let mut request = req(default_filter());
    request.limit = Some(MAX_LIMIT + 1);
    assert!(matches!(
        compile_and_run(&pool, request).await.unwrap_err(),
        AppError::Validation(_)
    ));
}

#[tokio::test]
async fn cursor_sort_mismatch_is_rejected() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Get a cursor from a position-sorted query.
    let p1 = compile_and_run(
        &pool,
        AdvancedQueryRequest {
            space_id: SPACE.to_string(),
            filter: default_filter(),
            sort: vec![SortKey {
                source: SortSource::Column {
                    name: SortColumn::Position,
                },
                desc: false,
            }],
            cursor: None,
            limit: Some(2),
            fulltext: None,
            group_by: None,
        },
    )
    .await
    .unwrap();
    let cursor = p1.next_cursor.expect("should have more");

    // Resume with a DIFFERENT sort shape (extra key) → cursor length mismatch.
    let resumed = AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: default_filter(),
        sort: vec![
            SortKey {
                source: SortSource::Column {
                    name: SortColumn::Position,
                },
                desc: false,
            },
            SortKey {
                source: SortSource::Column {
                    name: SortColumn::Priority,
                },
                desc: false,
            },
        ],
        cursor: Some(cursor),
        limit: Some(2),
        fulltext: None,
        group_by: None,
    };
    assert!(matches!(
        compile_and_run(&pool, resumed).await.unwrap_err(),
        AppError::Validation(_)
    ));
}

// ── Full-text composition (#1280 fulltext fast-follow) ───────────────────

use crate::fts::rebuild_fts_index;

/// Insert a content block with explicit FTS content + space.
async fn insert_ft_block(pool: &SqlitePool, id: &str, space_id: &str, content: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, space_id) VALUES (?, 'content', ?, ?)",
    )
    .bind(id)
    .bind(content)
    .bind(space_id)
    .execute(pool)
    .await
    .unwrap();
}

const F1: &str = "01F1000000000000000000000";
const F2: &str = "01F2000000000000000000000";
const F3: &str = "01F3000000000000000000000";
const F4: &str = "01F4000000000000000000000";
const FX: &str = "01FX000000000000000000000";

/// Seed FTS content + structural attributes, then rebuild the FTS index.
///   F1 — space A, "alpha beta gamma quick brown fox", tag RED
///   F2 — space A, "alpha delta epsilon quick",        tag RED
///   F3 — space A, "alpha zeta solo passage",          (no tag)
///   F4 — space A, "unrelated content passage here",   tag RED
///   FX — space B, "alpha beta other space",           tag RED
async fn seed_ft(pool: &SqlitePool) {
    for sp in [SPACE, OTHER_SPACE] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, page_id, space_id) VALUES (?, 'page', ?, NULL)",
        )
        .bind(sp)
        .bind(sp)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO spaces (id) VALUES (?)")
            .bind(sp)
            .execute(pool)
            .await
            .unwrap();
    }
    insert_ft_block(pool, F1, SPACE, "alpha beta gamma quick brown fox").await;
    insert_ft_block(pool, F2, SPACE, "alpha delta epsilon quick").await;
    insert_ft_block(pool, F3, SPACE, "alpha zeta solo passage").await;
    insert_ft_block(pool, F4, SPACE, "unrelated content passage here").await;
    insert_ft_block(pool, FX, OTHER_SPACE, "alpha beta other space").await;

    insert_tag(pool, F1, TAG_RED).await;
    insert_tag(pool, F2, TAG_RED).await;
    insert_tag(pool, F4, TAG_RED).await;
    insert_tag(pool, FX, TAG_RED).await;

    rebuild_fts_index(pool).await.unwrap();
}

fn ft_req(fulltext: &str) -> AdvancedQueryRequest {
    AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: default_filter(),
        sort: Vec::new(),
        cursor: None,
        limit: None,
        fulltext: Some(fulltext.to_string()),
        group_by: None,
    }
}

#[tokio::test]
async fn fulltext_only_returns_matching_set_in_space() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // "alpha" matches F1, F2, F3 in SPACE; FX is in OTHER_SPACE (excluded);
    // F4 has no "alpha".
    let resp = compile_and_run(&pool, ft_req("alpha")).await.unwrap();
    assert_eq!(ids(&resp), set(&[F1, F2, F3]));
    assert_eq!(resp.total_count, Some(3));
    // Every row carries a bm25 score on the full-text path.
    assert!(
        resp.rows.iter().all(|r| r.score.is_some()),
        "fulltext rows must carry a score"
    );
}

#[tokio::test]
async fn fulltext_plus_structural_filter_intersects() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // "alpha" ∩ tag RED → F1, F2 (F3 has no RED tag; F4 has no "alpha";
    // FX is in OTHER_SPACE).
    let mut request = ft_req("alpha");
    request.filter = leaf(FilterPrimitive::Tag {
        tag: TAG_RED.to_string(),
    });
    let resp = compile_and_run(&pool, request).await.unwrap();
    assert_eq!(ids(&resp), set(&[F1, F2]));
    assert_eq!(resp.total_count, Some(2));
}

#[tokio::test]
async fn score_is_some_with_fulltext_and_none_without() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    let with = compile_and_run(&pool, ft_req("alpha")).await.unwrap();
    assert!(with.rows.iter().all(|r| r.score.is_some()));

    let without = compile_and_run(&pool, req(default_filter())).await.unwrap();
    assert!(without.rows.iter().all(|r| r.score.is_none()));
}

#[tokio::test]
async fn default_sort_is_relevance_when_fulltext() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // No explicit sort → default relevance (lower bm25 = better → first).
    let resp = compile_and_run(&pool, ft_req("alpha")).await.unwrap();
    // Scores must be non-decreasing across the page (ASC by rank).
    let scores: Vec<f64> = resp.rows.iter().map(|r| r.score.unwrap()).collect();
    assert!(
        scores.windows(2).all(|w| w[0] <= w[1]),
        "default fulltext sort must be relevance-ascending, got {scores:?}"
    );
}

#[tokio::test]
async fn explicit_relevance_sort_accepted_with_fulltext() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    let mut request = ft_req("alpha");
    request.sort = vec![SortKey {
        source: SortSource::Relevance,
        desc: false,
    }];
    let resp = compile_and_run(&pool, request).await.unwrap();
    assert_eq!(ids(&resp), set(&[F1, F2, F3]));
}

#[tokio::test]
async fn relevance_sort_rejected_without_fulltext() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    let request = AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: default_filter(),
        sort: vec![SortKey {
            source: SortSource::Relevance,
            desc: false,
        }],
        cursor: None,
        limit: None,
        fulltext: None, // no rank channel to sort on.
        group_by: None,
    };
    assert!(matches!(
        compile_and_run(&pool, request).await.unwrap_err(),
        AppError::Validation(_)
    ));
}

#[tokio::test]
async fn fulltext_pagination_under_relevance_equals_one_big_page() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // One big page over "alpha" (F1, F2, F3), relevance default.
    let mut big = ft_req("alpha");
    big.limit = Some(50);
    let big_resp = compile_and_run(&pool, big).await.unwrap();
    let all: Vec<String> = big_resp
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    assert!(!big_resp.has_more);
    assert_eq!(all.len(), 3);

    // Page through with limit 1 under the relevance sort.
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut page = ft_req("alpha");
        page.limit = Some(1);
        page.cursor = cursor.clone();
        let resp = compile_and_run(&pool, page).await.unwrap();
        for r in &resp.rows {
            collected.push(r.block.id.as_str().to_string());
        }
        if resp.has_more {
            cursor = resp.next_cursor.clone();
            assert!(cursor.is_some());
        } else {
            assert!(resp.next_cursor.is_none());
            break;
        }
    }
    assert_eq!(
        collected, all,
        "relevance page-through order/content must equal one big page"
    );
    let uniq: BTreeSet<&String> = collected.iter().collect();
    assert_eq!(
        uniq.len(),
        collected.len(),
        "no duplicate rows across pages"
    );
}

#[tokio::test]
async fn invalid_fts_query_is_validation_error() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // A leading bare `NOT` is a valid sanitiser output but an FTS5 binary-op
    // syntax error (`NOT` needs a left operand), surfaced as Validation.
    let err = compile_and_run(&pool, ft_req("NOT alpha"))
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "an FTS5 parse error must map to Validation, got {err:?}"
    );
}

// ── Grouping (#1280 grouping fast-follow) ─────────────────────────────────

use crate::query::{DateBucketUnit, DateField, GroupKey, GroupSpec, QueryGroup};

/// Build a grouped request over SPACE with the given filter + group key.
fn group_req(filter: FilterExpr, key: GroupKey) -> AdvancedQueryRequest {
    AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter,
        sort: Vec::new(),
        cursor: None,
        limit: None,
        fulltext: None,
        group_by: Some(GroupSpec { key }),
    }
}

/// Map `groups` to a `{key -> count}` lookup for count assertions.
fn group_counts(resp: &AdvancedQueryResponse) -> std::collections::BTreeMap<String, i64> {
    resp.groups
        .iter()
        .map(|g| (g.key.clone(), g.count))
        .collect()
}

fn find_group<'a>(resp: &'a AdvancedQueryResponse, key: &str) -> &'a QueryGroup {
    resp.groups
        .iter()
        .find(|g| g.key == key)
        .unwrap_or_else(|| panic!("group `{key}` not found; got {:?}", group_counts(resp)))
}

#[tokio::test]
async fn group_by_state_counts_with_none_bucket() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(&pool, group_req(default_filter(), GroupKey::State))
        .await
        .unwrap();

    // Flat rows are empty in grouped mode.
    assert!(resp.rows.is_empty(), "grouped mode leaves rows empty");

    let counts = group_counts(&resp);
    // TODO: B1, B3. DONE: B2. none: B4 + RED tag block + BLUE tag block.
    assert_eq!(counts.get("TODO"), Some(&2));
    assert_eq!(counts.get("DONE"), Some(&1));
    assert_eq!(
        counts.get("none"),
        Some(&3),
        "NULL todo_state must bucket under `none`; got {counts:?}"
    );
    // total_count is the number of GROUPS on the first page.
    assert_eq!(resp.total_count, Some(3));
    assert!(!resp.has_more);

    // Buckets are ordered by descending count.
    let order: Vec<i64> = resp.groups.iter().map(|g| g.count).collect();
    assert!(
        order.windows(2).all(|w| w[0] >= w[1]),
        "groups must be count-descending, got {order:?}"
    );
}

#[tokio::test]
async fn group_by_tag_counts_each_tag_with_multiplicity() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(&pool, group_req(default_filter(), GroupKey::Tag))
        .await
        .unwrap();

    let counts = group_counts(&resp);
    // RED tags B1, B2 → 2. BLUE tags B2, B3 → 2. B2 is double-tagged so it
    // counts in BOTH groups (documented multiplicity). BX is in OTHER_SPACE.
    assert_eq!(counts.get(TAG_RED), Some(&2), "got {counts:?}");
    assert_eq!(counts.get(TAG_BLUE), Some(&2), "got {counts:?}");
    // No `none` bucket for tags — the JOIN drops untagged blocks.
    assert!(!counts.contains_key("none"), "tags have no none bucket");

    // B2 appears as a member in BOTH the RED and BLUE buckets.
    let red = find_group(&resp, TAG_RED);
    let blue = find_group(&resp, TAG_BLUE);
    let red_ids: BTreeSet<&str> = red.members.iter().map(|m| m.block.id.as_str()).collect();
    let blue_ids: BTreeSet<&str> = blue.members.iter().map(|m| m.block.id.as_str()).collect();
    assert!(red_ids.contains("01B2000000000000000000000"));
    assert!(blue_ids.contains("01B2000000000000000000000"));
}

#[tokio::test]
async fn group_by_page_buckets_under_none_when_pageless() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // The seeded content/tag blocks have NULL page_id → all under `none`.
    let resp = compile_and_run(&pool, group_req(default_filter(), GroupKey::Page))
        .await
        .unwrap();
    let counts = group_counts(&resp);
    assert!(
        counts.contains_key("none"),
        "page-less blocks must bucket under `none`; got {counts:?}"
    );
}

#[tokio::test]
async fn group_by_block_type_buckets() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(&pool, group_req(default_filter(), GroupKey::BlockType))
        .await
        .unwrap();
    let counts = group_counts(&resp);
    // 4 content blocks (B1..B4) + 2 tag blocks (RED, BLUE).
    assert_eq!(counts.get("content"), Some(&4), "got {counts:?}");
    assert_eq!(counts.get("tag"), Some(&2), "got {counts:?}");
}

#[tokio::test]
async fn group_by_date_bucket_due_month_labels() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(
        &pool,
        group_req(
            default_filter(),
            GroupKey::DateBucket {
                source: DateField::Due,
                unit: DateBucketUnit::Month,
            },
        ),
    )
    .await
    .unwrap();
    let counts = group_counts(&resp);
    // Due dates: B1 2026-03-01, B2 2026-03-05 → "2026-03" = 2. B4 2026-01-01 →
    // "2026-01" = 1. B3 (NULL due) + tag blocks → "none".
    assert_eq!(counts.get("2026-03"), Some(&2), "got {counts:?}");
    assert_eq!(counts.get("2026-01"), Some(&1), "got {counts:?}");
    assert!(
        counts.contains_key("none"),
        "NULL due → none; got {counts:?}"
    );
}

#[tokio::test]
async fn group_by_date_bucket_due_day_labels() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let resp = compile_and_run(
        &pool,
        group_req(
            default_filter(),
            GroupKey::DateBucket {
                source: DateField::Due,
                unit: DateBucketUnit::Day,
            },
        ),
    )
    .await
    .unwrap();
    let counts = group_counts(&resp);
    // Day granularity → each distinct due date its own bucket.
    assert_eq!(counts.get("2026-03-01"), Some(&1), "got {counts:?}");
    assert_eq!(counts.get("2026-03-05"), Some(&1), "got {counts:?}");
    assert_eq!(counts.get("2026-01-01"), Some(&1), "got {counts:?}");
}

#[tokio::test]
async fn group_by_property_value_text() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Tag two blocks with the same property value and one with another.
    let set_prop = |bid: &'static str, val: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'status', ?)",
            )
            .bind(bid)
            .bind(val)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    set_prop("01B1000000000000000000000", "open").await;
    set_prop("01B2000000000000000000000", "open").await;
    set_prop("01B3000000000000000000000", "closed").await;

    let resp = compile_and_run(
        &pool,
        group_req(
            default_filter(),
            GroupKey::Property {
                key: "status".to_string(),
            },
        ),
    )
    .await
    .unwrap();
    let counts = group_counts(&resp);
    assert_eq!(counts.get("open"), Some(&2), "got {counts:?}");
    assert_eq!(counts.get("closed"), Some(&1), "got {counts:?}");
    // B4 + tag blocks lack the property → `none`.
    assert!(counts.contains_key("none"), "got {counts:?}");
}

#[tokio::test]
async fn group_member_preview_is_bounded() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Insert > GROUP_MEMBER_PREVIEW blocks all in one state bucket.
    let n = crate::query::engine::GROUP_MEMBER_PREVIEW + 5;
    for i in 0..n {
        let id = format!("01BIG{i:020}");
        insert_block(
            &pool,
            &id,
            Some(SPACE),
            "content",
            Some("DOING"),
            None,
            None,
        )
        .await;
    }

    let resp = compile_and_run(&pool, group_req(default_filter(), GroupKey::State))
        .await
        .unwrap();
    let doing = find_group(&resp, "DOING");
    assert_eq!(doing.count, n, "full count is unbounded by the preview cap");
    assert_eq!(
        i64::try_from(doing.members.len()).unwrap(),
        crate::query::engine::GROUP_MEMBER_PREVIEW,
        "member preview must be capped at GROUP_MEMBER_PREVIEW"
    );
}

#[tokio::test]
async fn group_pagination_pages_through_all_groups_once() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // One big page: all state groups (TODO, DONE, none).
    let mut big = group_req(default_filter(), GroupKey::State);
    big.limit = Some(50);
    let big_resp = compile_and_run(&pool, big).await.unwrap();
    let all_keys: Vec<String> = big_resp.groups.iter().map(|g| g.key.clone()).collect();
    assert!(!big_resp.has_more);
    assert_eq!(all_keys.len(), 3);

    // Page through with limit 1.
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut first = true;
    loop {
        let mut page = group_req(default_filter(), GroupKey::State);
        page.limit = Some(1);
        page.cursor = cursor.clone();
        let resp = compile_and_run(&pool, page).await.unwrap();
        if first {
            assert_eq!(resp.total_count, Some(3), "first-page total = #groups");
            first = false;
        } else {
            assert_eq!(resp.total_count, None, "cursor pages skip total");
        }
        for g in &resp.groups {
            collected.push(g.key.clone());
        }
        if resp.has_more {
            cursor = resp.next_cursor.clone();
            assert!(cursor.is_some());
        } else {
            assert!(resp.next_cursor.is_none());
            break;
        }
    }
    assert_eq!(
        collected, all_keys,
        "page-through order must equal one big page"
    );
    let uniq: BTreeSet<&String> = collected.iter().collect();
    assert_eq!(
        uniq.len(),
        collected.len(),
        "no duplicate groups across pages"
    );
}

#[tokio::test]
async fn group_by_state_respects_structural_filter() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Group by state, but only over tag-RED blocks (B1 TODO, B2 DONE).
    let resp = compile_and_run(
        &pool,
        group_req(
            leaf(FilterPrimitive::Tag {
                tag: TAG_RED.to_string(),
            }),
            GroupKey::State,
        ),
    )
    .await
    .unwrap();
    let counts = group_counts(&resp);
    assert_eq!(counts.get("TODO"), Some(&1), "got {counts:?}");
    assert_eq!(counts.get("DONE"), Some(&1), "got {counts:?}");
    assert!(
        !counts.contains_key("none"),
        "filtered set has no NULL-state block; got {counts:?}"
    );
}

#[tokio::test]
async fn group_composes_with_fulltext() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;

    // Group the "alpha" FTS match set (F1, F2, F3 in SPACE) by tag.
    // F1, F2 carry RED; F3 has no tag (dropped by the tag JOIN).
    let mut request = group_req(default_filter(), GroupKey::Tag);
    request.fulltext = Some("alpha".to_string());
    let resp = compile_and_run(&pool, request).await.unwrap();
    let counts = group_counts(&resp);
    assert_eq!(counts.get(TAG_RED), Some(&2), "got {counts:?}");
    // Members carry a bm25 score on the full-text path.
    let red = find_group(&resp, TAG_RED);
    assert!(
        red.members.iter().all(|m| m.score.is_some()),
        "grouped full-text members must carry a score"
    );
}
