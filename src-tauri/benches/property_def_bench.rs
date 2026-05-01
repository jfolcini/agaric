//! Criterion benchmarks for property-definition CRUD operations.
//!
//! Benches:
//!   1. `create_property_def`          — create a new definition
//!   2. `list_property_defs`           — list all definitions
//!   3. `update_property_def_options`  — update options on a select-type def
//!   4. `delete_property_def`          — delete a definition (re-insert between iterations)

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{
    create_property_def_inner, delete_property_def_inner, list_property_defs_inner,
    update_property_def_options_inner,
};
use agaric_lib::db::init_pool;

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

/// Seed N property definitions via direct SQL for speed.
/// Keys are `bench_prop_000`, `bench_prop_001`, etc.
/// All are select-type with a default options array.
async fn seed_property_defs(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut keys = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let key = format!("bench-prop-{i:06}");
        sqlx::query(
            "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) \
             VALUES (?, 'select', '[\"a\",\"b\",\"c\"]', '2026-01-01T00:00:00.000Z')",
        )
        .bind(&key)
        .execute(&mut *tx)
        .await
        .unwrap();
        keys.push(key);
    }
    tx.commit().await.unwrap();
    keys
}

// ===========================================================================
// 1. bench_create_property_def — create a unique key each iteration
// ===========================================================================

fn bench_create_property_def(c: &mut Criterion) {
    let mut group = c.benchmark_group("create_property_def");

    for existing_count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("create_pd_{existing_count}")));

        // Seed existing definitions
        rt.block_on(seed_property_defs(&pool, existing_count));

        let mut counter = 0u64;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{existing_count}_defs")),
            &existing_count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    counter += 1;
                    let pool = pool.clone();
                    async move {
                        create_property_def_inner(
                            &pool,
                            format!("new-key-{counter}"),
                            "text".into(),
                            None,
                        )
                        .await
                        .unwrap();
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// 2. bench_list_property_defs — list all definitions
// ===========================================================================

fn bench_list_property_defs(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_property_defs");

    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("list_pd_{count}")));

        rt.block_on(seed_property_defs(&pool, count));

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        // M-85: returns a `PageResponse<T>`; the bench
                        // intentionally consumes only the first page —
                        // pagination cost is constant per page and the
                        // throughput metric tracks one page worth of work.
                        let page = list_property_defs_inner(&pool, None, Some(200))
                            .await
                            .unwrap();
                        // count seeded + any built-in defs from migrations
                        assert!(page.items.len() >= count);
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// 3. bench_update_property_def_options — update options on one select-type def
// ===========================================================================

fn bench_update_property_def_options(c: &mut Criterion) {
    let mut group = c.benchmark_group("update_property_def_options");

    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("upd_pd_{count}")));

        let keys = rt.block_on(seed_property_defs(&pool, count));
        let target_key = keys[count / 2].clone();

        let mut counter = 0u64;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    counter += 1;
                    let pool = pool.clone();
                    let target_key = target_key.clone();
                    async move {
                        update_property_def_options_inner(
                            &pool,
                            target_key,
                            format!("[\"opt_{counter}\",\"x\",\"y\"]"),
                        )
                        .await
                        .unwrap();
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// 4. bench_delete_property_def — delete one def per iteration
//    Uses iter_custom to re-insert between iterations.
// ===========================================================================

fn bench_delete_property_def(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_property_def");

    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("del_pd_{count}")));

        rt.block_on(seed_property_defs(&pool, count));

        let target_key = "deletable-key".to_string();

        // Seed the deletable key
        rt.block_on(async {
            sqlx::query(
                "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) \
                 VALUES (?, 'text', NULL, '2026-01-01T00:00:00.000Z')",
            )
            .bind(&target_key)
            .execute(&pool)
            .await
            .unwrap();
        });

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter_custom(|iters| {
                    let pool = pool.clone();
                    let target_key = target_key.clone();
                    async move {
                        let start = std::time::Instant::now();
                        for _ in 0..iters {
                            // Re-insert so there is something to delete
                            sqlx::query(
                                "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) \
                                 VALUES (?, 'text', NULL, '2026-01-01T00:00:00.000Z')",
                            )
                            .bind(&target_key)
                            .execute(&pool)
                            .await
                            .unwrap();

                            delete_property_def_inner(&pool, target_key.clone())
                                .await
                                .unwrap();
                        }
                        start.elapsed()
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

criterion_group!(
    property_def_benches,
    bench_create_property_def,
    bench_list_property_defs,
    bench_update_property_def_options,
    bench_delete_property_def,
);

criterion_main!(property_def_benches);
