//! Criterion benchmarks for the backlink query pipeline:
//!   - `eval_backlink_query`  — core filtered/sorted/paginated backlink lookup
//!   - `list_property_keys`   — distinct property key listing
//!   - `query_backlinks_filtered_inner` — Tauri command wrapper

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::backlink::{
    eval_backlink_query, list_property_keys, BacklinkFilter, BacklinkSort, CompareOp, SortDir,
};
use agaric_lib::commands::{count_backlinks_batch_inner, list_unlinked_references_inner};
use agaric_lib::db::init_pool;
use agaric_lib::pagination::PageRequest;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

// ---------------------------------------------------------------------------
// Seed helpers — raw SQL in transactions for speed
// ---------------------------------------------------------------------------

/// Seed a target block + `n` source blocks that link to it with full metadata.
///
/// Data distribution:
/// - Every 10th source includes "benchmark" in content (10% FTS match rate)
/// - Every 5th source has parent_id set to TARGET (20% parent relationship)
/// - Every 4th source is tagged with TAG01 (25% tag match rate)
/// - Every 3rd source has priority="high" (33% property match rate)
/// - All sources have `score` (num) and `due_date` (date) properties
///
/// This distribution is designed to test realistic filter selectivity.
async fn seed_backlinks_full(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Target block
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('TARGET', 'page', 'Target Page')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    // Tag block for HasTag filter benchmarks
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('TAG01', 'tag', 'bench-tag')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES ('TAG01', 'bench-tag', 0, '2025-01-01T00:00:00Z')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("SRC{i:020}");
        let extra = if i % 10 == 0 { " benchmark" } else { "" };
        let content = format!("Source block {i} with some content{extra}");
        let parent = if i % 5 == 0 { Some("TARGET") } else { None };

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES (?, 'content', ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(parent)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Link source → target
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, 'TARGET')")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();

        // FTS entry (stripped content = content itself for bench purposes)
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
            .bind(&id)
            .bind(&content)
            .execute(&mut *tx)
            .await
            .unwrap();

        // Properties
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'priority', ?)",
        )
        .bind(&id)
        .bind(if i % 3 == 0 { "high" } else { "low" })
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?, 'score', ?)",
        )
        .bind(&id)
        .bind(i as f64)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, 'due_date', ?)",
        )
        .bind(&id)
        .bind(format!("2025-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1))
        .execute(&mut *tx)
        .await
        .unwrap();

        // Tag every 4th block
        if i % 4 == 0 {
            sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, 'TAG01')")
                .bind(&id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }

    tx.commit().await.unwrap();
}

/// Lightweight seed: target + `n` source blocks with links only (no FTS/props/tags).
async fn seed_backlinks_minimal(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('TARGET', 'page', 'Target Page')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("SRC{i:020}");
        let content = format!("Source block {i}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(&content)
            .execute(&mut *tx)
            .await
            .unwrap();

        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, 'TARGET')")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
}

/// Seed `n` blocks with 2 properties each (for list_property_keys bench).
async fn seed_blocks_with_properties(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    for i in 0..n {
        let id = format!("BLK{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(format!("Block {i}"))
            .execute(&mut *tx)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'priority', 'high')",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?, 'score', ?)",
        )
        .bind(&id)
        .bind(i as f64)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();
}

// ===========================================================================
// 1. eval_query group — varying DB sizes, no filters
// ===========================================================================

fn bench_eval_query(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("eval_query");

    let page = PageRequest::new(None, None).unwrap();

    for count in [10, 100, 1_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("eval_{count}")));
        rt.block_on(seed_backlinks_minimal(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| eval_backlink_query(&pool, "TARGET", None, None, &page));
        });
    }
    group.finish();
}

// ===========================================================================
// 2. filter group — different filter types (~100 backlinks)
// ===========================================================================

fn bench_filter(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "filter"));
    rt.block_on(seed_backlinks_full(&pool, 100));

    let page = PageRequest::new(None, None).unwrap();

    let mut group = c.benchmark_group("filter");

    // Contains (FTS)
    group.bench_function("contains", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::Contains {
                query: "benchmark".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // BlockType
    group.bench_function("block_type", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::BlockType {
                block_type: "content".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // HasTag
    group.bench_function("has_tag", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::HasTag {
                tag_id: "TAG01".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // PropertyText Eq
    group.bench_function("property_text_eq", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::PropertyText {
                key: "priority".into(),
                op: CompareOp::Eq,
                value: "high".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // And compound (BlockType + Contains)
    group.bench_function("and_compound", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::And {
                filters: vec![
                    BacklinkFilter::BlockType {
                        block_type: "content".into(),
                    },
                    BacklinkFilter::Contains {
                        query: "benchmark".into(),
                    },
                ],
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // Or compound (HasTag | PropertyText)
    group.bench_function("or_compound", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::Or {
                filters: vec![
                    BacklinkFilter::HasTag {
                        tag_id: "TAG01".into(),
                    },
                    BacklinkFilter::PropertyText {
                        key: "priority".into(),
                        op: CompareOp::Eq,
                        value: "high".into(),
                    },
                ],
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // PropertyNum Gt
    group.bench_function("property_num_gt", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::PropertyNum {
                key: "score".into(),
                op: CompareOp::Gt,
                value: 50.0,
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // PropertyDate Eq
    group.bench_function("property_date_eq", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::PropertyDate {
                key: "due_date".into(),
                op: CompareOp::Eq,
                value: "2025-06-15".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // PropertyIsSet
    group.bench_function("property_is_set", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::PropertyIsSet {
                key: "priority".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // PropertyIsEmpty
    group.bench_function("property_is_empty", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::PropertyIsEmpty {
                key: "nonexistent_key".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // Not compound
    group.bench_function("not_compound", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::Not {
                filter: Box::new(BacklinkFilter::BlockType {
                    block_type: "tag".into(),
                }),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // HasTagPrefix
    group.bench_function("has_tag_prefix", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::HasTagPrefix {
                prefix: "bench".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // CreatedInRange
    group.bench_function("created_in_range", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::CreatedInRange {
                after: Some("2025-01-01T00:00:00Z".into()),
                before: Some("2025-12-31T23:59:59Z".into()),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    // Empty result (filter that matches nothing)
    group.bench_function("empty_result", |b| {
        b.to_async(&rt).iter(|| {
            let filters = vec![BacklinkFilter::Contains {
                query: "nonexistent_word_xyz".into(),
            }];
            eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        });
    });

    group.finish();
}

// ===========================================================================
// 3. sort group — different sort types (~100 backlinks)
// ===========================================================================

fn bench_sort(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "sort"));
    rt.block_on(seed_backlinks_full(&pool, 100));

    let page = PageRequest::new(None, None).unwrap();

    let mut group = c.benchmark_group("sort");

    // Created Asc
    group.bench_function("created_asc", |b| {
        b.to_async(&rt).iter(|| {
            let sort = BacklinkSort::Created { dir: SortDir::Asc };
            eval_backlink_query(&pool, "TARGET", None, Some(sort), &page)
        });
    });

    // Created Desc
    group.bench_function("created_desc", |b| {
        b.to_async(&rt).iter(|| {
            let sort = BacklinkSort::Created { dir: SortDir::Desc };
            eval_backlink_query(&pool, "TARGET", None, Some(sort), &page)
        });
    });

    // PropertyText sort
    group.bench_function("property_text", |b| {
        b.to_async(&rt).iter(|| {
            let sort = BacklinkSort::PropertyText {
                key: "priority".into(),
                dir: SortDir::Asc,
            };
            eval_backlink_query(&pool, "TARGET", None, Some(sort), &page)
        });
    });

    // PropertyNum sort
    group.bench_function("property_num", |b| {
        b.to_async(&rt).iter(|| {
            let sort = BacklinkSort::PropertyNum {
                key: "score".into(),
                dir: SortDir::Asc,
            };
            eval_backlink_query(&pool, "TARGET", None, Some(sort), &page)
        });
    });

    // PropertyDate sort
    group.bench_function("property_date", |b| {
        b.to_async(&rt).iter(|| {
            let sort = BacklinkSort::PropertyDate {
                key: "due_date".into(),
                dir: SortDir::Asc,
            };
            eval_backlink_query(&pool, "TARGET", None, Some(sort), &page)
        });
    });

    group.finish();
}

// ===========================================================================
// 4. pagination group — cursor-based paging (~500 backlinks)
// ===========================================================================

fn bench_pagination(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "pagination"));
    rt.block_on(seed_backlinks_minimal(&pool, 500));

    let mut group = c.benchmark_group("pagination");

    // First page (limit=20, no cursor)
    let first_page = PageRequest::new(None, Some(20)).unwrap();
    group.bench_function("first_page", |b| {
        b.to_async(&rt)
            .iter(|| eval_backlink_query(&pool, "TARGET", None, None, &first_page));
    });

    // Sequential 3-page walk
    group.bench_function("three_page_walk", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                // Page 1
                let page1 = PageRequest::new(None, Some(20)).unwrap();
                let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1)
                    .await
                    .unwrap();

                // Page 2
                if let Some(cursor) = resp1.next_cursor {
                    let page2 = PageRequest::new(Some(cursor), Some(20)).unwrap();
                    let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2)
                        .await
                        .unwrap();

                    // Page 3
                    if let Some(cursor2) = resp2.next_cursor {
                        let page3 = PageRequest::new(Some(cursor2), Some(20)).unwrap();
                        eval_backlink_query(&pool, "TARGET", None, None, &page3)
                            .await
                            .unwrap();
                    }
                }
            }
        });
    });

    group.finish();
}

// ===========================================================================
// 5. list_property_keys group
// ===========================================================================

fn bench_list_property_keys(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_property_keys");

    for count in [100, 1_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("props_{count}")));
        rt.block_on(seed_blocks_with_properties(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| list_property_keys(&pool));
        });
    }
    group.finish();
}

// ===========================================================================
// 6. scale group — eval_backlink_query at scale with filter + sort
// ===========================================================================

fn bench_scale(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("scale");

    for count in [100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("scale_{count}")));
        rt.block_on(seed_backlinks_full(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            let page = PageRequest::new(None, None).unwrap();
            b.to_async(&rt).iter(|| {
                let filters = vec![BacklinkFilter::Contains {
                    query: "benchmark".into(),
                }];
                let sort = BacklinkSort::Created { dir: SortDir::Asc };
                eval_backlink_query(&pool, "TARGET", Some(filters), Some(sort), &page)
            });
        });
    }
    group.finish();
}

// ===========================================================================
// 7. count_backlinks_batch — batch backlink counting for multiple pages
// ===========================================================================

/// Seed N content blocks with links pointing to 10 target pages.
async fn seed_backlinks_for_batch(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Create 10 target pages
    for p in 0..10 {
        let page_id = format!("PAGE{p:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)")
            .bind(&page_id)
            .bind(format!("Page {p}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    // Create N source blocks, each linking to one of the 10 pages (round-robin)
    for i in 0..n {
        let src_id = format!("BSRC{i:019}");
        let target_page = format!("PAGE{:020}", i % 10);

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES (?, 'content', ?, ?)",
        )
        .bind(&src_id)
        .bind(format!("Source block {i}"))
        .bind(&target_page)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&src_id)
            .bind(&target_page)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
}

fn bench_count_backlinks_batch(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("count_backlinks_batch");

    for count in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("batch_{count}")));
        rt.block_on(seed_backlinks_for_batch(&pool, count));

        let page_ids: Vec<String> = (0..10).map(|p| format!("PAGE{p:020}")).collect();

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| count_backlinks_batch_inner(&pool, page_ids.clone()));
        });
    }
    group.finish();
}

// ===========================================================================
// 8. list_unlinked_references — unlinked mention search
// ===========================================================================

/// Seed N content blocks; some contain the target page title as an unlinked mention.
/// Also seeds FTS entries so the unlinked-references query can find them.
async fn seed_unlinked_refs(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Target page whose title we search for as unlinked mentions
    let page_id = "UNLINK_TARGET_0000000000";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Benchmark Topic')",
    )
    .bind(page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let src_id = format!("USRC{i:019}");
        // Every 5th block mentions the page title text (20% mention rate)
        let content = if i % 5 == 0 {
            format!("This block mentions Benchmark Topic somewhere in block {i}")
        } else {
            format!("Unrelated content in block {i}")
        };

        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&src_id)
            .bind(&content)
            .execute(&mut *tx)
            .await
            .unwrap();

        // FTS entry for content search
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
            .bind(&src_id)
            .bind(&content)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
}

fn bench_list_unlinked_references(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_unlinked_references");

    for count in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("unlinked_{count}")));
        rt.block_on(seed_unlinked_refs(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| {
                list_unlinked_references_inner(
                    &pool,
                    "UNLINK_TARGET_0000000000",
                    None,
                    None,
                    None,
                    Some(50),
                )
            });
        });
    }
    group.finish();
}

// ===========================================================================
// Criterion harness
// ===========================================================================

criterion_group!(eval_query_benches, bench_eval_query,);

criterion_group!(filter_benches, bench_filter,);

criterion_group!(sort_benches, bench_sort,);

criterion_group!(pagination_benches, bench_pagination,);

criterion_group!(property_keys_benches, bench_list_property_keys,);

criterion_group!(scale_benches, bench_scale,);

criterion_group!(batch_benches, bench_count_backlinks_batch,);

criterion_group!(unlinked_benches, bench_list_unlinked_references,);

criterion_main!(
    eval_query_benches,
    filter_benches,
    sort_benches,
    pagination_benches,
    property_keys_benches,
    scale_benches,
    batch_benches,
    unlinked_benches,
);
