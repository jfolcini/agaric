//! Criterion benchmarks for draft autosave and flush — the hot path on every
//! keystroke (~2 s autosave) and every blur event (flush to op log).
//!
//! Benches:
//!   1. `save_draft`            — single block autosave (INSERT OR REPLACE)
//!   2. `save_draft_if_changed` — conditional autosave (skip if identical)
//!   3. `flush_draft`           — convert draft to `edit_block` op on blur
//!   4. Parameterised: steady-state cost with 10 / 100 / 1000 drafts in DB

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use block_notes_lib::commands::create_block_inner;
use block_notes_lib::db::init_pool;
use block_notes_lib::draft::{flush_draft, save_draft, save_draft_if_changed};
use block_notes_lib::materializer::Materializer;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Create a real content block so draft flush has a valid `block_id` target.
async fn create_block(pool: &SqlitePool, mat: &Materializer) -> String {
    let resp = create_block_inner(
        pool,
        "dev-bench",
        mat,
        "content".into(),
        "seed content".into(),
        None,
        None,
    )
    .await
    .unwrap();
    resp.id
}

/// Seed `n` drafts for distinct blocks.
async fn seed_drafts(pool: &SqlitePool, mat: &Materializer, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    for _ in 0..n {
        let id = create_block(pool, mat).await;
        save_draft(pool, &id, "draft content for background noise")
            .await
            .unwrap();
        ids.push(id);
    }
    ids
}

// ===========================================================================
// save_draft — INSERT OR REPLACE on every autosave tick
// ===========================================================================

fn bench_save_draft(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "save_draft"));
    let mat = rt.block_on(async { Materializer::new(pool.clone()) });
    let block_id = rt.block_on(create_block(&pool, &mat));

    let content = "a".repeat(200); // typical paragraph

    c.bench_function("save_draft", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let block_id = block_id.clone();
            let content = content.clone();
            async move {
                save_draft(&pool, &block_id, &content).await.unwrap();
            }
        })
    });

    rt.block_on(async { mat.shutdown() });
}

// ===========================================================================
// save_draft_if_changed — conditional write (skip when identical)
// ===========================================================================

fn bench_save_draft_if_changed_write(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "sdc_write"));
    let mat = rt.block_on(async { Materializer::new(pool.clone()) });
    let block_id = rt.block_on(create_block(&pool, &mat));

    let mut counter = 0u64;

    c.bench_function("save_draft_if_changed_write", |b| {
        b.to_async(&rt).iter(|| {
            counter += 1;
            let pool = pool.clone();
            let block_id = block_id.clone();
            let content = format!("version {counter} with some padding text here");
            async move {
                save_draft_if_changed(&pool, &block_id, &content)
                    .await
                    .unwrap();
            }
        })
    });

    rt.block_on(async { mat.shutdown() });
}

fn bench_save_draft_if_changed_skip(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "sdc_skip"));
    let mat = rt.block_on(async { Materializer::new(pool.clone()) });
    let block_id = rt.block_on(create_block(&pool, &mat));

    let content = "identical content on every call";
    rt.block_on(save_draft(&pool, &block_id, content)).unwrap();

    c.bench_function("save_draft_if_changed_skip", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let block_id = block_id.clone();
            async move {
                save_draft_if_changed(&pool, &block_id, content)
                    .await
                    .unwrap();
            }
        })
    });

    rt.block_on(async { mat.shutdown() });
}

// ===========================================================================
// flush_draft — write edit_block op + delete draft (transactional)
// ===========================================================================

fn bench_flush_draft(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "flush_draft"));
    let mat = rt.block_on(async { Materializer::new(pool.clone()) });
    let block_id = rt.block_on(create_block(&pool, &mat));

    let content = "b".repeat(200);

    // Measures save_draft + flush_draft together because criterion's async
    // `iter_batched` setup closure runs inside the runtime, preventing
    // `block_on` for per-iteration setup. Subtract the save_draft bench
    // (benchmarked separately above) for an approximation of flush cost alone.
    c.bench_function("flush_draft", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let block_id = block_id.clone();
            let content = content.clone();
            async move {
                save_draft(&pool, &block_id, &content).await.unwrap();
                flush_draft(&pool, "dev-bench", &block_id, &content, None)
                    .await
                    .unwrap();
            }
        })
    });

    rt.block_on(async { mat.shutdown() });
}

// ===========================================================================
// Parameterised: save_draft with N existing drafts in the table
// ===========================================================================

fn bench_save_draft_with_background_drafts(c: &mut Criterion) {
    let sizes: &[usize] = &[10, 100, 1000];

    let mut group = c.benchmark_group("save_draft_bg_drafts");
    for &n in sizes {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("bg_{n}")));
        let mat = rt.block_on(async { Materializer::new(pool.clone()) });

        // Seed N background drafts
        let target_id = rt.block_on(async {
            seed_drafts(&pool, &mat, n).await;
            create_block(&pool, &mat).await
        });

        let content = "target block draft content with padding";

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_drafts")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    async move {
                        save_draft(&pool, &target_id, content).await.unwrap();
                    }
                })
            },
        );

        rt.block_on(async { mat.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Parameterised: flush_draft with N existing drafts in the table
// ===========================================================================

fn bench_flush_draft_with_background_drafts(c: &mut Criterion) {
    let sizes: &[usize] = &[10, 100, 1000];

    let mut group = c.benchmark_group("flush_draft_bg_drafts");
    for &n in sizes {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("flush_bg_{n}")));
        let mat = rt.block_on(async { Materializer::new(pool.clone()) });

        let target_id = rt.block_on(async {
            seed_drafts(&pool, &mat, n).await;
            create_block(&pool, &mat).await
        });

        let content = "flush target content";

        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_drafts")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    async move {
                        save_draft(&pool, &target_id, content).await.unwrap();
                        flush_draft(&pool, "dev-bench", &target_id, content, None)
                            .await
                            .unwrap();
                    }
                })
            },
        );

        rt.block_on(async { mat.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    save_benches,
    bench_save_draft,
    bench_save_draft_if_changed_write,
    bench_save_draft_if_changed_skip,
);

criterion_group!(flush_benches, bench_flush_draft,);

criterion_group!(
    scale_benches,
    bench_save_draft_with_background_drafts,
    bench_flush_draft_with_background_drafts,
);

criterion_main!(save_benches, flush_benches, scale_benches);
