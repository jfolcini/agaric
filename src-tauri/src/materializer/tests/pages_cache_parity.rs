// ---------------------------------------------------------------------------
// PEND-56b — `pages_cache.{inbound_link_count,child_block_count}` parity
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
// to the cached columns. Drift here is the cliff PEND-56b is closing.

use super::*;
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
/// same-page/orphan exclusions with the recompute by necessity (those
/// are the definition, not an implementation detail), so the parity
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
               AND src.page_id != ?",
    )
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
/// default (zero) counts. Sets `page_id = id` to mirror what
/// `RebuildPageIds` would compute. Title = content per the canonical
/// pages_cache contract (see `cache/pages.rs::DESIRED_PAGES_SQL`).
async fn seed_page(pool: &SqlitePool, id: &str, title: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)")
        .bind(id)
        .bind(title)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
            "INSERT INTO pages_cache (page_id, title, updated_at, inbound_link_count, child_block_count) \
             VALUES (?, ?, 1735689600000, 0, 0)",
        )
        .bind(id)
        .bind(title)
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

/// Drive the FG ApplyOp + the matching BG ReindexBlockLinks (when
/// applicable) so the materialised counts settle to their canonical
/// values for both `child_block_count` (FG) and `inbound_link_count`
/// (BG, after `block_links` is updated).
async fn run_op(pool: &SqlitePool, task: MaterializeTask, link_block_ids: &[&str]) {
    handle_foreground_task(pool, &task, &empty_gcal_handle())
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

/// Multi-page fixture with mixed link patterns; exercises every
/// op kind and asserts parity at every step. The fixture is
/// intentionally small (10 pages instead of the 1000 PEND-56b
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
