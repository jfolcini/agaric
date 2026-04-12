// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmark for Markdown export:
//!   - `export_page_markdown_inner` — serialize a page with N child blocks

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::export_page_markdown_inner;
use agaric_lib::db::init_pool;

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

/// Seed a single page block with `n` child content blocks of varying length.
///
/// Children alternate between short (~50 chars) and long (~200 chars) content
/// to simulate realistic page bodies.
async fn seed_page_with_children(pool: &SqlitePool, n: usize) {
    let page_id = "EXPORTPAGE0000000000000";
    let mut tx = pool.begin().await.unwrap();

    // Parent page
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES (?, 'page', 'Benchmark Export Page', 1)",
    )
    .bind(page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("CHILD{i:018}");
        let content = if i % 2 == 0 {
            format!("Short content block number {i} with a few words.")
        } else {
            format!(
                "Longer content block number {i}: Lorem ipsum dolor sit amet, \
                 consectetur adipiscing elit. Sed do eiusmod tempor incididunt \
                 ut labore et dolore magna aliqua. Ut enim ad minim veniam, \
                 quis nostrud exercitation ullamco laboris."
            )
        };

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(page_id)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();
}

// ===========================================================================
// bench_export_page_markdown — parameterized by blocks per page
// ===========================================================================

fn bench_export_page_markdown(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("export_page_markdown");

    for n_blocks in [100, 500, 2_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("export_{n_blocks}")));
        rt.block_on(seed_page_with_children(&pool, n_blocks));

        group.throughput(Throughput::Elements(n_blocks as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_blocks}_blocks")),
            &n_blocks,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        export_page_markdown_inner(&pool, "EXPORTPAGE0000000000000")
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
// Harness
// ===========================================================================

criterion_group!(export_benches, bench_export_page_markdown,);

criterion_main!(export_benches);
