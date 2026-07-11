use super::super::*;
use super::common::*;
use crate::op::{
    DeletePropertyPayload, EditBlockPayload, OpPayload, OpRef, RemoveTagPayload, SetPropertyPayload,
};
use crate::op_log;

/// #2549 regression-test helper: insert a REPLICATED (audit-only,
/// `is_replicated = 1`) op from a foreign device — a row ingested for
/// provenance that is NEVER applied to local state (#2481/#2495). Goes
/// through the real sync-ingest core (`dag::insert_replicated_op`) so the
/// denormalized `block_id` column is populated and `is_replicated = 1` is
/// stamped exactly as a synced audit row would be. Mirrors
/// `reverse::tests::append_replicated_op`.
async fn append_replicated_op(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    mut payload: OpPayload,
    ts: i64,
) {
    payload.normalize_block_ids();
    let op_type = payload.op_type_str().to_owned();
    let payload_json = op_log::serialize_inner_payload(&payload).unwrap();
    let hash = crate::hash::compute_op_hash(device_id, seq, None, &op_type, &payload_json);
    let transfer = crate::sync_protocol::types::OpTransfer {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs: None,
        hash,
        op_type,
        payload: payload_json,
        created_at: ts,
        origin: "agent:codex".to_owned(),
    };
    crate::dag::insert_replicated_op(pool, &transfer)
        .await
        .expect("replicated audit op must ingest");
}

// ======================================================================
// Undo/Redo tests
// ======================================================================
//
// Removed 13 `tokio::time::sleep(Duration::from_millis(2))` calls
// that were used to ensure consecutive ops got distinct timestamps. They
// are no longer necessary because every undo/redo query in this code path
// uses `(created_at, seq[, device_id])` lexicographic ordering, and `seq`
// is strictly monotonic per device (enforced by `COALESCE(MAX(seq), 0) + 1`
// under `BEGIN IMMEDIATE` transactions in `op_log::append_local_op*`).
// Equal timestamps therefore still produce a total order on
// `(created_at, seq, device_id)`, so removing the sleep introduces no
// non-determinism. Do NOT re-add sleep guards here without first checking
// whether a new query path was added that compares `created_at` only.

/// Helper: create a page with children and return (page_id, child_ids)
async fn create_page_with_children(pool: &SqlitePool, mat: &Materializer) -> (String, Vec<String>) {
    let page = create_block_inner(
        pool,
        DEV,
        mat,
        "page".into(),
        "Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child1 = create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        "child one".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child2 = create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        "child two".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    (
        page.id.into_string(),
        vec![child1.id.into_string(), child2.id.into_string()],
    )
}

// -- list_page_history tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_returns_ops_for_page_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child1 to produce more ops
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited child one".into(),
    )
    .await
    .unwrap();

    // Also create an unrelated block to ensure it's excluded
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "unrelated".into(),
        None,
        Some(10),
    )
    .await
    .unwrap();

    let result = list_page_history_inner(
        &pool,
        page_id.clone(),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    // Should include: create_block (page), create_block (child1), create_block (child2), edit_block (child1)
    assert_eq!(
        result.items.len(),
        4,
        "should have 4 ops for page descendants"
    );

    // Verify all ops are for page or its descendants
    for entry in &result.items {
        let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
        let block_id = payload["block_id"].as_str().unwrap();
        assert!(
            block_id == page_id || child_ids.contains(&block_id.to_string()),
            "op should be for page or its descendants, got block_id: {block_id}"
        );
    }

    // Newest first
    assert_eq!(result.items[0].op_type, "edit_block", "newest op first");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_with_op_type_filter() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child1
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();

    let result = list_page_history_inner(
        &pool,
        page_id.clone(),
        Some("edit_block".into()),
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.items.len(), 1, "should only have edit_block ops");
    assert_eq!(
        result.items[0].op_type, "edit_block",
        "filtered op type should be edit_block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_pagination_works() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child to have 4 total ops
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();

    // Page 1: limit 2
    let page1 = list_page_history_inner(
        &pool,
        page_id.clone(),
        None,
        &SpaceScope::Global,
        None,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(page1.items.len(), 2, "first page should have 2 items");
    assert!(page1.has_more, "should have more items");
    assert!(page1.next_cursor.is_some(), "should have a cursor");

    // Page 2: use cursor from page 1
    let page2 = list_page_history_inner(
        &pool,
        page_id.clone(),
        None,
        &SpaceScope::Global,
        page1.next_cursor,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(page2.items.len(), 2, "second page should have 2 items");
    assert!(!page2.has_more, "should be the last page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_all_returns_ops_from_all_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create two separate pages with children
    let (page_a, _children_a) = create_page_with_children(&pool, &mat).await;
    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Second Page".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child of page b".into(),
        Some(page_b.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // __all__ should return ops from both pages
    let result = list_page_history_inner(
        &pool,
        "__all__".to_string(),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    // page_a (1 create) + 2 children + page_b (1 create) + child_b (1 create) = 5
    assert_eq!(
        result.items.len(),
        5,
        "should have ops from all pages, got: {}",
        result.items.len()
    );

    // Verify ops reference both pages' blocks
    let block_ids: Vec<String> = result
        .items
        .iter()
        .map(|e| {
            let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap();
            payload["block_id"].as_str().unwrap().to_string()
        })
        .collect();
    assert!(block_ids.contains(&page_a), "should contain ops for page_a");
    assert!(
        block_ids.contains(&page_b.id.clone().into_string()),
        "should contain ops for page_b"
    );
    assert!(
        block_ids.contains(&child_b.id.clone().into_string()),
        "should contain ops for child_b"
    );

    // Pagination: limit=2
    let page1 = list_page_history_inner(
        &pool,
        "__all__".to_string(),
        None,
        &SpaceScope::Global,
        None,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(page1.items.len(), 2, "first page should have 2 items");
    assert!(page1.has_more, "should have more items");
    assert!(page1.next_cursor.is_some(), "should have a cursor");

    let page2 = list_page_history_inner(
        &pool,
        "__all__".to_string(),
        None,
        &SpaceScope::Global,
        page1.next_cursor,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(page2.items.len(), 2, "second page should have 2 items");
    assert!(page2.has_more, "should still have more items");

    let page3 = list_page_history_inner(
        &pool,
        "__all__".to_string(),
        None,
        &SpaceScope::Global,
        page2.next_cursor,
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(page3.items.len(), 1, "third page should have 1 item");
    assert!(!page3.has_more, "should be the last page");
}

// -- revert_ops tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_reverses_single_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create and edit a block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let _edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "modified".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify block is now "modified"
    let before_undo = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        before_undo.content,
        Some("modified".into()),
        "block should contain modified content before undo"
    );

    // Get the edit op's seq
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();

    // Revert it
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: edit_op.seq,
        }],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 1, "should have one result");
    assert_eq!(
        results[0].reversed_op.seq, edit_op.seq,
        "reversed op seq should match edit op"
    );
    assert_eq!(
        results[0].reversed_op_type, "edit_block",
        "reversed_op_type should record the op_type of the original op"
    );
    assert_eq!(
        results[0].new_op_type, "edit_block",
        "new op type should be edit_block"
    );
    assert!(
        !results[0].is_redo,
        "single revert should not be flagged as redo"
    );

    // Block should be back to "original"
    let after_undo = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        after_undo.content,
        Some("original".into()),
        "content should revert to original"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_reverses_multiple_ops_in_correct_order() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit twice
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Get both edit ops
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let edit_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "edit_block").collect();
    assert_eq!(edit_ops.len(), 2, "should have exactly two edit ops");

    let op_refs: Vec<OpRef> = edit_ops
        .iter()
        .map(|o| OpRef {
            device_id: DEV.into(),
            seq: o.seq,
        })
        .collect();

    let results = revert_ops_inner(&pool, DEV, &mat, op_refs).await.unwrap();

    assert_eq!(results.len(), 2, "should have two results");

    // After reverting both edits, block should be back to "v0"
    let after = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        after.content,
        Some("v0".into()),
        "content should revert to original after reversing both edits"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_appends_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create and edit a block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "after".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let ops_before = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let count_before = ops_before.len();
    let edit_op = ops_before
        .iter()
        .find(|o| o.op_type == "edit_block")
        .unwrap();

    // Revert the edit
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: edit_op.seq,
        }],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 1, "should produce one result");

    // Verify the reverse op was appended to the op log
    let ops_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(
        ops_after.len(),
        count_before + 1,
        "revert_ops_inner should append exactly one reverse op to the op log"
    );

    let reverse_op = ops_after.last().unwrap();
    assert_eq!(
        reverse_op.op_type, "edit_block",
        "reverse of edit_block should be edit_block"
    );
    assert_eq!(
        reverse_op.seq, results[0].new_op_ref.seq,
        "appended op seq should match the result's new_op_ref"
    );
}

/// #659 / #851: a batch revert is undo-producing — its reverse op rows must
/// carry `op_log.is_undo = 1` (via `append_local_undo_op_in_tx`) so they are
/// legitimate redo targets and the activity feed / point-in-time restore can
/// distinguish them from ordinary forward edits. Pins the `is_undo` flag on
/// the row `revert_ops_inner` appends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_inner_marks_reverse_op_is_undo() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "after".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let ops_before = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let edit_op = ops_before
        .iter()
        .find(|o| o.op_type == "edit_block")
        .unwrap();

    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: edit_op.seq,
        }],
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 1, "should produce one result");

    let new_ref = &results[0].new_op_ref;

    // The forward edit op must NOT be flagged is_undo; the reverse op MUST be.
    let forward_is_undo: i64 =
        sqlx::query_scalar("SELECT is_undo FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(DEV)
            .bind(edit_op.seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        forward_is_undo, 0,
        "the original forward edit op must not be flagged is_undo"
    );

    let reverse_is_undo: i64 =
        sqlx::query_scalar("SELECT is_undo FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&new_ref.device_id)
            .bind(new_ref.seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        reverse_is_undo, 1,
        "#659: revert_ops_inner's reverse op row must carry is_undo = 1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_rejects_non_reversible_op() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create and soft-delete and purge a block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    purge_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Get the purge op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

    // Try to revert it — should fail
    let result = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: purge_op.seq,
        }],
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NonReversible { .. })),
        "should fail with NonReversible for purge_block, got: {result:?}"
    );
}

// -- restore_page_to_op tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_reverts_ops_after_target() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page with 3 blocks
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "first".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "second".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "third".into(),
        Some(page.id.clone()),
        Some(3),
    )
    .await
    .unwrap();

    // Edit each block
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "first-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Record the seq after b1 edit — this will be our restore target
    let ops_after_b1 = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_op = ops_after_b1
        .iter()
        .rev()
        .find(|o| o.op_type == "edit_block")
        .unwrap();
    let target_seq = target_op.seq;

    edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "second-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, b3.id.clone(), "third-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify all blocks have edited content
    assert_eq!(
        get_block_inner(&pool, b2.id.clone()).await.unwrap().content,
        Some("second-edited".into()),
        "b2 should be edited before restore"
    );
    assert_eq!(
        get_block_inner(&pool, b3.id.clone()).await.unwrap().content,
        Some("third-edited".into()),
        "b3 should be edited before restore"
    );

    // Restore to the point after b1 edit
    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.ops_reverted, 2,
        "should revert exactly 2 ops (b2 and b3 edits)"
    );
    assert_eq!(
        result.non_reversible_skipped, 0,
        "no non-reversible ops to skip"
    );

    // b1 should still be "first-edited" (at or before the target)
    assert_eq!(
        get_block_inner(&pool, b1.id).await.unwrap().content,
        Some("first-edited".into()),
        "b1 should keep its edit (at/before target)"
    );
    // b2 and b3 should be back to original
    assert_eq!(
        get_block_inner(&pool, b2.id).await.unwrap().content,
        Some("second".into()),
        "b2 should revert to original"
    );
    assert_eq!(
        get_block_inner(&pool, b3.id).await.unwrap().content,
        Some("third".into()),
        "b3 should revert to original"
    );
}

/// #1551 (behavior-preservation sanity check): an op already committed before
/// the restore call is included in the revert set.
///
/// NOTE: This test does NOT distinguish the fixed code (membership SELECT
/// inside the IMMEDIATE tx) from the pre-fix code (SELECT on the bare pool).
/// An op committed *before* the call is visible to both reads, so the test
/// passes on either version (verified by mutation: reverting the two SELECTs
/// to `.fetch_all(pool)` still passes). A deterministic regression test for
/// the TOCTOU window would need a concurrent writer racing to commit in the
/// read -> BEGIN IMMEDIATE gap; that gap exists only in the pre-fix code and
/// cannot be hit deterministically in a single process without an injectable
/// seam this code does not expose. This test is therefore kept only to guard
/// the `revert_ops_in_tx` extraction against regressing the
/// already-committed-op case — not as proof the window is closed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_includes_op_present_at_tx_open() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "first".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Target = the point right after b1 was created.
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Commit an edit that lands AFTER the target. It is fully committed to
    // op_log (and the derived projection) before the restore call below, so
    // it is unambiguously present at the moment the restore's IMMEDIATE
    // transaction opens its membership read. The atomic read must see it.
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "first-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    assert_eq!(
        get_block_inner(&pool, b1.id.clone()).await.unwrap().content,
        Some("first-edited".into()),
        "edit must be committed before restore (present at tx-open)"
    );

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.ops_reverted, 1,
        "the edit present at tx-open must be in the revert set (membership read is inside the IMMEDIATE tx)"
    );
    assert_eq!(
        get_block_inner(&pool, b1.id).await.unwrap().content,
        Some("first".into()),
        "b1 must revert to its pre-edit content"
    );
}

/// Verify that ops belonging to a purged block are not discovered by the
/// page-subtree walk used inside `restore_page_to_op_inner` (#2201: the
/// materialized `collect_subtree_ids_unbounded` walk, previously an inline
/// recursive CTE).  The walk reads the `blocks` table; once a block is
/// purged it is no longer in that table, so its ops are never reached and
/// `non_reversible_skipped` stays 0 — the purge's non-reversibility is
/// invisible to the walker, not "skipped" in the sense of encountering and
/// deciding to pass over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_purged_block_ops_not_in_cte_scope() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "keep".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    // Record target
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Create another block, then purge it (non-reversible)
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    purge_block_inner(&pool, DEV, &mat, b2.id).await.unwrap();
    mat.flush_background().await.unwrap();

    // Also edit b1 (this IS reversible)
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "modified".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // b2 was purged — it's no longer in the blocks table, so the recursive
    // CTE cannot discover its ops. Only b1's edit (on a live block) is found.
    assert_eq!(
        result.non_reversible_skipped, 0,
        "purged block ops not discoverable via recursive CTE on blocks table"
    );
    assert_eq!(
        result.ops_reverted, 1,
        "should revert exactly 1 op (edit_block b1)"
    );
    assert_eq!(
        get_block_inner(&pool, b1.id).await.unwrap().content,
        Some("keep".into()),
        "b1 should revert to original"
    );
}

/// #2201: the materialized page-subtree walk must include DELETED
/// descendants. The restore's ops-to-revert scan intentionally does NOT
/// filter `deleted_at IS NULL` (see the NOTE in `restore_page_to_op_inner`):
/// restoring to a point before a delete means un-deleting that block, so
/// the walk must still reach it to sweep its ops. A walk using the
/// `Active` filter (the delete-cascade shape) would silently drop both the
/// child's edit and its delete from the revert set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_sweeps_ops_on_deleted_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Target = the point right after the child was created.
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // AFTER the target: edit the child, then soft-DELETE it. At restore
    // time the child row is tombstoned, so only a deleted-inclusive
    // subtree walk can discover these two ops.
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    delete_block_inner(&pool, DEV, &mat, child.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.ops_reverted, 2,
        "both the edit and the delete on the (now-deleted) child must be \
         swept — the page-subtree walk must include deleted blocks"
    );
    assert_eq!(
        result.non_reversible_skipped, 0,
        "edit_block and delete_block are both reversible"
    );

    let restored = get_block_inner(&pool, child.id).await.unwrap();
    assert!(
        restored.deleted_at.is_none(),
        "child must be un-deleted by the restore (delete op reverted)"
    );
    assert_eq!(
        restored.content,
        Some("original".into()),
        "child content must revert to its pre-target state (edit op reverted)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_global_scope() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page 1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "orig-1".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let page2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page 2".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "orig-2".into(),
        Some(page2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Edit blocks on BOTH pages
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "changed-1".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "changed-2".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Global restore
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, "__all__".into(), DEV.into(), target_seq)
            .await
            .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(result.ops_reverted, 2, "should revert edits on both pages");
    assert_eq!(
        get_block_inner(&pool, b1.id).await.unwrap().content,
        Some("orig-1".into()),
        "b1 should revert"
    );
    assert_eq!(
        get_block_inner(&pool, b2.id).await.unwrap().content,
        Some("orig-2".into()),
        "b2 should revert"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_no_ops_after_target() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();

    assert_eq!(
        result.ops_reverted, 0,
        "no ops after target should mean zero reverts"
    );
    assert_eq!(
        result.non_reversible_skipped, 0,
        "no non-reversible ops to skip"
    );
    assert!(result.results.is_empty(), "results should be empty");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_includes_nested_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create page → parent block → nested child block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent-orig".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child-orig".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    // Record target after initial setup
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Edit both the parent and the nested child
    edit_block_inner(&pool, DEV, &mat, parent.id.clone(), "parent-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify both are edited
    assert_eq!(
        get_block_inner(&pool, parent.id.clone())
            .await
            .unwrap()
            .content,
        Some("parent-edited".into()),
        "parent should be edited before restore"
    );
    assert_eq!(
        get_block_inner(&pool, child.id.clone())
            .await
            .unwrap()
            .content,
        Some("child-edited".into()),
        "child should be edited before restore"
    );

    // Page-scoped restore — must find nested child too
    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.ops_reverted, 2,
        "should revert both parent and nested child edits"
    );
    assert_eq!(
        get_block_inner(&pool, parent.id).await.unwrap().content,
        Some("parent-orig".into()),
        "parent should revert to original"
    );
    assert_eq!(
        get_block_inner(&pool, child.id).await.unwrap().content,
        Some("child-orig".into()),
        "nested child should revert to original (recursive CTE)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_invalid_target_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Use a seq that doesn't exist in the op log
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, page.id.to_string(), DEV.into(), 999_999).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring to a non-existent target_seq should return NotFound, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_verifies_reverse_ops_in_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page with two content blocks
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "alpha".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "beta".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();

    // Record ops count and target after creates
    let ops_before = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops_before.last().unwrap().seq;

    // Edit both blocks (these will be reverted)
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "alpha-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "beta-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let ops_before_restore = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let count_before = ops_before_restore.len();

    // Restore to target — should revert both edits
    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(result.ops_reverted, 2, "should revert exactly 2 edit ops");

    // Fetch all ops after restore — should have 2 new reverse ops appended
    let ops_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(
        ops_after.len(),
        count_before + 2,
        "should have appended exactly 2 reverse ops to the op log"
    );

    // Verify the reverse ops have correct op_type values
    let reverse_ops = &ops_after[count_before..];
    for rev_op in reverse_ops {
        assert_eq!(
            rev_op.op_type, "edit_block",
            "reverse of edit_block should be edit_block, got: {}",
            rev_op.op_type
        );
    }

    // Verify hash chain integrity: each op's parent_seqs references the
    // previous op's hash, and the hash is correctly computed.
    for i in 1..ops_after.len() {
        let prev = &ops_after[i - 1];
        let curr = &ops_after[i];

        // parent_seqs should reference the previous seq
        let parent_seqs_parsed = curr.parsed_parent_seqs().unwrap();
        assert!(
            parent_seqs_parsed.is_some(),
            "non-genesis op (seq {}) must have parent_seqs",
            curr.seq
        );
        let parents = parent_seqs_parsed.unwrap();
        assert_eq!(
            parents.len(),
            1,
            "Phase 1 linear chain — exactly one parent expected"
        );
        assert_eq!(
            parents[0],
            (prev.device_id.clone(), prev.seq),
            "parent_seqs should reference the immediately preceding op"
        );

        // Recompute the hash and verify it matches
        let expected_hash = crate::hash::compute_op_hash(
            &curr.device_id,
            curr.seq,
            curr.parent_seqs.as_deref(),
            &curr.op_type,
            &curr.payload,
        );
        assert_eq!(
            curr.hash, expected_hash,
            "hash for op seq {} should match recomputed value",
            curr.seq
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_skips_delete_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page with a content block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    // Add an attachment BEFORE the target point (so it's part of baseline)
    let att_id = "ATT_RESTORE_001";
    let att_ts = crate::db::now_ms();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(att_id)
    .bind(&child.id)
    .bind("image/png")
    .bind("photo.png")
    .bind(1024_i64)
    .bind("/tmp/photo.png")
    .bind(att_ts)
    .execute(&pool)
    .await
    .unwrap();

    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            block_id: child.id.clone(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
        att_ts,
    )
    .await
    .unwrap();

    // Record target seq AFTER the add_attachment
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Now delete the attachment AFTER the target (non-reversible op)
    let del_ts = crate::db::now_ms();
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            fs_path: "/tmp/photo.png".into(),
        }),
        del_ts,
    )
    .await
    .unwrap();

    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(att_id)
        .execute(&pool)
        .await
        .unwrap();

    // Also edit the child block after target (this IS reversible)
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Restore using global scope (__all__) so the delete_attachment op is
    // discoverable — page-scoped queries filter by payload $.block_id which
    // delete_attachment payloads lack (they use $.attachment_id instead).
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, "__all__".into(), DEV.into(), target_seq)
            .await
            .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.non_reversible_skipped, 1,
        "should count exactly 1 non-reversible op (delete_attachment)"
    );
    assert_eq!(
        result.ops_reverted, 1,
        "should revert exactly 1 reversible op (edit_block)"
    );
    assert_eq!(
        get_block_inner(&pool, child.id).await.unwrap().content,
        Some("child block".into()),
        "child block content should revert to original"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_finds_delete_attachment_in_page_scope() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page with a child block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Add an attachment to the child block BEFORE the target point
    let att_id = "ATT_B59_001";
    let att_ts = crate::db::now_ms();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(att_id)
    .bind(&child.id)
    .bind("image/png")
    .bind("photo.png")
    .bind(1024_i64)
    .bind("/tmp/photo.png")
    .bind(att_ts)
    .execute(&pool)
    .await
    .unwrap();

    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            block_id: child.id.clone(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
        att_ts,
    )
    .await
    .unwrap();

    // Record target seq AFTER the add_attachment
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;

    // Delete the attachment AFTER the target point (soft-delete, keeping the
    // row so the attachments-based EXISTS subquery can still resolve it).
    let del_ts = crate::db::now_ms();
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            fs_path: "/tmp/photo.png".into(),
        }),
        del_ts,
    )
    .await
    .unwrap();

    sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
        .bind(del_ts)
        .bind(att_id)
        .execute(&pool)
        .await
        .unwrap();

    // Also edit the child block after target (reversible)
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // PAGE-SCOPED restore (not __all__) — before B-59 fix, the
    // delete_attachment op was silently missed because it has
    // $.attachment_id instead of $.block_id.
    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.clone().into_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // delete_attachment is in the non_reversible list, so it should be
    // discovered (counted as skipped) rather than silently missed.
    assert_eq!(
        result.non_reversible_skipped, 1,
        "page-scoped restore should find the delete_attachment op (B-59 fix)"
    );
    assert_eq!(
        result.ops_reverted, 1,
        "should revert exactly 1 reversible op (edit_block)"
    );
    assert_eq!(
        get_block_inner(&pool, child.id).await.unwrap().content,
        Some("child block".into()),
        "child block content should revert to original"
    );
}

// -- undo_page_op tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_depth_0_reverses_most_recent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child1
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify block is "edited"
    let before = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        before.content,
        Some("edited".into()),
        "block should be edited before undo"
    );

    // Undo most recent op (depth=0) — the edit
    let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .unwrap();

    assert_eq!(
        result.reversed_op.device_id, DEV,
        "reversed op device_id should match"
    );
    assert_eq!(
        result.new_op_type, "edit_block",
        "undo should produce edit_block op"
    );
    assert!(
        !result.is_redo,
        "undo operation should not be flagged as redo"
    );

    // Block should be back to "child one"
    let after = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        after.content,
        Some("child one".into()),
        "content should revert to original after undo"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_depth_1_reverses_second_most_recent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child1 twice
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edit1".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edit2".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Undo depth=1 — should reverse the first edit (second most recent op)
    let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 1)
        .await
        .unwrap();

    // The second most recent op is "edit1" (edit_block)
    assert_eq!(
        result.new_op_type, "edit_block",
        "depth-1 undo should reverse an edit_block"
    );
    assert!(
        !result.is_redo,
        "depth-1 undo should not be flagged as redo"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_finds_delete_attachment_op() {
    use sqlx::Row;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // 1. Create a page with a child block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Attachment Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // 2. Add an attachment to the child block
    let att_id = "ATT_UNDO_001";
    // Explicit timestamps (instead of consecutive `now_rfc3339()`
    // calls) so the ATT and subsequent DEL op cannot share a millisecond and
    // make the (created_at, seq) ordering test-fragile. Sibling sites in this
    // file already use `append_local_op_at` with explicit strings; this
    // closes the last residual `now_rfc3339()` collision in the file.
    // Use timestamps in the far future so they're strictly after the
    // page/child `create_block` ops (which use real `now_rfc3339()`),
    // ensuring undo's "most recent op" lookup finds the attachment ops.
    let att_ts: i64 = 4_072_161_600_000;
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(att_id)
    .bind(&child.id)
    .bind("image/png")
    .bind("photo.png")
    .bind(1024_i64)
    .bind("/tmp/photo.png")
    .bind(att_ts)
    .execute(&pool)
    .await
    .unwrap();

    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            block_id: child.id.clone(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
        att_ts,
    )
    .await
    .unwrap();

    // 3. Delete the attachment (append delete_attachment op + soft-delete)
    // Explicit timestamp strictly after `att_ts` for deterministic
    // ordering (see comment at the att_ts declaration above).
    let del_ts: i64 = 4_072_161_601_000;
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            fs_path: "/tmp/photo.png".into(),
        }),
        del_ts,
    )
    .await
    .unwrap();

    sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
        .bind(del_ts)
        .bind(att_id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify attachment is soft-deleted
    let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
        .bind(att_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let deleted_at: Option<String> = row.get("deleted_at");
    assert!(
        deleted_at.is_some(),
        "attachment should be soft-deleted before undo"
    );

    // 4. Undo most recent op — should find the delete_attachment op
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .expect("undo should find delete_attachment op on the page");

    assert_eq!(
        result.new_op_type, "add_attachment",
        "reversing delete_attachment should produce add_attachment"
    );
    assert!(
        !result.is_redo,
        "attachment undo should not be flagged as redo"
    );

    // 5. Verify the attachment is restored (deleted_at cleared)
    let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
        .bind(att_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let deleted_at: Option<String> = row.get("deleted_at");
    assert!(
        deleted_at.is_none(),
        "attachment should be restored after undo (deleted_at should be NULL)"
    );
}

// Regression for the #571 review fix: undo of a rename must restore the
// ORIGINAL filename. `reverse_rename_attachment` swaps old/new, so the
// reverse-apply path must read `new_filename` (the restore target); reading
// `old_filename` made undo a silent no-op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_restores_renamed_attachment_filename() {
    use sqlx::Row;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Seed an attachment row, then append its add op (far-future ts so the
    // rename op below is the most-recent op on the page for undo's lookup).
    let att_id = "ATT_RENAME_UNDO_1";
    let add_ts: i64 = 4_072_161_600_000;
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(att_id)
    .bind(&child.id)
    .bind("image/png")
    .bind("original.png")
    .bind(8_i64)
    .bind("attachments/original")
    .bind(add_ts)
    .execute(&pool)
    .await
    .unwrap();
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            block_id: child.id.clone(),
            mime_type: "image/png".into(),
            filename: "original.png".into(),
            size_bytes: 8,
            fs_path: "attachments/original".into(),
        }),
        add_ts,
    )
    .await
    .unwrap();

    // Forward rename → "renamed.png" (op + row update mirror the command path).
    let rename_ts: i64 = 4_072_161_601_000;
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::RenameAttachment(crate::op::RenameAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            old_filename: "original.png".into(),
            new_filename: "renamed.png".into(),
        }),
        rename_ts,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE attachments SET filename = ? WHERE id = ?")
        .bind("renamed.png")
        .bind(att_id)
        .execute(&pool)
        .await
        .unwrap();

    // Undo the most-recent op (the rename).
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .expect("undo should find the rename_attachment op");
    assert_eq!(result.new_op_type, "rename_attachment");

    let row = sqlx::query("SELECT filename FROM attachments WHERE id = ?")
        .bind(att_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let filename: String = row.get("filename");
    assert_eq!(
        filename, "original.png",
        "undo of rename must restore the original filename, not no-op"
    );
}

// -- redo_page_op tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redo_page_op_reverses_undo_restoring_state() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // Edit child1
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Undo the edit
    let undo_result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .unwrap();

    // Verify it's undone
    let after_undo = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        after_undo.content,
        Some("child one".into()),
        "content should revert after undo"
    );

    // Redo it
    let redo_result = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo_result.new_op_ref.device_id.clone(),
        undo_result.new_op_ref.seq,
    )
    .await
    .unwrap();

    assert!(redo_result.is_redo, "should be flagged as redo");
    assert_eq!(
        redo_result.new_op_type, "edit_block",
        "redo should produce edit_block op"
    );

    // Block should be back to "edited"
    let after_redo = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        after_redo.content,
        Some("edited".into()),
        "content should be restored after redo"
    );
}

// -- Full cycle test --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_cycle_create_edit_undo_redo() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create page + child
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let after_edit = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after_edit.content,
        Some("modified".into()),
        "content should be modified after edit"
    );

    // Undo the edit (depth=0 = most recent)
    let undo = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    assert!(!undo.is_redo, "undo should not be flagged as redo");

    let after_undo = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after_undo.content,
        Some("original".into()),
        "undo should restore original content"
    );

    // Redo the undo
    let redo = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo.new_op_ref.device_id.clone(),
        undo.new_op_ref.seq,
    )
    .await
    .unwrap();
    assert!(redo.is_redo, "redo should be flagged as redo");

    let after_redo = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after_redo.content,
        Some("modified".into()),
        "redo should produce original edit result"
    );
}

// ======================================================================
// Extended Undo/Redo integration tests — Groups 1-4 (19 tests)
// ======================================================================

// -- Group 1: apply_reverse_in_tx — all variants (9 tests) --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_create_block_soft_deletes() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ephemeral".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Get the create_block op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let create_op = ops.iter().find(|o| o.op_type == "create_block").unwrap();

    // Revert the create (reverse = DeleteBlock → soft-deletes the block)
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: create_op.seq,
        }],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 1, "should return one revert result");
    assert_eq!(
        results[0].new_op_type, "delete_block",
        "reverting create should produce delete_block"
    );
    assert_eq!(
        results[0].reversed_op_type, "create_block",
        "reversed_op_type must echo the create_block op_type being reverted"
    );

    // Verify the block is now soft-deleted
    let block = get_block_inner(&pool, created.id).await.unwrap();
    assert!(
        block.deleted_at.is_some(),
        "block should be soft-deleted after reverting create"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_delete_block_restores_with_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create parent + child
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify both are deleted
    let p_row = get_block_inner(&pool, parent.id.clone()).await.unwrap();
    assert!(p_row.deleted_at.is_some(), "parent should be deleted");

    // Get the delete_block op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let delete_op = ops.iter().find(|o| o.op_type == "delete_block").unwrap();

    // Revert the delete (reverse = RestoreBlock)
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: delete_op.seq,
        }],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 1, "should return one revert result");
    assert_eq!(
        results[0].new_op_type, "restore_block",
        "reverting delete should produce restore_block"
    );

    // Verify both are restored
    let p_after = get_block_inner(&pool, parent.id.clone()).await.unwrap();
    assert!(
        p_after.deleted_at.is_none(),
        "parent should be restored after revert"
    );

    let c_after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert!(
        c_after.deleted_at.is_none(),
        "child should be restored after revert"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_move_block_restores_original_position() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create two parent pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page One".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create child under P1 at index 3 (0-based slot ⇒ provisional rank 4).
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "movable".into(),
        Some(p1.id.clone()),
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Move child to P2 at index 7 (0-based slot ⇒ provisional rank 8).
    move_block_inner(&pool, DEV, &mat, child.id.clone(), Some(p2.id.clone()), 7)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify it's at P2, provisional rank 8 (new_index 7 + 1).
    let before = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        before.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(p2.id.as_str()),
        "block should be under P2 after move"
    );
    assert_eq!(
        before.position,
        Some(8),
        "new_index 7 ⇒ provisional dense rank 8 after move"
    );

    // Get the move_block op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let move_op = ops.iter().find(|o| o.op_type == "move_block").unwrap();

    // Revert the move
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: move_op.seq,
        }],
    )
    .await
    .unwrap();

    // Verify it's back at P1. The reverse move reads the original create
    // op (index 3) and restores that parent. #928: `apply_reverse_in_tx` now
    // reprojects the restored sibling group to dense 1-based positions (the
    // same densification the forward engine move runs), so the child — the SOLE
    // live block under P1 — converges to dense rank 1, NOT the gapped
    // provisional rank 4 the raw reverse UPDATE used to leave behind.
    let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(p1.id.as_str()),
        "parent should be restored to P1"
    );
    assert_eq!(
        after.position,
        Some(1),
        "#928: sole restored child re-densifies to dense rank 1 after revert"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_add_tag_removes_association() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a tag block and a content block
    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "my-tag".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let content = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "some text".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Add the tag
    add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify the tag is applied
    let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&content.id)
        .bind(&tag.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(before.is_some(), "tag should be applied");

    // Get the add_tag op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let add_tag_op = ops.iter().find(|o| o.op_type == "add_tag").unwrap();

    // Revert the add_tag (reverse = RemoveTag)
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: add_tag_op.seq,
        }],
    )
    .await
    .unwrap();

    // Verify the tag is removed
    let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&content.id)
        .bind(&tag.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(after.is_none(), "tag should be removed after revert");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_remove_tag_restores_association() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create tag + content
    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "my-tag".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let content = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "some text".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Add tag, then remove tag
    add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    remove_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify tag is removed
    let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&content.id)
        .bind(&tag.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(before.is_none(), "tag should be removed");

    // Get the remove_tag op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let remove_tag_op = ops.iter().find(|o| o.op_type == "remove_tag").unwrap();

    // Revert the remove_tag (reverse = AddTag)
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: remove_tag_op.seq,
        }],
    )
    .await
    .unwrap();

    // Verify the tag is restored
    let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&content.id)
        .bind(&tag.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(after.is_some(), "tag should be restored after revert");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_set_property_restores_prior_value() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set property to "high"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set property to "low"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "importance".into(),
        Some("low".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify it's "low"
    let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let p_before = props_before.iter().find(|p| p.key == "importance").unwrap();
    assert_eq!(
        p_before.value_text.as_deref(),
        Some("low"),
        "property value should be low before revert"
    );

    // Get the second set_property op (the one that set "low")
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    let second_set = set_ops.last().unwrap();

    // Revert the second set (should restore "high")
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: second_set.seq,
        }],
    )
    .await
    .unwrap();

    // Verify it's back to "high"
    let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let p_after = props_after.iter().find(|p| p.key == "importance").unwrap();
    assert_eq!(
        p_after.value_text.as_deref(),
        Some("high"),
        "value should be restored to 'high' after reverting second set"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_set_property_first_produces_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set property "color" = "red" (first set, no prior)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "color".into(),
        Some("red".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Get the set_property op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_op = ops.iter().find(|o| o.op_type == "set_property").unwrap();

    // Revert the first set (no prior → reverse = DeleteProperty)
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: set_op.seq,
        }],
    )
    .await
    .unwrap();

    // Verify the property row no longer exists
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        props.iter().all(|p| p.key != "color"),
        "property 'color' should be deleted after reverting first set"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_delete_property_restores_value() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set property "due" with value_date
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "due".into(),
        None,
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Delete the property
    delete_property_inner(&pool, DEV, &mat, block.id.as_str().into(), "due".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify property is gone
    let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        props_before.iter().all(|p| p.key != "due"),
        "property 'due' should be deleted"
    );

    // Get the delete_property op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let del_op = ops.iter().find(|o| o.op_type == "delete_property").unwrap();

    // Revert the delete (reverse = SetProperty with prior value)
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: del_op.seq,
        }],
    )
    .await
    .unwrap();

    // Verify the property is restored with value_date="2025-06-15"
    let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let due = props_after
        .iter()
        .find(|p| p.key == "due")
        .expect("property 'due' should be restored after reverting delete");
    assert_eq!(
        due.value_date.as_deref(),
        Some("2025-06-15"),
        "value_date should be restored to '2025-06-15'"
    );
}

/// C7 (#345): reverting an `add_attachment` must HARD-delete the row,
/// matching the runtime / materializer model
/// (`materializer::handlers::apply_delete_attachment_tx` runs
/// `DELETE FROM attachments`). Undo was previously the only producer of
/// soft-deleted attachment rows, and because `list_attachments_*` has no
/// `deleted_at` filter, a soft-delete left a tombstone visible in
/// listings that was never GC'd. After undo the row must be GONE, not
/// merely stamped with `deleted_at`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_add_attachment_hard_deletes_row_c7() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block (needed for FK)
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Manually insert an attachment row
    let att_id = "ATT_TEST_001";
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(att_id)
    .bind(&block.id)
    .bind("image/png")
    .bind("photo.png")
    .bind(1024_i64)
    .bind("/tmp/photo.png")
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();

    // Append add_attachment op via op_log
    op_log::append_local_op_at(
        &pool,
        DEV,
        OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: BlockId::from_trusted(att_id),
            block_id: block.id.clone(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Get the add_attachment op
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let add_att_op = ops.iter().find(|o| o.op_type == "add_attachment").unwrap();

    // Revert the add_attachment (reverse = DeleteAttachment → hard-delete)
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: add_att_op.seq,
        }],
    )
    .await
    .unwrap();

    // C7: the row must be HARD-deleted — gone, not soft-deleted. A
    // lingering (`deleted_at IS NOT NULL`) tombstone would leak into
    // unfiltered `list_attachments_*` listings and never be GC'd.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = ?")
        .bind(att_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "C7: reverting add_attachment must hard-DELETE the row, not soft-delete it"
    );
}

// -- Group 2: Error paths (5 tests) --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_nonexistent_page_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = undo_page_op_inner(&pool, DEV, &mat, "NONEXISTENT_PAGE".into(), 0).await;

    assert!(result.is_err(), "undo on nonexistent page should fail");
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_depth_exceeds_ops_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _child_ids) = create_page_with_children(&pool, &mat).await;

    // Page has 3 ops: create page, create child1, create child2.
    // Undo with depth=10 should exceed available ops.
    let result = undo_page_op_inner(&pool, DEV, &mat, page_id, 10).await;

    assert!(result.is_err(), "undo with depth exceeding ops should fail");
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redo_nonexistent_undo_op_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = redo_page_op_inner(&pool, DEV, &mat, "FAKE".into(), 9999).await;

    assert!(result.is_err(), "redo with nonexistent op should fail");
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_empty_list_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let results = revert_ops_inner(&pool, DEV, &mat, vec![]).await.unwrap();

    assert!(
        results.is_empty(),
        "reverting empty list should return empty vec"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_mixed_reversible_non_reversible_rejects_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block and edit it (reversible op)
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "start".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Create another block, delete it, purge it (non-reversible)
    let doomed = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, doomed.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    purge_block_inner(&pool, DEV, &mat, doomed.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Gather op refs
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();
    let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

    // Record op_log count before attempt
    let count_before = ops.len();

    // Try to revert both — should fail because purge is non-reversible
    let result = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![
            OpRef {
                device_id: DEV.into(),
                seq: edit_op.seq,
            },
            OpRef {
                device_id: DEV.into(),
                seq: purge_op.seq,
            },
        ],
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NonReversible { .. })),
        "should fail with NonReversible, got: {result:?}"
    );

    // Verify the edit was NOT reversed (block content unchanged)
    let after = get_block_inner(&pool, block.id).await.unwrap();
    assert_eq!(
        after.content,
        Some("edited".into()),
        "edit should NOT be reversed when batch is rejected"
    );

    // Verify op_log count unchanged
    let ops_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(
        count_before,
        ops_after.len(),
        "no new ops should be appended when batch is rejected"
    );
}

// -- Group 3: list_page_history edge cases (3 tests) --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_deep_nesting_includes_grandchildren() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create: page → child → grandchild → great-grandchild
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Root".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(child.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let great_grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "great-grandchild".into(),
        Some(grandchild.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit each to add more ops
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child-edited".into())
        .await
        .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        grandchild.id.clone(),
        "grandchild-edited".into(),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        great_grandchild.id.clone(),
        "gg-edited".into(),
    )
    .await
    .unwrap();

    let result = list_page_history_inner(
        &pool,
        page.id.clone().into_string(),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    // 4 creates + 3 edits = 7 ops
    assert_eq!(
        result.items.len(),
        7,
        "should include ops for all 4 levels of nesting"
    );

    // Verify all block IDs are from the page tree
    let valid_ids = [
        page.id.clone(),
        child.id.clone(),
        grandchild.id.clone(),
        great_grandchild.id.clone(),
    ];
    for entry in &result.items {
        let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
        let block_id = payload["block_id"].as_str().unwrap();
        assert!(
            valid_ids.iter().any(|id| id == block_id),
            "op should be for a block in the page tree, got: {block_id}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_includes_ops_for_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create page + child
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit child
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited-child".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Delete child
    delete_block_inner(&pool, DEV, &mat, child.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let result = list_page_history_inner(
        &pool,
        page.id.clone().into_string(),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    // Ops: create page + create child + edit child + delete child = 4
    assert_eq!(
        result.items.len(),
        4,
        "should include ops for deleted blocks too"
    );

    let op_types: Vec<&str> = result.items.iter().map(|e| e.op_type.as_str()).collect();
    assert!(
        op_types.contains(&"create_block"),
        "should include create_block ops"
    );
    assert!(
        op_types.contains(&"edit_block"),
        "should include edit_block ops"
    );
    assert!(
        op_types.contains(&"delete_block"),
        "should include delete_block ops"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_empty_page_returns_only_create() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Empty Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = list_page_history_inner(
        &pool,
        page.id.clone().into_string(),
        None,
        &SpaceScope::Global,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.items.len(),
        1,
        "empty page should have exactly 1 op (the create_block)"
    );
    assert_eq!(
        result.items[0].op_type, "create_block",
        "most recent op should be create_block"
    );
}

// -- Group 4: Multi-step cycles (2 tests) --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_redo_undo_redo_full_cycle_multiple_edits() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create page + child
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit to "v1", then "v2"
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v1".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v2".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // 1) undo(depth=0) → reverses edit "v2" → content="v1"
    let undo1 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v1".into()),
        "after first undo, content should be v1"
    );

    // 2) undo(depth=1) → reverses edit "v1"
    //    #2018: `undo_page_op_inner`'s target SELECT now filters `is_undo = 0`,
    //    so the reverse op appended by step 1's undo (a plain `edit_block` with
    //    `is_undo = 1`) is NOT counted by the depth OFFSET — matching the op
    //    set `find_undo_group_inner` walks. The undoable ops newest-first are:
    //      depth=0: edit_v2, depth=1: edit_v1, depth=2: create_child.
    //    So edit "v1" (prior text "original") is now at depth=1, not depth=2.
    let undo2 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 1)
        .await
        .unwrap();
    let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("original".into()),
        "after second undo, content should be original"
    );

    // 3) redo the second undo → reverses the undo2 op → content="v1"
    let _redo1 = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo2.new_op_ref.device_id.clone(),
        undo2.new_op_ref.seq,
    )
    .await
    .unwrap();
    let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v1".into()),
        "after first redo, content should be v1"
    );

    // 4) redo the first undo → reverses the undo1 op → content="v2"
    let _redo2 = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo1.new_op_ref.device_id.clone(),
        undo1.new_op_ref.seq,
    )
    .await
    .unwrap();
    let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v2".into()),
        "after second redo, content should be v2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_ops_from_different_devices() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with DEV
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Manually append an edit_block op from "device-B".
    // Use a far-future timestamp so it sorts AFTER the create_block op
    // from DEV (whose created_at is now_rfc3339()). The reverse lookup
    // needs to find the create op *before* this edit in temporal order.
    let edit_payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block.id.clone(),
        to_text: "from-device-B".into(),
        prev_edit: None,
    });
    let device_b_op =
        op_log::append_local_op_at(&pool, "device-B", edit_payload, 4_070_908_800_000)
            .await
            .unwrap();

    // Manually apply the edit to the blocks table (op_log doesn't do this)
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
        .bind("from-device-B")
        .bind(&block.id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify content is "from-device-B"
    let before = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(
        before.content,
        Some("from-device-B".into()),
        "content should reflect device-B edit"
    );

    // Get the create_block op from DEV
    let dev_ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let create_op = dev_ops
        .iter()
        .find(|o| o.op_type == "create_block")
        .unwrap();

    // Revert both ops: edit from device-B and create from DEV
    // revert_ops_inner sorts newest-first: device-B edit (newer) then DEV create
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![
            OpRef {
                device_id: "device-B".into(),
                seq: device_b_op.seq,
            },
            OpRef {
                device_id: DEV.into(),
                seq: create_op.seq,
            },
        ],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 2, "should have two results");

    // After reverting device-B's edit: content should be "original"
    // After reverting DEV's create: block should be soft-deleted
    let after = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        after.deleted_at.is_some(),
        "block should be soft-deleted after reverting create"
    );
}

// -- Group 5: Additional integration tests (5 tests) --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_history_includes_ops_after_block_moved_to_different_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create page A
    let page_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create page B
    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create child under page A
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child text".into(),
        Some(page_a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit child while under page A
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited child".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Move child to page B
    move_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Query page A history — child is no longer under A
    let history_a = list_page_history_inner(
        &pool,
        page_a.id.clone().into_string(),
        None,
        &SpaceScope::Global,
        None,
        Some(50),
    )
    .await
    .unwrap();

    // Query page B history — child is now under B
    let history_b = list_page_history_inner(
        &pool,
        page_b.id.clone().into_string(),
        None,
        &SpaceScope::Global,
        None,
        Some(50),
    )
    .await
    .unwrap();

    // Verify page B contains the child's ops (create, edit, move)
    let child_ops_in_b: Vec<_> = history_b
        .items
        .iter()
        .filter(|e| {
            let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap_or_default();
            payload.get("block_id").and_then(|v| v.as_str()) == Some(child.id.as_str())
        })
        .collect();

    // The child is now under B, so all ops for child should appear in B's history.
    assert_eq!(
        child_ops_in_b.len(),
        3,
        "page B history should include all 3 ops for the moved child (create, edit, move)"
    );

    // Page A should NOT include the child's ops anymore (child is no longer a descendant)
    let child_ops_in_a: Vec<_> = history_a
        .items
        .iter()
        .filter(|e| {
            let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap_or_default();
            payload.get("block_id").and_then(|v| v.as_str()) == Some(child.id.as_str())
        })
        .collect();
    assert!(
        child_ops_in_a.is_empty(),
        "page A history should NOT include ops for child that moved away"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_delete_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child content".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Delete the child
    delete_block_inner(&pool, DEV, &mat, child.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify deleted
    let deleted = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert!(deleted.deleted_at.is_some(), "child should be deleted");

    // Undo the delete (depth=0)
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.new_op_type, "restore_block",
        "undo of delete should produce restore"
    );

    // Verify restored
    let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert!(
        restored.deleted_at.is_none(),
        "child should be restored after undo"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_move_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let parent_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Parent A".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let parent_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Parent B".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "moveable".into(),
        Some(parent_a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Move child from parent_a to parent_b
    move_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        Some(parent_b.id.clone()),
        5,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify moved
    let moved = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        moved.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(parent_b.id.as_str()),
        "block should be under parent_b after move"
    );

    // Undo the move (depth=0)
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.new_op_type, "move_block",
        "undo of move should produce move"
    );

    // Verify moved back
    let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        restored
            .parent_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(parent_a.id.as_str()),
        "child should be back under parent A"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "important".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Add tag to child
    add_tag_inner(&pool, DEV, &mat, child.id.clone(), tag.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify tag exists
    let count_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&child.id)
            .bind(&tag.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count_before, 1, "tag should be applied before undo");

    // Undo the add_tag (depth=0)
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.new_op_type, "remove_tag",
        "undoing add_tag should produce remove_tag"
    );

    // Verify tag removed
    let count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&child.id)
            .bind(&tag.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count_after, 0, "tag should be removed after undo");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_set_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        child.id.as_str().into(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify property exists
    let props = get_properties_inner(&pool, child.id.clone()).await.unwrap();
    assert!(
        props
            .iter()
            .any(|p| p.key == "importance" && p.value_text.as_deref() == Some("high")),
        "importance property should be set to high"
    );

    // Undo the set_property (depth=0) — should produce delete_property since it was the first set
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.new_op_type, "delete_property",
        "undoing first set_property should produce delete_property"
    );

    // Verify property removed
    let props_after = get_properties_inner(&pool, child.id.clone()).await.unwrap();
    assert!(
        !props_after.iter().any(|p| p.key == "importance"),
        "property should be removed after undo"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sequential_undo_from_multiple_devices() {
    // Previously concurrent via tokio::spawn + join! (flaky ~0.03% due to
    // SQLite BEGIN IMMEDIATE scheduling). Made deterministic: sequential
    // undo from two devices proves multi-device undo safety without races.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page and two child blocks
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Multi-device Undo Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child_a = create_block_inner(
        &pool,
        "device-A",
        &mat,
        "content".into(),
        "Block from device-A".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child_b = create_block_inner(
        &pool,
        "device-B",
        &mat,
        "content".into(),
        "Block from device-B".into(),
        Some(page.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Edit both blocks from their respective devices
    edit_block_inner(
        &pool,
        "device-A",
        &mat,
        child_a.id.clone(),
        "A-edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(
        &pool,
        "device-B",
        &mat,
        child_b.id.clone(),
        "B-edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify pre-undo state
    let a_before = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
    let b_before = get_block_inner(&pool, child_b.id.clone()).await.unwrap();
    assert_eq!(
        a_before.content,
        Some("A-edited".into()),
        "child A should have edited content"
    );
    assert_eq!(
        b_before.content,
        Some("B-edited".into()),
        "child B should have edited content"
    );

    // Sequential undo from two devices.
    // Page op history (newest first): edit_b(0), edit_a(1), create_b(2), create_a(3)
    //
    // First undo at depth=0 reverses edit_b.
    let result_b = undo_page_op_inner(&pool, "device-B", &mat, page.id.clone().into_string(), 0)
        .await
        .expect("undo edit_b should succeed");
    assert!(
        !result_b.is_redo,
        "first undo should not be flagged as redo"
    );

    // After first undo, the op_log contains reverse_edit_b (a plain
    // `edit_block` with `is_undo = 1`) as the newest row, but #2018's fix
    // makes `undo_page_op_inner` filter `is_undo = 0` for its depth OFFSET
    // (matching `find_undo_group_inner`). The UNDOABLE ops newest-first are:
    //   depth=0: edit_b, depth=1: edit_a, depth=2: create_b, depth=3: create_a.
    // Second undo at depth=1 targets edit_a (the reverse op is skipped).
    let result_a = undo_page_op_inner(&pool, "device-A", &mat, page.id.clone().into_string(), 1)
        .await
        .expect("undo edit_a should succeed");
    assert!(
        !result_a.is_redo,
        "second undo should not be flagged as redo"
    );

    // They should have different op refs (no duplicate ops)
    assert_ne!(
        result_a.new_op_ref, result_b.new_op_ref,
        "sequential undos from different devices should produce distinct ops"
    );

    // Verify both blocks reverted to pre-edit state
    let a_after = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
    let b_after = get_block_inner(&pool, child_b.id.clone()).await.unwrap();
    assert_eq!(
        a_after.content,
        Some("Block from device-A".into()),
        "child A should be reverted"
    );
    assert_eq!(
        b_after.content,
        Some("Block from device-B".into()),
        "child B should be reverted"
    );

    // Verify op_log integrity: 2 create + 2 edit + 2 undo = 6 ops
    let total_ops: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE json_extract(payload, '$.block_id') IN \
         (SELECT id FROM blocks WHERE parent_id = ?)",
        page.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        total_ops, 6,
        "expected exactly 6 ops (2 creates + 2 edits + 2 undos), got {total_ops}"
    );
}

// ======================================================================
// undo_page_op_inner – input validation
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_rejects_negative_depth() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = undo_page_op_inner(&pool, DEV, &mat, "nonexistent-page".into(), -1).await;

    assert!(result.is_err(), "negative undo_depth should be rejected");
    let err = result.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("undo_depth must be non-negative"),
        "error should mention undo_depth validation, got: {msg}"
    );
    assert!(
        matches!(err, AppError::Validation { .. }),
        "error should be Validation variant, got: {err:?}"
    );
}

// ── #129: rows_affected checks in apply_reverse_in_tx ────────────

#[tokio::test]
async fn apply_reverse_remove_tag_on_nonexistent_is_idempotent() {
    let (pool, _dir) = test_pool().await;
    let mut tx = pool.begin().await.unwrap();

    let payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: BlockId::test_id("GHOST_BLK"),
        tag_id: BlockId::test_id("GHOST_TAG"),
    });
    let result = apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &payload,
        crate::db::now_ms(),
    )
    .await;

    // RemoveTag is intentionally idempotent (B-64): deleting a nonexistent
    // association is a harmless no-op, symmetric with AddTag's INSERT OR IGNORE.
    assert!(
        result.is_ok(),
        "removing a nonexistent tag association should succeed (idempotent), got: {result:?}"
    );
}

#[tokio::test]
async fn apply_reverse_delete_property_on_nonexistent_is_idempotent() {
    let (pool, _dir) = test_pool().await;
    let mut tx = pool.begin().await.unwrap();

    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::test_id("GHOST_BLK"),
        key: "priority".into(),
    });
    let result = apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &payload,
        crate::db::now_ms(),
    )
    .await;

    // I-CommandsCRUD-10: DeleteProperty's reverse is intentionally idempotent —
    // its forward counterpart (SetProperty) is already idempotent (INSERT OR
    // REPLACE), and a strict NotFound here would abort `revert_ops_inner`
    // batches when a property had been manually cleared between the original
    // op and the undo.
    assert!(
        result.is_ok(),
        "deleting a nonexistent property should succeed (idempotent), got: {result:?}"
    );
}

#[tokio::test]
async fn apply_reverse_delete_attachment_on_nonexistent_is_idempotent() {
    let (pool, _dir) = test_pool().await;
    let mut tx = pool.begin().await.unwrap();

    let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
        attachment_id: BlockId::test_id("ATT_GHOST"),
        fs_path: "/tmp/ghost.bin".into(),
    });
    let result = apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &payload,
        crate::db::now_ms(),
    )
    .await;

    // I-CommandsCRUD-10: DeleteAttachment's reverse is intentionally idempotent —
    // its forward counterpart (AddAttachment) is already idempotent (INSERT OR
    // REPLACE), and a strict NotFound here would abort `revert_ops_inner`
    // batches when an attachment had been manually purged between the
    // original op and the undo. C7 (#345): the reverse now hard-DELETEs;
    // `DELETE ... WHERE id = ?` on a missing row is a 0-row no-op, so it
    // stays idempotent.
    assert!(
        result.is_ok(),
        "hard-deleting a nonexistent attachment should succeed (idempotent), got: {result:?}"
    );
}

// ======================================================================
// #604 — apply_reverse_in_tx must route column-backed property keys to
// their `blocks` columns, never into `block_properties` (which would be
// aborted by the migration-0088 `key_not_reserved` CHECK for reserved
// keys, or silently desync `blocks.space_id` for `space`).
// ======================================================================

/// #604 (direct, materializer-free): drive `apply_reverse_in_tx` inside a
/// bare transaction so the assertions pin the IN-TX routing itself — a
/// post-commit materializer dispatch cannot mask a wrong write here.
///
/// Covers all three routing shapes:
/// 1. reverse `SetProperty` of a reserved key → UPDATE the same-named
///    `blocks` column (pre-fix: INSERT into block_properties → CHECK abort);
/// 2. reverse `DeleteProperty` of a reserved key → NULL the column
///    (pre-fix: 0-row DELETE no-op left the column stale);
/// 3. reverse `SetProperty`/`DeleteProperty` of `space` → stamp/clear
///    `blocks.space_id` for the whole owning-page group.
#[tokio::test]
async fn apply_reverse_routes_column_backed_keys_to_blocks_columns_604() {
    let (pool, _dir) = test_pool().await;

    let block_id = BlockId::test_id("B604BLK");
    insert_block(&pool, block_id.as_str(), "content", "task", None, Some(1)).await;
    sqlx::query(
        "UPDATE blocks SET todo_state = 'DONE', scheduled_date = '2025-05-05' WHERE id = ?",
    )
    .bind(block_id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    // Owning-page group for the `space` fan-out checks.
    ensure_test_space(&pool).await;
    let page_id = BlockId::test_id("B604PAGE");
    let child_id = BlockId::test_id("B604CHLD");
    insert_block(&pool, page_id.as_str(), "page", "P", None, Some(1)).await;
    insert_block(
        &pool,
        child_id.as_str(),
        "content",
        "c",
        Some(page_id.as_str()),
        Some(1),
    )
    .await;

    let mut tx = pool.begin().await.unwrap();

    // 1. Reverse SetProperty(todo_state="TODO") — e.g. undo of a later
    //    set_todo_state with this prior value.
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &OpPayload::SetProperty(SetPropertyPayload {
            block_id: block_id.clone(),
            key: "todo_state".into(),
            value_text: Some("TODO".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        crate::db::now_ms(),
    )
    .await
    .expect("reverse SetProperty(todo_state) must not hit the 0088 CHECK");

    // 2. Reverse SetProperty(due_date) — date keys carry value_date.
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &OpPayload::SetProperty(SetPropertyPayload {
            block_id: block_id.clone(),
            key: "due_date".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-03-04".into()),
            value_ref: None,
            value_bool: None,
        }),
        crate::db::now_ms(),
    )
    .await
    .expect("reverse SetProperty(due_date) must not hit the 0088 CHECK");

    // 3. Reverse DeleteProperty(scheduled_date) — undo of a first-set must
    //    NULL the column (the pre-fix DELETE on block_properties was a
    //    silent no-op that left the column populated).
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: block_id.clone(),
            key: "scheduled_date".into(),
        }),
        crate::db::now_ms(),
    )
    .await
    .unwrap();

    // 4. Reverse SetProperty(space) — stamps space_id for the page group.
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &OpPayload::SetProperty(SetPropertyPayload {
            block_id: page_id.clone(),
            key: "space".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from_trusted(TEST_SPACE_ID)),
            value_bool: None,
        }),
        crate::db::now_ms(),
    )
    .await
    .expect("reverse SetProperty(space) must not hit the 0088 CHECK");

    tx.commit().await.unwrap();

    let row: (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("SELECT todo_state, due_date, scheduled_date FROM blocks WHERE id = ?")
            .bind(block_id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row.0.as_deref(),
        Some("TODO"),
        "reverse SetProperty(todo_state) must restore blocks.todo_state"
    );
    assert_eq!(
        row.1.as_deref(),
        Some("2025-03-04"),
        "reverse SetProperty(due_date) must restore blocks.due_date"
    );
    assert_eq!(
        row.2, None,
        "reverse DeleteProperty(scheduled_date) must NULL blocks.scheduled_date"
    );

    for id in [page_id.as_str(), child_id.as_str()] {
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            space.as_deref(),
            Some(TEST_SPACE_ID),
            "reverse SetProperty(space) must stamp space_id for the whole page group ({id})"
        );
    }

    // 5. Reverse DeleteProperty(space) — undo of a first space assignment
    //    clears space_id for the whole page group.
    let mut tx = pool.begin().await.unwrap();
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: page_id.clone(),
            key: "space".into(),
        }),
        crate::db::now_ms(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    for id in [page_id.as_str(), child_id.as_str()] {
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            space, None,
            "reverse DeleteProperty(space) must clear space_id for the whole page group ({id})"
        );
    }

    // No column-backed key may have leaked into block_properties.
    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties \
         WHERE key IN ('todo_state', 'priority', 'due_date', 'scheduled_date', 'space')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "no column-backed key may be written to block_properties by undo"
    );
}

/// #604 (end-to-end): undoing a `set_property(todo_state)` that had a
/// prior value must restore `blocks.todo_state` to that prior value via
/// `revert_ops_inner`. Pre-fix this errored mid-undo: the reverse
/// SetProperty tried to INSERT `todo_state` into `block_properties` and
/// was aborted by the migration-0088 CHECK.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_set_todo_state_restores_blocks_column_604() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    for state in ["TODO", "DONE"] {
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.as_str().into(),
            "todo_state".into(),
            Some(state.into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
    }

    // Revert the second set (the one that set "DONE").
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    let second_set = set_ops.last().unwrap();
    let undo_results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: second_set.seq,
        }],
    )
    .await
    .expect("undo of set_property(todo_state) must not hit the 0088 CHECK");
    mat.flush_background().await.unwrap();

    let todo_state: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(block.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        todo_state.as_deref(),
        Some("TODO"),
        "undo must restore blocks.todo_state to the prior value"
    );

    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "undo must not create a block_properties row for todo_state"
    );

    // #604 (other direction): redo of the undo flows through the same
    // compute_reverse → apply_reverse_in_tx → projection path and must
    // restore blocks.todo_state to "DONE" — again without leaking a
    // block_properties row.
    let redo = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo_results[0].new_op_ref.device_id.clone(),
        undo_results[0].new_op_ref.seq,
    )
    .await
    .expect("redo of undo(set_property(todo_state)) must not hit the 0088 CHECK");
    assert!(redo.is_redo, "should be flagged as redo");
    mat.flush_background().await.unwrap();

    let todo_state: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(block.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        todo_state.as_deref(),
        Some("DONE"),
        "redo must restore blocks.todo_state to the undone value"
    );
    let leaked_after_redo: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked_after_redo, 0,
        "redo must not create a block_properties row for todo_state"
    );
}

/// #604 (end-to-end): undoing the FIRST `set_property(due_date)` (no prior
/// value → reverse = `delete_property`) must NULL `blocks.due_date`.
/// Pre-fix the reverse ran a 0-row DELETE against `block_properties` and
/// left the column populated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_first_set_due_date_clears_blocks_column_604() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "due_date".into(),
        None,
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_op = ops.iter().find(|o| o.op_type == "set_property").unwrap();
    let results = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: set_op.seq,
        }],
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    assert_eq!(
        results[0].new_op_type, "delete_property",
        "undoing a first set_property must produce delete_property"
    );

    let due_date: Option<String> = sqlx::query_scalar("SELECT due_date FROM blocks WHERE id = ?")
        .bind(block.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        due_date, None,
        "undo of the first set must NULL blocks.due_date"
    );

    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'due_date'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "undo must not create a block_properties row for due_date"
    );
}

/// #604 (end-to-end): undoing a space re-assignment must restore
/// `blocks.space_id` to the prior space and never write a
/// `block_properties(key='space')` row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_set_space_restores_space_id_604() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    let page = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, None)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    for space in [TEST_SPACE_ID, TEST_SPACE_B_ID] {
        set_property_inner(
            &pool,
            DEV,
            &mat,
            page.id.as_str().into(),
            "space".into(),
            None,
            None,
            None,
            Some(space.into()),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
    }

    // Revert the second assignment (A → B); space_id must return to A.
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    let second_set = set_ops.last().unwrap();
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: second_set.seq,
        }],
    )
    .await
    .expect("undo of set_property(space) must not hit the 0088 CHECK");
    mat.flush_background().await.unwrap();

    let space_id: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(page.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        space_id.as_deref(),
        Some(TEST_SPACE_ID),
        "undo must restore blocks.space_id to the prior space"
    );

    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'space'",
    )
    .bind(page.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "undo must not create a block_properties row for space"
    );
}

// ======================================================================
// Phase 2 — SpaceScope parity test (commands/history.rs)
// ======================================================================
//
// Asserts that `list_page_history_inner` honours the `&SpaceScope`
// boundary in `__all__` (cross-page) mode: `Global` returns the union
// across spaces, `Active(SpaceId)` narrows to the named space.
// Per-page mode is space-bound by `page_id` already, so the scope is a
// no-op there (ignored at the SQL bind site).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend18_list_page_history_scope_parity() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Two pages, one per space — each `create_block_inner` appends one
    // CreateBlock op so the cross-page history surfaces both.
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    let page_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;
    assign_to_space(&pool, page_a.id.as_str(), TEST_SPACE_ID).await;
    assign_to_space(&pool, page_b.id.as_str(), TEST_SPACE_B_ID).await;

    let global = list_page_history_inner(
        &pool,
        "__all__".into(),
        None,
        &SpaceScope::Global,
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert!(
        global.items.len() >= 2,
        "Global must include ops from both spaces; got {} items",
        global.items.len()
    );

    let active_a = list_page_history_inner(
        &pool,
        "__all__".into(),
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert!(
        active_a.items.iter().all(|e| {
            let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap();
            payload["block_id"].as_str() == Some(page_a.id.as_str())
        }),
        "Active(TEST_SPACE_ID) must restrict ops to space A's blocks; got {} items",
        active_a.items.len()
    );

    mat.shutdown();
}

// ======================================================================
// #657 — reverse RestoreBlock / MoveBlock must refresh `space_id` in
// step with `page_id` (#533 parity with the forward paths they mirror).
// ======================================================================

/// Seed two registered spaces, a page in each, and a child subtree under
/// the space-A page. Returns nothing — fixed ids are used by the callers.
async fn seed_two_space_pages_657(pool: &SqlitePool) {
    // Space blocks first (spaces.id FK → blocks.id, migration 0089).
    for (id, pos) in [("SPACEA657", 1i64), ("SPACEB657", 2i64)] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'space', NULL, ?, ?)",
        )
        .bind(id)
        .bind(pos)
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
    // One page per space.
    for (id, pos, space) in [
        ("PAGE1657", 3i64, "SPACEA657"),
        ("PAGE2657", 4i64, "SPACEB657"),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'p', NULL, ?, ?, ?)",
        )
        .bind(id)
        .bind(pos)
        .bind(id)
        .bind(space)
        .execute(pool)
        .await
        .unwrap();
    }
    // Child + grandchild under the space-A page.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES ('CHILD657', 'content', 'c', 'PAGE1657', 1, 'PAGE1657', 'SPACEA657')",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES ('GRAND657', 'content', 'g', 'CHILD657', 1, 'PAGE1657', 'SPACEA657')",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn page_and_space_of(pool: &SqlitePool, id: &str) -> (Option<String>, Option<String>) {
    let row = sqlx::query("SELECT page_id, space_id FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    use sqlx::Row;
    (row.get("page_id"), row.get("space_id"))
}

/// #657 (MoveBlock half): undoing a move re-parents the subtree across a
/// space boundary — the reverse arm must rewrite `space_id` alongside
/// `page_id`, not leave the subtree's space membership stale until the
/// background RebuildPageIds chain lands.
#[tokio::test]
async fn apply_reverse_move_block_refreshes_space_id_657() {
    let (pool, _dir) = test_pool().await;
    seed_two_space_pages_657(&pool).await;

    // Reverse-of-a-move payload: put CHILD657 under the space-B page.
    let payload = OpPayload::MoveBlock(crate::op::MoveBlockPayload {
        block_id: BlockId::test_id("CHILD657"),
        new_parent_id: Some(BlockId::test_id("PAGE2657")),
        new_position: 1,
        new_index: None,
    });
    let mut tx = pool.begin().await.unwrap();
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &payload,
        crate::db::now_ms(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    for id in ["CHILD657", "GRAND657"] {
        let (page_id, space_id) = page_and_space_of(&pool, id).await;
        assert_eq!(
            page_id.as_deref(),
            Some("PAGE2657"),
            "{id}: page_id refreshed"
        );
        assert_eq!(
            space_id.as_deref(),
            Some("SPACEB657"),
            "{id}: space_id must follow page_id synchronously on reverse move (#657)"
        );
    }
}

/// #657 (RestoreBlock half): undoing a delete restores the subtree into a
/// page whose space assignment changed while the subtree was tombstoned —
/// the reverse arm must stamp the CURRENT space, not resurrect the stale one.
#[tokio::test]
async fn apply_reverse_restore_block_refreshes_space_id_657() {
    let (pool, _dir) = test_pool().await;
    seed_two_space_pages_657(&pool).await;

    // Tombstone the subtree as one cohort, then move its owning page to
    // space B while it sits in the trash.
    const COHORT_TS: i64 = 1_600_000_000_000;
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id IN ('CHILD657','GRAND657')")
        .bind(COHORT_TS)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET space_id = 'SPACEB657' WHERE id = 'PAGE1657'")
        .execute(&pool)
        .await
        .unwrap();

    let payload = OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
        block_id: BlockId::test_id("CHILD657"),
        deleted_at_ref: COHORT_TS,
    });
    let mut tx = pool.begin().await.unwrap();
    apply_reverse_in_tx(
        &mut tx,
        &crate::loro::shared::LoroState::new(),
        DEV,
        &payload,
        crate::db::now_ms(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    for id in ["CHILD657", "GRAND657"] {
        let (page_id, space_id) = page_and_space_of(&pool, id).await;
        assert_eq!(
            page_id.as_deref(),
            Some("PAGE1657"),
            "{id}: page_id refreshed"
        );
        assert_eq!(
            space_id.as_deref(),
            Some("SPACEB657"),
            "{id}: restored subtree must pick up the page's CURRENT space (#657)"
        );
    }
}

// ======================================================================
// #659 — redo_page_op must verify its target is an undo op.
// ======================================================================

/// #659: handing redo a FORWARD op ref (here: the original edit, not the
/// undo) must be rejected with `Validation` — before the fix it happily
/// reversed the forward op and labelled the result `is_redo: true`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redo_rejects_forward_op_ref_659() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (_page_id, child_ids) = create_page_with_children(&pool, &mat).await;
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // The forward edit op's ref.
    let edit_seq: i64 = sqlx::query_scalar(
        "SELECT MAX(seq) FROM op_log WHERE device_id = ? AND op_type = 'edit_block'",
    )
    .bind(DEV)
    .fetch_one(&pool)
    .await
    .unwrap();

    let result = redo_page_op_inner(&pool, DEV, &mat, DEV.into(), edit_seq).await;
    let err = result.expect_err("redo of a forward op must be rejected (#659)");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "expected Validation, got: {err:?}"
    );
    assert!(
        err.to_string().contains("not"),
        "error should explain the target is not an undo op: {err}"
    );

    // The forward edit's effect must be untouched.
    let after = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        after.content,
        Some("edited".into()),
        "rejected redo must not mutate state (#659)"
    );
    mat.shutdown();
}

/// #659: the legitimate path still works — undo stamps `is_undo = 1` and
/// redo accepts the ref. (The end-to-end behaviour is covered by the
/// existing redo tests; this pins the flag itself.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_ops_are_flagged_is_undo_659() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "edited".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let undo = undo_page_op_inner(&pool, DEV, &mat, page_id, 0)
        .await
        .unwrap();

    let flag: i64 =
        sqlx::query_scalar("SELECT is_undo FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&undo.new_op_ref.device_id)
            .bind(undo.new_op_ref.seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(flag, 1, "undo-produced ops must carry is_undo = 1 (#659)");

    // And the forward edit op is NOT flagged.
    let forward_flag: i64 = sqlx::query_scalar(
        "SELECT is_undo FROM op_log WHERE device_id = ? AND op_type = 'edit_block' \
         ORDER BY seq ASC LIMIT 1",
    )
    .bind(DEV)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(forward_flag, 0, "forward ops keep is_undo = 0 (#659)");
    mat.shutdown();
}

// ======================================================================
// undo_page_group tests (#2190)
//
// The batched group-undo command resolves the page subtree + the group's
// op refs ONCE and reverts them in a single IMMEDIATE transaction, replacing
// the FE's `find_undo_group` + N × `undo_page_op` IPC loop. These tests pin:
//   * a multi-op group reverts every op newest-first in one tx, appending the
//     reverse ops to the op_log in application (newest-first) order,
//   * a single-op group degenerates to one reverse,
//   * an empty group (seed op doesn't exist) is a clean no-op, and
//   * a non-reversible op anywhere in the group rolls the WHOLE tx back with
//     no partial undo (no reverse ops leaked, live state untouched).
//
// The undo group is delimited by the SAME rule as `find_undo_group_inner`:
// a consecutive run of same-`device_id`, within-`window_ms` ops in the page's
// newest-first op stream. To make a group span exactly the ops we want, the
// tests exploit the same-device boundary: an op by a DIFFERENT device breaks
// the walk, so a block CREATED by one device and then EDITED by another yields
// a group of just the edits (the cross-device create is excluded).
// ======================================================================

const OTHER_DEV: &str = "test-device-OTHER";

/// Toggle the H-13 append-only bypass sentinel so a test can rewrite
/// `op_log.created_at` to carve deterministic grouping windows.
async fn set_op_log_mutation_bypass(pool: &SqlitePool, on: bool) {
    let sql = if on {
        "INSERT INTO _op_log_mutation_allowed (token) VALUES (1)"
    } else {
        "DELETE FROM _op_log_mutation_allowed"
    };
    sqlx::query(sql).execute(pool).await.unwrap();
}

/// A multi-op group is reverted newest-first in a single tx; the reverse ops
/// land in the op_log in application order, all flagged `is_undo = 1`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_reverts_multi_op_group_newest_first() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Block created by OTHER_DEV (this create op breaks the same-device walk,
    // so it is NOT part of the group) then edited twice by DEV.
    let created = create_block_inner(
        &pool,
        OTHER_DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
        .await
        .unwrap();
    settle(&mat).await;
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Resolve the two DEV edit ops (v1 = lower seq, v2 = higher seq).
    let edit_seqs: Vec<i64> = sqlx::query_scalar(
        "SELECT seq FROM op_log WHERE device_id = ? AND op_type = 'edit_block' ORDER BY seq ASC",
    )
    .bind(DEV)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(edit_seqs.len(), 2, "expected exactly two DEV edit ops");
    let (edit_v1_seq, edit_v2_seq) = (edit_seqs[0], edit_seqs[1]);

    let ops_before = op_log::get_ops_since(&ReadPool(pool.clone()), OTHER_DEV, 0)
        .await
        .unwrap()
        .len()
        + op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
            .await
            .unwrap()
            .len();

    // Batch-undo the group. A large window guarantees the two same-device
    // edits group; the cross-device create bounds the group at 2.
    let results = undo_page_group_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        0,
        1_000_000,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Exactly the two edits, newest-first: v2 then v1.
    assert_eq!(
        results.len(),
        2,
        "group must span the two same-device edits"
    );
    assert_eq!(
        results[0].reversed_op.seq, edit_v2_seq,
        "newest-first: the first reversed op must be the newest edit (v2)"
    );
    assert_eq!(
        results[1].reversed_op.seq, edit_v1_seq,
        "the second reversed op must be the older edit (v1)"
    );
    assert!(
        results.iter().all(|r| r.reversed_op_type == "edit_block"),
        "both reversed ops are edit_block"
    );

    // Materialized content is back to the pre-group value.
    let after = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v0".into()),
        "reverting the whole group restores the pre-group content"
    );

    // Two reverse ops appended, in application (newest-first) order, both
    // flagged is_undo = 1.
    let ops_after = op_log::get_ops_since(&ReadPool(pool.clone()), OTHER_DEV, 0)
        .await
        .unwrap()
        .len()
        + op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
            .await
            .unwrap()
            .len();
    assert_eq!(
        ops_after,
        ops_before + 2,
        "the batch appends exactly one reverse op per reverted op"
    );
    assert!(
        results[0].new_op_ref.seq < results[1].new_op_ref.seq,
        "reverse ops are appended in application order (v2's reverse before v1's)"
    );
    for r in &results {
        let is_undo: i64 =
            sqlx::query_scalar("SELECT is_undo FROM op_log WHERE device_id = ? AND seq = ?")
                .bind(&r.new_op_ref.device_id)
                .bind(r.new_op_ref.seq)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(is_undo, 1, "#659: batch reverse ops must carry is_undo = 1");
    }

    mat.shutdown();
}

/// A single-op group degenerates to one reverse (the batch command is a
/// drop-in for the old single `undo_page_op`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_single_op_group_degenerates() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Cross-device create bounds the group; a single DEV edit forms a group
    // of exactly one.
    let created = create_block_inner(
        &pool,
        OTHER_DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
        .await
        .unwrap();
    settle(&mat).await;

    let results = undo_page_group_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        0,
        1_000_000,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(results.len(), 1, "single-op group reverts exactly one op");
    let after = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v0".into()),
        "the single edit is reverted to v0"
    );
    mat.shutdown();
}

/// An empty group (seed depth past the page's undoable-op count) is a clean
/// no-op: no reverse ops, live state untouched (the IMMEDIATE tx rolls back).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_empty_group_is_noop() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "only".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let count_before = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap()
        .len();

    // depth = 50 seeds well past the single available op → no group.
    let results = undo_page_group_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        50,
        1_000_000,
    )
    .await
    .unwrap();

    assert!(results.is_empty(), "no seed op → empty result");
    let count_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap()
        .len();
    assert_eq!(
        count_after, count_before,
        "an empty group must not append any op (tx rolled back)"
    );
    let after = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(after.content, Some("only".into()), "live state untouched");
    mat.shutdown();
}

/// A non-reversible op anywhere in the group aborts the WHOLE batch before any
/// reverse is applied: no partial undo, no reverse ops leaked, live state
/// untouched. The group is forced to include a `purge_block` op (statically
/// non-reversible) by raw-inserting one on a still-live block so it stays in
/// the page's op scope — a real purge would delete the block and drop the op
/// out of scope.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_rolls_back_on_non_reversible() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Raw-insert a `purge_block` op for the STILL-LIVE block, newest in the
    // stream (highest seq), same device + created_at as the edit so it groups.
    let edit_ts: i64 = sqlx::query_scalar(
        "SELECT created_at FROM op_log WHERE device_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .bind(DEV)
    .fetch_one(&pool)
    .await
    .unwrap();
    let next_seq: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) + 1 FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, is_undo) \
         VALUES (?, ?, NULL, ?, 'purge_block', '{}', ?, ?, 0)",
    )
    .bind(DEV)
    .bind(next_seq)
    .bind("test-hash-purge")
    .bind(edit_ts)
    .bind(created.id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let count_before = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap()
        .len();

    // depth 0 seeds at the purge op (newest); the group also spans the edit +
    // create. The non-reversible purge must abort the whole batch.
    let result = undo_page_group_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        0,
        1_000_000,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NonReversible { .. })),
        "a non-reversible op in the group must abort the batch; got: {result:?}"
    );

    // Tx rolled back: no reverse ops appended, live content unchanged.
    let count_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap()
        .len();
    assert_eq!(
        count_after, count_before,
        "aborted batch must not append any reverse op (whole tx rolled back)"
    );
    let after = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v1".into()),
        "no partial undo: the edit stays applied"
    );
    mat.shutdown();
}

/// #2190 DIFFERENTIAL: the fused batch enumeration must select EXACTLY the op
/// set the old `find_undo_group` + N × `undo_page_op(depth + i)` loop walked —
/// same same-device rule, same chained (not seed-anchored) `window_ms` gap,
/// same `is_undo = 0` exclusion, same depth seeding.
///
/// Fixture (newest-first undoable stream, all on one page, window = 1000 ms):
///   [raw is_undo=1 op]            ← excluded from the stream entirely
///   e4 (DEV, T+5100) ┐ group A (e4→e3 gap 100 ≤ 1000;
///   e3 (DEV, T+5000) ┘           e3→e2 gap 4900 > 1000 breaks)
///   e2 (DEV, T+100)  ┐ group B (e2→e1 gap 100)
///   e1 (DEV, T)      ┘
///   create (OTHER_DEV)            ← same-device boundary
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_enumeration_matches_find_undo_group_differential() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    const WINDOW: i64 = 1000;

    let created = create_block_inner(
        &pool,
        OTHER_DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    for v in ["v1", "v2", "v3", "v4"] {
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), v.into())
            .await
            .unwrap();
        settle(&mat).await;
    }

    // Rewrite the DEV edits' timestamps to carve the two windows.
    let edit_seqs: Vec<i64> = sqlx::query_scalar(
        "SELECT seq FROM op_log WHERE device_id = ? AND op_type = 'edit_block' ORDER BY seq ASC",
    )
    .bind(DEV)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(edit_seqs.len(), 4);
    let base: i64 = 2_000_000_000_000;
    set_op_log_mutation_bypass(&pool, true).await;
    for (seq, ts) in edit_seqs
        .iter()
        .zip([base, base + 100, base + 5000, base + 5100])
    {
        sqlx::query("UPDATE op_log SET created_at = ? WHERE device_id = ? AND seq = ?")
            .bind(ts)
            .bind(DEV)
            .bind(seq)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Ensure the OTHER_DEV create sits BELOW group B in the newest-first order.
    sqlx::query("UPDATE op_log SET created_at = ? WHERE device_id = ?")
        .bind(base - 100)
        .bind(OTHER_DEV)
        .execute(&pool)
        .await
        .unwrap();
    set_op_log_mutation_bypass(&pool, false).await;
    // A raw is_undo = 1 op newer than everything: must be INVISIBLE to both
    // the sizing walk and the batch enumeration.
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, is_undo) \
         VALUES (?, ?, NULL, 'h-undo-noise', 'edit_block', '{}', ?, ?, 1)",
    )
    .bind(DEV)
    .bind(edit_seqs[3] + 1)
    .bind(base + 5200)
    .bind(created.id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let page_id = created.id.clone().into_string();

    // ── depth 0: both sides must agree on group A = {e4, e3} ─────────────
    let size_a = find_undo_group_inner(&pool, &page_id, 0, WINDOW)
        .await
        .unwrap();
    let group_a = undo_page_group_inner(&pool, DEV, &mat, page_id.clone(), 0, WINDOW)
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(size_a, 2, "window gap must bound group A at 2");
    assert_eq!(
        i32::try_from(group_a.len()).unwrap(),
        size_a,
        "batch enumeration must revert exactly the ops find_undo_group sized"
    );
    assert_eq!(
        (group_a[0].reversed_op.seq, group_a[1].reversed_op.seq),
        (edit_seqs[3], edit_seqs[2]),
        "group A must be e4 then e3, newest-first"
    );
    let after_a = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(after_a.content, Some("v2".into()), "undoing e4,e3 → v2");

    // ── depth 2 (FE anchor after a 2-op batch): group B = {e2, e1} ────────
    // The undoable stream is UNCHANGED by the first batch (its reverses are
    // is_undo = 1), so the same depth seeds the same ops on both sides.
    let size_b = find_undo_group_inner(&pool, &page_id, 2, WINDOW)
        .await
        .unwrap();
    let group_b = undo_page_group_inner(&pool, DEV, &mat, page_id.clone(), 2, WINDOW)
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(size_b, 2, "group B spans e2,e1 down to the device boundary");
    assert_eq!(i32::try_from(group_b.len()).unwrap(), size_b);
    assert_eq!(
        (group_b[0].reversed_op.seq, group_b[1].reversed_op.seq),
        (edit_seqs[1], edit_seqs[0]),
        "group B must be e2 then e1 — the cross-device create is excluded"
    );
    let after_b = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        after_b.content,
        Some("v0".into()),
        "undoing all four edits restores the created content"
    );
    mat.shutdown();
}

// ======================================================================
// Reverse-apply integrity — the reverse path must validate the CURRENT
// tree state before writing (cycle probe, target-parent liveness, #1884
// upward ancestor restore), exactly like its forward counterparts.
// ======================================================================

/// Reverting an old move op AFTER the prior parent was reparented under the
/// moved block must be REJECTED (classified `NonReversible`), never commit a
/// `blocks.parent_id` cycle. The forward path guards this via the shared
/// `block_descendants::move_would_cycle` probe (`move_ops.rs`); the reverse
/// path (`reverse_move_block`) must run the same probe.
///
/// Reachable from the History view: select only the old 'moved' entry and
/// click Revert (`HistoryRevertDialog` → `revert_ops`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_of_move_rejects_cycle_forming_reverse() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;

    // A under page, B under A
    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "A".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "B".into(),
        Some(a.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Op M: move B out to the page root
    move_block_inner(
        &pool,
        DEV,
        &mat,
        b.id.clone(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        0,
    )
    .await
    .unwrap();
    // capture M's op ref
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let m = ops.iter().rfind(|o| o.op_type == "move_block").unwrap();
    let m_seq = m.seq;

    // Now move A under B (valid: B is no longer inside A)
    move_block_inner(&pool, DEV, &mat, a.id.clone(), Some(b.id.clone()), 0)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Revert op M alone (History view arbitrary-selection revert). The reverse
    // MoveBlock targets prior parent A, which is now a DESCENDANT of B — the
    // interactive batch contract is abort-before-apply with a classified error.
    let res = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: m_seq,
        }],
    )
    .await;
    let err = res.expect_err(
        "reverting a move whose prior parent is now a descendant of the moved \
         block must be rejected, not committed as a parent_id cycle",
    );
    assert!(
        matches!(err, AppError::NonReversible { .. }),
        "cycle-forming reverse move must be classified NonReversible, got: {err:?}"
    );

    // The rejected revert must leave the tree exactly as it was: A under B,
    // B under the page — acyclic and fully reachable.
    let a_parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(a.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    let b_parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(b.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        a_parent.as_deref(),
        Some(b.id.as_str()),
        "rejected revert must leave A under B (tree unchanged)"
    );
    assert_eq!(
        b_parent.as_deref(),
        Some(page_id.as_str()),
        "rejected revert must leave B under the page (no cycle installed)"
    );
    mat.shutdown();
}

/// Reverting a move AFTER the prior parent was soft-deleted must be REJECTED
/// (classified `NonReversible`), never reparent a LIVE block under a
/// tombstone — such a block is invisible in both the tree and the trash, and
/// a later 'delete forever' on the tombstoned parent would hard-delete it
/// (the purge CTE walks without a `deleted_at` filter).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_of_move_rejects_tombstoned_prior_parent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;

    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "A".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "C".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "B".into(),
        Some(a.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Op M: move B from A to C
    move_block_inner(&pool, DEV, &mat, b.id.clone(), Some(c.id.clone()), 0)
        .await
        .unwrap();
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let m_seq = ops.iter().rfind(|o| o.op_type == "move_block").unwrap().seq;

    // Delete A (trash)
    delete_block_inner(&pool, DEV, &mat, a.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Revert op M alone: the reverse MoveBlock targets prior parent A, which
    // is now tombstoned. The revert must abort with a classified error.
    let res = revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: m_seq,
        }],
    )
    .await;
    let err = res.expect_err(
        "reverting a move whose prior parent is soft-deleted must be rejected, \
         not leave a live block parented under a tombstone",
    );
    assert!(
        matches!(err, AppError::NonReversible { .. }),
        "reverse move onto a tombstoned parent must be classified NonReversible, got: {err:?}"
    );

    // The rejected revert must leave B exactly where it was: live under C.
    let (b_parent, b_deleted): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT parent_id, deleted_at FROM blocks WHERE id = ?")
            .bind(b.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        b_parent.as_deref(),
        Some(c.id.as_str()),
        "rejected revert must leave B under its current parent C"
    );
    assert!(b_deleted.is_none(), "B must remain live");
    mat.shutdown();
}

/// Reverting an old delete (History view / ActivityFeed single-op revert)
/// AFTER the parent was separately deleted must restore the tombstoned
/// ancestor chain too (#1884), exactly like the forward restore command
/// (`restore_block_inner`) and the materializer projection
/// (`project_restore_block_to_sql`) — otherwise the block comes back LIVE
/// under a still-tombstoned parent, invisible in both the tree and trash.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_of_delete_restores_tombstoned_ancestor_chain_1884() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;

    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "A".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "B".into(),
        Some(a.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Op D1: delete B; then delete A (separate cohort, skips already-deleted B)
    delete_block_inner(&pool, DEV, &mat, b.id.clone())
        .await
        .unwrap();
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let d1_seq = ops
        .iter()
        .rfind(|o| o.op_type == "delete_block")
        .unwrap()
        .seq;
    delete_block_inner(&pool, DEV, &mat, a.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Revert D1 alone: the reverse RestoreBlock must clear B's cohort AND
    // restore the contiguous tombstoned ancestor chain (here: A), mirroring
    // the #1884 behaviour of every other restore writer.
    revert_ops_inner(
        &pool,
        DEV,
        &mat,
        vec![OpRef {
            device_id: DEV.into(),
            seq: d1_seq,
        }],
    )
    .await
    .expect("reverting the child's delete must succeed");

    let (b_parent, b_deleted): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT parent_id, deleted_at FROM blocks WHERE id = ?")
            .bind(b.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    let a_deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(a.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(b_deleted.is_none(), "B must be restored live");
    assert_eq!(
        b_parent.as_deref(),
        Some(a.id.as_str()),
        "B keeps its parent A after the revert"
    );
    assert!(
        a_deleted.is_none(),
        "#1884: the revert must restore B's tombstoned ancestor A too — a live \
         block under a tombstoned parent is invisible in both tree and trash; \
         got A.deleted_at = {a_deleted:?}"
    );
    mat.shutdown();
}

/// Point-in-time restore (#2020 best-effort contract): a reverse move whose
/// prior parent was PURGED cannot be applied — it must be SKIPPED and counted
/// (`non_reversible_skipped`), not abort the whole restore with an opaque FK
/// error (and never write a dangling `parent_id`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_skips_reverse_move_onto_purged_parent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;

    // P and Q under the page, X under P.
    let p = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "P".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let q = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Q".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(4),
    )
    .await
    .unwrap();
    let x = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "X".into(),
        Some(p.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Restore target: the create-X op (the state just before the move below).
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops
        .iter()
        .rfind(|o| o.op_type == "create_block")
        .unwrap()
        .seq;

    // Op M: move X from P to Q; then delete AND purge P — the reverse of M
    // now targets a parent that no longer exists at all.
    move_block_inner(&pool, DEV, &mat, x.id.clone(), Some(q.id.clone()), 0)
        .await
        .unwrap();
    delete_block_inner(&pool, DEV, &mat, p.id.clone())
        .await
        .unwrap();
    purge_block_inner(&pool, DEV, &mat, p.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page_id.clone(),
        DEV.to_owned(),
        target_seq,
    )
    .await
    .expect(
        "restore must complete best-effort, skipping the unappliable reverse \
         move instead of aborting on a purged prior parent",
    );

    // Skipped: the reverse move onto the purged parent (dynamically
    // non-reversible). P's own delete/purge ops fall outside the page-scoped
    // membership CTE once the purge removed P's row, so the move is the only
    // candidate — and it must be SKIPPED, not applied (dangling `parent_id` /
    // FK abort) and not abort the restore.
    assert_eq!(
        result.non_reversible_skipped, 1,
        "the reverse move onto the purged parent must be skipped+counted; \
         got {result:?}"
    );
    assert_eq!(
        result.ops_reverted, 0,
        "nothing else was revertible; got {result:?}"
    );

    // X must stay live under Q — never re-parented to a nonexistent row.
    let (x_parent, x_deleted): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT parent_id, deleted_at FROM blocks WHERE id = ?")
            .bind(x.id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        x_parent.as_deref(),
        Some(q.id.as_str()),
        "the skipped reverse move must leave X under its current parent Q"
    );
    assert!(x_deleted.is_none(), "X must remain live");
    mat.shutdown();
}

// ======================================================================
// Undo/redo cohort invariant — `op.created_at == blocks.deleted_at`
// (#1549 analogue for undo-produced deletes)
// ======================================================================

/// An undo-produced soft-delete (reverse of `create_block`) must stamp
/// `blocks.deleted_at` with the SAME value as the reverse op's
/// `op_log.created_at`, and that value must come from the process-monotonic
/// delete clock (`next_delete_ms`) — never a second independent `now_ms()`
/// read. Two clock reads break the redo chain (the later `RestoreBlock`
/// matches zero rows), and a non-monotonic stamp can collide with an
/// existing cohort (#1549 over-restore).
///
/// Determinism: the delete clock is pre-advanced ~2s into the future, so a
/// wall-clock (`now_ms`) stamp is guaranteed to violate the monotonic floor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_produced_delete_cohorts_are_monotonic_and_match_op_created_at() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;

    // Two nested blocks whose creates form one undo group.
    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "A".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "B".into(),
        Some(a.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Advance the process-global delete clock well past wall-clock so a
    // `now_ms()`-stamped cohort deterministically lands BELOW the floor.
    let mut floor = 0;
    for _ in 0..2000 {
        floor = crate::db::next_delete_ms();
    }

    // Group-undo the whole burst (routes through `revert_ops_in_tx`); every
    // reverse here is a DeleteBlock.
    let results = undo_page_group_inner(&pool, DEV, &mat, page_id.clone(), 0, 60_000)
        .await
        .unwrap();
    settle(&mat).await;
    assert!(
        results.len() >= 2,
        "group undo must cover at least the two creates; got {results:?}"
    );

    let mut cohorts: Vec<i64> = Vec::new();
    for r in &results {
        assert_eq!(r.new_op_type, "delete_block");
        let (op_created_at, block_id): (i64, String) = sqlx::query_as(
            "SELECT created_at, block_id FROM op_log WHERE device_id = ? AND seq = ?",
        )
        .bind(&r.new_op_ref.device_id)
        .bind(r.new_op_ref.seq)
        .fetch_one(&pool)
        .await
        .unwrap();
        let deleted_at: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(&block_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let deleted_at = deleted_at.unwrap_or_else(|| {
            panic!("undo of create must soft-delete block {block_id}, got live row")
        });
        assert_eq!(
            deleted_at, op_created_at,
            "cohort invariant: blocks.deleted_at must equal the reverse op's \
             op_log.created_at (block {block_id}) — otherwise redo's \
             RestoreBlock(deleted_at_ref) matches zero rows and silently no-ops"
        );
        assert!(
            deleted_at > floor,
            "undo-produced delete cohort must come from the monotonic delete \
             clock (next_delete_ms > pre-advanced floor {floor}), got {deleted_at} \
             for block {block_id} — a wall-clock stamp can collide with an \
             existing cohort (#1549)"
        );
        cohorts.push(deleted_at);
    }
    let mut deduped = cohorts.clone();
    deduped.sort_unstable();
    deduped.dedup();
    assert_eq!(
        deduped.len(),
        cohorts.len(),
        "each undo-produced delete must get a DISTINCT cohort timestamp; got {cohorts:?}"
    );
    // Silence unused warnings for ids the loop resolves dynamically.
    let _ = (a, b);
    mat.shutdown();
}

/// Behavioural pin for the cohort invariant: create → undo → redo must bring
/// the block back. (With two independent clock reads, redo's RestoreBlock
/// referenced a `deleted_at` that no row carried whenever the append and the
/// apply straddled a millisecond boundary.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_undo_redo_roundtrip_restores_block_live() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _children) = create_page_with_children(&pool, &mat).await;
    let c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "C".into(),
        Some(crate::ulid::BlockId::from_trusted(&page_id)),
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let undo = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(undo.new_op_type, "delete_block");
    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(c.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(deleted.is_some(), "undo of create must soft-delete C");

    redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo.new_op_ref.device_id.clone(),
        undo.new_op_ref.seq,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(c.id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        deleted.is_none(),
        "redo of undo-of-create must restore C live (RestoreBlock cohort must \
         match the undo op's deleted_at stamp); got deleted_at = {deleted:?}"
    );
    mat.shutdown();
}

/// Same invariant through the redo path's own delete stamping:
/// delete → undo (restore) → redo (re-delete) → undo (restore) must end with
/// the block live — the final RestoreBlock references the REDO op's
/// `created_at`, which must equal the `deleted_at` the redo stamped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_undo_redo_undo_chain_ends_with_block_live() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;
    let target = crate::ulid::BlockId::from_trusted(&child_ids[0]);

    delete_block_inner(&pool, DEV, &mat, target.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Undo the delete → restore.
    let undo = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(undo.new_op_type, "restore_block");

    // Redo → re-delete (appended as a forward op, `is_undo = 0`).
    redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo.new_op_ref.device_id.clone(),
        undo.new_op_ref.seq,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(target.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(deleted.is_some(), "redo must re-delete the block");

    // Undo again — targets the redo's delete op (newest is_undo = 0 op) and
    // must find its cohort.
    undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;
    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(target.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        deleted.is_none(),
        "undo of the redo's delete must restore the block live (cohort match); \
         got deleted_at = {deleted:?}"
    );
    mat.shutdown();
}

// ======================================================================
// Undo must keep the shared per-space Loro engine in step with SQL —
// otherwise the NEXT forward move reprojects the whole sibling group
// from the stale engine order, silently resurrecting the undone move.
// ======================================================================

/// Seed one pre-existing block into BOTH SQL and the per-space engine tree
/// (mirrors `undo_integration.rs::seed_block_both`): a brand-new root page
/// created via op resolves no space yet and would take the SQL-only fallback,
/// so pre-existing roots are replayed straight into the engine.
async fn seed_block_into_sql_and_engine(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: i64,
) {
    insert_block(pool, id, block_type, content, parent_id, Some(position)).await;
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEV)
        .expect("for_space seed");
    guard
        .engine_mut()
        .apply_create_block(id, block_type, content, parent_id, position)
        .expect("seed apply_create_block into engine");
    drop(guard);
}

/// Drive a single op through the production ENGINE path: append to the
/// op-log, then run the foreground ApplyOp (`dispatch_op` → `apply_*_via_loro`
/// + dense reprojection) and settle the background fan-out.
async fn dispatch_op_via_engine(
    pool: &SqlitePool,
    mat: &Materializer,
    payload: crate::op::OpPayload,
) {
    let record = op_log::append_local_op(pool, DEV, payload)
        .await
        .expect("append_local_op");
    mat.dispatch_op(&record).await.expect("dispatch_op");
    settle(mat).await;
}

/// Undoing a move must drive the SAME reverse move into the per-space engine:
/// the forward move path is engine-authoritative (it translates the requested
/// slot against the engine's sibling order and reprojects EVERY sibling's SQL
/// position from it), so a stale engine order silently re-applies the undone
/// move on the next forward move in the group.
///
/// Scenario: siblings X,Y,Z → move X to the end (Y,Z,X) → undo (X,Y,Z) →
/// move Y to the end. Expected X,Z,Y; with a stale engine the result was
/// Z,X,Y — the undone move of X resurrected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_move_keeps_engine_order_in_step_with_sql() {
    use crate::op::{CreateBlockPayload, MoveBlockPayload};

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let state = mat.loro_state();

    const S1: &str = "01HZUES000000000000000PAG1";
    const X: &str = "01HZUES0000000000000000XXX";
    const Y: &str = "01HZUES0000000000000000YYY";
    const Z: &str = "01HZUES0000000000000000ZZZ";

    seed_block_into_sql_and_engine(&pool, state, S1, "page", "page-1", None, 1).await;
    assign_all_to_test_space(&pool).await;

    // Create X,Y,Z as children of S1 through the engine path (slots 0,1,2).
    for (i, child) in [X, Y, Z].into_iter().enumerate() {
        dispatch_op_via_engine(
            &pool,
            &mat,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(S1)),
                position: None,
                index: Some(i64::try_from(i).unwrap()),
                content: child.into(),
            }),
        )
        .await;
    }
    assign_all_to_test_space(&pool).await;

    async fn sql_order(pool: &SqlitePool) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position, id",
        )
        .bind("01HZUES000000000000000PAG1")
        .fetch_all(pool)
        .await
        .unwrap();
        rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()
    }
    assert_eq!(sql_order(&pool).await, vec![X, Y, Z], "sanity: X,Y,Z");

    // Move X to the end (slot 2) — engine + SQL now hold Y,Z,X.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(X),
            new_parent_id: Some(BlockId::from_trusted(S1)),
            new_position: 3,
            new_index: Some(2),
        }),
    )
    .await;
    assert_eq!(sql_order(&pool).await, vec![Y, Z, X], "after move: Y,Z,X");

    // Undo the move: SQL must return to X,Y,Z AND the engine must follow.
    let undo = undo_page_op_inner(&pool, DEV, &mat, S1.to_owned(), 0)
        .await
        .expect("undo move");
    settle(&mat).await;
    assert_eq!(undo.reversed_op_type, "move_block");
    assert_eq!(sql_order(&pool).await, vec![X, Y, Z], "after undo: X,Y,Z");
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        let engine_order = guard
            .engine_mut()
            .children_ordered_block_ids(Some(S1))
            .expect("children_ordered_block_ids");
        drop(guard);
        assert_eq!(
            engine_order,
            vec![X.to_owned(), Y.to_owned(), Z.to_owned()],
            "undo must drive the reverse move into the per-space engine — a \
             stale engine order re-applies the undone move on the next \
             forward move in this sibling group"
        );
    }

    // The user now sees X,Y,Z and moves Y to the end → expects X,Z,Y. With a
    // stale engine (Y,Z,X) the reprojection produced Z,X,Y instead.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(Y),
            new_parent_id: Some(BlockId::from_trusted(S1)),
            new_position: 3,
            new_index: Some(2),
        }),
    )
    .await;
    assert_eq!(
        sql_order(&pool).await,
        vec![X, Z, Y],
        "the forward move AFTER an undo must project against the undone \
         order (X,Y,Z), not resurrect the undone move"
    );

    // ENGINE-PATH GUARD: all blocks must be present in the engine tree, so a
    // silent regression to the SQL-only fallback fails loudly.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        for id in [S1, X, Y, Z] {
            assert!(
                guard
                    .engine_mut()
                    .read_block(id)
                    .expect("read_block")
                    .is_some(),
                "block {id} absent from the engine tree — ops took the SQL-only \
                 fallback, not the production engine path",
            );
        }
        drop(guard);
    }
    mat.shutdown();
}

/// Undo-of-delete (reverse `RestoreBlock`) staleness probe: the SQL restore
/// must reach the per-space engine too, or the NEXT forward move in the
/// sibling group reprojects the group WITHOUT the restored block — its stale
/// SQL rank then collides with a live sibling's and the visible order
/// silently diverges from what the user arranged.
///
/// Scenario: X,Y,Z → delete Y → undo (SQL: X,Y,Z again) → move X to the end.
/// Expected Y,Z,X; with a stale engine (Y still tombstoned there) the group
/// reprojects only [Z,X], leaving Y at its stale rank.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_delete_keeps_engine_in_step_for_next_move() {
    use crate::op::{CreateBlockPayload, DeleteBlockPayload, MoveBlockPayload};

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let state = mat.loro_state();

    const S1: &str = "01HZUED000000000000000PAG1";
    const X: &str = "01HZUED0000000000000000XXX";
    const Y: &str = "01HZUED0000000000000000YYY";
    const Z: &str = "01HZUED0000000000000000ZZZ";

    seed_block_into_sql_and_engine(&pool, state, S1, "page", "page-1", None, 1).await;
    assign_all_to_test_space(&pool).await;
    for (i, child) in [X, Y, Z].into_iter().enumerate() {
        dispatch_op_via_engine(
            &pool,
            &mat,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(S1)),
                position: None,
                index: Some(i64::try_from(i).unwrap()),
                content: child.into(),
            }),
        )
        .await;
    }
    assign_all_to_test_space(&pool).await;

    async fn sql_order(pool: &SqlitePool) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position, id",
        )
        .bind("01HZUED000000000000000PAG1")
        .fetch_all(pool)
        .await
        .unwrap();
        rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()
    }
    assert_eq!(sql_order(&pool).await, vec![X, Y, Z], "sanity: X,Y,Z");

    // Delete Y through the engine path, then undo it.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(Y),
        }),
    )
    .await;
    assert_eq!(sql_order(&pool).await, vec![X, Z], "after delete: X,Z");

    undo_page_op_inner(&pool, DEV, &mat, S1.to_owned(), 0)
        .await
        .expect("undo delete");
    settle(&mat).await;
    assert_eq!(sql_order(&pool).await, vec![X, Y, Z], "after undo: X,Y,Z");

    // Move X to the end. The user sees X,Y,Z and expects Y,Z,X. If the undo
    // never restored Y in the engine, the group reprojects as [Z,X] only and
    // Y's stale rank corrupts the visible order.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(X),
            new_parent_id: Some(BlockId::from_trusted(S1)),
            new_position: 3,
            new_index: Some(2),
        }),
    )
    .await;
    assert_eq!(
        sql_order(&pool).await,
        vec![Y, Z, X],
        "the forward move AFTER an undo-of-delete must project against the \
         restored sibling group (X,Y,Z → move X to end → Y,Z,X)"
    );
    mat.shutdown();
}

/// Undo-of-create (reverse `DeleteBlock`) staleness probe: the SQL tombstone
/// must reach the per-space engine too, or the NEXT forward move in the
/// sibling group reprojects the group WITH the undone block still in it —
/// live siblings keep order but the undone block's presence skews the ranks
/// the engine hands back on subsequent slot translations.
///
/// Scenario: X,Y → create Z between them (slot 1) → undo (SQL: X,Y) →
/// move Y to slot 0. Expected Y,X; a stale engine still holding Z translates
/// the slot against [X,Z,Y] and reprojects Z's tombstoned row too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_create_keeps_engine_in_step_for_next_move() {
    use crate::op::{CreateBlockPayload, MoveBlockPayload};

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let state = mat.loro_state();

    const S1: &str = "01HZUEC000000000000000PAG1";
    const X: &str = "01HZUEC0000000000000000XXX";
    const Y: &str = "01HZUEC0000000000000000YYY";
    const Z: &str = "01HZUEC0000000000000000ZZZ";

    seed_block_into_sql_and_engine(&pool, state, S1, "page", "page-1", None, 1).await;
    assign_all_to_test_space(&pool).await;
    for (i, child) in [X, Y].into_iter().enumerate() {
        dispatch_op_via_engine(
            &pool,
            &mat,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(S1)),
                position: None,
                index: Some(i64::try_from(i).unwrap()),
                content: child.into(),
            }),
        )
        .await;
    }
    assign_all_to_test_space(&pool).await;

    // Create Z between X and Y, then undo it.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(Z),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(S1)),
            position: None,
            index: Some(1),
            content: Z.into(),
        }),
    )
    .await;
    assign_all_to_test_space(&pool).await;

    async fn sql_order(pool: &SqlitePool) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position, id",
        )
        .bind("01HZUEC000000000000000PAG1")
        .fetch_all(pool)
        .await
        .unwrap();
        rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()
    }
    assert_eq!(sql_order(&pool).await, vec![X, Z, Y], "sanity: X,Z,Y");

    undo_page_op_inner(&pool, DEV, &mat, S1.to_owned(), 0)
        .await
        .expect("undo create");
    settle(&mat).await;
    assert_eq!(sql_order(&pool).await, vec![X, Y], "after undo: X,Y");

    // Move Y to the front. The user sees X,Y and expects Y,X — the slot must
    // be translated against the LIVE group (X,Y), not one still holding Z.
    dispatch_op_via_engine(
        &pool,
        &mat,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(Y),
            new_parent_id: Some(BlockId::from_trusted(S1)),
            new_position: 1,
            new_index: Some(0),
        }),
    )
    .await;
    assert_eq!(
        sql_order(&pool).await,
        vec![Y, X],
        "the forward move AFTER an undo-of-create must project against the \
         live sibling group (X,Y → move Y to front → Y,X)"
    );

    // The undone block must stay tombstoned in SQL with its cohort intact.
    let z_deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(Z)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(z_deleted.is_some(), "undone create must stay soft-deleted");
    mat.shutdown();
}

// ======================================================================
// #2549 — reviewer-added completeness fixes.
//
// The original #2549 fix filtered `find_prior_*` prior-state walks and
// added `reject_replicated_targets` to `revert_ops_in_tx`. It missed two
// other op_log reads that feed the SAME reverse-computation surface:
//
//   * `undo_page_op_inner`'s target-selection query calls
//     `reverse::compute_reverse` DIRECTLY — it never routes through
//     `revert_ops_in_tx`, so `reject_replicated_targets` never runs for it.
//   * `restore_page_to_op_inner`'s "ops after target" sweep feeds
//     `revert_ops_in_tx` a whole-batch-reject guard: a single unrelated
//     replicated audit row anywhere in the swept range would abort an
//     otherwise legitimate point-in-time restore.
//
// Both are fixed by adding `is_replicated = 0` to the respective queries
// (see `commands/history.rs`). These tests cover the two gaps.
// ======================================================================

/// #2549: `undo_page_op_inner` must skip a replicated (foreign, never-
/// applied) audit row even when it is NEWER than the last local op —
/// undo_depth=0 must still target the local edit, not the audit row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_skips_replicated_op_newer_than_local_2549() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

    // The only LOCAL edit this device actually applied.
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        child_ids[0].clone().into(),
        "local-edit".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // A REPLICATED (foreign, never-applied) edit on the SAME block, stamped
    // with a LATER created_at than the local edit above. Without the
    // `is_replicated = 0` filter on the undo target-selection query, this
    // newer-but-foreign row would be picked as the undo_depth=0 target
    // instead of the local edit, and `compute_reverse` +
    // `apply_reverse_in_tx` would mutate local state from a row this device
    // never actually applied.
    append_replicated_op(
        &pool,
        "remote-dev-2549",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: child_ids[0].clone().into(),
            to_text: "foreign-edit".into(),
            prev_edit: None,
        }),
        FIXED_TS + 999_999_999,
    )
    .await;

    let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
        .await
        .expect("undo must succeed by skipping the replicated row");

    assert_eq!(
        result.reversed_op.device_id, DEV,
        "undo must target the LOCAL edit, not the newer replicated audit row (#2549)"
    );
    assert_eq!(result.new_op_type, "edit_block");

    let after = get_block_inner(&pool, child_ids[0].clone().into())
        .await
        .unwrap();
    assert_eq!(
        after.content,
        Some("child one".into()),
        "content should revert to the pre-local-edit value, unaffected by the \
         never-applied foreign row"
    );

    // The replicated row itself must remain untouched.
    let (is_replicated,): (i64,) =
        sqlx::query_as("SELECT is_replicated FROM op_log WHERE device_id = ? AND seq = ?")
            .bind("remote-dev-2549")
            .bind(1i64)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        is_replicated, 1,
        "replicated row must stay marked as replicated"
    );
}

/// #2549: `restore_page_to_op_inner`'s sweep must exclude replicated audit
/// rows so an unrelated foreign op does not trip `reject_replicated_targets`
/// and abort an otherwise legitimate point-in-time restore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_ignores_replicated_op_in_sweep_2549() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "first".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "first-edited".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Restore target: right after this edit.
    let ops_so_far = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops_so_far
        .iter()
        .rev()
        .find(|o| o.op_type == "edit_block")
        .unwrap()
        .seq;

    // A REPLICATED (foreign, never-applied) edit AFTER the target, on the
    // SAME block that is in scope for this page restore. Before the fix,
    // this row would land in `candidate_ops` and `revert_ops_in_tx`'s
    // `reject_replicated_targets` guard would reject the ENTIRE restore,
    // even though this row has no local forward effect to undo.
    append_replicated_op(
        &pool,
        "remote-dev-2549",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: b1.id.clone(),
            to_text: "foreign-edit".into(),
            prev_edit: None,
        }),
        FIXED_TS + 500_000,
    )
    .await;

    // A genuine LOCAL edit after the target — this is what should actually
    // be reverted by the restore.
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "second-local-edit".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let result = restore_page_to_op_inner(
        &pool,
        DEV,
        &mat,
        page.id.to_string(),
        DEV.into(),
        target_seq,
    )
    .await
    .expect("restore must succeed despite an unrelated replicated audit row in the swept range");
    mat.flush_background().await.unwrap();

    assert_eq!(
        result.ops_reverted, 1,
        "only the local second edit should be reverted; the replicated row \
         must be excluded from the sweep entirely"
    );
    assert_eq!(result.non_reversible_skipped, 0);

    assert_eq!(
        get_block_inner(&pool, b1.id.clone()).await.unwrap().content,
        Some("first-edited".into()),
        "block should be restored to the target's local content"
    );

    // The replicated audit row itself must be untouched (never reverted).
    let (is_replicated,): (i64,) =
        sqlx::query_as("SELECT is_replicated FROM op_log WHERE device_id = ? AND seq = ?")
            .bind("remote-dev-2549")
            .bind(1i64)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        is_replicated, 1,
        "replicated row must remain marked as replicated"
    );
}

/// #2549: `undo_page_group_inner` (and by construction the identical
/// `find_undo_group_inner` CTE) must exclude replicated audit rows from
/// `ordered_ops`. A replicated row that is NEWER than every local op would
/// otherwise seed the walk (rn = 1 for depth = 0), flow into
/// `revert_ops_in_tx`, and be rejected wholesale by
/// `reject_replicated_targets` — making group undo unusable. With the filter,
/// the row is invisible: the two local edits form the group and both revert.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_group_skips_replicated_rows_2549() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Block created by OTHER_DEV so the create op breaks the same-device
    // walk and bounds the group at the two DEV edits (mirrors
    // `undo_page_group_reverts_multi_op_group_newest_first`).
    let created = create_block_inner(
        &pool,
        OTHER_DEV,
        &mat,
        "content".into(),
        "v0".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Two LOCAL edits, applied — the group that should be undone.
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "local-1".into())
        .await
        .unwrap();
    settle(&mat).await;
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "local-2".into())
        .await
        .unwrap();
    settle(&mat).await;

    // A REPLICATED (foreign, never-applied) edit on the same block with a
    // LATER created_at than both local edits: without the
    // `is_replicated = 0` filter it seeds the walk at depth 0 and the whole
    // group undo is rejected by `reject_replicated_targets`.
    append_replicated_op(
        &pool,
        "remote-dev-2549",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: created.id.clone(),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        crate::db::now_ms() + 999_999,
    )
    .await;

    let page_id = created.id.clone().into_string();

    // Sizing must agree with enumeration: the group is the two local edits.
    let size = find_undo_group_inner(&pool, &page_id, 0, 1_000_000)
        .await
        .expect("find_undo_group must succeed with a replicated row present");
    assert_eq!(
        size, 2,
        "group size must count only LOCAL undoable ops, not the replicated row (#2549)"
    );

    let results = undo_page_group_inner(&pool, DEV, &mat, page_id.clone(), 0, 1_000_000)
        .await
        .expect("group undo must succeed by ignoring the replicated row (#2549)");
    settle(&mat).await;

    assert_eq!(
        results.len(),
        2,
        "both local edits must be reverted; the replicated row must not \
         seed/abort the group"
    );
    assert!(
        results.iter().all(|r| r.reversed_op.device_id == DEV),
        "every reversed op must be a LOCAL op"
    );

    let after = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        after.content,
        Some("v0".into()),
        "content must revert to the pre-edit value, unaffected by the \
         never-applied foreign row"
    );
}
