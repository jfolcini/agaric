#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use crate::draft;
use crate::op_log;
use crate::soft_delete;

// ======================================================================
// create_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_returns_correct_fields_and_persists() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
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

    assert_eq!(resp.block_type, "content", "block_type should match input");
    assert_eq!(
        resp.content,
        Some("hello world".into()),
        "content should match input"
    );
    assert!(resp.parent_id.is_none(), "top-level block has no parent");
    assert_eq!(resp.position, Some(1), "position should match input");
    assert!(resp.deleted_at.is_none(), "new block should not be deleted");

    // Verify persistence in DB via direct query
    let row = get_block_inner(&pool, resp.id.clone()).await.unwrap();
    assert_eq!(row.id, resp.id, "DB row should match response ID");
    assert_eq!(
        row.block_type, "content",
        "DB block_type should be persisted"
    );
    assert_eq!(
        row.content,
        Some("hello world".into()),
        "DB content should be persisted"
    );
    assert_eq!(row.position, Some(1), "DB position should be persisted");
    assert!(
        row.deleted_at.is_none(),
        "DB row should not be soft-deleted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_generates_valid_ulid() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.id.len(),
        26,
        "ULID should be 26 Crockford base32 characters"
    );
    assert!(
        resp.id.chars().all(|c| c.is_ascii_alphanumeric()),
        "ULID should only contain alphanumeric characters"
    );
    assert!(
        BlockId::from_string(&resp.id).is_ok(),
        "response ID should parse as a valid ULID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_parent_sets_parent_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    settle(&mat).await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(
        child.parent_id,
        Some(parent.id),
        "child.parent_id should match parent's ID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some("NONEXISTENT_PARENT".into()),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent parent"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for deleted parent"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_writes_op_to_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "logged".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'create_block'",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(count, 1, "exactly one create_block op should be logged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_invalid_block_type_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "invalid_type".into(),
        "hello".into(),
        None,
        None,
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error"
    );
    assert!(
        err.to_string().contains("unknown block_type"),
        "error message should mention unknown block_type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_all_valid_types_accepted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    for block_type in &["content", "tag", "page"] {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            block_type.to_string(),
            format!("test {block_type}"),
            None,
            None,
        )
        .await;

        assert!(resp.is_ok(), "block_type '{block_type}' should be accepted");
        assert_eq!(
            resp.unwrap().block_type,
            *block_type,
            "returned block_type should match"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_empty_content_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(&pool, DEV, &mat, "content".into(), "".into(), None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.content,
        Some("".into()),
        "empty content should be stored as-is"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_unicode_content_preserves_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let unicode_content = "Hello 世界! 🌍 Ñoño café résumé";
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        unicode_content.into(),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.content,
        Some(unicode_content.into()),
        "unicode content should be preserved exactly"
    );

    // Also verify round-trip through DB
    let row = get_block_inner(&pool, resp.id).await.unwrap();
    assert_eq!(
        row.content,
        Some(unicode_content.into()),
        "DB should preserve unicode content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_rejects_oversized_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
    let result =
        create_block_inner(&pool, DEV, &mat, "content".into(), oversized, None, None).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error for oversized content, got: {err:?}"
    );
    assert!(
        err.to_string().contains("exceeds maximum"),
        "error message should mention exceeds maximum"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_accepts_content_at_max_length() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
    let result = create_block_inner(&pool, DEV, &mat, "content".into(), at_limit, None, None).await;

    assert!(
        result.is_ok(),
        "content of exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
        result.unwrap_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_position_zero_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(0),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "position=0 should return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message should mention position must be positive"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_position_negative_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(-1),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "position=-1 should return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message should mention position must be positive"
    );
}

// ======================================================================
// edit_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_updates_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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

    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("updated".into()),
        "edited content should reflect new value"
    );

    // Verify in DB
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("updated".into()),
        "DB content should be updated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_sequential_edits_chain_prev_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // First edit
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
        .await
        .unwrap();

    // Second edit — should have prev_edit pointing to the first edit
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
        .await
        .unwrap();

    // Check the last op_log entry has prev_edit set
    let row = sqlx::query!(
        "SELECT payload FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
    assert!(
        !payload["prev_edit"].is_null(),
        "prev_edit should be set on second edit"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "soon deleted".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing a deleted block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_unicode_preserves_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let unicode = "日本語テスト 🎌 über";
    let edited = edit_block_inner(&pool, DEV, &mat, created.id, unicode.into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some(unicode.into()),
        "unicode content should survive edit round-trip"
    );
}

// ── edit_block edge cases ───────────────────────────────────────────

/// Editing a block to an empty string must succeed — empty content is
/// valid (e.g. a cleared paragraph before the user types new text).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_empty_to_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "non-empty".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("".into()),
        "editing to empty string must succeed and store empty content"
    );

    // Verify in DB
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("".into()),
        "empty string must be persisted in DB"
    );
}

/// Editing a block with the exact same content it already has must still
/// succeed (the command layer does not short-circuit on identical content).
/// An op_log entry IS written because the command doesn't diff content —
/// that's a valid design choice for idempotent replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_identical_content_is_noop() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "same text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Count ops before the "no-change" edit
    let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Edit with identical content
    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "same text".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("same text".into()),
        "content must be returned unchanged"
    );

    // The command layer does not diff — an op IS still written
    let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after,
        ops_before + 1,
        "an edit_block op is written even for identical content"
    );

    // Verify DB content is unchanged
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("same text".into()),
        "DB content should remain unchanged"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_rejects_oversized_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block to edit
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
    let result = edit_block_inner(&pool, DEV, &mat, created.id, oversized).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error for oversized content, got: {err:?}"
    );
    assert!(
        err.to_string().contains("exceeds maximum"),
        "error message should mention exceeds maximum"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_accepts_content_at_max_length() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
    let result = edit_block_inner(&pool, DEV, &mat, created.id, at_limit).await;

    assert!(
        result.is_ok(),
        "edit with exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
        result.unwrap_err()
    );
}

// ======================================================================
// delete_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_cascades_to_children() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    // Creating a page dispatches background materializer tasks (pages cache
    // rebuild, page_id updates). Wait for them to complete before adding a
    // child — otherwise the child's parent FK resolution can race with the
    // materializer's page-cache transaction and fail intermittently.
    settle(&mat).await;

    let _child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let resp = delete_block_inner(&pool, DEV, &mat, parent.id)
        .await
        .unwrap();

    assert_eq!(resp.descendants_affected, 2, "parent + child = 2 affected");
    assert!(
        !resp.deleted_at.is_empty(),
        "deleted_at timestamp should be set"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_already_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "delete me".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    let result = delete_block_inner(&pool, DEV, &mat, created.id).await;
    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "second delete should return InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = delete_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "deleting a nonexistent block should return NotFound"
    );
}

// ======================================================================
// restore_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_restores_block_and_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Use direct inserts for setup to avoid materializer write contention
    insert_block(&pool, "RST_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "RST_CHD",
        "content",
        "child",
        Some("RST_PAR"),
        Some(1),
    )
    .await;

    // Cascade soft-delete directly
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "RST_PAR")
        .await
        .unwrap();

    let rest_resp = restore_block_inner(&pool, DEV, &mat, "RST_PAR".into(), ts)
        .await
        .unwrap();

    assert_eq!(rest_resp.restored_count, 2, "parent + child restored");

    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "RST_PAR")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        row.deleted_at.is_none(),
        "parent should no longer be deleted after restore"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_not_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ALIVE01", "content", "alive", None, Some(1)).await;

    let result = restore_block_inner(&pool, DEV, &mat, "ALIVE01".into(), FIXED_TS.into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "restoring a non-deleted block should return InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = restore_block_inner(&pool, DEV, &mat, "GHOST".into(), FIXED_TS.into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring a nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_mismatched_deleted_at_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MISMATCH1", "content", "test", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "MISMATCH1")
        .await
        .unwrap();

    let wrong_ts = format!("{ts}_wrong");
    let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH1".into(), wrong_ts).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "mismatched deleted_at should return InvalidOperation"
    );
    assert!(
        err.to_string().contains("deleted_at mismatch"),
        "error message should mention mismatch"
    );
}

// ======================================================================
// purge_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_physically_removes_from_db() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE1", "content", "doomed", None, Some(1)).await;

    // Soft-delete first (purge requires prior soft-delete)
    soft_delete::cascade_soft_delete(&pool, "PURGE1")
        .await
        .unwrap();

    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE1".into())
        .await
        .unwrap();

    assert_eq!(
        resp.purged_count, 1,
        "single block should have purged_count=1"
    );

    let exists = sqlx::query!(r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ?"#, "PURGE1")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        exists.is_none(),
        "block should be physically gone after purge"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = purge_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "purging a nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_not_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE_ALIVE", "content", "alive", None, Some(1)).await;

    let result = purge_block_inner(&pool, DEV, &mat, "PURGE_ALIVE".into()).await;
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "purging a non-deleted block should return InvalidOperation"
    );
    assert!(
        err.to_string().contains("soft-deleted before purging"),
        "error message should explain the requirement"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_inner_cleans_page_aliases() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(
        &pool,
        "PURGE_PA_CMD",
        "page",
        "page with alias",
        None,
        Some(1),
    )
    .await;
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_PA_CMD")
        .bind("my-alias")
        .execute(&pool)
        .await
        .unwrap();

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_CMD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "alias should exist before purge");

    soft_delete::cascade_soft_delete(&pool, "PURGE_PA_CMD")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_PA_CMD".into())
        .await
        .unwrap();

    let alias_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_CMD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        alias_count, 0,
        "page_aliases should be cleaned after purge_block_inner"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_inner_cleans_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE_PAC_CMD", "content", "task", None, Some(1)).await;
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_PAC_CMD")
    .bind("2025-06-15")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_CMD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "projected_agenda_cache row should exist before purge"
    );

    soft_delete::cascade_soft_delete(&pool, "PURGE_PAC_CMD")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_PAC_CMD".into())
        .await
        .unwrap();

    let cache_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_CMD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cache_count, 0,
        "projected_agenda_cache should be cleaned after purge_block_inner"
    );
}

// ======================================================================
// list_blocks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_no_filters_returns_top_level() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TOP1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "TOP2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "CHILD1", "content", "c", Some("TOP1"), Some(1)).await;

    let resp = list_blocks_inner(
        &pool, None, None, None, None, None, None, None, None, None, None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "should only return top-level blocks (parent_id IS NULL)"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"TOP1"), "TOP1 should be in results");
    assert!(ids.contains(&"TOP2"), "TOP2 should be in results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_block_type_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE1", "page", "my page", None, Some(1)).await;
    insert_block(&pool, "TAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "CONT1", "content", "hello", None, Some(2)).await;

    let resp = list_blocks_inner(
        &pool,
        None,
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "should filter to page type only");
    assert_eq!(resp.items[0].id, "PAGE1", "only page block should match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_parent_id_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "CH1", "content", "child 1", Some("PAR"), Some(1)).await;
    insert_block(&pool, "CH2", "content", "child 2", Some("PAR"), Some(2)).await;
    insert_block(&pool, "OTHER", "content", "other", None, Some(2)).await;

    let resp = list_blocks_inner(
        &pool,
        Some("PAR".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2, "should return only children of PAR");
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"CH1"), "CH1 should be in children results");
    assert!(ids.contains(&"CH2"), "CH2 should be in children results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_tag_id_filter() {
    let (pool, _dir) = test_pool().await;

    // Create a tag and a content block, then associate them
    insert_block(&pool, "TAG_FILTER", "tag", "urgent", None, None).await;
    insert_block(&pool, "TAGGED_BLK", "content", "tagged item", None, Some(1)).await;
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("TAGGED_BLK")
        .bind("TAG_FILTER")
        .execute(&pool)
        .await
        .unwrap();

    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        Some("TAG_FILTER".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "should return blocks tagged with TAG_FILTER"
    );
    assert_eq!(
        resp.items[0].id, "TAGGED_BLK",
        "tagged block should be returned"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_show_deleted_returns_trash() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "ALIVE", "content", "alive", None, Some(1)).await;
    insert_block(&pool, "DEAD", "content", "dead", None, Some(2)).await;

    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DEAD'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some(true),
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "trash should contain only deleted blocks"
    );
    assert_eq!(
        resp.items[0].id, "DEAD",
        "only deleted block should appear in trash"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_rejects_conflicting_filters() {
    let (pool, _dir) = test_pool().await;

    // parent_id + block_type
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "parent_id + block_type should be rejected: {result:?}"
    );

    // tag_id + show_deleted
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        Some("T1".into()),
        Some(true),
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "tag_id + show_deleted should be rejected: {result:?}"
    );

    // parent_id + agenda_date
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        None,
        None,
        None,
        Some("2025-01-15".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "parent_id + agenda_date should be rejected: {result:?}"
    );

    // Three filters at once
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        Some("page".into()),
        Some("T1".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "three filters should be rejected: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_single_filter_is_accepted() {
    let (pool, _dir) = test_pool().await;

    // Each single filter should succeed (may return empty results — that's fine).
    assert!(
        list_blocks_inner(
            &pool,
            Some("P1".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None, // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "parent_id alone should be accepted"
    );
    assert!(
        list_blocks_inner(
            &pool,
            None,
            Some("page".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None, // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "block_type alone should be accepted"
    );
    assert!(
        list_blocks_inner(
            &pool,
            None,
            None,
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
            None, // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "show_deleted alone should be accepted"
    );
    // show_deleted=false should NOT count as a filter
    assert!(
        list_blocks_inner(
            &pool,
            None,
            Some("page".into()),
            None,
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None,
            None, // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "block_type + show_deleted=false should be accepted (false is not a filter)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_empty_db_returns_empty_page() {
    let (pool, _dir) = test_pool().await;

    let resp = list_blocks_inner(
        &pool, None, None, None, None, None, None, None, None, None, None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert!(
        resp.items.is_empty(),
        "empty DB should return empty items list"
    );
    assert!(
        resp.next_cursor.is_none(),
        "empty DB should have no next cursor"
    );
}

// ======================================================================
// get_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_single_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK001", "content", "hello", None, Some(1)).await;

    let block = get_block_inner(&pool, "BLK001".into()).await.unwrap();
    assert_eq!(block.id, "BLK001", "returned block ID should match");
    assert_eq!(block.block_type, "content", "block_type should be content");
    assert_eq!(
        block.content,
        Some("hello".into()),
        "content should match inserted value"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = get_block_inner(&pool, "NOPE".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_block on nonexistent ID should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_deleted_block_too() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "DELBLK", "content", "will be deleted", None, Some(1)).await;

    // Soft-delete the block
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DELBLK'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    // get_block should still return it (unlike list_blocks which excludes deleted)
    let block = get_block_inner(&pool, "DELBLK".into()).await.unwrap();
    assert_eq!(
        block.id, "DELBLK",
        "deleted block should still be retrievable"
    );
    assert_eq!(
        block.deleted_at,
        Some(FIXED_TS.into()),
        "get_block should return deleted_at for soft-deleted blocks"
    );
}

// ======================================================================
// move_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_basic_reparent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Setup: two parents and a child under parent A
    insert_block(&pool, "MV_PAR_A", "page", "parent A", None, Some(1)).await;
    insert_block(&pool, "MV_PAR_B", "page", "parent B", None, Some(2)).await;
    insert_block(
        &pool,
        "MV_CHILD",
        "content",
        "child",
        Some("MV_PAR_A"),
        Some(1),
    )
    .await;

    let resp = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_CHILD".into(),
        Some("MV_PAR_B".into()),
        5,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.block_id, "MV_CHILD",
        "block_id should match moved block"
    );
    assert_eq!(
        resp.new_parent_id,
        Some("MV_PAR_B".into()),
        "new_parent_id should be parent B"
    );
    assert_eq!(
        resp.new_position, 5,
        "new_position should match requested value"
    );

    // Verify DB state
    let row = sqlx::query!(
        "SELECT parent_id, position FROM blocks WHERE id = ?",
        "MV_CHILD"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.parent_id,
        Some("MV_PAR_B".into()),
        "parent_id should be updated in DB"
    );
    assert_eq!(row.position, Some(5), "position should be updated in DB");

    // Verify op_log entry
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'move_block'",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "exactly one move_block op should be logged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_root() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Setup: a parent and a child under it
    insert_block(&pool, "MV_ROOT_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "MV_ROOT_CHD",
        "content",
        "child",
        Some("MV_ROOT_PAR"),
        Some(1),
    )
    .await;

    // Move child to root (new_parent_id = None)
    let resp = move_block_inner(&pool, DEV, &mat, "MV_ROOT_CHD".into(), None, 10)
        .await
        .unwrap();

    assert_eq!(
        resp.block_id, "MV_ROOT_CHD",
        "block_id should match moved block"
    );
    assert!(
        resp.new_parent_id.is_none(),
        "new_parent_id should be None for root move"
    );
    assert_eq!(
        resp.new_position, 10,
        "new_position should match requested value"
    );

    // Verify DB state
    let row = sqlx::query!(
        "SELECT parent_id, position FROM blocks WHERE id = ?",
        "MV_ROOT_CHD"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        row.parent_id.is_none(),
        "parent_id should be NULL in DB after move to root"
    );
    assert_eq!(row.position, Some(10), "position should be updated in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = move_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_deleted_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_DEL", "content", "deleted block", None, Some(1)).await;

    // Soft-delete the block
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, "MV_DEL".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving a deleted block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_deleted_parent_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_BLK", "content", "block", None, Some(1)).await;
    insert_block(&pool, "MV_DEL_PAR", "page", "deleted parent", None, Some(2)).await;

    // Soft-delete the parent
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL_PAR'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_BLK".into(),
        Some("MV_DEL_PAR".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to a deleted parent should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_self_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_SELF", "content", "self ref", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_SELF".into(),
        Some("MV_SELF".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "block_id == new_parent_id should return InvalidOperation"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("cannot be its own parent"),
        "error message should explain the constraint"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_cycle_grandchild_to_grandparent_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build A→B→C hierarchy
    insert_block(&pool, "CYC_A", "page", "A", None, Some(1)).await;
    insert_block(&pool, "CYC_B", "content", "B", Some("CYC_A"), Some(1)).await;
    insert_block(&pool, "CYC_C", "content", "C", Some("CYC_B"), Some(1)).await;

    // Try moving A under C — should create cycle A→B→C→A
    let result = move_block_inner(&pool, DEV, &mat, "CYC_A".into(), Some("CYC_C".into()), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving A under its grandchild C should detect cycle, got: {result:?}"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("cycle detected"),
        "error message should mention cycle detection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_non_ancestor_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build A→B and separate C
    insert_block(&pool, "NC_A", "page", "A", None, Some(1)).await;
    insert_block(&pool, "NC_B", "content", "B", Some("NC_A"), Some(1)).await;
    insert_block(&pool, "NC_C", "page", "C", None, Some(2)).await;

    // Move B under C — no cycle, should succeed
    let resp = move_block_inner(&pool, DEV, &mat, "NC_B".into(), Some("NC_C".into()), 1)
        .await
        .unwrap();

    assert_eq!(
        resp.new_parent_id,
        Some("NC_C".into()),
        "block should be reparented to C"
    );
}

// ── #74: max nesting depth guard ─────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH levels: page→b1→b2→...→b20
    insert_block(&pool, "DEPTH_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "DEPTH_PAGE".to_string();
    for i in 1..=MAX_BLOCK_DEPTH {
        let id = format!("DEPTH_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Create a loose block to try nesting under the deepest
    insert_block(&pool, "DEPTH_EXTRA", "content", "extra", None, Some(99)).await;

    // Try moving the loose block under the deepest level — should fail
    let result = move_block_inner(&pool, DEV, &mat, "DEPTH_EXTRA".into(), Some(parent), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("nesting depth"),
        "error message should mention nesting depth"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_at_depth_limit_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH - 1 levels
    insert_block(&pool, "DLIM_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "DLIM_PAGE".to_string();
    for i in 1..MAX_BLOCK_DEPTH {
        let id = format!("DLIM_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Create a loose block and move under the (MAX_BLOCK_DEPTH - 1)th level — should succeed
    insert_block(&pool, "DLIM_OK", "content", "ok", None, Some(99)).await;

    let result = move_block_inner(&pool, DEV, &mat, "DLIM_OK".into(), Some(parent), 1).await;

    assert!(
        result.is_ok(),
        "moving to exactly MAX_BLOCK_DEPTH should succeed, got: {result:?}"
    );
}

// ── L-37: MAX_BLOCK_DEPTH enforced in create_block_in_tx ─────────────────
//
// `move_block_inner` already rejects moves that would push the subtree past
// the documented limit (ARCHITECTURE.md §20). L-37 closed the asymmetry on
// the create side: a user used to be able to repeatedly create blocks under
// the deepest leaf and drift past the bound. The recursive CTE inside
// `create_block_in_tx` now computes parent_depth and rejects when
// parent_depth + 1 > MAX_BLOCK_DEPTH.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_at_max_depth_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH - 1 levels under a page. The deepest
    // existing block is at depth (MAX_BLOCK_DEPTH - 1); creating one more
    // under it lands at exactly MAX_BLOCK_DEPTH = OK.
    insert_block(&pool, "CDLIM_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "CDLIM_PAGE".to_string();
    for i in 1..MAX_BLOCK_DEPTH {
        let id = format!("CDLIM_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "at-limit".into(),
        Some(parent),
        Some(1),
    )
    .await;

    assert!(
        result.is_ok(),
        "create at exactly MAX_BLOCK_DEPTH should succeed, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH levels: page→b1→...→b20. The deepest
    // existing block is at depth MAX_BLOCK_DEPTH; creating one more under it
    // would push the new block to depth MAX_BLOCK_DEPTH + 1 = rejected.
    insert_block(&pool, "CDOVER_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "CDOVER_PAGE".to_string();
    for i in 1..=MAX_BLOCK_DEPTH {
        let id = format!("CDOVER_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "over-limit".into(),
        Some(parent),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "creating beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("nesting depth"),
        "error message should mention nesting depth, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_at_root_with_no_parent_skips_depth_check() {
    // L-37 regression guard: when `parent_id = None`, the new depth check
    // must NOT fire — root-level page creation is unconstrained by the
    // depth limit (the page itself sits at depth 0).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "root-page".into(),
        None,
        Some(1),
    )
    .await;

    assert!(
        result.is_ok(),
        "creating a root-level block (no parent) must succeed regardless of depth, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_with_subtree_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a deep parent chain of 17 levels: page→d1→d2→...→d17
    insert_block(&pool, "SUB_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "SUB_PAGE".to_string();
    for i in 1..=17_i64 {
        let id = format!("SUB_P{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("parent {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Build a detached subtree: A→B→C→D (depth 3 below A)
    insert_block(&pool, "SUB_A", "content", "a", None, Some(90)).await;
    insert_block(&pool, "SUB_B", "content", "b", Some("SUB_A"), Some(1)).await;
    insert_block(&pool, "SUB_C", "content", "c", Some("SUB_B"), Some(1)).await;
    insert_block(&pool, "SUB_D", "content", "d", Some("SUB_C"), Some(1)).await;

    // Moving A under d17 means D ends up at depth 17+1+3 = 21 > 20
    let result = move_block_inner(&pool, DEV, &mat, "SUB_A".into(), Some(parent), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving subtree that would exceed depth limit should fail, got: {result:?}"
    );
}

// ======================================================================
// Attachment commands (F-7, F-11)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_creates_row() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block to attach to
    let block = create_block_inner(
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

    // M-29: file must exist on disk under app_data_dir before the row commits.
    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 1024];
    std::fs::write(app_data_dir.join("attachments/photo.png"), &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone(),
        "photo.png".into(),
        "image/png".into(),
        1024,
        "attachments/photo.png".into(),
    )
    .await
    .unwrap();

    assert_eq!(att.block_id, block.id, "attachment block_id should match");
    assert_eq!(
        att.filename, "photo.png",
        "attachment filename should match"
    );
    assert_eq!(
        att.mime_type, "image/png",
        "attachment mime_type should match"
    );
    assert_eq!(att.size_bytes, 1024, "attachment size should match");
    assert_eq!(
        att.fs_path, "attachments/photo.png",
        "attachment fs_path should match"
    );
    assert!(!att.id.is_empty(), "attachment should have a generated ID");
    assert!(!att.created_at.is_empty(), "created_at should be set");

    // Verify persistence in DB via direct query
    let db_row = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at \
         FROM attachments WHERE id = ?",
        att.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(db_row.id, att.id, "DB row id should match returned id");
    assert_eq!(db_row.block_id, block.id, "DB row block_id should match");
    assert_eq!(db_row.filename, "photo.png", "DB row filename should match");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_removes_row() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block and an attachment
    let block = create_block_inner(
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

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 2048];
    std::fs::write(app_data_dir.join("attachments/doc.pdf"), &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone(),
        "doc.pdf".into(),
        "application/pdf".into(),
        2048,
        "attachments/doc.pdf".into(),
    )
    .await
    .unwrap();

    // Delete it
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .unwrap();

    // Verify it's gone from the DB
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "attachment should be deleted from DB");

    // C-3b: file should be unlinked from disk too.
    assert!(
        !app_data_dir.join("attachments/doc.pdf").exists(),
        "attachment file should be removed from disk after delete_attachment_inner"
    );

    mat.shutdown();
}

/// C-3a/b happy path: `delete_attachment_inner` must (a) commit a
/// `DeleteAttachment` op-log entry whose `fs_path` matches the original
/// `add_attachment` fs_path, and (b) unlink the on-disk file under
/// `app_data_dir`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_unlinks_file_and_records_fs_path_in_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "with attachment".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 64];
    let rel_path = "attachments/c3b_happy.pdf";
    let full_path = app_data_dir.join(rel_path);
    std::fs::write(&full_path, &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone(),
        "c3b_happy.pdf".into(),
        "application/pdf".into(),
        64,
        rel_path.into(),
    )
    .await
    .unwrap();

    // Sanity: file is present before delete.
    assert!(
        full_path.exists(),
        "fixture file must be on disk before delete"
    );

    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .expect("delete_attachment_inner happy path must succeed");

    // (a) DB row gone.
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "attachment row must be deleted from DB");

    // (b) On-disk file gone.
    assert!(
        !full_path.exists(),
        "attachment file at {} must be unlinked",
        full_path.display()
    );

    // (c) Op log contains a `delete_attachment` whose payload carries the
    // expected `fs_path`. Walk the log directly so we check the persisted
    // shape (this is what remote peers and the C-3c GC pass will see).
    let ops = crate::op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    let del_op = ops
        .iter()
        .find(|o| o.op_type == "delete_attachment")
        .expect("op log must contain a delete_attachment entry");
    let parsed: crate::op::DeleteAttachmentPayload =
        serde_json::from_str(&del_op.payload).expect("delete_attachment payload must parse");
    assert_eq!(
        parsed.attachment_id, att.id,
        "op-log payload attachment_id must match"
    );
    assert_eq!(
        parsed.fs_path, rel_path,
        "C-3a: op-log payload fs_path must match the original add_attachment fs_path"
    );

    mat.shutdown();
}

/// C-3b: when the on-disk file has already been removed (e.g., the user
/// pruned the attachments directory by hand, or a previous failed delete
/// already unlinked it), `delete_attachment_inner` must still succeed —
/// the op-log entry is authoritative, the missing file is logged at info
/// level, and the row is removed from the DB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_succeeds_when_file_already_missing_on_disk() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ghost".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let rel_path = "attachments/c3b_ghost.pdf";
    let full_path = app_data_dir.join(rel_path);
    std::fs::write(&full_path, b"x").unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone(),
        "c3b_ghost.pdf".into(),
        "application/pdf".into(),
        1,
        rel_path.into(),
    )
    .await
    .unwrap();

    // Simulate the user (or a previous botched delete) removing the file
    // out from under us.
    std::fs::remove_file(&full_path).unwrap();
    assert!(
        !full_path.exists(),
        "precondition: file must be missing before delete"
    );

    // Must still succeed: missing file is non-fatal.
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .expect("delete must succeed even if the on-disk file is already gone");

    // DB row is gone.
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "DB row must be deleted");

    // Op log entry was still written.
    let ops = crate::op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(
        ops.iter().any(|o| o.op_type == "delete_attachment"),
        "op-log must contain a delete_attachment entry"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_validates_size_limit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block
    let block = create_block_inner(
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

    // Attempt to attach a file exceeding 50 MB
    let over_limit = MAX_ATTACHMENT_SIZE + 1;
    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        _dir.path(),
        block.id.clone(),
        "big.bin".into(),
        "application/zip".into(),
        over_limit,
        "attachments/big.bin".into(),
    )
    .await;

    assert!(result.is_err(), "should reject oversized attachment");
    match result.unwrap_err() {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("exceeds maximum"),
                "error should mention size limit: {msg}"
            );
        }
        other => panic!("expected Validation error, got: {other:?}"),
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_validates_mime_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
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

    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        _dir.path(),
        block.id.clone(),
        "virus.exe".into(),
        "application/x-msdownload".into(),
        1024,
        "attachments/virus.exe".into(),
    )
    .await;

    assert!(result.is_err(), "should reject disallowed MIME type");
    match result.unwrap_err() {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("not allowed"),
                "error should mention MIME not allowed: {msg}"
            );
        }
        other => panic!("expected Validation error, got: {other:?}"),
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_returns_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create two blocks
    let block_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block a".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let block_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block b".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    // Set up the on-disk attachment fixtures (M-29: stat-check inside tx).
    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    std::fs::write(app_data_dir.join("attachments/a1.png"), vec![0u8; 100]).unwrap();
    std::fs::write(app_data_dir.join("attachments/a2.pdf"), vec![0u8; 200]).unwrap();
    std::fs::write(app_data_dir.join("attachments/b1.txt"), vec![0u8; 50]).unwrap();

    // Add 2 attachments to block_a
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone(),
        "a1.png".into(),
        "image/png".into(),
        100,
        "attachments/a1.png".into(),
    )
    .await
    .unwrap();

    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone(),
        "a2.pdf".into(),
        "application/pdf".into(),
        200,
        "attachments/a2.pdf".into(),
    )
    .await
    .unwrap();

    // Add 1 attachment to block_b
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_b.id.clone(),
        "b1.txt".into(),
        "text/plain".into(),
        50,
        "attachments/b1.txt".into(),
    )
    .await
    .unwrap();

    // List for block_a — should get 2
    let list_a = list_attachments_inner(&pool, block_a.id.clone())
        .await
        .unwrap();
    assert_eq!(list_a.len(), 2, "block_a should have 2 attachments");
    assert_eq!(
        list_a[0].filename, "a1.png",
        "first attachment should be a1.png"
    );
    assert_eq!(
        list_a[1].filename, "a2.pdf",
        "second attachment should be a2.pdf"
    );

    // List for block_b — should get 1
    let list_b = list_attachments_inner(&pool, block_b.id.clone())
        .await
        .unwrap();
    assert_eq!(list_b.len(), 1, "block_b should have 1 attachment");
    assert_eq!(
        list_b[0].filename, "b1.txt",
        "block_b attachment should be b1.txt"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_returns_io_error_when_file_missing_on_disk() {
    // M-29: when the frontend's `@tauri-apps/plugin-fs` write fails or
    // races so the file is never actually persisted, `add_attachment`
    // must surface `AppError::Io` rather than committing a row that
    // points at a non-existent file (which would later trip the sync
    // layer's `MissingAttachment` path).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "missing fs".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Note: we deliberately do NOT create the file on disk.
    let app_data_dir = _dir.path();

    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone(),
        "ghost.png".into(),
        "image/png".into(),
        1024,
        "attachments/ghost.png".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Io(_))),
        "missing fs_path file must surface as AppError::Io, got: {result:?}"
    );

    // No row inserted — the IMMEDIATE tx rolled back on the metadata error.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "missing-file failure must not leave an attachment row"
    );

    mat.shutdown();
}

// ======================================================================
// Draft autosave commands (F-17)
// ======================================================================

#[tokio::test]
async fn save_and_flush_draft() {
    let (pool, _dir) = test_pool().await;

    // Save a draft
    draft::save_draft(&pool, "01HZ000000000000000000DRF01", "draft content")
        .await
        .unwrap();

    // Verify it persists
    let d = draft::get_draft(&pool, "01HZ000000000000000000DRF01")
        .await
        .unwrap()
        .expect("draft should exist after save");
    assert_eq!(
        d.content, "draft content",
        "saved draft content should match"
    );

    // Flush the draft (writes edit_block op + deletes draft row)
    flush_draft_inner(&pool, DEV, "01HZ000000000000000000DRF01".into())
        .await
        .unwrap();

    // Draft should be gone
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF01")
            .await
            .unwrap()
            .is_none(),
        "draft must be deleted after flush"
    );

    // An edit_block op should exist in the log
    let ops = crate::op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "flush must produce one op");
    assert_eq!(
        ops[0].op_type, "edit_block",
        "flushed op should be edit_block"
    );
}

#[tokio::test]
async fn delete_draft_removes_entry() {
    let (pool, _dir) = test_pool().await;

    // Save a draft
    draft::save_draft(&pool, "01HZ000000000000000000DRF02", "to be deleted")
        .await
        .unwrap();

    // Verify it exists
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF02")
            .await
            .unwrap()
            .is_some(),
        "draft should exist after save"
    );

    // Delete it
    draft::delete_draft(&pool, "01HZ000000000000000000DRF02")
        .await
        .unwrap();

    // Verify it's gone
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF02")
            .await
            .unwrap()
            .is_none(),
        "draft must be gone after delete"
    );
}

#[tokio::test]
async fn list_drafts_returns_all_drafts() {
    let (pool, _dir) = test_pool().await;

    // Start with no drafts
    let result = list_drafts_inner(&pool).await.unwrap();
    assert!(result.is_empty(), "should start with zero drafts");

    // Save two drafts
    draft::save_draft(&pool, "01HZ000000000000000000DRF03", "content one")
        .await
        .unwrap();
    draft::save_draft(&pool, "01HZ000000000000000000DRF04", "content two")
        .await
        .unwrap();

    let result = list_drafts_inner(&pool).await.unwrap();
    assert_eq!(result.len(), 2, "should return both drafts");
}

// ======================================================================
// Regression: move_block recursive CTEs must filter `is_conflict = 0`
// (AGENTS.md invariant #9). Conflict copies inherit `parent_id` from the
// original block and would otherwise be re-parented into a moved subtree
// or inflate the depth-check subtree count.
// ======================================================================

/// Insert a conflict-copy block directly with `is_conflict = 1` and an
/// optional `page_id` pin. Mirrors the shape produced by
/// `merge::resolve::create_conflict_copy`.
async fn insert_conflict_copy_with_page(
    pool: &SqlitePool,
    id: &str,
    parent_id: &str,
    page_id: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, page_id) \
         VALUES (?, 'content', 'conflict', ?, 999, 1, ?)",
    )
    .bind(id)
    .bind(parent_id)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_does_not_reparent_conflict_copy_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // OLD_PAGE contains BLK → REAL_CHILD (real). BLK also has a conflict copy
    // CF_DESC sitting as a descendant (parent_id = BLK, is_conflict = 1).
    insert_block(&pool, "CF_MV_OLD", "page", "old", None, Some(1)).await;
    insert_block(&pool, "CF_MV_NEW", "page", "new", None, Some(2)).await;
    insert_block(
        &pool,
        "CF_MV_BLK",
        "content",
        "blk",
        Some("CF_MV_OLD"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "CF_MV_RC",
        "content",
        "real-child",
        Some("CF_MV_BLK"),
        Some(1),
    )
    .await;

    // Pin page_id on the real rows (mirrors what the materializer would do).
    sqlx::query("UPDATE blocks SET page_id = 'CF_MV_OLD' WHERE id = 'CF_MV_OLD'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET page_id = 'CF_MV_NEW' WHERE id = 'CF_MV_NEW'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET page_id = 'CF_MV_OLD' WHERE id IN ('CF_MV_BLK', 'CF_MV_RC')")
        .execute(&pool)
        .await
        .unwrap();

    // Conflict copy rooted under the moved subtree — page_id pinned to OLD.
    insert_conflict_copy_with_page(&pool, "CF_MV_CC", "CF_MV_BLK", Some("CF_MV_OLD")).await;

    // Move BLK from OLD_PAGE to NEW_PAGE.
    move_block_inner(
        &pool,
        DEV,
        &mat,
        "CF_MV_BLK".into(),
        Some("CF_MV_NEW".into()),
        1,
    )
    .await
    .unwrap();

    // `move_block` dispatches `RebuildPageIds` as a background task (see
    // dispatch.rs `move_block` arm). The assertions below must reflect the
    // FINAL state after the rebuild has run — otherwise the test races the
    // background task and is non-deterministic. Flush the background queue
    // to wait for quiescence before reading.
    mat.flush_background().await.unwrap();

    // Real descendant follows BLK into NEW_PAGE.
    let rc_page: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'CF_MV_RC'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        rc_page,
        Some("CF_MV_NEW".into()),
        "real descendant's page_id must follow moved parent"
    );

    // Conflict copy's page_id must NOT be rewritten — the descendants CTE
    // in `move_block_inner` skips `is_conflict = 1` rows, AND the background
    // `rebuild_page_ids` CTE must also skip conflict copies (invariant #9).
    // Without the `is_conflict = 0` filter in `rebuild_page_ids_impl`, the
    // rebuild would walk CF_MV_CC → CF_MV_BLK → CF_MV_NEW and incorrectly
    // set CF_MV_CC.page_id = CF_MV_NEW.
    let cc_page: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'CF_MV_CC'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        cc_page,
        Some("CF_MV_OLD".into()),
        "conflict-copy descendant's page_id must NOT be rewritten by move_block \
         or the subsequent rebuild_page_ids background task"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_depth_check_ignores_conflict_copy_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a parent chain of depth MAX_BLOCK_DEPTH - 1 = 19 levels:
    // page→d01→d02→...→d19. Target: place a subtree under d19.
    insert_block(&pool, "CFD_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "CFD_PAGE".to_string();
    for i in 1..MAX_BLOCK_DEPTH {
        let id = format!("CFD_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }
    let deepest = parent; // CFD_19

    // The block we will move is a loose leaf; crucially, it has a CONFLICT
    // copy as a direct child. With the buggy CTE, the descendants walk would
    // count the conflict copy, making subtree_depth = 1 and the move
    // parent_depth(19) + 1 + subtree_depth(1) = 21 > MAX_BLOCK_DEPTH (20) →
    // false Validation error. With the fixed CTE (is_conflict = 0 filter),
    // subtree_depth = 0 and the move succeeds (19 + 1 + 0 = 20 <= 20).
    insert_block(&pool, "CFD_LEAF", "content", "leaf", None, Some(99)).await;
    insert_conflict_copy_with_page(&pool, "CFD_LEAF_CC", "CFD_LEAF", None).await;

    let result = move_block_inner(&pool, DEV, &mat, "CFD_LEAF".into(), Some(deepest), 1).await;
    assert!(
        result.is_ok(),
        "conflict-copy descendants must not count toward subtree depth; got: {result:?}"
    );
}
