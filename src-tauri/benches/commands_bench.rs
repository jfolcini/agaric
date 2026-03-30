//! Criterion benchmarks for the three hot-path Tauri command inner functions:
//!   1. `create_block_inner`  — every new block
//!   2. `edit_block_inner`    — every keystroke save
//!   3. `list_blocks_inner`   — every view render

use criterion::{criterion_group, criterion_main, Criterion};

use block_notes_lib::commands::{
    batch_resolve_inner, create_block_inner, edit_block_inner, list_blocks_inner,
};
use block_notes_lib::db::init_pool;
use block_notes_lib::materializer::Materializer;

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
            Some(i as i64),
        )
        .await
        .unwrap();
        ids.push(resp.id);
    }
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
            Some(0),
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
                list_blocks_inner(&pool, None, None, None, None, None, Some(50))
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
                list_blocks_inner(&pool, None, None, None, None, None, Some(50))
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
                list_blocks_inner(&pool, None, None, None, None, None, Some(200))
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
                let page1 = list_blocks_inner(&pool, None, None, None, None, None, Some(10))
                    .await
                    .unwrap();
                // Second page using cursor from first page
                if let Some(cursor) = page1.next_cursor {
                    list_blocks_inner(&pool, None, None, None, None, Some(cursor), Some(10))
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
                list_blocks_inner(&pool, None, Some("page".into()), None, None, None, Some(50))
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

fn bench_batch_resolve_10(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "batch_resolve_10"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    let ids = rt.block_on(seed_blocks(&pool, &materializer, 10));

    c.bench_function("batch_resolve_10_blocks", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let ids = ids.clone();
            async move { batch_resolve_inner(&pool, ids).await.unwrap() }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_batch_resolve_100(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "batch_resolve_100"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    let ids = rt.block_on(seed_blocks(&pool, &materializer, 100));

    c.bench_function("batch_resolve_100_blocks", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let ids = ids.clone();
            async move { batch_resolve_inner(&pool, ids).await.unwrap() }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

fn bench_batch_resolve_500(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "batch_resolve_500"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    let ids = rt.block_on(seed_blocks(&pool, &materializer, 500));

    c.bench_function("batch_resolve_500_blocks", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let ids = ids.clone();
            async move { batch_resolve_inner(&pool, ids).await.unwrap() }
        })
    });

    rt.block_on(async { materializer.shutdown() });
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

criterion_group!(
    resolve_benches,
    bench_batch_resolve_10,
    bench_batch_resolve_100,
    bench_batch_resolve_500,
);

criterion_main!(create_benches, edit_benches, list_benches, resolve_benches);
