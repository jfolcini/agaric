use super::*;

#[tokio::test]
async fn tags_cache_after_create_tag() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_FLUSH_1", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_FLUSH_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT name, usage_count FROM tags_cache WHERE tag_id = 'TAG_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "tags_cache should have a row for the created tag"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("name"),
        "urgent",
        "tag name in cache should match created tag"
    );
    assert_eq!(
        row.get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 for a new tag with no references"
    );
}
#[tokio::test]
async fn pages_cache_after_create_page() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAGE_FLUSH_1", "page", "My Test Page").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("PAGE_FLUSH_1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "My Test Page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT title FROM pages_cache WHERE page_id = 'PAGE_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "pages_cache should have a row for the created page"
    );
    assert_eq!(
        row.unwrap().get::<String, _>("title"),
        "My Test Page",
        "page title in cache should match created page"
    );
}

#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_refreshes_derived_caches() {
    // #4: after an inbound sync writes the per-block SQL
    // projection, the orchestrator enqueues this fan-out so the read-path
    // derived caches + FTS converge to the imported state. Seed a tag, a
    // page, and a content block directly (as `apply_remote`'s per-block
    // projection would), run the fan-out, and assert each corresponding
    // cache was rebuilt.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "SYNC_TAG_1", "tag", "synced-tag").await;
    insert_block_direct(&pool, "SYNC_PAGE_1", "page", "Synced Page").await;
    insert_block_direct(&pool, "SYNC_NOTE_1", "content", "searchable inbound text").await;

    // #421: FTS is now driven from the changed-block set (per-block
    // `UpdateFtsBlock` for a small incremental import). Pass the seeded ids.
    let changed = [
        crate::ulid::BlockId::test_id("SYNC_TAG_1"),
        crate::ulid::BlockId::test_id("SYNC_PAGE_1"),
        crate::ulid::BlockId::test_id("SYNC_NOTE_1"),
    ];
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    mat.flush_background().await.expect("flush background");

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'SYNC_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(tag_rows, 1, "RebuildTagsCache ran for the synced tag block");

    let page_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = 'SYNC_PAGE_1'")
            .fetch_one(&pool)
            .await
            .expect("count pages_cache");
    assert_eq!(
        page_rows, 1,
        "RebuildPagesCache ran for the synced page block"
    );

    let fts_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = 'SYNC_NOTE_1'")
            .fetch_one(&pool)
            .await
            .expect("count fts_blocks");
    assert_eq!(
        fts_rows, 1,
        "RebuildFtsIndex ran for the synced content block"
    );
}

/// #2264: a complete no-op inbound import (changed AND purged both empty —
/// a redelivered / echoed delta) must enqueue NOTHING: nothing was
/// projected, so every derived cache is already consistent. Observable via
/// a seeded tag block whose `tags_cache` row would appear iff
/// `RebuildTagsCache` ran.
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_noop_import_enqueues_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "NOOP_TAG_1", "tag", "would-be-cached").await;

    mat.enqueue_inbound_sync_rebuilds(&[], &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    mat.flush_background().await.expect("flush background");

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'NOOP_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(
        tag_rows, 0,
        "a no-op inbound import must not enqueue any cache rebuild"
    );
}

/// #2264: a purge-ONLY inbound import (changed empty, purged non-empty)
/// must still fan out — Pass D removed base-table rows and the aggregate
/// caches only converge through these rebuilds.
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_purge_only_import_still_fans_out() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "PURGE_TAG_1", "tag", "still-cached").await;

    let purged = [crate::ulid::BlockId::test_id("GONE_BLOCK_1")];
    mat.enqueue_inbound_sync_rebuilds(&[], &purged)
        .await
        .expect("enqueue inbound sync rebuilds");
    mat.flush_background().await.expect("flush background");

    let tag_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache WHERE tag_id = 'PURGE_TAG_1'")
            .fetch_one(&pool)
            .await
            .expect("count tags_cache");
    assert_eq!(
        tag_rows, 1,
        "a purge-only inbound import must still run the derived-cache fan-out"
    );
}

/// #2265: the inbound fan-out must NOT rebuild `block_tag_inherited` (that
/// cache is refreshed synchronously — and scoped — by `import_and_project`
/// before the fan-out is enqueued), while #2264 keeps `RebuildPageIds` so a
/// moved subtree's descendants converge on their new `page_id`.
///
/// Seed a shape where both a global tag-inheritance rebuild and a page-id
/// rebuild WOULD write rows: a page → parent(tagged) → child chain with the
/// child's `page_id` left NULL (as after an inbound structural move). After
/// the fan-out: `page_id` is repaired (RebuildPageIds retained) but no
/// inherited row appears (RebuildTagInheritanceCache dropped).
#[tokio::test]
async fn enqueue_inbound_sync_rebuilds_skips_tag_inheritance_but_rebuilds_page_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "INH_PAGE_1", "page", "Inh Page").await;
    insert_block_direct(&pool, "INH_TAG_1", "tag", "inh-tag").await;
    insert_block_direct(&pool, "INH_PARENT_1", "content", "parent").await;
    insert_block_direct(&pool, "INH_CHILD_1", "content", "child").await;
    sqlx::query("UPDATE blocks SET parent_id = 'INH_PAGE_1', page_id = 'INH_PAGE_1' WHERE id = 'INH_PARENT_1'")
        .execute(&pool)
        .await
        .unwrap();
    // Child hangs off the parent but its page_id is stale (NULL), as after
    // an inbound move whose per-block projection touched only the moved
    // block's own row.
    sqlx::query("UPDATE blocks SET parent_id = 'INH_PARENT_1' WHERE id = 'INH_CHILD_1'")
        .execute(&pool)
        .await
        .unwrap();
    insert_block_tag(&pool, "INH_PARENT_1", "INH_TAG_1").await;

    let changed = [crate::ulid::BlockId::test_id("INH_CHILD_1")];
    mat.enqueue_inbound_sync_rebuilds(&changed, &[])
        .await
        .expect("enqueue inbound sync rebuilds");
    mat.flush_background().await.expect("flush background");

    let child_page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'INH_CHILD_1'")
            .fetch_one(&pool)
            .await
            .expect("read child page_id");
    assert_eq!(
        child_page_id.as_deref(),
        Some("INH_PAGE_1"),
        "RebuildPageIds must be retained in the inbound fan-out (descendants' \
         page_id after an inbound move)"
    );

    let inherited_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited WHERE block_id = 'INH_CHILD_1'",
    )
    .fetch_one(&pool)
    .await
    .expect("count block_tag_inherited");
    assert_eq!(
        inherited_rows, 0,
        "the inbound fan-out must not rebuild block_tag_inherited — \
         import_and_project already refreshed it synchronously (scoped)"
    );
}

#[tokio::test]
async fn tags_cache_after_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_DEL_1", "tag", "to-delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "to-delete".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_some(),
        "tag should exist in cache before deletion"
    );
    soft_delete_block_direct(&pool, "TAG_DEL_1").await;
    let del = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&del).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "tag should be removed from cache after deletion"
    );
}
#[tokio::test]
async fn tags_usage_count() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_USE_1", "tag", "important").await;
    insert_block_direct(&pool, "BLK_USE_1", "content", "some note").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_USE_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "important".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 before any tag is applied"
    );
    insert_block_tag(&pool, "BLK_USE_1", "TAG_USE_1").await;
    let add = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("BLK_USE_1"),
            tag_id: BlockId::test_id("TAG_USE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&add).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        1,
        "usage_count should be 1 after adding tag to one block"
    );
}
#[tokio::test]
async fn agenda_cache_after_set_property() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK_AGD_1", "content", "task").await;
    insert_property_date(&pool, "BLK_AGD_1", "due", "2025-03-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_AGD_1"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-03-15".into()),
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT date, source FROM agenda_cache WHERE block_id = 'BLK_AGD_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "agenda_cache should have a row after setting a date property"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("date"),
        "2025-03-15",
        "agenda date should match the set property value"
    );
    assert_eq!(
        row.get::<String, _>("source"),
        "property:due",
        "agenda source should indicate the property key"
    );
}
