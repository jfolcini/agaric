// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmark for Markdown export:
//!   - `export_page_markdown_inner` — serialize a page with N child blocks

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group};

use agaric_lib::commands::export_page_markdown_inner;
use agaric_lib::db::init_pool;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Page id used by both the seed and the export call. `export_page_markdown_inner`
/// now parses its argument as a ULID, so this must be a canonical 26-char
/// Crockford base32 string (no I/L/O/U, first char 0-7).
const EXPORT_PAGE_ID: &str = "0000000000000000EXP0RTPAGE";

/// Title of the seeded page block. Bound (not inlined in the SQL) so the
/// untimed shape probe in `bench_export_page_markdown` asserts against the
/// same string the seeder writes.
const EXPORT_PAGE_TITLE: &str = "Benchmark Export Page";

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed a single page block with `n` child content blocks of varying length.
///
/// Children alternate between short (~50 chars) and long (~200 chars) content
/// to simulate realistic page bodies.
async fn seed_page_with_children(pool: &SqlitePool, n: usize) {
    let page_id = EXPORT_PAGE_ID;
    let mut tx = pool.begin().await.unwrap();

    // Parent page. A 'page' block must set `page_id = id` (migration 0073's
    // `page_id_self_for_pages` CHECK).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position, page_id) \
         VALUES (?, 'page', ?, 1, ?)",
    )
    .bind(page_id)
    .bind(EXPORT_PAGE_TITLE)
    .bind(page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("CHILD{i:018}");
        let content = if i % 2 == 0 {
            format!("Short content block number {i} with a few words.")
        } else {
            format!(
                "Longer content block number {i}: Lorem ipsum dolor sit amet, \
                 consectetur adipiscing elit. Sed do eiusmod tempor incididunt \
                 ut labore et dolore magna aliqua. Ut enim ad minim veniam, \
                 quis nostrud exercitation ullamco laboris."
            )
        };

        // Export discovers the full subtree through the denormalized page_id
        // column; parent_id alone makes this fixture export zero children.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(page_id)
        .bind(i as i64 + 1)
        .bind(page_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();
}

// ===========================================================================
// bench_export_page_markdown — parameterized by blocks per page
// ===========================================================================

fn bench_export_page_markdown(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("export_page_markdown");

    for n_blocks in [100, 500, 2_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("export_{n_blocks}")));
        rt.block_on(seed_page_with_children(&pool, n_blocks));

        // Untimed shape probe (#3304 idiom, see benches/AGENTS.md): one call
        // after seeding and before registering the Criterion loop, pinning the
        // fixture shape this group claims to measure. Without it the bench
        // silently degrades to serializing the page heading alone — a fixture
        // that drops the children (the `page_id` regression this bench was just
        // fixed for) still exports fine, still reports a throughput number, and
        // reads as a large speedup rather than as a broken fixture. Outside
        // `iter_custom`, so it costs the measurement nothing.
        let observed = rt
            .block_on(export_page_markdown_inner(&pool, EXPORT_PAGE_ID))
            .unwrap();
        assert!(
            observed.starts_with(&format!("# {EXPORT_PAGE_TITLE}\n")),
            "export_page_markdown/{n_blocks}_blocks: untimed probe must export the \
             seeded fixture page, but the first line was: {:?}",
            observed.lines().next()
        );
        assert_eq!(
            observed
                .lines()
                .filter(|line| line.starts_with("- "))
                .count(),
            n_blocks,
            "export_page_markdown/{n_blocks}_blocks: untimed probe must serialize all \
             {n_blocks} seeded children — a heading-only export means the fixture lost \
             its subtree and this bench is timing the wrong work (#3304)"
        );

        group.throughput(Throughput::Elements(n_blocks as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_blocks}_blocks")),
            &n_blocks,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        export_page_markdown_inner(&pool, EXPORT_PAGE_ID)
                            .await
                            .unwrap()
                    }
                });
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(export_benches, bench_export_page_markdown,);
