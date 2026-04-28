// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for property and task-state commands:
//!   1. `set_property_inner`
//!   2. `get_properties_inner`
//!   3. `delete_property_inner`
//!   4. `set_todo_state_inner`
//!   5. `set_priority_inner`
//!   6. `set_due_date_inner`
//!   7. `set_scheduled_date_inner`

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{
    delete_property_inner, get_properties_inner, set_due_date_inner, set_priority_inner,
    set_property_inner, set_scheduled_date_inner, set_todo_state_inner,
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
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Bulk-seed `n` blocks directly via SQL in a single transaction.
///
/// Much faster than going through `create_block_inner` — suitable for 10K+
/// DB sizes where seeding cost would dominate benchmark setup.
async fn seed_blocks_bulk(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("PROP{i:020}");
        let content = format!("Property bench block {i}");
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
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

/// Seed 3 properties per block directly via SQL.
async fn seed_properties(pool: &SqlitePool, ids: &[String]) {
    let mut tx = pool.begin().await.unwrap();
    for id in ids {
        for key in &["custom_a", "custom_b", "custom_c"] {
            sqlx::query(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
                 VALUES (?, ?, ?)",
            )
            .bind(id)
            .bind(key)
            .bind("bench_value")
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();
}

// ===========================================================================
// 1. set_property benchmarks
// ===========================================================================

fn bench_set_property(c: &mut Criterion) {
    let mut group = c.benchmark_group("set_property");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("set_prop_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        set_property_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            "custom_field".to_string(),
                            Some("value".to_string()),
                            None,
                            None,
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

// ===========================================================================
// 2. get_properties benchmarks
// ===========================================================================

fn bench_get_properties(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_properties");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("get_prop_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        rt.block_on(seed_properties(&pool, &ids));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    async move { get_properties_inner(&pool, target_id).await.unwrap() }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// 3. delete_property benchmarks
// ===========================================================================

fn bench_delete_property(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_property");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("del_prop_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));

        // Seed a deletable property on every block
        rt.block_on(async {
            let mut tx = pool.begin().await.unwrap();
            for id in &ids {
                sqlx::query(
                    "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
                     VALUES (?, 'deletable', 'val')",
                )
                .bind(id)
                .execute(&mut *tx)
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();
        });

        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter_custom(|iters| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        let start = std::time::Instant::now();
                        for _ in 0..iters {
                            // Re-insert so there is something to delete
                            sqlx::query(
                                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
                                 VALUES (?, 'deletable', 'val')",
                            )
                            .bind(&target_id)
                            .execute(&pool)
                            .await
                            .unwrap();

                            delete_property_inner(
                                &pool,
                                "dev-bench",
                                materializer_ref,
                                target_id.clone(),
                                "deletable".to_string(),
                            )
                            .await
                            .unwrap();
                        }
                        start.elapsed()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// 4. set_todo_state benchmarks
// ===========================================================================

fn bench_set_todo_state(c: &mut Criterion) {
    let mut group = c.benchmark_group("set_todo_state");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("todo_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        set_todo_state_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            Some("TODO".to_string()),
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

// ===========================================================================
// 5. set_priority benchmarks
// ===========================================================================

fn bench_set_priority(c: &mut Criterion) {
    let mut group = c.benchmark_group("set_priority");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("prio_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        set_priority_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            Some("1".to_string()),
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

// ===========================================================================
// 6. set_due_date benchmarks
// ===========================================================================

fn bench_set_due_date(c: &mut Criterion) {
    let mut group = c.benchmark_group("set_due_date");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("due_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        set_due_date_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            Some("2025-12-31".to_string()),
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

// ===========================================================================
// 7. set_scheduled_date benchmarks
// ===========================================================================

fn bench_set_scheduled_date(c: &mut Criterion) {
    let mut group = c.benchmark_group("set_scheduled_date");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("sched_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));
        let target_id = ids[size / 2].clone();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let target_id = target_id.clone();
                    async move {
                        set_scheduled_date_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            target_id,
                            Some("2025-12-31".to_string()),
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

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    benches,
    bench_set_property,
    bench_get_properties,
    bench_delete_property,
    bench_set_todo_state,
    bench_set_priority,
    bench_set_due_date,
    bench_set_scheduled_date,
);
criterion_main!(benches);
