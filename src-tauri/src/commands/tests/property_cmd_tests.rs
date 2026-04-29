#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use crate::op_log;
use chrono::Datelike;

// ======================================================================
// set_property / delete_property / get_properties
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_creates_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block to attach the property to
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prop test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set a text property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Verify via get_properties
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(props.len(), 1, "should have exactly one property");
    assert_eq!(
        props[0].key, "importance",
        "property key should be 'importance'"
    );
    assert_eq!(
        props[0].value_text,
        Some("high".into()),
        "property value_text should be 'high'"
    );
    assert!(
        props[0].value_num.is_none(),
        "value_num should be None for text property"
    );
    assert!(
        props[0].value_date.is_none(),
        "value_date should be None for text property"
    );
    assert!(
        props[0].value_ref.is_none(),
        "value_ref should be None for text property"
    );

    // TEST-42: verify op_log row was written with op_type='set_property'
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'importance'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "set_property should have written exactly one op_log row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_validates_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
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

    mat.flush_background().await.unwrap();

    // Empty key should fail validation
    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "".into(),
        Some("val".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty key should return Validation error, got: {result:?}"
    );
}

// ----------------------------------------------------------------------
// L-122: caller_context message wording
//
// `set_property_inner`'s last parameter, `caller_context`, augments the
// exactly-one-value validation error so the MCP boundary can name the
// tool without duplicating the count check. `None` falls through to
// `set_property_in_tx`'s `validate_set_property` (existing message);
// `Some(name)` produces a message that includes the caller name *and*
// every `value_*` field name.
// ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_inner_with_none_caller_context_uses_legacy_message() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ctx test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Two value fields populated → must reject with the legacy
    // `validate_set_property` wording (no tool name).
    let err = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "assignee".into(),
        Some("alice".into()),
        Some(3.0),
        None,
        None,
        None,
    )
    .await
    .expect_err("two value fields must be rejected");
    let msg = err.to_string();
    assert!(
        matches!(err, AppError::Validation(_)),
        "expected Validation, got: {err:?}"
    );
    assert!(
        msg.contains("found 2"),
        "legacy wording should still mention 'found 2', got: {msg}",
    );
    assert!(
        !msg.contains("tool '"),
        "None caller_context must NOT name a tool, got: {msg}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_inner_with_some_caller_context_names_caller() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ctx test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Two value fields populated, caller names itself → message must
    // include the caller name AND every value_* field name so the
    // agent-facing error stays descriptive.
    let err = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "assignee".into(),
        Some("alice".into()),
        Some(3.0),
        None,
        None,
        Some("set_property"),
    )
    .await
    .expect_err("two value fields must be rejected");
    let msg = err.to_string();
    assert!(
        matches!(err, AppError::Validation(_)),
        "expected Validation, got: {err:?}"
    );
    for needle in [
        "set_property",
        "value_text",
        "value_num",
        "value_date",
        "value_ref",
        "got 2",
    ] {
        assert!(
            msg.contains(needle),
            "Some(caller_context) message must contain '{needle}', got: {msg}",
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_inner_with_some_caller_context_rejects_zero_values() {
    // The MCP precheck used to reject zero-value calls outright. With
    // `Some(_)` caller_context that behaviour now lives inside
    // `set_property_inner`. Verify zero values still error and the
    // message names the caller.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ctx test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let err = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "assignee".into(),
        None,
        None,
        None,
        None,
        Some("set_property"),
    )
    .await
    .expect_err("zero value fields must be rejected when caller_context is Some");
    let msg = err.to_string();
    assert!(
        matches!(err, AppError::Validation(_)),
        "expected Validation, got: {err:?}"
    );
    assert!(
        msg.contains("set_property") && msg.contains("got 0"),
        "Some(caller_context) zero-value message must name the caller and 'got 0', got: {msg}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_on_deleted_block_fails() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
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

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "key".into(),
        Some("val".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "setting property on deleted block should return NotFound, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_removes_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
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

    mat.flush_background().await.unwrap();

    // Set a property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Delete the property
    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    // Verify it's gone
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        props.is_empty(),
        "properties should be empty after delete, got: {props:?}"
    );

    // TEST-42: verify op_log row was written with op_type='delete_property'
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'delete_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'status'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "delete_property should have written exactly one op_log row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_allows_builtin_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set a system-managed built-in property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "created_at".into(),
        None,
        None,
        Some("2026-01-01".into()),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Deleting a built-in property should now succeed
    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "created_at".into())
        .await
        .unwrap();

    // Verify it's gone
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        !props.iter().any(|p| p.key == "created_at"),
        "created_at should be deleted, got: {props:?}"
    );

    // Deleting a user-settable property like "effort" should work
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "effort".into(),
        Some("2h".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "effort".into())
        .await
        .unwrap();

    // Deleting a custom property should still work
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "my_custom".into(),
        Some("val".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "my_custom".into())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_clears_reserved_column_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date (a reserved column key)
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-06-01".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify it's set
    let b = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(b.due_date.as_deref(), Some("2026-06-01"));

    // Delete the reserved property via delete_property_inner
    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "due_date".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify the column is NULLed
    let b = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        b.due_date.is_none(),
        "due_date should be NULL after delete, got: {:?}",
        b.due_date
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_properties_returns_empty_for_new_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "no props".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        props.is_empty(),
        "new block should have no properties, got: {props:?}"
    );
}

// ─── get_batch_properties tests ──────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_properties_returns_all_for_multiple_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 3 blocks
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block one".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block two".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block three".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set properties on blocks 1 and 2
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Batch-fetch for all 3
    let result =
        get_batch_properties_inner(&pool, vec![b1.id.clone(), b2.id.clone(), b3.id.clone()])
            .await
            .unwrap();

    // b1 and b2 should have properties, b3 should be omitted
    assert!(result.contains_key(&b1.id), "b1 must be in result");
    assert!(result.contains_key(&b2.id), "b2 must be in result");
    assert_eq!(result[&b1.id].len(), 1, "b1 should have one property");
    assert_eq!(
        result[&b1.id][0].key, "importance",
        "b1 property key should be 'importance'"
    );
    assert_eq!(result[&b2.id].len(), 1, "b2 should have one property");
    assert_eq!(
        result[&b2.id][0].key, "status",
        "b2 property key should be 'status'"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_properties_empty_ids_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let result = get_batch_properties_inner(&pool, vec![]).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_ids list must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_properties_omits_blocks_without_properties() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with no properties
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "no props".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    assert!(
        !result.contains_key(&block.id),
        "block with no properties must be omitted from result, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_properties_returns_multiple_props_per_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "multi-prop".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set 3 different properties
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "score".into(),
        None,
        Some(42.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    assert!(result.contains_key(&block.id), "block must be in result");
    let props = &result[&block.id];
    assert_eq!(props.len(), 3, "must return all 3 properties");

    let keys: Vec<&str> = props.iter().map(|p| p.key.as_str()).collect();
    assert!(keys.contains(&"importance"), "must contain importance");
    assert!(keys.contains(&"status"), "must contain status");
    assert!(keys.contains(&"score"), "must contain score");
}

// ─── batch_resolve tests ─────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_returns_all_requested_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR01", "content", "First block", None, Some(0)).await;
    insert_block(&pool, "BR02", "page", "My Page", None, Some(1)).await;
    insert_block(&pool, "BR03", "tag", "work", None, Some(2)).await;
    // FEAT-3 Phase 7 — `batch_resolve_inner` filters by space via
    // `COALESCE(b.page_id, b.id) IN (block_properties WHERE key='space' …)`.
    // Each block needs a space row for the filter to keep it in scope.
    assign_to_test_space(&pool, "BR01").await;
    assign_to_test_space(&pool, "BR02").await;
    assign_to_test_space(&pool, "BR03").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR01".into(), "BR02".into(), "BR03".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 3, "must return all 3 blocks");

    let r1 = result.iter().find(|r| r.id == "BR01").unwrap();
    assert_eq!(
        r1.title.as_deref(),
        Some("First block"),
        "r1 title should match content"
    );
    assert_eq!(r1.block_type, "content", "r1 block_type should be content");
    assert!(!r1.deleted, "r1 should not be deleted");

    let r2 = result.iter().find(|r| r.id == "BR02").unwrap();
    assert_eq!(
        r2.title.as_deref(),
        Some("My Page"),
        "r2 title should match content"
    );
    assert_eq!(r2.block_type, "page", "r2 block_type should be page");
    assert!(!r2.deleted, "r2 should not be deleted");

    let r3 = result.iter().find(|r| r.id == "BR03").unwrap();
    assert_eq!(
        r3.title.as_deref(),
        Some("work"),
        "r3 title should match content"
    );
    assert_eq!(r3.block_type, "tag", "r3 block_type should be tag");
    assert!(!r3.deleted, "r3 should not be deleted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_empty_ids_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let result = batch_resolve_inner(&pool, vec![], Some(TEST_SPACE_ID.to_string())).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty ids list must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_includes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR_DEL", "content", "deleted block", None, Some(0)).await;
    assign_to_test_space(&pool, "BR_DEL").await;
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(FIXED_TS)
        .bind("BR_DEL")
        .execute(&pool)
        .await
        .unwrap();

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_DEL".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 1, "should return the deleted block");
    assert!(result[0].deleted, "deleted blocks must have deleted=true");
    assert_eq!(
        result[0].title.as_deref(),
        Some("deleted block"),
        "title should still be accessible"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_omits_nonexistent_ids() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR_EXISTS", "content", "exists", None, Some(0)).await;
    assign_to_test_space(&pool, "BR_EXISTS").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_EXISTS".into(), "BR_MISSING".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 1, "nonexistent IDs must be silently omitted");
    assert_eq!(
        result[0].id, "BR_EXISTS",
        "existing block should be returned"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_null_content_returns_none_title() {
    let (pool, _dir) = test_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, NULL, NULL, 0)",
    )
    .bind("BR_NULL")
    .bind("content")
    .execute(&pool)
    .await
    .unwrap();
    assign_to_test_space(&pool, "BR_NULL").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_NULL".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(
        result.len(),
        1,
        "null-content block should still be resolved"
    );
    assert!(result[0].title.is_none(), "NULL content → None title");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_single_id() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR_SINGLE", "page", "Solo Page", None, Some(0)).await;
    assign_to_test_space(&pool, "BR_SINGLE").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_SINGLE".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 1, "single ID should return one result");
    assert_eq!(result[0].id, "BR_SINGLE", "resolved block ID should match");
    assert_eq!(
        result[0].title.as_deref(),
        Some("Solo Page"),
        "resolved title should match content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_duplicate_ids_deduped_by_db() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR_DUP", "content", "Dup block", None, Some(0)).await;
    assign_to_test_space(&pool, "BR_DUP").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_DUP".into(), "BR_DUP".into(), "BR_DUP".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    // json_each produces 3 rows for 3 values, but the IN subquery
    // matches only the one block row — result depends on DB behavior.
    // With json_each + IN, duplicates in the value list may produce
    // duplicate matches. We assert at least 1 result.
    assert!(
        !result.is_empty(),
        "duplicate IDs must still return the block"
    );
    assert!(
        result.iter().all(|r| r.id == "BR_DUP"),
        "all results must be the same block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_mixed_block_types() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BR_PAGE", "page", "Page Title", None, Some(0)).await;
    insert_block(&pool, "BR_TAG", "tag", "my-tag", None, Some(1)).await;
    insert_block(
        &pool,
        "BR_CONTENT",
        "content",
        "Some text",
        Some("BR_PAGE"),
        Some(0),
    )
    .await;
    // Page + tag both need explicit space rows because COALESCE(page_id, id) = id.
    // Content block resolves via its parent page row's space property when
    // page_id is set; here we set page_id = "BR_PAGE" via UPDATE (insert_block
    // does not populate page_id), so giving BR_PAGE a space row is sufficient
    // for BR_CONTENT — but we assign explicitly to keep the test obvious.
    sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
        .bind("BR_PAGE")
        .bind("BR_CONTENT")
        .execute(&pool)
        .await
        .unwrap();
    assign_to_test_space(&pool, "BR_PAGE").await;
    assign_to_test_space(&pool, "BR_TAG").await;

    let result = batch_resolve_inner(
        &pool,
        vec!["BR_PAGE".into(), "BR_TAG".into(), "BR_CONTENT".into()],
        Some(TEST_SPACE_ID.to_string()),
    )
    .await
    .unwrap();

    assert_eq!(
        result.len(),
        3,
        "all three mixed-type blocks should be resolved"
    );
    let types: Vec<&str> = result.iter().map(|r| r.block_type.as_str()).collect();
    assert!(types.contains(&"page"), "result should include page type");
    assert!(types.contains(&"tag"), "result should include tag type");
    assert!(
        types.contains(&"content"),
        "result should include content type"
    );
}

// ======================================================================
// set_todo_state / set_priority / set_due_date
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_sets_value() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "todo test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    assert_eq!(
        result.todo_state,
        Some("TODO".into()),
        "returned block should have TODO state"
    );

    // Verify DB column
    let db_val: Option<String> = sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        db_val,
        Some("TODO".into()),
        "DB column should persist TODO state"
    );

    // TEST-42: verify op_log row was written with op_type='set_property' for the todo_state key
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'todo_state'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "set_todo_state should have written exactly one set_property op_log row for the todo_state key"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_clears_value() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "clear test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set then clear
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), None)
        .await
        .unwrap();

    assert_eq!(
        result.todo_state, None,
        "todo_state should be cleared to None"
    );

    // Verify DB column is NULL
    let db_val: Option<String> = sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(db_val.is_none(), "DB column should be NULL after clearing");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_rejects_too_long_string() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "too long test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let long_state = "A".repeat(51);
    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some(long_state)).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "state over 50 chars should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_rejects_empty_string() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "empty test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("".into())).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty state should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_accepts_custom_keyword_cancelled() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "custom keyword test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // BUG-20: Backend validates todo_state against the property_definitions
    // options. To accept a custom keyword like CANCELLED, the user must
    // first extend the options list for the todo_state definition.
    update_property_def_options_inner(
        &pool,
        "todo_state".into(),
        r#"["TODO","DOING","DONE","CANCELLED"]"#.into(),
    )
    .await
    .unwrap();

    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("CANCELLED".into()))
        .await
        .unwrap();

    assert_eq!(
        result.todo_state.as_deref(),
        Some("CANCELLED"),
        "todo_state should be CANCELLED after options update"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        "nonexistent-id".into(),
        Some("TODO".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_priority_sets_and_clears() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prio test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set priority
    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into()))
        .await
        .unwrap();
    assert_eq!(
        result.priority,
        Some("2".into()),
        "priority should be set to 2"
    );

    mat.flush_background().await.unwrap();

    // Clear priority
    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), None)
        .await
        .unwrap();
    assert_eq!(result.priority, None, "priority should be cleared to None");

    // TEST-42: verify op_log rows were written with op_type='set_property' for the priority key
    // (one for the set, one for the clear)
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'priority'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 2,
        "set_priority should have written one set_property op_log row per call (set + clear)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_priority_invalid_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "inv prio".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("5".into())).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid priority should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_sets_and_clears() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "date test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set due date
    let result = set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-04-15".into()),
    )
    .await
    .unwrap();
    assert_eq!(
        result.due_date,
        Some("2026-04-15".into()),
        "due_date should be set to 2026-04-15"
    );

    mat.flush_background().await.unwrap();

    // Clear due date
    let result = set_due_date_inner(&pool, DEV, &mat, block.id.clone(), None)
        .await
        .unwrap();
    assert_eq!(result.due_date, None, "due_date should be cleared to None");

    // TEST-42: verify op_log rows were written with op_type='set_property' for the due_date key
    // (one for the set, one for the clear)
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'due_date'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 2,
        "set_due_date should have written one set_property op_log row per call (set + clear)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_invalid_format_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "inv date".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("not-a-date".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid date should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_routes_reserved_key_to_blocks_column() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "reserved routing".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Use set_property_inner directly with reserved key
    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "todo_state".into(),
        Some("DONE".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.todo_state,
        Some("DONE".into()),
        "todo_state should be DONE"
    );

    // Verify blocks.todo_state column updated
    let db_val: Option<String> = sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        db_val,
        Some("DONE".into()),
        "DB column should persist DONE state"
    );

    // Verify block_properties does NOT have a row for it
    let prop_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        prop_count, 0,
        "reserved key should not be in block_properties"
    );

    mat.shutdown();
}

// ======================================================================
// set_property — date format / reserved key / property_definitions type
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_invalid_date_format() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "date val test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "my_date".into(),
        None,
        None,
        Some("not-a-date".into()),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("Invalid date format")),
        "invalid date string should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_out_of_range_date() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "date range test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "my_date".into(),
        None,
        None,
        Some("2025-13-45".into()),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("Invalid date format")),
        "out-of-range date should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_due_date_with_value_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "reserved field test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        Some("2025-01-01".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("requires value_date")),
        "due_date with value_text should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_todo_state_with_value_date() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "reserved field test 2".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "todo_state".into(),
        None,
        None,
        Some("2025-01-01".into()),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("requires value_text")),
        "todo_state with value_date should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_accepts_valid_reserved_key_with_correct_field() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "reserved accept test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some("2025-01-15".into()),
        None,
        None,
    )
    .await;

    assert!(
        result.is_ok(),
        "due_date with valid value_date should succeed, got: {result:?}"
    );

    let block = result.unwrap();
    assert_eq!(
        block.due_date,
        Some("2025-01-15".into()),
        "due_date should match the set value"
    );

    mat.shutdown();
}

// ======================================================================
// ref value_type — property definitions & set_property (#H-6)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_property_def_ref_type_succeeds() {
    let (pool, _dir) = test_pool().await;

    let def = create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();

    assert_eq!(def.key, "reviewer", "property def key should be reviewer");
    assert_eq!(
        def.value_type, "ref",
        "property def value_type should be ref"
    );
    assert!(def.options.is_none(), "ref type should have no options");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_property_def_ref_type_rejects_options() {
    let (pool, _dir) = test_pool().await;

    let result = create_property_def_inner(
        &pool,
        "reviewer".into(),
        "ref".into(),
        Some(r#"["a","b"]"#.into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("options are only allowed for select")),
        "ref with options should return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_ref_type_enforces_value_ref() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a ref-type definition
    create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();

    // Create a block
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ref type test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Setting value_text on a ref-type property should fail
    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "reviewer".into(),
        Some("wrong".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("expects type")),
        "ref def with value_text should fail type check, got: {result:?}"
    );

    // Setting value_ref should succeed
    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "target page".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "reviewer".into(),
        None,
        None,
        None,
        Some(target.id.clone()),
        None,
    )
    .await;

    assert!(
        result.is_ok(),
        "ref def with value_ref should succeed, got: {result:?}"
    );

    mat.shutdown();
}

// ======================================================================
// set_priority / set_due_date — nonexistent block returns NotFound
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_priority_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result =
        set_priority_inner(&pool, DEV, &mat, "nonexistent-id".into(), Some("1".into())).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = set_due_date_inner(
        &pool,
        DEV,
        &mat,
        "nonexistent-id".into(),
        Some("2026-05-15".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

// ======================================================================
// Deleted block returns NotFound for all three thin commands
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "will delete".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result =
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into())).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "set_todo_state on deleted block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_priority_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "will delete".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into())).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "set_priority on deleted block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "will delete".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-05-15".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "set_due_date on deleted block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

// ======================================================================
// Op log verification for thin commands
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "op log test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    // null→TODO now also sets created_at, so we expect 2 set_property ops
    assert_eq!(
        set_prop_ops.len(),
        2,
        "two set_property ops should be logged (todo_state + created_at)"
    );
    assert!(
        set_prop_ops[0].payload.contains("\"todo_state\""),
        "first op payload must contain key 'todo_state'"
    );
    assert!(
        set_prop_ops[1].payload.contains("\"created_at\""),
        "second op payload must contain key 'created_at'"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_priority_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "op log test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("1".into()))
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    assert_eq!(
        set_prop_ops.len(),
        1,
        "exactly one set_property op should be logged"
    );
    assert!(
        set_prop_ops[0].payload.contains("\"priority\""),
        "op payload must contain key 'priority'"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "op log test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-05-15".into()),
    )
    .await
    .unwrap();

    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
    assert_eq!(
        set_prop_ops.len(),
        1,
        "exactly one set_property op should be logged"
    );
    assert!(
        set_prop_ops[0].payload.contains("\"due_date\""),
        "op payload must contain key 'due_date'"
    );

    mat.shutdown();
}

// ====================================================================
// set_scheduled_date tests (#592)
// ====================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_scheduled_date_sets_and_clears() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "sched test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set scheduled date
    let result = set_scheduled_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-06-01".into()),
    )
    .await
    .unwrap();
    assert_eq!(
        result.scheduled_date,
        Some("2026-06-01".into()),
        "scheduled_date should be set"
    );

    mat.flush_background().await.unwrap();

    // Clear scheduled date
    let result = set_scheduled_date_inner(&pool, DEV, &mat, block.id.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        result.scheduled_date, None,
        "scheduled_date should be cleared to None"
    );

    // TEST-42: verify op_log rows were written with op_type='set_property' for the scheduled_date key
    // (one for the set, one for the clear)
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' \
         AND json_extract(payload, '$.block_id') = ? \
         AND json_extract(payload, '$.key') = 'scheduled_date'",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 2,
        "set_scheduled_date should have written one set_property op_log row per call (set + clear)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_scheduled_date_invalid_format_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bad sched".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    let result = set_scheduled_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("not-a-date".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid date should return Validation error, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_scheduled_date_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = set_scheduled_date_inner(
        &pool,
        DEV,
        &mat,
        "nonexistent-id".into(),
        Some("2026-05-15".into()),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "set_scheduled_date on nonexistent block should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_agenda_cache_includes_scheduled_date_entries() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "agenda sched".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Set scheduled_date
    set_scheduled_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-07-20".into()),
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // Rebuild agenda cache
    crate::cache::rebuild_agenda_cache(&pool).await.unwrap();

    // Check that the agenda cache contains the entry
    let row = sqlx::query!(
        "SELECT source FROM agenda_cache WHERE block_id = ? AND date = '2026-07-20'",
        block.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();

    assert!(
        row.is_some(),
        "agenda_cache should have the scheduled_date entry"
    );
    assert_eq!(
        row.unwrap().source,
        "column:scheduled_date",
        "cache source should be column:scheduled_date"
    );

    mat.shutdown();
}

// ====================================================================
// todo_state_auto_timestamp tests (#593)
// ====================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_state_auto_null_to_todo_sets_created_at() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "auto ts test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // null → TODO
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    // Check created_at property was set
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let created_at = props.iter().find(|p| p.key == "created_at");
    assert!(
        created_at.is_some(),
        "created_at should be set on null→TODO transition"
    );
    assert!(
        created_at.unwrap().value_date.is_some(),
        "created_at should have a value_date"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_state_auto_todo_to_done_sets_completed_at() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "done test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // null → TODO
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    // TODO → DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    // Check completed_at property was set
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let completed_at = props.iter().find(|p| p.key == "completed_at");
    assert!(
        completed_at.is_some(),
        "completed_at should be set on TODO→DONE transition"
    );
    assert!(
        completed_at.unwrap().value_date.is_some(),
        "completed_at should have a value_date"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_state_auto_done_to_todo_sets_created_at_clears_completed_at() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "reopen test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // null → TODO → DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // DONE → TODO
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();

    // created_at should be set (refreshed)
    let created_at = props.iter().find(|p| p.key == "created_at");
    assert!(
        created_at.is_some(),
        "created_at should be set on DONE→TODO transition"
    );

    // completed_at should be cleared
    let completed_at = props.iter().find(|p| p.key == "completed_at");
    assert!(
        completed_at.is_none(),
        "completed_at should be cleared on DONE→TODO transition"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_state_auto_todo_to_null_clears_both_timestamps() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "untask test".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    // null → TODO
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify created_at exists
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        props.iter().any(|p| p.key == "created_at"),
        "created_at should exist after null→TODO"
    );

    // TODO → null (un-tasking)
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), None)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Both should be cleared
    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    let created_at = props.iter().find(|p| p.key == "created_at");
    let completed_at = props.iter().find(|p| p.key == "completed_at");
    assert!(
        created_at.is_none(),
        "created_at should be cleared on TODO→null transition"
    );
    assert!(
        completed_at.is_none(),
        "completed_at should be cleared on TODO→null transition"
    );

    mat.shutdown();
}

// ====================================================================
// Recurrence on DONE transition tests (#595)
// ====================================================================

/// Helper: set a repeat property on a block via block_properties table.
async fn set_repeat_property(
    pool: &SqlitePool,
    device_id: &str,
    mat: &Materializer,
    block_id: &str,
    rule: &str,
) {
    set_property_inner(
        pool,
        device_id,
        mat,
        block_id.to_string(),
        "repeat".to_string(),
        Some(rule.to_string()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_daily_creates_next_occurrence() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create block, set TODO, set due_date, set repeat=daily
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "daily task".into(),
        None,
        None,
    )
    .await
    .unwrap();

    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Original block should be DONE
    let original = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(
        original.todo_state.as_deref(),
        Some("DONE"),
        "original block should be marked DONE"
    );

    // Find the new sibling block (any block with todo_state=TODO that isn't original)
    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(new_blocks.len(), 1, "should create exactly one new block");
    let new_block = &new_blocks[0];

    assert_eq!(
        new_block.todo_state.as_deref(),
        Some("TODO"),
        "new block should have TODO state"
    );
    assert_eq!(
        new_block.content.as_deref(),
        Some("daily task"),
        "new block should copy original content"
    );
    assert_eq!(
        new_block.due_date.as_deref(),
        Some("2025-06-16"),
        "new block due_date should advance by one day"
    );

    // Check repeat property was copied
    let props = get_properties_inner(&pool, new_block.id.clone())
        .await
        .unwrap();
    let repeat_prop = props.iter().find(|p| p.key == "repeat");
    assert!(
        repeat_prop.is_some(),
        "new block should have repeat property"
    );
    assert_eq!(
        repeat_prop.unwrap().value_text.as_deref(),
        Some("daily"),
        "repeat property should be copied as daily"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_weekly_shifts_by_7_days() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "weekly task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "weekly").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find new block
    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(new_blocks.len(), 1, "should create one recurrence block");
    assert_eq!(
        new_blocks[0].due_date.as_deref(),
        Some("2025-06-22"),
        "weekly recurrence should advance by 7 days"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_monthly_handles_month_end() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "monthly task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Jan 31 → monthly should clamp to Feb 28 (2025 is not a leap year)
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-01-31".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "monthly").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        new_blocks.len(),
        1,
        "monthly recurrence should create one block"
    );
    assert_eq!(
        new_blocks[0].due_date.as_deref(),
        Some("2025-02-28"),
        "Jan 31 + monthly should clamp to Feb 28"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_custom_plus_3d() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "every 3 days".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-28".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "+3d").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        new_blocks.len(),
        1,
        "multi-day recurrence should create one block"
    );
    assert_eq!(
        new_blocks[0].due_date.as_deref(),
        Some("2025-07-01"),
        "+3d from Jun 28 should be Jul 1"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_no_repeat_property_does_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "no repeat".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // No repeat property set — transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Should NOT create any new TODO blocks
    let todo_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        todo_count, 0,
        "no new block should be created without repeat property"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_set_todo_state_recurrence_is_atomic() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with TODO + repeat rule
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "atomic recurrence test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Transition to DONE — should atomically create the recurring block
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find the new sibling block
    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(new_blocks.len(), 1, "should create exactly one new block");
    let new_block = &new_blocks[0];

    // Verify the new block has both todo_state=TODO and repeat property set
    assert_eq!(
        new_block.todo_state.as_deref(),
        Some("TODO"),
        "recurrence block should have TODO state"
    );
    assert_eq!(
        new_block.content.as_deref(),
        Some("atomic recurrence test"),
        "recurrence block should copy content"
    );

    let props = get_properties_inner(&pool, new_block.id.clone())
        .await
        .unwrap();
    let repeat_prop = props.iter().find(|p| p.key == "repeat");
    assert!(
        repeat_prop.is_some(),
        "new block should have repeat property"
    );
    assert_eq!(
        repeat_prop.unwrap().value_text.as_deref(),
        Some("daily"),
        "repeat property should be daily"
    );

    mat.shutdown();
}

// ======================================================================
// Recurrence end conditions (#644)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_stops_when_repeat_until_is_reached() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with TODO + due_date + repeat + repeat-until
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "until task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date to 2025-06-14 (shifting daily → 2025-06-15)
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-14".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-until to 2025-06-14 — shifted date (2025-06-15) > until
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "repeat-until".to_string(),
        None,
        None,
        Some("2025-06-14".to_string()),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Should NOT create any new TODO blocks
    let todo_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        todo_count, 0,
        "no new block should be created when shifted date exceeds repeat-until"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_stops_when_repeat_count_is_exhausted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with TODO + repeat + repeat-count=2, repeat-seq=2
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "count task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count=2
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "repeat-count".to_string(),
        None,
        Some(2.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat-seq=2 (already at the limit)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "repeat-seq".to_string(),
        None,
        Some(2.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Should NOT create any new TODO blocks
    let todo_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        todo_count, 0,
        "no new block should be created when repeat-seq >= repeat-count"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_continues_when_repeat_count_not_exhausted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with TODO + repeat + repeat-count=3, repeat-seq=1
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "count task ok".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count=3
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "repeat-count".to_string(),
        None,
        Some(3.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat-seq=1 (still under the limit)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "repeat-seq".to_string(),
        None,
        Some(1.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Should create a new TODO block
    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(new_blocks.len(), 1, "should create one new block");

    // Check that repeat-seq was incremented to 2
    let props = get_properties_inner(&pool, new_blocks[0].id.clone())
        .await
        .unwrap();
    let seq_prop = props.iter().find(|p| p.key == "repeat-seq");
    assert!(seq_prop.is_some(), "new block should have repeat-seq");
    assert_eq!(
        seq_prop.unwrap().value_num,
        Some(2.0),
        "repeat-seq should be incremented to 2"
    );

    // Check that repeat-count was copied
    let count_prop = props.iter().find(|p| p.key == "repeat-count");
    assert!(count_prop.is_some(), "new block should have repeat-count");
    assert_eq!(
        count_prop.unwrap().value_num,
        Some(3.0),
        "repeat-count should remain 3"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_sets_repeat_origin_on_sibling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "origin task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Transition to DONE — creates sibling
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find the new sibling
    let new_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        block.id
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(new_blocks.len(), 1, "should create one recurrence sibling");
    let sibling = &new_blocks[0];

    // Check repeat-origin points to original block
    let props = get_properties_inner(&pool, sibling.id.clone())
        .await
        .unwrap();
    let origin_prop = props.iter().find(|p| p.key == "repeat-origin");
    assert!(origin_prop.is_some(), "sibling should have repeat-origin");
    assert_eq!(
        origin_prop.unwrap().value_ref.as_deref(),
        Some(block.id.as_str()),
        "repeat-origin should point to original block"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrence_preserves_repeat_origin_across_chain() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "chain task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // First DONE → creates sibling1
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find sibling1
    let sibling1_id: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE id != ?1 AND todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Complete sibling1 → creates sibling2
    set_todo_state_inner(&pool, DEV, &mat, sibling1_id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find sibling2
    let sibling2_id: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE id != ?1 AND id != ?2 AND todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .bind(&block.id)
    .bind(&sibling1_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Both sibling1 and sibling2 should point to the original block
    let props1 = get_properties_inner(&pool, sibling1_id).await.unwrap();
    let origin1 = props1.iter().find(|p| p.key == "repeat-origin");
    assert_eq!(
        origin1.unwrap().value_ref.as_deref(),
        Some(block.id.as_str()),
        "first sibling repeat-origin should point to original"
    );

    let props2 = get_properties_inner(&pool, sibling2_id).await.unwrap();
    let origin2 = props2.iter().find(|p| p.key == "repeat-origin");
    assert_eq!(
        origin2.unwrap().value_ref.as_deref(),
        Some(block.id.as_str()),
        "sibling2's repeat-origin should still point to the ORIGINAL block, not sibling1"
    );

    mat.shutdown();
}

// ======================================================================
// Repeat recurrence hardening (#665)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_done_with_dot_plus_repeat_shifts_from_today() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create block with due_date in the past
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Water plants".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-06-01".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set .+ repeat (from completion)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some(".+weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE — should create sibling with date shifted from today
    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find the sibling (new block with TODO state, same parent)
    let blocks = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                due_date, scheduled_date, page_id
         FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL"#,
        resp.id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert!(
        !blocks.is_empty(),
        "DONE transition should create a TODO sibling"
    );
    let sibling = &blocks[0];

    // .+ mode: due_date should be shifted from today, not from 2025-06-01
    let today = chrono::Local::now().date_naive();
    if let Some(ref due) = sibling.due_date {
        let due_date = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").unwrap();
        // Should be approximately today + 7 days (within 1 day tolerance for test timing)
        let expected = today + chrono::Duration::days(7);
        let diff = (due_date - expected).num_days().abs();
        assert!(
            diff <= 1,
            ".+ weekly should shift from today: expected ~{expected}, got {due_date}"
        );
    } else {
        panic!("Sibling should have a due_date");
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_done_with_plus_plus_repeat_catches_up() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create block with due_date far in the past (a Monday)
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Weekly review".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set ++ repeat (catch-up)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("++weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE
    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find the sibling
    let blocks = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                due_date, scheduled_date, page_id
         FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL"#,
        resp.id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert!(
        !blocks.is_empty(),
        "DONE transition should create a TODO sibling"
    );
    let sibling = &blocks[0];

    // ++ mode: due_date should be the next Monday after today
    let today = chrono::Local::now().date_naive();
    if let Some(ref due) = sibling.due_date {
        let due_date = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").unwrap();
        assert!(
            due_date > today,
            "++ mode sibling due_date should be in the future"
        );
        assert_eq!(
            due_date.weekday(),
            chrono::Weekday::Mon,
            "++ weekly from Monday cadence should land on Monday, got {due_date}"
        );
    } else {
        panic!("Sibling should have a due_date");
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_done_with_malformed_repeat_creates_sibling_without_shifted_dates() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Bad repeat".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set malformed repeat value
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("invalid_rule".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE — should still create sibling (graceful degradation)
    let result = set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into())).await;
    assert!(
        result.is_ok(),
        "DONE transition should succeed even with malformed repeat"
    );
    mat.flush_background().await.unwrap();

    // Original should be DONE
    let original = sqlx::query_scalar!("SELECT todo_state FROM blocks WHERE id = ?1", resp.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        original.as_deref(),
        Some("DONE"),
        "original block should remain DONE after recurrence"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_done_with_repeat_until_without_dates_still_creates_sibling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Block with repeat + repeat-until but NO due_date or scheduled_date
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "No dates".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat-until to a future date
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-until".into(),
        None,
        None,
        Some("2026-12-31".into()),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Transition to DONE — should create sibling (repeat-until can't be checked without reference date)
    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Find siblings with TODO state
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL",
    )
    .bind(&resp.id)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Sibling should be created (repeat-until check is skipped when no dates)
    assert!(
        count >= 1,
        "should create sibling even without dates (repeat-until check skipped)"
    );

    mat.shutdown();
}

// ─── delete_property_def builtin guard (BUG-11) ─────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_def_rejects_builtin_key() {
    let (pool, _dir) = test_pool().await;

    let result = delete_property_def_inner(&pool, "todo_state".into()).await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("builtin")),
        "deleting a builtin property key must return Validation error, got: {result:?}"
    );
}

// ─── BUG-41: command wrappers must sanitize internal errors ──────────
//
// The two Tauri wrappers `update_property_def_options` / `delete_property_def`
// previously returned raw `AppError::Database(sqlx::Error)` straight to the
// frontend. Every other write-command wrapper in the codebase applies
// `sanitize_internal_error` to collapse internal-detail variants
// (Database/Migration/Io/Json/Channel/Snapshot) into a generic
// `InvalidOperation("an internal error occurred")`. These tests pin the
// sanitization contract: user-facing variants (Validation, NotFound) pass
// through unchanged, but a Database error becomes InvalidOperation.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_property_def_options_sanitizes_database_errors() {
    // Trigger a Database error by closing the pool before calling.
    let (pool, _dir) = test_pool().await;
    // Seed a valid select-type def so the query reaches the UPDATE stage,
    // not the early NotFound branch.
    create_property_def_inner(
        &pool,
        "moods".into(),
        "select".into(),
        Some(r#"["happy","sad"]"#.into()),
    )
    .await
    .unwrap();

    pool.close().await;

    let raw = update_property_def_options_inner(&pool, "moods".into(), r#"["a","b"]"#.into()).await;
    let sanitized = raw.map_err(sanitize_internal_error);

    match sanitized {
        Err(AppError::InvalidOperation(msg)) => {
            assert_eq!(
                msg, "an internal error occurred",
                "sanitized DB errors must surface the generic copy, got: {msg:?}"
            );
        }
        other => panic!("expected sanitized DB error to become InvalidOperation, got: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_def_sanitizes_database_errors() {
    let (pool, _dir) = test_pool().await;
    create_property_def_inner(&pool, "temp".into(), "text".into(), None)
        .await
        .unwrap();

    pool.close().await;

    let raw = delete_property_def_inner(&pool, "temp".into()).await;
    let sanitized = raw.map_err(sanitize_internal_error);

    match sanitized {
        Err(AppError::InvalidOperation(msg)) => {
            assert_eq!(
                msg, "an internal error occurred",
                "sanitized DB errors must surface the generic copy, got: {msg:?}"
            );
        }
        other => panic!("expected sanitized DB error to become InvalidOperation, got: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_property_def_options_preserves_user_facing_errors_through_sanitize() {
    // Validation errors are user-facing and must pass through sanitization
    // unchanged — otherwise the frontend loses the actionable message
    // ("options must be a JSON array of strings" / "must not be empty").
    let (pool, _dir) = test_pool().await;
    create_property_def_inner(
        &pool,
        "flavour".into(),
        "select".into(),
        Some(r#"["sweet"]"#.into()),
    )
    .await
    .unwrap();

    let raw = update_property_def_options_inner(&pool, "flavour".into(), "not-json".into()).await;
    let sanitized = raw.map_err(sanitize_internal_error);

    match sanitized {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("JSON array"),
                "Validation message must pass through sanitization unchanged, got: {msg:?}"
            );
        }
        other => panic!(
            "expected Validation error to pass through sanitize_internal_error, got: {other:?}"
        ),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_def_preserves_user_facing_errors_through_sanitize() {
    // NotFound / Validation are user-facing — sanitize must not rewrite them.
    let (pool, _dir) = test_pool().await;

    let raw = delete_property_def_inner(&pool, "nonexistent-key".into()).await;
    let sanitized = raw.map_err(sanitize_internal_error);
    assert!(
        matches!(sanitized, Err(AppError::NotFound(_))),
        "NotFound must pass through sanitization unchanged, got: {sanitized:?}"
    );

    let raw = delete_property_def_inner(&pool, "todo_state".into()).await;
    let sanitized = raw.map_err(sanitize_internal_error);
    assert!(
        matches!(sanitized, Err(AppError::Validation(_))),
        "Validation must pass through sanitization unchanged, got: {sanitized:?}"
    );
}

// ─── M-26: delete_property_def must not orphan block_properties rows ─────────
//
// `delete_property_def_inner` previously DELETEd the `property_definitions`
// row unconditionally, leaving any `block_properties` rows that referenced
// the same key as orphans: `set_property_in_tx` would then see `def_meta =
// None`, skip type/options validation, and accept arbitrary values for the
// key on subsequent writes. Re-creating the same key with a different
// `value_type` later mismatched the existing data.
//
// The fix rejects the delete with `AppError::Validation` whenever any
// `block_properties` row references the key. Cascading the delete would
// violate the append-only op-log invariant (the rows were created via
// SetProperty ops and can't be removed outside the op-log path), and
// changing the public signature with a `force` flag would require explicit
// approval. The tests below pin the new behaviour.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m26_delete_property_def_happy_path_removes_row_when_no_dependents() {
    // No `block_properties` rows reference the key → the delete should
    // succeed and the `property_definitions` row should be gone.
    let (pool, _dir) = test_pool().await;

    create_property_def_inner(&pool, "scratch".into(), "text".into(), None)
        .await
        .unwrap();

    delete_property_def_inner(&pool, "scratch".into())
        .await
        .expect("delete must succeed when no block_properties reference the key");

    let still_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM property_definitions WHERE key = ?")
            .bind("scratch")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        still_present, 0,
        "property_definitions row must be gone after a successful delete"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m26_delete_property_def_rejects_when_block_properties_reference_key() {
    // Definition exists AND a block_properties row references the key →
    // the delete must reject with Validation, the property_definitions row
    // must still be present (no partial delete), and the dependent row
    // must be untouched.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_property_def_inner(&pool, "importance".into(), "text".into(), None)
        .await
        .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "m26 dependent block".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = delete_property_def_inner(&pool, "importance".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "delete must return Validation when block_properties reference the key, got: {result:?}"
    );

    // No partial delete — the property_definitions row must still be there.
    let def_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM property_definitions WHERE key = ?")
            .bind("importance")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        def_present, 1,
        "property_definitions row must survive a rejected delete (no partial delete)"
    );

    // The dependent block_properties row must also still be there.
    let dep_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(&block.id)
            .bind("importance")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        dep_present, 1,
        "block_properties row must be untouched by a rejected delete"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m26_delete_property_def_rejection_message_includes_key_and_count() {
    // The rejection must name the offending key (so the user knows which
    // property to clear) and surface the dependent-row count (so the user
    // knows how much clean-up is involved).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_property_def_inner(&pool, "importance".into(), "text".into(), None)
        .await
        .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "m26 message block".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = delete_property_def_inner(&pool, "importance".into()).await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("importance"),
                "rejection message must name the offending key, got: {msg:?}"
            );
            assert!(
                msg.contains('1'),
                "rejection message must surface the dependent-row count, got: {msg:?}"
            );
            assert!(
                msg.contains("set_property"),
                "rejection message must point users at the clean-up path, got: {msg:?}"
            );
        }
        other => panic!("expected Validation rejection, got: {other:?}"),
    }

    mat.shutdown();
}

// ─── BUG-20: Select/enum property value validation against options ───
//
// Previously the backend only validated property *types*, not whether
// the supplied value was one of the allowed options for select-type
// definitions. These tests exercise the option-membership check added
// to `set_property_in_tx` and the fallback in `set_todo_state_inner`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_set_todo_state_accepts_seeded_option() {
    // Happy path: TODO is in the seeded options list for the todo_state
    // property definition (migration 0014).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 happy".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    assert_eq!(
        result.todo_state.as_deref(),
        Some("TODO"),
        "TODO is in seeded options and must be accepted"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_set_todo_state_rejects_value_not_in_options() {
    // Error path: FROB is NOT in the seeded options list and must be
    // rejected with AppError::Validation.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 reject".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result =
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("FROB".into())).await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("FROB") && msg.contains("allowed options")),
        "setting todo_state to FROB must return Validation with options message, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_set_property_rejects_select_value_not_in_custom_options() {
    // Error path: a user-defined select property with custom options
    // must reject values outside the list.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_property_def_inner(
        &pool,
        "mood".into(),
        "select".into(),
        Some(r#"["happy","sad","meh"]"#.into()),
    )
    .await
    .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 custom select".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Happy: "happy" is in options
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "mood".into(),
        Some("happy".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // Error: "angry" is not in options
    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "mood".into(),
        Some("angry".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("angry") && msg.contains("allowed options")),
        "setting mood to 'angry' must return Validation error referencing allowed options, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_set_property_text_type_has_no_options_restriction() {
    // Happy path: text-type properties do not enforce any options check.
    // `assignee` is seeded as text-type (migration 0014) with NULL options.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 text".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "assignee".into(),
        Some("anyone-whatsoever".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(props.len(), 1, "text property should be saved");
    assert_eq!(
        props[0].value_text.as_deref(),
        Some("anyone-whatsoever"),
        "arbitrary text value must be accepted for text-type property"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_select_property_with_null_options_is_permissive() {
    // Edge: a select-type property definition with NULL options (no
    // restriction) must accept any value_text.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a select-type definition. `create_property_def_inner` requires
    // non-empty options for select, so we bypass it and insert directly
    // with NULL options — exercising the defensive permissive branch in
    // the validation logic.
    sqlx::query(
        "INSERT INTO property_definitions (key, value_type, options, created_at) \
         VALUES ('freeform_select', 'select', NULL, '2025-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 null opts".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "freeform_select".into(),
        Some("any-value".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(
        props.len(),
        1,
        "select-type with NULL options must not enforce options check"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_set_priority_rejects_value_not_in_seeded_options() {
    // Priority definition is seeded with options ["1","2","3"] at migration
    // 0014. Calling set_property_inner directly for "priority" with a value
    // outside the list must be rejected by the in_tx options check.
    //
    // This exercises the reserved-key branch where the existing hardcoded
    // validation in `set_priority_inner` is bypassed.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 priority".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "priority".into(),
        Some("99".into()),
        None,
        None,
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("99") && msg.contains("allowed options")),
        "setting priority to 99 via set_property must return Validation with options message, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m20_set_priority_accepts_user_extended_options() {
    // M-20 / ARCHITECTURE.md §20 (UX-201b): the priority property is a
    // user-extensible select-type definition. Calling set_priority_inner
    // with a value outside the seeded `["1","2","3"]` set must succeed
    // when the user has extended the options to cover that value (e.g.
    // an A/B/C scheme). The previous hardcoded `1|2|3` guard rejected
    // this categorically; the fix relies on `set_property_in_tx` to
    // validate against the live `property_definitions.options` row.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // User extends priority options via the existing update path.
    update_property_def_options_inner(
        &pool,
        "priority".into(),
        "[\"1\",\"2\",\"3\",\"A\",\"B\",\"C\"]".into(),
    )
    .await
    .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "m20 extended".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Happy path: extended value "A" is now permitted.
    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("A".into()))
        .await
        .unwrap();
    assert_eq!(
        result.priority.as_deref(),
        Some("A"),
        "priority 'A' should be persisted after the user extends the options"
    );

    // Built-in seeded value still works alongside the extension.
    set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into()))
        .await
        .unwrap();

    // Out-of-options value still rejected (BUG-20 options check inside
    // set_property_in_tx).
    let bad = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("Z".into())).await;
    assert!(
        matches!(bad, Err(AppError::Validation(ref msg)) if msg.contains("Z") && msg.contains("allowed options")),
        "value not in user-extended options must still be rejected, got: {bad:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m20_set_priority_fallback_when_definition_deleted() {
    // M-20: if the `priority` property_definition row is deleted (so the
    // BUG-20 options check inside `set_property_in_tx` finds no
    // definition), `set_priority_inner` falls back to the built-in
    // seeded options `["1","2","3"]` so the reserved-key contract
    // remains enforced. Mirrors `bug20_todo_state_fallback_when_definition_deleted`.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    sqlx::query("DELETE FROM property_definitions WHERE key = 'priority'")
        .execute(&pool)
        .await
        .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "m20 fallback".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Happy path: "1" is in the built-in fallback.
    set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("1".into()))
        .await
        .unwrap();

    // Error path: "9" is rejected via fallback defaults.
    let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("9".into())).await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("9") && msg.contains("allowed options")),
        "without definition row, priority must fall back to built-in defaults and reject unknown values, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug20_todo_state_fallback_when_definition_deleted() {
    // Fallback path: if the todo_state property_definition row is deleted,
    // set_todo_state_inner must still enforce the built-in defaults
    // ["TODO","DOING","DONE"].
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Directly remove the row; bypass delete_property_def_inner which
    // refuses to delete built-in keys.
    sqlx::query("DELETE FROM property_definitions WHERE key = 'todo_state'")
        .execute(&pool)
        .await
        .unwrap();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "bug20 fallback".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Happy path: TODO is in built-in fallback
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    // Error path: NONSENSE is rejected via fallback defaults
    let result =
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("NONSENSE".into())).await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("NONSENSE") && msg.contains("TODO")),
        "without definition row, todo_state must fall back to built-in defaults and reject unknown values, got: {result:?}"
    );

    mat.shutdown();
}

// ======================================================================
// H-4 — set_todo_state atomicity across state change + timestamps + recurrence
// ======================================================================

/// H-4: when the recurrence-sibling creation inside `set_todo_state_inner`
/// fails, the entire transaction (state flip to DONE, completed_at write,
/// sibling creation) must roll back. Pre-fix the state flip and timestamp
/// writes ran on separate transactions from the recurrence sibling, so a
/// failure in the recurrence step left the user stuck with a `done` state
/// and no next-occurrence sibling.
///
/// Trigger mechanism (post-L-100): a whitespace `repeat` value planted
/// directly into `block_properties` (bypassing the L-6 empty-text guard
/// in `set_property_inner`). `shift_date(due, " ")` returns `None`, so
/// the L-100 ISO-date check on `repeat-until` never fires; the copy step
/// then calls `set_property_in_tx(..., "repeat", Some(" "))`, which the
/// L-6 empty/whitespace guard in `validate_set_property` rejects. The
/// error propagates out through `handle_recurrence_in_tx` and rolls
/// the entire `CommandTx` back.
///
/// Note: the previous trigger (a corrupt `repeat-until = "not-a-date"`)
/// no longer reaches the copy step because L-100 now stops the
/// recurrence early on a malformed `repeat-until`. The H-4 invariant is
/// independent of L-100 — we just need any corrupt vehicle that
/// bypasses the early end-condition gates to keep this test green.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_atomic_when_recurrence_fails() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Set up a TODO block with due_date.
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task with corrupt repeat (H-4)".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Plant a whitespace `repeat` directly, bypassing the L-6
    // empty/whitespace guard in `set_property_inner`. The recurrence
    // flow proceeds past the end-condition gates (no `repeat-until`,
    // no `repeat-count`, and `reference_date` is `None` because
    // `shift_date(due, " ")` returns `None`), then the copy step's
    // `set_property_in_tx` call rejects the whitespace value_text.
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(&block.id)
        .bind("repeat")
        .bind(" ")
        .execute(&pool)
        .await
        .unwrap();

    // Snapshot pre-call state so we can assert it survived rollback.
    let pre_state: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(&block.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(pre_state.as_deref(), Some("TODO"));

    let ops_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Try to flip to DONE. This should fail because the recurrence step
    // inside the same tx hits the corrupt repeat value.
    let result =
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into())).await;

    assert!(
        result.is_err(),
        "set_todo_state_inner DONE should propagate the recurrence validation error, got {result:?}"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("set_property.value_text.empty") || err_msg.contains("empty"),
        "error should be the empty/whitespace value_text rejection, got: {err_msg}"
    );

    // H-4 contract: state did NOT transition.
    let post_state: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(&block.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        post_state.as_deref(),
        Some("TODO"),
        "rolled-back tx must leave todo_state unchanged"
    );

    // No completed_at was written.
    let completed_at: Option<String> = sqlx::query_scalar(
        "SELECT value_date FROM block_properties WHERE block_id = ? AND key = 'completed_at'",
    )
    .bind(&block.id)
    .fetch_optional(&pool)
    .await
    .unwrap()
    .flatten();
    assert!(
        completed_at.is_none(),
        "rolled-back tx must NOT write completed_at, got: {completed_at:?}"
    );

    // No recurrence sibling was created.
    let sibling_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks
         WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL",
    )
    .bind(&block.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        sibling_count, 0,
        "rolled-back tx must NOT create a recurrence sibling, got: {sibling_count}"
    );

    // No partial op_log entries from the failed call survived.
    let ops_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after, ops_before,
        "rolled-back tx must leave op_log unchanged (before={ops_before}, after={ops_after})"
    );

    mat.shutdown();
}

// ======================================================================
// I-CommandsCRUD-6 / I-CommandsCRUD-8 — boundary date validation
//
// These tests pin the post-fix contract for the two ISO-date validators
// that previously diverged:
//   * `validate_date_format` is the canonical entry point and now rejects
//     calendar-impossible combinations (Feb 30, Apr 31) — previously it
//     accepted them and relied on downstream re-parses to catch them
//     with a different error shape (I-CommandsCRUD-6).
//   * `is_valid_iso_date` is now a thin delegation to
//     `validate_date_format` so the two cannot drift again
//     (I-CommandsCRUD-8).
// ======================================================================

#[test]
fn validate_date_format_rejects_feb_30_i_commandscrud_6() {
    assert!(
        validate_date_format("2025-02-30").is_err(),
        "Feb 30 is not a real calendar date and must be rejected at the boundary"
    );
}

#[test]
fn validate_date_format_rejects_apr_31_i_commandscrud_6() {
    assert!(
        validate_date_format("2025-04-31").is_err(),
        "Apr 31 is not a real calendar date and must be rejected at the boundary"
    );
}

#[test]
fn validate_date_format_accepts_feb_29_in_leap_year_i_commandscrud_6() {
    assert!(
        validate_date_format("2024-02-29").is_ok(),
        "Feb 29 in a leap year (2024) must be accepted"
    );
    assert!(
        validate_date_format("2025-02-29").is_err(),
        "Feb 29 in a non-leap year (2025) must be rejected"
    );
}

#[test]
fn validate_date_format_still_rejects_structural_garbage_i_commandscrud_6() {
    for input in ["2025-13-01", "2025/02/01", "abc", ""] {
        assert!(
            validate_date_format(input).is_err(),
            "structural garbage '{input}' must still be rejected after the chrono switch"
        );
    }
}

#[test]
fn validate_date_format_accepts_canonical_form_i_commandscrud_6() {
    for input in ["2025-01-15", "1999-12-31", "2099-06-30"] {
        assert!(
            validate_date_format(input).is_ok(),
            "canonical YYYY-MM-DD '{input}' must continue to be accepted"
        );
    }
}

#[test]
fn is_valid_iso_date_delegates_to_validate_date_format_i_commandscrud_8() {
    // Pin the delegation contract: whatever inputs we throw at the two
    // validators, they must agree. Mixes valid, structurally-garbage,
    // and calendar-impossible inputs so the agreement is non-trivial.
    for input in [
        "2025-01-15",
        "2025-02-30",
        "2024-02-29",
        "2025-02-29",
        "abc",
        "",
    ] {
        assert_eq!(
            is_valid_iso_date(input),
            validate_date_format(input).is_ok(),
            "delegation invariant: is_valid_iso_date and validate_date_format must agree on '{input}'"
        );
    }
}
