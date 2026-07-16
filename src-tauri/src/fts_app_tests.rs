//! App-layer FTS tests -- the partitioned / cursor search suites relocated out
//! of `agaric_store::fts`'s `tests.rs` (#2621, wave S4d). These call the
//! app-only command inner functions
//! (`crate::commands::queries::{search_blocks_partitioned_inner,
//! search_blocks_inner}`), which live above the store layer and cannot move
//! down with the FTS module. The pure FTS unit tests (strip / index / toggle /
//! filter semantics) moved with the module and stay in
//! `agaric_store::fts::tests`. The FTS seed entry point (`rebuild_fts_index`)
//! and the internal caps these tests assert against (`MAX_SEARCH_RESULTS`,
//! `MAX_QUERY_LEN`) are reached through the store's public surface. Behaviour
//! is unchanged from the pre-move `fts/tests.rs`; helpers and fixture
//! constants are copied verbatim from there.

use agaric_core::error::AppError;
use agaric_store::fts::{MAX_SEARCH_RESULTS, rebuild_fts_index};
use agaric_store::space::{SpaceId, SpaceScope};
use sqlx::SqlitePool;
use tempfile::TempDir;

// -- Fixture constants (copied verbatim from the pre-move fts/tests.rs) --
const BLOCK_A: &str = "01HQBLKA00000000000000BKA1";

const FTS_SPACE_A_ID: &str = "FTS_SPC_A";

const FTS_SPACE_B_ID: &str = "FTS_SPC_B";

const PT_PAGE_IDS: [&str; 5] = [
    "01HQPART01PAGE000000000P01",
    "01HQPART02PAGE000000000P02",
    "01HQPART03PAGE000000000P03",
    "01HQPART04PAGE000000000P04",
    "01HQPART05PAGE000000000P05",
];

const PT_BLOCK_IDS: [&str; 5] = [
    "01HQPART01BANK000000000B01",
    "01HQPART02BANK000000000B02",
    "01HQPART03BANK000000000B03",
    "01HQPART04BANK000000000B04",
    "01HQPART05BANK000000000B05",
];

// -- Helpers (copied verbatim from the pre-move fts/tests.rs) --

// ── Helpers ──────────────────────────────────────────────────────────

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = crate::db::init_pool(&db_path).await.unwrap();
    (pool, dir)
}

async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    // `page_id = id` for page blocks per the §5.3 invariant (migration
    // 0066); content blocks inherit page_id from their parent at write
    // time in production, but this test fixture inlines the safe default.
    let page_id = if block_type == "page" {
        Some(id)
    } else {
        parent_id
    };
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a space block (a page carrying `is_space = 'true'`). Required
/// so the FK on `blocks.space_id` validates when the tests assign a page
/// to the space.
async fn insert_space_block_for_fts(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

/// Assign a block to a space by stamping the denormalized `blocks.space_id`
/// column directly — bypasses the command layer because the test targets
/// the FTS filter SQL, not op-log semantics.
async fn assign_to_space_for_fts(pool: &SqlitePool, block_id: &str, space_id: &str) {
    // #533: stamp the denormalized `blocks.space_id` column the FTS filter
    // reads (every block whose owning page is `block_id`).
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(space_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Generate a unique 26-character ULID-shaped id under the
/// `01HQPART…` namespace for partitioned tests that need more rows
/// than the fixed `PT_*` arrays carry. The shape is not a valid
/// Crockford ULID but `insert_block` only requires uniqueness — see
/// the constants' docstring above.
fn pt_block_id(index: u32) -> String {
    format!("01HQPARTGEN{index:015}")
}

/// Seed `n_pages` page blocks and `n_blocks` content blocks, all
/// matching the FTS keyword `partitioned`. Returns when the FTS
/// index is up to date.
async fn seed_partitioned_fixture(pool: &SqlitePool, n_pages: usize, n_blocks: usize) {
    assert!(n_pages <= PT_PAGE_IDS.len(), "n_pages exceeds fixture ids");
    assert!(
        n_blocks <= PT_BLOCK_IDS.len(),
        "n_blocks exceeds fixture ids"
    );
    for (i, id) in PT_PAGE_IDS.iter().take(n_pages).enumerate() {
        // Pages carry the search keyword in their title so the FTS
        // hit is a page-title-only match.
        insert_block(
            pool,
            id,
            "page",
            &format!("partitioned page title {i}"),
            None,
            Some(i64::try_from(i).unwrap()),
        )
        .await;
    }
    for (i, id) in PT_BLOCK_IDS.iter().take(n_blocks).enumerate() {
        // Content blocks live under the first page so their `page_id`
        // resolves to a real row — keeps space-filter joins happy.
        let parent = if n_pages > 0 {
            Some(PT_PAGE_IDS[0])
        } else {
            None
        };
        insert_block(
            pool,
            id,
            "content",
            &format!("partitioned block content {i}"),
            parent,
            Some(i64::try_from(i + n_pages).unwrap()),
        )
        .await;
    }
    rebuild_fts_index(pool).await.unwrap();
}

// ======================================================================
// Search backend test coverage matrix
// ======================================================================
//
// Stress / edge-case coverage for the partitioned search IPC:
//
// 1. Concurrent IPC — `tokio::join!`-style fan-out + tail-latency bound.
// 2. Pathological queries — 100KB long-query short-circuit, 12-field
//    populated filter struct.
// 3. Empty / giant space — zero-row partitioned scan; 10k-block fixture
//    wall-time bound.
// 4. Boolean + toggle combinations — case_sensitive + OR, whole_word +
//    AND, regex alternation, invalid-regex validation error mapping.
//
// All tests use the existing `test_pool()` + `TempDir` pattern (per
// `src-tauri/tests/AGENTS.md`); wall-clock bounds are anchored to
// measured-local baselines × 3 headroom (see project memory note
// "Measure, don't imagine"). No sleep-loop polling.

/// Seed a "giant" partitioned fixture: 1 root page + `n_blocks`
/// content blocks all matching the FTS keyword `partitioned`. The shape
/// is chosen so a single FTS scan returns up to `MAX_SEARCH_RESULTS` rows
/// — enough to exercise the partitioned dispatch on a non-trivial corpus
/// without exploding wall-time in unrelated CI runs.
///
/// Generated IDs follow the `pt_block_id` 26-char ULID shape; uniqueness
/// is the only DB-level constraint.
async fn seed_giant_fixture(pool: &SqlitePool, n_blocks: u32) {
    let root = pt_block_id(0);
    insert_block(
        &pool.clone(),
        &root,
        "page",
        "partitioned giant root page",
        None,
        Some(0),
    )
    .await;
    // Single transaction so the 10k inserts don't fan out into per-row
    // fsyncs. Mirrors the bulk-insert pattern in
    // `search_fts_partition_max_search_results_ceiling`.
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=n_blocks {
        let id = pt_block_id(i);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(format!("partitioned giant row {i}"))
        .bind(&root)
        .bind(i64::from(i))
        .bind(&root)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    rebuild_fts_index(pool).await.unwrap();
}

// ======================================================================
// Cancellation + slow-query logging tests
// ======================================================================

/// Seed a 100+ row "heavy" FTS fixture so the bench-sized scan takes
/// long enough that a racing cancel signal has a reasonable chance to
/// win the `tokio::select!` arm. The exact row count exceeds
/// `MAX_SEARCH_RESULTS` (100) — under load this saturates the
/// configured fetch ceiling and forces the SQL builder to walk the
/// trigram index for a measurable number of rows.
async fn seed_heavy_partitioned_fixture(pool: &SqlitePool, n_blocks: u32) {
    let root = pt_block_id(0);
    insert_block(
        pool,
        &root,
        "page",
        "partitioned cancel root",
        None,
        Some(0),
    )
    .await;
    for i in 1..=n_blocks {
        let id = pt_block_id(i);
        insert_block(
            pool,
            &id,
            "content",
            &format!("partitioned cancellation row {i}"),
            Some(&root),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(pool).await.unwrap();
}

// `LogBuf` — in-process tracing capture writer (copied verbatim from the
// pre-move fts/tests.rs) used by `slow_acquire_logs_warning`.
/// writer so we can capture emitted log lines in-process. Mirrors the
/// shape used in `db.rs::tests`.
#[derive(Clone, Default)]
struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl LogBuf {
    fn contents(&self) -> String {
        let bytes = self.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

// -- Relocated command-coupled tests --

#[tokio::test]
async fn partitioned_happy_path_pages_and_blocks_within_caps() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        2,
        3,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        2,
        "pages partition must cap at page_limit"
    );
    assert_eq!(
        resp.blocks.items.len(),
        3,
        "blocks partition must cap at block_limit"
    );
    // Pages partition contains only page-typed rows.
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "pages partition must contain only block_type='page' rows"
        );
    }
    // Neither partition emits a cursor.
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
    assert!(resp.pages.total_count.is_none());
    assert!(resp.blocks.total_count.is_none());
}

#[tokio::test]
async fn partitioned_pages_partition_is_page_typed_only_with_mixed_types() {
    let (pool, _dir) = test_pool().await;
    // Mixed: 3 pages, 5 content blocks.
    seed_partitioned_fixture(&pool, 3, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        3,
        "pages partition must surface all 3 page-typed rows"
    );
    for row in &resp.pages.items {
        assert_eq!(row.block_type, "page");
    }
}

#[tokio::test]
async fn partitioned_blocks_partition_is_unrestricted() {
    let (pool, _dir) = test_pool().await;
    // 3 pages + 2 content blocks → 5 total. `blocks` cap = 10 → all 5
    // survive; the partition must include page-typed entries
    // alongside the content blocks (this is the documented
    // "unrestricted" semantics).
    seed_partitioned_fixture(&pool, 3, 2).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.blocks.items.len(),
        5,
        "blocks partition is unrestricted — must include both pages and content"
    );
    let pages_in_blocks = resp
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "page")
        .count();
    let content_in_blocks = resp
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .count();
    assert_eq!(pages_in_blocks, 3, "blocks partition must contain pages");
    assert_eq!(
        content_in_blocks, 2,
        "blocks partition must contain content blocks"
    );
}

#[tokio::test]
async fn partitioned_caps_honour_each_partition_limit() {
    let (pool, _dir) = test_pool().await;
    // 5 pages, 5 content → caps at 1/1 must return exactly 1+1.
    seed_partitioned_fixture(&pool, 5, 5).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        1,
        1,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.pages.items.len(), 1, "page_limit=1 must clip to 1");
    assert_eq!(resp.blocks.items.len(), 1, "block_limit=1 must clip to 1");
}

#[tokio::test]
async fn partitioned_has_more_flags_reflect_partition_overflow() {
    let (pool, _dir) = test_pool().await;
    // 5 pages, 5 content → 10 matching rows in the scan.
    seed_partitioned_fixture(&pool, 5, 5).await;

    // Case A — both caps under the available count. Both partitions
    // must report `has_more = true`.
    let tight = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        2,
        3,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();
    assert!(
        tight.pages.has_more,
        "pages.has_more must be true when more page-typed rows existed beyond the cap"
    );
    assert!(
        tight.blocks.has_more,
        "blocks.has_more must be true when more rows existed beyond the cap"
    );

    // Case B — caps exceed the available row count. Both partitions
    // must report `has_more = false`.
    let loose = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        20,
        20,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();
    assert!(
        !loose.pages.has_more,
        "pages.has_more must be false when fewer pages existed than the cap"
    );
    assert!(
        !loose.blocks.has_more,
        "blocks.has_more must be false when fewer rows existed than the cap"
    );
}

#[tokio::test]
async fn partitioned_empty_query_returns_empty_partitions() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 2, 2).await;

    for q in ["", "   ", "\t\n"] {
        let resp = crate::commands::queries::search_blocks_partitioned_inner(
            &pool,
            q.to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await
        .unwrap();
        assert!(
            resp.pages.items.is_empty(),
            "empty/whitespace query must yield empty pages partition (q={q:?})"
        );
        assert!(
            resp.blocks.items.is_empty(),
            "empty/whitespace query must yield empty blocks partition (q={q:?})"
        );
        assert!(!resp.pages.has_more);
        assert!(!resp.blocks.has_more);
    }

    // Also cover the empty-space case: a non-empty query
    // against a space that has zero matching rows must yield two
    // empty partitions with `has_more=false`. Exercises the
    // post-`MATCH` filter path (FTS5 returns rows that are then
    // filtered out by the space predicate), proving the two-scan
    // partition machinery doesn't synthesise phantom `has_more`
    // signals on an empty result.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Empty Space").await;
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            scope: SpaceScope::Active(SpaceId::from_trusted(FTS_SPACE_A_ID)),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        resp.pages.items.is_empty(),
        "zero-page space must yield empty pages partition"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "zero-page space must yield empty blocks partition"
    );
    assert!(
        !resp.pages.has_more,
        "empty-space query must not signal pages.has_more"
    );
    assert!(
        !resp.blocks.has_more,
        "empty-space query must not signal blocks.has_more"
    );
}

#[tokio::test]
async fn partitioned_ignores_block_type_filter_in_filter_struct() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let baseline = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    let with_filter = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            // Phase 1: this field MUST be ignored — partitioning
            // by block_type is what the IPC does.
            block_type_filter: Some("page".to_string()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        baseline.pages.items.len(),
        with_filter.pages.items.len(),
        "block_type_filter must not affect the pages partition cardinality"
    );
    assert_eq!(
        baseline.blocks.items.len(),
        with_filter.blocks.items.len(),
        "block_type_filter must not affect the blocks partition cardinality"
    );
    // The blocks partition must still contain content-typed rows
    // even when the caller passed `block_type_filter=Some("page")`.
    let content_count = with_filter
        .blocks
        .items
        .iter()
        .filter(|r| r.block_type == "content")
        .count();
    assert!(
        content_count > 0,
        "block_type_filter must not narrow the unrestricted blocks partition"
    );
}

#[tokio::test]
async fn partitioned_space_filter_excludes_other_spaces_from_both_partitions() {
    let (pool, _dir) = test_pool().await;
    // Two spaces, both with a matching page in each. The FTS5 space
    // filter is applied against `b.page_id IN (… key='space' …)` —
    // the partitioned scan must inherit it from the same dynamic-SQL
    // builder used by `search_fts`.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    insert_space_block_for_fts(&pool, FTS_SPACE_B_ID, "Work").await;

    let page_in_a = PT_PAGE_IDS[0];
    let page_in_b = PT_PAGE_IDS[1];
    insert_block(
        &pool,
        page_in_a,
        "page",
        "partitioned page in space a",
        None,
        Some(1),
    )
    .await;
    assign_to_space_for_fts(&pool, page_in_a, FTS_SPACE_A_ID).await;
    insert_block(
        &pool,
        page_in_b,
        "page",
        "partitioned page in space b",
        None,
        Some(2),
    )
    .await;
    assign_to_space_for_fts(&pool, page_in_b, FTS_SPACE_B_ID).await;

    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            scope: SpaceScope::Active(SpaceId::from_trusted(FTS_SPACE_A_ID)),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    let ids_pages: Vec<&str> = resp.pages.items.iter().map(|r| r.id.as_str()).collect();
    let ids_blocks: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids_pages.contains(&page_in_a),
        "pages partition must include the SPACE_A row (invariant): {ids_pages:?}"
    );
    assert!(
        !ids_pages.contains(&page_in_b),
        "pages partition must exclude rows from other spaces: {ids_pages:?}"
    );
    assert!(
        ids_blocks.contains(&page_in_a),
        "blocks partition must include the SPACE_A row: {ids_blocks:?}"
    );
    assert!(
        !ids_blocks.contains(&page_in_b),
        "blocks partition must exclude rows from other spaces: {ids_blocks:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_mode_routes_through_partitioned_dispatch() {
    // `search_with_toggles_partitioned` dispatches `is_regex=true` through
    // a separate path (`regex_mode_query`) rather than the FTS scan.
    // This test verifies that branch partitions rows correctly — pages
    // stay page-typed-only and the blocks partition is unrestricted.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partition".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    // Seeded content carries the substring "partitioned" → regex /partition/
    // matches all 6 rows (3 pages + 3 content blocks).
    assert_eq!(
        resp.pages.items.len(),
        3,
        "regex-mode pages partition must surface all matching page-typed rows"
    );
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "regex-mode pages partition must be page-typed-only"
        );
    }
    assert_eq!(
        resp.blocks.items.len(),
        6,
        "regex-mode blocks partition is unrestricted (includes pages)"
    );
}

#[tokio::test]
async fn partitioned_zero_limits_yield_empty_partitions_and_no_has_more() {
    // Degenerate `page_limit=0` / `block_limit=0` must yield empty
    // partitions without `has_more=true` (the `page_limit_usize > 0`
    // guard on `pages_filled` is what prevents the degenerate true).
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        0,
        0,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert!(
        resp.pages.items.is_empty(),
        "page_limit=0 must yield no items"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "block_limit=0 must yield no items"
    );
    assert!(
        !resp.pages.has_more,
        "page_limit=0 must not report has_more (filled-guard)"
    );
    assert!(
        !resp.blocks.has_more,
        "block_limit=0 must not report has_more (filled-guard)"
    );
}

#[tokio::test]
async fn partitioned_max_search_results_ceiling_propagates_to_has_more() {
    // The bounded FTS scan clips at `MAX_SEARCH_RESULTS` (100). When a
    // caller's combined cap exceeds that ceiling AND the matching row
    // set is larger than the ceiling, the scan flags `ceiling_hit=true`
    // and `has_more` must propagate even if the partition cap itself
    // would not have overflowed within the (clipped) scan.
    let (pool, _dir) = test_pool().await;

    // Seed > MAX_SEARCH_RESULTS (100) matching content rows under a
    // single root page. Generated IDs follow the project's 26-char ULID
    // shape; uniqueness is the only requirement here.
    let root = pt_block_id(0);
    insert_block(
        &pool,
        &root,
        "page",
        "partitioned ceiling root",
        None,
        Some(0),
    )
    .await;
    for i in 1..=120 {
        let id = pt_block_id(i);
        insert_block(
            &pool,
            &id,
            "content",
            &format!("partitioned ceiling row {i}"),
            Some(&root),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        50,
        50,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        1,
        "exactly one page-typed row matched the seed"
    );
    assert_eq!(
        resp.blocks.items.len(),
        50,
        "blocks partition fills to the cap (50) under a 100-row scan ceiling"
    );
    assert!(
        resp.blocks.has_more,
        "blocks.has_more must be true when caller's cap fills AND there are more rows in the scan"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_partitioned_searches_do_not_deadlock_or_starve() {
    // Fan five identical partitioned-search queries against the same pool
    // and assert (a) all complete within a generous 5s timeout and (b)
    // each returns Ok. The `test_pool()` helper uses `init_pool` which
    // exposes max_connections(5); five concurrent readers saturate the
    // pool to the cap and force the sqlx connection-acquire path to
    // serialise — which is what we want to validate is deadlock-free.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let pool0 = pool.clone();
    let pool1 = pool.clone();
    let pool2 = pool.clone();
    let pool3 = pool.clone();
    let pool4 = pool.clone();

    let fut0 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool0,
        "partitioned".to_string(),
        8,
        40,
        agaric_store::search_types::SearchFilter::default(),
        None,
    );
    let fut1 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool1,
        "partitioned".to_string(),
        8,
        40,
        agaric_store::search_types::SearchFilter::default(),
        None,
    );
    let fut2 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool2,
        "partitioned".to_string(),
        8,
        40,
        agaric_store::search_types::SearchFilter::default(),
        None,
    );
    let fut3 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool3,
        "partitioned".to_string(),
        8,
        40,
        agaric_store::search_types::SearchFilter::default(),
        None,
    );
    let fut4 = crate::commands::queries::search_blocks_partitioned_inner(
        &pool4,
        "partitioned".to_string(),
        8,
        40,
        agaric_store::search_types::SearchFilter::default(),
        None,
    );

    // Box the inner future to keep clippy's `large_futures` lint quiet —
    // the five composed `search_blocks_partitioned_inner` calls inflate
    // the inline future past clippy's 16KB warning threshold. The box is
    // otherwise indistinguishable from inline composition (single
    // once-per-test allocation, no behavioural change).
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Box::pin(async move { tokio::join!(fut0, fut1, fut2, fut3, fut4) }),
    )
    .await
    .expect("five concurrent partitioned searches must not deadlock within 5s");

    let (r0, r1, r2, r3, r4) = joined;
    assert!(
        r0.is_ok(),
        "concurrent partitioned search 0 must succeed: {r0:?}"
    );
    assert!(
        r1.is_ok(),
        "concurrent partitioned search 1 must succeed: {r1:?}"
    );
    assert!(
        r2.is_ok(),
        "concurrent partitioned search 2 must succeed: {r2:?}"
    );
    assert!(
        r3.is_ok(),
        "concurrent partitioned search 3 must succeed: {r3:?}"
    );
    assert!(
        r4.is_ok(),
        "concurrent partitioned search 4 must succeed: {r4:?}"
    );
    // Sanity: each result must include both pages and blocks partitions
    // populated. If a request raced into an empty result, that's a
    // partitioning regression we want to catch.
    let r0 = r0.unwrap();
    assert!(
        !r0.pages.items.is_empty() || !r0.blocks.items.is_empty(),
        "concurrent partitioned search 0 returned a fully-empty response — partition regression?"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pool_starvation_bound_500ms() {
    // Queue five readers against the test pool to exercise the
    // connection-acquire queue. The production read pool is
    // `max_connections(4)` so five readers force one to wait on a
    // connection; the test pool (`init_pool`) is `max_connections(5)`
    // so saturation is less aggressive but the contention is still
    // measurable. We measure tail latency (the slowest of the five)
    // and assert it stays under the bound.
    //
    // Measured locally (debug build, warm SQLite cache, 4-thread tokio
    // runtime, 10-row fixture from `seed_partitioned_fixture(5, 5)`)
    // across three back-to-back runs: tail = 4.5 / 7.6 / 4.2 ms.
    // Worst observed = 7.6ms → 3x headroom = ~23ms. The 500ms ceiling
    // Is the plan-prescribed value (checklist names the test
    // `..._bound_500ms`); it's a wide envelope deliberately chosen to
    // tolerate CI runner variance. The assertion is the *order of
    // magnitude* check — the per-task array is preserved in the panic
    // message so a regression that drifts toward the bound is
    // diagnosable.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 5, 5).await;

    let start = std::time::Instant::now();
    let p0 = pool.clone();
    let p1 = pool.clone();
    let p2 = pool.clone();
    let p3 = pool.clone();
    let p4 = pool.clone();
    let h0 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p0,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h1 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p1,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h2 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p2,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h3 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p3,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let h4 = tokio::spawn(async move {
        let t = std::time::Instant::now();
        let _ = crate::commands::queries::search_blocks_partitioned_inner(
            &p4,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await;
        t.elapsed()
    });
    let elapsed = [
        h0.await.unwrap(),
        h1.await.unwrap(),
        h2.await.unwrap(),
        h3.await.unwrap(),
        h4.await.unwrap(),
    ];
    let total = start.elapsed();
    let tail = elapsed.iter().copied().max().unwrap();
    assert!(
        tail < std::time::Duration::from_millis(500),
        "tail latency of five concurrent partitioned searches must stay under 500ms \
         (saw tail={tail:?}; total={total:?}; per-task={elapsed:?}). \
         Locally measured 4-8ms; 500ms = plan-prescribed envelope for CI runner variance."
    );
}

#[tokio::test]
async fn partitioned_over_long_query_is_rejected() {
    // A 100KB query now exceeds `MAX_QUERY_LEN`
    // (4 KiB) and is REJECTED up front with a validation error, before
    // Any tokenise / sanitise work. This supersedes the pre-
    // behaviour where a long sub-trigram-only query was tokenised,
    // sanitised to empty, and short-circuited to an empty response. The
    // sub-trigram empty-short-circuit itself is still covered by
    // `partitioned_sub_trigram_only_under_cap_short_circuits` below for
    // queries that fit under the length cap.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    // 50_000 alternating chars + spaces ≈ 100KB UTF-8 — well over the
    // 4 KiB `MAX_QUERY_LEN` cap.
    let huge: String = "a ".repeat(50_000);
    assert!(huge.len() >= 100_000, "fixture must be at least 100KB");

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        huge,
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("over-long query must be rejected, not short-circuited");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-long query must surface AppError::Validation, got {err:?}"
    );
}

#[tokio::test]
async fn partitioned_sub_trigram_only_under_cap_short_circuits() {
    // A sub-trigram-only query that fits UNDER `MAX_QUERY_LEN`: every
    // token is a single-character word (sub-trigram length). The
    // sanitizer drops sub-trigram word tokens (per `sanitize_fts_query`'s
    // `TRIGRAM_MIN_LEN = 3` filter), leaving the post-sanitised query
    // empty. The partitioned path then short-circuits to two empty
    // partitions rather than passing an empty MATCH expression to SQLite.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    // "a a a …" — comfortably under the 4 KiB cap.
    let short: String = "a ".repeat(100);
    assert!(
        short.len() < agaric_store::fts::MAX_QUERY_LEN,
        "fixture must fit under MAX_QUERY_LEN"
    );

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        short,
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect("sub-trigram-only query must short-circuit, not error");

    assert!(
        resp.pages.items.is_empty(),
        "sub-trigram-only query must yield empty pages partition"
    );
    assert!(
        resp.blocks.items.is_empty(),
        "sub-trigram-only query must yield empty blocks partition"
    );
    assert!(!resp.pages.has_more);
    assert!(!resp.blocks.has_more);
}

#[tokio::test]
async fn partitioned_all_filters_populated_executes_cleanly() {
    // Smoke test: build a `SearchFilter` with every documented field
    // populated and assert the dynamic-SQL builder composes without
    // error. We don't assert on result cardinality — the point is to
    // exercise the full filter-composition path so a regression in any
    // single clause surfaces as a SQL syntax / binding error.
    //
    // Fields populated:
    //   parent_id, tag_ids, space_id, include_page_globs,
    //   exclude_page_globs, case_sensitive, whole_word, is_regex (off —
    //   regex-mode bypasses the FTS filter composition; we want to
    //   exercise the FTS path), block_type_filter (ignored by the
    //   partitioned IPC; populated to verify the field's drop is
    //   silent), state_filter, priority_filter, due_filter,
    //   scheduled_filter, property_filters, excluded_property_filters,
    //   excluded_state_filter, excluded_priority_filter.
    let (pool, _dir) = test_pool().await;
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    seed_partitioned_fixture(&pool, 3, 3).await;
    // Bind the first seeded page into the space so `space_id` resolves
    // to a real row instead of an empty subselect.
    assign_to_space_for_fts(&pool, PT_PAGE_IDS[0], FTS_SPACE_A_ID).await;
    rebuild_fts_index(&pool).await.unwrap();

    let filter = agaric_store::search_types::SearchFilter {
        parent_id: Some(PT_PAGE_IDS[0].to_string()),
        tag_ids: vec!["01HQTAG000000000000000TAG1".to_string()],
        scope: SpaceScope::Active(SpaceId::from_trusted(FTS_SPACE_A_ID)),
        include_page_globs: vec!["*page*".to_string()],
        exclude_page_globs: vec!["*never*".to_string()],
        case_sensitive: true,
        whole_word: true,
        // `is_regex` left off so the test exercises the FTS path that
        // composes the metadata + glob + space SQL clauses. The regex
        // path is separately covered by `partitioned_regex_*` tests.
        is_regex: false,
        // Ignored by the partitioned IPC — populate to verify the
        // silent drop doesn't break the builder.
        block_type_filter: Some("page".to_string()),
        state_filter: vec!["TODO".to_string()],
        priority_filter: vec!["A".to_string()],
        due_filter: Some(agaric_store::search_types::DateFilter::Named(
            agaric_store::search_types::NamedDateRange::Today,
        )),
        scheduled_filter: Some(agaric_store::search_types::DateFilter::Op {
            op: agaric_store::search_types::DateOp::Gte,
            date: "2026-01-01".to_string(),
        }),
        property_filters: vec![agaric_store::search_types::SearchPropertyFilter {
            key: "owner".to_string(),
            value: "alice".to_string(),
        }],
        excluded_property_filters: vec![agaric_store::search_types::SearchPropertyFilter {
            key: "archived".to_string(),
            value: "true".to_string(),
        }],
        excluded_state_filter: vec!["DONE".to_string()],
        excluded_priority_filter: vec!["C".to_string()],
        // #1320-C — exercise the `last-edited:` projection splice in the
        // partitioned builder alongside every other filter clause.
        last_edited: Some(crate::filters::primitive::LastEditedSpec::Rolling { days: 7 }),
    };

    // The corpus deliberately does NOT match all of these predicates —
    // we just need the SQL to compose and execute. An empty result is
    // a valid outcome; an error is not.
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        filter,
        None,
    )
    .await
    .expect("12-field-populated SearchFilter must compose into valid SQL");

    // Wire-shape sanity — both partitions present, neither emits a
    // cursor / total_count.
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
    assert!(resp.pages.total_count.is_none());
    assert!(resp.blocks.total_count.is_none());
}

#[tokio::test]
async fn partitioned_empty_space_returns_empty_partitions() {
    // Zero pages, zero blocks in the space → both partitions must be
    // empty and `has_more=false`. Distinct from
    // `partitioned_empty_query_returns_empty_partitions` (which seeds
    // the fixture and tests the empty-query short-circuit); this test
    // skips seeding entirely so the FTS5 index has no rows at all.
    let (pool, _dir) = test_pool().await;
    // Build the FTS index without any seeded blocks so the MATCH path
    // exercises the empty-corpus branch, not the empty-query branch.
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect("empty-space partitioned search must succeed");

    assert_eq!(
        resp.pages.items.len(),
        0,
        "empty space must yield zero pages"
    );
    assert_eq!(
        resp.blocks.items.len(),
        0,
        "empty space must yield zero blocks"
    );
    assert!(!resp.pages.has_more, "empty space must not report has_more");
    assert!(
        !resp.blocks.has_more,
        "empty space must not report has_more"
    );
    assert!(resp.pages.next_cursor.is_none());
    assert!(resp.blocks.next_cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn partitioned_giant_space_completes_within_1s() {
    // 10k-block fixture. PRIMARY assertion is CORRECTNESS (the
    // partitioned scan returns the right capped result set). A loose
    // wall-clock ceiling is retained ONLY as a coarse N+1-regression
    // tripwire — NOT as a tight SLO. See issue #333: the old 300ms bound
    // flaked under concurrent CI load even though the query is ~17× faster.
    //
    // Measured distribution (issue #333, debug build, warm SQLite cache,
    // 4-thread tokio runtime, 10k content-block fixture, FTS5 trigram
    // index warmed by the no-op query below), 18 back-to-back idle runs
    // via `cargo nextest run --no-capture`:
    //
    //   55.4 55.5 56.1 56.1 56.4 56.4 56.6 56.8 56.8 57.0 58.1 58.4
    //   59.4 59.9 61.1 61.3 63.7 ms  (min 55.4, p50 ≈ 56.8, max 63.7)
    //
    // The query is firmly in the ~55-64ms band — three orders of
    // Magnitude under the 1000ms in the test name (checklist).
    // It is NOT near-budget, so per "measure, don't imagine" we keep the
    // perf budget here (case (a)) rather than moving it to a bench: there
    // is no real perf concern to track, only a regression to guard.
    //
    // The ceiling is set to **750ms** ≈ 12× the worst observed idle
    // (63.7ms). That absorbs the heavy scheduling jitter a loaded CI box
    // adds to a debug-build wall-clock measurement (the #333 flake) while
    // still tripping on an actual N+1 pattern, which would issue a query
    // per matched row (10k rows) and blow well past one second. If a
    // future runner drifts past 750ms, RE-MEASURE the distribution (don't
    // just bump the number) and record it here.
    let (pool, _dir) = test_pool().await;
    seed_giant_fixture(&pool, 10_000).await;

    // Warm the FTS5 cache + planner with a no-op query so the
    // measurement below times steady-state search, not cold-cache
    // first-query overhead (which on debug builds is a 10x cliff).
    let _ = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await;

    let start = std::time::Instant::now();
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect("giant-space partitioned search must succeed");
    let elapsed = start.elapsed();

    // Coarse N+1 tripwire only — NOT a tight SLO. 750ms ≈ 12× worst idle
    // (63.7ms measured, see header). Load-tolerant by design (#333).
    assert!(
        elapsed < std::time::Duration::from_millis(750),
        "giant-space partitioned search must complete under 750ms \
         (saw {elapsed:?}). Measured idle ~55-64ms (#333); 750ms is a \
         coarse N+1-regression tripwire with generous CI-load headroom, \
         not an SLO. A regression past 750ms is almost certainly an N+1 \
         pattern (a per-row query over the 10k-block fixture). If a loaded \
         runner legitimately drifts past this, RE-MEASURE before bumping."
    );
    // Sanity — the partitioned IPC must return at least the cap from
    // the unrestricted partition (10k matching rows, cap = 10).
    assert_eq!(
        resp.blocks.items.len(),
        10,
        "giant-space partitioned search must fill the blocks cap"
    );
    assert!(
        resp.blocks.has_more,
        "giant-space partitioned search must flag has_more on the blocks partition"
    );
}

#[tokio::test]
async fn partitioned_case_sensitive_with_or_preserves_case() {
    // `case_sensitive=true` + query `"Foo OR Bar"`:
    //
    // 1. Sanitizer preserves the `OR` operator (length-3 token in a
    //    valid operator position) — FTS5 candidate set includes blocks
    //    matching either `Foo` or `Bar` (case-insensitive trigram match).
    // 2. The toggle-mode post-filter compiles the entire query string as
    //    a *literal* regex (via `regex::escape`) with the `(?-i)` flag,
    //    so only blocks whose `content` contains the exact substring
    //    `"Foo OR Bar"` (case-matched) survive.
    //
    // Seeded content:
    //   - mixed-case "Has Foo OR Bar text" — survives post-filter.
    //   - lowercase "has foo or bar text" — FTS hit, post-filter drops.
    //   - mismatched "Foo only" / "Bar only" — FTS hit, post-filter drops
    //     (no literal "Foo OR Bar" substring).
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTCSOR01PAGE0000000P01",
        "page",
        "Has Foo OR Bar text",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR02PAGE0000000P02",
        "page",
        "has foo or bar text",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR03BLK00000000B03",
        "content",
        "Foo only here",
        Some("01HQPTCSOR01PAGE0000000P01"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTCSOR04BLK00000000B04",
        "content",
        "Bar only here",
        Some("01HQPTCSOR01PAGE0000000P01"),
        Some(3),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "Foo OR Bar".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            case_sensitive: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("case_sensitive + OR query must execute cleanly");

    // The post-filter regex is the literal `"Foo OR Bar"` with
    // case-sensitive flag — only the mixed-case page survives.
    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTCSOR01PAGE0000000P01"),
        "case_sensitive post-filter must keep the exact-case match: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR02PAGE0000000P02"),
        "case_sensitive post-filter must drop the lowercased page: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR03BLK00000000B03"),
        "case_sensitive post-filter must drop single-term blocks: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTCSOR04BLK00000000B04"),
        "case_sensitive post-filter must drop single-term blocks: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        1,
        "exactly one row matches the literal `Foo OR Bar` case-sensitively"
    );
}

#[tokio::test]
async fn partitioned_whole_word_with_and_combines_terms() {
    // `whole_word=true` + query `"foo AND bar"`:
    //
    // 1. Sanitizer preserves the `AND` operator — FTS5 candidate set
    //    requires both `foo` AND `bar` (case-insensitive trigram).
    // 2. The toggle-mode post-filter compiles the escaped literal query
    //    wrapped in ASCII word boundaries: `(?i)(?-u:\b)foo AND
    //    bar(?-u:\b)`. Only blocks whose content contains the exact
    //    substring `"foo AND bar"` as a word-boundary-aligned run
    //    survive.
    //
    // Seeded content:
    //   - "foo AND bar in title" — both terms present, literal substring
    //     present, word-boundary aligned → survives.
    //   - "foobar AND barfoo" — both terms substring-present in FTS5
    //     trigram view, but the literal "foo AND bar" string is not
    //     present → post-filter drops.
    //   - "foo standalone, no bar near" — both terms present (FTS5 hit),
    //     no literal "foo AND bar" → post-filter drops.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTWWAN01PAGE0000000P01",
        "page",
        "foo AND bar in title",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTWWAN02PAGE0000000P02",
        "page",
        "foobar AND barfoo",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTWWAN03BLK00000000B03",
        "content",
        "foo standalone, no bar near",
        Some("01HQPTWWAN01PAGE0000000P01"),
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "foo AND bar".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            whole_word: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("whole_word + AND query must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTWWAN01PAGE0000000P01"),
        "whole_word + AND must keep the exact-substring word-boundary match: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTWWAN02PAGE0000000P02"),
        "whole_word + AND must drop substring-only matches: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTWWAN03BLK00000000B03"),
        "whole_word + AND must drop blocks without the literal `foo AND bar` substring: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        1,
        "exactly one row matches `foo AND bar` as a word-boundary-aligned literal"
    );
}

#[tokio::test]
async fn partitioned_regex_alternation_matches_both() {
    // `is_regex=true` + pattern `(foo|bar).*baz`:
    //
    // The regex-mode path bypasses FTS sanitisation entirely and uses
    // `regex_mode_query` for the candidate set (recency-ordered SQL
    // scan of structurally-filtered blocks). The compiled regex
    // `(?i)(foo|bar).*baz` is applied as the post-filter — both
    // alternations must produce matches.
    //
    // Seeded content:
    //   - "foo zzz baz" — matches via `foo.*baz`.
    //   - "bar yyy baz" — matches via `bar.*baz`.
    //   - "neither here" — drops.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTRGAL01PAGE0000000P01",
        "page",
        "foo zzz baz",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAL02PAGE0000000P02",
        "page",
        "bar yyy baz",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAL03BLK00000000B03",
        "content",
        "neither alternation here",
        Some("01HQPTRGAL01PAGE0000000P01"),
        Some(2),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "(foo|bar).*baz".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("regex alternation query must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTRGAL01PAGE0000000P01"),
        "regex alternation must match the `foo.*baz` block: {surviving_ids:?}"
    );
    assert!(
        surviving_ids.contains(&"01HQPTRGAL02PAGE0000000P02"),
        "regex alternation must match the `bar.*baz` block: {surviving_ids:?}"
    );
    assert!(
        !surviving_ids.contains(&"01HQPTRGAL03BLK00000000B03"),
        "regex alternation must drop the non-matching block: {surviving_ids:?}"
    );
    assert_eq!(
        resp.blocks.items.len(),
        2,
        "exactly two rows match `(foo|bar).*baz`"
    );
}

#[tokio::test]
async fn partitioned_nfc_query_matches_nfd_content() {
    // / T1a — NFC normalisation guard.
    //
    // macOS volume content tends to be NFD-encoded (filename
    // decomposition; copy-paste from Safari can preserve NFD), and
    // typed queries on most platforms default to NFC. Without
    // normalisation, an NFC query for "café" misses the NFD content
    // "café" (the second one has the acute as a combining
    // codepoint). With B3's index-time + query-time NFC normalisation,
    // both ends agree on the canonical form.
    //
    // Sanity: assert the two raw strings are NOT byte-equal before
    // the fix would even attempt to make them match.
    let nfc_query = "caf\u{00E9}"; // U+00E9 = é (NFC composed)
    let nfd_content = "caf\u{0065}\u{0301}"; // 'e' + combining acute (NFD)
    assert_ne!(
        nfc_query.as_bytes(),
        nfd_content.as_bytes(),
        "test pre-condition: NFC and NFD encodings must be byte-different"
    );

    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQNFC001PAGE0000000P01CC",
        "page",
        nfd_content,
        None,
        Some(0),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        nfc_query.to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect("NFC query against NFD content must execute cleanly");

    let surviving_ids: Vec<&str> = resp.pages.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQNFC001PAGE0000000P01CC"),
        "NFC query `{nfc_query}` must match NFD content `{nfd_content}` after normalisation; \
         got pages: {surviving_ids:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_bare_alternation_matches_both_arms_under_case_flag() {
    // Phase 1.B7 — regression guard for the (?:...) wrap around
    // the user pattern. The historical risk: `(?i)foo|bar` composed by
    // string-concat is fine today, but any future prefix toggle in
    // front of `query` (e.g. `(?s)`) would interact with the top-level
    // `|` via precedence. The new `(?i)(?:foo|bar)` shape isolates the
    // user's pattern in a group so the alternation can't escape.
    //
    // Behavioural check: a bare alternation (no user-supplied parens)
    // must still match both arms case-insensitively under
    // `case_sensitive=false`.
    let (pool, _dir) = test_pool().await;
    insert_block(
        &pool,
        "01HQPTRGAW01PAGE0000000P01",
        "page",
        "Foo content",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01HQPTRGAW02PAGE0000000P02",
        "page",
        "BAR content",
        None,
        Some(1),
    )
    .await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "foo|bar".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            case_sensitive: false,
            ..Default::default()
        },
        None,
    )
    .await
    .expect("bare-alternation regex must execute cleanly");

    let surviving_ids: Vec<&str> = resp.blocks.items.iter().map(|r| r.id.as_str()).collect();
    assert!(
        surviving_ids.contains(&"01HQPTRGAW01PAGE0000000P01"),
        "case-insensitive `foo|bar` must match `Foo content`: {surviving_ids:?}"
    );
    assert!(
        surviving_ids.contains(&"01HQPTRGAW02PAGE0000000P02"),
        "case-insensitive `foo|bar` must match `BAR content`: {surviving_ids:?}"
    );
}

#[tokio::test]
async fn partitioned_regex_invalid_pattern_returns_validation_error() {
    // `is_regex=true` + invalid regex pattern `"*"` (Rust's regex crate
    // rejects unanchored `*` as a repetition operator with no
    // preceding atom). Per `toggle_filter.rs:331-343`, the compile
    // failure is mapped onto an `InvalidRegex`-coded `AppError::Validation`
    // — the partitioned IPC must propagate it verbatim.
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "*".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("invalid regex pattern must surface AppError::Validation");

    match err {
        agaric_core::error::AppError::Validation { code, .. } => assert_eq!(
            code,
            Some(agaric_core::error::ValidationCode::InvalidRegex),
            "expected InvalidRegex code"
        ),
        other => panic!("expected a coded InvalidRegex validation error; got {other:?}"),
    }
}

// ======================================================================
// Partition correctness + filter pushdown tests
// ======================================================================

/// When content blocks rank above the only page hit, the
/// Pages partition must still surface the page. The pre-
/// single-scan-then-Rust-partition shape failed this case: 60
/// content blocks crowd out the lone page within the
/// `min(page_limit + block_limit + 1, MAX_SEARCH_RESULTS)` scan
/// window. The two-scan shape guarantees a per-partition window so
/// the page is never invisible.
#[tokio::test]
async fn partitioned_scan_returns_pages_when_blocks_outrank_them() {
    let (pool, _dir) = test_pool().await;

    // One matching page; 60 matching content blocks that share the
    // FTS keyword. The content blocks' `content` is short so their
    // FTS rank tends to be at least as good as the page's title hit
    // — under the old shape the page typically lost the rank race.
    let page_id = pt_block_id(0);
    insert_block(
        &pool,
        &page_id,
        "page",
        "partitioned outranked page",
        None,
        Some(0),
    )
    .await;
    for i in 1..=60 {
        let content_id = pt_block_id(i);
        insert_block(
            &pool,
            &content_id,
            "content",
            // Repeat the keyword so the trigram rank stays high.
            "partitioned partitioned partitioned",
            Some(&page_id),
            Some(i64::from(i)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        5,  // page_limit
        20, // block_limit
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        1,
        "pages partition must return the one matching page regardless of how many content blocks outrank it"
    );
    assert_eq!(
        resp.pages.items[0].block_type, "page",
        "pages partition row must be page-typed"
    );
    assert!(
        !resp.pages.has_more,
        "pages.has_more must be false — only one page existed in total"
    );
}

/// Regex page-only queries must surface all matching
/// Pages even when content blocks dominate the table. Pre-
/// the regex SQL scan grabbed the 1000 most-recent rows ANY-type
/// then dropped non-pages in Rust, so 5 pages buried below 2000
/// recently-inserted content rows would disappear.
///
/// Two-pool worker threads: the regex scan itself is small but
/// `insert_block` writes a lot of rows; default flavor is fine.
#[tokio::test]
async fn partitioned_regex_page_filter_returns_pages_when_content_dominates() {
    let (pool, _dir) = test_pool().await;

    // Pages go in FIRST — their ULIDs sort below the content blocks'
    // and `regex_mode_query` orders `b.id DESC` (recency proxy). So
    // under the pre-F2 shape the 1000-row pre-filter window would
    // be entirely content rows; the pages would be invisible.
    for i in 0..5 {
        let pid = pt_block_id(i);
        insert_block(
            &pool,
            &pid,
            "page",
            &format!("regex_page_target_{i}"),
            None,
            Some(i64::from(i)),
        )
        .await;
    }
    // 2000 newer content rows (higher-ULID prefix) that don't match
    // the user's regex but DO match the regex builder's structural
    // filter (content IS NOT NULL).
    for i in 5..2005 {
        let cid = pt_block_id(i);
        insert_block(
            &pool,
            &cid,
            "content",
            "filler content row without target keyword",
            None,
            Some(i64::from(i)),
        )
        .await;
    }
    // FTS index isn't used by the regex path, but rebuild_fts_index
    // is a no-op cost on top of a pool-only check.

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "regex_page_target_".to_string(),
        20,
        20,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.pages.items.len(),
        5,
        "regex pages scan must return all 5 matching pages; pre-F2 dropped them past the 1000-row pre-filter cap"
    );
    for row in &resp.pages.items {
        assert_eq!(
            row.block_type, "page",
            "regex pages partition must be page-typed-only"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_drops_in_flight_query() {
    // Acceptance: dropping the client promise → in-flight Rust future
    // returns `AppError::Cancelled` within one row-batch boundary
    // (≤ 50 ms typical, ≤ 200 ms worst case).
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 150).await;

    let guard = agaric_store::cancellation::CancellationGuard::new();
    let token = guard.token();

    // Fire the cancel signal *before* the inner call so the
    // `tokio::select!` immediately resolves the cancel arm. This
    // tests the load-bearing invariant: a fired token makes the
    // inner call observe `AppError::Cancelled` instead of returning
    // rows. The race-with-live-cancel path is covered by the spawn
    // assertion below.
    guard.cancel();

    let start = std::time::Instant::now();
    let result = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        50,
        50,
        agaric_store::search_types::SearchFilter::default(),
        Some(token),
    )
    .await;
    let elapsed = start.elapsed();

    assert!(
        matches!(result, Err(agaric_core::error::AppError::Cancelled)),
        "pre-cancelled token must surface AppError::Cancelled, got {result:?}"
    );
    assert!(
        elapsed < std::time::Duration::from_millis(200),
        "cancellation must propagate within 200ms worst-case, elapsed {elapsed:?}"
    );

    // Second leg: kick off an inner call without pre-cancellation,
    // fire the guard mid-flight, and observe `AppError::Cancelled`
    // within the 200ms budget. This is the "client dropped the
    // promise" path the IPC wrapper exercises in production.
    let guard2 = agaric_store::cancellation::CancellationGuard::new();
    let token2 = guard2.token();
    let pool_clone = pool.clone();
    let handle = tokio::spawn(async move {
        let t0 = std::time::Instant::now();
        let res = crate::commands::queries::search_blocks_partitioned_inner(
            &pool_clone,
            "partitioned".to_string(),
            50,
            50,
            agaric_store::search_types::SearchFilter::default(),
            Some(token2),
        )
        .await;
        (res, t0.elapsed())
    });
    // Yield briefly so the spawned task makes it into the SQL
    // fetch_all (or at least registers on the runtime).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    drop(guard2); // fire cancel via Drop, mirroring IPC wrapper behaviour.

    let (res, dt) = tokio::time::timeout(std::time::Duration::from_millis(500), handle)
        .await
        .expect("cancellation must complete within 500ms")
        .expect("spawned task must finish cleanly");
    // Two valid outcomes:
    //   1. Cancelled — the cancel signal won the race (expected path).
    //   2. Ok — the SQL completed before the cancel arrived. This is
    //      legitimate on a hot in-memory DB; the partitioned scan can
    //      finish in single-digit ms. We do NOT consider it a failure
    //      — the contract is "cancellation does no harm", not "every
    //      drop produces Cancelled".
    match res {
        Err(agaric_core::error::AppError::Cancelled) => {
            assert!(
                dt < std::time::Duration::from_millis(200),
                "mid-flight cancel must surface within 200ms, dt = {dt:?}"
            );
        }
        Ok(_) => {
            // SQL won the race; no regression. Document via a permissive log line.
            eprintln!("note: mid-flight cancel raced and SQL completed first (dt = {dt:?})");
        }
        Err(e) => panic!("unexpected error from cancelled search: {e:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn slow_acquire_logs_warning() {
    // Acceptance: bursty typing saturates the read pool → at least
    // one slow-acquire warn fires. We exercise the saturation
    // mechanically: a holder task takes the single pool slot and
    // sleeps past the 50 ms `SLOW_SEARCH_ACQUIRE_WARN_MS` threshold,
    // forcing the next `search_pool_acquire_logged` caller to wait.
    //
    // ## Why we hold the connection inside the subscriber scope
    //
    // `tracing::subscriber::set_default` installs a *thread-local*
    // subscriber. `tokio::spawn`'d tasks run on different worker
    // threads, so the subscriber isn't visible inside the holder
    // closure. Holding the pool slot via a local `acquire().await`
    // on the current task keeps the slow-acquire warn (emitted by
    // `search_pool_acquire_logged` inside `fts_fetch_rows`) within
    // the same task that installed the subscriber.
    use tracing_subscriber::layer::SubscriberExt;

    // Single-slot pool guarantees the search task waits behind the
    // holder. `init_pool` would give 5 connections — too many to
    // reliably saturate from a single test.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("slow_acquire_search.db");
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&db_path)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON")
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    // Seed BEFORE we install the subscriber so the seed-side
    // queries (which run their own warn-eligible code paths) don't
    // pollute the captured log buffer.
    seed_heavy_partitioned_fixture(&pool, 50).await;

    let writer = LogBuf::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // Take the single slot on the *current* task so the subscriber
    // installed above is visible when the search task crosses the
    // slow-acquire threshold.
    let holder_conn = pool.acquire().await.unwrap();

    // Saturating call: race a search future against a `sleep` that
    // releases the holder past the slow-acquire threshold. The
    // search future's `search_pool_acquire_logged` waits the full
    // duration before getting its slot — that wait crosses the
    // `SLOW_SEARCH_ACQUIRE_WARN_MS` (50 ms) threshold and emits the
    // warn log.
    let pool_for_search = pool.clone();
    let search_future = async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_for_search,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await
    };
    let release_future = async {
        // Sleep past the slow-acquire threshold, then drop the
        // holder so the search proceeds.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        drop(holder_conn);
    };
    let (search_res, ()) = tokio::join!(search_future, release_future);
    let _ = search_res.expect("search must complete once the holder releases");

    let contents = writer.contents();
    assert!(
        contents.contains("slow read-pool acquire"),
        "saturating the read pool must emit a slow-acquire warn, got: {contents:?}"
    );
    assert!(
        contents.contains("fts_fetch_rows"),
        "slow-acquire warn must carry the fts_fetch_rows label, got: {contents:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_does_not_lose_in_flight_results() {
    // Acceptance: firing two searches with the same query → at least
    // one completes successfully (no double-cancel race destroys
    // both). Mirrors the palette's keystroke pattern where the
    // *last* IPC is the one the frontend keeps.
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 30).await;

    let guard_a = agaric_store::cancellation::CancellationGuard::new();
    let token_a = guard_a.token();
    let pool_a = pool.clone();
    let handle_a = tokio::spawn(async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_a,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            Some(token_a),
        )
        .await
    });

    let guard_b = agaric_store::cancellation::CancellationGuard::new();
    let token_b = guard_b.token();
    let pool_b = pool.clone();
    let handle_b = tokio::spawn(async move {
        crate::commands::queries::search_blocks_partitioned_inner(
            &pool_b,
            "partitioned".to_string(),
            10,
            10,
            agaric_store::search_types::SearchFilter::default(),
            Some(token_b),
        )
        .await
    });

    // Cancel the first one only (mimicking the palette discarding
    // the stale IPC when a new keystroke arrives). The second must
    // complete OK.
    drop(guard_a);

    let res_a = tokio::time::timeout(std::time::Duration::from_secs(2), handle_a)
        .await
        .expect("first search must finish within 2s")
        .expect("first search task must join cleanly");
    let res_b = tokio::time::timeout(std::time::Duration::from_secs(2), handle_b)
        .await
        .expect("second search must finish within 2s")
        .expect("second search task must join cleanly");

    // At least one must complete with rows. The cancelled one may
    // return either Cancelled (cancel won) or Ok (SQL finished
    // first); the un-cancelled one must return Ok.
    assert!(
        res_b.is_ok(),
        "un-cancelled second search must complete: {res_b:?}"
    );
    let resp_b = res_b.unwrap();
    assert!(
        !resp_b.blocks.items.is_empty(),
        "un-cancelled search must return at least one row"
    );
    // Keep `guard_b` alive across the await so its Drop fires AFTER
    // the inner call completes — exercising the "guard outlives the
    // call" production path.
    drop(guard_b);

    // The first call: either Cancelled or Ok is acceptable.
    match res_a {
        Ok(_) | Err(agaric_core::error::AppError::Cancelled) => {}
        Err(e) => panic!("first search must be Ok or Cancelled, got: {e:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rapid_fire_burst_pattern_does_not_starve_pool() {
    // Integration-style: mimic the palette's 5-keystroke rapid-fire
    // burst (80ms debounce per CommandPalette.tsx → 5 keystrokes in
    // ~400ms). Each keystroke fires a fresh `search_blocks_partitioned`
    // IPC; the previous one is cancelled. The last one must complete
    // successfully.
    let (pool, _dir) = test_pool().await;
    seed_heavy_partitioned_fixture(&pool, 40).await;

    let mut prev_guard: Option<agaric_store::cancellation::CancellationGuard> = None;
    let mut handles: Vec<(
        tokio::task::JoinHandle<
            Result<
                crate::commands::queries::PartitionedSearchResponse,
                agaric_core::error::AppError,
            >,
        >,
        usize,
    )> = Vec::new();

    // 5 keystrokes, each 80ms apart.
    for keystroke in 0..5 {
        // Drop the previous guard — this fires its cancel signal,
        // exactly mirroring the palette's "abandon the stale
        // generationRef" pattern.
        if let Some(g) = prev_guard.take() {
            drop(g);
        }
        let guard = agaric_store::cancellation::CancellationGuard::new();
        let token = guard.token();
        let pool_clone = pool.clone();
        let handle = tokio::spawn(async move {
            crate::commands::queries::search_blocks_partitioned_inner(
                &pool_clone,
                "partitioned".to_string(),
                10,
                10,
                agaric_store::search_types::SearchFilter::default(),
                Some(token),
            )
            .await
        });
        handles.push((handle, keystroke));
        prev_guard = Some(guard);
        // 80ms debounce window from CommandPalette.tsx.
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }

    // The last guard is still alive — its query must complete.
    let last_idx = handles.len() - 1;
    let (last_handle, _) = handles.pop().expect("we spawned 5 handles");
    let last_res = tokio::time::timeout(std::time::Duration::from_secs(3), last_handle)
        .await
        .expect("last search must finish within 3s")
        .expect("last search task must join cleanly");
    assert!(
        last_res.is_ok(),
        "the last (un-cancelled) keystroke's IPC must complete: {last_res:?}"
    );
    let last_resp = last_res.unwrap();
    assert!(
        !last_resp.blocks.items.is_empty(),
        "last keystroke's response must carry rows"
    );

    // Drain the previous handles. Each is allowed to be either
    // Ok (the SQL completed before the cancel arrived) or Cancelled
    // (cancel won the race). Any other error indicates a regression
    // in the cancellation plumbing.
    let mut completed = 0_usize;
    let mut cancelled = 0_usize;
    for (handle, idx) in handles {
        let res = tokio::time::timeout(std::time::Duration::from_secs(3), handle)
            .await
            .unwrap_or_else(|_| panic!("keystroke {idx} timed out"))
            .unwrap_or_else(|e| panic!("keystroke {idx} task panicked: {e:?}"));
        match res {
            Ok(_) => completed += 1,
            Err(agaric_core::error::AppError::Cancelled) => cancelled += 1,
            Err(e) => panic!("keystroke {idx} surfaced unexpected error: {e:?}"),
        }
    }
    assert_eq!(
        completed + cancelled,
        last_idx, // we popped one; the remaining is last_idx
        "every cancelled keystroke must end with either Ok or Cancelled (no other errors), \
         completed={completed} cancelled={cancelled}"
    );
}

/// BE-A4 — the regex branch of the partitioned scan now
/// honours the cancellation token. A pre-cancelled token must short-
/// circuit the regex dispatch with `AppError::Cancelled` rather than
/// running the two parallel scans to completion. The existing
/// `partitioned_pre_cancelled_token_returns_cancelled` test only
/// exercises the FTS branch (default filter); this one drives the
/// `is_regex = true` path that previously ignored the token.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partitioned_regex_pre_cancelled_token_returns_cancelled() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let guard = agaric_store::cancellation::CancellationGuard::new();
    let token = guard.token();
    // Fire the cancel signal before the search runs.
    drop(guard);

    let result = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partition".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        Some(token),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "a pre-cancelled token on the regex branch must yield AppError::Cancelled, got {result:?}"
    );
}

/// `has_more` must be TRUE at exactly the
/// `MAX_SEARCH_RESULTS` (100) cap when more rows exist. Before the fix,
/// `limit_plus_one_capped(100)` collapsed to `100`, so the probe could
/// never see the 101st row and `has_more` was stuck false at the cap.
#[tokio::test]
async fn partitioned_has_more_is_true_at_exactly_the_cap() {
    let (pool, _dir) = test_pool().await;

    // Seed > 100 matching content rows under a single root page so the
    // blocks partition's scan overflows the cap.
    let root = pt_block_id(0);
    insert_block(&pool, &root, "page", "cap boundary root", None, Some(0)).await;
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=130u32 {
        let id = pt_block_id(i);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(format!("capboundary row {i}"))
        .bind(&root)
        .bind(i64::from(i))
        .bind(&root)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    rebuild_fts_index(&pool).await.unwrap();

    // Request the page/block limits at exactly the cap (100).
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "capboundary".to_string(),
        100,
        100,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.blocks.items.len(),
        100,
        "blocks partition must fill to the 100 cap"
    );
    assert!(
        resp.blocks.has_more,
        "blocks.has_more must be TRUE at the cap when >100 rows matched"
    );
}

/// BE-2 — the partitioned command rejects an over-limit
/// request (mirrors the cursor path's `PageRequest::new` reject contract)
/// instead of silently capping it.
#[tokio::test]
async fn partitioned_over_limit_is_rejected() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    // page_limit over the cap.
    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        101,
        10,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("page_limit over the cap must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-limit page_limit must surface AppError::Validation, got {err:?}"
    );

    // block_limit over the cap.
    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        101,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("block_limit over the cap must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-limit block_limit must surface AppError::Validation, got {err:?}"
    );
}

/// BE-2 — limits at exactly the cap are accepted (boundary).
#[tokio::test]
async fn partitioned_limits_at_exactly_the_cap_are_accepted() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        100,
        100,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await;
    assert!(
        resp.is_ok(),
        "limits at exactly MAX_SEARCH_RESULTS must be accepted: {resp:?}"
    );
}

/// BE-6 — fail-fast: an invalid regex routed through the
/// partitioned inner surfaces a validation error (not a partial / empty
/// response). Exercises the command-layer error envelope.
#[tokio::test]
async fn partitioned_invalid_regex_fails_fast_with_validation() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "(unclosed".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("invalid regex must fail fast");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "invalid regex must surface AppError::Validation, got {err:?}"
    );
}

/// BE-6 — cancellation envelope: a pre-cancelled token makes
/// the partitioned inner return `AppError::Cancelled` rather than running
/// the scan to completion.
#[tokio::test]
async fn partitioned_pre_cancelled_token_returns_cancelled() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 3, 3).await;

    let guard = agaric_store::cancellation::CancellationGuard::new();
    let token = guard.token();
    // Fire the cancel signal before the search runs.
    drop(guard);

    let result = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter::default(),
        Some(token),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "a pre-cancelled token must yield AppError::Cancelled, got {result:?}"
    );
}

/// BE-8 — an empty `prop:` key is rejected at the command
/// layer (mirrors `query_by_property_inner`'s contract) instead of
/// composing a `bp.key = ''` clause that silently matches nothing.
#[tokio::test]
async fn search_empty_property_key_is_rejected() {
    let (pool, _dir) = test_pool().await;
    seed_partitioned_fixture(&pool, 1, 1).await;

    let err = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            property_filters: vec![agaric_store::search_types::SearchPropertyFilter {
                key: "   ".to_string(),
                value: "x".to_string(),
            }],
            ..Default::default()
        },
        None,
    )
    .await
    .expect_err("empty prop: key must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "empty prop: key must surface AppError::Validation, got {err:?}"
    );
}

/// BE-9 — `space_id: Some("")` is the "match nothing"
/// space-isolation invariant. A search scoped to the empty space must
/// return zero rows even when matching content exists in real spaces.
#[tokio::test]
async fn search_empty_space_id_matches_nothing() {
    let (pool, _dir) = test_pool().await;
    // Seed a real space + a matching page assigned to it, so without the
    // empty-space guard the row would otherwise be reachable.
    insert_space_block_for_fts(&pool, FTS_SPACE_A_ID, "Personal").await;
    seed_partitioned_fixture(&pool, 1, 1).await;
    assign_to_space_for_fts(&pool, PT_PAGE_IDS[0], FTS_SPACE_A_ID).await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "partitioned".to_string(),
        10,
        10,
        agaric_store::search_types::SearchFilter {
            scope: SpaceScope::Active(SpaceId::from_trusted("")),
            ..Default::default()
        },
        None,
    )
    .await
    .expect("empty space_id search must succeed (returning nothing)");

    assert_eq!(
        resp.pages.items.len(),
        0,
        "space_id=\"\" must match no pages"
    );
    assert_eq!(
        resp.blocks.items.len(),
        0,
        "space_id=\"\" must match no blocks"
    );
}

/// BE-A10 (4) — SQL-A2: partitioned REGEX search with exactly
/// `MAX_SEARCH_RESULTS + 1` matching rows → `has_more == true` and
/// `<= MAX_SEARCH_RESULTS` returned.
///
/// The partitioned regex caller passes a `limit + 1` PROBE to
/// `regex_mode_query`, whose clamp is `MAX_SEARCH_RESULTS + 1` (SQL-A2).
/// At `block_limit == MAX_SEARCH_RESULTS` the probe is `MAX_SEARCH_RESULTS
/// + 1`, so the (cap+1)-th survivor is seen and `has_more` flips true —
/// the bug the previous `clamp(1, 100)` masked.
#[tokio::test]
async fn be_a10_sqla2_partitioned_regex_has_more_at_cap() {
    let (pool, _dir) = test_pool().await;
    let n = u32::try_from(MAX_SEARCH_RESULTS + 1).unwrap();
    for index in 0..n {
        let id = pt_block_id(index);
        insert_block(
            &pool,
            &id,
            "content",
            "regexcap candidate row",
            None,
            Some(i64::from(index)),
        )
        .await;
    }
    rebuild_fts_index(&pool).await.unwrap();

    let cap = u32::try_from(MAX_SEARCH_RESULTS).unwrap();
    let resp = crate::commands::queries::search_blocks_partitioned_inner(
        &pool,
        "regexcap".to_string(),
        cap,
        cap,
        agaric_store::search_types::SearchFilter {
            is_regex: true,
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        i64::try_from(resp.blocks.items.len()).unwrap(),
        MAX_SEARCH_RESULTS,
        "blocks partition returns at most MAX_SEARCH_RESULTS rows"
    );
    assert!(
        resp.blocks.has_more,
        "SQL-A2: has_more must be true with MAX_SEARCH_RESULTS + 1 matching rows at the cap"
    );
}

/// BE-A10 (5) — SQL-A1: cursor `search_blocks_inner` rejects
/// `limit > MAX_SEARCH_RESULTS` with `AppError::Validation`, while
/// `limit == MAX_SEARCH_RESULTS` and the default (`None`) limit succeed.
#[tokio::test]
async fn be_a10_sqla1_cursor_rejects_over_cap_limit() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, BLOCK_A, "content", "sqla1 probe", None, Some(0)).await;
    rebuild_fts_index(&pool).await.unwrap();

    // limit = MAX_SEARCH_RESULTS + 1 (101) — accepted by PageRequest::new
    // (<= MAX_PAGE_SIZE = 200) but rejected by the SQL-A1 guard.
    let over = MAX_SEARCH_RESULTS + 1;
    let err = crate::commands::queries::search_blocks_inner(
        &pool,
        "sqla1".to_string(),
        None,
        Some(over),
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await
    .expect_err("limit > MAX_SEARCH_RESULTS must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-cap limit must surface AppError::Validation, got {err:?}"
    );

    // limit = MAX_SEARCH_RESULTS (100) — accepted.
    let ok_cap = crate::commands::queries::search_blocks_inner(
        &pool,
        "sqla1".to_string(),
        None,
        Some(MAX_SEARCH_RESULTS),
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await;
    assert!(
        ok_cap.is_ok(),
        "limit == MAX_SEARCH_RESULTS must be accepted, got {:?}",
        ok_cap.err()
    );
    assert_eq!(
        ok_cap.unwrap().items.len(),
        1,
        "the one matching block returns"
    );

    // Default (None) limit = DEFAULT_PAGE_SIZE (50) <= MAX_SEARCH_RESULTS —
    // accepted. Guards the None/default path against the SQL-A1 reject.
    let ok_default = crate::commands::queries::search_blocks_inner(
        &pool,
        "sqla1".to_string(),
        None,
        None,
        agaric_store::search_types::SearchFilter::default(),
        None,
    )
    .await;
    assert!(
        ok_default.is_ok(),
        "default (None) limit must be accepted, got {:?}",
        ok_default.err()
    );
    assert_eq!(
        ok_default.unwrap().items.len(),
        1,
        "default-limit search returns the block"
    );
}
