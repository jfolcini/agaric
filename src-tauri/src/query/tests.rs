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
        aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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
async fn sort_by_title_ascending_with_keyset_pagination() {
    // Guards the correlated-subquery → LEFT JOIN materialisation for the Title
    // sort (issue #1631): the sort key (`pages_cache.title`) must drive the
    // ORDER BY and the keyset WHERE identically across page boundaries.
    let (pool, _d) = test_pool().await;

    // Register the space (blocks.space_id REFERENCES spaces(id)).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, page_id, space_id) VALUES (?, 'page', ?, NULL)",
    )
    .bind(SPACE)
    .bind(SPACE)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(SPACE)
        .execute(&pool)
        .await
        .unwrap();

    // Three page blocks (page_id == id, per migration 0073 CHECK) with titles
    // that sort Apple < Banana < Cherry — deliberately NOT in id order so the
    // primary sort key, not the id tiebreak, decides ordering.
    let pages = [
        ("01PAGE000000000000000000C", "Cherry"),
        ("01PAGE000000000000000000A", "Apple"),
        ("01PAGE000000000000000000B", "Banana"),
    ];
    for (id, title) in pages {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, page_id, space_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(id)
        .bind(id)
        .bind(SPACE)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, 0)")
            .bind(id)
            .bind(title)
            .execute(&pool)
            .await
            .unwrap();
    }

    let make = |cursor: Option<String>| AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: default_filter(),
        sort: vec![SortKey {
            source: SortSource::Column {
                name: SortColumn::Title,
            },
            desc: false,
        }],
        cursor,
        limit: Some(2),
        fulltext: None,
        group_by: None,
        aggregates: Vec::new(),
    };

    // Page 1: the two lowest titles, in order — Apple then Banana.
    let p1 = compile_and_run(&pool, make(None)).await.unwrap();
    let p1_ids: Vec<String> = p1
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    assert_eq!(
        p1_ids,
        vec![
            "01PAGE000000000000000000A".to_string(), // Apple
            "01PAGE000000000000000000B".to_string(), // Banana
        ],
        "Title-ascending page 1 must order by pages_cache.title"
    );
    assert!(p1.has_more, "third page (Cherry) remains");

    // Page 2 resumes after the keyset boundary: Cherry, no overlap with page 1.
    let p2 = compile_and_run(&pool, make(p1.next_cursor.clone()))
        .await
        .unwrap();
    let p2_ids: Vec<String> = p2
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    assert_eq!(
        p2_ids,
        vec!["01PAGE000000000000000000C".to_string()], // Cherry
        "keyset WHERE must resume strictly after Banana"
    );
    let s1: BTreeSet<_> = p1_ids.iter().collect();
    let s2: BTreeSet<_> = p2_ids.iter().collect();
    assert!(
        s1.is_disjoint(&s2),
        "Title keyset pagination must not repeat rows across the page boundary"
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
            aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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
        aggregates: Vec::new(),
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

// ── Aggregation (#1280 C4) ────────────────────────────────────────────────

use crate::query::{AggOp, AggregateColumn, AggregateResult, AggregateSpec, AggregateTarget};

/// Set a numeric (or non-numeric) `value_text` property on a block.
async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
}

/// Seed an `estimate` property: B1=3, B2=5, B3=8 (numeric) and B4="big"
/// (NON-numeric → must be SKIPPED by every fold). Sum of numerics = 16,
/// avg = 16/3 (NOT /4), min = 3, max = 8, numeric-count = 3.
async fn seed_estimates(pool: &SqlitePool) {
    set_property(pool, "01B1000000000000000000000", "estimate", "3").await;
    set_property(pool, "01B2000000000000000000000", "estimate", "5").await;
    set_property(pool, "01B3000000000000000000000", "estimate", "8").await;
    set_property(pool, "01B4000000000000000000000", "estimate", "big").await;
}

/// Build an aggregate spec over a property key.
fn agg_prop(op: AggOp, key: &str) -> AggregateSpec {
    AggregateSpec {
        op,
        target: Some(AggregateTarget::Property {
            key: key.to_string(),
        }),
    }
}

/// Look up the result for the i-th requested aggregate.
fn agg_at(resp: &AdvancedQueryResponse, i: usize) -> &AggregateResult {
    &resp.aggregates[i]
}

/// A small epsilon comparator for the f64 aggregate values.
fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[tokio::test]
async fn global_count_equals_match_count() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    let mut request = req(default_filter());
    request.aggregates = vec![AggregateSpec {
        op: AggOp::Count,
        target: None,
    }];
    let resp = compile_and_run(&pool, request).await.unwrap();
    // Whole SPACE: B1..B4 + RED + BLUE tag blocks = 6.
    assert_eq!(resp.total_count, Some(6));
    assert_eq!(agg_at(&resp, 0).op, AggOp::Count);
    assert_eq!(agg_at(&resp, 0).count, Some(6));
    assert_eq!(agg_at(&resp, 0).value, None);
}

#[tokio::test]
async fn global_folds_skip_non_numeric() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    seed_estimates(&pool).await;

    let mut request = req(default_filter());
    request.aggregates = vec![
        agg_prop(AggOp::Sum, "estimate"),
        agg_prop(AggOp::Avg, "estimate"),
        agg_prop(AggOp::Min, "estimate"),
        agg_prop(AggOp::Max, "estimate"),
        // Count WITH a target = the NUMERIC count (skips "big").
        agg_prop(AggOp::Count, "estimate"),
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();

    // Sum = 3+5+8 = 16 (the "big" row is skipped, NOT summed as 0).
    assert!(approx(agg_at(&resp, 0).value.unwrap(), 16.0), "{resp:?}");
    // Avg = 16 / 3 (numeric denominator), NOT 16 / 4.
    assert!(
        approx(agg_at(&resp, 1).value.unwrap(), 16.0 / 3.0),
        "avg must divide by the numeric count (3), not the row count (4): {resp:?}"
    );
    assert!(approx(agg_at(&resp, 2).value.unwrap(), 3.0), "{resp:?}");
    assert!(approx(agg_at(&resp, 3).value.unwrap(), 8.0), "{resp:?}");
    // Count-with-target = the numeric count = 3 (the non-numeric "big" skipped).
    assert_eq!(agg_at(&resp, 4).count, Some(3), "{resp:?}");
}

#[tokio::test]
async fn global_folds_all_non_numeric_is_none() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // EVERY estimate value is non-numeric.
    set_property(&pool, "01B1000000000000000000000", "estimate", "big").await;
    set_property(&pool, "01B2000000000000000000000", "estimate", "huge").await;

    let mut request = req(default_filter());
    request.aggregates = vec![
        agg_prop(AggOp::Sum, "estimate"),
        agg_prop(AggOp::Avg, "estimate"),
        agg_prop(AggOp::Min, "estimate"),
        agg_prop(AggOp::Max, "estimate"),
        agg_prop(AggOp::Count, "estimate"),
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();
    // All folds over an all-non-numeric set → NULL → value None.
    assert_eq!(agg_at(&resp, 0).value, None, "sum: {resp:?}");
    assert_eq!(agg_at(&resp, 1).value, None, "avg: {resp:?}");
    assert_eq!(agg_at(&resp, 2).value, None, "min: {resp:?}");
    assert_eq!(agg_at(&resp, 3).value, None, "max: {resp:?}");
    // Count-with-target over an all-non-numeric set = 0.
    assert_eq!(agg_at(&resp, 4).count, Some(0), "count: {resp:?}");
}

#[tokio::test]
async fn global_aggregate_over_priority_column_skips_non_numeric() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // priority is TEXT; the `select` values are "1"/"2"/"3" — and a label "A"
    // that must be skipped by the numeric guard.
    sqlx::query("UPDATE blocks SET priority = '2' WHERE id = '01B1000000000000000000000'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET priority = '4' WHERE id = '01B2000000000000000000000'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET priority = 'A' WHERE id = '01B3000000000000000000000'")
        .execute(&pool)
        .await
        .unwrap();

    let mut request = req(default_filter());
    request.aggregates = vec![
        AggregateSpec {
            op: AggOp::Sum,
            target: Some(AggregateTarget::Column {
                name: AggregateColumn::Priority,
            }),
        },
        AggregateSpec {
            op: AggOp::Count,
            target: Some(AggregateTarget::Column {
                name: AggregateColumn::Priority,
            }),
        },
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();
    // 2 + 4 = 6 ("A" skipped).
    assert!(approx(agg_at(&resp, 0).value.unwrap(), 6.0), "{resp:?}");
    assert_eq!(agg_at(&resp, 1).count, Some(2), "{resp:?}");
}

#[tokio::test]
async fn global_aggregate_over_position_column() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // positions: B1=1, B2=2, B3=3, B4=4; tag blocks NULL (skipped by SUM).
    let mut request = req(default_filter());
    request.aggregates = vec![
        AggregateSpec {
            op: AggOp::Sum,
            target: Some(AggregateTarget::Column {
                name: AggregateColumn::Position,
            }),
        },
        AggregateSpec {
            op: AggOp::Max,
            target: Some(AggregateTarget::Column {
                name: AggregateColumn::Position,
            }),
        },
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();
    assert!(approx(agg_at(&resp, 0).value.unwrap(), 10.0), "{resp:?}");
    assert!(approx(agg_at(&resp, 1).value.unwrap(), 4.0), "{resp:?}");
}

#[tokio::test]
async fn per_group_aggregates_correct() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    seed_estimates(&pool).await;
    // States: B1 TODO (est 3), B3 TODO (est 8) → TODO sum 11.
    //         B2 DONE (est 5)                  → DONE sum 5.
    //         B4 none (est "big" skipped)      → none sum NULL.
    let mut request = group_req(default_filter(), GroupKey::State);
    request.aggregates = vec![agg_prop(AggOp::Sum, "estimate")];
    let resp = compile_and_run(&pool, request).await.unwrap();

    let todo = find_group(&resp, "TODO");
    let done = find_group(&resp, "DONE");
    let none = find_group(&resp, "none");
    assert!(
        approx(todo.aggregates[0].value.unwrap(), 11.0),
        "TODO group sum: {:?}",
        todo.aggregates
    );
    assert!(
        approx(done.aggregates[0].value.unwrap(), 5.0),
        "DONE group sum: {:?}",
        done.aggregates
    );
    // The `none` state bucket = B4 ("big", skipped) + RED + BLUE tag blocks (no
    // estimate) → all NULL → fold None.
    assert_eq!(
        none.aggregates[0].value, None,
        "none group sum must be None (all-non-numeric/absent): {:?}",
        none.aggregates
    );

    // Grouped mode also carries the GLOBAL aggregate over the full set.
    assert!(
        approx(resp.aggregates[0].value.unwrap(), 16.0),
        "global sum over the full set = 16: {:?}",
        resp.aggregates
    );
}

#[tokio::test]
async fn aggregates_compose_with_structural_filter_and_fulltext() {
    let (pool, _d) = test_pool().await;
    seed_ft(&pool).await;
    // estimates on the FTS fixture: F1=3, F2=5 (RED), F3=8 (no tag).
    set_property(&pool, F1, "estimate", "3").await;
    set_property(&pool, F2, "estimate", "5").await;
    set_property(&pool, F3, "estimate", "8").await;

    // "alpha" (F1,F2,F3) ∩ tag RED (F1,F2) → sum estimate = 8, count = 2.
    let mut request = ft_req("alpha");
    request.filter = leaf(FilterPrimitive::Tag {
        tag: TAG_RED.to_string(),
    });
    request.aggregates = vec![
        agg_prop(AggOp::Sum, "estimate"),
        AggregateSpec {
            op: AggOp::Count,
            target: None,
        },
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();
    assert_eq!(ids(&resp), set(&[F1, F2]));
    assert!(approx(agg_at(&resp, 0).value.unwrap(), 8.0), "{resp:?}");
    assert_eq!(agg_at(&resp, 1).count, Some(2), "{resp:?}");
}

#[tokio::test]
async fn aggregates_over_empty_match_set() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // A filter matching nothing: state = a value no block has.
    let mut request = req(leaf(FilterPrimitive::State {
        values: vec!["NEVER".to_string()],
        is_null: false,
        exclude: false,
    }));
    request.aggregates = vec![
        AggregateSpec {
            op: AggOp::Count,
            target: None,
        },
        agg_prop(AggOp::Sum, "estimate"),
        agg_prop(AggOp::Avg, "estimate"),
    ];
    let resp = compile_and_run(&pool, request).await.unwrap();
    assert_eq!(resp.total_count, Some(0));
    // Count over an empty set = 0; folds = None.
    assert_eq!(agg_at(&resp, 0).count, Some(0), "{resp:?}");
    assert_eq!(agg_at(&resp, 1).value, None, "{resp:?}");
    assert_eq!(agg_at(&resp, 2).value, None, "{resp:?}");
}

#[tokio::test]
async fn aggregates_invariant_across_pagination() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    seed_estimates(&pool).await;

    let make = |limit: i64, cursor: Option<String>| {
        let mut r = req(default_filter());
        r.limit = Some(limit);
        r.cursor = cursor;
        r.sort = vec![SortKey {
            source: SortSource::Column {
                name: SortColumn::Position,
            },
            desc: false,
        }];
        r.aggregates = vec![
            AggregateSpec {
                op: AggOp::Count,
                target: None,
            },
            agg_prop(AggOp::Sum, "estimate"),
        ];
        r
    };

    // One big page: aggregates present on the first page.
    let big = compile_and_run(&pool, make(50, None)).await.unwrap();
    assert_eq!(big.aggregates[0].count, Some(6));
    assert!(approx(big.aggregates[1].value.unwrap(), 16.0));

    // First page of a paginated run: SAME aggregates (full-set invariant).
    let p1 = compile_and_run(&pool, make(2, None)).await.unwrap();
    assert_eq!(p1.aggregates[0].count, Some(6), "page-1 count == full set");
    assert!(
        approx(p1.aggregates[1].value.unwrap(), 16.0),
        "page-1 sum == full set"
    );

    // Cursor page: aggregates are NOT recomputed (empty, like total_count).
    let cursor = p1.next_cursor.clone().expect("has more");
    let p2 = compile_and_run(&pool, make(2, Some(cursor))).await.unwrap();
    assert!(
        p2.aggregates.is_empty(),
        "cursor pages skip aggregates (full-set invariant), got {:?}",
        p2.aggregates
    );
    assert_eq!(p2.total_count, None);
}

#[tokio::test]
async fn no_aggregates_requested_yields_empty() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // Default request carries no aggregates → response aggregates empty (flat).
    let flat = compile_and_run(&pool, req(default_filter())).await.unwrap();
    assert!(flat.aggregates.is_empty());
    // Grouped with no aggregates → empty global + empty per-group.
    let grouped = compile_and_run(&pool, group_req(default_filter(), GroupKey::State))
        .await
        .unwrap();
    assert!(grouped.aggregates.is_empty());
    assert!(grouped.groups.iter().all(|g| g.aggregates.is_empty()));
}

#[tokio::test]
async fn equal_count_grouped_pagination_no_dup() {
    let (pool, _d) = test_pool().await;
    // A dedicated fixture: 4 distinct states each with EXACTLY 2 blocks, so the
    // `gcount DESC, gkey ASC` keyset must lean on the `gkey` tiebreak for every
    // equal-count page boundary. Exercises the C3-deferred tie regression.
    for sp in [SPACE] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, page_id, space_id) VALUES (?, 'page', ?, NULL)",
        )
        .bind(sp)
        .bind(sp)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO spaces (id) VALUES (?)")
            .bind(sp)
            .execute(&pool)
            .await
            .unwrap();
    }
    // States AA, BB, CC, DD each get two blocks → 4 equal-count (2) groups.
    let states = ["AA", "BB", "CC", "DD"];
    for (si, st) in states.iter().enumerate() {
        for j in 0..2 {
            let id = format!("01EQ{si}{j}0000000000000000000");
            insert_block(&pool, &id, Some(SPACE), "content", Some(st), None, None).await;
        }
    }

    // One big page over all 4 groups.
    let mut big = group_req(default_filter(), GroupKey::State);
    big.limit = Some(50);
    let big_resp = compile_and_run(&pool, big).await.unwrap();
    let all_keys: Vec<String> = big_resp.groups.iter().map(|g| g.key.clone()).collect();
    assert_eq!(all_keys.len(), 4, "got {all_keys:?}");
    // All counts equal (2) → order is purely the gkey ASC tiebreak: AA,BB,CC,DD.
    assert_eq!(
        all_keys,
        vec!["AA", "BB", "CC", "DD"],
        "tie order by gkey ASC"
    );

    // Page through at limit 1: must reproduce the big-page order with no dup.
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut page = group_req(default_filter(), GroupKey::State);
        page.limit = Some(1);
        page.cursor = cursor.clone();
        let resp = compile_and_run(&pool, page).await.unwrap();
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
        "equal-count page-through must equal one big page (gkey tiebreak)"
    );
    let uniq: BTreeSet<&String> = collected.iter().collect();
    assert_eq!(
        uniq.len(),
        collected.len(),
        "no duplicate groups across pages"
    );
}

// ─────────────────────────────────────────────────────────────────────
// #1455 — relational / multi-hop predicates (links-to / linked-from /
// has-parent-matching). These tests seed `block_links` edges and
// `parent_id` chains on top of the standard fixture and assert the
// matched id set, AND/OR/NOT composition, keyset pagination, and the
// nested-`has-parent-matching` depth/cycle safety.
// ─────────────────────────────────────────────────────────────────────

/// Insert a directed link edge `source -> target` into `block_links`.
async fn insert_link(pool: &SqlitePool, source: &str, target: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert a content block with an explicit `parent_id`.
async fn insert_child(pool: &SqlitePool, id: &str, parent_id: &str, todo_state: Option<&str>) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, space_id, parent_id, todo_state, position) \
         VALUES (?, 'content', ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(format!("content {id}"))
    .bind(SPACE)
    .bind(parent_id)
    .bind(todo_state)
    .bind(1)
    .execute(pool)
    .await
    .unwrap();
}

const LINK_TARGET: &str = "01TARGET00000000000000000T";
const LINK_SOURCE: &str = "01SOURCE00000000000000000S";

#[tokio::test]
async fn links_to_matches_only_blocks_with_outbound_edge() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // A concrete target block (a content block in SPACE).
    insert_block(
        &pool,
        LINK_TARGET,
        Some(SPACE),
        "content",
        None,
        None,
        Some(9),
    )
    .await;
    // B1 and B3 link to the target; B2/B4 do NOT.
    insert_link(&pool, "01B1000000000000000000000", LINK_TARGET).await;
    insert_link(&pool, "01B3000000000000000000000", LINK_TARGET).await;
    // A red herring edge with a different target.
    insert_link(
        &pool,
        "01B2000000000000000000000",
        "01B4000000000000000000000",
    )
    .await;

    let resp = compile_and_run(
        &pool,
        req(leaf(FilterPrimitive::LinksTo {
            target: LINK_TARGET.to_string(),
        })),
    )
    .await
    .unwrap();

    assert_eq!(
        ids(&resp),
        set(&["01B1000000000000000000000", "01B3000000000000000000000"]),
        "links-to must match exactly the blocks with an outbound edge to the target"
    );
}

#[tokio::test]
async fn linked_from_matches_only_blocks_with_inbound_edge() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    insert_block(
        &pool,
        LINK_SOURCE,
        Some(SPACE),
        "content",
        None,
        None,
        Some(9),
    )
    .await;
    // The source links INTO B2 and B4 (inbound for those).
    insert_link(&pool, LINK_SOURCE, "01B2000000000000000000000").await;
    insert_link(&pool, LINK_SOURCE, "01B4000000000000000000000").await;
    // A red herring edge from a different source.
    insert_link(
        &pool,
        "01B1000000000000000000000",
        "01B3000000000000000000000",
    )
    .await;

    let resp = compile_and_run(
        &pool,
        req(leaf(FilterPrimitive::LinkedFrom {
            source: LINK_SOURCE.to_string(),
        })),
    )
    .await
    .unwrap();

    assert_eq!(
        ids(&resp),
        set(&["01B2000000000000000000000", "01B4000000000000000000000"]),
        "linked-from must match exactly the blocks with an inbound edge from the source"
    );
}

#[tokio::test]
async fn has_parent_matching_selects_children_of_matching_parent() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // Two parents in SPACE: PA is TODO, PB is DONE.
    insert_block(
        &pool,
        "01PA00000000000000000000A",
        Some(SPACE),
        "content",
        Some("TODO"),
        None,
        Some(20),
    )
    .await;
    insert_block(
        &pool,
        "01PB00000000000000000000B",
        Some(SPACE),
        "content",
        Some("DONE"),
        None,
        Some(21),
    )
    .await;
    // Children: C_A under PA (TODO parent), C_B under PB (DONE parent).
    insert_child(
        &pool,
        "01CA00000000000000000000A",
        "01PA00000000000000000000A",
        Some("DONE"),
    )
    .await;
    insert_child(
        &pool,
        "01CB00000000000000000000B",
        "01PB00000000000000000000B",
        Some("DONE"),
    )
    .await;

    // has-parent-matching(state TODO) → only C_A (its parent PA is TODO).
    let f = leaf(FilterPrimitive::HasParentMatching {
        matcher: Box::new(leaf(FilterPrimitive::State {
            values: vec!["TODO".to_string()],
            is_null: false,
            exclude: false,
        })),
    });
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    let got = ids(&resp);
    assert!(
        got.contains("01CA00000000000000000000A"),
        "child of TODO parent matches"
    );
    assert!(
        !got.contains("01CB00000000000000000000B"),
        "child of DONE parent excluded"
    );
    // Top-level blocks (no parent) never match has-parent-matching.
    assert!(!got.contains("01B1000000000000000000000"));
}

#[tokio::test]
async fn relational_composes_with_and_or_not() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    insert_block(
        &pool,
        LINK_TARGET,
        Some(SPACE),
        "content",
        None,
        None,
        Some(9),
    )
    .await;
    // B1 (TODO) and B2 (DONE) both link to target.
    insert_link(&pool, "01B1000000000000000000000", LINK_TARGET).await;
    insert_link(&pool, "01B2000000000000000000000", LINK_TARGET).await;

    // links-to(target) AND state TODO → only B1.
    let and = FilterExpr::And {
        children: vec![
            leaf(FilterPrimitive::LinksTo {
                target: LINK_TARGET.to_string(),
            }),
            leaf(FilterPrimitive::State {
                values: vec!["TODO".to_string()],
                is_null: false,
                exclude: false,
            }),
        ],
    };
    let resp = compile_and_run(&pool, req(and)).await.unwrap();
    assert_eq!(
        ids(&resp),
        set(&["01B1000000000000000000000"]),
        "AND with links-to intersects"
    );

    // NOT links-to(target) → blocks WITHOUT the edge (B3, B4, tag block, …);
    // B1/B2 excluded.
    let not = FilterExpr::Not {
        child: Box::new(leaf(FilterPrimitive::LinksTo {
            target: LINK_TARGET.to_string(),
        })),
    };
    let resp = compile_and_run(&pool, req(not)).await.unwrap();
    let got = ids(&resp);
    assert!(!got.contains("01B1000000000000000000000"));
    assert!(!got.contains("01B2000000000000000000000"));
    assert!(got.contains("01B3000000000000000000000"));
    assert!(got.contains("01B4000000000000000000000"));

    // links-to(target) OR state TODO → B1, B2 (links) ∪ B1, B3 (TODO).
    let or = FilterExpr::Or {
        children: vec![
            leaf(FilterPrimitive::LinksTo {
                target: LINK_TARGET.to_string(),
            }),
            leaf(FilterPrimitive::State {
                values: vec!["TODO".to_string()],
                is_null: false,
                exclude: false,
            }),
        ],
    };
    let resp = compile_and_run(&pool, req(or)).await.unwrap();
    assert_eq!(
        ids(&resp),
        set(&[
            "01B1000000000000000000000",
            "01B2000000000000000000000",
            "01B3000000000000000000000",
        ]),
        "OR with links-to unions"
    );
}

#[tokio::test]
async fn relational_predicate_paginates_correctly() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    insert_block(
        &pool,
        LINK_TARGET,
        Some(SPACE),
        "content",
        None,
        None,
        Some(99),
    )
    .await;
    // All four content blocks link to the target so the match set is B1..B4.
    for b in [
        "01B1000000000000000000000",
        "01B2000000000000000000000",
        "01B3000000000000000000000",
        "01B4000000000000000000000",
    ] {
        insert_link(&pool, b, LINK_TARGET).await;
    }

    let make = |cursor: Option<String>| AdvancedQueryRequest {
        space_id: SPACE.to_string(),
        filter: leaf(FilterPrimitive::LinksTo {
            target: LINK_TARGET.to_string(),
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
        aggregates: Vec::new(),
    };

    // One big page = ground truth order.
    let mut big = make(None);
    big.limit = Some(50);
    let big_resp = compile_and_run(&pool, big).await.unwrap();
    let all: Vec<String> = big_resp
        .rows
        .iter()
        .map(|r| r.block.id.as_str().to_string())
        .collect();
    assert_eq!(all.len(), 4, "all four linked blocks match");
    assert!(!big_resp.has_more);

    // Page through with limit 2; the keyset predicate must compose with the
    // relational EXISTS subquery without skipping or repeating rows.
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let resp = compile_and_run(&pool, make(cursor.clone())).await.unwrap();
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
        "paged result must equal one big page under a relational filter"
    );
    let uniq: BTreeSet<&String> = collected.iter().collect();
    assert_eq!(
        uniq.len(),
        collected.len(),
        "no duplicate rows across pages"
    );
}

#[tokio::test]
async fn nested_has_parent_matching_uses_distinct_aliases() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;
    // Grandparent GP (TODO) → parent P (DONE) → child C (DONE).
    insert_block(
        &pool,
        "01GP00000000000000000GP",
        Some(SPACE),
        "content",
        Some("TODO"),
        None,
        Some(30),
    )
    .await;
    insert_child(
        &pool,
        "01PP00000000000000000PP",
        "01GP00000000000000000GP",
        Some("DONE"),
    )
    .await;
    insert_child(
        &pool,
        "01CC00000000000000000CC",
        "01PP00000000000000000PP",
        Some("DONE"),
    )
    .await;

    // has-parent-matching( has-parent-matching(state TODO) )
    //   → blocks whose GRANDparent is TODO → only C (GP is TODO).
    // This exercises the per-level `p1`/`p2` aliasing: `p2.id = p1.parent_id`.
    let f = leaf(FilterPrimitive::HasParentMatching {
        matcher: Box::new(leaf(FilterPrimitive::HasParentMatching {
            matcher: Box::new(leaf(FilterPrimitive::State {
                values: vec!["TODO".to_string()],
                is_null: false,
                exclude: false,
            })),
        })),
    });
    let resp = compile_and_run(&pool, req(f)).await.unwrap();
    let got = ids(&resp);
    assert!(
        got.contains("01CC00000000000000000CC"),
        "grandchild of TODO grandparent matches"
    );
    // P's parent GP is TODO, but P itself is the child of GP (one hop) — the
    // TWO-hop filter must NOT match P, and must NOT match GP (top-level).
    assert!(!got.contains("01PP00000000000000000PP"));
    assert!(!got.contains("01GP00000000000000000GP"));
}

#[tokio::test]
async fn has_parent_matching_depth_exceeded_is_rejected() {
    let (pool, _d) = test_pool().await;
    seed(&pool).await;

    // Build a chain of MAX_DEPTH + 2 nested has-parent-matching leaves so the
    // depth gate (which now descends into the boxed matcher, #1455) rejects it
    // BEFORE the unbounded compile recursion runs.
    let mut expr = leaf(FilterPrimitive::State {
        values: vec!["TODO".to_string()],
        is_null: false,
        exclude: false,
    });
    for _ in 0..(FilterExpr::MAX_DEPTH + 2) {
        expr = leaf(FilterPrimitive::HasParentMatching {
            matcher: Box::new(expr),
        });
    }
    let err = compile_and_run(&pool, req(expr)).await.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "deeply-nested has-parent-matching must be rejected by the depth gate, got {err:?}"
    );
}
