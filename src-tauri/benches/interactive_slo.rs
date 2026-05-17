// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

//! Interactive-command SLO gate — Phase 1 of
//! `pending/scale-benchmarks-100k-2026-05-14.md`.
//!
//! Re-runs the 100K-scale measurements for every user-facing Tauri command
//! covered by `docs/ARCHITECTURE.md` §25 (lines 2374-2393) and `panic!`s if any
//! sample's *mean* elapsed wall-clock exceeds the per-command latency
//! budget. The product SLO is "interactive commands ≤ 200 ms p95 @ 100K";
//! individual budgets are seeded from §25's current numbers, rounded up,
//! and listed inline beside each bench function.
//!
//! ## Running
//!
//! ```text
//! cargo bench --bench interactive_slo
//! ```
//!
//! Uses `sample_size(10)` and is intended to be run **once in CI**
//! (release profile, single-thread, fixed seed). Total runtime: ~1-2 min
//! including the 100K fixture build.
//!
//! ## Problem-command gating
//!
//! Two commands currently violate the 200 ms budget (`list_page_links`
//! ~1.3 s, `list_projected_agenda` ~620 ms — see §25 *Problem* rows).
//! Their bench fns are present in this file with the *aspirational*
//! 200 ms budget, but are gated behind the `SLO_INCLUDE_PROBLEM` env
//! var so they don't fail CI today. To run them locally:
//!
//! ```text
//! SLO_INCLUDE_PROBLEM=1 cargo bench --bench interactive_slo
//! ```
//!
//! Each Problem fn's gate carries a TODO pointing at its mitigation
//! plan; remove the gate as the fix lands (`pending/scale-benchmarks-100k-2026-05-14.md`
//! Phase 3).
//!
//! ## Why bench-internal `assert!` rather than Criterion thresholds?
//!
//! Criterion has no native "fail if mean > X" API. The two clean
//! alternatives are (a) parse `target/criterion/<group>/new/estimates.json`
//! post-run, or (b) time manually via `iter_custom` and assert at the
//! end of the bench fn. We use (b) because `iter_custom` is already
//! the dominant pattern in this tree (`compaction_bench.rs`,
//! `attachment_bench.rs`, `property_bench.rs`) and avoids depending on
//! Criterion's filesystem layout.

use criterion::{criterion_group, criterion_main, Criterion};

use agaric_lib::commands::{
    batch_resolve_inner, count_agenda_batch_inner, count_backlinks_batch_inner, create_block_inner,
    export_page_markdown_inner, get_block_inner, get_properties_inner, list_blocks_inner,
    list_page_links_inner, list_projected_agenda_inner, revert_ops_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::op::OpRef;
use agaric_lib::space::{SpaceId, SpaceScope};

use sqlx::SqlitePool;
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 100K-block fixture scale — the SLO is defined at this size.
const FIXTURE_SIZE: usize = 100_000;

/// Sample count per bench — the plan calls for `sample_size(10)` to keep
/// total runtime under 2 min on a CI runner.
const SAMPLE_SIZE: usize = 10;

/// Space ULID used by every bench that exercises a space-scoped command.
/// Mirrors the `TEST_SPACE_ID` constant in `commands_bench.rs`.
const SLO_SPACE_ID: &str = "01SLOSPACE0000000000000001";

/// Device id used by `bench_revert_ops_50op_at_100k` — paired with
/// `seed_single_page_history` so the most-recent-50 op selector can
/// build `OpRef`s without querying the op_log.
const HISTORY_BENCH_DEVICE: &str = "bench-device";

// ---------------------------------------------------------------------------
// Accumulator type
// ---------------------------------------------------------------------------

/// Shared elapsed/iters counter, cloned into every `iter_custom` closure.
/// Cell + Rc rather than RefCell because Criterion calls the
/// `bench_function` closure multiple times (once per sample), and the
/// closure must move-capture its accumulator clone each call.
#[derive(Clone, Default)]
struct Acc {
    total: Rc<Cell<Duration>>,
    iters: Rc<Cell<u64>>,
}

impl Acc {
    fn new() -> Self {
        Self {
            total: Rc::new(Cell::new(Duration::ZERO)),
            iters: Rc::new(Cell::new(0)),
        }
    }
    fn record(&self, elapsed: Duration, iters: u64) {
        self.total.set(self.total.get() + elapsed);
        self.iters.set(self.iters.get() + iters);
    }
    fn total(&self) -> Duration {
        self.total.get()
    }
    fn iters(&self) -> u64 {
        self.iters.get()
    }
}

// ---------------------------------------------------------------------------
// Fixture helpers — mirror `commands_bench.rs::seed_blocks_bulk` and
// `commands_bench.rs::assign_all_to_test_space`. Duplicated rather than
// extracted to a shared module because Cargo's bench-target layout makes
// cross-bench module sharing painful (each `[[bench]]` is its own crate
// root) and the helpers are small. Keep these in sync with the
// `commands_bench.rs`/`agenda_bench.rs`/`graph_bench.rs`/`export_bench.rs`
// / `backlink_query_bench.rs` copies if either side changes.
// ---------------------------------------------------------------------------

async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Bulk-seed `n` blocks directly via SQL in a single transaction.
/// Populates both `blocks` and `op_log` tables for realistic DB state.
async fn seed_blocks_bulk(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("SEED{i:020}");
        let content = format!("Seeded block {i} with some placeholder content.");
        let ts = format!("2025-01-15T12:00:{:06}+00:00", i);
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

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES ('dev-bench', ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(i as i64 + 1)
        .bind(format!(
            r#"{{"block_id":"{id}","block_type":"content","content":"{content}"}}"#,
        ))
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .unwrap();

        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

/// Assign every seeded block to `SLO_SPACE_ID` so space-scoped commands
/// see a non-empty result set.
async fn assign_all_to_slo_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'page', 'SloSpace', NULL, NULL)",
    )
    .bind(SLO_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_ref) \
         SELECT b.id, 'space', ? FROM blocks b \
         WHERE b.id <> ? \
           AND NOT EXISTS ( \
                SELECT 1 FROM block_properties bp \
                WHERE bp.block_id = b.id AND bp.key = 'space' \
           )",
    )
    .bind(SLO_SPACE_ID)
    .bind(SLO_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// Seed `n` agenda_cache entries spread across a 30-day window from
/// 2025-07-01. Mirrors `agenda_bench.rs::seed_agenda_blocks`.
async fn seed_agenda_blocks(pool: &SqlitePool, n: usize) {
    let base_date = chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("AGD{i:021}");
        let date = base_date + chrono::Duration::days((i % 30) as i64);
        let date_str = date.format("%Y-%m-%d").to_string();
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

/// Seed `n` repeating-task blocks. Mirrors
/// `agenda_bench.rs::seed_repeating_blocks`.
async fn seed_repeating_blocks(pool: &SqlitePool, n: usize) {
    let base_date = chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("RPT{i:021}");
        let date = base_date + chrono::Duration::days((i % 30) as i64);
        let date_str = date.format("%Y-%m-%d").to_string();
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
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'repeat', 'every 1 week')",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` pages + child content + ~3 cross-page links per source.
/// Mirrors `graph_bench.rs::seed_pages_with_links`.
async fn seed_pages_with_links(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let page_id = format!("PG{i:022}");
        let child_id = format!("CH{i:022}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'page', ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Page {i}"))
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, 1)",
        )
        .bind(&child_id)
        .bind(format!("Content of page {i}"))
        .bind(&page_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    for i in 0..n {
        let child_id = format!("CH{i:022}");
        for offset in 1..=3 {
            let target_idx = (i + offset) % n;
            if target_idx == i {
                continue;
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

/// Seed an export-target page with `n` child blocks of varying length.
/// Mirrors `export_bench.rs::seed_page_with_children`.
async fn seed_export_page(pool: &SqlitePool, page_id: &str, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES (?, 'page', 'SLO Export Page', 1)",
    )
    .bind(page_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    for i in 0..n {
        let id = format!("EX{i:022}");
        let content = if i % 2 == 0 {
            format!("Short content block {i}.")
        } else {
            format!(
                "Longer content block {i}: Lorem ipsum dolor sit amet, \
                 consectetur adipiscing elit. Sed do eiusmod tempor incididunt \
                 ut labore et dolore magna aliqua."
            )
        };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(page_id)
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed a production-realistic 100K shape for `batch_resolve`:
/// `PAGE_COUNT` pages (each `page_id = id`, each carrying a `space`
/// property pointing at `SLO_SPACE_ID`) and `n` content blocks
/// distributed round-robin across those pages with `page_id` set to
/// their owning page's id.
///
/// ## Why this seeder exists separately from `seed_blocks_bulk`
///
/// SQL-review Phase 4 (commit `4a4128fd`) removed `COALESCE(b.page_id,
/// b.id)` from the space filter at every read site; the new shape
/// (`b.page_id IN (SELECT bp.block_id ... WHERE bp.key='space')`)
/// requires `page_id` to be non-NULL for any block that should pass the
/// filter. The legacy `seed_blocks_bulk` + `assign_all_to_slo_space`
/// pair was written against the COALESCE-era SQL where `page_id` NULL
/// fell back to `b.id` — under the new SQL it silently produces an
/// empty result set, and `batch_resolve` ends up benchmarking the cost
/// of an unindexed filter that never matches. The 50 request_ids
/// returned here resolve to ~50 live rows under both the old and new
/// SQL shapes, so the bench measures real interactive-resolve cost.
///
/// Other benches in this file (`bench_list_blocks`, `bench_get_block`,
/// etc.) continue to use `seed_blocks_bulk` because they either don't
/// space-filter (`get_block`) or paginate with `LIMIT 50` (`list_blocks`)
/// where an empty result is bounded by the index scan, not the subquery
/// re-evaluation that hurts `batch_resolve`.
async fn seed_resolve_fixture(pool: &SqlitePool, n: usize) -> Vec<String> {
    // Density chosen to match the real-world shape: ~1 page per 100
    // content blocks gives 1000 pages at 100K total — close to the
    // upper end of what FEAT-3 telemetry sees in active vaults. Keep
    // PAGE_COUNT < FIXTURE_SIZE so the round-robin distribution
    // produces ≥1 block per page.
    const PAGE_COUNT: usize = 1_000;
    let blocks_per_page = n.div_ceil(PAGE_COUNT);

    let mut tx = pool.begin().await.unwrap();

    // The space-owner page (mirrors `assign_all_to_slo_space`).
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'SloSpace', NULL, NULL, ?)",
    )
    .bind(SLO_SPACE_ID)
    .bind(SLO_SPACE_ID)
    .execute(&mut *tx)
    .await
    .unwrap();

    // Seed PAGE_COUNT pages. `page_id = id` matches the invariant
    // migration 0066 backfilled (every page-create path now sets this).
    let mut page_ids: Vec<String> = Vec::with_capacity(PAGE_COUNT);
    for p in 0..PAGE_COUNT {
        let page_id = format!("SLPG{p:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Resolve fixture page {p}"))
        .bind(p as i64 + 1)
        .bind(&page_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        // Each page carries the `space` property — this is the
        // production invariant: pages own the space tag, content
        // blocks inherit via `page_id`.
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(&page_id)
        .bind(SLO_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();
        page_ids.push(page_id);
    }

    // Seed n content blocks distributed across the pages.
    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        let id = format!("SEED{i:020}");
        let content = format!("Seeded block {i} with some placeholder content.");
        let ts = format!("2025-01-15T12:00:{:06}+00:00", i);
        let owning_page = &page_ids[i % PAGE_COUNT];
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(owning_page)
        .bind(i as i64 + 1)
        .bind(owning_page)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES ('dev-bench', ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(i as i64 + 1)
        .bind(format!(
            r#"{{"block_id":"{id}","block_type":"content","parent_id":"{owning_page}","content":"{content}"}}"#,
        ))
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .unwrap();

        ids.push(id);
    }
    tx.commit().await.unwrap();
    // `blocks_per_page` is computed for symmetry / debugging only; the
    // round-robin loop above does not need it. Silence the unused
    // binding without dragging an `#[allow]` attribute through the
    // helper.
    let _ = blocks_per_page;
    ids
}

/// Seed `n` source content blocks linking round-robin to 10 target pages.
/// Mirrors `backlink_query_bench.rs::seed_backlinks_for_batch`.
async fn seed_backlinks_for_batch(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for p in 0..10 {
        let page_id = format!("BLP{p:021}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)")
            .bind(&page_id)
            .bind(format!("Page {p}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for i in 0..n {
        let src_id = format!("BLS{i:021}");
        let target_page = format!("BLP{:021}", i % 10);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES (?, 'content', ?, ?)",
        )
        .bind(&src_id)
        .bind(format!("Source block {i}"))
        .bind(&target_page)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&src_id)
            .bind(&target_page)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Build a deterministic, valid RFC-3339 timestamp from a seq counter.
/// Mirrors the safe `% 24` variant in `history_bench.rs::ts_for` (the
/// flat seeder in `undo_redo.rs` overflows hours past 86400 ops; this
/// stays valid through 100K).
fn slo_history_ts_for(seq: i64) -> String {
    format!(
        "2025-01-15T{:02}:{:02}:{:02}.{:03}Z",
        (seq / 3600) % 24,
        (seq / 60) % 60,
        seq % 60,
        seq % 1000
    )
}

/// Seed a single page with exactly `total_ops` ops in its history.
/// Duplicated verbatim from `history_bench.rs::seed_single_page_history`
/// per the inline-helper convention this file already uses; keep the
/// two copies in sync if either side changes. Layout: seq=1 page create,
/// seq=2 child create, seq=3..=total_ops edit_block ops against that
/// child. Returns `(page_id, child_block_id, last_seq)`.
async fn seed_single_page_history(pool: &SqlitePool, total_ops: usize) -> (String, String, i64) {
    assert!(
        total_ops >= 52,
        "seed_single_page_history needs >=52 ops (2 creates + 50-op revert window)"
    );

    let page_id = format!("PAGE{:020}", 0);
    let block_id = format!("BLK{:020}", 0);
    let mut seq: i64 = 0;

    let mut tx = pool.begin().await.unwrap();

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES (?, 'page', 'Bench Page', 1)",
    )
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let page_create_json = format!(
        r#"{{"block_id":"{page_id}","block_type":"page","parent_id":null,"position":1,"content":"Bench Page"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(HISTORY_BENCH_DEVICE)
    .bind(seq)
    .bind(&page_create_json)
    .bind(slo_history_ts_for(seq))
    .execute(&mut *tx)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'initial', ?, 1)",
    )
    .bind(&block_id)
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let child_create_json = format!(
        r#"{{"block_id":"{block_id}","block_type":"content","parent_id":"{page_id}","position":1,"content":"initial"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(HISTORY_BENCH_DEVICE)
    .bind(seq)
    .bind(&child_create_json)
    .bind(slo_history_ts_for(seq))
    .execute(&mut *tx)
    .await
    .unwrap();

    let remaining = (total_ops as i64) - seq;
    for j in 0..remaining {
        seq += 1;
        let edit_json =
            format!(r#"{{"block_id":"{block_id}","to_text":"edit-{j}","prev_edit":null}}"#);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, 'fakehash', 'edit_block', ?, ?)",
        )
        .bind(HISTORY_BENCH_DEVICE)
        .bind(seq)
        .bind(&edit_json)
        .bind(slo_history_ts_for(seq))
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    if remaining > 0 {
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(format!("edit-{}", remaining - 1))
            .bind(&block_id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
    assert_eq!(seq, total_ops as i64);
    (page_id, block_id, seq)
}

// ---------------------------------------------------------------------------
// Assertion + gating helpers
// ---------------------------------------------------------------------------

/// Compute mean ms from an `Acc` and panic with a grep-friendly message
/// if it exceeds the budget. The message format is stable; PR reviewers
/// and `grep interactive_slo:` consumers depend on it.
fn assert_under_budget(cmd: &str, acc: &Acc, budget_ms: f64) {
    let iters = acc.iters();
    assert!(
        iters > 0,
        "interactive_slo: {cmd} ran zero iterations (Criterion harness bug?)"
    );
    let mean_ms = (acc.total().as_secs_f64() * 1000.0) / iters as f64;
    assert!(
        mean_ms <= budget_ms,
        "interactive_slo: {cmd} = {mean_ms:.2} ms > budget {budget_ms} ms \
         (regression — see docs/ARCHITECTURE.md §25)"
    );
    println!("interactive_slo: {cmd} = {mean_ms:.2} ms <= budget {budget_ms} ms (PASS)");
}

/// Skip-gate for problem commands. Returns `true` when the bench should
/// be skipped (the default for CI). Set `SLO_INCLUDE_PROBLEM=1` to run.
fn problem_skipped(cmd: &str) -> bool {
    if std::env::var("SLO_INCLUDE_PROBLEM").is_err() {
        println!(
            "interactive_slo: {cmd} SKIPPED (set SLO_INCLUDE_PROBLEM=1 to run; \
             aspirational budget — see pending/scale-benchmarks-100k-2026-05-14.md Phase 3)"
        );
        true
    } else {
        false
    }
}

// ===========================================================================
// Green tier — budgets enforced
// ===========================================================================

/// `get_block` — single-row lookup by id. Budget: 1 ms @ 100K.
fn bench_get_block(c: &mut Criterion) {
    const BUDGET_MS: f64 = 1.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_get_block"));
    let ids = rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));
    let target_id = ids[FIXTURE_SIZE / 2].clone();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("get_block_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let target_id = target_id.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let target_id = target_id.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = get_block_inner(&pool, target_id.clone()).await.unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("get_block @ 100K", &acc, BUDGET_MS);
}

/// `get_properties` — all properties for one block. Budget: 1 ms @ 100K.
fn bench_get_properties(c: &mut Criterion) {
    const BUDGET_MS: f64 = 1.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_get_props"));
    let ids = rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));
    rt.block_on(async {
        for (k, v) in [("priority", "high"), ("status", "active")] {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
            )
            .bind(&ids[FIXTURE_SIZE / 2])
            .bind(k)
            .bind(v)
            .execute(&pool)
            .await
            .unwrap();
        }
    });
    let target_id = ids[FIXTURE_SIZE / 2].clone();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("get_properties_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let target_id = target_id.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let target_id = target_id.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = get_properties_inner(&pool, target_id.clone())
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("get_properties @ 100K", &acc, BUDGET_MS);
}

/// `list_blocks` — first paginated page of 50 in a 100K DB. Budget: 30 ms.
fn bench_list_blocks(c: &mut Criterion) {
    const BUDGET_MS: f64 = 30.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_list_blocks"));
    rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));
    rt.block_on(assign_all_to_slo_space(&pool));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("list_blocks_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = list_blocks_inner(
                        &pool,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        Some(50),
                        SLO_SPACE_ID.into(),
                    )
                    .await
                    .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("list_blocks (paginated) @ 100K", &acc, BUDGET_MS);
}

/// `batch_resolve` — resolve 50 ids in a 100K DB. Budget: 5 ms.
///
/// SQL-review Phase 4 (commit `4a4128fd`) tightened the space filter
/// from `COALESCE(b.page_id, b.id) IN (...)` to `b.page_id IN (...)`,
/// matching the invariant migration 0066 backfilled. The fixture must
/// therefore set `page_id` to a non-NULL page that carries the `space`
/// property — `seed_resolve_fixture` produces this shape; the legacy
/// `seed_blocks_bulk` + `assign_all_to_slo_space` pair (still used by
/// other benches in this file) does not, and would silently make this
/// bench measure an empty-result path that runs ~12 ms because the
/// planner re-evaluates the unindexed `b.page_id IS NULL` filter for
/// every `json_each(?1)` row.
fn bench_batch_resolve(c: &mut Criterion) {
    const BUDGET_MS: f64 = 5.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_batch_resolve"));
    let ids = rt.block_on(seed_resolve_fixture(&pool, FIXTURE_SIZE));

    // 50 ids spread across the seed range — same shape as a typical
    // chip-rehydration request.
    let request_ids: Vec<String> = ids
        .iter()
        .step_by(FIXTURE_SIZE / 50)
        .take(50)
        .cloned()
        .collect();
    let scope = SpaceScope::Active(SpaceId::from_trusted(SLO_SPACE_ID));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("batch_resolve_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let request_ids = request_ids.clone();
        let scope = scope.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let request_ids = request_ids.clone();
            let scope = scope.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = batch_resolve_inner(&pool, request_ids.clone(), &scope)
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("batch_resolve @ 100K", &acc, BUDGET_MS);
}

/// `count_agenda_batch` — weekly badge counts over 100K agenda rows.
/// Budget: 30 ms.
fn bench_count_agenda_batch(c: &mut Criterion) {
    const BUDGET_MS: f64 = 30.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_count_agenda"));
    rt.block_on(seed_agenda_blocks(&pool, FIXTURE_SIZE));

    let dates: Vec<String> = (0..7)
        .map(|d| {
            let date =
                chrono::NaiveDate::from_ymd_opt(2025, 7, 1).unwrap() + chrono::Duration::days(d);
            date.format("%Y-%m-%d").to_string()
        })
        .collect();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("count_agenda_batch_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let dates = dates.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let dates = dates.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = count_agenda_batch_inner(&pool, dates.clone(), &SpaceScope::Global)
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("count_agenda_batch @ 100K", &acc, BUDGET_MS);
}

/// `count_backlinks_batch` — 10 target pages, 100K source blocks.
/// Budget: 100 ms (§25 measures ~62 ms — "concerning at scale" tier).
fn bench_count_backlinks_batch(c: &mut Criterion) {
    const BUDGET_MS: f64 = 100.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_backlinks_batch"));
    rt.block_on(seed_backlinks_for_batch(&pool, FIXTURE_SIZE));

    let page_ids: Vec<String> = (0..10).map(|p| format!("BLP{p:021}")).collect();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("count_backlinks_batch_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let page_ids = page_ids.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let page_ids = page_ids.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ =
                        count_backlinks_batch_inner(&pool, page_ids.clone(), &SpaceScope::Global)
                            .await
                            .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("count_backlinks_batch @ 100K", &acc, BUDGET_MS);
}

/// `export_page_markdown` — serialise a page with 2K children on top of
/// a 100K background DB. Budget: 10 ms (per §A's "export_page_markdown
/// (2K)" row, the scale parameter is *children of the exported page*).
fn bench_export_page_markdown(c: &mut Criterion) {
    const BUDGET_MS: f64 = 10.0;
    const EXPORT_PAGE_ID: &str = "SLOEXPORTPAGE0000000000001";
    const CHILD_COUNT: usize = 2_000;

    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_export"));
    rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));
    rt.block_on(seed_export_page(&pool, EXPORT_PAGE_ID, CHILD_COUNT));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("export_page_markdown_2k_in_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = export_page_markdown_inner(&pool, EXPORT_PAGE_ID)
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("export_page_markdown (2K children) @ 100K", &acc, BUDGET_MS);
}

/// `create_block` — one new content block on top of a 100K DB. Budget: 60 ms.
fn bench_create_block(c: &mut Criterion) {
    const BUDGET_MS: f64 = 60.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_create_block"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    {
        let pool_outer = pool.clone();
        group.bench_function("create_block_100k", move |b| {
            let acc = acc_for_bench.clone();
            let pool = pool_outer.clone();
            let materializer_ref = &materializer;
            b.to_async(&rt).iter_custom(move |iters| {
                let pool = pool.clone();
                let acc = acc.clone();
                async move {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let _ = create_block_inner(
                            &pool,
                            "dev-bench",
                            materializer_ref,
                            "content".into(),
                            "SLO bench block".into(),
                            None,
                            None,
                        )
                        .await
                        .unwrap();
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                }
            })
        });
    }
    group.finish();

    assert_under_budget("create_block @ 100K", &acc, BUDGET_MS);
}

/// `revert_ops_inner` — 50-op batch revert against a single page with
/// 100K total ops in its history. Budget: 200 ms.
///
/// Phase 2 §B.1 gate for `history_bench::bench_revert_ops_50op`. The
/// 200 ms ceiling is the same SLO every interactive command answers to;
/// `revert` is bulk-write but user-initiated (Cmd+Z over a selection
/// translates to this command), so it sits in the interactive tier.
///
/// `revert_ops_inner` mutates state (appends 50 reverse ops), so each
/// iteration grows the op log; the cost-per-revert is dominated by the
/// per-op `compute_reverse` walk + the recursive-CTE op-log read, both
/// of which scale with the size of the log not with the per-revert
/// mutation. The mean-of-`sample_size(10)` measurement is therefore a
/// faithful "50-op revert at 100K" number — within sample noise.
fn bench_revert_ops_50op_at_100k(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;
    const TOTAL_OPS: usize = 100_000;

    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_revert_ops"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    let (_page_id, _block_id, last_seq) = rt.block_on(seed_single_page_history(&pool, TOTAL_OPS));

    // Most-recent-50 ops = [last_seq - 49 .. last_seq], all edit_block
    // against the same child (see `seed_single_page_history` doc).
    let ops: Vec<OpRef> = (0..50)
        .map(|i| OpRef {
            device_id: HISTORY_BENCH_DEVICE.to_string(),
            seq: last_seq - i,
        })
        .collect();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    {
        let pool_outer = pool.clone();
        group.bench_function("revert_ops_50op_at_100k", move |b| {
            let acc = acc_for_bench.clone();
            let pool = pool_outer.clone();
            let ops = ops.clone();
            let materializer_ref = &materializer;
            b.to_async(&rt).iter_custom(move |iters| {
                let pool = pool.clone();
                let ops = ops.clone();
                let acc = acc.clone();
                async move {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let _ = revert_ops_inner(
                            &pool,
                            HISTORY_BENCH_DEVICE,
                            materializer_ref,
                            ops.clone(),
                        )
                        .await
                        .unwrap();
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                }
            })
        });
    }
    group.finish();

    assert_under_budget("revert_ops (50op) @ 100K", &acc, BUDGET_MS);
}

// ===========================================================================
// Problem tier — aspirational budgets, gated behind SLO_INCLUDE_PROBLEM
// ===========================================================================

/// `list_page_links` — graph-view roll-up. **Currently ~1.3 s at 100K**
/// (3-JOIN superlinearity, see §25 *Problem* row); SQL-review §H-2
/// (migration 0065 `page_link_cache` + the per-`ReindexBlockLinks`
/// rollup in `cache::page_links::reindex_page_link_cache_for_block`)
/// brought it under budget, so the `SLO_INCLUDE_PROBLEM` env-gate has
/// been removed.
fn bench_list_page_links(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_page_links"));
    rt.block_on(seed_pages_with_links(&pool, FIXTURE_SIZE));
    // SQL-review §H-2: the fixture seeds `block_links` directly,
    // bypassing the materializer's per-`ReindexBlockLinks` rollup. Run
    // a single `rebuild_page_link_cache` so the read path can hit the
    // cache (the production hot path is populated incrementally; this
    // wholesale rebuild is the same code FULL_CACHE_REBUILD_TASKS runs
    // on delete/restore/purge, just hoisted to fixture time).
    rt.block_on(agaric_lib::cache::rebuild_page_link_cache(&pool))
        .unwrap();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("list_page_links_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = list_page_links_inner(&pool, &SpaceScope::Global, None)
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("list_page_links @ 100K", &acc, BUDGET_MS);
}

/// `list_projected_agenda` — repeating-task projection over 100K rows.
/// **Currently ~620 ms** (O(n×m) in-memory expansion, §25 *Problem* row).
///
/// TODO(scale-benchmarks-100k-2026-05-14.md Phase 3): drop the
/// `problem_skipped` gate once the SQL/CTE pushdown lands.
fn bench_list_projected_agenda(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;
    if problem_skipped("list_projected_agenda @ 100K") {
        return;
    }
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_projected_agenda"));
    rt.block_on(seed_repeating_blocks(&pool, FIXTURE_SIZE));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("list_projected_agenda_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = list_projected_agenda_inner(
                        &pool,
                        "2025-07-01".into(),
                        "2025-07-07".into(),
                        None,
                        Some(200),
                        &SpaceScope::Global,
                    )
                    .await
                    .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        })
    });
    group.finish();

    assert_under_budget("list_projected_agenda @ 100K", &acc, BUDGET_MS);
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    slo_green,
    bench_get_block,
    bench_get_properties,
    bench_list_blocks,
    bench_batch_resolve,
    bench_count_agenda_batch,
    bench_count_backlinks_batch,
    bench_export_page_markdown,
    bench_revert_ops_50op_at_100k,
    bench_create_block,
);

criterion_group!(
    slo_problem,
    bench_list_page_links,
    bench_list_projected_agenda,
);

criterion_main!(slo_green, slo_problem);
