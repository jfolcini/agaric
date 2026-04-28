// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for the three hot-path Tauri command inner functions:
//!   1. `create_block_inner`  — every new block
//!   2. `edit_block_inner`    — every keystroke save
//!   3. `list_blocks_inner`   — every view render

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{
    batch_resolve_inner, create_block_inner, edit_block_inner, get_batch_properties_inner,
    get_block_history_inner, get_block_inner, get_conflicts_inner, list_blocks_inner,
    set_property_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
/// Must be called inside a tokio runtime (e.g. via `rt.block_on`).
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed `n` content blocks and return their IDs.
async fn seed_blocks(pool: &SqlitePool, materializer: &Materializer, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        let resp = create_block_inner(
            pool,
            "dev-bench",
            materializer,
            "content".into(),
            format!("Seeded block number {i} with some placeholder content."),
            None,
            Some(i as i64 + 1),
        )
        .await
        .unwrap();
        ids.push(resp.id);
    }
    ids
}

/// Bulk-seed `n` blocks directly via SQL in a single transaction.
///
/// Much faster than [`seed_blocks`] (which goes through the full command
/// pipeline) — suitable for 10K+ DB sizes where seeding cost dominates.
/// Populates both `blocks` and `op_log` tables for realistic DB state.
async fn seed_blocks_bulk(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("SEED{i:020}");
        let content = format!("Seeded block {i} with some placeholder content.");
        let ts = format!("2025-01-15T12:00:{:06}+00:00", i);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'content', ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES ('dev-bench', ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(i as i64 + 1)
        .bind(format!(
            r#"{{"block_id":"{id}","block_type":"content","content":"{content}"}}"#,
        ))
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .unwrap();

        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

// ===========================================================================
// create_block benchmarks
// ===========================================================================

fn bench_create_block_content_type(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "create_content"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    let content = "a".repeat(100);

    c.bench_function("create_block_content_type", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let content = content.clone();
            async move {
                create_block_inner(
                    &pool,
                    "dev-bench",
                    materializer_ref,
                    "content".into(),
                    content,
                    None,
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_create_block_with_parent(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "create_parent"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    // Create one parent block
    let parent_id = rt.block_on(async {
        let resp = create_block_inner(
            &pool,
            "dev-bench",
            &materializer,
            "page".into(),
            "Parent page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        resp.id
    });

    let content = "a".repeat(100);

    c.bench_function("create_block_with_parent", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let content = content.clone();
            let parent_id = parent_id.clone();
            async move {
                create_block_inner(
                    &pool,
                    "dev-bench",
                    materializer_ref,
                    "content".into(),
                    content,
                    Some(parent_id),
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_create_block_page_type(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "create_page"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    c.bench_function("create_block_page_type", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            async move {
                create_block_inner(
                    &pool,
                    "dev-bench",
                    materializer_ref,
                    "page".into(),
                    "My new page title".into(),
                    None,
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

// ===========================================================================
// edit_block benchmarks
// ===========================================================================

fn bench_edit_block_small_content(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "edit_small"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    // Seed one block to edit
    let block_id = rt.block_on(async {
        let ids = seed_blocks(&pool, &materializer, 1).await;
        ids[0].clone()
    });

    let small_content = "b".repeat(100);

    c.bench_function("edit_block_small_content", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let block_id = block_id.clone();
            let content = small_content.clone();
            async move {
                edit_block_inner(&pool, "dev-bench", materializer_ref, block_id, content)
                    .await
                    .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_edit_block_large_content(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "edit_large"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    let block_id = rt.block_on(async {
        let ids = seed_blocks(&pool, &materializer, 1).await;
        ids[0].clone()
    });

    let large_content = "c".repeat(10_000); // 10 KB

    c.bench_function("edit_block_large_content", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let block_id = block_id.clone();
            let content = large_content.clone();
            async move {
                edit_block_inner(&pool, "dev-bench", materializer_ref, block_id, content)
                    .await
                    .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_edit_block_sequential_10(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "edit_seq"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    let block_id = rt.block_on(async {
        let ids = seed_blocks(&pool, &materializer, 1).await;
        ids[0].clone()
    });

    c.bench_function("edit_block_sequential_10", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let block_id = block_id.clone();
            async move {
                for i in 0..10 {
                    edit_block_inner(
                        &pool,
                        "dev-bench",
                        materializer_ref,
                        block_id.clone(),
                        format!("Sequential edit number {i} with some content padding here"),
                    )
                    .await
                    .unwrap();
                }
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

// ===========================================================================
// list_blocks benchmarks
// ===========================================================================

fn bench_list_blocks_empty(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "list_empty"));

    c.bench_function("list_blocks_empty", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                list_blocks_inner(
                    &pool,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(50),
                    None,
                )
                .await
                .unwrap()
            }
        })
    });
}

fn bench_list_blocks_10_items(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "list_10"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    rt.block_on(seed_blocks(&pool, &materializer, 10));

    c.bench_function("list_blocks_10_items", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                list_blocks_inner(
                    &pool,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(50),
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_list_blocks_100_items(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "list_100"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    rt.block_on(seed_blocks(&pool, &materializer, 100));

    c.bench_function("list_blocks_100_items", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                list_blocks_inner(
                    &pool,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(200),
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_list_blocks_paginate_10_of_100(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "list_paginate"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    rt.block_on(seed_blocks(&pool, &materializer, 100));

    c.bench_function("list_blocks_paginate_10_of_100", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                // First page — fetch 10 of 100
                let page1 = list_blocks_inner(
                    &pool,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(10),
                    None,
                )
                .await
                .unwrap();
                // Second page using cursor from first page
                if let Some(cursor) = page1.next_cursor {
                    list_blocks_inner(
                        &pool,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        Some(cursor),
                        Some(10),
                        None,
                    )
                    .await
                    .unwrap();
                }
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_list_blocks_with_type_filter(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "list_filter"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    // Seed a mix: 50 content + 20 pages
    rt.block_on(async {
        seed_blocks(&pool, &materializer, 50).await; // content type
        for i in 0..20 {
            create_block_inner(
                &pool,
                "dev-bench",
                &materializer,
                "page".into(),
                format!("Page {i}"),
                None,
                Some(100 + i as i64),
            )
            .await
            .unwrap();
        }
    });

    c.bench_function("list_blocks_with_type_filter", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                list_blocks_inner(
                    &pool,
                    None,
                    Some("page".into()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(50),
                    None,
                )
                .await
                .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

// ===========================================================================
// batch_resolve benchmarks
// ===========================================================================

fn bench_batch_resolve(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("batch_resolve");

    // FEAT-3 Phase 7 — batch_resolve_inner takes a required space_id.
    // The bench seeds a synthetic space block + assigns every seeded
    // block to it so the membership filter doesn't drop the entire
    // result set (which would skew the throughput numbers).
    const BENCH_SPACE_ID: &str = "01BENCHSPACE00000000000001";

    for size in [10, 100, 500] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("batch_resolve_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks(&pool, &materializer, size));

        rt.block_on(async {
            sqlx::query(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'page', 'BenchSpace', NULL, NULL)",
            )
            .bind(BENCH_SPACE_ID)
            .execute(&pool)
            .await
            .unwrap();
            for id in &ids {
                sqlx::query(
                    "INSERT INTO block_properties (block_id, key, value_ref) \
                     VALUES (?, 'space', ?)",
                )
                .bind(id)
                .bind(BENCH_SPACE_ID)
                .execute(&pool)
                .await
                .unwrap();
            }
        });

        group.throughput(Throughput::Elements(size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let ids = ids.clone();
                    async move {
                        batch_resolve_inner(&pool, ids, Some(BENCH_SPACE_ID.to_string()))
                            .await
                            .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// batch_properties benchmarks
// ===========================================================================

fn bench_batch_properties(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "batch_props"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    // Seed 100 blocks with 2 properties each
    let ids = rt.block_on(async {
        let ids = seed_blocks(&pool, &materializer, 100).await;
        for id in &ids {
            set_property_inner(
                &pool,
                "dev-bench",
                &materializer,
                id.clone(),
                "priority".into(),
                Some("high".into()),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
            materializer.flush_background().await.unwrap();

            set_property_inner(
                &pool,
                "dev-bench",
                &materializer,
                id.clone(),
                "status".into(),
                Some("active".into()),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
            materializer.flush_background().await.unwrap();
        }
        ids
    });

    let mut group = c.benchmark_group("batch_properties");

    for size in [10, 50, 100] {
        let subset: Vec<String> = ids[..size].to_vec();
        group.throughput(Throughput::Elements(size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let ids = subset.clone();
                    async move { get_batch_properties_inner(&pool, ids).await.unwrap() }
                })
            },
        );
    }

    group.finish();
    rt.block_on(async { materializer.shutdown() });
}

// ===========================================================================
// Scale benchmarks — measure hot-path ops at realistic DB sizes
// ===========================================================================

/// Benchmark create_block with 100 / 1K / 10K / 100K existing blocks in the DB.
fn bench_create_block_at_scale(c: &mut Criterion) {
    let mut group = c.benchmark_group("create_block_at_scale");

    for db_size in [100, 1_000, 10_000, 100_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("create_s{db_size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        rt.block_on(seed_blocks_bulk(&pool, db_size));

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{db_size}_blocks")),
            &db_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    async move {
                        create_block_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            "content".into(),
                            "New block at scale".into(),
                            None,
                            None,
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

/// Benchmark edit_block with 100 / 1K / 10K / 100K ops already in the log.
fn bench_edit_block_at_scale(c: &mut Criterion) {
    let mut group = c.benchmark_group("edit_block_at_scale");

    for db_size in [100, 1_000, 10_000, 100_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("edit_s{db_size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, db_size));
        let target_id = ids[0].clone();

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{db_size}_blocks")),
            &db_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        edit_block_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            "Edited content at scale".into(),
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

/// Benchmark list_blocks (first page of 50) with 100 / 1K / 10K / 100K total blocks.
fn bench_list_blocks_at_scale(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_blocks_at_scale");

    for db_size in [100, 1_000, 10_000, 100_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("list_s{db_size}")));
        rt.block_on(seed_blocks_bulk(&pool, db_size));

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{db_size}_blocks")),
            &db_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        list_blocks_inner(
                            &pool,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            Some(50),
                            None,
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// get_block benchmarks
// ===========================================================================

/// Benchmark get_block_inner: look up a single block by ID at varying DB sizes.
fn bench_get_block(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_block");

    for db_size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("get_block_{db_size}")));
        let ids = rt.block_on(seed_blocks_bulk(&pool, db_size));
        let target_id = ids[db_size / 2].clone(); // pick the middle block

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{db_size}_blocks")),
            &db_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    async move { get_block_inner(&pool, target_id).await.unwrap() }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// get_block_history benchmarks
// ===========================================================================

/// Benchmark get_block_history_inner: fetch first page of history for a block
/// that has been edited M times.
fn bench_get_block_history(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_block_history");

    for history_size in [10, 100, 1_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("history_{history_size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        // Seed one block, then edit it `history_size` times to build history.
        let block_id = rt.block_on(async {
            let ids = seed_blocks(&pool, &materializer, 1).await;
            let id = ids[0].clone();
            for i in 0..history_size {
                edit_block_inner(
                    &pool,
                    "dev-bench",
                    &materializer,
                    id.clone(),
                    format!("History edit number {i} with padding content"),
                )
                .await
                .unwrap();
            }
            id
        });

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{history_size}_entries")),
            &history_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let block_id = block_id.clone();
                    async move {
                        get_block_history_inner(&pool, block_id, None, Some(50))
                            .await
                            .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// get_conflicts benchmarks
// ===========================================================================

/// Benchmark get_conflicts_inner: fetch first page of conflict blocks from a DB
/// where 10% of rows are marked as conflicts.
fn bench_get_conflicts(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_conflicts");

    for db_size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("conflicts_{db_size}")));
        let ids = rt.block_on(seed_blocks_bulk(&pool, db_size));

        // Mark 10% of blocks as conflicts via direct SQL.
        rt.block_on(async {
            let conflict_count = db_size / 10;
            let mut tx = pool.begin().await.unwrap();
            for id in ids.iter().take(conflict_count) {
                sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            tx.commit().await.unwrap();
        });

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{db_size}_blocks")),
            &db_size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move { get_conflicts_inner(&pool, None, Some(50)).await.unwrap() }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    create_benches,
    bench_create_block_content_type,
    bench_create_block_with_parent,
    bench_create_block_page_type,
);

criterion_group!(
    edit_benches,
    bench_edit_block_small_content,
    bench_edit_block_large_content,
    bench_edit_block_sequential_10,
);

criterion_group!(
    list_benches,
    bench_list_blocks_empty,
    bench_list_blocks_10_items,
    bench_list_blocks_100_items,
    bench_list_blocks_paginate_10_of_100,
    bench_list_blocks_with_type_filter,
);

criterion_group!(resolve_benches, bench_batch_resolve,);

criterion_group!(properties_benches, bench_batch_properties,);

criterion_group!(
    scale_benches,
    bench_create_block_at_scale,
    bench_edit_block_at_scale,
    bench_list_blocks_at_scale,
);

criterion_group!(
    read_benches,
    bench_get_block,
    bench_get_block_history,
    bench_get_conflicts,
);

criterion_main!(
    create_benches,
    edit_benches,
    list_benches,
    resolve_benches,
    properties_benches,
    scale_benches,
    read_benches,
);
