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

    let resp = get_block_history_inner(&pool, created.id, None, None)
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
