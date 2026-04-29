use super::common::*;
use crate::op_log;

// ======================================================================
// page aliases — CRUD & resolution
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_and_get_page_aliases() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set aliases
    let inserted =
        set_page_aliases_inner(&pool, &page.id, vec!["my-alias".into(), "another".into()])
            .await
            .unwrap();

    assert_eq!(inserted.len(), 2, "both aliases must be inserted");
    assert!(
        inserted.contains(&"my-alias".to_string()),
        "must contain my-alias"
    );
    assert!(
        inserted.contains(&"another".to_string()),
        "must contain another"
    );

    // Get aliases (returned sorted alphabetically)
    let fetched = get_page_aliases_inner(&pool, &page.id).await.unwrap();
    assert_eq!(
        fetched,
        vec!["another", "my-alias"],
        "aliases must be sorted alphabetically"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_by_alias() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Resolvable Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_page_aliases_inner(&pool, &page.id, vec!["my-alias".into()])
        .await
        .unwrap();

    // Resolve by alias
    let resolved = resolve_page_by_alias_inner(&pool, "my-alias")
        .await
        .unwrap();
    assert!(resolved.is_some(), "alias must resolve to a page");

    let (resolved_id, resolved_title) = resolved.unwrap();
    assert_eq!(resolved_id, page.id, "resolved page ID must match");
    assert_eq!(
        resolved_title.as_deref(),
        Some("Resolvable Page"),
        "resolved title must match page content"
    );

    // Non-existent alias returns None
    let missing = resolve_page_by_alias_inner(&pool, "no-such-alias")
        .await
        .unwrap();
    assert!(missing.is_none(), "unknown alias must return None");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn alias_collision_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Page A claims the alias first
    let inserted_a = set_page_aliases_inner(&pool, &page_a.id, vec!["shared-alias".into()])
        .await
        .unwrap();
    assert_eq!(
        inserted_a,
        vec!["shared-alias"],
        "page A must own the alias"
    );

    // Page B tries to claim the same alias — INSERT OR IGNORE silently skips it
    let inserted_b = set_page_aliases_inner(&pool, &page_b.id, vec!["shared-alias".into()])
        .await
        .unwrap();
    assert!(
        inserted_b.is_empty(),
        "duplicate alias must be silently ignored (INSERT OR IGNORE)"
    );

    // The alias still resolves to page A
    let resolved = resolve_page_by_alias_inner(&pool, "shared-alias")
        .await
        .unwrap();
    assert!(resolved.is_some(), "alias must still resolve");
    assert_eq!(
        resolved.unwrap().0,
        page_a.id,
        "alias must still point to page A after collision"
    );
}

// ======================================================================
// Journal commands — today_journal / navigate_journal
// ======================================================================
//
// FEAT-3p5: every journal call now requires a `space_id`. Tests seed a
// space via `test_space()` and pass its ULID through.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn today_journal_creates_page_for_today() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let page = today_journal_inner(&pool, DEV, &mat, &space).await.unwrap();
    settle(&mat).await;

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(page.block_type, "page", "journal page must be a page block");
    assert_eq!(
        page.content,
        Some(today),
        "journal page content must be today's date"
    );
    assert!(page.deleted_at.is_none(), "page must not be soft-deleted");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn today_journal_returns_existing_page() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let first = today_journal_inner(&pool, DEV, &mat, &space).await.unwrap();
    settle(&mat).await;

    let second = today_journal_inner(&pool, DEV, &mat, &space).await.unwrap();
    settle(&mat).await;

    assert_eq!(
        first.id, second.id,
        "calling today_journal twice must return the same page (idempotent)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn navigate_journal_creates_page_for_date() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let date = "2025-03-15".to_string();
    let page = navigate_journal_inner(&pool, DEV, &mat, date.clone(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(page.block_type, "page");
    assert_eq!(
        page.content,
        Some(date),
        "journal page content must match the requested date"
    );

    // Verify persisted in DB
    let fetched = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(fetched.id, page.id);
    assert_eq!(fetched.block_type, "page");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn navigate_journal_returns_existing_page_for_same_date() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let date = "2025-06-01".to_string();
    let first = navigate_journal_inner(&pool, DEV, &mat, date.clone(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    let second = navigate_journal_inner(&pool, DEV, &mat, date.clone(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        first.id, second.id,
        "navigating to the same date twice must return the same page"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn navigate_journal_different_dates_create_different_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let page_a = navigate_journal_inner(&pool, DEV, &mat, "2025-01-10".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    let page_b = navigate_journal_inner(&pool, DEV, &mat, "2025-01-11".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_ne!(
        page_a.id, page_b.id,
        "different dates must produce different pages"
    );
    assert_eq!(page_a.content, Some("2025-01-10".into()));
    assert_eq!(page_b.content, Some("2025-01-11".into()));

    mat.shutdown();
}

// ======================================================================
// quick_capture_block — FEAT-12 (global-shortcut quick capture)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_capture_block_creates_today_journal_and_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let block = quick_capture_block_inner(&pool, DEV, &mat, "captured note".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        block.block_type, "content",
        "quick capture must create a content block"
    );
    assert_eq!(
        block.content,
        Some("captured note".into()),
        "captured content must round-trip verbatim"
    );
    assert!(
        block.parent_id.is_some(),
        "captured block must be parented under today's journal page"
    );

    let parent_id = block.parent_id.clone().unwrap();
    let parent = get_block_inner(&pool, parent_id.clone()).await.unwrap();
    assert_eq!(
        parent.block_type, "page",
        "parent of a quick-captured block must be a page (the journal)"
    );
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(
        parent.content,
        Some(today),
        "parent must be today's journal page"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_capture_block_reuses_existing_journal_page() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    // Pre-create today's journal page so the second call sees an existing page.
    let page = today_journal_inner(&pool, DEV, &mat, &space).await.unwrap();
    settle(&mat).await;

    let block = quick_capture_block_inner(&pool, DEV, &mat, "after-create".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        block.parent_id.as_deref(),
        Some(page.id.as_str()),
        "quick capture must reuse the pre-existing today journal page"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_capture_block_appends_two_blocks_when_called_twice() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    let first = quick_capture_block_inner(&pool, DEV, &mat, "first capture".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    let second = quick_capture_block_inner(&pool, DEV, &mat, "second capture".into(), &space)
        .await
        .unwrap();
    settle(&mat).await;

    assert_ne!(
        first.id, second.id,
        "two quick captures on the same day must produce two distinct blocks"
    );
    assert_eq!(
        first.parent_id, second.parent_id,
        "both quick-captured blocks must share the same today-journal parent"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_capture_block_oversize_content_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = test_space(&pool, "Personal").await;

    // MAX_CONTENT_LENGTH = 256 KiB — anything larger must be rejected by
    // create_block_inner with a Validation error, propagated through the
    // quick_capture wrapper unchanged.
    let oversize = "x".repeat(256 * 1024 + 1);
    let result = quick_capture_block_inner(&pool, DEV, &mat, oversize, &space).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize content must produce AppError::Validation, got {result:?}"
    );

    mat.shutdown();
}

// ======================================================================
// restore_page_to_op — point-in-time page restore
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_reverts_edits_after_target() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create page + child block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Restore Page".into(),
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
        "content-A".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Edit block: A → B
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "content-B".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Record the seq of the op that set content to B
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;

    // Edit block: B → C (this should be reverted)
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "content-C".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Verify block is at C before restore
    assert_eq!(
        get_block_inner(&pool, child.id.clone())
            .await
            .unwrap()
            .content,
        Some("content-C".into()),
        "block should be at content-C before restore"
    );

    // Restore to the seq that set content to B
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, page.id.clone(), DEV.into(), target_seq)
            .await
            .unwrap();
    settle(&mat).await;

    // Verify content reverted to B and ops_reverted > 0
    assert!(
        result.ops_reverted > 0,
        "should have reverted at least one op"
    );
    assert_eq!(
        get_block_inner(&pool, child.id).await.unwrap().content,
        Some("content-B".into()),
        "block content should revert to B after restore"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_with_all_pages_target() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 2 pages with children
    let page1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page 1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "orig-1".into(),
        Some(page1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let page2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page 2".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "orig-2".into(),
        Some(page2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Record target seq before edits
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops.last().unwrap().seq;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;

    // Edit blocks on both pages
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "changed-1".into())
        .await
        .unwrap();
    settle(&mat).await;
    edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "changed-2".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Restore to early seq with page_id = "__all__"
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, "__all__".into(), DEV.into(), target_seq)
            .await
            .unwrap();
    settle(&mat).await;

    assert_eq!(result.ops_reverted, 2, "should revert edits on both pages");
    assert_eq!(
        get_block_inner(&pool, b1.id).await.unwrap().content,
        Some("orig-1".into()),
        "b1 should revert to original"
    );
    assert_eq!(
        get_block_inner(&pool, b2.id).await.unwrap().content,
        Some("orig-2".into()),
        "b2 should revert to original"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_nonexistent_page_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // No ops exist in the DB — target (DEV, 1) will not be found by get_op_by_seq
    let result =
        restore_page_to_op_inner(&pool, DEV, &mat, "FAKE_PAGE_XYZ".into(), DEV.into(), 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring with a nonexistent page/target should return NotFound, got: {result:?}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_invalid_seq_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create page + child so ops exist
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Use the latest seq as target — nothing comes after it
    let ops = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let latest_seq = ops.last().unwrap().seq;

    let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), latest_seq)
        .await
        .unwrap();

    assert_eq!(
        result.ops_reverted, 0,
        "nothing to revert when target is the latest op"
    );
    assert_eq!(
        result.non_reversible_skipped, 0,
        "no non-reversible ops to skip"
    );
    assert!(result.results.is_empty(), "results should be empty");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_page_to_op_op_log_chain_valid_after_restore() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create page + child block
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
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
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Record target after creates
    let ops_snapshot = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let target_seq = ops_snapshot.last().unwrap().seq;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;

    // Make edits that will be reverted
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited-1".into())
        .await
        .unwrap();
    settle(&mat).await;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited-2".into())
        .await
        .unwrap();
    settle(&mat).await;

    let ops_before_restore = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let count_before = ops_before_restore.len();

    // Restore to target — should revert both edits
    let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(result.ops_reverted, 2, "should revert exactly 2 edit ops");

    // Fetch all ops after restore — reverse ops should be appended (not replacing old ones)
    let ops_after = op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(
        ops_after.len(),
        count_before + 2,
        "should have appended exactly 2 reverse ops to the op log"
    );

    // Verify the new reverse ops are at the end
    let reverse_ops = &ops_after[count_before..];
    for rev_op in reverse_ops {
        assert_eq!(
            rev_op.op_type, "edit_block",
            "reverse of edit_block should be edit_block, got: {}",
            rev_op.op_type
        );
    }

    // Verify op count increased (ops are appended, never removed)
    assert!(
        ops_after.len() > count_before,
        "op log must grow after restore, not shrink"
    );

    mat.shutdown();
}

// ======================================================================
// list_page_links — graph view page relationship query
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_returns_empty_with_no_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 2 pages, no block_links
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let links = list_page_links_inner(&pool).await.unwrap();
    assert!(
        links.is_empty(),
        "should return empty vec when no block_links exist"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_rolls_up_content_block_links_to_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create page P1 and P2
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page One".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create content block B1 under P1
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert block_links row: B1 → P2
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();

    // Assert result has link with source_id = P1.id, target_id = P2.id (rolled up)
    let p1_to_p2 = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(
        p1_to_p2.is_some(),
        "should find link P1→P2 rolled up from content block B1→P2"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create content block under P1
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert block_links
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    // Soft-delete the source block
    delete_block_inner(&pool, DEV, &mat, b1.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let links = list_page_links_inner(&pool).await.unwrap();
    let has_link = links
        .iter()
        .any(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(
        !has_link,
        "should NOT include links from deleted source blocks"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_self_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Self Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a block under p1 that links back to p1 itself
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("self [[{}]]", p1.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert self-referential block_links entry (b1 under p1 → p1)
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p1.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();
    let self_link = links.iter().find(|l| l.source_id == l.target_id);
    assert!(
        self_link.is_none(),
        "should not include self-referencing links"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_deduplicates() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 2 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create 2 content blocks under P1, both linking to P2
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("first [[{}]]", p2.id),
        Some(p1.id.clone()),
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
        format!("second [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert block_links for both content blocks → P2
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b2.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();

    // Both b1 and b2 roll up to P1 → P2; DISTINCT should collapse to 1 edge
    let p1_to_p2_count = links
        .iter()
        .filter(|l| l.source_id == p1.id && l.target_id == p2.id)
        .count();
    assert_eq!(
        p1_to_p2_count, 1,
        "should deduplicate multiple content blocks linking to the same target page"
    );

    mat.shutdown();
}
