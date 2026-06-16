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
    let bid = created.id.clone().into_string();

    assert_eq!(
        created.content,
        Some("version 1".into()),
        "create must set content"
    );
    assert!(created.deleted_at.is_none(), "create: not deleted");

    // 2. Edit
    let edited = edit_block_inner(&pool, DEV, &mat, bid.clone().into(), "version 2".into())
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        edited.content,
        Some("version 2".into()),
        "edit must update content"
    );

    // 3. Delete
    let deleted = delete_block_inner(&pool, DEV, &mat, bid.clone().into())
        .await
        .unwrap();
    let deleted_ts = deleted.deleted_at;
    settle(&mat).await;

    let row = get_block_inner(&pool, bid.clone().into()).await.unwrap();
    assert!(row.deleted_at.is_some(), "block must be deleted");
    assert_eq!(
        row.content,
        Some("version 2".into()),
        "deleted block retains edited content"
    );

    // 4. Restore
    restore_block_inner(&pool, DEV, &mat, bid.clone().into(), deleted_ts)
        .await
        .unwrap();

    let row = get_block_inner(&pool, bid.clone().into()).await.unwrap();
    assert!(row.deleted_at.is_none(), "block must be restored");
    assert_eq!(
        row.content,
        Some("version 2".into()),
        "restored block retains edited content"
    );

    // 5. Edit again after restore
    let re_edited = edit_block_inner(&pool, DEV, &mat, bid.clone().into(), "version 3".into())
        .await
        .unwrap();

    assert_eq!(
        re_edited.content,
        Some("version 3".into()),
        "re-edit after restore must update content"
    );

    let final_row = get_block_inner(&pool, bid.into()).await.unwrap();
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

/// PEND-24 M6: `restore_block_inner` must refresh the denormalized
/// `page_id` column synchronously inside its own tx, mirroring
/// `move_block_inner`. Pre-fix the column was only rewritten by the
/// async `RebuildPageIds` materializer task, leaving an observable
/// staleness window after the restore tx committed.
///
/// Scenario:
///
/// 1. Build a tree under `page_a`: `page_a → parent → leaf`. The
///    leaf's denormalised `page_id` is `page_a`.
/// 2. Soft-delete the leaf.
/// 3. Shut the materialiser down so subsequent commands cannot rely
///    on async catch-up — `RebuildPageIds` won't run, and any sync
///    column update has to come from the command tx itself.
/// 4. Move `parent` under `page_b`. `move_block_inner`'s recursive
///    UPDATE filters `b.deleted_at IS NULL`, so it skips the
///    soft-deleted leaf — `leaf.page_id` stays at `page_a` (verified
///    inline as the test setup precondition).
/// 5. Restore the leaf. With the M6 fix this synchronously rewrites
///    `leaf.page_id = page_b` inside the restore tx. Without M6 the
///    leaf would stay at `page_a` (no sync update; async path is
///    blocked by the shutdown).
///
/// The shutdown is what makes the test deterministic: it removes the
/// only async catch-up path so the assertion at step 5 isolates the
/// synchronous-tx behaviour the M6 fix introduces.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_synchronously_refreshes_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Two pages.
    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    let page_b = create_block_inner(&pool, DEV, &mat, "page".into(), "Page B".into(), None, None)
        .await
        .unwrap();

    // Parent (non-page) block under page_a — this is what we move
    // cross-page while the leaf is in the trash.
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
        Some(page_a.id.clone()),
        None,
    )
    .await
    .unwrap();
    // Leaf block under parent. Initial page_id = page_a (inherited
    // via parent at create time).
    let leaf = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "leaf".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(
        leaf.page_id
            .as_ref()
            .map(super::super::ulid::BlockId::as_str),
        Some(page_a.id.as_str()),
        "sanity: leaf inherits page_a as its initial page_id"
    );

    // Soft-delete the leaf. Its parent stays alive.
    let del = delete_block_inner(&pool, DEV, &mat, leaf.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    // Shut down the materialiser BEFORE the move/restore pair so any
    // bg tasks they dispatch (RebuildPageIds in particular) cannot
    // mask the sync-update behaviour we are testing. After shutdown
    // `dispatch_background` returns Err and the `_or_warn` wrapper in
    // `commit_and_dispatch` swallows it — the command tx still
    // commits, only the async catch-up is blocked.
    mat.shutdown();

    // Move parent under page_b. `move_block_inner`'s recursive UPDATE
    // filters `b.deleted_at IS NULL`, so the soft-deleted leaf's
    // page_id is NOT touched by the move's sync path — the only path
    // that would catch it is the async RebuildPageIds, now blocked.
    move_block_inner(
        &pool,
        DEV,
        &mat,
        parent.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();

    // Test setup precondition: leaf.page_id is still page_a (stale).
    // If this ever fails, either move_block_inner started rewriting
    // deleted descendants too, or the materialiser shutdown stopped
    // working — both invalidate the test's setup.
    let leaf_page_after_move: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_move.as_deref(),
        Some(page_a.id.as_str()),
        "setup precondition: deleted leaf must still point at page_a \
         after parent moves to page_b — move_block_inner skips \
         soft-deleted descendants and async RebuildPageIds is blocked \
         by the materialiser shutdown"
    );

    // Restore the leaf. With the M6 sync refresh in place, this
    // rewrites leaf.page_id = page_b inside the restore tx itself.
    // Without M6, the sync path leaves it at page_a (the async
    // RebuildPageIds catch-up is blocked by the shutdown).
    restore_block_inner(&pool, DEV, &mat, leaf.id.clone(), del.deleted_at)
        .await
        .unwrap();

    let leaf_page_after_restore: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_restore.as_deref(),
        Some(page_b.id.as_str()),
        "PEND-24 M6: restore_block_inner must synchronously refresh \
         page_id to the new ancestor (page_b), not the stale page_a"
    );
}

/// Verifies that per-device op_log sequences are isolated from one another.
/// Blocks are created sequentially (nested for-loops with `.await`), not
/// concurrently. The test checks that each device's op_log has exactly 5
/// monotonically-increasing seq entries and that all generated IDs are unique.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creates_from_multiple_devices_verifies_op_log_isolation() {
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

    let unique: HashSet<&str> = all_ids.iter().map(AsRef::as_ref).collect();
    assert_eq!(unique.len(), 15, "all IDs must be unique across devices");

    // Verify each device's op_log is independent
    for dev in &devices {
        let ops = op_log::get_ops_since(&ReadPool(pool.clone()), dev, 0)
            .await
            .unwrap();
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

    // TEST-29: parallelize the 50 block creates. The downstream assertions
    // check count, uniqueness, and page count only — never ordering — so
    // nondeterministic completion order across the 2-writer pool is safe.
    let creates = (0..TOTAL).map(|i| {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some(i64::try_from(i + 1).unwrap()),
        )
    });
    futures_util::future::try_join_all(creates).await.unwrap();

    // Drain bg dispatches before paginating. Post-MAINT-112 every
    // `create_block_inner` enqueues a bg op record; with the parallel
    // `try_join_all` above, all 50 dispatches must settle before the
    // pagination loop reads materializer-affected joined state.
    settle(&mat).await;
    assign_all_to_test_space(&pool).await;

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
            cursor,
            Some(PAGE_SIZE),
            TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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

    let unique: HashSet<&str> = all_ids.iter().map(AsRef::as_ref).collect();
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

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some("2099-12-31".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
    assign_all_to_test_space(&pool).await;
    let tagged = list_blocks_inner(
        &pool,
        None,
        None,
        Some(tag.id.clone().into_string()),
        None,
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();
    assert_eq!(tagged.items.len(), 1, "one block tagged");
    assert_eq!(
        tagged.items[0].id.as_str(),
        block.id.as_str(),
        "correct block tagged"
    );

    // 4. Move block to root
    move_block_inner(&pool, DEV, &mat, block.id.clone(), None, 99)
        .await
        .unwrap();

    let moved = get_block_inner(&pool, block.id.clone()).await.unwrap();
    assert!(moved.parent_id.is_none(), "block moved to root");
    // #400: new_index 99 ⇒ provisional dense 1-based rank = new_index + 1 = 100.
    assert_eq!(moved.position, Some(100), "new_index 99 ⇒ rank 100");

    // 5. Remove tag
    remove_tag_inner(&pool, DEV, &mat, block.id.clone(), tag.id.clone())
        .await
        .unwrap();

    let untagged = list_blocks_inner(
        &pool,
        None,
        None,
        Some(tag.id.clone().into_string()),
        None,
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();
    assert!(
        untagged.items.is_empty(),
        "no blocks tagged after remove_tag"
    );

    // 6. Verify op_log contains all operations
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
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
// #400: index-based create/move — slot 0 and negative slots are valid
// (the old 1-based "position must be positive" validation is gone).
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_create_block_index_zero_creates_as_first_child() {
    // #400: `index` is a 0-based sibling slot. Slot 0 ("first child") is
    // valid — the old "position must be positive" rejection is gone. The
    // optimistic write carries the provisional dense 1-based rank = index + 1.
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();

    assert_eq!(
        resp.position,
        Some(1),
        "index 0 (first child) ⇒ provisional dense rank 1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_create_block_negative_index_clamps_to_first() {
    // #400: a stray negative `index` is silently clamped to 0 (first child)
    // rather than rejected — the old "position must be positive" error is gone.
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(-5),
    )
    .await
    .unwrap();

    assert_eq!(
        resp.position,
        Some(1),
        "negative index clamps to 0 ⇒ provisional dense rank 1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_move_block_index_zero_moves_to_top() {
    // #400: `new_index` is a 0-based slot. Slot 0 ("move to top") is valid —
    // the old "position must be positive" rejection is gone. This is the whole
    // point of #400. Provisional dense 1-based rank = new_index + 1.
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();

    let resp = move_block_inner(&pool, DEV, &mat, block.id, None, 0)
        .await
        .unwrap();

    assert_eq!(
        resp.new_position, 1,
        "new_index 0 (top) ⇒ provisional dense rank 1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_move_block_negative_index_clamps_to_top() {
    // #400: a stray negative `new_index` is silently clamped to 0 (top)
    // rather than rejected — the old "position must be positive" error is gone.
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "test".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();

    let resp = move_block_inner(&pool, DEV, &mat, block.id, None, -3)
        .await
        .unwrap();

    assert_eq!(
        resp.new_position, 1,
        "negative new_index clamps to 0 ⇒ provisional dense rank 1"
    );
}

// ======================================================================
// Fix #26: date format validation — list_blocks agenda_date
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_list_blocks_rejects_invalid_date() {
    let (pool, _dir) = test_pool().await;

    // Too short
    assign_all_to_test_space(&pool).await;
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some("2025-1-1".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("abcd-ef-gh".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2025-13-01".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2025-01-00".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2024-01-32".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("not-a-date".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2025/01/15".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
    assign_all_to_test_space(&pool).await;
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        Some("2025-06-15".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2025-01-01".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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
        Some("2025-12-31".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
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

// ======================================================================
// #1248 — apply-cursor semantics: the LOCAL command path does NOT advance
// the materializer apply cursor.
//
// `materializer_apply_cursor.materialized_through_seq` tracks ENGINE-apply
// progress, not SQL-materialization progress. It advances ONLY inside
// `apply_op` / the `BatchApplyOps` arm (`advance_apply_cursor`), reached by
// boot replay / the test-only `dispatch_op` helper / remote apply. The live
// LOCAL command path (`create_block_inner` → `CommandTx::commit_and_dispatch`)
// writes the SQL `blocks` row synchronously and fires only background
// cache-rebuild tasks — it never enqueues an `ApplyOp` and never advances
// the cursor. This test pins that documented semantics: after a local
// create-block command (and a full background `settle()`), `op_log.seq`
// has advanced but `materialized_through_seq` is UNCHANGED.
//
// (Making the local path advance the cursor would require routing local
// ops through engine-apply — tracked separately in #1257; this test must
// be updated when that lands.)
// ======================================================================

/// Read `materializer_apply_cursor.materialized_through_seq`.
async fn read_apply_cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Highest `op_log.seq` (0 if the log is empty).
async fn max_op_log_seq(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_command_path_does_not_advance_apply_cursor_1248() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let cursor_before = read_apply_cursor(&pool).await;
    let seq_before = max_op_log_seq(&pool).await;
    assert_eq!(cursor_before, 0, "fresh DB: cursor seeded at 0");
    assert_eq!(seq_before, 0, "fresh DB: op_log empty");

    // Drive an op through the REAL local command path:
    // `create_block_inner` → `CommandTx::commit_and_dispatch`, which writes
    // the SQL `blocks` row synchronously and fires only background
    // cache-rebuild tasks (NO `ApplyOp`, NO engine apply).
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "cursor-semantics-1248".into(),
        None,
        None,
    )
    .await
    .unwrap();

    // Fully drain background materializer work — the local path's only
    // post-commit dispatches are background cache rebuilds, and none of
    // them advance the cursor either.
    settle(&mat).await;

    let cursor_after = read_apply_cursor(&pool).await;
    let seq_after = max_op_log_seq(&pool).await;

    // The op DID land in the op_log (the command path appended it)...
    assert!(
        seq_after > seq_before,
        "local create_block must append to op_log: {seq_before} -> {seq_after}",
    );

    // ...the SQL `blocks` row WAS materialized synchronously in the CommandTx
    // (the row exists), proving SQL materialization happened without the
    // cursor moving.
    let block_exists: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM blocks WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(created.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(block_exists, 1, "SQL blocks row materialized synchronously");

    // ...but the apply cursor is UNCHANGED: the local command path tracks no
    // engine-apply progress, so `materialized_through_seq` stays pinned even
    // though `op_log.seq` advanced. This is the #1248 semantics this test pins.
    assert_eq!(
        cursor_after, cursor_before,
        "local command path must NOT advance the apply cursor \
         (it tracks engine-apply, not SQL materialization — #1248); \
         cursor moved {cursor_before} -> {cursor_after} while op_log seq \
         moved {seq_before} -> {seq_after}",
    );

    mat.shutdown();
}
