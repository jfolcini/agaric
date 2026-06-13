// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for two hot, user-facing read commands on the
//! editor/block path that previously had no bench coverage (#978):
//!
//!   1. `load_page_subtree_inner` — the single-SELECT page loader that
//!      replaced the FE-side recursive `listBlocks` walk. Runs on every
//!      page open; latency here is the time-to-first-render of a page.
//!   2. `get_blocks_inner` — the batch block fetch (`get_blocks(ids)`),
//!      used by multi-select, backlink hydration, and any view that
//!      resolves a known set of block ids in one IPC.
//!
//! Both are read-only and are exercised at realistic page sizes. The seed
//! mirrors `export_bench`'s direct-SQL shape (fast bulk insert in one tx)
//! but additionally sets `page_id` + `space_id` because both commands
//! filter on those columns. IDs are real ULIDs (`BlockId::new()`) so the
//! commands' `BlockId::from_string` validation passes.

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};

use agaric_lib::commands::{get_blocks_inner, load_page_subtree_inner};
use agaric_lib::db::init_pool;
use agaric_lib::ulid::BlockId;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Register `TEST_SPACE_ID` as a space: a `page` block plus a row in the
/// `spaces` registry. Since migration 0089, `blocks.space_id REFERENCES
/// spaces(id)`, so any block we stamp with `space_id = TEST_SPACE_ID` needs
/// this row first (else FK 787). Mirrors
/// `commands::tests::common::ensure_test_space`.
async fn ensure_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?1, 'page', 'BenchSpace', NULL, NULL, ?1)",
    )
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
}

/// Seed a page block with `n` child content blocks, all carrying
/// `page_id = <page>` and `space_id = TEST_SPACE_ID` so the page-scoped /
/// space-scoped read filters select them. Returns `(page_id, child_ids)`.
///
/// Children alternate short/long content to mimic a real page body.
async fn seed_page(pool: &SqlitePool, n: usize) -> (String, Vec<String>) {
    ensure_space(pool).await;

    let page_id = BlockId::new().into_string();
    let mut tx = pool.begin().await.unwrap();

    // Parent page. CHECK `page_id_self_for_pages` (migration 0073) requires
    // a `block_type='page'` row to carry `page_id = id`. The page lives in
    // TEST_SPACE_ID so the subtree read's space-membership probe
    // (`id = root AND space_id = ?`) passes.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position, page_id, space_id) \
         VALUES (?1, 'page', 'Benchmark Page', 1, ?1, ?2)",
    )
    .bind(&page_id)
    .bind(TEST_SPACE_ID)
    .execute(&mut *tx)
    .await
    .unwrap();

    let mut child_ids = Vec::with_capacity(n);
    for i in 0..n {
        let id = BlockId::new().into_string();
        let content = if i % 2 == 0 {
            format!("Short content block number {i} with a few words.")
        } else {
            format!(
                "Longer content block number {i}: Lorem ipsum dolor sit amet, \
                 consectetur adipiscing elit. Sed do eiusmod tempor incididunt \
                 ut labore et dolore magna aliqua. Ut enim ad minim veniam."
            )
        };

        sqlx::query(
            "INSERT INTO blocks \
             (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?1, 'content', ?2, ?3, ?4, ?3, ?5)",
        )
        .bind(&id)
        .bind(&content)
        .bind(&page_id)
        .bind(i as i64 + 1)
        .bind(TEST_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

        child_ids.push(id);
    }

    tx.commit().await.unwrap();
    (page_id, child_ids)
}

// ===========================================================================
// load_page_subtree — every page open
// ===========================================================================

fn bench_load_page_subtree(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("load_page_subtree");

    // Realistic page bodies: a small note, a medium page, a large outline.
    for n_blocks in [50, 500, 2_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("subtree_{n_blocks}")));
        let (page_id, _) = rt.block_on(seed_page(&pool, n_blocks));

        group.throughput(Throughput::Elements(n_blocks as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_blocks}_blocks")),
            &page_id,
            |b, page_id| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let page_id = page_id.clone();
                    async move {
                        load_page_subtree_inner(&pool, &page_id, TEST_SPACE_ID)
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
// get_blocks — batch fetch by id set
// ===========================================================================

fn bench_get_blocks(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("get_blocks");

    // Seed once at a representative page size, then fetch batches of varying
    // width (multi-select / backlink hydration sizes). The DB carries 2K
    // rows so the `json_each` membership probe runs against a realistic
    // index, not a toy table.
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "get_blocks"));
    let (_page_id, child_ids) = rt.block_on(seed_page(&pool, 2_000));

    // MAX_BATCH_BLOCK_IDS is 1000; 500 stays comfortably under the cap.
    for batch in [10usize, 100, 500] {
        let ids: Vec<BlockId> = child_ids
            .iter()
            .take(batch)
            .map(|s| BlockId::from_string(s).unwrap())
            .collect();

        group.throughput(Throughput::Elements(batch as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{batch}_ids")),
            &ids,
            |b, ids| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let ids = ids.clone();
                    async move { get_blocks_inner(&pool, ids).await.unwrap() }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(page_load_benches, bench_load_page_subtree, bench_get_blocks,);

criterion_main!(page_load_benches);
