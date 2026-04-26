#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// add_tag
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

    let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "AT_BLK", "response block_id should match");
    assert_eq!(resp.tag_id, "AT_TAG", "response tag_id should match");

    // Verify block_tags row
    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "AT_BLK",
        "AT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_some(), "block_tags row should exist after add_tag");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_duplicate_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATD_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATD_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into())
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "adding same tag twice should return InvalidOperation"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("tag already applied"),
        "error message should mention tag already applied"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_block_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATN_TAG", "tag", "urgent", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "ATN_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_tag_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "NONEXISTENT".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding nonexistent tag should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_non_tag_block_type_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATNBT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATNBT_CONT", "content", "not a tag", None, Some(2)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNBT_BLK".into(), "ATNBT_CONT".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "using a content block as tag_id should return InvalidOperation"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("expected 'tag'"),
        "error message should mention expected tag type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_self_returns_invalid_operation() {
    // L-34 regression: a block cannot tag itself. The guard rejects the call
    // before any DB work, regardless of whether the block exists or its type.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "AT_SELF", "tag", "self", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "AT_SELF".into(), "AT_SELF".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "self-tagging should return InvalidOperation, got {result:?}"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("a block cannot tag itself"),
        "error message should mention self-tag guard, got {err}"
    );
}

// ======================================================================
// remove_tag
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "RT_BLK", "response block_id should match");
    assert_eq!(resp.tag_id, "RT_TAG", "response tag_id should match");

    // Verify block_tags is empty
    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "RT_BLK",
        "RT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "block_tags row should be gone after remove_tag"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_not_applied_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

    let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing a tag that was never applied should return NotFound"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("tag association"),
        "error message should mention tag association"
    );
}

// ======================================================================
// list_tags_by_prefix_inner
// ======================================================================

/// Helper: insert a tag_cache entry for command-level tests.
async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
    )
    .bind(tag_id)
    .bind(name)
    .bind(usage_count)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_returns_matching() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
    insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;
    insert_block(&pool, "TAG_P", "tag", "personal", None, None).await;

    insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
    insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
    insert_tag_cache(&pool, "TAG_P", "personal", 10).await;

    let result = list_tags_by_prefix_inner(&pool, "work/".into(), None)
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "should match both work/ tags");
    assert_eq!(
        result[0].name, "work/email",
        "first tag should be work/email"
    );
    assert_eq!(
        result[1].name, "work/meeting",
        "second tag should be work/meeting"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_empty_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let result = list_tags_by_prefix_inner(&pool, "nonexistent/".into(), None)
        .await
        .unwrap();

    assert!(
        result.is_empty(),
        "nonexistent prefix should return no tags"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_respects_limit() {
    let (pool, _dir) = test_pool().await;

    for i in 0..5 {
        insert_block(
            &pool,
            &format!("TAG_A{i}"),
            "tag",
            &format!("alpha{i}"),
            None,
            None,
        )
        .await;
        insert_tag_cache(&pool, &format!("TAG_A{i}"), &format!("alpha{i}"), 1).await;
    }

    let result = list_tags_by_prefix_inner(&pool, "alpha".into(), Some(2))
        .await
        .unwrap();
    assert_eq!(result.len(), 2, "limit=2 should return exactly 2 tags");
}
