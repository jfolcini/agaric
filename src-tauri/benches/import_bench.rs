// Bench helpers cast small loop indices between usize/i64/u64 freely.
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

//! Criterion benchmarks for import/parsing:
//!   1. `parse_logseq_markdown` — pure parsing, no DB
//!   2. `import_markdown_inner`  — full pipeline: parse + create page + insert blocks

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::import_markdown_inner;
use agaric_lib::db::init_pool;
use agaric_lib::import::parse_logseq_markdown;
use agaric_lib::materializer::Materializer;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_BENCH: &str = "dev-bench";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Generate Logseq-style markdown with `n` blocks.
/// Each block is a top-level list item with one property:
///
/// ```text
/// - Block content line 0
///   property:: value
/// - Block content line 1
///   property:: value
/// …
/// ```
fn generate_logseq_markdown(n: usize) -> String {
    let mut s = String::with_capacity(n * 50);
    for i in 0..n {
        s.push_str(&format!("- Block content line {i}\n  property:: value\n"));
    }
    s
}

// ===========================================================================
// Group 1: parse_logseq_markdown — pure parsing, no DB
// ===========================================================================

/// Benchmark `parse_logseq_markdown` at varying block counts (100, 1000, 5000).
///
/// Uses `Throughput::Elements(N)` so Criterion reports blocks/sec.
fn bench_parse_logseq_markdown(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_logseq_markdown");

    for n in [100u64, 1000, 5000] {
        let markdown = generate_logseq_markdown(n as usize);

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &markdown,
            |b, md| {
                b.iter(|| {
                    let blocks = parse_logseq_markdown(md);
                    assert_eq!(blocks.len(), n as usize);
                });
            },
        );
    }

    group.finish();
}

// ===========================================================================
// Group 2: import_markdown_inner — full pipeline with DB
// ===========================================================================

/// Benchmark `import_markdown_inner` (parse + create page + insert blocks)
/// at varying block counts (100, 1000, 5000).
///
/// A fresh `TempDir` + SQLite pool is created per size parameter.
/// Uses `Throughput::Elements(N)` for block insertion rate.
fn bench_import_markdown_inner(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("import_markdown_inner");

    for n in [100u64, 1000, 5000] {
        let markdown = generate_logseq_markdown(n as usize);

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let content = markdown.clone();
                    async {
                        let dir = TempDir::new().unwrap();
                        let pool = fresh_pool(&dir, "import").await;
                        let materializer = Materializer::new(pool.clone());

                        let result = import_markdown_inner(
                            &pool,
                            DEV_BENCH,
                            &materializer,
                            content,
                            Some("BenchPage.md".into()),
                        )
                        .await
                        .unwrap();

                        assert_eq!(result.blocks_created, n as i64);

                        materializer.shutdown();
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

criterion_group!(parse_benches, bench_parse_logseq_markdown);
criterion_group!(import_benches, bench_import_markdown_inner);
criterion_main!(parse_benches, import_benches);
