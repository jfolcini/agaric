use super::common::*;
use crate::op_log;

// ======================================================================
// add_tag — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_associates_block_with_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

    let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "AT_BLK", "block_id must match");
    assert_eq!(resp.tag_id, "AT_TAG", "tag_id must match");

    // Verify block_tags row
    let row = sqlx::query_scalar!(
        "SELECT block_id FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "AT_BLK",
        "AT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_some(), "block_tags row must exist after add_tag");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATL_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATL_BLK".into(), "ATL_TAG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "add_tag", "op_type must be add_tag");
    assert!(
        ops[0].payload.contains("ATL_BLK"),
        "payload must contain block_id"
    );
    assert!(
        ops[0].payload.contains("ATL_TAG"),
        "payload must contain tag_id"
    );
}

// ======================================================================
// add_tag — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNB_TAG", "tag", "urgent", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "GHOST_BLK".into(), "ATNB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATDB_BLK", "content", "deleted", None, Some(1)).await;
    insert_block(&pool, "ATDB_TAG", "tag", "urgent", None, None).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'ATDB_BLK'")
        .execute(&pool)
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATDB_BLK".into(), "ATDB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_tag_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "GHOST_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding nonexistent tag must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_with_non_tag_block_type_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNTT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATNTT_CONT", "content", "not a tag", None, Some(2)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNTT_BLK".into(), "ATNTT_CONT".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "using content block as tag_id must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("expected 'tag'"),
        "error message must mention expected tag type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_duplicate_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATDUP_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATDUP_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATDUP_BLK".into(), "ATDUP_TAG".into())
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATDUP_BLK".into(), "ATDUP_TAG".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "duplicate add_tag must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("tag already applied"),
        "error message must mention tag already applied"
    );
}

// ======================================================================
// remove_tag — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_deletes_association() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "RT_BLK", "block_id must match");
    assert_eq!(resp.tag_id, "RT_TAG", "tag_id must match");

    // Verify association gone
    let row = sqlx::query_scalar!(
        "SELECT block_id FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "RT_BLK",
        "RT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "block_tags row must be gone after remove_tag"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTL_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RTL_BLK".into(), "RTL_TAG".into())
        .await
        .unwrap();

    remove_tag_inner(&pool, DEV, &mat, "RTL_BLK".into(), "RTL_TAG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(ops.len(), 2, "add_tag + remove_tag = 2 ops");
    assert_eq!(ops[1].op_type, "remove_tag", "second op must be remove_tag");
    assert!(
        ops[1].payload.contains("RTL_BLK"),
        "payload must contain block_id"
    );
}

// ======================================================================
// remove_tag — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = remove_tag_inner(&pool, DEV, &mat, "GHOST_BLK".into(), "GHOST_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing tag from nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTDB_BLK", "content", "deleted", None, Some(1)).await;
    insert_block(&pool, "RTDB_TAG", "tag", "urgent", None, None).await;
    // Add tag before deleting block
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("RTDB_BLK")
        .bind("RTDB_TAG")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'RTDB_BLK'")
        .execute(&pool)
        .await
        .unwrap();

    let result = remove_tag_inner(&pool, DEV, &mat, "RTDB_BLK".into(), "RTDB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing tag from deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_not_applied_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

    let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "removing unapplied tag must return AppError::NotFound"
    );
    assert!(
        err.to_string().contains("tag association"),
        "error message must mention tag association"
    );
}

// ======================================================================
// list_tags_for_block — happy paths & lifecycle
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_block_returns_both_tags_then_one_after_removal() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block and two tags
    insert_block(&pool, "LTFB_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "LTFB_TAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "LTFB_TAG2", "tag", "personal", None, None).await;

    // Add both tags
    add_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG1".into())
        .await
        .unwrap();
    add_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG2".into())
        .await
        .unwrap();

    // Verify both tags returned
    let tags = list_tags_for_block_inner(&pool, "LTFB_BLK".into())
        .await
        .unwrap();
    assert_eq!(tags.len(), 2, "block must have 2 tags after adding both");
    assert!(
        tags.contains(&"LTFB_TAG1".to_string()),
        "tag list must contain LTFB_TAG1"
    );
    assert!(
        tags.contains(&"LTFB_TAG2".to_string()),
        "tag list must contain LTFB_TAG2"
    );

    // Remove one tag
    remove_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG1".into())
        .await
        .unwrap();

    // Verify only one tag remains
    let tags_after = list_tags_for_block_inner(&pool, "LTFB_BLK".into())
        .await
        .unwrap();
    assert_eq!(tags_after.len(), 1, "block must have 1 tag after removal");
    assert_eq!(
        tags_after[0], "LTFB_TAG2",
        "remaining tag must be LTFB_TAG2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_block_no_tags_returns_empty() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LTFB_EMPTY", "content", "no tags", None, Some(1)).await;

    let tags = list_tags_for_block_inner(&pool, "LTFB_EMPTY".into())
        .await
        .unwrap();
    assert!(tags.is_empty(), "block with no tags must return empty vec");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_nonexistent_block_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let tags = list_tags_for_block_inner(&pool, "GHOST_LTFB_999".into())
        .await
        .unwrap();
    assert!(
        tags.is_empty(),
        "nonexistent block must return empty vec (no error)"
    );
}
