//! Criterion benchmarks for snapshot creation and application:
//!   1. `create_snapshot`  — snapshot creation at varying DB sizes (10, 100, 1000 blocks)
//!   2. `apply_snapshot`   — snapshot application to a fresh DB at varying sizes

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::create_block_inner;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::snapshot::{apply_snapshot, create_snapshot, get_latest_snapshot};

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_BENCH: &str = "dev-bench";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed `n` content blocks via `create_block_inner` (populates both `blocks`
/// and `op_log` tables for realistic DB state).
async fn seed_blocks(pool: &SqlitePool, materializer: &Materializer, n: usize) {
    for i in 0..n {
        create_block_inner(
            pool,
            DEV_BENCH,
            materializer,
            "content".into(),
            format!("Seeded block number {i} with some placeholder content for snapshot benchmarks."),
            None,
            Some(i as i64 + 1),
        )
        .await
        .unwrap();
    }
}

// ===========================================================================
// Benchmark 1: Snapshot creation at varying DB sizes
// ===========================================================================

/// Benchmark `create_snapshot` with N blocks in the DB (10, 100, 1000).
///
/// Pre-populates the database via `create_block_inner` so both `blocks` and
/// `op_log` tables contain realistic data.  Uses `Throughput::Elements(N)`
/// so Criterion reports blocks/sec.
fn bench_create_snapshot(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("create_snapshot");

    for n in [10u64, 100, 1000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("snap_create_{n}")));
        let materializer = Materializer::new(pool.clone());

        // Seed the DB with n blocks
        rt.block_on(seed_blocks(&pool, &materializer, n as usize));

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        create_snapshot(&pool, DEV_BENCH).await.unwrap();
                    }
                })
            },
        );
    }

    group.finish();
}

// ===========================================================================
// Benchmark 2: Snapshot application at varying sizes
// ===========================================================================

/// Benchmark `apply_snapshot` with snapshots captured from databases of
/// N blocks (10, 100, 1000).
///
/// For each size, a snapshot is created from a populated database, then the
/// benchmark applies that snapshot repeatedly.  `apply_snapshot` wipes all
/// core tables before inserting, so each iteration starts from a clean slate.
fn bench_apply_snapshot(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("apply_snapshot");

    for n in [10u64, 100, 1000] {
        let dir = TempDir::new().unwrap();

        // Create and populate a source DB, then capture a snapshot
        let source_pool = rt.block_on(fresh_pool(&dir, &format!("snap_src_{n}")));
        let materializer = Materializer::new(source_pool.clone());
        rt.block_on(seed_blocks(&source_pool, &materializer, n as usize));
        rt.block_on(create_snapshot(&source_pool, DEV_BENCH)).unwrap();

        // Retrieve the compressed snapshot data
        let (_snap_id, compressed) = rt
            .block_on(get_latest_snapshot(&source_pool))
            .unwrap()
            .expect("snapshot should exist after create_snapshot");

        // Target pool for applying the snapshot
        let target_pool = rt.block_on(fresh_pool(&dir, &format!("snap_tgt_{n}")));

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = target_pool.clone();
                    let data = compressed.clone();
                    async move {
                        apply_snapshot(&pool, &data).await.unwrap();
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

criterion_group!(snapshot_create_benches, bench_create_snapshot);
criterion_group!(snapshot_apply_benches, bench_apply_snapshot);
criterion_main!(snapshot_create_benches, snapshot_apply_benches);
