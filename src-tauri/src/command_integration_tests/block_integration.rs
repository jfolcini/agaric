use super::common::*;
use crate::op_log;
use crate::soft_delete;
use std::collections::HashSet;

// ======================================================================
// create_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_content_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    assert_eq!(resp.block_type, "content", "block_type must be content");
    assert_eq!(
        resp.content,
        Some("hello world".into()),
        "content must match input"
    );
    assert!(resp.parent_id.is_none(), "top-level block has no parent");
    assert_eq!(resp.position, Some(1), "position must match input");
    assert!(resp.deleted_at.is_none(), "new block must not be deleted");
    assert_eq!(resp.id.len(), 26, "ULID must be 26 chars");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_tag_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(&pool, DEV, &mat, "tag".into(), "urgent".into(), None, None)
        .await
        .unwrap();

    assert_eq!(resp.block_type, "tag", "block_type must be tag");
    assert_eq!(resp.content, Some("urgent".into()), "content must match");
    assert_eq!(
        resp.position,
        Some(1),
        "auto-assigned position for first block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(10),
    )
    .await
    .unwrap();

    assert_eq!(resp.block_type, "page", "block_type must be page");
    assert_eq!(resp.content, Some("My Page".into()), "content must match");
    assert_eq!(resp.position, Some(10), "position must match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_parent_sets_parent_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
        "child.parent_id must match parent's ID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_position_preserves_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "positioned".into(),
        None,
        Some(42),
    )
    .await
    .unwrap();

    assert_eq!(
        resp.position,
        Some(42),
        "position must be preserved exactly"
    );

    // Verify in DB
    let row = get_block_inner(&pool, resp.id).await.unwrap();
    assert_eq!(row.position, Some(42), "position must be persisted in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_empty_content_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(&pool, DEV, &mat, "content".into(), "".into(), None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.content,
        Some("".into()),
        "empty content must be stored as-is"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_large_unicode_content_preserves_data() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Build ~100KB of unicode content
    let unit = "日本語テスト🌍Ñ ";
    let repeat = 100_000 / unit.len() + 1;
    let large_content: String = unit.repeat(repeat);
    assert!(
        large_content.len() >= 100_000,
        "test content must be at least 100KB"
    );

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        large_content.clone(),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.content,
        Some(large_content.clone()),
        "large unicode content must be preserved in response"
    );

    // Round-trip through DB
    let row = get_block_inner(&pool, resp.id).await.unwrap();
    assert_eq!(
        row.content,
        Some(large_content),
        "large unicode content must survive DB round-trip"
    );
}

// ======================================================================
// create_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_invalid_block_type_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "invalid_type".into(),
        "text".into(),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid block_type must return AppError::Validation"
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("unknown block_type"),
        "error message must mention unknown block_type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some("NONEXISTENT_PARENT_000".into()),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent parent must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

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
        "deleted parent must return AppError::NotFound"
    );
}

// ======================================================================
// create_block — concurrency & op_log
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_multiple_blocks_rapidly_all_get_unique_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let mut ids = HashSet::new();
    for i in 0..20 {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await
        .unwrap();
        ids.insert(resp.id);
    }

    assert_eq!(
        ids.len(),
        20,
        "all 20 rapid creates must produce unique IDs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
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

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op should be logged after create");
    assert_eq!(ops[0].seq, 1, "first op should have seq=1");
    assert_eq!(
        ops[0].op_type, "create_block",
        "op_type must be create_block"
    );
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains(&resp.id),
        "payload must contain the block ID"
    );
}

// ======================================================================
// edit_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_updates_content_and_returns_new_value() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
        "edit must return new content"
    );
    assert_eq!(edited.id, created.id, "ID must not change on edit");
    assert_eq!(
        edited.block_type, "content",
        "block_type must not change on edit"
    );

    // Verify in DB
    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        row.content,
        Some("updated".into()),
        "DB must reflect updated content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_unicode_content_preserved() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let unicode = "日本語テスト 🎌 über café résumé Ñoño";
    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), unicode.into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some(unicode.into()),
        "unicode content must survive edit round-trip"
    );

    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        row.content,
        Some(unicode.into()),
        "unicode must survive DB round-trip"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_empty_string_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("".into()),
        "edit to empty string must succeed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_sequential_edits_chain_prev_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
    settle(&mat).await;

    // Second edit — should chain prev_edit
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
        .await
        .unwrap();

    // Inspect the last edit_block op_log entry
    let row = sqlx::query!(
        "SELECT payload FROM op_log WHERE op_type = 'edit_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
    assert!(
        !payload["prev_edit"].is_null(),
        "second edit must have prev_edit set in op_log payload"
    );
}

// ======================================================================
// edit_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT_BLK".into(), "text".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "will delete".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing a deleted block must return AppError::NotFound"
    );
}

// ======================================================================
// delete_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_marks_as_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let del = delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    assert!(
        !del.deleted_at.is_empty(),
        "deleted_at timestamp must be set"
    );
    assert_eq!(del.block_id, created.id, "block_id must match");

    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert!(
        row.deleted_at.is_some(),
        "block must be marked as deleted in DB"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_cascades_to_children() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let del = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();

    assert_eq!(
        del.descendants_affected, 2,
        "parent + child = 2 descendants affected"
    );

    let child_row = get_block_inner(&pool, child.id).await.unwrap();
    assert!(
        child_row.deleted_at.is_some(),
        "child must be cascade-deleted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_blocks_excluded_from_list_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "alive".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
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

    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();

    let live = list_blocks_inner(
        &pool, None, None, None, None, None, None, None, None, None, None,
    )
    .await
    .unwrap();

    assert_eq!(live.items.len(), 1, "only alive blocks in normal list");
    assert_eq!(live.items[0].id, b1.id, "surviving block must be b1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_blocks_visible_in_list_blocks_show_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "alive".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
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

    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();

    let trash = list_blocks_inner(
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
    )
    .await
    .unwrap();

    assert_eq!(trash.items.len(), 1, "only deleted blocks in trash view");
    assert_eq!(trash.items[0].id, b2.id, "deleted block must be b2");

    // alive block must NOT appear in trash
    let trash_ids: Vec<&str> = trash.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        !trash_ids.contains(&b1.id.as_str()),
        "alive block must not appear in trash"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "log-delete".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block
    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "create + delete = 2 ops");
    assert_eq!(
        ops[1].op_type, "delete_block",
        "op_type must be delete_block"
    );
    assert_eq!(ops[1].device_id, DEV, "device_id must match");
    assert!(
        ops[1].payload.contains(&created.id),
        "payload must contain the block ID"
    );
}

// ======================================================================
// delete_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = delete_block_inner(&pool, DEV, &mat, "GHOST_BLK_999".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "deleting nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_already_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "delete twice".into(),
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
        "double-delete must return AppError::InvalidOperation"
    );
}

// ======================================================================
// restore_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_clears_deleted_at() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "REST01", "content", "restore me", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "REST01")
        .await
        .unwrap();

    let resp = restore_block_inner(&pool, DEV, &mat, "REST01".into(), ts)
        .await
        .unwrap();

    assert_eq!(resp.block_id, "REST01", "block_id must match");
    assert_eq!(
        resp.restored_count, 1,
        "single block restore should return count 1"
    );

    let row = get_block_inner(&pool, "REST01".into()).await.unwrap();
    assert!(
        row.deleted_at.is_none(),
        "deleted_at must be cleared after restore"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_cascades_to_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RPAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "RCHD", "content", "child", Some("RPAR"), Some(1)).await;
    insert_block(
        &pool,
        "RGCH",
        "content",
        "grandchild",
        Some("RCHD"),
        Some(1),
    )
    .await;

    let (ts, count) = soft_delete::cascade_soft_delete(&pool, "RPAR")
        .await
        .unwrap();
    assert_eq!(count, 3, "cascade must delete parent + child + grandchild");

    let resp = restore_block_inner(&pool, DEV, &mat, "RPAR".into(), ts)
        .await
        .unwrap();

    assert_eq!(resp.restored_count, 3, "all 3 descendants must be restored");

    for id in &["RPAR", "RCHD", "RGCH"] {
        let row = get_block_inner(&pool, id.to_string()).await.unwrap();
        assert!(
            row.deleted_at.is_none(),
            "block {id} must have deleted_at cleared after restore"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "REST_LOG", "content", "restore-log", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "REST_LOG")
        .await
        .unwrap();

    restore_block_inner(&pool, DEV, &mat, "REST_LOG".into(), ts)
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(
        ops[0].op_type, "restore_block",
        "op_type must be restore_block"
    );
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains("REST_LOG"),
        "payload must contain block_id"
    );
}

// ======================================================================
// restore_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = restore_block_inner(
        &pool,
        DEV,
        &mat,
        "GHOST_REST".into(),
        "2025-01-01T00:00:00Z".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_non_deleted_block_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ALIVE01", "content", "alive", None, Some(1)).await;

    let result = restore_block_inner(
        &pool,
        DEV,
        &mat,
        "ALIVE01".into(),
        "2025-01-01T00:00:00Z".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "restoring non-deleted block must return AppError::InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_with_wrong_deleted_at_ref_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MISMATCH01", "content", "test", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "MISMATCH01")
        .await
        .unwrap();

    let wrong_ts = format!("{ts}_WRONG");
    let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH01".into(), wrong_ts).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "mismatched deleted_at must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("deleted_at mismatch"),
        "error message must mention mismatch"
    );
}

// ======================================================================
// purge_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_removes_from_db() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE01", "content", "doomed", None, Some(1)).await;
    soft_delete::cascade_soft_delete(&pool, "PURGE01")
        .await
        .unwrap();

    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE01".into())
        .await
        .unwrap();

    assert_eq!(resp.purged_count, 1, "one block must be purged");
    assert_eq!(resp.block_id, "PURGE01", "block_id must match");

    let exists = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", "PURGE01")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        exists.is_none(),
        "block must be physically removed from DB after purge"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_removes_tags_properties_attachments_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block and tag
    insert_block(
        &pool,
        "PURGE_REL",
        "content",
        "has relations",
        None,
        Some(1),
    )
    .await;
    insert_block(&pool, "PURGE_TAG", "tag", "my-tag", None, None).await;
    insert_block(&pool, "PURGE_TGT", "content", "link target", None, Some(2)).await;
    // Ancestor holding a direct tag so that block_tag_inherited is populated
    // for PURGE_REL (inherited_from = PURGE_REL itself is fine too).
    insert_block(&pool, "PURGE_ANC", "page", "ancestor page", None, Some(3)).await;

    // Add related rows covering every table purge_block_inner cleans.
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("PURGE_TAG")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
    )
    .bind("PURGE_REL")
    .bind("PURGE_TAG")
    .bind("PURGE_ANC")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind("PURGE_REL")
        .bind("priority")
        .bind("high")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATT-PURGE-001")
    .bind("PURGE_REL")
    .bind("text/plain")
    .bind("readme.txt")
    .bind(256_i64)
    .bind("attachments/readme.txt")
    .bind("2024-01-01T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("PURGE_TGT")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2024-12-25")
        .bind("PURGE_REL")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    // tags_cache is keyed by tag_id — insert a row keyed on PURGE_REL so it
    // is in the subtree being purged. (The cleanup DELETEs rows whose tag_id
    // appears in the descendant set.)
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind("PURGE_REL")
    .bind("purge-rel-tag")
    .bind(1_i64)
    .bind("2024-01-01T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();
    // pages_cache is keyed by page_id — insert row referencing the purged block
    // (pages_cache normally only holds pages but the purge cleanup keys off the
    // subtree's block_id, so insert directly to verify cleanup).
    sqlx::query("INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, ?)")
        .bind("PURGE_REL")
        .bind("has relations")
        .bind("2024-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("PURGE_REL")
        .bind("draft content")
        .bind("2024-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("has relations")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("Has Relations")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_REL")
    .bind("2024-12-26")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    // Soft-delete then purge
    soft_delete::cascade_soft_delete(&pool, "PURGE_REL")
        .await
        .unwrap();
    purge_block_inner(&pool, DEV, &mat, "PURGE_REL".into())
        .await
        .unwrap();

    // Verify all 13 tables that purge_block_inner DELETEs from are cleaned.
    // Order matches the DELETE order in commands/blocks/crud.rs::purge_block_inner.
    // Use the non-macro `query_scalar` form so we don't have to add every new
    // variation to the sqlx offline cache.
    let tags: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? OR tag_id = ?")
            .bind("PURGE_REL")
            .bind("PURGE_REL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(tags, 0, "block_tags must be purged");

    let inherited: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_inherited WHERE block_id = ?")
            .bind("PURGE_REL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(inherited, 0, "block_tag_inherited must be purged");

    let props: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(props, 0, "block_properties must be purged");

    let links: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_links WHERE source_id = ? OR target_id = ?")
            .bind("PURGE_REL")
            .bind("PURGE_REL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(links, 0, "block_links must be purged");

    let agenda: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(agenda, 0, "agenda_cache must be purged");

    // tags_cache was keyed by PURGE_REL (in the subtree). Verify the row is gone.
    let tcache: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tcache, 0, "tags_cache must be purged");

    let pcache: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pcache, 0, "pages_cache must be purged");

    let atts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(atts, 0, "attachments must be purged");

    let drafts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_drafts WHERE block_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(drafts, 0, "block_drafts must be purged");

    let fts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fts, 0, "fts_blocks must be purged");

    let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = ?")
        .bind("PURGE_REL")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(aliases, 0, "page_aliases must be purged");

    let projected: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = ?")
            .bind("PURGE_REL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(projected, 0, "projected_agenda_cache must be purged");

    // blocks (the root of the subtree) must be physically removed.
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
        .bind("PURGE_REL")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(exists.is_none(), "blocks row must be purged");
}

// BUG-46 regression: `purge_block_inner` previously only cleaned
// `block_tag_inherited` rows whose `block_id` or `inherited_from` columns
// pointed into the descendant set, leaving rows whose `tag_id` column
// referenced the purged tag — which violates the FK when the tag row is
// then removed. Reuse the PURGE_* fixture style: leave PURGE_TAG
// soft-deleted on its own, seed a `block_tag_inherited` row keyed on
// PURGE_TAG (with alive block/ancestor), and confirm the single-block
// purge commits cleanly and wipes those orphan rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_inner_succeeds_when_tag_still_inherited_by_alive_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Alive page + alive child + alive tag (standalone). Only the tag
    // gets soft-deleted.
    insert_block(
        &pool,
        "PURGE_TAG_ANC",
        "page",
        "alive ancestor",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "PURGE_TAG_BLK",
        "content",
        "alive inheriting block",
        Some("PURGE_TAG_ANC"),
        Some(1),
    )
    .await;
    insert_block(&pool, "PURGE_TAG", "tag", "purge-tag", None, None).await;

    // Materialized inheritance row: alive block inherits PURGE_TAG from
    // the alive ancestor — `tag_id` is the only column that references
    // PURGE_TAG.
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
    )
    .bind("PURGE_TAG_BLK")
    .bind("PURGE_TAG")
    .bind("PURGE_TAG_ANC")
    .execute(&pool)
    .await
    .unwrap();

    // Soft-delete only the tag.
    let (_ts, cnt) = soft_delete::cascade_soft_delete(&pool, "PURGE_TAG")
        .await
        .unwrap();
    assert_eq!(cnt, 1, "only the tag should be soft-deleted");

    // Purge just the tag. Before the fix this hit FK error 787 because
    // the inheritance row above still referenced PURGE_TAG.tag_id while
    // the CTE-driven DELETE only matched block_id / inherited_from.
    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE_TAG".into())
        .await
        .unwrap();
    assert_eq!(resp.purged_count, 1, "only the tag must be purged");
    assert_eq!(resp.block_id, "PURGE_TAG");

    // Alive blocks remain.
    let anc = get_block_inner(&pool, "PURGE_TAG_ANC".into())
        .await
        .unwrap();
    assert!(anc.deleted_at.is_none(), "PURGE_TAG_ANC must remain alive");
    let blk = get_block_inner(&pool, "PURGE_TAG_BLK".into())
        .await
        .unwrap();
    assert!(blk.deleted_at.is_none(), "PURGE_TAG_BLK must remain alive");

    // Zero rows reference PURGE_TAG in any column of block_tag_inherited.
    let refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited \
         WHERE block_id = ? OR tag_id = ? OR inherited_from = ?",
    )
    .bind("PURGE_TAG")
    .bind("PURGE_TAG")
    .bind("PURGE_TAG")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        refs, 0,
        "no block_tag_inherited row may reference the purged tag in any column"
    );

    // The tag's blocks row is physically gone.
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
        .bind("PURGE_TAG")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(exists.is_none(), "PURGE_TAG blocks row must be purged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE_LOG", "content", "purge-log", None, Some(1)).await;
    soft_delete::cascade_soft_delete(&pool, "PURGE_LOG")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_LOG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "purge_block", "op_type must be purge_block");
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains("PURGE_LOG"),
        "payload must contain block_id"
    );
}

// ======================================================================
// purge_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = purge_block_inner(&pool, DEV, &mat, "GHOST_PURGE".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "purging nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_non_deleted_block_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE_ALIVE", "content", "alive", None, Some(1)).await;

    let result = purge_block_inner(&pool, DEV, &mat, "PURGE_ALIVE".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "purging non-deleted block must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("soft-deleted before purging"),
        "error message must explain the requirement"
    );
}

// ======================================================================
// list_blocks — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_top_level_returns_root_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "ROOT1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "ROOT2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "CHILD1", "content", "c", Some("ROOT1"), Some(1)).await;

    let resp = list_blocks_inner(
        &pool, None, None, None, None, None, None, None, None, None, None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "must only return top-level blocks (parent_id IS NULL)"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"ROOT1"), "ROOT1 must be in results");
    assert!(ids.contains(&"ROOT2"), "ROOT2 must be in results");
    assert!(
        !ids.contains(&"CHILD1"),
        "CHILD1 must not be in top-level results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_parent_id_returns_children_only() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LP01", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "LC01", "content", "child 1", Some("LP01"), Some(1)).await;
    insert_block(&pool, "LC02", "content", "child 2", Some("LP01"), Some(2)).await;
    insert_block(&pool, "LOTHER", "content", "other", None, Some(2)).await;

    let resp = list_blocks_inner(
        &pool,
        Some("LP01".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2, "must return only children of LP01");
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"LC01"), "LC01 must be in children");
    assert!(ids.contains(&"LC02"), "LC02 must be in children");
    assert!(
        !ids.contains(&"LOTHER"),
        "LOTHER must not be in children of LP01"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_block_type_filter_returns_matching_type() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LPAGE1", "page", "my page", None, Some(1)).await;
    insert_block(&pool, "LTAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "LCONT1", "content", "hello", None, Some(2)).await;

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
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "must return only page type blocks");
    assert_eq!(resp.items[0].id, "LPAGE1", "page block must be LPAGE1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_empty_db_returns_empty_page_no_more() {
    let (pool, _dir) = test_pool().await;

    let resp = list_blocks_inner(
        &pool, None, None, None, None, None, None, None, None, None, None,
    )
    .await
    .unwrap();

    assert!(resp.items.is_empty(), "empty DB must return empty items");
    assert!(!resp.has_more, "empty DB must have has_more=false");
    assert!(
        resp.next_cursor.is_none(),
        "empty DB must have no next_cursor"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_show_deleted_returns_only_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LD_ALIVE", "content", "alive", None, Some(1)).await;
    insert_block(&pool, "LD_DEAD1", "content", "dead1", None, Some(2)).await;
    insert_block(&pool, "LD_DEAD2", "content", "dead2", None, Some(3)).await;

    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-15T00:00:00+00:00' WHERE id = 'LD_DEAD1'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-16T00:00:00+00:00' WHERE id = 'LD_DEAD2'")
        .execute(&pool)
        .await
        .unwrap();

    let trash = list_blocks_inner(
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
    )
    .await
    .unwrap();

    assert_eq!(
        trash.items.len(),
        2,
        "trash must contain only 2 deleted blocks"
    );
    let ids: Vec<&str> = trash.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"LD_DEAD1"), "LD_DEAD1 must be in trash");
    assert!(ids.contains(&"LD_DEAD2"), "LD_DEAD2 must be in trash");
    assert!(
        !ids.contains(&"LD_ALIVE"),
        "alive block must not appear in trash"
    );
}

// ======================================================================
// list_blocks — pagination
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_walk_all_pages_no_duplicates() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 15 blocks
    for i in 0..15 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await
        .unwrap();
    }

    let mut all_ids = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let page = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            cursor,
            Some(4),
        )
        .await
        .unwrap();
        for item in &page.items {
            all_ids.push(item.id.clone());
        }
        pages += 1;
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }

    assert_eq!(all_ids.len(), 15, "must collect all 15 blocks across pages");
    assert_eq!(pages, 4, "15 blocks with limit 4 must produce 4 pages");

    let unique: HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(
        unique.len(),
        15,
        "no duplicate blocks across paginated pages"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_limit_1_produces_single_item_pages() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PG1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "PG2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "PG3", "content", "c", None, Some(3)).await;

    let mut cursor: Option<String> = None;
    let mut all_ids = Vec::new();
    let mut pages = 0;

    loop {
        let page = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            cursor,
            Some(1),
        )
        .await
        .unwrap();
        assert!(
            page.items.len() <= 1,
            "limit=1 must produce at most 1 item per page"
        );
        for item in &page.items {
            all_ids.push(item.id.clone());
        }
        pages += 1;
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }

    assert_eq!(all_ids.len(), 3, "must collect all 3 blocks");
    assert_eq!(pages, 3, "limit=1 with 3 items must produce 3 pages");
}

// ======================================================================
// get_block — happy & error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_full_row() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "GET01", "page", "my page", None, Some(5)).await;

    let row = get_block_inner(&pool, "GET01".into()).await.unwrap();

    assert_eq!(row.id, "GET01", "id must match");
    assert_eq!(row.block_type, "page", "block_type must match");
    assert_eq!(row.content, Some("my page".into()), "content must match");
    assert!(row.parent_id.is_none(), "parent_id must be None");
    assert_eq!(row.position, Some(5), "position must match");
    assert!(row.deleted_at.is_none(), "deleted_at must be None");
    assert!(!row.is_conflict, "is_conflict must be false");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = get_block_inner(&pool, "NOPE_BLK_999".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_block on nonexistent ID must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "GET_DEL", "content", "was alive", None, Some(1)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'GET_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let row = get_block_inner(&pool, "GET_DEL".into()).await.unwrap();

    assert_eq!(row.id, "GET_DEL", "must return the deleted block");
    assert!(
        row.deleted_at.is_some(),
        "deleted_at must be present on deleted block"
    );
}

// ======================================================================
// move_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_reparents_and_updates_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    assert_eq!(resp.block_id, "MV_CHILD", "block_id must match");
    assert_eq!(
        resp.new_parent_id,
        Some("MV_PAR_B".into()),
        "new parent must be MV_PAR_B"
    );
    assert_eq!(resp.new_position, 5, "position must match");

    // Verify DB state
    let row = get_block_inner(&pool, "MV_CHILD".into()).await.unwrap();
    assert_eq!(row.parent_id, Some("MV_PAR_B".into()), "parent_id in DB");
    assert_eq!(row.position, Some(5), "position in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_root_clears_parent() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV2_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "MV2_CHD",
        "content",
        "child",
        Some("MV2_PAR"),
        Some(1),
    )
    .await;

    let resp = move_block_inner(&pool, DEV, &mat, "MV2_CHD".into(), None, 10)
        .await
        .unwrap();

    assert!(
        resp.new_parent_id.is_none(),
        "root move must have None parent"
    );
    assert_eq!(resp.new_position, 10, "position must match");

    let row = get_block_inner(&pool, "MV2_CHD".into()).await.unwrap();
    assert!(
        row.parent_id.is_none(),
        "parent_id must be NULL after root move"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_LOG", "content", "block", None, Some(1)).await;

    move_block_inner(&pool, DEV, &mat, "MV_LOG".into(), None, 3)
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "move_block", "op_type must be move_block");
    assert!(
        ops[0].payload.contains("MV_LOG"),
        "payload must contain block_id"
    );
}

// ======================================================================
// move_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = move_block_inner(&pool, DEV, &mat, "GHOST_MV".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_DEL", "content", "deleted", None, Some(1)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'MV_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, "MV_DEL".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_self_parent_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_SELF", "content", "self", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_SELF".into(),
        Some("MV_SELF".into()),
        1,
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "self-parent must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("cannot be its own parent"),
        "error message must mention self-parent constraint"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_NP", "content", "block", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_NP".into(),
        Some("GHOST_PARENT".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to nonexistent parent must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_DP_BLK", "content", "block", None, Some(1)).await;
    insert_block(&pool, "MV_DP_PAR", "page", "deleted parent", None, Some(2)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'MV_DP_PAR'")
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_DP_BLK".into(),
        Some("MV_DP_PAR".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to deleted parent must return AppError::NotFound"
    );
}
