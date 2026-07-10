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

/// #2508 scope item 1 — distinct tag count for `bench_tags_cache_direct_query`'s
/// fixture. Spreading `FIXTURE_SIZE` tagged blocks across this many tags gives
/// `DESIRED_TAGS_SQL`'s `GROUP BY tag_id` a realistic number of groups (not one
/// dominant tag skewing the scan).
const TAGS_CACHE_TAG_COUNT: usize = 500;

/// #2508 scope item 1 — page/children shape for
/// `bench_pages_cache_counts_direct_query`'s fixture.
/// `PAGES_CACHE_FIXTURE_PAGES * (PAGES_CACHE_CHILDREN_PER_PAGE + 1) == FIXTURE_SIZE`
/// (10_000 pages × 10 blocks/page = 100_000) so the DB is at the same
/// 100K-block SLO scale as every other bench in this file.
const PAGES_CACHE_FIXTURE_PAGES: usize = 10_000;
const PAGES_CACHE_CHILDREN_PER_PAGE: usize = 9;

/// #2508 scope item 1 — "a representative page set (e.g. 50 pages like a
/// Pages-view page)" per the issue's scope description.
const PAGES_CACHE_SAMPLE_SIZE: usize = 50;

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

/// #2508 scope item 1 — attach `TAGS_CACHE_TAG_COUNT` tag blocks to the given
/// (already-seeded) content block ids, split across BOTH `block_tags`
/// (explicit tagging) and `block_tag_refs` (inline `#[ULID]` refs) so
/// `DESIRED_TAGS_SQL`'s `UNION` in `bench_tags_cache_direct_query` scans real
/// rows from both source tables, not just one. Even-indexed blocks get a
/// `block_tags` row, odd-indexed blocks get a `block_tag_refs` row; every tag
/// ends up with nonzero usage spread over many distinct blocks (round-robin
/// assignment), matching the "no cache row is a lonely zero-usage tag" shape
/// `DESIRED_TAGS_SQL`'s `LEFT JOIN … COALESCE` has to handle either way.
async fn seed_tags_with_usage(
    pool: &SqlitePool,
    block_ids: &[String],
    n_tags: usize,
) -> Vec<String> {
    let mut tx = pool.begin().await.unwrap();
    let mut tag_ids = Vec::with_capacity(n_tags);
    for i in 0..n_tags {
        let tag_id = format!("SLOTAG{i:018}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'tag', ?, ?)",
        )
        .bind(&tag_id)
        .bind(format!("tag{i}"))
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
        tag_ids.push(tag_id);
    }
    for (i, block_id) in block_ids.iter().enumerate() {
        let tag_id = &tag_ids[i % n_tags];
        if i % 2 == 0 {
            sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(block_id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await
                .unwrap();
        } else {
            sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
                .bind(block_id)
                .bind(tag_id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    tx.commit().await.unwrap();
    tag_ids
}

/// #2508 scope item 1 — fixture for `bench_pages_cache_counts_direct_query`.
/// Seeds `n_pages` page blocks, each with `children_per_page` child blocks
/// whose `page_id` points back at the owning page (the column the
/// `child_block_count` subselect in
/// `materializer/handlers/pages_cache.rs:104-120` filters on — plain
/// `seed_pages_with_links`-style children don't set `page_id`, which would
/// make that subselect scan zero rows). Every page's first child also links
/// to 3 OTHER pages' own block ids (round-robin), so `inbound_link_count`
/// sees real cross-page `block_links` rows with a live, non-NULL,
/// different-page `src.page_id` — the exact shape that subselect's `WHERE
/// src.page_id != pages_cache.page_id` filter is selecting for. Returns the
/// page ids in seed order.
async fn seed_pages_cache_fixture(
    pool: &SqlitePool,
    n_pages: usize,
    children_per_page: usize,
) -> Vec<String> {
    let mut tx = pool.begin().await.unwrap();
    let mut page_ids = Vec::with_capacity(n_pages);
    let mut first_child_of = Vec::with_capacity(n_pages);
    let mut child_counter: usize = 0;
    for i in 0..n_pages {
        let page_id = format!("SLOPGC{i:018}");
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

        let mut first_child: Option<String> = None;
        for c in 0..children_per_page {
            let child_id = format!("SLOCHC{child_counter:018}");
            child_counter += 1;
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'content', ?, ?, ?, ?)",
            )
            .bind(&child_id)
            .bind(format!("Child {c} of page {i}"))
            .bind(&page_id)
            .bind(c as i64 + 1)
            .bind(&page_id)
            .execute(&mut *tx)
            .await
            .unwrap();
            if first_child.is_none() {
                first_child = Some(child_id);
            }
        }
        first_child_of.push(first_child);
        page_ids.push(page_id);
    }
    for (i, first_child) in first_child_of.iter().enumerate() {
        let Some(source_child) = first_child else {
            continue;
        };
        for offset in 1..=3 {
            let target_idx = (i + offset) % n_pages;
            if target_idx == i {
                continue;
            }
            sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
                .bind(source_child)
                .bind(&page_ids[target_idx])
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    tx.commit().await.unwrap();
    page_ids
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

/// Skip-gate keyed on an env var. Returns `true` (skip) unless `env_var`
/// is set. The message names the exact variable so the log tells a reader
/// how to enable the bench.
fn gate_skipped(cmd: &str, env_var: &str) -> bool {
    if std::env::var(env_var).is_err() {
        println!(
            "interactive_slo: {cmd} SKIPPED (set {env_var}=1 to run; \
             aspirational budget — see docs/architecture/operations.md § Product SLO)"
        );
        true
    } else {
        false
    }
}

/// Skip-gate for the confirmable problem-tier probes (`list_page_links` /
/// `list_projected_agenda`, #2178) that the `bench-slo` workflow measures via
/// `slo_include_problem`. Set `SLO_INCLUDE_PROBLEM=1` to run.
fn problem_skipped(cmd: &str) -> bool {
    gate_skipped(cmd, "SLO_INCLUDE_PROBLEM")
}

/// Problem-tier budget failures deferred to `problem_tier_verdict` so ONE
/// `slo_include_problem=true` dispatch measures EVERY probe before the bench
/// fails (#2298 — previously the first over-budget probe panicked and the
/// remaining probes were never measured).
static PROBLEM_TIER_FAILURES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Like `assert_under_budget`, but records an over-budget result instead of
/// panicking, so later problem-tier probes still run. The over-budget line is
/// still printed immediately in the exact grep-stable
/// `interactive_slo: {cmd} = … > budget …` format log consumers depend on;
/// `problem_tier_verdict` fails the bench at the end if anything was recorded.
fn assert_under_budget_deferred(cmd: &str, acc: &Acc, budget_ms: f64) {
    let iters = acc.iters();
    assert!(
        iters > 0,
        "interactive_slo: {cmd} ran zero iterations (Criterion harness bug?)"
    );
    let mean_ms = (acc.total().as_secs_f64() * 1000.0) / iters as f64;
    if mean_ms <= budget_ms {
        println!("interactive_slo: {cmd} = {mean_ms:.2} ms <= budget {budget_ms} ms (PASS)");
    } else {
        let line = format!(
            "interactive_slo: {cmd} = {mean_ms:.2} ms > budget {budget_ms} ms (regression — see docs/architecture/operations.md § Product SLO)"
        );
        println!("{line}");
        PROBLEM_TIER_FAILURES.lock().unwrap().push(line);
    }
}

/// Final member of the `slo_problem` group: fails the bench run iff any
/// deferred problem-tier probe exceeded its budget. Runs after every probe,
/// so a single dispatch yields the complete problem-tier dataset (#2298).
fn problem_tier_verdict(_c: &mut Criterion) {
    let failures = PROBLEM_TIER_FAILURES.lock().unwrap();
    assert!(
        failures.is_empty(),
        "interactive_slo: {n} problem-tier probe(s) over budget:\n{list}",
        n = failures.len(),
        list = failures.join("\n")
    );
}

/// Skip-gate for `revert_ops @ 100K`. This is a *permanently* known-over-budget
/// bench (~6× the 200 ms ceiling; see its doc) with no near-term promotion path,
/// so it must NOT ride the shared `SLO_INCLUDE_PROBLEM` flag — otherwise
/// enabling that flag to measure the #2178 probes would drag this bench in and
/// guarantee a red job (both a pool-saturation panic and the budget breach).
/// It gets its own dedicated `SLO_INCLUDE_REVERT` gate, which the scheduled
/// workflow never sets.
fn revert_gate_skipped(cmd: &str) -> bool {
    gate_skipped(cmd, "SLO_INCLUDE_REVERT")
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
        });
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
        });
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
        });
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
        });
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
        });
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
        });
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
        });
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
            });
        });
    }
    group.finish();

    assert_under_budget("create_block @ 100K", &acc, BUDGET_MS);
}

/// `revert_ops_inner` — 50-op batch revert against a single page with
/// 100K total ops in its history. Aspirational budget: 200 ms.
///
/// PROBLEM TIER (gated behind its OWN `SLO_INCLUDE_REVERT`, NOT the shared
/// `SLO_INCLUDE_PROBLEM`): a faithful single "50-op revert at 100K" measures
/// ~1.2 s, ~6× over the 200 ms interactive ceiling. The cost is dominated by
/// the per-op `compute_reverse` walk + the recursive-CTE op-log read, both
/// O(log size). Until that read is made sublinear (mirrors the
/// `list_projected_agenda` gate), this stays gated so the green tier isn't
/// blocked by a known, tracked perf gap.
///
/// It gets a dedicated gate so that enabling `SLO_INCLUDE_PROBLEM` to measure
/// the confirmable #2178 probes (`list_page_links` / `list_projected_agenda`)
/// does not also un-gate this permanently-over-budget bench — which would both
/// saturate the bench pool (`PoolTimedOut`) and breach the budget, guaranteeing
/// a red job every time someone gathers the #2178 numbers.
///
/// Phase 2 §B.1 gate for `history_bench::bench_revert_ops_50op`; `revert` is
/// bulk-write but user-initiated (Cmd+Z over a selection), so it belongs in
/// the interactive tier once its read path is optimized.
fn bench_revert_ops_50op_at_100k(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;
    const TOTAL_OPS: usize = 100_000;

    if revert_gate_skipped("revert_ops (50op) @ 100K") {
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
            });
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
///
/// #2070: migration 0096 denormalised the residual `deleted_at` /
/// `block_type = 'page'` predicates into the cache flags so the unscoped read
/// is now a single `idx_page_link_cache_live` scan with ZERO `blocks` joins.
/// The under-budget win is EXPECTED but not yet confirmed — the 100K bench is
/// not runnable in the dev sandbox, so it must be verified on the nightly
/// bench-compile lane (`SLO_INCLUDE_PROBLEM=1`). The skip-gate therefore stays
/// IN PLACE here — this PR does not promote the row to the green tier; that
/// flip is a separate change once the nightly lane confirms the budget.
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
                    // #2298: returns `PageLinksResponse` — the edge set is
                    // capped at PAGE_LINKS_EDGE_CAP (count-then-cap), so at
                    // 100K this measures the capped read + true-total COUNT.
                    let _ = list_page_links_inner(&pool, &SpaceScope::Global, None)
                        .await
                        .unwrap();
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        });
    });
    group.finish();

    assert_under_budget_deferred("list_page_links @ 100K", &acc, BUDGET_MS);
}

/// `list_projected_agenda` — repeating-task projection over 100K rows.
/// **Was ~620 ms** (O(n×m) in-memory expansion; see
/// docs/architecture/operations.md § Product SLO known-exceeds-budget note).
///
/// #2069: the "push the date-range projection into SQL" framing in the
/// issue is INFEASIBLE — the recurrence grammar (sticky monthly clamp,
/// `.+` / `++` today-anchored catch-up, 10K safety bound, 1900-2200 rail)
/// is stateful Rust (`crate::recurrence`), so it cannot be a recursive-CTE
/// / `generate_series` rewrite. Instead the on-the-fly fallback
/// (`list_projected_agenda_on_the_fly`) now carries a superset date-overlap
/// PREFILTER that drops blocks which provably cannot project into
/// `[range_start, range_end]` BEFORE the Rust expansion, shrinking the
/// expansion set. The 100K bench is not runnable in this environment, so
/// the `problem_skipped` gate stays IN PLACE — SLO confirmation is deferred
/// to the nightly lane, which runs the real 100K fixture against the budget.
///
/// TODO: drop the `problem_skipped` gate once the nightly lane confirms the
/// #2069 prefilter brings `list_projected_agenda @ 100K` under the 200ms SLO.
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
        });
    });
    group.finish();

    assert_under_budget_deferred("list_projected_agenda @ 100K", &acc, BUDGET_MS);
}

/// #2508 scope item 1 — the `DESIRED_TAGS_SQL` projection from
/// `src/cache/tags.rs:70-87`, copied VERBATIM (that const is private to the
/// crate's `cache::tags` module, so a bench binary — a separate crate root —
/// cannot `use` it directly; keep this in sync with the source if it
/// changes). This is the query `tags_cache` denormalizes: a `GROUP BY` over
/// `block_tags ∪ block_tag_refs` joined to live tag blocks.
///
/// **Direction of measurement**: this times the query as a plain read — it
/// never writes `tags_cache` — so the nightly 100K lane can compare this
/// number against the cache's read/write-amplification cost and produce the
/// #2508 keep-vs-drop verdict on whether `tags_cache` is still worth
/// maintaining or whether callers could just run this SELECT live.
const SLO_TAGS_CACHE_DIRECT_SQL: &str = "SELECT b.id, b.content, COALESCE(t.cnt, 0) AS cnt
             FROM blocks b
             LEFT JOIN (
                 SELECT tag_id, COUNT(*) AS cnt FROM (
                     SELECT bt.tag_id, bt.block_id
                     FROM block_tags bt
                     JOIN blocks blk ON blk.id = bt.block_id
                     WHERE blk.deleted_at IS NULL
                     UNION
                     SELECT btr.tag_id, btr.source_id AS block_id
                     FROM block_tag_refs btr
                     JOIN blocks blk ON blk.id = btr.source_id
                     WHERE blk.deleted_at IS NULL
                 )
                 GROUP BY tag_id
             ) t ON t.tag_id = b.id
             WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL
             ORDER BY b.id ASC";

/// #2508 scope item 1 — the two `pages_cache` count subselects from
/// `materializer/handlers/pages_cache.rs:104-120`
/// (`recompute_pages_cache_counts_for_pages`), adapted from an `UPDATE
/// pages_cache SET … WHERE page_id IN (…)` into a plain `SELECT … FROM
/// blocks p WHERE p.id IN (…)` — same two correlated subqueries, same
/// predicates, just read instead of written, and rooted on `blocks` (the
/// live source of truth) instead of the cache table itself so this measures
/// the direct computation `pages_cache.inbound_link_count` /
/// `child_block_count` denormalize. The `json_each(?)` id-list binding
/// mirrors the production function's own batching idiom.
const SLO_PAGES_CACHE_COUNTS_DIRECT_SQL: &str = "SELECT p.id AS page_id, \
    ( \
        SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
            JOIN blocks descendant ON bl.target_id = descendant.id \
            JOIN blocks src ON src.id = bl.source_id \
            WHERE descendant.page_id = p.id \
              AND descendant.deleted_at IS NULL \
              AND src.deleted_at IS NULL \
              AND src.page_id IS NOT NULL \
              AND src.page_id != p.id \
    ) AS inbound_link_count, \
    ( \
        SELECT COUNT(*) FROM blocks descendant \
            WHERE descendant.page_id = p.id \
              AND descendant.deleted_at IS NULL \
              AND descendant.id != p.id \
    ) AS child_block_count \
    FROM blocks p \
    WHERE p.id IN (SELECT value FROM json_each(?))";

/// `tags_cache` direct query — #2508 scope item 1. PROBLEM TIER (gated
/// behind `SLO_INCLUDE_PROBLEM`, same `#2178`-style "confirmable probe"
/// idiom as `bench_list_page_links`/`bench_list_projected_agenda`): this is
/// a NEW measurement probe, not a known-over-budget command, but #2508
/// notes the 100K fixture isn't runnable in this dev sandbox, so it rides
/// the same nightly-only gate rather than claiming an unverified green
/// pass. `SLO_INCLUDE_PROBLEM=1 cargo bench --bench interactive_slo` (the
/// scheduled `bench-slo` workflow) produces the real 100K measurement this
/// scope item asks for.
fn bench_tags_cache_direct_query(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;

    if problem_skipped("tags_cache direct query @ 100K") {
        return;
    }
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_tags_cache_direct"));
    let ids = rt.block_on(seed_blocks_bulk(&pool, FIXTURE_SIZE));
    rt.block_on(seed_tags_with_usage(&pool, &ids, TAGS_CACHE_TAG_COUNT));

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("tags_cache_direct_query_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let rows = sqlx::query(SLO_TAGS_CACHE_DIRECT_SQL)
                        .fetch_all(&pool)
                        .await
                        .unwrap();
                    assert!(
                        !rows.is_empty(),
                        "tags_cache direct query returned no rows — seeding bug"
                    );
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        });
    });
    group.finish();

    assert_under_budget_deferred("tags_cache direct query @ 100K", &acc, BUDGET_MS);
}

/// `pages_cache` counts direct query — #2508 scope item 1. PROBLEM TIER
/// (gated behind `SLO_INCLUDE_PROBLEM`; see `bench_tags_cache_direct_query`
/// doc for why a new #2508 probe rides this gate rather than an unverified
/// green claim). Runs the live `inbound_link_count` +
/// `child_block_count` computation as a plain `SELECT` (never an `UPDATE`)
/// for a 50-page sample — "a representative page set … like a Pages-view
/// page" per the issue's scope description.
fn bench_pages_cache_counts_direct_query(c: &mut Criterion) {
    const BUDGET_MS: f64 = 200.0;

    if problem_skipped("pages_cache counts direct query @ 100K") {
        return;
    }
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "slo_pages_cache_counts_direct"));
    let page_ids = rt.block_on(seed_pages_cache_fixture(
        &pool,
        PAGES_CACHE_FIXTURE_PAGES,
        PAGES_CACHE_CHILDREN_PER_PAGE,
    ));
    let stride = page_ids.len() / PAGES_CACHE_SAMPLE_SIZE;
    let sample_pages: Vec<&String> = page_ids
        .iter()
        .step_by(stride)
        .take(PAGES_CACHE_SAMPLE_SIZE)
        .collect();
    let sample_json = serde_json::to_string(&sample_pages).unwrap();

    let mut group = c.benchmark_group("interactive_slo");
    group.sample_size(SAMPLE_SIZE);
    let acc = Acc::new();
    let acc_for_bench = acc.clone();

    group.bench_function("pages_cache_counts_direct_query_100k", move |b| {
        let acc = acc_for_bench.clone();
        let pool = pool.clone();
        let sample_json = sample_json.clone();
        b.to_async(&rt).iter_custom(move |iters| {
            let pool = pool.clone();
            let acc = acc.clone();
            let sample_json = sample_json.clone();
            async move {
                let start = Instant::now();
                for _ in 0..iters {
                    let rows = sqlx::query(SLO_PAGES_CACHE_COUNTS_DIRECT_SQL)
                        .bind(&sample_json)
                        .fetch_all(&pool)
                        .await
                        .unwrap();
                    assert_eq!(
                        rows.len(),
                        PAGES_CACHE_SAMPLE_SIZE,
                        "pages_cache counts direct query returned unexpected row count"
                    );
                }
                let elapsed = start.elapsed();
                acc.record(elapsed, iters);
                elapsed
            }
        });
    });
    group.finish();

    assert_under_budget_deferred("pages_cache counts direct query @ 100K", &acc, BUDGET_MS);
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
    bench_tags_cache_direct_query,
    bench_pages_cache_counts_direct_query,
    problem_tier_verdict,
);

criterion_main!(slo_green, slo_problem);
