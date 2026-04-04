//! Criterion benchmarks for `move_block_inner`.
//!
//! The command uses transactions with cycle detection CTEs and sibling
//! position shifts, making it non-trivial under load.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::commands::move_block_inner;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;

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

/// Seed two parent blocks and `n` children under PARENT_A.
async fn seed_move_data(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut tx = pool.begin().await.unwrap();

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('PARENT_A', 'content', 'Parent A')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('PARENT_B', 'content', 'Parent B')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        let id = format!("CHILD{i:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, 'PARENT_A', ?)",
        )
        .bind(&id)
        .bind(format!("Child block {i}"))
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

// ---------------------------------------------------------------------------
// move_block benchmarks
// ---------------------------------------------------------------------------

fn bench_move_block(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("move_block");
    group.sample_size(100);

    for count in [10, 100, 1_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("move_{count}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let children = rt.block_on(seed_move_data(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            let child = children[0].clone();
            b.to_async(&rt).iter(|| {
                let pool = pool.clone();
                let mat = materializer.clone();
                let child = child.clone();
                async move {
                    // Move first child to PARENT_B, then back
                    move_block_inner(
                        &pool,
                        "dev-bench",
                        &mat,
                        child.clone(),
                        Some("PARENT_B".into()),
                        1,
                    )
                    .await
                    .unwrap();
                    move_block_inner(&pool, "dev-bench", &mat, child, Some("PARENT_A".into()), 1)
                        .await
                        .unwrap();
                }
            });
        });

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

criterion_group!(benches, bench_move_block);
criterion_main!(benches);
