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
//!   8. an advanced-query property filter over list rows

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group};

use agaric_lib::commands::{
    delete_property_inner, get_properties_inner, set_due_date_inner, set_priority_inner,
    set_property_inner, set_scheduled_date_inner, set_todo_state_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_store::filters::FilterExpr;
use agaric_store::filters::primitive::{FilterPrimitive, PropertyPredicate, PropertyValue};
use agaric_store::query::{AdvancedQueryRequest, compile_and_run};

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

    // Size axis = total block count, which scales with the vault, so this
    // sweeps to the realistic 100K-block ceiling (#1231). `seed_properties`
    // puts a handful (3) of props per block — property cost grows with the
    // number of property-bearing blocks, not with props-per-block.
    for size in [100, 1_000, 10_000, 100_000] {
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
                            target_id.into(),
                            "custom_field".to_string(),
                            Some("value".to_string()),
                            None,
                            None,
                            None,
                            None,
                            None,
                        )
                        .await
                        .unwrap()
                    }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                    async move { get_properties_inner(&pool, target_id.into()).await.unwrap() }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                                target_id.clone().into(),
                                "deletable".to_string(),
                            )
                            .await
                            .unwrap();
                        }
                        start.elapsed()
                    }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                            target_id.into(),
                            Some("TODO".to_string()),
                        )
                        .await
                        .unwrap()
                    }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                            target_id.into(),
                            Some("1".to_string()),
                        )
                        .await
                        .unwrap()
                    }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                            target_id.into(),
                            Some("2025-12-31".to_string()),
                        )
                        .await
                        .unwrap()
                    }
                });
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

    // 100K = vault-scale ceiling (#1231); see `bench_set_property`.
    for size in [100, 1_000, 10_000, 100_000] {
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
                            target_id.into(),
                            Some("2025-12-31".to_string()),
                        )
                        .await
                        .unwrap()
                    }
                });
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// 8. A property filter over list rows (#6741)
// ===========================================================================

const FILTER_SPACE: &str = "01BENCHSPACE00000000000000";
const FILTER_BLOCKS: usize = 100_000;
const FILTER_HOLDERS: usize = 20_000;

/// `FILTER_BLOCKS` blocks in one space: the first `FILTER_HOLDERS` hold the
/// text `status = v{i % 100}`, the next `FILTER_HOLDERS` the list
/// `authors = [v{i % 100}, w{i % 50}]`, so `v7` is held by 200 of each.
async fn seed_filter_vault(pool: &SqlitePool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'space', ?)",
    )
    .bind(FILTER_SPACE)
    .bind(FILTER_SPACE)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(FILTER_SPACE)
        .execute(&mut *tx)
        .await
        .unwrap();
    for i in 0..FILTER_BLOCKS {
        let id = format!("FILT{i:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, space_id) \
             VALUES (?, 'content', 'filter bench block', ?, ?)",
        )
        .bind(&id)
        .bind(i as i64 + 1)
        .bind(FILTER_SPACE)
        .execute(&mut *tx)
        .await
        .unwrap();
        let (key, column, value) = if i < FILTER_HOLDERS {
            ("status", "value_text", format!("v{}", i % 100))
        } else if i < 2 * FILTER_HOLDERS {
            let list = format!(r#"["v{}","w{}"]"#, i % 100, i % 50);
            ("authors", "value_list", list)
        } else {
            continue;
        };
        let sql =
            format!("INSERT INTO block_properties (block_id, key, {column}) VALUES (?, ?, ?)");
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(&id)
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

/// The advanced query's `key = v7`, first page with its total count.
fn eq_v7_request(key: &str) -> AdvancedQueryRequest {
    AdvancedQueryRequest {
        space_id: FILTER_SPACE.to_string(),
        filter: FilterExpr::leaf(FilterPrimitive::HasProperty {
            key: key.to_string(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "v7".to_string(),
                },
            },
        }),
        sort: Vec::new(),
        cursor: None,
        limit: None,
        fulltext: None,
        group_by: None,
        aggregates: Vec::new(),
    }
}

/// An Eq filter over 20,000 list rows next to the same filter over 20,000
/// text rows, in a 100,000-block space: the list matches through
/// `json_each`, the text by its column.
fn bench_property_filter_list(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "filter_list"));
    rt.block_on(seed_filter_vault(&pool));
    // Shape probe: each key matches its 200 holders of `v7`.
    for key in ["status", "authors"] {
        let resp = rt
            .block_on(compile_and_run(&pool, eq_v7_request(key)))
            .unwrap();
        assert_eq!(resp.total_count, Some(200), "{key} = v7 matches 200 blocks");
    }

    let mut group = c.benchmark_group("property_filter_list");
    for (label, key) in [("text_eq", "status"), ("list_eq", "authors")] {
        group.bench_function(BenchmarkId::new(label, FILTER_BLOCKS), |b| {
            b.to_async(&rt)
                .iter(|| async { compile_and_run(&pool, eq_v7_request(key)).await.unwrap() });
        });
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
    bench_property_filter_list,
);
