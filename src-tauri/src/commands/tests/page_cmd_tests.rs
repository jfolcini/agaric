#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// page_aliases (#598)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_creates_and_returns_aliases() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "page-1", "page", "My Page", None, Some(0)).await;

    let inserted = set_page_aliases_inner(&pool, "page-1", vec!["Alpha".into(), "Beta".into()])
        .await
        .unwrap();

    assert_eq!(inserted.len(), 2, "should insert 2 aliases");
    assert!(
        inserted.contains(&"Alpha".to_string()),
        "should contain Alpha"
    );
    assert!(
        inserted.contains(&"Beta".to_string()),
        "should contain Beta"
    );

    // Verify persistence
    let aliases = get_page_aliases_inner(&pool, "page-1").await.unwrap();
    assert_eq!(
        aliases,
        vec!["Alpha", "Beta"],
        "persisted aliases should match"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_replaces_existing() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "page-2", "page", "Page Two", None, Some(0)).await;

    // Set initial aliases
    set_page_aliases_inner(&pool, "page-2", vec!["Old1".into(), "Old2".into()])
        .await
        .unwrap();

    // Replace with new aliases
    let inserted = set_page_aliases_inner(
        &pool,
        "page-2",
        vec!["New1".into(), "New2".into(), "New3".into()],
    )
    .await
    .unwrap();

    assert_eq!(inserted.len(), 3, "should insert 3 replacement aliases");

    let aliases = get_page_aliases_inner(&pool, "page-2").await.unwrap();
    assert_eq!(
        aliases,
        vec!["New1", "New2", "New3"],
        "aliases should be fully replaced"
    );

    // Old aliases should be gone
    let resolved = resolve_page_by_alias_inner(&pool, "Old1").await.unwrap();
    assert!(resolved.is_none(), "old alias should no longer resolve");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_skips_empty_and_duplicates() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "page-3", "page", "Page Three", None, Some(0)).await;

    let inserted = set_page_aliases_inner(
        &pool,
        "page-3",
        vec![
            "  ".into(), // whitespace only — skipped
            "".into(),   // empty — skipped
            "Valid".into(),
            "Valid".into(), // duplicate — second insert is ignored
            "  Trimmed  ".into(),
        ],
    )
    .await
    .unwrap();

    // "Valid" appears once, "Trimmed" appears once
    assert_eq!(inserted.len(), 2, "should insert 2 unique aliases");
    assert!(
        inserted.contains(&"Valid".to_string()),
        "should contain Valid"
    );
    assert!(
        inserted.contains(&"Trimmed".to_string()),
        "should contain Trimmed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_aliases_returns_sorted_list() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "page-4", "page", "Page Four", None, Some(0)).await;

    set_page_aliases_inner(
        &pool,
        "page-4",
        vec!["Zulu".into(), "Alpha".into(), "Mike".into()],
    )
    .await
    .unwrap();

    let aliases = get_page_aliases_inner(&pool, "page-4").await.unwrap();
    assert_eq!(
        aliases,
        vec!["Alpha", "Mike", "Zulu"],
        "aliases should be sorted alphabetically"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_by_alias_case_insensitive() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "page-5", "page", "Page Five", None, Some(0)).await;

    set_page_aliases_inner(&pool, "page-5", vec!["MyAlias".into()])
        .await
        .unwrap();

    // Exact case
    let r1 = resolve_page_by_alias_inner(&pool, "MyAlias").await.unwrap();
    assert!(r1.is_some(), "exact alias should resolve");
    let (pid, title) = r1.unwrap();
    assert_eq!(pid, "page-5", "resolved page id should match");
    assert_eq!(
        title.as_deref(),
        Some("Page Five"),
        "resolved page title should match"
    );

    // Different case
    let r2 = resolve_page_by_alias_inner(&pool, "myalias").await.unwrap();
    assert!(r2.is_some(), "lowercase alias should resolve");
    assert_eq!(
        r2.unwrap().0,
        "page-5",
        "lowercase should resolve to same page"
    );

    let r3 = resolve_page_by_alias_inner(&pool, "MYALIAS").await.unwrap();
    assert!(r3.is_some(), "uppercase alias should resolve");
    assert_eq!(
        r3.unwrap().0,
        "page-5",
        "uppercase should resolve to same page"
    );

    // Non-existent alias
    let r4 = resolve_page_by_alias_inner(&pool, "NoSuchAlias")
        .await
        .unwrap();
    assert!(r4.is_none(), "non-existent alias should return None");
}

// ======================================================================
// export_page_markdown (#519)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_basic() {
    let (pool, _dir) = test_pool().await;

    // Create a page with two child content blocks
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "My Test Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "First block",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK2",
        "content",
        "Second block with **bold**",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(2),
    )
    .await;

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    // Title as h1
    assert!(
        md.starts_with("# My Test Page\n\n"),
        "should start with h1 title"
    );
    // Block content present
    assert!(md.contains("First block\n"), "should contain first block");
    // Markdown formatting preserved
    assert!(
        md.contains("Second block with **bold**\n"),
        "should preserve markdown formatting"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_resolves_tag_ulids() {
    let (pool, _dir) = test_pool().await;

    // Create a tag block
    insert_block(
        &pool,
        "01TAG00000000000000000TAG1",
        "tag",
        "rust",
        None,
        Some(1),
    )
    .await;

    // Create a page with a content block that references the tag
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "Tagged Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "Learning #[01TAG00000000000000000TAG1] today",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    assert!(
        md.contains("Learning #rust today"),
        "tag ULID should be replaced with #tagname, got: {md}"
    );
    assert!(
        !md.contains("01TAG00000000000000000TAG1"),
        "raw ULID should not appear in output"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_resolves_page_link_ulids() {
    let (pool, _dir) = test_pool().await;

    // Create a target page
    insert_block(
        &pool,
        "01LINKPAGE000000000000LNK1",
        "page",
        "Linked Page",
        None,
        Some(1),
    )
    .await;

    // Create the main page with a content block that links to the target
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "Source Page",
        None,
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "See also [[01LINKPAGE000000000000LNK1]] for details",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    assert!(
        md.contains("See also [[Linked Page]] for details"),
        "page link ULID should be replaced with [[Page Title]], got: {md}"
    );
    assert!(
        !md.contains("01LINKPAGE000000000000LNK1"),
        "raw ULID should not appear in output"
    );
}

// ======================================================================
// import_markdown — Logseq/Markdown import (#660)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_creates_page_and_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let content = "- Block 1\n  - Child 1\n  - Child 2\n- Block 2";
    let result =
        import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TestPage.md".into()))
            .await
            .unwrap();

    assert_eq!(
        result.page_title, "TestPage",
        "page title should match filename"
    );
    assert_eq!(
        result.blocks_created, 4,
        "should create 4 blocks from markdown"
    );
    assert!(
        result.warnings.is_empty(),
        "import should produce no warnings"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_handles_properties() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Task\n  priority:: 1\n  status:: done";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), Some("Props.md".into()))
        .await
        .unwrap();

    assert_eq!(
        result.blocks_created, 1,
        "should create 1 block with properties"
    );
    assert_eq!(result.properties_set, 2, "should set 2 properties");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_strips_block_refs() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let content = "- See ((abc-123-def)) for details";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), None)
        .await
        .unwrap();

    assert_eq!(
        result.blocks_created, 1,
        "should create 1 block after stripping refs"
    );
    assert_eq!(
        result.page_title, "Imported Page",
        "default page title should be used"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_empty_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = import_markdown_inner(&pool, DEV, &mat, "".into(), Some("Empty.md".into()))
        .await
        .unwrap();

    assert_eq!(
        result.page_title, "Empty",
        "page title should derive from filename"
    );
    assert_eq!(
        result.blocks_created, 0,
        "empty content should create no blocks"
    );

    mat.shutdown();
}

/// P-19: Verify that `import_markdown_inner` runs all block + property
/// writes inside a single transaction by checking that:
/// 1. All blocks are present in the DB after a successful import.
/// 2. All properties are persisted correctly.
/// 3. The op_log contains the expected number of entries.
/// 4. Parent-child hierarchy is correct.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_single_transaction() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Parent block\n  priority:: 1\n  status:: active\n  - Child A\n  - Child B\n    - Grandchild";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TxTest.md".into()))
        .await
        .unwrap();

    // Basic import stats
    assert_eq!(result.page_title, "TxTest");
    assert_eq!(result.blocks_created, 4, "should create 4 blocks");
    assert_eq!(result.properties_set, 2, "should set 2 properties");
    assert!(result.warnings.is_empty(), "should have no warnings");

    // Verify page exists
    let page: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE block_type = 'page' AND content = 'TxTest'"#
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(page.is_some(), "page block must exist");
    let page = page.unwrap();

    // Verify all content blocks exist under the page hierarchy
    let all_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE block_type = 'content' ORDER BY position"#
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(all_blocks.len(), 4, "should have 4 content blocks in DB");

    // Verify parent-child: "Parent block" is child of page
    let parent_block = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Parent block"))
        .expect("Parent block must exist");
    assert_eq!(
        parent_block.parent_id.as_deref(),
        Some(page.id.as_str()),
        "Parent block should be child of the page"
    );

    // Verify child: "Child A" has parent = "Parent block"
    let child_a = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Child A"))
        .expect("Child A must exist");
    assert_eq!(
        child_a.parent_id.as_deref(),
        Some(parent_block.id.as_str()),
        "Child A should be child of Parent block"
    );

    // Verify grandchild: "Grandchild" has parent = "Child B"
    let child_b = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Child B"))
        .expect("Child B must exist");
    let grandchild = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Grandchild"))
        .expect("Grandchild must exist");
    assert_eq!(
        grandchild.parent_id.as_deref(),
        Some(child_b.id.as_str()),
        "Grandchild should be child of Child B"
    );

    // Verify properties were persisted
    // "priority" is a reserved key stored in blocks.priority column
    let refreshed_parent: BlockRow = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ?"#,
        parent_block.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        refreshed_parent.priority.as_deref(),
        Some("1"),
        "priority reserved property should be in blocks.priority"
    );

    // "status" is a custom property stored in block_properties
    let props: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value_text FROM block_properties WHERE block_id = ? ORDER BY key",
    )
    .bind(&parent_block.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(props.len(), 1, "parent block should have 1 custom property");
    assert_eq!(props[0].0, "status");
    assert_eq!(props[0].1, "active");

    // Verify op_log entries: 1 page + 4 blocks + 2 properties = 7 ops
    let op_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        op_count.0, 7,
        "op_log should have 7 entries (1 page + 4 blocks + 2 properties)"
    );

    mat.shutdown();
}

// ======================================================================
// list_page_links (F-33)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_returns_edges_between_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 2 pages
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
    mat.flush_background().await.unwrap();
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
    mat.flush_background().await.unwrap();

    // Create a content block under p1 that links to p2
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
    mat.flush_background().await.unwrap();

    // Insert block_links entry manually (content block b1 → page p2)
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();

    // Should have at least one link: p1 → p2 (rolled up from b1 → p2)
    let p1_to_p2 = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(
        p1_to_p2.is_some(),
        "should find link from page 1 to page 2 (rolled up from content block)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_deleted_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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
    mat.flush_background().await.unwrap();
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
    mat.flush_background().await.unwrap();

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
    mat.flush_background().await.unwrap();

    // Insert block_links entry manually
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    // Delete p2
    delete_block_inner(&pool, DEV, &mat, p2.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();
    let has_deleted = links.iter().any(|l| l.target_id == p2.id);
    assert!(!has_deleted, "should not include links to deleted pages");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_self_links() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p1 = create_block_inner(
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
    mat.flush_background().await.unwrap();

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
    mat.flush_background().await.unwrap();

    // Insert self-referential block_links entry
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
        "should not include self-referential links"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_empty_when_no_links() {
    let (pool, _dir) = test_pool().await;
    let links = list_page_links_inner(&pool).await.unwrap();
    assert!(links.is_empty(), "should return empty when no links exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_deduplicates_multiple_content_links() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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
    mat.flush_background().await.unwrap();
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
    mat.flush_background().await.unwrap();

    // Create 2 content blocks under p1, both linking to p2
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
    mat.flush_background().await.unwrap();

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
    mat.flush_background().await.unwrap();

    // Insert block_links entries for both content blocks → p2
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

    // Both b1 and b2 roll up to p1 → p2; GROUP BY should collapse to 1 edge
    let p1_to_p2_count = links
        .iter()
        .filter(|l| l.source_id == p1.id && l.target_id == p2.id)
        .count();
    assert_eq!(
        p1_to_p2_count, 1,
        "GROUP BY should deduplicate multiple content blocks linking to the same target page"
    );

    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id)
        .unwrap();
    assert_eq!(
        edge.ref_count, 2,
        "ref_count should be 2 for two content blocks linking to the same target page"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_single_link_has_ref_count_one() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p1 = create_block_inner(
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
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
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
    mat.flush_background().await.unwrap();

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
    mat.flush_background().await.unwrap();

    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool).await.unwrap();
    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id)
        .unwrap();
    assert_eq!(
        edge.ref_count, 1,
        "single content block link should have ref_count 1"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_links_with_deleted_parent_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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
    mat.flush_background().await.unwrap();
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
    mat.flush_background().await.unwrap();

    // Create a content block under p1 that links to p2
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
    mat.flush_background().await.unwrap();

    // Insert block_links entry
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify link exists before deletion
    let links_before = list_page_links_inner(&pool).await.unwrap();
    let has_link = links_before
        .iter()
        .any(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(has_link, "link should exist before deleting source page");

    // Soft-delete the SOURCE page (p1)
    delete_block_inner(&pool, DEV, &mat, p1.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let links_after = list_page_links_inner(&pool).await.unwrap();
    let has_deleted_source = links_after.iter().any(|l| l.source_id == p1.id);
    assert!(
        !has_deleted_source,
        "should not include links from a deleted parent page"
    );

    mat.shutdown();
}

// ======================================================================
// CTE oracle: verify optimized list_page_links query matches the original
// ======================================================================

/// Original (pre-P-15) query preserved as a correctness oracle.
/// Runs the old SQL and returns sorted results for comparison.
async fn list_page_links_oracle(pool: &SqlitePool) -> Vec<PageLink> {
    let mut rows = sqlx::query_as::<_, PageLink>(
        "SELECT
            COALESCE(sb.parent_id, bl.source_id) AS source_id,
            bl.target_id AS target_id,
            COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id AND sb.deleted_at IS NULL
         JOIN blocks tb ON tb.id = bl.target_id AND tb.deleted_at IS NULL AND tb.block_type = 'page'
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
         AND (sb.parent_id IS NULL OR (pb.deleted_at IS NULL AND pb.block_type = 'page'))
         GROUP BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    rows.sort();
    rows
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_optimized_matches_oracle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // -- Set up a non-trivial graph covering all edge-case branches --

    // 3 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Alpha".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Beta".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let p3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Gamma".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Content blocks under p1
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link to beta [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link to gamma [[{}]]", p3.id),
        Some(p1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Content block under p2 linking to p3
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("cross link [[{}]]", p3.id),
        Some(p2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Self-link: content under p1 linking back to p1 (should be excluded)
    let b4 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("self [[{}]]", p1.id),
        Some(p1.id.clone()),
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Duplicate content blocks linking to same target (tests DISTINCT)
    let b5 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("also beta [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(4),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Direct page-to-page link (source is itself a page, no parent rollup)
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&p2.id)
        .bind(&p1.id)
        .execute(&pool)
        .await
        .unwrap();

    // Insert all content block links
    for (src, tgt) in [
        (&b1.id, &p2.id),
        (&b2.id, &p3.id),
        (&b3.id, &p3.id),
        (&b4.id, &p1.id),
        (&b5.id, &p2.id),
    ] {
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }

    // -- Compare optimized vs oracle --
    let mut optimized = list_page_links_inner(&pool).await.unwrap();
    optimized.sort();

    let oracle = list_page_links_oracle(&pool).await;

    assert_eq!(
        optimized, oracle,
        "P-15 optimized query must match original oracle.\n  optimized: {optimized:?}\n  oracle:    {oracle:?}"
    );

    // Sanity: we should have some links
    assert!(
        !optimized.is_empty(),
        "test should produce at least one page link"
    );

    mat.shutdown();
}

// ======================================================================
// page_id tests (FEAT-1)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_sets_page_id_self_for_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        page.page_id.as_deref(),
        Some(page.id.as_str()),
        "page block's page_id should be its own id"
    );

    // Verify via direct DB read
    let fetched = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(fetched.page_id.as_deref(), Some(page.id.as_str()));

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_sets_page_id_for_content_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent Page".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        child.page_id.as_deref(),
        Some(page.id.as_str()),
        "content block's page_id should be the parent page's id"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_updates_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    let page_b = create_block_inner(&pool, DEV, &mat, "page".into(), "Page B".into(), None, None)
        .await
        .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "movable".into(),
        Some(page_a.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(child.page_id.as_deref(), Some(page_a.id.as_str()));

    // Move child to page_b
    move_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();

    let fetched = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        fetched.page_id.as_deref(),
        Some(page_b.id.as_str()),
        "page_id should update after move"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_updates_descendants_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    let page_b = create_block_inner(&pool, DEV, &mat, "page".into(), "Page B".into(), None, None)
        .await
        .unwrap();
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
    let grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(grandchild.page_id.as_deref(), Some(page_a.id.as_str()));

    // Move parent to page_b
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

    let fetched_grandchild = get_block_inner(&pool, grandchild.id.clone()).await.unwrap();
    assert_eq!(
        fetched_grandchild.page_id.as_deref(),
        Some(page_b.id.as_str()),
        "descendants' page_id should update after move"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_page_ids_restores_correct_values() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "RebuildTest".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();

    // Corrupt page_id by setting it to NULL
    sqlx::query("UPDATE blocks SET page_id = NULL")
        .execute(&pool)
        .await
        .unwrap();

    // Run rebuild
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let fetched_page = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(fetched_page.page_id.as_deref(), Some(page.id.as_str()));

    let fetched_child = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(fetched_child.page_id.as_deref(), Some(page.id.as_str()));

    mat.shutdown();
}
