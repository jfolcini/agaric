// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

//! Interactive-command SLO gate — the canonical enforcer of the product
//! performance SLO documented in `docs/architecture/operations.md`
//! (§ Product SLO).
//!
//! Re-runs the 100K-scale measurements for every user-facing Tauri command
//! and `panic!`s if any sample's *mean* elapsed wall-clock exceeds the
//! per-command latency budget. The product SLO is "interactive commands
//! ≤ 200 ms p95 @ 100K"; individual per-command budgets are listed inline
//! beside each bench function (this file is the source of truth for them).
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
//! ~1.3 s, `list_projected_agenda` ~620 ms — see the *known to exceed
//! budget* note in `docs/architecture/operations.md` § Product SLO).
//! Their bench fns are present in this file with the *aspirational*
//! 200 ms budget, but are gated behind the `SLO_INCLUDE_PROBLEM` env
//! var so they don't fail CI today. To run them locally:
//!
//! ```text
//! SLO_INCLUDE_PROBLEM=1 cargo bench --bench interactive_slo
//! ```
//!
//! Each Problem fn's gate carries a TODO pointing at its mitigation
//! plan; remove the gate as the fix lands.
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

use criterion::{Criterion, criterion_group, criterion_main};

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

/// Base `op_log.created_at` value, epoch milliseconds (2025-01-15T12:00:00Z).
/// `created_at` is INTEGER-NOT-NULL since migration 0079 (#109 Phase 2); the
/// STRICT table rejects the RFC-3339 TEXT this bench used to bind. Seeders add
/// a monotonic per-op offset so ordering matches the old string ordering.
const SLO_BASE_TS_MS: i64 = 1_736_942_400_000;

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
        let ts = SLO_BASE_TS_MS + i as i64;
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
        .bind(ts)
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
    // A 'page' block must have `page_id = id` (migration 0073's
    // `page_id_self_for_pages` CHECK); omitting it makes INSERT OR IGNORE
    // silently drop the row, leaving SLO_SPACE_ID absent and the space_id FK
    // below unsatisfiable.
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'SloSpace', NULL, NULL, ?)",
    )
    .bind(SLO_SPACE_ID)
    .bind(SLO_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    // Register the page in the `spaces` registry (#708, migration 0089):
    // `blocks.space_id` now REFERENCES spaces(id), so the space owner must
    // exist there before any block can point its space_id at it.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SLO_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    // Space membership is the first-class `blocks.space_id` column (#533,
    // migration 0086); the canonical filter is `b.space_id = ?` and `space`
    // is a reserved key that the 0088 CHECK forbids in `block_properties`.
    // Assign every block (except the space-owner page itself) to the space.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id <> ?")
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
            "INSERT INTO blocks (id, block_type, content, position, page_id) \
             VALUES (?, 'page', ?, ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Page {i}"))
        .bind(i as i64 + 1)
        .bind(&page_id)
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
        "INSERT INTO blocks (id, block_type, content, position, page_id) \
         VALUES (?, 'page', 'SLO Export Page', 1, ?)",
    )
    .bind(page_id)
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
/// `PAGE_COUNT` pages (each `page_id = id`) and `n` content blocks
/// distributed round-robin across those pages with `page_id` set to
/// their owning page's id. Every seeded block carries the first-class
/// `blocks.space_id = SLO_SPACE_ID` column (#533, migration 0086) so the
/// canonical `b.space_id = ?` filter matches it.
///
/// ## Why this seeder exists separately from `seed_blocks_bulk`
///
/// The canonical space filter is `(?N IS NULL OR b.space_id = ?N)` (see
/// `space_filter_canonical.rs`): space membership is the `blocks.space_id`
/// column, not a `block_properties` row (`space` is a reserved key the
/// migration-0088 CHECK forbids there). A block only passes the filter if
/// its own `space_id` is set, so this seeder assigns it on every page and
/// content block; `batch_resolve` then measures real interactive-resolve
/// cost over a populated space rather than an empty result set.
///
/// Other benches in this file (`bench_list_blocks`, `bench_get_block`,
/// etc.) use `seed_blocks_bulk` + `assign_all_to_slo_space` (which now
/// sets `space_id` via UPDATE) because they either don't space-filter
/// (`get_block`) or paginate with `LIMIT 50` (`list_blocks`).
async fn seed_resolve_fixture(pool: &SqlitePool, n: usize) -> Vec<String> {
    // Density chosen to match the real-world shape: ~1 page per 100
    // content blocks gives 1000 pages at 100K total — close to the
    // Upper end of what telemetry sees in active vaults. Keep
    // PAGE_COUNT < FIXTURE_SIZE so the round-robin distribution
    // produces ≥1 block per page.
    const PAGE_COUNT: usize = 1_000;
    let blocks_per_page = n.div_ceil(PAGE_COUNT);

    let mut tx = pool.begin().await.unwrap();

    // The space-owner page + its `spaces` registry row (mirrors
    // `assign_all_to_slo_space`). `blocks.space_id` REFERENCES spaces(id)
    // (#708, migration 0089), so the owner must exist in `spaces` before the
    // pages/content below point their space_id at it.
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'SloSpace', NULL, NULL, ?)",
    )
    .bind(SLO_SPACE_ID)
    .bind(SLO_SPACE_ID)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SLO_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

    // Seed PAGE_COUNT pages. `page_id = id` matches the invariant
    // migration 0066 backfilled (every page-create path now sets this).
    let mut page_ids: Vec<String> = Vec::with_capacity(PAGE_COUNT);
    for p in 0..PAGE_COUNT {
        let page_id = format!("SLPG{p:020}");
        // Space membership is the first-class `blocks.space_id` column (#533,
        // migration 0086) — the canonical filter is `b.space_id = ?`; `space`
        // is a reserved key the 0088 CHECK forbids in `block_properties`.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, ?, ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Resolve fixture page {p}"))
        .bind(p as i64 + 1)
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
        let ts = SLO_BASE_TS_MS + i as i64;
        let owning_page = &page_ids[i % PAGE_COUNT];
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(owning_page)
        .bind(i as i64 + 1)
        .bind(owning_page)
        .bind(SLO_SPACE_ID)
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
        .bind(ts)
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
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Page {p}"))
        .bind(&page_id)
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

/// Deterministic, monotonic `op_log.created_at` (epoch ms) from a seq counter.
/// INTEGER since migration 0079 — see `SLO_BASE_TS_MS`. Strictly increasing in
/// `seq` so the most-recent-N op selectors see a stable order.
fn slo_history_ts_for(seq: i64) -> i64 {
    SLO_BASE_TS_MS + seq
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
        "INSERT INTO blocks (id, block_type, content, position, page_id) \
         VALUES (?, 'page', 'Bench Page', 1, ?)",
    )
    .bind(&page_id)
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let page_create_json = format!(
        r#"{{"block_id":"{page_id}","block_type":"page","parent_id":null,"position":1,"content":"Bench Page"}}"#
    );
    // op_log.block_id (indexed, migration 0030) must be set: the revert path's
    // `find_prior_text` filters edit/create ops by this column, not by
    // json_extract(payload). Unset → NULL → "no prior text found".
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?, ?)",
    )
    .bind(HISTORY_BENCH_DEVICE)
    .bind(seq)
    .bind(&page_create_json)
    .bind(slo_history_ts_for(seq))
    .bind(&page_id)
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
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?, ?)",
    )
    .bind(HISTORY_BENCH_DEVICE)
    .bind(seq)
    .bind(&child_create_json)
    .bind(slo_history_ts_for(seq))
    .bind(&block_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    let remaining = (total_ops as i64) - seq;
    for j in 0..remaining {
        seq += 1;
        let edit_json =
            format!(r#"{{"block_id":"{block_id}","to_text":"edit-{j}","prev_edit":null}}"#);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
             VALUES (?, ?, 'fakehash', 'edit_block', ?, ?, ?)",
        )
        .bind(HISTORY_BENCH_DEVICE)
        .bind(seq)
        .bind(&edit_json)
        .bind(slo_history_ts_for(seq))
        .bind(&block_id)
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
         (regression — see docs/architecture/operations.md § Product SLO)"
    );
    println!("interactive_slo: {cmd} = {mean_ms:.2} ms <= budget {budget_ms} ms (PASS)");
}

/// Skip-gate for problem commands. Returns `true` when the bench should
/// be skipped (the default for CI). Set `SLO_INCLUDE_PROBLEM=1` to run.
fn problem_skipped(cmd: &str) -> bool {
    if std::env::var("SLO_INCLUDE_PROBLEM").is_err() {
        println!(
            "interactive_slo: {cmd} SKIPPED (set SLO_INCLUDE_PROBLEM=1 to run; \
             aspirational budget — see docs/architecture/operations.md § Product SLO)"
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
                    let _ = get_block_inner(&pool, target_id.clone().into())
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
        // Free-form keys only: `priority` (and the other fixed props) are
        // column-backed on `blocks` and the 0088 CHECK forbids them here.
        for (k, v) in [("category", "high"), ("status", "active")] {
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
                    let _ = get_properties_inner(&pool, target_id.clone().into())
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
                    let _ = batch_resolve_inner(
                        &pool,
                        request_ids
                            .clone()
                            .into_iter()
                            .map(Into::into)
                            .collect::<Vec<_>>(),
                        &scope,
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
/// Budget: 100 ms (measured ~62 ms — "concerning at scale" tier).
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
                    let _ = count_backlinks_batch_inner(
                        &pool,
                        page_ids
                            .clone()
                            .into_iter()
                            .map(Into::into)
                            .collect::<Vec<agaric_lib::ulid::PageId>>(),
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

    assert_under_budget("count_backlinks_batch @ 100K", &acc, BUDGET_MS);
}

/// `export_page_markdown` — serialise a page with 2K children on top of
/// a 100K background DB. Budget: 10 ms (per §A's "export_page_markdown
/// (2K)" row, the scale parameter is *children of the exported page*).
fn bench_export_page_markdown(c: &mut Criterion) {
    const BUDGET_MS: f64 = 10.0;
    // Must be a valid ULID (Crockford base32, no I/L/O/U): export_page_markdown_inner
    // parses the page id as a ULID. "SLOEXPORT…" had invalid chars (L, O).
    const EXPORT_PAGE_ID: &str = "01SEXPRTPG0000000000000001";
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
/// 100K total ops in its history. Aspirational budget: 200 ms.
///
/// PROBLEM TIER (gated behind `SLO_INCLUDE_PROBLEM`): a faithful single
/// "50-op revert at 100K" measures ~1.2 s, ~6× over the 200 ms interactive
/// ceiling. The cost is dominated by the per-op `compute_reverse` walk + the
/// recursive-CTE op-log read, both O(log size). Until that read is made
/// sublinear (mirrors the `list_projected_agenda` gate), this stays gated so
/// the green tier isn't blocked by a known, tracked perf gap.
///
/// Phase 2 §B.1 gate for `history_bench::bench_revert_ops_50op`; `revert` is
/// bulk-write but user-initiated (Cmd+Z over a selection), so it belongs in
/// the interactive tier once its read path is optimized.
fn bench_revert_ops_50op_at_100k(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;
    const TOTAL_OPS: usize = 100_000;

    if problem_skipped("revert_ops (50op) @ 100K") {
        return;
    }

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

/// `list_page_links` — graph-view roll-up. PROBLEM TIER (gated behind
/// `SLO_INCLUDE_PROBLEM`): a warm measurement is ~530 ms at 100K, ~2.6× over
/// the 200 ms budget (3-JOIN superlinearity; see docs/architecture/operations.md
/// § Product SLO known-exceeds-budget note). The SQL-review §H-2 `page_link_cache`
/// rollup (migration 0065) helped but did NOT bring it under budget — this was
/// never verified because the bench was never actually run until now (#1233).
/// Re-gated so the green tier isn't blocked by this tracked perf gap.
fn bench_list_page_links(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;

    if problem_skipped("list_page_links @ 100K") {
        return;
    }
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
/// **Currently ~620 ms** (O(n×m) in-memory expansion; see
/// docs/architecture/operations.md § Product SLO known-exceeds-budget note).
///
/// TODO: drop the `problem_skipped` gate once the SQL/CTE pushdown lands.
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
