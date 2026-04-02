//! Criterion benchmarks for sync protocol hot-path functions:
//!   - `get_local_heads`     — per-device head query
//!   - `compute_ops_to_send` — delta computation against remote heads

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::db::init_pool;
use agaric_lib::sync_protocol::{compute_ops_to_send, get_local_heads, DeviceHead};

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

/// Seed op_log with `n` ops from a single device.
async fn seed_ops(pool: &SqlitePool, device_id: &str, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let hash = format!("hash_{device_id}_{i}");
        let ts = format!("2025-01-15T12:00:00.{i:06}+00:00");
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, 'create_block', ?, ?)",
        )
        .bind(device_id)
        .bind(i as i64 + 1)
        .bind(&hash)
        .bind(format!(
            r#"{{"block_id":"BLK{i:020}","block_type":"content","content":"op {i}"}}"#,
        ))
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

// ---------------------------------------------------------------------------
// get_local_heads
// ---------------------------------------------------------------------------

fn bench_get_local_heads(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("get_local_heads");

    for num_ops in [100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("heads_{num_ops}")));
        rt.block_on(seed_ops(&pool, "device-a", num_ops));
        rt.block_on(seed_ops(&pool, "device-b", num_ops / 10));

        group.bench_with_input(BenchmarkId::from_parameter(num_ops), &num_ops, |b, _| {
            b.to_async(&rt).iter(|| get_local_heads(&pool));
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// compute_ops_to_send
// ---------------------------------------------------------------------------

fn bench_compute_ops_to_send(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("compute_ops_to_send");

    for num_ops in [100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("delta_{num_ops}")));
        rt.block_on(seed_ops(&pool, "device-local", num_ops));

        // Remote knows about half our ops
        let remote_heads = vec![DeviceHead {
            device_id: "device-local".into(),
            seq: (num_ops / 2) as i64,
            hash: format!("hash_device-local_{}", num_ops / 2 - 1),
        }];

        group.bench_with_input(BenchmarkId::from_parameter(num_ops), &num_ops, |b, _| {
            let rh = remote_heads.clone();
            b.to_async(&rt).iter(|| compute_ops_to_send(&pool, &rh));
        });
    }
    group.finish();
}

criterion_group!(benches, bench_get_local_heads, bench_compute_ops_to_send);
criterion_main!(benches);
