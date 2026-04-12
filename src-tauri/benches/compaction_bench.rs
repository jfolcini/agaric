// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for op log compaction (F-20):
//!   1. `get_compaction_status` — query op log statistics at varying table sizes
//!   2. `compact_op_log`        — full compaction (snapshot + purge) at varying sizes

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{compact_op_log_cmd_inner, get_compaction_status_inner};
use agaric_lib::db::init_pool;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BENCH_DEVICE: &str = "dev-bench";

/// A deliberately old timestamp that will always be older than any retention
/// cutoff (even `retention_days=0` uses `Utc::now()` as the cutoff).
const OLD_TIMESTAMP: &str = "2020-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed `n` ops into op_log via raw SQL with an old `created_at` timestamp
/// so they are all eligible for compaction.
async fn seed_old_ops(pool: &SqlitePool, n: usize) {
    // Batch in groups of 500 for performance
    let batch_size = 500;
    let mut i = 0usize;
    while i < n {
        let end = (i + batch_size).min(n);
        let mut tx = pool.begin().await.unwrap();
        for j in i..end {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
            )
            .bind(BENCH_DEVICE)
            .bind(j as i64 + 1)
            .bind(format!(
                r#"{{"block_id":"BENCH{j:06}","block_type":"content","parent_id":null,"position":{pos},"content":"seed"}}"#,
                pos = j + 1,
            ))
            .bind(OLD_TIMESTAMP)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        i = end;
    }
}

// ===========================================================================
// get_compaction_status — query op log statistics
// ===========================================================================

fn bench_get_compaction_status(c: &mut Criterion) {
    let sizes: &[usize] = &[1_000, 10_000, 100_000];

    let mut group = c.benchmark_group("get_compaction_status");
    for &n in sizes {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("status_{n}")));

        // Seed N ops
        rt.block_on(seed_old_ops(&pool, n));

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_ops")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        get_compaction_status_inner(&pool).await.unwrap();
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// compact_op_log — full compaction (snapshot + purge), destructive
// ===========================================================================

fn bench_compact_op_log(c: &mut Criterion) {
    let sizes: &[usize] = &[1_000, 10_000, 100_000];

    let mut group = c.benchmark_group("compact_op_log");
    // Compaction is slow at large sizes; keep sample size reasonable
    group.sample_size(10);

    for &n in sizes {
        let rt = Runtime::new().unwrap();

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_ops")),
            &n,
            |b, _| {
                b.to_async(&rt).iter_custom(|iters| async move {
                    let mut total = std::time::Duration::ZERO;
                    for _ in 0..iters {
                        // Fresh DB per iteration because compaction is destructive
                        let dir = TempDir::new().unwrap();
                        let pool = fresh_pool(&dir, "compact").await;
                        seed_old_ops(&pool, n).await;

                        let start = std::time::Instant::now();
                        compact_op_log_cmd_inner(&pool, BENCH_DEVICE, 0)
                            .await
                            .unwrap();
                        total += start.elapsed();

                        pool.close().await;
                    }
                    total
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(status_benches, bench_get_compaction_status);
criterion_group!(compact_benches, bench_compact_op_log);
criterion_main!(status_benches, compact_benches);
