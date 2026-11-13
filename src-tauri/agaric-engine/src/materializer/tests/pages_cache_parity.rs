// ---------------------------------------------------------------------------
// `pages_cache.{inbound_link_count,child_block_count}` parity
// ---------------------------------------------------------------------------
//
// These tests assert that the materialised count columns added by
// migration 0069 are byte-identical to what the live `COUNT(...)` SELECT
// in `commands::pages::list_pages_with_metadata_inner` (the canonical
// shape in `commands/pages.rs:1666-1675`) would compute.
//
// Strategy: seed a fixture, run a series of materializer ops via
// `handle_foreground_task` + `handle_background_task`, and after each
// step recompute the canonical aggregates from the raw data and compare
// To the cached columns. Drift here is the cliff is closing.

use super::*;
use crate::loro::shared::LoroState;
use crate::materializer::handlers::{handle_background_task, handle_foreground_task};

/// Recompute `(inbound_link_count, child_block_count)` for `page_id`
/// from FIRST PRINCIPLES — deliberately NOT a copy of the recompute
/// SQL's `page_id`-keyed shape (E10: a bug shared by both copies of a
/// `page_id`-based COUNT would otherwise pass parity silently).
///
/// `child_block_count` is derived by walking the live `parent_id` tree
/// down from the page block (a recursive descent that NEVER reads the
/// denormalised `blocks.page_id` column) and counting non-deleted
/// descendants, stopping at nested page boundaries — a nested page owns
/// its own subtree, so it and its descendants belong to that page, not
/// this one. This is the structural definition that `page_id` is merely
/// a cache of; if `page_id` drifts from the tree (the exact E4 bug),
/// this oracle catches it while a `page_id`-keyed copy would not.
///
/// `inbound_link_count` is computed against `block_links`; it shares the
/// same-page/orphan/same-space exclusions with the recompute by necessity
/// (those are the definition, not an implementation detail), so the parity
/// tests additionally pin it with hard-literal assertions.
async fn canonical_counts(pool: &SqlitePool, page_id: &str) -> (i64, i64) {
    // child_block_count via structural tree walk (no page_id read).
    // Seeds at the page's direct children; recurses through any block
    // that is NOT itself a page (a nested page starts a new page
    // subtree). Bounds `depth < 100` per invariant #9 and excludes
    // soft-deleted rows in both members.
    let child: i64 = sqlx::query_scalar(
        "WITH RECURSIVE owned(id, block_type, depth) AS ( \
                 SELECT b.id, b.block_type, 0 FROM blocks b \
                 WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
                 UNION ALL \
                 SELECT b.id, b.block_type, o.depth + 1 FROM blocks b \
                 JOIN owned o ON b.parent_id = o.id \
                 WHERE b.deleted_at IS NULL \
                   AND o.block_type != 'page' \
                   AND o.depth < 100 \
             ) \
             SELECT COUNT(*) FROM owned WHERE block_type != 'page'",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let inbound: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                 JOIN blocks descendant ON bl.target_id = descendant.id \
                 JOIN blocks src ON src.id = bl.source_id \
             WHERE descendant.page_id = ? AND descendant.deleted_at IS NULL \
               AND src.deleted_at IS NULL \
               AND src.page_id IS NOT NULL \
               AND src.page_id != ? \
               AND src.space_id IS (SELECT space_id FROM blocks WHERE id = ?)",
    )
    .bind(page_id)
    .bind(page_id)
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap();
    (inbound, child)
}

/// Read the materialised pair from `pages_cache`. Returns `None` if
/// the page row doesn't exist (e.g., the page was purged or
/// soft-deleted and a `RebuildPagesCache` already removed the row).
async fn cached_counts(pool: &SqlitePool, page_id: &str) -> Option<(i64, i64)> {
    sqlx::query_as::<_, (i64, i64)>(
        "SELECT inbound_link_count, child_block_count FROM pages_cache \
             WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// Walk every live page and assert that cached counts equal the
/// canonical SELECT. Skips pages whose `pages_cache` row no longer
/// exists (a soft-deleted or purged page may have had its row
/// removed by the cascade or by a `RebuildPagesCache` rebuild — the
/// parity contract only applies to extant cache rows).
async fn assert_parity(pool: &SqlitePool, context: &str) {
    let live_pages: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL")
            .fetch_all(pool)
            .await
            .unwrap();
    for (page_id,) in live_pages {
        let canon = canonical_counts(pool, &page_id).await;
        if let Some(cached) = cached_counts(pool, &page_id).await {
            assert_eq!(
                cached, canon,
                "[{context}] parity drift on page_id={page_id}: cached={cached:?} != canonical={canon:?}",
            );
        }
    }
}

/// Insert a page row directly + the matching `pages_cache` row with
/// default (zero) counts and no op yet (`last_edited_ms = 0`). Sets
/// `page_id = id` to mirror what `RebuildPageIds` would compute. Title =
/// content per the canonical pages_cache contract (see
/// `cache/pages.rs::apply_sort_merge_rebuild`).
async fn seed_page(pool: &SqlitePool, id: &str, title: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)")
        .bind(id)
        .bind(title)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
            "INSERT INTO pages_cache (page_id, title, title_sort_key, updated_at, inbound_link_count, child_block_count) \
             VALUES (?, ?, ?, 1735689600000, 0, 0)",
        )
        .bind(id)
        .bind(title)
        .bind(agaric_core::title_sort::title_sort_key(title))
        .execute(pool)
        .await
        .unwrap();
}

/// Synthesise a foreground `ApplyOp` task with the given inner-only
/// payload JSON. Mirrors `fake_op_record` but lets the caller pick
/// the op type.
fn op_task(op_type: &str, payload: &str) -> MaterializeTask {
    MaterializeTask::ApplyOp(StdArc::new(fake_op_record(op_type, payload)))
}

/// Drive the FG ApplyOp + the matching BG tasks (when applicable) so the
/// materialised counts settle to their canonical values for both
/// `child_block_count` and `inbound_link_count` — mirroring production's
/// background dispatch after the foreground apply.
async fn run_op(pool: &SqlitePool, task: MaterializeTask, link_block_ids: &[&str]) {
    // #2042: delete / restore / purge defer the page-wide pages_cache count
    // recompute to the background `RebuildPagesCacheCounts` task (production
    // enqueues it via the lifecycle rebuild set). Capture whether this is a
    // cohort lifecycle op before the FG handler consumes the borrow.
    let is_lifecycle = matches!(
        &task,
        MaterializeTask::ApplyOp(r)
            if matches!(r.op_type.as_str(), "delete_block" | "restore_block" | "purge_block")
    );

    handle_foreground_task(pool, &task, &LoroState::new())
        .await
        .unwrap();
    // Drive ReindexBlockLinks for every block whose `block_links`
    // rows changed. The dispatch in production fires this for
    // create_block / edit_block.
    for id in link_block_ids {
        handle_background_task(
            pool,
            &MaterializeTask::ReindexBlockLinks {
                block_id: (*id).into(),
            },
            None,
            None,
        )
        .await
        .unwrap();
    }
    // #2042: drive the deferred page-wide count recompute for cohort lifecycle
    // ops so the parity assertions see canonical counts (matching production
    // after the background queue drains). Idempotent full-table recompute.
    if is_lifecycle {
        handle_background_task(pool, &MaterializeTask::RebuildPagesCacheCounts, None, None)
            .await
            .unwrap();
    }
}

/// Single-shot parity: a page with no descendants and no inbound
/// links must show counts (0, 0). Verifies the seed path is sane.
#[tokio::test]
async fn empty_page_has_zero_counts() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "P01", "Page One").await;
    assert_parity(&pool, "empty seed").await;
}

/// Create a content block under a page → child_block_count = 1.
/// Then add a [[PAGE]] link → inbound_link_count on the target rises
/// once `ReindexBlockLinks` runs.
#[tokio::test]
async fn create_and_link_updates_both_counts() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_A", "Page A").await;
    seed_page(&pool, "PAGE_B", "Page B").await;

    // CreateBlock — content block under PAGE_A with no link yet.
    let payload = r#"{"block_id":"CHILD_1","block_type":"content","content":"hello","parent_id":"PAGE_A","position":0}"#.to_string();
    run_op(&pool, op_task("create_block", &payload), &["CHILD_1"]).await;
    // page_id for CHILD_1 isn't set by the SQL-only fallback; in
    // production it's set by RebuildPageIds. For the parity test we
    // patch it manually so the SELECT shape can find it.
    sqlx::query("UPDATE blocks SET page_id = 'PAGE_A' WHERE id = 'CHILD_1'")
        .execute(&pool)
        .await
        .unwrap();
    // Recompute via the canonical-shape UPDATE to bring pages_cache
    // up to date now that page_id is set.
    sqlx::query(
        "UPDATE pages_cache SET \
                 inbound_link_count = ( \
                     SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                         JOIN blocks d ON bl.target_id = d.id \
                         JOIN blocks src ON src.id = bl.source_id \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND src.deleted_at IS NULL \
                           AND src.page_id IS NOT NULL \
                           AND src.page_id != pages_cache.page_id), \
                 child_block_count = ( \
                     SELECT COUNT(*) FROM blocks d \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND d.id != pages_cache.page_id)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_parity(&pool, "after create CHILD_1").await;

    // EditBlock — add a [[PAGE_B]] link in CHILD_1.
    let payload = r#"{"block_id":"CHILD_1","to_text":"hello [[PAGE_B]]","prev_edit":null}"#;
    run_op(&pool, op_task("edit_block", payload), &["CHILD_1"]).await;
    assert_parity(&pool, "after edit CHILD_1 add link").await;

    // EditBlock — remove the link again.
    let payload = r#"{"block_id":"CHILD_1","to_text":"hello","prev_edit":null}"#;
    run_op(&pool, op_task("edit_block", payload), &["CHILD_1"]).await;
    assert_parity(&pool, "after edit CHILD_1 remove link").await;
}

/// DeleteBlock soft-deletes a content block → child_block_count
/// decreases on its owning page. RestoreBlock reverses it.
#[tokio::test]
async fn delete_restore_updates_child_count() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_D", "Page D").await;
    // Insert a content block + patch page_id.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('CHILD_D', 'content', 'c', 'PAGE_D', 'PAGE_D')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE pages_cache SET child_block_count = 1 WHERE page_id = 'PAGE_D'")
        .execute(&pool)
        .await
        .unwrap();
    assert_parity(&pool, "seeded 1 child").await;

    // DeleteBlock.
    let payload = r#"{"block_id":"CHILD_D"}"#;
    run_op(&pool, op_task("delete_block", payload), &[]).await;
    assert_parity(&pool, "after delete CHILD_D").await;
    let (_, child) = cached_counts(&pool, "PAGE_D").await.unwrap();
    assert_eq!(child, 0, "child_block_count must drop to 0");

    // RestoreBlock — re-read deleted_at_ref from the row.
    let deleted_at: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'CHILD_D'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let payload = format!(r#"{{"block_id":"CHILD_D","deleted_at_ref":{deleted_at}}}"#);
    run_op(&pool, op_task("restore_block", &payload), &[]).await;
    assert_parity(&pool, "after restore CHILD_D").await;
    let (_, child) = cached_counts(&pool, "PAGE_D").await.unwrap();
    assert_eq!(child, 1, "child_block_count must return to 1");
}

/// #2042 — a cohort op must DEFER its page-wide count recompute, not run it
/// in this transaction.
///
/// `maintain_pages_cache_counts_after_op`'s [`PreOpState::Deferred`] arm adds
/// nothing to `affected`, because the affected set of a Delete, Restore or Purge
/// spans an arbitrarily large descendant subtree and recomputing it here holds
/// the single-writer apply lock for the whole walk. The background
/// `RebuildPagesCacheCounts` task does it instead.
///
/// Nothing pinned that: the other parity tests drain the background handler
/// before asserting, so they see the same final counts either way. This calls
/// the hook directly and asserts the counts are UNTOUCHED — the one observation
/// that separates "deferred" from "done inline". A deliberately wrong seeded
/// value stands in for the recompute's output, so the assertion fails the moment
/// the walk runs.
///
/// One state, not three: all three ops name the same payload-free variant, so
/// there is no longer a per-op shape that could diverge from the others.
#[tokio::test]
async fn cohort_ops_defer_the_count_recompute_2042() {
    use crate::apply::pages_cache::{PreOpState, maintain_pages_cache_counts_after_op};

    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_X", "Page X").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('CHILD_X', 'content', 'c', 'PAGE_X', 'PAGE_X')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Deliberately wrong: the real count is 1. An inline recompute would
    // correct it, which is exactly what the deferral must not do here.
    sqlx::query("UPDATE pages_cache SET child_block_count = 99 WHERE page_id = 'PAGE_X'")
        .execute(&pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    maintain_pages_cache_counts_after_op(&mut conn, &PreOpState::Deferred, None)
        .await
        .unwrap();
    drop(conn);

    let (_, child) = cached_counts(&pool, "PAGE_X").await.unwrap();
    assert_eq!(
        child, 99,
        "a cohort op must leave the count to the background task; got {child}"
    );
}

/// #5423 — an edit does not recompute its own page's counts. It moves no block
/// into or out of the page, and the page's inbound count skips sources on the
/// page itself, so that recompute could only re-derive the stored values; the
/// edits in the parity tests around this one pin that the counts stay right
/// without it.
///
/// A deliberately wrong seeded value stands in for the recompute's output, as in
/// `cohort_ops_defer_the_count_recompute_2042`, so the assertion fails the moment
/// an edit recomputes its page again.
#[tokio::test]
async fn edit_leaves_its_own_page_counts_alone_5423() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_E", "Page E").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('CHILD_E', 'content', 'before', 'PAGE_E', 'PAGE_E')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Deliberately wrong: the real count is 1.
    sqlx::query("UPDATE pages_cache SET child_block_count = 99 WHERE page_id = 'PAGE_E'")
        .execute(&pool)
        .await
        .unwrap();

    let payload = r#"{"block_id":"CHILD_E","to_text":"after","prev_edit":null}"#;
    run_op(&pool, op_task("edit_block", payload), &[]).await;

    let content: Option<String> =
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = 'CHILD_E'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("after"),
        "the edit must have applied, or the count below proves nothing"
    );
    let (_, child) = cached_counts(&pool, "PAGE_E").await.unwrap();
    assert_eq!(
        child, 99,
        "an edit must leave its own page's counts alone; got {child}"
    );
}

/// Multi-page fixture with mixed link patterns; exercises every
/// op kind and asserts parity at every step. The fixture is
/// Intentionally small (10 pages instead of the 1000
/// proposed) — the parity contract is op-agnostic, so the same
/// invariants would hold at any scale. Larger fixtures slow the
/// CI loop without adding coverage.
#[tokio::test]
async fn mixed_fixture_full_lifecycle() {
    let (pool, _dir) = test_pool().await;
    // 10 pages.
    for i in 0..10 {
        let id = format!("P{i:02}");
        let title = format!("Page {i:02}");
        seed_page(&pool, &id, &title).await;
    }
    // Seed a few content blocks with cross-page links via direct
    // SQL so we have non-zero counts to track. Then the op loop
    // mutates them and asserts parity after every step.
    for i in 0..10 {
        let block_id = format!("CB{i:02}");
        let page_id = format!("P{i:02}");
        let link_target = format!("P{:02}", (i + 1) % 10);
        let content = format!("body [[{link_target}]]");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
                 VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&block_id)
        .bind(&content)
        .bind(&page_id)
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&block_id)
            .bind(&link_target)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Bring pages_cache up to date with the seeded state via the
    // canonical recompute (since direct inserts bypassed the
    // materializer).
    sqlx::query(
        "UPDATE pages_cache SET \
                 inbound_link_count = ( \
                     SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                         JOIN blocks d ON bl.target_id = d.id \
                         JOIN blocks src ON src.id = bl.source_id \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND src.deleted_at IS NULL \
                           AND src.page_id IS NOT NULL \
                           AND src.page_id != pages_cache.page_id), \
                 child_block_count = ( \
                     SELECT COUNT(*) FROM blocks d \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND d.id != pages_cache.page_id)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_parity(&pool, "seeded fixture").await;

    // Op 1: EditBlock to drop CB00's link.
    let payload = r#"{"block_id":"CB00","to_text":"body","prev_edit":null}"#;
    run_op(&pool, op_task("edit_block", payload), &["CB00"]).await;
    assert_parity(&pool, "after edit CB00 drop link").await;

    // Op 2: EditBlock to add a new link from CB01 to P05.
    let payload = r#"{"block_id":"CB01","to_text":"body [[P02]] [[P05]]","prev_edit":null}"#;
    run_op(&pool, op_task("edit_block", payload), &["CB01"]).await;
    assert_parity(&pool, "after edit CB01 add link").await;

    // Op 3: DeleteBlock soft-deletes CB02 (which links to P03).
    let payload = r#"{"block_id":"CB02"}"#;
    run_op(&pool, op_task("delete_block", payload), &[]).await;
    assert_parity(&pool, "after delete CB02").await;

    // Op 4: RestoreBlock the same block.
    let deleted_at: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'CB02'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let payload = format!(r#"{{"block_id":"CB02","deleted_at_ref":{deleted_at}}}"#);
    run_op(&pool, op_task("restore_block", &payload), &[]).await;
    assert_parity(&pool, "after restore CB02").await;

    // Op 5: CreateBlock — a new content block on P07 that links to P00.
    let payload = r#"{"block_id":"NEW1","block_type":"content","content":"hi [[P00]]","parent_id":"P07","position":1}"#;
    run_op(&pool, op_task("create_block", payload), &["NEW1"]).await;
    // SQL-only fallback doesn't set page_id; mirror what RebuildPageIds would do.
    sqlx::query("UPDATE blocks SET page_id = 'P07' WHERE id = 'NEW1'")
        .execute(&pool)
        .await
        .unwrap();
    // Bring counts up to date for the affected pages now that page_id
    // is finally populated.
    sqlx::query(
        "UPDATE pages_cache SET \
                 inbound_link_count = ( \
                     SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                         JOIN blocks d ON bl.target_id = d.id \
                         JOIN blocks src ON src.id = bl.source_id \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND src.deleted_at IS NULL \
                           AND src.page_id IS NOT NULL \
                           AND src.page_id != pages_cache.page_id), \
                 child_block_count = ( \
                     SELECT COUNT(*) FROM blocks d \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND d.id != pages_cache.page_id) \
             WHERE page_id IN ('P00', 'P07')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_parity(&pool, "after create NEW1").await;

    // Op 6: PurgeBlock — hard-delete NEW1.
    let payload = r#"{"block_id":"NEW1"}"#;
    run_op(&pool, op_task("purge_block", payload), &[]).await;
    assert_parity(&pool, "after purge NEW1").await;
}

/// T-B6 — same-page (and self) edges must NOT count toward
/// `inbound_link_count`. A block on page P linking to another block on
/// the same page P is a same-page reference; the canonical backlink
/// query (`backlink/grouped.rs`) excludes it via `src.page_id != P`, so
/// the materialised column must too. The OLD 0069 shape (no `src` join)
/// would have counted it as 1 — this test pins it to 0 and then proves
/// a cross-page edge from a different page DOES count.
#[tokio::test]
async fn same_page_edge_excluded_from_inbound_count() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_P", "Page P").await;

    // Two content descendants of PAGE_P, both with page_id = PAGE_P.
    for id in ["PD_1", "PD_2"] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
                 VALUES (?, 'content', 'c', 'PAGE_P', 'PAGE_P')",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Same-page edge: PD_1 (on PAGE_P) links to PD_2 (also on PAGE_P).
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES ('PD_1', 'PD_2')")
        .execute(&pool)
        .await
        .unwrap();

    // Recompute via the corrected inline UPDATE (direct inserts bypassed
    // the materializer). Mirrors the canonical_counts shape.
    let recompute = "UPDATE pages_cache SET \
                 inbound_link_count = ( \
                     SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                         JOIN blocks d ON bl.target_id = d.id \
                         JOIN blocks src ON src.id = bl.source_id \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND src.deleted_at IS NULL \
                           AND src.page_id IS NOT NULL \
                           AND src.page_id != pages_cache.page_id), \
                 child_block_count = ( \
                     SELECT COUNT(*) FROM blocks d \
                         WHERE d.page_id = pages_cache.page_id \
                           AND d.deleted_at IS NULL \
                           AND d.id != pages_cache.page_id)";
    sqlx::query(recompute).execute(&pool).await.unwrap();

    // The same-page edge must NOT count: inbound stays 0 (OLD shape: 1).
    let (inbound, _) = cached_counts(&pool, "PAGE_P").await.unwrap();
    assert_eq!(
        inbound, 0,
        "same-page edge must be excluded from inbound_link_count"
    );
    assert_parity(&pool, "same-page edge only").await;

    // Now add a cross-page edge: a block on a DIFFERENT page (PAGE_Q)
    // links into a descendant of PAGE_P. That one DOES count.
    seed_page(&pool, "PAGE_Q", "Page Q").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('QD_1', 'content', 'c', 'PAGE_Q', 'PAGE_Q')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES ('QD_1', 'PD_2')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(recompute).execute(&pool).await.unwrap();

    let (inbound, _) = cached_counts(&pool, "PAGE_P").await.unwrap();
    assert_eq!(
        inbound, 1,
        "cross-page edge from a different page must count toward inbound_link_count"
    );
    assert_parity(&pool, "after cross-page edge").await;
}

/// #1548 — the per-op `inbound_link_count` must be correct SYNCHRONOUSLY,
/// i.e. immediately after the foreground `ApplyOp` for a link-adding /
/// link-removing edit, WITHOUT waiting for the background
/// `ReindexBlockLinks` task. Before the fix the foreground recompute joined
/// `block_links` before the new edge was written (that write happened only
/// in the async reindex), so the count stayed stale until the async job
/// caught up. The fix writes the block's outbound edges in-tx via
/// `cache::reindex_block_links_conn` before the recompute.
///
/// This test asserts BOTH halves of the contract:
///  1. After the FG op ALONE (no BG ReindexBlockLinks), the cached
///     `inbound_link_count` already equals the canonical live value.
///  2. Running the BG ReindexBlockLinks afterwards yields the SAME value —
///     the synchronous update and the backstop rebuild converge with no
///     double-count.
#[tokio::test]
async fn inbound_count_correct_synchronously_without_bg_reindex() {
    // 26-char Crockford-base32 ids so `ULID_LINK_RE` ([0-9A-Z]{26})
    // actually matches the `[[..]]` token and a real `block_links` edge
    // is created (short fixture ids would silently never match the regex).
    const SRC_PG: &str = "01HZ00000000000000000SRCPG";
    const TGT_PG: &str = "01HZ00000000000000000TGTPG";
    const SRC_CB: &str = "01HZ00000000000000000SRCCB";

    let (pool, _dir) = test_pool().await;
    seed_page(&pool, SRC_PG, "Source Page").await;
    seed_page(&pool, TGT_PG, "Target Page").await;

    // A content block on SRC_PG that will hold the link. page_id is set
    // directly (mirrors what RebuildPageIds stamps) so the cross-page
    // src.page_id != target exclusion evaluates correctly.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES (?, 'content', 'body', ?, ?)",
    )
    .bind(SRC_CB)
    .bind(SRC_PG)
    .bind(SRC_PG)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE pages_cache SET child_block_count = 1 WHERE page_id = ?")
        .bind(SRC_PG)
        .execute(&pool)
        .await
        .unwrap();
    assert_parity(&pool, "seeded source block").await;

    // Baseline: TGT_PG has no inbound links yet.
    let (inbound, _) = cached_counts(&pool, TGT_PG).await.unwrap();
    assert_eq!(inbound, 0, "target starts with zero inbound links");

    // EditBlock that ADDS a [[TGT_PG]] link — but drive ONLY the foreground
    // ApplyOp (note the empty `link_block_ids`: NO BG ReindexBlockLinks is
    // run). This is the heart of #1548: pre-fix the in-tx recompute joined
    // `block_links` before the edge existed, so the count stayed 0 here.
    let payload =
        format!(r#"{{"block_id":"{SRC_CB}","to_text":"body [[{TGT_PG}]]","prev_edit":null}}"#);
    run_op(&pool, op_task("edit_block", &payload), &[]).await;

    // (1) Synchronous correctness: the FG op ALONE must have made the
    // count correct — the edge was written in-tx and the recompute saw it.
    let (inbound_fg, _) = cached_counts(&pool, TGT_PG).await.unwrap();
    assert_eq!(
        inbound_fg, 1,
        "inbound_link_count must be correct synchronously after the FG op, \
         BEFORE any background ReindexBlockLinks runs"
    );
    // And it must equal the canonical live value, not just a literal.
    let (canon_inbound, _) = canonical_counts(&pool, TGT_PG).await;
    assert_eq!(
        inbound_fg, canon_inbound,
        "synchronous count must equal the canonical live SELECT"
    );
    assert_parity(&pool, "after FG-only link add").await;

    // (2) No double-count: running the BG ReindexBlockLinks (the backstop)
    // afterwards must leave the value unchanged — the diff is now empty.
    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockLinks {
            block_id: SRC_CB.into(),
        },
        None,
        None,
    )
    .await
    .unwrap();
    let (inbound_after_bg, _) = cached_counts(&pool, TGT_PG).await.unwrap();
    assert_eq!(
        inbound_after_bg, 1,
        "background ReindexBlockLinks must NOT double-count — converges to the same value"
    );
    assert_parity(&pool, "after backstop BG reindex").await;

    // Now REMOVE the link, again FG-only, and assert it decrements
    // synchronously back to 0.
    let payload = format!(r#"{{"block_id":"{SRC_CB}","to_text":"body","prev_edit":null}}"#);
    run_op(&pool, op_task("edit_block", &payload), &[]).await;
    let (inbound_removed, _) = cached_counts(&pool, TGT_PG).await.unwrap();
    assert_eq!(
        inbound_removed, 0,
        "inbound_link_count must decrement synchronously when the link is removed"
    );
    assert_parity(&pool, "after FG-only link remove").await;

    // Backstop again: still 0, no drift.
    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockLinks {
            block_id: SRC_CB.into(),
        },
        None,
        None,
    )
    .await
    .unwrap();
    let (inbound_final, _) = cached_counts(&pool, TGT_PG).await.unwrap();
    assert_eq!(inbound_final, 0, "removal stays converged after BG reindex");
    assert_parity(&pool, "after backstop BG reindex (removal)").await;
}

/// E4 — a `MoveBlock` that reparents a block onto a DIFFERENT page must
/// refresh BOTH the source page's and the destination page's
/// `child_block_count`. Before the fix the MoveBlock arm was a no-op
/// (it asserted "MoveBlock never alters page_id", which `move_ops.rs`
/// already violated), so both counts drifted until an unrelated op
/// touched each page.
///
/// Drives the real materializer `ApplyOp(move_block)` path end-to-end
/// and asserts hard literals on both pages plus full parity.
#[tokio::test]
async fn cross_page_move_refreshes_both_page_counts() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "PAGE_SRC", "Source").await;
    seed_page(&pool, "PAGE_DST", "Destination").await;

    // A content block + a grandchild, both owned by PAGE_SRC.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('MV_PARENT', 'content', 'p', 'PAGE_SRC', 'PAGE_SRC')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES ('MV_CHILD', 'content', 'c', 'MV_PARENT', 'PAGE_SRC')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Bring counts up to date: PAGE_SRC has 2 descendants, PAGE_DST 0.
    sqlx::query("UPDATE pages_cache SET child_block_count = 2 WHERE page_id = 'PAGE_SRC'")
        .execute(&pool)
        .await
        .unwrap();
    assert_parity(&pool, "seeded 2 children on source").await;
    let (_, src_child) = cached_counts(&pool, "PAGE_SRC").await.unwrap();
    let (_, dst_child) = cached_counts(&pool, "PAGE_DST").await.unwrap();
    assert_eq!(src_child, 2, "PAGE_SRC starts with 2 children");
    assert_eq!(dst_child, 0, "PAGE_DST starts empty");

    // MoveBlock: reparent MV_PARENT (and its subtree) onto PAGE_DST.
    let payload = r#"{"block_id":"MV_PARENT","new_parent_id":"PAGE_DST","new_position":0}"#;
    run_op(&pool, op_task("move_block", payload), &[]).await;

    // Hard literals: the 2-block subtree migrated from SRC to DST.
    let (_, src_child) = cached_counts(&pool, "PAGE_SRC").await.unwrap();
    let (_, dst_child) = cached_counts(&pool, "PAGE_DST").await.unwrap();
    assert_eq!(
        src_child, 0,
        "source page must lose both moved descendants after cross-page move"
    );
    assert_eq!(
        dst_child, 2,
        "destination page must gain both moved descendants after cross-page move"
    );
    assert_parity(&pool, "after cross-page move").await;

    // Sanity: the moved subtree's `page_id` was reparented in-tx, so
    // the structural oracle (which walks parent_id) agrees with the
    // page_id-keyed cache.
    let moved_page: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'MV_CHILD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        moved_page.as_deref(),
        Some("PAGE_DST"),
        "grandchild's page_id must follow the moved subtree to the destination"
    );
}

// ---------------------------------------------------------------------------
// #5371 — `pages_cache.{title_sort_key,last_edited_ms}` parity
// ---------------------------------------------------------------------------

/// Every row's `title_sort_key` is the key of its title, and its
/// `last_edited_ms` is at least the newest op on any block now on the page.
/// It may sit higher, never lower: ops on a block that moved away keep the
/// credit they gave, so each test also pins the touched page exactly.
async fn assert_sort_key_parity(pool: &SqlitePool, context: &str) {
    let rows: Vec<(String, String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT pc.page_id, pc.title, pc.title_sort_key, pc.last_edited_ms, \
                (SELECT MAX(o.created_at) FROM op_log o JOIN blocks d ON d.id = o.block_id \
                  WHERE d.page_id = pc.page_id) \
           FROM pages_cache pc",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    for (page_id, title, key, last_edited, newest_op) in rows {
        assert_eq!(
            key,
            agaric_core::title_sort::title_sort_key(&title),
            "[{context}] title_sort_key drift on page_id={page_id}",
        );
        assert!(
            last_edited >= newest_op.unwrap_or(0),
            "[{context}] last_edited_ms={last_edited} below the newest op {newest_op:?} on \
             page_id={page_id}",
        );
    }
}

async fn last_edited(pool: &SqlitePool, page_id: &str) -> i64 {
    sqlx::query_scalar("SELECT last_edited_ms FROM pages_cache WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn seed_child(pool: &SqlitePool, id: &str, page_id: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
         VALUES (?, 'content', 'c', ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

/// An op stamped `created_at`: two ops one test compares must not share a
/// millisecond, or an assertion that tells them apart passes vacuously.
async fn make_op_record_at(pool: &SqlitePool, payload: OpPayload, created_at: i64) -> OpRecord {
    agaric_store::op_log::append_local_op_at(pool, DEV, payload, created_at)
        .await
        .unwrap()
}

fn edit(block_id: &str, to_text: &str) -> OpPayload {
    OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: to_text.into(),
        prev_edit: None,
        prior_text: None,
    })
}

/// #5371 — the single-op `ApplyOp` path: a child's edit or delete moves its
/// page to the op's time and leaves other pages alone; a retitle re-keys the
/// page once `RebuildPagesCache` runs.
#[tokio::test]
async fn sort_keys_follow_single_ops_5371() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "SK_PAGE_A", "Émile").await;
    seed_page(&pool, "SK_PAGE_B", "Zebra").await;
    seed_child(&pool, "SK_CHILD_A", "SK_PAGE_A").await;
    assert_sort_key_parity(&pool, "seeded").await;

    let e = make_op_record_at(&pool, edit("SK_CHILD_A", "edited"), FIXED_TS + 1).await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(e.clone())), &[]).await;
    assert_eq!(
        last_edited(&pool, "SK_PAGE_A").await,
        e.created_at,
        "child edit"
    );
    assert_eq!(last_edited(&pool, "SK_PAGE_B").await, 0, "untouched page");
    assert_sort_key_parity(&pool, "after child edit").await;

    let d = make_op_record_at(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("SK_CHILD_A"),
        }),
        FIXED_TS + 2,
    )
    .await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(d.clone())), &[]).await;
    assert_eq!(
        last_edited(&pool, "SK_PAGE_A").await,
        d.created_at,
        "child delete"
    );
    assert_sort_key_parity(&pool, "after child delete").await;

    let t = make_op_record_at(&pool, edit("SK_PAGE_B", "ángel"), FIXED_TS + 3).await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(t.clone())), &[]).await;
    handle_background_task(&pool, &MaterializeTask::RebuildPagesCache, None, None)
        .await
        .unwrap();
    let key: String =
        sqlx::query_scalar("SELECT title_sort_key FROM pages_cache WHERE page_id = 'SK_PAGE_B'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(key, "angel", "retitle re-keys the page");
    assert_eq!(
        last_edited(&pool, "SK_PAGE_B").await,
        t.created_at,
        "retitle"
    );
    assert_sort_key_parity(&pool, "after retitle").await;
}

/// #5371 — the `BatchApplyOps` path raises every page the batch touched to
/// its own newest op.
#[tokio::test]
async fn sort_keys_follow_a_batch_5371() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "SK_PAGE_C", "Charlie").await;
    seed_page(&pool, "SK_PAGE_D", "Delta").await;
    seed_page(&pool, "SK_PAGE_E", "Echo").await;
    seed_child(&pool, "SK_CHILD_C1", "SK_PAGE_C").await;
    seed_child(&pool, "SK_CHILD_C2", "SK_PAGE_C").await;
    seed_child(&pool, "SK_CHILD_D", "SK_PAGE_D").await;

    let c1 = make_op_record_at(&pool, edit("SK_CHILD_C1", "one"), FIXED_TS + 1).await;
    let d = make_op_record_at(&pool, edit("SK_CHILD_D", "two"), FIXED_TS + 2).await;
    let c2 = make_op_record_at(&pool, edit("SK_CHILD_C2", "three"), FIXED_TS + 3).await;
    handle_foreground_task(
        &pool,
        &MaterializeTask::BatchApplyOps(StdArc::new(vec![c1, d.clone(), c2.clone()])),
        &LoroState::new(),
    )
    .await
    .unwrap();

    assert_eq!(
        last_edited(&pool, "SK_PAGE_C").await,
        c2.created_at,
        "newest of two"
    );
    assert_eq!(
        last_edited(&pool, "SK_PAGE_D").await,
        d.created_at,
        "its own op"
    );
    assert_eq!(last_edited(&pool, "SK_PAGE_E").await, 0, "not in the batch");
    assert_sort_key_parity(&pool, "after batch").await;
}

/// #5371 — a move between pages moves the destination up; the source keeps
/// the credit its earlier ops gave it.
#[tokio::test]
async fn a_cross_page_move_raises_the_destination_only_5371() {
    let (pool, _dir) = test_pool().await;
    seed_page(&pool, "SK_PAGE_SRC", "Source").await;
    seed_page(&pool, "SK_PAGE_DST", "Destination").await;
    seed_child(&pool, "SK_MOVED", "SK_PAGE_SRC").await;

    let e = make_op_record_at(&pool, edit("SK_MOVED", "before the move"), FIXED_TS + 1).await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(e.clone())), &[]).await;
    let m = make_op_record_at(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("SK_MOVED"),
            new_parent_id: Some(BlockId::test_id("SK_PAGE_DST")),
            new_position: 0,
            new_index: None,
            prior: None,
        }),
        FIXED_TS + 2,
    )
    .await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(m.clone())), &[]).await;

    assert_eq!(
        last_edited(&pool, "SK_PAGE_DST").await,
        m.created_at,
        "destination"
    );
    assert_eq!(
        last_edited(&pool, "SK_PAGE_SRC").await,
        e.created_at,
        "source unchanged"
    );
    assert_sort_key_parity(&pool, "after cross-page move").await;
}

/// #5371 — a page created through `ApplyOp` carries its title key from the
/// create itself: no `RebuildPagesCache` runs before the read.
#[tokio::test]
async fn a_page_create_writes_its_title_key_without_a_rebuild_5371() {
    let (pool, _dir) = test_pool().await;
    let c = make_op_record_at(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("SK_PAGE_NEW"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "Émile".into(),
        }),
        FIXED_TS + 1,
    )
    .await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(c.clone())), &[]).await;

    let row: (String, i64) = sqlx::query_as(
        "SELECT title_sort_key, last_edited_ms FROM pages_cache WHERE page_id = 'SK_PAGE_NEW'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        ("emile".to_owned(), c.created_at),
        "the create's INSERT writes the key, and the apply raises the row to the create"
    );
}

// ---------------------------------------------------------------------------
// #5371 — `pages_cache.space_id` parity
// ---------------------------------------------------------------------------

const SP_SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5371";
const SP_SPACE_B: &str = "01ARZ3NDEKTSV4RRFFQ69G5372";
const SP_PAGE: &str = "01HZ00000000000000000P5371";

/// Every row's `space_id` is its page's `blocks.space_id`: the Pages list
/// reads the space from the cache row.
async fn assert_space_parity(pool: &SqlitePool, context: &str) {
    let drift: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT pc.page_id, pc.space_id, b.space_id FROM pages_cache pc \
           JOIN blocks b ON b.id = pc.page_id \
          WHERE pc.space_id IS NOT b.space_id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(
        drift,
        Vec::new(),
        "[{context}] (page, cached space, page's space)"
    );
}

async fn cached_space(pool: &SqlitePool, page_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT space_id FROM pages_cache WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A registered space: its block (a `tag`, so it has no cache row of its
/// own) and its `spaces` row, which a `space` op's projection requires.
async fn seed_space(pool: &SqlitePool, id: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', 'space')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

fn set_space(block_id: &str, space: &str) -> OpPayload {
    OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted(block_id),
        key: "space".into(),
        value_text: None,
        value_num: None,
        value_date: None,
        value_ref: Some(BlockId::from_trusted(space)),
        value_bool: None,
        prior: None,
    })
}

fn create_page(block_id: &str, title: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: "page".into(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: title.into(),
    })
}

/// #5371 — a page's cache row follows its space in the transaction that
/// moves the page: born with the page's space, moved by each `space` op,
/// cleared with it. No `RebuildPagesCache` runs between an op and its
/// assertion, so each one sees the in-transaction write alone.
#[tokio::test]
async fn space_id_follows_the_page_through_its_space_ops_5371() {
    let (pool, _dir) = test_pool().await;
    let state = LoroState::new();
    seed_space(&pool, SP_SPACE_A).await;
    seed_space(&pool, SP_SPACE_B).await;
    let apply = async |payload: OpPayload, at: i64| {
        let record = make_op_record_at(&pool, payload, at).await;
        handle_foreground_task(
            &pool,
            &MaterializeTask::ApplyOp(StdArc::new(record)),
            &state,
        )
        .await
        .unwrap();
    };

    apply(create_page(SP_PAGE, "Spaced"), FIXED_TS + 1).await;
    assert_eq!(cached_space(&pool, SP_PAGE).await, None, "born space-less");

    apply(set_space(SP_PAGE, SP_SPACE_A), FIXED_TS + 2).await;
    assert_eq!(
        cached_space(&pool, SP_PAGE).await.as_deref(),
        Some(SP_SPACE_A),
        "the first space op"
    );

    apply(set_space(SP_PAGE, SP_SPACE_B), FIXED_TS + 3).await;
    assert_eq!(
        cached_space(&pool, SP_PAGE).await.as_deref(),
        Some(SP_SPACE_B),
        "a move to another space"
    );
    assert_space_parity(&pool, "after the move").await;

    let mut conn = pool.acquire().await.unwrap();
    crate::loro::projection::project_delete_property_to_sql(&mut conn, SP_PAGE, "space")
        .await
        .unwrap();
    drop(conn);
    assert_eq!(
        cached_space(&pool, SP_PAGE).await,
        None,
        "a DeleteProperty(space)"
    );
    assert_space_parity(&pool, "after the clear").await;
}

/// #5371 — the two other writers: a page row born where the page already has
/// a space (a create re-applied after a reset wiped the cache) copies it,
/// and the page-row rebuild repairs a row any other path left behind.
#[tokio::test]
async fn space_id_is_born_from_the_page_and_repaired_by_the_rebuild_5371() {
    let (pool, _dir) = test_pool().await;
    seed_space(&pool, SP_SPACE_A).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id, space_id) \
         VALUES (?, 'page', 'Spaced', ?, ?)",
    )
    .bind(SP_PAGE)
    .bind(SP_PAGE)
    .bind(SP_SPACE_A)
    .execute(&pool)
    .await
    .unwrap();

    let create = make_op_record_at(&pool, create_page(SP_PAGE, "Spaced"), FIXED_TS + 1).await;
    run_op(&pool, MaterializeTask::ApplyOp(StdArc::new(create)), &[]).await;
    assert_eq!(
        cached_space(&pool, SP_PAGE).await.as_deref(),
        Some(SP_SPACE_A),
        "the create's INSERT copies the page's space"
    );

    sqlx::query("UPDATE pages_cache SET space_id = NULL WHERE page_id = ?")
        .bind(SP_PAGE)
        .execute(&pool)
        .await
        .unwrap();
    handle_background_task(&pool, &MaterializeTask::RebuildPagesCache, None, None)
        .await
        .unwrap();
    assert_eq!(
        cached_space(&pool, SP_PAGE).await.as_deref(),
        Some(SP_SPACE_A),
        "the rebuild restores a stale space"
    );
    assert_space_parity(&pool, "after the rebuild").await;
}

/// #5371 — a `RestoreBlock` the materializer applies (a peer's, or a replay)
/// gives the page back the cache row the rebuild swept while it sat in the
/// trash, in the op's own transaction: the Pages list reads its rows from the
/// cache. The row is born as the rebuild births one, the restore its newest op.
#[tokio::test]
async fn a_restore_gives_the_page_back_its_swept_row_5371() {
    let (pool, _dir) = test_pool().await;
    seed_space(&pool, SP_SPACE_A).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id, space_id, deleted_at) \
         VALUES (?, 'page', 'Émile', ?, ?, ?)",
    )
    .bind(SP_PAGE)
    .bind(SP_PAGE)
    .bind(SP_SPACE_A)
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();

    let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(SP_PAGE),
        deleted_at_ref: FIXED_TS,
    });
    let record = make_op_record_at(&pool, restore, FIXED_TS + 1).await;
    handle_foreground_task(
        &pool,
        &MaterializeTask::ApplyOp(StdArc::new(record)),
        &LoroState::new(),
    )
    .await
    .unwrap();

    let row: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT title_sort_key, space_id, last_edited_ms FROM pages_cache WHERE page_id = ?",
    )
    .bind(SP_PAGE)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        Some((
            "emile".to_owned(),
            Some(SP_SPACE_A.to_owned()),
            FIXED_TS + 1
        ))
    );
}

/// #5371 — a `MoveBlock` that carries a nested page out of its deleted parent
/// (the concurrent delete-vs-move merge, #4204) un-sweeps it, and the page
/// gets back the cache row the rebuild swept, in the op's own transaction.
/// The parent it left stays trashed and off the list.
#[tokio::test]
async fn an_un_sweeping_move_gives_the_page_back_its_swept_row_5371() {
    const PARENT: &str = "01HZ00000000000000000Q5371";
    let (pool, _dir) = test_pool().await;
    for (id, title, parent) in [(PARENT, "Parent", None), (SP_PAGE, "Émile", Some(PARENT))] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id, deleted_at) \
             VALUES (?, 'page', ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(parent)
        .bind(id)
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();
    }

    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(SP_PAGE),
        new_parent_id: None,
        new_position: 0,
        new_index: Some(0),
        prior: None,
    });
    let record = make_op_record_at(&pool, mv, FIXED_TS + 1).await;
    handle_foreground_task(
        &pool,
        &MaterializeTask::ApplyOp(StdArc::new(record)),
        &LoroState::new(),
    )
    .await
    .unwrap();

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT page_id, title_sort_key, last_edited_ms FROM pages_cache ORDER BY page_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(SP_PAGE.to_owned(), "emile".to_owned(), FIXED_TS + 1)]
    );
}
