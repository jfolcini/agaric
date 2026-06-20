use super::*;

#[tokio::test]
async fn dispatch_op_create_block_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "My page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "page", "block_type should be page");
    assert_eq!(row.1, "My page", "content should match created page title");
}
#[tokio::test]
async fn dispatch_op_create_block_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-tag"),
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
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "tag", "block_type should be tag");
    assert_eq!(row.1, "urgent", "content should match created tag name");
}
#[tokio::test]
async fn dispatch_op_create_block_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-c"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "just content".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-C'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "content", "block_type should be content");
    assert_eq!(
        row.1, "just content",
        "content should match created block text"
    );
}
#[tokio::test]
async fn dispatch_op_edit_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-2", "content", "original").await;
    make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "original".into(),
        }),
    )
    .await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            to_text: "edited".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>("SELECT content FROM blocks WHERE id = 'BLK-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "edited", "content should be updated after EditBlock");
}
#[tokio::test]
async fn dispatch_op_delete_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-3", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-3"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<i64>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-3'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_some(),
        "deleted_at should be set after DeleteBlock"
    );
}
#[tokio::test]
async fn dispatch_op_restore_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-R", "content", "was deleted").await;
    soft_delete_block_direct(&pool, "BLK-R").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("blk-r"),
            deleted_at_ref: FIXED_TS,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-R'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_none(),
        "deleted_at should be NULL after RestoreBlock"
    );
}
#[tokio::test]
async fn dispatch_op_purge_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-P", "content", "to purge").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("blk-p"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'BLK-P'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "block should be gone after PurgeBlock");
}
#[tokio::test]
async fn dispatch_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-4", "content", "tagged block").await;
    insert_block_direct(&pool, "TAG-1", "tag", "my-tag").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("blk-4"),
            tag_id: BlockId::test_id("tag-1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-4' AND tag_id = 'TAG-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 1, "block_tags row should exist after AddTag");
}
#[tokio::test]
async fn dispatch_op_remove_tag() {
    use crate::op::RemoveTagPayload;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-RT", "content", "rt block").await;
    insert_block_direct(&pool, "TAG-99", "tag", "rm-tag").await;
    insert_block_tag(&pool, "BLK-RT", "TAG-99").await;
    let r = make_op_record(
        &pool,
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("blk-rt"),
            tag_id: BlockId::test_id("tag-99"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-RT' AND tag_id = 'TAG-99'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "block_tags row should be gone after RemoveTag");
}
#[tokio::test]
async fn dispatch_op_set_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-5", "content", "prop block").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("blk-5"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-01-15".into()),
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT value_date FROM block_properties WHERE block_id = 'BLK-5' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0, "2025-01-15",
        "value_date should match the set property date"
    );
}
#[tokio::test]
async fn dispatch_op_delete_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-DP", "content", "dp block").await;
    insert_property_date(&pool, "BLK-DP", "due", "2025-01-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("blk-dp"),
            key: "due".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-DP' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "property should be gone after DeleteProperty");
}

/// #802 regression: the engine-less SQL-only fallback for `SetProperty`
/// had no arm for the column-backed `space` key (#533) — the op fell into
/// the generic `block_properties` INSERT and aborted on migration 0088's
/// `key_not_reserved` CHECK. The fallback now delegates to the same
/// projection the via-loro path uses, so a `space` op routes to
/// `blocks.space_id` for the whole owning-page group.
///
/// The SQL-only path is reached here because the target page has no
/// `space_id` yet (`resolve_block_space` → None) — exactly the degraded
/// replay shape the fallback exists for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_op_set_property_space_sql_only_802() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // A registered space — the 0089 `spaces_register_is_space` trigger
    // fires on the `is_space = 'true'` property row.
    insert_block_direct(&pool, "SPACE-802", "page", "the space").await;
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) \
         VALUES ('SPACE-802', 'is_space', 'true')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // A page plus one member block in its page group.
    insert_block_direct(&pool, "PAGE-802", "page", "the page").await;
    insert_block_direct(&pool, "CHILD-802", "content", "member").await;
    sqlx::query(
        "UPDATE blocks SET parent_id = 'PAGE-802', page_id = 'PAGE-802' WHERE id = 'CHILD-802'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let set = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("page-802"),
            key: "space".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::test_id("space-802")),
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&set).await.expect(
        "#802: engine-less SetProperty(space) must not abort on the 0088 reserved-key CHECK",
    );
    mat.flush_foreground().await.unwrap();

    // The op landed on the column, for the whole page group …
    let spaces: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, space_id FROM blocks WHERE id IN ('PAGE-802', 'CHILD-802') ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        spaces,
        vec![
            ("CHILD-802".to_string(), Some("SPACE-802".to_string())),
            ("PAGE-802".to_string(), Some("SPACE-802".to_string())),
        ],
        "SetProperty(space) must stamp blocks.space_id for the page group"
    );
    // … and never as a block_properties row (the 0088 invariant).
    let prop_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE key = 'space'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        prop_rows, 0,
        "the space key is column-backed only — no block_properties row"
    );

    // Parity: the engine-less DeleteProperty(space) clears the column for
    // the page group (the old inline body silently no-op'd here).
    let del = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("page-802"),
            key: "space".into(),
        }),
    )
    .await;
    mat.dispatch_op(&del)
        .await
        .expect("engine-less DeleteProperty(space) must succeed");
    mat.flush_foreground().await.unwrap();
    let cleared: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT space_id FROM blocks WHERE id IN ('PAGE-802', 'CHILD-802') ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        cleared,
        vec![None, None],
        "DeleteProperty(space) must clear blocks.space_id for the page group"
    );

    mat.shutdown();
}

/// #802 guard: a `SetProperty(space)` whose target is NOT a registered
/// space must be skipped (warn) on the SQL-only path too — mirroring the
/// #708 degrade contract of the via-loro projection — instead of tripping
/// the 0089 `blocks.space_id → spaces(id)` FK and wedging replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_op_set_property_space_sql_only_skips_unregistered_target_802() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block_direct(&pool, "NOT-A-SPACE", "page", "no is_space flag").await;
    insert_block_direct(&pool, "PAGE-802B", "page", "the page").await;

    let set = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("page-802b"),
            key: "space".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::test_id("not-a-space")),
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&set)
        .await
        .expect("an unregistered space target must be skipped, not an FK abort (#708 contract)");
    mat.flush_foreground().await.unwrap();

    let sid: Option<String> =
        sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'PAGE-802B'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        sid, None,
        "a dangling/mis-stamped space target must leave space_id untouched"
    );

    mat.shutdown();
}

#[tokio::test]
async fn dispatch_op_move_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-PARENT", "page", "parent page").await;
    insert_block_direct(&pool, "BLK-6", "content", "child block").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("blk-6"),
            new_parent_id: Some(BlockId::test_id("blk-parent")),
            new_position: 2,
            new_index: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (Option<String>, i64)>(
        "SELECT parent_id, position FROM blocks WHERE id = 'BLK-6'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0.as_deref(),
        Some("BLK-PARENT"),
        "parent_id should be set after MoveBlock"
    );
    assert_eq!(row.1, 2, "position should be updated after MoveBlock");
}
#[tokio::test]
async fn dispatch_op_add_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-A", "content", "attachment block").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-1"),
            block_id: BlockId::test_id("blk-a"),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    // AttachmentId (BlockId alias) auto-uppercases on construction, so
    // the materializer writes 'ATT-1' regardless of input casing.
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT filename, mime_type FROM attachments WHERE id = 'ATT-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "photo.png", "filename should match added attachment");
    assert_eq!(
        row.1, "image/png",
        "mime_type should match added attachment"
    );
}
#[tokio::test]
async fn dispatch_op_delete_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-ATT-DEL", "content", "att block").await;
    // Store the row with the canonical-uppercase id so it matches the
    // bind value the materializer derives from the auto-normalized
    // AttachmentId in the payload.
    sqlx::query("INSERT INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) VALUES ('ATT-2', 'BLK-ATT-DEL', 'f.txt', '/tmp/f.txt', 'text/plain', 10, 1735689600000)")
        .execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-2"),
            fs_path: "/tmp/f.txt".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM attachments WHERE id = 'ATT-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "attachment should be gone after DeleteAttachment");
}
#[tokio::test]
async fn dispatch_op_unknown_op_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let blocks_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        mat.dispatch_op(&fake_op_record("unknown_future_op", "{}"))
            .await
            .is_ok(),
        "unknown op type should not cause an error"
    );
    let blocks_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks_before, blocks_after,
        "unknown op_type must not mutate blocks"
    );
}
#[tokio::test]
async fn dispatch_background_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-bg"),
            to_text: "edited bg".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
#[tokio::test]
async fn dispatch_background_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-db"),
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
