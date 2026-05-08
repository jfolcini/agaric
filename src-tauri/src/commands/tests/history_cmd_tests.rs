#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// get_block_history
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_returns_ops_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
        .await
        .unwrap();

    let resp = get_block_history_inner(&pool, created.id, None, None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "create + edit = 2 ops");
    // Newest first (seq DESC)
    assert_eq!(
        resp.items[0].op_type, "edit_block",
        "newest op should be edit_block"
    );
    assert_eq!(
        resp.items[1].op_type, "create_block",
        "oldest op should be create_block"
    );
}

// ======================================================================
// compute_edit_diff_inner
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with initial content
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Edit the block to change its content
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "hello universe".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Find the edit_block op in the op_log
    let op_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
        .await
        .unwrap();

    let spans = diff.expect("diff should be Some for an edit_block op");
    assert!(!spans.is_empty(), "diff should contain at least one span");

    // The diff should contain a Delete for "world" and an Insert for "universe"
    use crate::word_diff::DiffTag;
    let has_delete = spans.iter().any(|s| s.tag == DiffTag::Delete);
    let has_insert = spans.iter().any(|s| s.tag == DiffTag::Insert);
    assert!(
        has_delete,
        "diff should have a Delete span for the old word"
    );
    assert!(
        has_insert,
        "diff should have an Insert span for the new word"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_same_text_produces_equal_spans() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block — this is the first (and only) op for this block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "initial text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Edit the block once — the prior text comes from create_block
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "initial text".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Grab the edit_block op
    let op_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
        .await
        .unwrap();

    let spans = diff.expect("diff should be Some for an edit_block op");
    // Editing with the same text should yield all-Equal spans (no changes)
    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().all(|s| s.tag == DiffTag::Equal),
        "diff should contain only Equal spans when text is unchanged, got: {spans:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_invalid_op_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    // Call with a device_id/seq that doesn't exist in the op_log
    let result = compute_edit_diff_inner(&pool, "nonexistent-device".into(), 999999).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for a nonexistent op, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_undo_page_op_inner_rejects_undo_depth_exceeding_max() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = undo_page_op_inner(&pool, DEV, &mat, "some-page".into(), 1001).await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("undo_depth exceeds maximum of 1000")),
        "should return Validation error for undo_depth > 1000, got: {result:?}"
    );
}

// ======================================================================
// compute_block_vs_current_diff_inner (PEND-17 Part B)
// ======================================================================
//
// The "block-vs-current" diff feeds the in-panel restore preview: given
// `historical_seq` (the op the user is hovering on) and the live
// `blocks.content`, it returns the word-level changes a restore would
// undo. Direction is `historical → current`, so `Insert` spans = "would
// be removed if you restore" and `Delete` spans = "would be brought back".

/// Modified block: live content differs from the historical version
/// produced by `historical_seq`. We must see at least one Delete + one
/// Insert span (the change between the two snapshots) and the
/// reconstructed live content (Equal + Insert spans) must equal the
/// current `blocks.content`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_spans_for_modified_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // create + edit + edit — three ops, three snapshots.
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "hello universe".into(),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "goodbye universe".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Pick the FIRST edit's seq as `historical_seq` so the diff is
    // "hello universe" → "goodbye universe" (current).
    let first_edit = sqlx::query!(
        "SELECT seq FROM op_log WHERE op_type = 'edit_block' ORDER BY seq ASC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let spans =
        compute_block_vs_current_diff_inner(&pool, created.id.as_str().to_string(), first_edit.seq)
            .await
            .unwrap();

    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().any(|s| s.tag == DiffTag::Delete),
        "modified block must have a Delete span (text removed since historical), got: {spans:?}"
    );
    assert!(
        spans.iter().any(|s| s.tag == DiffTag::Insert),
        "modified block must have an Insert span (text added since historical), got: {spans:?}"
    );

    // Reconstruct the `current` side (Equal + Insert spans) and confirm
    // it matches the live `blocks.content` — guards against the diff
    // direction silently flipping.
    let reconstructed: String = spans
        .iter()
        .filter(|s| s.tag != DiffTag::Delete)
        .map(|s| s.value.as_str())
        .collect();
    assert_eq!(reconstructed, "goodbye universe");
}

/// Unmodified block: the live content is byte-identical to the
/// historical version. The word-diff helper documents that identical
/// inputs collapse to all-Equal spans (or empty when both are ""), so
/// the response must contain zero Insert/Delete spans — what the UI
/// reads as "no changes since this version".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_no_spans_for_unmodified_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "stable text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    // No further edits — current matches the create_block payload.
    mat.flush_background().await.unwrap();

    let create_op = sqlx::query!(
        "SELECT seq FROM op_log WHERE op_type = 'create_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let spans =
        compute_block_vs_current_diff_inner(&pool, created.id.as_str().to_string(), create_op.seq)
            .await
            .unwrap();

    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().all(|s| s.tag == DiffTag::Equal),
        "unmodified block must produce only Equal spans, got: {spans:?}"
    );
}

/// Block deleted (soft-deleted) since `historical_seq`: the live row is
/// excluded by the `deleted_at IS NULL` filter. We surface this as a
/// `NotFound` error rather than fabricating an "all-removed" diff —
/// the UI's preview is meaningless for trashed blocks (the restore
/// flow there is "restore from trash", not "restore to historical
/// version") and the existing single-step `compute_edit_diff` remains
/// available as a fallback. This pins that contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_not_found_for_soft_deleted_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "to be trashed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    delete_block_inner(&pool, DEV, &mat, created.id.as_str().to_string())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let create_op = sqlx::query!(
        "SELECT seq FROM op_log WHERE op_type = 'create_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let result =
        compute_block_vs_current_diff_inner(&pool, created.id.as_str().to_string(), create_op.seq)
            .await;

    assert!(
        matches!(result, Err(AppError::NotFound(ref msg)) if msg.contains("soft-deleted")),
        "soft-deleted block must yield NotFound with a 'soft-deleted' diagnostic, got: {result:?}"
    );
}
