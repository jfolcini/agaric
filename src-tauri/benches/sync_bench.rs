//! Criterion benchmarks for sync protocol hot-path functions:
//!   - `get_local_heads`     — per-device head query
//!   - `compute_ops_to_send` — delta computation against remote heads

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::commands::{
    delete_peer_ref_inner, list_peer_refs_inner, set_peer_address_inner, update_peer_name_inner,
};
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

criterion_group!(
    benches,
    bench_get_local_heads,
    bench_compute_ops_to_send,
    bench_list_peer_refs,
    bench_delete_peer_ref,
    bench_update_peer_name,
    bench_set_peer_address,
);
criterion_main!(benches);

// ---------------------------------------------------------------------------
// Peer-ref helpers
// ---------------------------------------------------------------------------

/// Seed `n` peer_refs via direct SQL.
async fn seed_peer_refs(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let peer_id = format!("peer-{i:06}");
        let ts = format!("2025-01-15T12:00:00.{i:06}+00:00");
        sqlx::query(
            "INSERT INTO peer_refs (peer_id, last_hash, last_sent_hash, synced_at, reset_count, last_reset_at, cert_hash, device_name, last_address) \
             VALUES (?, ?, NULL, ?, 0, NULL, NULL, ?, ?)",
        )
        .bind(&peer_id)
        .bind(format!("hash_{i}"))
        .bind(&ts)
        .bind(format!("Device {i}"))
        .bind(format!("192.168.1.{i}:{}", 8000 + i))
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

// ---------------------------------------------------------------------------
// bench_list_peer_refs
// ---------------------------------------------------------------------------

fn bench_list_peer_refs(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_peer_refs");

    for num_peers in [10, 50, 100] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("list_peers_{num_peers}")));
        rt.block_on(seed_peer_refs(&pool, num_peers));

        group.bench_with_input(
            BenchmarkId::from_parameter(num_peers),
            &num_peers,
            |b, _| {
                b.to_async(&rt).iter(|| list_peer_refs_inner(&pool));
            },
        );
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// bench_delete_peer_ref
// ---------------------------------------------------------------------------

fn bench_delete_peer_ref(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "delete_peer"));
    rt.block_on(seed_peer_refs(&pool, 100));

    // We'll delete peer-000050 each iteration, re-inserting it between iterations.
    let target_peer = "peer-000050".to_string();

    c.bench_function("delete_peer_ref", |b| {
        b.iter_custom(|iters| {
            let start = std::time::Instant::now();
            for _ in 0..iters {
                // Delete
                rt.block_on(async {
                    delete_peer_ref_inner(&pool, target_peer.clone())
                        .await
                        .unwrap();
                });
                // Re-insert for next iteration
                rt.block_on(async {
                    sqlx::query(
                        "INSERT INTO peer_refs (peer_id, last_hash, last_sent_hash, synced_at, reset_count, last_reset_at, cert_hash, device_name, last_address) \
                         VALUES (?, 'hash_50', NULL, '2025-01-15T12:00:00.000050+00:00', 0, NULL, NULL, 'Device 50', '192.168.1.50:8050')",
                    )
                    .bind(&target_peer)
                    .execute(&pool)
                    .await
                    .unwrap();
                });
            }
            start.elapsed()
        });
    });
}

// ---------------------------------------------------------------------------
// bench_update_peer_name
// ---------------------------------------------------------------------------

fn bench_update_peer_name(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("update_peer_name");

    for num_peers in [10, 50, 100] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("update_name_{num_peers}")));
        rt.block_on(seed_peer_refs(&pool, num_peers));

        let target_peer = "peer-000000".to_string();

        group.bench_with_input(
            BenchmarkId::from_parameter(num_peers),
            &num_peers,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let peer_id = target_peer.clone();
                    async move {
                        update_peer_name_inner(&pool, peer_id, Some("New Name".to_string()))
                            .await
                            .unwrap()
                    }
                });
            },
        );
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// bench_set_peer_address
// ---------------------------------------------------------------------------

fn bench_set_peer_address(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("set_peer_address");

    for num_peers in [10, 50, 100] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("set_addr_{num_peers}")));
        rt.block_on(seed_peer_refs(&pool, num_peers));

        let target_peer = "peer-000000".to_string();

        group.bench_with_input(
            BenchmarkId::from_parameter(num_peers),
            &num_peers,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let peer_id = target_peer.clone();
                    async move {
                        set_peer_address_inner(&pool, peer_id, "10.0.0.1:9090".to_string())
                            .await
                            .unwrap()
                    }
                });
            },
        );
    }
    group.finish();
}
