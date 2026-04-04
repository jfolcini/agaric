use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::db::init_pool;
use agaric_lib::fts::{fts_optimize, rebuild_fts_index, search_fts, update_fts_for_block};
use agaric_lib::pagination::PageRequest;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/// Generate varied content for block `i`.
///
/// Every 10th block includes the word "benchmark" so search queries on that
/// term match ~10 % of the corpus.
fn make_content(i: usize) -> String {
    let extra = if i.is_multiple_of(10) {
        " benchmark"
    } else {
        ""
    };
    format!(
        "The quick brown fox {i} jumped over the lazy dog {}{extra}",
        i % 100
    )
}

/// Insert `count` blocks into the `blocks` table with varied content.
async fn seed_blocks(pool: &SqlitePool, count: usize) {
    for i in 0..count {
        let id = format!("FTS{i:022}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(make_content(i))
            .execute(pool)
            .await
            .unwrap();
    }
}

/// Seed blocks **and** populate the FTS index via `rebuild_fts_index`.
async fn seed_blocks_with_fts(pool: &SqlitePool, count: usize) {
    seed_blocks(pool, count).await;
    rebuild_fts_index(pool).await.unwrap();
}

/// Seed blocks **and** index each one individually via `update_fts_for_block`.
async fn seed_blocks_with_fts_incremental(pool: &SqlitePool, count: usize) {
    for i in 0..count {
        let id = format!("FTS{i:022}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(make_content(i))
            .execute(pool)
            .await
            .unwrap();
        update_fts_for_block(pool, &id).await.unwrap();
    }
}

// ---------------------------------------------------------------------------
// Helper: create a temporary pool
// ---------------------------------------------------------------------------

fn make_pool(rt: &Runtime, dir: &TempDir) -> SqlitePool {
    rt.block_on(async { init_pool(&dir.path().join("bench.db")).await.unwrap() })
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/// Benchmark `search_fts` — query matches ~10 % of blocks ("benchmark").
fn bench_search_fts(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("search_fts");

    let page = PageRequest {
        after: None,
        limit: 20,
    };

    for count in [1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        rt.block_on(seed_blocks_with_fts(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| search_fts(&pool, "benchmark", &page));
        });
    }
    group.finish();
}

/// Benchmark `rebuild_fts_index` — full reindex.
fn bench_rebuild_fts_index(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("rebuild_fts_index");

    for count in [1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        // Only seed blocks; the benchmark itself does the rebuild.
        rt.block_on(seed_blocks(&pool, count));

        group.throughput(Throughput::Elements(count as u64));
        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| rebuild_fts_index(&pool));
        });
    }
    group.finish();
}

/// Benchmark `update_fts_for_block` — single block insert/update.
fn bench_update_fts_for_block(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("update_fts_for_block");

    for count in [1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        // Seed all blocks (with FTS index) so subsequent updates are realistic.
        rt.block_on(seed_blocks_with_fts(&pool, count));

        // We always update the same block; the benchmark measures steady-state cost.
        let target_id = "FTS0000000000000000000000";

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| update_fts_for_block(&pool, target_id));
        });
    }
    group.finish();
}

/// Benchmark `fts_optimize` after N incremental edits.
fn bench_fts_optimize(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("fts_optimize");

    for edits in [1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        // Seed via incremental inserts to create many FTS segments.
        rt.block_on(seed_blocks_with_fts_incremental(&pool, edits));

        group.bench_with_input(BenchmarkId::from_parameter(edits), &edits, |b, _| {
            b.to_async(&rt).iter(|| fts_optimize(&pool));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_search_fts,
    bench_rebuild_fts_index,
    bench_update_fts_for_block,
    bench_fts_optimize,
);
criterion_main!(benches);
