//! Criterion benchmarks for the page-alias subsystem:
//!   1. `set_page_aliases_inner`     — replace all aliases for a page
//!   2. `get_page_aliases_inner`     — read aliases for a single page
//!   3. `resolve_page_by_alias_inner` — look up a page by one alias

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{
    get_page_aliases_inner, resolve_page_by_alias_inner, set_page_aliases_inner,
};
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

/// Seed `n` page blocks via direct SQL and assign 3 aliases per page.
///
/// Returns the list of page IDs that were created.
async fn seed_pages_with_aliases(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();

    for i in 0..n {
        let id = format!("PAGE{i:020}");
        let title = format!("Bench Page {i}");

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'page', ?, ?)",
        )
        .bind(&id)
        .bind(&title)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();

        // 3 aliases per page
        for j in 0..3 {
            let alias = format!("alias-{i}-{j}");
            sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
                .bind(&id)
                .bind(&alias)
                .execute(&mut *tx)
                .await
                .unwrap();
        }

        ids.push(id);
    }

    tx.commit().await.unwrap();
    ids
}

/// Seed `n` page blocks without aliases (for set_page_aliases benchmark).
async fn seed_pages_bare(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();

    for i in 0..n {
        let id = format!("PAGE{i:020}");
        let title = format!("Bench Page {i}");

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'page', ?, ?)",
        )
        .bind(&id)
        .bind(&title)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();

        ids.push(id);
    }

    tx.commit().await.unwrap();
    ids
}

// ===========================================================================
// bench_set_page_aliases — parameterized by number of pages
// ===========================================================================

fn bench_set_page_aliases(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("set_page_aliases");

    for n_pages in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("set_alias_{n_pages}")));
        let ids = rt.block_on(seed_pages_bare(&pool, n_pages));

        group.throughput(Throughput::Elements(n_pages as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_pages}_pages")),
            &n_pages,
            |b, _| {
                // Pick the last page so we're not always hitting the same row cache
                let target_id = ids[n_pages - 1].clone();
                let aliases = vec![
                    "bench-a".to_string(),
                    "bench-b".to_string(),
                    "bench-c".to_string(),
                ];

                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    let aliases = aliases.clone();
                    async move {
                        set_page_aliases_inner(&pool, &target_id, aliases)
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
// bench_get_page_aliases — parameterized by number of pages
// ===========================================================================

fn bench_get_page_aliases(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("get_page_aliases");

    for n_pages in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("get_alias_{n_pages}")));
        let ids = rt.block_on(seed_pages_with_aliases(&pool, n_pages));

        group.throughput(Throughput::Elements(n_pages as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_pages}_pages")),
            &n_pages,
            |b, _| {
                let target_id = ids[n_pages / 2].clone(); // middle page

                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_id = target_id.clone();
                    async move { get_page_aliases_inner(&pool, &target_id).await.unwrap() }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// bench_resolve_page_by_alias — parameterized by total aliases
// ===========================================================================

fn bench_resolve_page_by_alias(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("resolve_page_by_alias");

    // 3 aliases per page, so n_pages = total_aliases / 3
    for total_aliases in [100, 1_000, 10_000] {
        let n_pages = total_aliases / 3;
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("resolve_{total_aliases}")));
        rt.block_on(seed_pages_with_aliases(&pool, n_pages));

        // Pick an alias in the middle of the dataset
        let target_alias = format!("alias-{}-1", n_pages / 2);

        group.throughput(Throughput::Elements(total_aliases as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{total_aliases}_aliases")),
            &total_aliases,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let alias = target_alias.clone();
                    async move { resolve_page_by_alias_inner(&pool, &alias).await.unwrap() }
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
    alias_benches,
    bench_set_page_aliases,
    bench_get_page_aliases,
    bench_resolve_page_by_alias,
);

criterion_main!(alias_benches);
