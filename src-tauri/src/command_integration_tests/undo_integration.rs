use super::common::*;

// ======================================================================
// undo / redo — integration tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Undo Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child block with "original"
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
    settle(&mat).await;

    // Edit child to "modified"
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Undo the most recent op on the page
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        result.new_op_type, "edit_block",
        "undo of an edit must produce an edit_block op"
    );
    assert_eq!(
        result.reversed_op_type, "edit_block",
        "reversed_op_type must echo the op_type of the op being undone"
    );
    assert!(!result.is_redo, "undo must not be flagged as redo");

    // Content should be back to "original"
    let fetched = get_block_inner(&pool, child.id).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("original".into()),
        "undo must restore content to 'original'"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_then_redo_restores_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Redo Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child with "original"
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
    settle(&mat).await;

    // Edit to "modified"
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Undo
    let undo_result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    // Content should be "original" after undo
    let fetched = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("original".into()),
        "after undo, content must be 'original'"
    );

    // Redo using the new_op_ref from the undo result
    let redo_result = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo_result.new_op_ref.device_id.clone(),
        undo_result.new_op_ref.seq,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert!(redo_result.is_redo, "redo must be flagged as is_redo");
    assert_eq!(
        redo_result.reversed_op_type, "edit_block",
        "reversed_op_type on redo should reflect the undo op being reversed (an edit_block undo)"
    );

    // Content should be back to "modified"
    let fetched = get_block_inner(&pool, child.id).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("modified".into()),
        "after redo, content must be 'modified'"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_property_change_restores_prior_value() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Property Undo Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child block
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set a custom property "importance" to "low"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone().into(),
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
    settle(&mat).await;

    // Change "importance" to "high"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone().into(),
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
    settle(&mat).await;

    // Undo the most recent op on the page (the "high" set)
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    assert!(
        !result.is_redo,
        "undo of property change must not be flagged as redo"
    );

    // "importance" should be back to "low" (prior value restored)
    let props = get_properties_inner(&pool, child.id).await.unwrap();
    let importance = props.iter().find(|p| p.key == "importance");
    assert!(
        importance.is_some(),
        "importance property must still exist after undo"
    );
    assert_eq!(
        importance.unwrap().value_text.as_deref(),
        Some("low"),
        "undo must restore property value to 'low'"
    );
}

/// MAINT-214 (b): `apply_reverse_in_tx` for `OpPayload::MoveBlock`
/// must refresh the denormalised `page_id` column synchronously,
/// mirroring the M6 fix in `move_block_inner`
/// (`commands/blocks/move_ops.rs:174-231`). Pre-fix, undoing a
/// cross-page move relied on the async `RebuildPageIds` materializer
/// task to update page_id, leaving an observable staleness window
/// after the undo tx committed.
///
/// Scenario:
///
/// 1. Build a tree under `page_a`: `page_a → leaf`.
/// 2. Move `leaf` under `page_b` (sync M6 already refreshes
///    `leaf.page_id = page_b`).
/// 3. Shut the materialiser down so async catch-up can't mask the
///    sync-update behaviour we are testing.
/// 4. Undo the move via `undo_page_op_inner`. The reverse payload is
///    a `MoveBlock` putting the leaf back under `page_a`. With the
///    MAINT-214 (b) fix, `apply_reverse_in_tx` synchronously rewrites
///    `leaf.page_id = page_a`. Without the fix the column stays at
///    `page_b` (async catch-up is blocked).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_move_block_synchronously_refreshes_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Move Undo Page A".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Move Undo Page B".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let leaf = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "leaf".into(),
        Some(page_a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(
        leaf.page_id.as_deref(),
        Some(page_a.id.as_str()),
        "sanity: leaf starts under page_a"
    );

    // Move leaf to page_b. move_block_inner's sync M6 rewrites
    // leaf.page_id = page_b.
    move_block_inner(
        &pool,
        DEV,
        &mat,
        leaf.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let leaf_page_after_move: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_move.as_deref(),
        Some(page_b.id.as_str()),
        "sanity: leaf.page_id is page_b after the move"
    );

    // Shut the materialiser down so async RebuildPageIds cannot
    // catch up — only the sync MAINT-214 (b) fix can produce the
    // expected post-state.
    mat.shutdown();

    // Undo on page_b (where the move op was journalled — move_block
    // ops attach to the new parent's page).
    let undo_result = undo_page_op_inner(&pool, DEV, &mat, page_b.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        undo_result.reversed_op_type, "move_block",
        "undo target must be the move_block op"
    );

    let leaf_page_after_undo: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_undo.as_deref(),
        Some(page_a.id.as_str()),
        "MAINT-214 (b): apply_reverse_in_tx for MoveBlock must \
         synchronously refresh page_id back to page_a — async \
         RebuildPageIds is blocked by the materialiser shutdown"
    );

    // Sanity: leaf is now parented to page_a again.
    let leaf_row = get_block_inner(&pool, leaf.id.clone()).await.unwrap();
    assert_eq!(
        leaf_row.parent_id.as_deref(),
        Some(page_a.id.as_str()),
        "sanity: undo restored parent_id to page_a"
    );
}
