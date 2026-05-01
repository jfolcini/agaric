// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for the three agenda command inner functions:
//!   1. `count_agenda_batch_inner`        — weekly badge counts
//!   2. `count_agenda_batch_by_source_inner` — per-source badge counts
//!   3. `list_projected_agenda_inner`     — repeating-task projection

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{
    count_agenda_batch_by_source_inner, count_agenda_batch_inner, list_projected_agenda_inner,
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

/// Seed `n` blocks with agenda_cache entries spread across 30 days starting
/// 2025-07-01.  Each block gets a due_date on the blocks table and a matching
/// row in `agenda_cache` so that `count_agenda_batch*` queries find them.
async fn seed_agenda_blocks(pool: &SqlitePool, n: usize) {
    let base_date = chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("AGENDA{i:020}");
        let date = base_date + chrono::Duration::days((i % 30) as i64);
        let date_str = date.format("%Y-%m-%d").to_string();

        // Insert block with due_date set
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, due_date) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&id)
        .bind(format!("Task {i}"))
        .bind(i as i64 + 1)
        .bind(&date_str)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Insert agenda_cache entry (materializer normally does this)
        sqlx::query(
            "INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, 'property:due_date')",
        )
        .bind(&date_str)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` blocks with repeating-task properties for
/// `list_projected_agenda_inner`.
///
/// Each block gets:
/// - `due_date` on the blocks table (cycling through 30 days from 2025-07-01)
/// - `todo_state = 'TODO'`
/// - A `repeat` property in `block_properties` (e.g. `every 1 week`)
async fn seed_repeating_blocks(pool: &SqlitePool, n: usize) {
    let base_date = chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("REPAG{i:020}");
        let date = base_date + chrono::Duration::days((i % 30) as i64);
        let date_str = date.format("%Y-%m-%d").to_string();

        // Insert block with due_date and todo_state
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, due_date, todo_state) \
             VALUES (?, 'content', ?, ?, ?, 'TODO')",
        )
        .bind(&id)
        .bind(format!("Repeating task {i}"))
        .bind(i as i64 + 1)
        .bind(&date_str)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Insert repeat property
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'repeat', 'every 1 week')",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

// ===========================================================================
// count_agenda_batch benchmarks
// ===========================================================================

fn bench_count_agenda_batch(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_agenda_batch");

    // 7 dates simulating a weekly view
    let dates: Vec<String> = (0..7)
        .map(|d| {
            let date =
                chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap() + chrono::Duration::days(d);
            date.format("%Y-%m-%d").to_string()
        })
        .collect();

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("agenda_batch_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        rt.block_on(seed_agenda_blocks(&pool, size));

        group.throughput(Throughput::Elements(size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let dates = dates.clone();
                    async move { count_agenda_batch_inner(&pool, dates, None).await.unwrap() }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// count_agenda_batch_by_source benchmarks
// ===========================================================================

fn bench_count_agenda_batch_by_source(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_agenda_batch_by_source");

    let dates: Vec<String> = (0..7)
        .map(|d| {
            let date =
                chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap() + chrono::Duration::days(d);
            date.format("%Y-%m-%d").to_string()
        })
        .collect();

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("agenda_src_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        rt.block_on(seed_agenda_blocks(&pool, size));

        group.throughput(Throughput::Elements(size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let dates = dates.clone();
                    async move {
                        count_agenda_batch_by_source_inner(&pool, dates, None)
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
// list_projected_agenda benchmarks
// ===========================================================================

fn bench_list_projected_agenda(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_projected_agenda");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("agenda_proj_{size}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        rt.block_on(seed_repeating_blocks(&pool, size));

        group.throughput(Throughput::Elements(size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        list_projected_agenda_inner(
                            &pool,
                            "2025-07-01".into(),
                            "2025-07-07".into(),
                            None,
                            Some(200),
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
// Harness
// ===========================================================================

criterion_group!(
    benches,
    bench_count_agenda_batch,
    bench_count_agenda_batch_by_source,
    bench_list_projected_agenda,
);

criterion_main!(benches);
