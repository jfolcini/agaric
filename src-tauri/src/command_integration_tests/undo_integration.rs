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
        child.id.clone(),
        "importance".into(),
        Some("low".into()),
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
        child.id.clone(),
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
