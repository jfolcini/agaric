use super::common::*;
use crate::op_log;
use std::collections::HashSet;

// ======================================================================
// Cross-cutting: Full lifecycle
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_lifecycle_create_edit_delete_restore_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // 1. Create
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "version 1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let bid = created.id.clone();

    assert_eq!(
        created.content,
        Some("version 1".into()),
        "create must set content"
    );
    assert!(created.deleted_at.is_none(), "create: not deleted");

    // 2. Edit
    let edited = edit_block_inner(&pool, DEV, &mat, bid.clone(), "version 2".into())
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        edited.content,
        Some("version 2".into()),
        "edit must update content"
    );

    // 3. Delete
    let deleted = delete_block_inner(&pool, DEV, &mat, bid.clone())
        .await
        .unwrap();
    let deleted_ts = deleted.deleted_at.clone();
    settle(&mat).await;

    let row = get_block_inner(&pool, bid.clone()).await.unwrap();
    assert!(row.deleted_at.is_some(), "block must be deleted");
    assert_eq!(
        row.content,
        Some("version 2".into()),
        "deleted block retains edited content"
    );

    // 4. Restore
    restore_block_inner(&pool, DEV, &mat, bid.clone(), deleted_ts)
        .await
        .unwrap();

    let row = get_block_inner(&pool, bid.clone()).await.unwrap();
    assert!(row.deleted_at.is_none(), "block must be restored");
    assert_eq!(
        row.content,
        Some("version 2".into()),
        "restored block retains edited content"
    );

    // 5. Edit again after restore
    let re_edited = edit_block_inner(&pool, DEV, &mat, bid.clone(), "version 3".into())
        .await
        .unwrap();

    assert_eq!(
        re_edited.content,
        Some("version 3".into()),
        "re-edit after restore must update content"
    );

    let final_row = get_block_inner(&pool, bid).await.unwrap();
    assert_eq!(
        final_row.content,
        Some("version 3".into()),
        "final DB content must be version 3"
    );
    assert!(
        final_row.deleted_at.is_none(),
        "final state must not be deleted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_creates_from_multiple_devices_no_conflicts() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let devices = ["device-A", "device-B", "device-C"];
    let mut all_ids = Vec::new();

    for dev in &devices {
        for i in 0..5 {
            let resp = create_block_inner(
                &pool,
                dev,
                &mat,
                "content".into(),
                format!("{dev}-block-{i}"),
                None,
                Some(i64::from(i + 1)),
            )
            .await
            .unwrap();
            all_ids.push(resp.id);
        }
    }

    assert_eq!(
        all_ids.len(),
        15,
        "15 total blocks created across 3 devices"
    );

    let unique: HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(unique.len(), 15, "all IDs must be unique across devices");

    // Verify each device's op_log is independent
    for dev in &devices {
        let ops = op_log::get_ops_since(&pool, dev, 0).await.unwrap();
        assert_eq!(
            ops.len(),
            5,
            "device {dev} must have exactly 5 ops in op_log"
        );
        for (i, op) in ops.iter().enumerate() {
            assert_eq!(
                op.seq,
                i64::try_from(i + 1).unwrap(),
                "device {dev} seq must be monotonic"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_50_blocks_paginate_through_all_verify_count() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    const TOTAL: usize = 50;
    const PAGE_SIZE: i64 = 7;

    for i in 0..TOTAL {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some(i64::try_from(i + 1).unwrap()),
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
            Some(PAGE_SIZE),
            None, // FEAT-3 Phase 2: space_id unscoped
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

    assert_eq!(
        all_ids.len(),
        TOTAL,
        "must collect all {TOTAL} blocks across pages"
    );

    let unique: HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    assert_eq!(
        unique.len(),
        TOTAL,
        "no duplicate blocks in paginated results"
    );

    // Expected pages: ceil(50/7) = 8
    let expected_pages = (i64::try_from(TOTAL).unwrap() + PAGE_SIZE - 1) / PAGE_SIZE;
    assert_eq!(
        pages, expected_pages,
        "expected {expected_pages} pages for {TOTAL} items at page size {PAGE_SIZE}"
    );
}

// ======================================================================
// list_blocks — agenda_date filter
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_agenda_date_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;

    // Create blocks and agenda_cache entries
    insert_block(&pool, "AG_BLK1", "content", "meeting", None, Some(1)).await;
    insert_block(&pool, "AG_BLK2", "content", "deadline", None, Some(2)).await;
    insert_block(&pool, "AG_BLK3", "content", "other day", None, Some(3)).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-15")
        .bind("AG_BLK1")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-15")
        .bind("AG_BLK2")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-16")
        .bind("AG_BLK3")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-06-15".into()),
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
        2,
        "must return only blocks with agenda date 2025-06-15"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"AG_BLK1"), "AG_BLK1 must be in results");
    assert!(ids.contains(&"AG_BLK2"), "AG_BLK2 must be in results");
    assert!(
        !ids.contains(&"AG_BLK3"),
        "AG_BLK3 must not be in results (different date)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_agenda_date_no_matches_returns_empty() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "AG_EMPTY", "content", "block", None, Some(1)).await;

    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2099-12-31".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert!(
        resp.items.is_empty(),
        "no blocks for nonexistent agenda date"
    );
    assert!(!resp.has_more, "has_more must be false for empty results");
}

// ======================================================================
// Cross-cutting: move_block + add_tag lifecycle
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_lifecycle_create_tag_move_remove_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // 1. Create blocks
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

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "important".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // 2. Add tag
    add_tag_inner(&pool, DEV, &mat, block.id.clone(), tag.id.clone())
        .await
        .unwrap();

    // 3. Verify tag via list_by_tag
    let tagged = list_blocks_inner(
        &pool,
        None,
        None,
        Some(tag.id.clone()),
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
    assert_eq!(tagged.items.len(), 1, "one block tagged");
    assert_eq!(tagged.items[0].id, block.id, "correct block tagged");

    // 4. Move block to root
    move_block_inner(&pool, DEV, &mat, block.id.clone(), None, 99)
        .await
        .unwrap();

    let moved = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(moved.parent_id.is_none(), "block moved to root");
    assert_eq!(moved.position, Some(99), "position updated");

    // 5. Remove tag
    remove_tag_inner(&pool, DEV, &mat, block.id.clone(), tag.id.clone())
        .await
        .unwrap();

    let untagged = list_blocks_inner(
        &pool,
        None,
        None,
        Some(tag.id.clone()),
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
    assert!(
        untagged.items.is_empty(),
        "no blocks tagged after remove_tag"
    );

    // 6. Verify op_log contains all operations
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    let op_types: Vec<&str> = ops.iter().map(|o| o.op_type.as_str()).collect();
    assert!(
        op_types.contains(&"create_block"),
        "op_log must contain create_block"
    );
    assert!(op_types.contains(&"add_tag"), "op_log must contain add_tag");
    assert!(
        op_types.contains(&"move_block"),
        "op_log must contain move_block"
    );
    assert!(
        op_types.contains(&"remove_tag"),
        "op_log must contain remove_tag"
    );
}

// ======================================================================
// Fix #25: position validation — create_block & move_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_create_block_rejects_zero_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(0),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "position=0 must return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message must mention positive position, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_create_block_rejects_negative_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(-5),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "negative position must return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message must mention positive position, got: {err}"
    );
    assert!(
        err.to_string().contains("-5"),
        "error message must include the bad value, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_move_block_rejects_zero_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, block.id, None, 0).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "move with position=0 must return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message must mention positive position, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_move_block_rejects_negative_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, block.id, None, -3).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "move with negative position must return Validation error, got: {err:?}"
    );
    assert!(
        err.to_string().contains("position must be positive"),
        "error message must mention positive position, got: {err}"
    );
    assert!(
        err.to_string().contains("-3"),
        "error message must include the bad value, got: {err}"
    );
}

// ======================================================================
// Fix #26: date format validation — list_blocks agenda_date
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_list_blocks_rejects_invalid_date() {
    let (pool, _dir) = test_pool().await;

    // Too short
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-1-1".into()),
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
        "short date must return Validation error, got: {result:?}"
    );

    // Non-digit characters
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("abcd-ef-gh".into()),
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
        "non-digit date must return Validation error, got: {result:?}"
    );

    // Invalid month
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

    // Invalid day (00)
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01-00".into()),
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
        "day=00 must return Validation error, got: {result:?}"
    );

    // Invalid day (32)
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2024-01-32".into()),
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

    // Completely non-date string (exact 10 chars)
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

    // Wrong separator
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025/01/15".into()),
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
        "slash-separated date must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_list_blocks_accepts_valid_date() {
    let (pool, _dir) = test_pool().await;

    // Valid dates should not return a Validation error — they may return
    // an empty result set (no agenda entries) but no error.
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        result.is_ok(),
        "valid date 2025-06-15 must be accepted, got: {result:?}"
    );

    // Boundary: Jan 1
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01-01".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        result.is_ok(),
        "valid date 2025-01-01 must be accepted, got: {result:?}"
    );

    // Boundary: Dec 31
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-12-31".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        result.is_ok(),
        "valid date 2025-12-31 must be accepted, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_none_position_appends_after_siblings() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a parent page
    let parent = create_block_inner(&pool, DEV, &mat, "page".into(), "parent".into(), None, None)
        .await
        .unwrap();

    settle(&mat).await;

    // Create three children with position: None — each should auto-append
    let child0 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "first".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();

    settle(&mat).await;

    let child1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "second".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();

    settle(&mat).await;

    let child2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "third".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        child0.position,
        Some(1),
        "first child with position: None should get position 1"
    );
    assert_eq!(
        child1.position,
        Some(2),
        "second child with position: None should get position 2"
    );
    assert_eq!(
        child2.position,
        Some(3),
        "third child with position: None should get position 3"
    );
}
