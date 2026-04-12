// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmark for the graph-view link query:
//!   - `list_page_links_inner` — rolls up content-block links to parent pages

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::list_page_links_inner;
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

/// Seed `n` page blocks, each with one child content block, and insert ~3
/// block_links per page between random pairs of content blocks and pages.
///
/// Link pattern: for page `i`, we create links from its child content block
/// to pages `(i+1) % n`, `(i+2) % n`, and `(i+3) % n` (skipping self-links).
async fn seed_pages_with_links(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Create all pages and their child content blocks
    for i in 0..n {
        let page_id = format!("PG{i:022}");
        let child_id = format!("CH{i:022}");
        let title = format!("Graph Page {i}");
        let content = format!("Content of page {i} with a [[link]] reference.");

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'page', ?, ?)",
        )
        .bind(&page_id)
        .bind(&title)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, 1)",
        )
        .bind(&child_id)
        .bind(&content)
        .bind(&page_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    // Insert ~3 links per page (content child -> target page)
    for i in 0..n {
        let child_id = format!("CH{i:022}");
        for offset in 1..=3 {
            let target_idx = (i + offset) % n;
            if target_idx == i {
                continue; // skip self-links
            }
            let target_page_id = format!("PG{target_idx:022}");
            sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
                .bind(&child_id)
                .bind(&target_page_id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }

    tx.commit().await.unwrap();
}

// ===========================================================================
// bench_list_page_links — parameterized by number of pages
// ===========================================================================

fn bench_list_page_links(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_page_links");

    for n_pages in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("graph_{n_pages}")));
        rt.block_on(seed_pages_with_links(&pool, n_pages));

        group.throughput(Throughput::Elements(n_pages as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_pages}_pages")),
            &n_pages,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move { list_page_links_inner(&pool).await.unwrap() }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(graph_benches, bench_list_page_links,);

criterion_main!(graph_benches);
