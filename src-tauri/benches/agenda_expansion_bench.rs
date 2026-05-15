// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion bench that isolates the O(n × m) **repeating-rule fan-out**
//! cost in `list_projected_agenda_inner`.
//!
//! The existing `agenda_bench.rs::bench_list_projected_agenda` varies the
//! total block count but pins the projection window to a fixed 7-day range
//! — its sweep measures end-to-end latency at a single window size and
//! does not let us see the `m` coefficient (number of repeating rules)
//! independently. ARCHITECTURE.md §25 documents the on-the-fly projection
//! path as O(n × m) where:
//!   - `n` = projection-window size (days)
//!   - `m` = number of repeating rules in scope
//!
//! ARCHITECTURE.md §25 *Problem* row reports ~620 ms at 100K total blocks;
//! that figure rolls `n` and `m` together. Without a bench that varies `m`
//! while holding `n` fixed, a future fix to the expansion algorithm cannot
//! be verified — you cannot tell whether wall-clock improved because the
//! fix shrunk the `m` coefficient, or because the test fixture happened to
//! have fewer repeating rules.
//!
//! This bench fixes `n` (a 30-day window — long enough that
//! `every 1 week` rules emit ~4 occurrences each) and sweeps
//! `m ∈ {100, 1_000, 10_000}`. The cache table (`projected_agenda_cache`)
//! is left empty so the `inner` function falls through to the
//! `list_projected_agenda_on_the_fly` branch — that is the expansion-cost
//! target. (`on_the_fly` itself is `pub(crate)` and not reachable from a
//! bench crate; the inner's cache-empty fallback is the documented
//! external entry point.)
//!
//! This is a regular Criterion measurement — no panic-on-budget. The HTML
//! report at `target/criterion/agenda_expansion/report/index.html` shows
//! the wall-clock-vs-`m` scaling curve directly.
//!
//! Seeder helper (`seed_repeating_blocks`) is copied inline from
//! `agenda_bench.rs` following the inline-duplicate convention used by
//! `interactive_slo.rs` (which copied many seeders from sibling benches).
//! Keeping the seeder local means a future change to the upstream seeder
//! cannot silently shift this bench's fixture out from under it.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::list_projected_agenda_inner;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::space::SpaceScope;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers (copied inline from `agenda_bench.rs` — see module docstring)
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed `n` blocks with repeating-task properties for
/// `list_projected_agenda_inner`.
///
/// Each block gets:
/// - `due_date` on the blocks table (cycling through 30 days from 2025-07-01)
/// - `todo_state = 'TODO'`
/// - A `repeat` property in `block_properties` (`every 1 week`)
///
/// NOTE: inserts go directly via SQL (NOT through the materializer event
/// loop), so `projected_agenda_cache` is intentionally left empty — the
/// cache-empty fallback in `list_projected_agenda_inner` routes through
/// the on-the-fly expansion path, which is the O(n × m) target this bench
/// measures.
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
// list_projected_agenda_inner — repeating-rule fan-out sweep
// ===========================================================================

/// Sweep `m` (the number of repeating rules in scope) across
/// `[100, 1_000, 10_000]`, holding the projection window fixed at 30 days.
/// Each iteration calls `list_projected_agenda_inner`; with an empty
/// `projected_agenda_cache` and no cursor, the inner function falls
/// through to the on-the-fly expansion branch — that is the path whose
/// O(n × m) cost we want to observe.
fn bench_agenda_expansion(c: &mut Criterion) {
    let mut group = c.benchmark_group("agenda_expansion");

    // Fixed 30-day window: long enough that an `every 1 week` rule emits
    // ~4 occurrences per block, so the expansion loop's work-per-block
    // is non-trivial and the per-`m` curve is not dominated by setup.
    let start_date = "2025-07-01";
    let end_date = "2025-07-30";

    for m in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("agenda_expansion_{m}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        rt.block_on(seed_repeating_blocks(&pool, m));

        group.throughput(Throughput::Elements(m as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{m}_rules")),
            &m,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        list_projected_agenda_inner(
                            &pool,
                            start_date.into(),
                            end_date.into(),
                            None,
                            Some(200),
                            &SpaceScope::Global,
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

criterion_group!(benches, bench_agenda_expansion);
criterion_main!(benches);
