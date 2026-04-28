use super::common::*;
use crate::op_log;

// ======================================================================
// set_property / delete_property — op_log verification
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prop-log".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block
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

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "create + set_property = 2 ops");
    assert_eq!(
        ops[1].op_type, "set_property",
        "op_type must be set_property"
    );
    assert_eq!(ops[1].device_id, DEV, "device_id must match");
    assert!(
        ops[1].payload.contains(&block.id),
        "payload must contain block_id"
    );
    assert!(
        ops[1].payload.contains("status"),
        "payload must contain property key"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prop-del-log".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block, seq 2 = set_property
    // BUG-20: "status" is seeded as select with options
    // ["active","paused","done","archived"] (migration 0011).
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
    settle(&mat).await;

    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 3, "create + set + delete = 3 ops");
    assert_eq!(
        ops[2].op_type, "delete_property",
        "op_type must be delete_property"
    );
    assert_eq!(ops[2].device_id, DEV, "device_id must match");
    assert!(
        ops[2].payload.contains(&block.id),
        "payload must contain block_id"
    );
    assert!(
        ops[2].payload.contains("status"),
        "payload must contain property key"
    );
}

// ======================================================================
// delete_property on deleted block — error path
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_on_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block, set a property, then delete the block
    let block = create_block_inner(
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
    settle(&mat).await;

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    // Attempt to delete property on the now-deleted block
    let result = delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete_property on deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_on_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = delete_property_inner(
        &pool,
        DEV,
        &mat,
        "GHOST_PROP_BLK_999".into(),
        "whatever".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete_property on nonexistent block must return AppError::NotFound"
    );
}

// ======================================================================
// get_batch_properties — happy paths & error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create two blocks via the command layer
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set properties via command layer
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
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("done".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Batch-fetch
    let result = get_batch_properties_inner(&pool, vec![b1.id.clone(), b2.id.clone()])
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "both blocks must be in result");
    assert_eq!(result[&b1.id][0].key, "importance");
    assert_eq!(result[&b1.id][0].value_text, Some("high".into()));
    assert_eq!(result[&b2.id][0].key, "status");
    assert_eq!(result[&b2.id][0].value_text, Some("done".into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_empty_ids_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let result = get_batch_properties_inner(&pool, vec![]).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_ids must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_does_not_affect_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "op-log check".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "key1".into(),
        Some("val".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Count op_log entries before the read-only batch call
    let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();

    // Read-only batch fetch
    let _ = get_batch_properties_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    // op_log must not change
    let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(
        ops_before.len(),
        ops_after.len(),
        "get_batch_properties must not write to op_log"
    );
}

// ======================================================================
// Date validation edge cases — comprehensive format checks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_invalid_month_13_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-13-01".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "month=13 must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_short_format_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "short date '2025-01' must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_two_digit_year_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("25-1-1".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "'25-1-1' must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_day_32_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01-32".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "day=32 must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_non_date_string_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("not-a-date".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "'not-a-date' must return Validation error, got: {result:?}"
    );
}

// ======================================================================
// query_by_property — integration
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create blocks via command layer
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task one".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task three".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set properties via command layer
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "todo".into(),
        Some("TODO".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "todo".into(),
        Some("DONE".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        "priority".into(),
        Some("1".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Query all blocks with 'todo' property (any value)
    let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None)
        .await
        .unwrap();

    assert_eq!(result.items.len(), 2, "two blocks have 'todo' property");

    // Query with value filter: only TODO
    let filtered = query_by_property_inner(
        &pool,
        "todo".into(),
        Some("TODO".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(filtered.items.len(), 1, "only one block has todo=TODO");
    assert_eq!(filtered.items[0].id, b1.id);

    // Query nonexistent key: empty
    let empty = query_by_property_inner(&pool, "nonexistent".into(), None, None, None, None, None)
        .await
        .unwrap();

    assert!(empty.items.is_empty(), "nonexistent key must return empty");
}

// ======================================================================
// Property definitions — happy paths (#548, #549, #550, #557)
// ======================================================================

#[tokio::test]
async fn create_property_def_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let def = create_property_def_inner(&pool, "custom_field".into(), "text".into(), None)
        .await
        .unwrap();
    assert_eq!(def.key, "custom_field");
    assert_eq!(def.value_type, "text");
    assert!(def.options.is_none(), "text-type must have no options");
    assert!(!def.created_at.is_empty(), "created_at must be set");
}

#[tokio::test]
async fn create_property_def_select_with_options() {
    let (pool, _dir) = test_pool().await;
    let opts = r#"["low","medium","high"]"#;
    let def =
        create_property_def_inner(&pool, "severity".into(), "select".into(), Some(opts.into()))
            .await
            .unwrap();
    assert_eq!(def.key, "severity");
    assert_eq!(def.value_type, "select");
    assert_eq!(def.options.as_deref(), Some(opts));
}

#[tokio::test]
async fn create_property_def_idempotent() {
    let (pool, _dir) = test_pool().await;
    let opts = r#"["a","b"]"#;
    let first =
        create_property_def_inner(&pool, "color".into(), "select".into(), Some(opts.into()))
            .await
            .unwrap();

    // Call again with different options — should return original unchanged
    let second = create_property_def_inner(
        &pool,
        "color".into(),
        "select".into(),
        Some(r#"["x","y"]"#.into()),
    )
    .await
    .unwrap();

    assert_eq!(
        first.created_at, second.created_at,
        "original must be preserved"
    );
    assert_eq!(
        first.options, second.options,
        "options must remain unchanged on duplicate insert"
    );
}

#[tokio::test]
async fn list_property_defs_returns_all_ordered() {
    let (pool, _dir) = test_pool().await;
    // Delete seeded defaults to isolate this test
    sqlx::query("DELETE FROM property_definitions")
        .execute(&pool)
        .await
        .unwrap();

    create_property_def_inner(&pool, "zeta".into(), "text".into(), None)
        .await
        .unwrap();
    create_property_def_inner(&pool, "alpha".into(), "number".into(), None)
        .await
        .unwrap();
    create_property_def_inner(&pool, "mid".into(), "date".into(), None)
        .await
        .unwrap();

    let defs = list_property_defs_inner(&pool).await.unwrap();
    assert_eq!(defs.len(), 3);
    assert_eq!(defs[0].key, "alpha", "results must be sorted by key");
    assert_eq!(defs[1].key, "mid");
    assert_eq!(defs[2].key, "zeta");
}

#[tokio::test]
async fn list_property_defs_includes_seeded_defaults() {
    let (pool, _dir) = test_pool().await;
    let defs = list_property_defs_inner(&pool).await.unwrap();
    let keys: Vec<&str> = defs.iter().map(|d| d.key.as_str()).collect();
    assert!(keys.contains(&"status"), "seeded 'status' must exist");
    assert!(keys.contains(&"due"), "seeded 'due' must exist");
    assert!(keys.contains(&"url"), "seeded 'url' must exist");

    // Verify status is select-type with correct options
    let status = defs.iter().find(|d| d.key == "status").unwrap();
    assert_eq!(status.value_type, "select");
    assert!(status.options.is_some());
}

#[tokio::test]
async fn update_property_def_options_changes_options() {
    let (pool, _dir) = test_pool().await;
    let opts1 = r#"["a","b"]"#;
    create_property_def_inner(&pool, "mood".into(), "select".into(), Some(opts1.into()))
        .await
        .unwrap();

    let opts2 = r#"["x","y","z"]"#;
    let updated = update_property_def_options_inner(&pool, "mood".into(), opts2.into())
        .await
        .unwrap();

    assert_eq!(updated.options.as_deref(), Some(opts2));
    assert_eq!(updated.key, "mood");
    assert_eq!(updated.value_type, "select");
}

#[tokio::test]
async fn delete_property_def_removes_row() {
    let (pool, _dir) = test_pool().await;
    create_property_def_inner(&pool, "temp".into(), "text".into(), None)
        .await
        .unwrap();

    delete_property_def_inner(&pool, "temp".into())
        .await
        .unwrap();

    let defs = list_property_defs_inner(&pool).await.unwrap();
    assert!(
        !defs.iter().any(|d| d.key == "temp"),
        "deleted def must not appear in list"
    );
}

// ======================================================================
// Property definitions — error paths
// ======================================================================

#[tokio::test]
async fn create_property_def_empty_key_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result = create_property_def_inner(&pool, "".into(), "text".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty key must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_key_too_long_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let long_key = "a".repeat(65);
    let result = create_property_def_inner(&pool, long_key, "text".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "65-char key must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_invalid_chars_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result = create_property_def_inner(&pool, "has spaces".into(), "text".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "key with spaces must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_invalid_value_type_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result = create_property_def_inner(&pool, "flag".into(), "boolean".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid value_type must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_select_without_options_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result = create_property_def_inner(&pool, "pick".into(), "select".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "select without options must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_text_with_options_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result =
        create_property_def_inner(&pool, "note".into(), "text".into(), Some(r#"["a"]"#.into()))
            .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "text type with options must return Validation error"
    );
}

#[tokio::test]
async fn update_property_def_options_nonexistent_key_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let result =
        update_property_def_options_inner(&pool, "nonexistent".into(), r#"["a"]"#.into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "update on nonexistent key must return NotFound"
    );
}

#[tokio::test]
async fn update_property_def_options_non_select_returns_validation() {
    let (pool, _dir) = test_pool().await;
    create_property_def_inner(&pool, "mytext".into(), "text".into(), None)
        .await
        .unwrap();

    let result = update_property_def_options_inner(&pool, "mytext".into(), r#"["a"]"#.into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "update options on text-type must return Validation error"
    );
}

#[tokio::test]
async fn delete_property_def_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let result = delete_property_def_inner(&pool, "ghost".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete nonexistent key must return NotFound"
    );
}

// ======================================================================
// Property definitions — edge cases
// ======================================================================

#[tokio::test]
async fn create_property_def_select_empty_options_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let result =
        create_property_def_inner(&pool, "empty".into(), "select".into(), Some("[]".into())).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "select with empty options array must return Validation error"
    );
}

#[tokio::test]
async fn create_property_def_with_hyphen_underscore_key() {
    let (pool, _dir) = test_pool().await;
    let def = create_property_def_inner(&pool, "my-custom_prop".into(), "text".into(), None)
        .await
        .unwrap();
    assert_eq!(def.key, "my-custom_prop", "hyphen/underscore key must work");
}

// ---------------------------------------------------------------------------
// Reserved key routing: query_by_property + delete_property (#562 review fixes)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_finds_reserved_key_in_blocks_column() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a content block and set its todo_state
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task one".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    settle(&mat).await;

    // Query by reserved key — should find the block via blocks.todo_state column
    let result = query_by_property_inner(
        &pool,
        "todo_state".into(),
        Some("TODO".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.items.len(),
        1,
        "query_by_property with reserved key must find blocks with that column value"
    );
    assert_eq!(result.items[0].id, block.id);

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_clears_reserved_key_column() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a content block and set its priority
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "important".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into()))
        .await
        .unwrap();
    settle(&mat).await;

    // Verify it's set
    let fetched = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(
        fetched.priority.as_deref(),
        Some("2"),
        "priority should be set before delete"
    );

    // Delete the reserved key property — should succeed and NULL the column
    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "priority".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Verify column IS cleared
    let fetched = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        fetched.priority.is_none(),
        "priority should be NULL after delete, got: {:?}",
        fetched.priority
    );

    mat.shutdown();
}

// ---------------------------------------------------------------------------
// Block fixed fields integration tests: thin commands + query_by_property
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_todo_state_then_query_by_property_returns_match() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task for query".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    settle(&mat).await;

    let result = query_by_property_inner(
        &pool,
        "todo_state".into(),
        Some("TODO".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.items.len(),
        1,
        "query_by_property with todo_state=TODO must find the block"
    );
    assert_eq!(result.items[0].id, block.id);

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_due_date_then_query_by_property_returns_match() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "due date query".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2026-06-01".into()),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = query_by_property_inner(
        &pool,
        "due_date".into(),
        Some("2026-06-01".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.items.len(),
        1,
        "query_by_property with due_date=2026-06-01 must find the block"
    );
    assert_eq!(result.items[0].id, block.id);

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thin_commands_survive_delete_property_cycle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "cycle test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set todo_state
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    settle(&mat).await;

    // Verify it's set
    let fetched = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert_eq!(
        fetched.todo_state.as_deref(),
        Some("TODO"),
        "todo_state should be TODO before delete"
    );

    // Delete the todo_state property — should succeed and NULL the column
    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "todo_state".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Verify todo_state is cleared
    let fetched = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(
        fetched.todo_state.is_none(),
        "todo_state should be NULL after delete, got: {:?}",
        fetched.todo_state
    );

    mat.shutdown();
}
