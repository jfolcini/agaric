use super::super::*;
use super::common::*;
use crate::draft;
use crate::soft_delete;

// ======================================================================
// create_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_returns_correct_fields_and_persists() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(resp.block_type, "content", "block_type should match input");
    assert_eq!(
        resp.content,
        Some("hello world".into()),
        "content should match input"
    );
    assert!(resp.parent_id.is_none(), "top-level block has no parent");
    assert_eq!(resp.position, Some(1), "position should match input");
    assert!(resp.deleted_at.is_none(), "new block should not be deleted");

    // Verify persistence in DB via direct query
    let row = get_block_inner(&pool, resp.id.clone().into_string())
        .await
        .unwrap();
    assert_eq!(row.id, resp.id, "DB row should match response ID");
    assert_eq!(
        row.block_type, "content",
        "DB block_type should be persisted"
    );
    assert_eq!(
        row.content,
        Some("hello world".into()),
        "DB content should be persisted"
    );
    assert_eq!(row.position, Some(1), "DB position should be persisted");
    assert!(
        row.deleted_at.is_none(),
        "DB row should not be soft-deleted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_generates_valid_ulid() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
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

    assert_eq!(
        resp.id.as_str().len(),
        26,
        "ULID should be 26 Crockford base32 characters"
    );
    assert!(
        resp.id.as_str().chars().all(|c| c.is_ascii_alphanumeric()),
        "ULID should only contain alphanumeric characters"
    );
    assert!(
        BlockId::from_string(resp.id.as_str()).is_ok(),
        "response ID should parse as a valid ULID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_parent_sets_parent_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(
        child.parent_id,
        Some(parent.id),
        "child.parent_id should match parent's ID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some("NONEXISTENT_PARENT".into()),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent parent"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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

    mat.flush_background().await.unwrap();

    delete_block_inner(&pool, DEV, &mat, parent.id.clone().into_string())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.into_string()),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for deleted parent"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_writes_op_to_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "logged".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'create_block'",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(count, 1, "exactly one create_block op should be logged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_invalid_block_type_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "invalid_type".into(),
        "hello".into(),
        None,
        None,
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error, got: {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_all_valid_types_accepted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    for block_type in &["content", "tag", "page"] {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            block_type.to_string(),
            format!("test {block_type}"),
            None,
            None,
        )
        .await;

        assert!(resp.is_ok(), "block_type '{block_type}' should be accepted");
        assert_eq!(
            resp.unwrap().block_type,
            *block_type,
            "returned block_type should match"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_empty_content_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(&pool, DEV, &mat, "content".into(), "".into(), None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.content,
        Some("".into()),
        "empty content should be stored as-is"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_unicode_content_preserves_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let unicode_content = "Hello 世界! 🌍 Ñoño café résumé";
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        unicode_content.into(),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.content,
        Some(unicode_content.into()),
        "unicode content should be preserved exactly"
    );

    // Also verify round-trip through DB
    let row = get_block_inner(&pool, resp.id.into_string()).await.unwrap();
    assert_eq!(
        row.content,
        Some(unicode_content.into()),
        "DB should preserve unicode content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_rejects_oversized_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
    let result =
        create_block_inner(&pool, DEV, &mat, "content".into(), oversized, None, None).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error for oversized content, got: {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_accepts_content_at_max_length() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
    let result = create_block_inner(&pool, DEV, &mat, "content".into(), at_limit, None, None).await;

    assert!(
        result.is_ok(),
        "content of exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
        result.unwrap_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_position_zero_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(0),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "position=0 should return Validation error, got: {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_position_negative_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(-1),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "position=-1 should return Validation error, got: {err:?}"
    );
}

// ======================================================================
// BUG-1 / H-3a — `create_block_inner_with_space` (IPC tightening)
// ======================================================================
//
// The IPC `create_block` Tauri command delegates to
// `create_block_inner_with_space`, which enforces the FEAT-3
// "every page belongs to a space" invariant at the IPC boundary so a
// misbehaving frontend (e.g. a stale `createBlock({ blockType: 'page' })`
// callsite) cannot leak unscoped pages into the materialized state.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_rejects_page_without_space_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    crate::spaces::bootstrap_spaces(&pool, DEV).await.unwrap();

    let before_ops: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    // `block_type = "page"` AND `scope == Global` → Validation error.
    // The page must NEVER be created, never appended to op_log.
    let result = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Untitled leak".into(),
        None,
        None,
        &SpaceScope::Global, // <-- no space_id
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg))
            if msg.contains("page") && msg.contains("space")),
        "page block without space_id must yield Validation, got {result:?}"
    );

    let after_ops: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        after_ops, before_ops,
        "atomicity: validation failure must NOT append any ops to op_log"
    );

    // No `page` row must have been materialized either.
    let leaked_pages: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND content = 'Untitled leak'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked_pages, 0,
        "no page row must be inserted when validation fails"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_page_and_space_id_emits_two_ops_atomically() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    crate::spaces::bootstrap_spaces(&pool, DEV).await.unwrap();

    let before_ops: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    let block = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Hello space".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(
            crate::spaces::bootstrap::SPACE_PERSONAL_ULID,
        )),
    )
    .await
    .expect("create_block(page, spaceId=Personal) must succeed");

    assert_eq!(block.block_type, "page");
    assert_eq!(block.content.as_deref(), Some("Hello space"));
    assert_eq!(
        block.page_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(block.id.as_str()),
        "page block must materialize page_id = self"
    );

    let after_ops: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        after_ops - before_ops,
        2,
        "exactly two ops must be appended (CreateBlock + SetProperty(space))"
    );

    let per_block: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log WHERE block_id = ?")
            .bind(&block.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        per_block, 2,
        "both appended ops must reference the new page id"
    );

    // The space property is materialized inline by `set_property_in_tx`.
    let space_ref: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
    )
    .bind(&block.id)
    .fetch_optional(&pool)
    .await
    .unwrap()
    .flatten();
    assert_eq!(
        space_ref.as_deref(),
        Some(crate::spaces::bootstrap::SPACE_PERSONAL_ULID),
        "space property must point at the Personal space"
    );

    // The page must surface from `list_blocks(blockType='page', spaceId=Personal)` —
    // the very pagination path PageBrowser uses. Without the space property
    // it would silently disappear (BUG-1 root cause).
    assign_all_to_test_space(&pool).await;
    let page = list_blocks_inner(
        &pool,
        None,
        Some("page".into()),
        None, // tag_id
        None, // agenda_date
        None, // agenda_date_start
        None, // agenda_date_end
        None, // agenda_source
        None, // cursor
        None, // limit
        crate::spaces::bootstrap::SPACE_PERSONAL_ULID.to_string(),
    )
    .await
    .unwrap();
    assert!(
        page.items.iter().any(|b| b.id == block.id.as_str()),
        "newly-created page must surface in scoped list_blocks(page, Personal); got {} items",
        page.items.len(),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_non_page_ignores_space_id() {
    // Other block types pass through to `create_block_inner` unchanged
    // — `space_id` (when supplied) is ignored, no validation error.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    crate::spaces::bootstrap_spaces(&pool, DEV).await.unwrap();

    // First create a page parent so the content block has somewhere to go.
    let page = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(
            crate::spaces::bootstrap::SPACE_PERSONAL_ULID,
        )),
    )
    .await
    .unwrap();

    // Content blocks are unaffected by the `scope` parameter — pass
    // Global or Active, behavior is identical.
    let block = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone().into_string()),
        None,
        &SpaceScope::Global,
    )
    .await
    .expect("content block create must succeed without space_id");
    assert_eq!(block.block_type, "content");
    assert_eq!(block.content.as_deref(), Some("child"));
}

// ======================================================================
// edit_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_updates_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let edited = edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "updated".into(),
    )
    .await
    .unwrap();

    assert_eq!(
        edited.content,
        Some("updated".into()),
        "edited content should reflect new value"
    );

    // Verify in DB
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("updated".into()),
        "DB content should be updated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_sequential_edits_chain_prev_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // First edit
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "v2".into(),
    )
    .await
    .unwrap();

    // Second edit — should have prev_edit pointing to the first edit
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "v3".into(),
    )
    .await
    .unwrap();

    // Check the last op_log entry has prev_edit set
    let row = sqlx::query!(
        "SELECT payload FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
    assert!(
        !payload["prev_edit"].is_null(),
        "prev_edit should be set on second edit"
    );
}

/// PEND-20 B.1 parity: after the rewrite from
/// `json_extract(payload, '$.block_id')` + `ORDER BY created_at DESC`
/// to `block_id = ?` + `ORDER BY (seq DESC, device_id DESC)`,
/// `find_prev_edit_in_tx` must still chain the most-recent edit
/// across multiple edits — this is the same contract the lookup served
/// before the rewrite. Three sequential edits inside one second
/// (`created_at` would tie at millisecond resolution) prove that the
/// new ordering picks the highest-seq edit unambiguously.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_prev_edit_picks_highest_seq_after_b1_rewrite() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "v2".into(),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "v3".into(),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "v4".into(),
    )
    .await
    .unwrap();

    // The op_log holds: 1 create + 3 edit ops. The latest edit's
    // `prev_edit` must reference the second-latest edit, i.e. the op
    // with the second-highest `seq` for this block.
    let rows = sqlx::query!(
        "SELECT seq, payload FROM op_log \
         WHERE block_id = ? AND op_type = 'edit_block' \
         ORDER BY seq DESC",
        created.id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 3, "three edit_block ops expected");

    // Latest op_log row = v4 edit. Its prev_edit must point at the v3 edit.
    // `prev_edit` serializes as a `[device_id, seq]` JSON array
    // (`Option<(String, i64)>`); see `op.rs::edit_block_prev_edit_serializes_as_array_or_null`.
    let latest_payload: serde_json::Value = serde_json::from_str(&rows[0].payload).unwrap();
    let prev_edit = latest_payload["prev_edit"].as_array().expect(
        "PEND-20 B.1: prev_edit must be set after sequential edits, even with native column",
    );
    assert_eq!(prev_edit.len(), 2, "prev_edit is (device_id, seq) tuple");
    let prev_seq = prev_edit[1].as_i64().unwrap();
    assert_eq!(
        prev_seq, rows[1].seq,
        "PEND-20 B.1: prev_edit.seq must point at the second-latest edit (highest-seq predecessor)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "soon deleted".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone().into_string())
        .await
        .unwrap();

    let result = edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.into_string(),
        "should fail".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing a deleted block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_unicode_preserves_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let unicode = "日本語テスト 🎌 über";
    let edited = edit_block_inner(&pool, DEV, &mat, created.id.into_string(), unicode.into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some(unicode.into()),
        "unicode content should survive edit round-trip"
    );
}

// ── edit_block edge cases ───────────────────────────────────────────

/// Editing a block to an empty string must succeed — empty content is
/// valid (e.g. a cleared paragraph before the user types new text).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_empty_to_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "non-empty".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let edited = edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "".into(),
    )
    .await
    .unwrap();

    assert_eq!(
        edited.content,
        Some("".into()),
        "editing to empty string must succeed and store empty content"
    );

    // Verify in DB
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("".into()),
        "empty string must be persisted in DB"
    );
}

/// Editing a block with the exact same content it already has must still
/// succeed (the command layer does not short-circuit on identical content).
/// An op_log entry IS written because the command doesn't diff content —
/// that's a valid design choice for idempotent replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_identical_content_is_noop() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "same text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Count ops before the "no-change" edit
    let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Edit with identical content
    let edited = edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone().into_string(),
        "same text".into(),
    )
    .await
    .unwrap();

    assert_eq!(
        edited.content,
        Some("same text".into()),
        "content must be returned unchanged"
    );

    // The command layer does not diff — an op IS still written
    let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after,
        ops_before + 1,
        "an edit_block op is written even for identical content"
    );

    // Verify DB content is unchanged
    let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.content,
        Some("same text".into()),
        "DB content should remain unchanged"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_rejects_oversized_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block to edit
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
    let result = edit_block_inner(&pool, DEV, &mat, created.id.into_string(), oversized).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "should return Validation error for oversized content, got: {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_accepts_content_at_max_length() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
    let result = edit_block_inner(&pool, DEV, &mat, created.id.into_string(), at_limit).await;

    assert!(
        result.is_ok(),
        "edit with exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
        result.unwrap_err()
    );
}

// ======================================================================
// delete_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_cascades_to_children() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

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
    // Creating a page dispatches background materializer tasks (pages cache
    // rebuild, page_id updates). Wait for them to complete before adding a
    // child — otherwise the child's parent FK resolution can race with the
    // materializer's page-cache transaction and fail intermittently.
    settle(&mat).await;

    let _child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();

    let resp = delete_block_inner(&pool, DEV, &mat, parent.id.into_string())
        .await
        .unwrap();

    assert_eq!(resp.descendants_affected, 2, "parent + child = 2 affected");
    assert!(
        !resp.deleted_at.is_empty(),
        "deleted_at timestamp should be set"
    );

    let op_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'delete_block'",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        op_count, 1,
        "delete_block_inner should append exactly one op regardless of descendant count"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_already_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "delete me".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone().into_string())
        .await
        .unwrap();

    let result = delete_block_inner(&pool, DEV, &mat, created.id.into_string()).await;
    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "second delete should return InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = delete_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "deleting a nonexistent block should return NotFound"
    );
}

/// I-CommandsCRUD-2 regression — block_id arguments must be normalised to
/// uppercase at the SQL boundary. AGENTS.md invariant #8 mandates
/// Crockford-uppercase ULIDs for blake3 hash determinism, but raw `String`
/// args from MCP tools / sync replay / scripted imports can arrive
/// lowercase. SQLite text comparison is byte-exact, so without
/// normalisation the WHERE id = ? lookup would silently miss the row and
/// surface as a confusing `NotFound`. This test inserts an uppercase
/// block, then calls `delete_block_inner` with the lowercase form and
/// expects the call to succeed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_normalises_lowercase_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "BLKNORM01", "content", "lowered", None, Some(1)).await;

    // Pre-fix this would have returned NotFound because SQLite compares
    // 'BLKNORM01' (stored) vs 'blknorm01' (queried) byte-for-byte.
    let resp = delete_block_inner(&pool, DEV, &mat, "blknorm01".into())
        .await
        .expect("lowercase block_id must be normalised to uppercase before SQL lookup");
    assert_eq!(
        resp.block_id, "BLKNORM01",
        "response should echo the canonical uppercase id"
    );

    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "BLKNORM01")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        row.deleted_at.is_some(),
        "block should be soft-deleted after the lowercase delete call"
    );
}

// ======================================================================
// restore_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_restores_block_and_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Use direct inserts for setup to avoid materializer write contention
    insert_block(&pool, "RST_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "RST_CHD",
        "content",
        "child",
        Some("RST_PAR"),
        Some(1),
    )
    .await;

    // Cascade soft-delete directly
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, &mat, DEV, "RST_PAR")
        .await
        .unwrap();

    let rest_resp = restore_block_inner(&pool, DEV, &mat, "RST_PAR".into(), ts)
        .await
        .unwrap();

    assert_eq!(rest_resp.restored_count, 2, "parent + child restored");

    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "RST_PAR")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        row.deleted_at.is_none(),
        "parent should no longer be deleted after restore"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_not_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ALIVE01", "content", "alive", None, Some(1)).await;

    let result = restore_block_inner(&pool, DEV, &mat, "ALIVE01".into(), FIXED_TS.into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "restoring a non-deleted block should return InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = restore_block_inner(&pool, DEV, &mat, "GHOST".into(), FIXED_TS.into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring a nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_mismatched_deleted_at_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MISMATCH1", "content", "test", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, &mat, DEV, "MISMATCH1")
        .await
        .unwrap();

    let wrong_ts = format!("{ts}_wrong");
    let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH1".into(), wrong_ts).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "mismatched deleted_at should return InvalidOperation, got: {err:?}"
    );
}

// ======================================================================
// purge_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_physically_removes_from_db() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE1", "content", "doomed", None, Some(1)).await;

    // Soft-delete first (purge requires prior soft-delete)
    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "PURGE1")
        .await
        .unwrap();

    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE1".into())
        .await
        .unwrap();

    assert_eq!(
        resp.purged_count, 1,
        "single block should have purged_count=1"
    );

    let exists = sqlx::query!(r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ?"#, "PURGE1")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        exists.is_none(),
        "block should be physically gone after purge"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = purge_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "purging a nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_not_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE_ALIVE", "content", "alive", None, Some(1)).await;

    let result = purge_block_inner(&pool, DEV, &mat, "PURGE_ALIVE".into()).await;
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "purging a non-deleted block should return InvalidOperation, got: {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_inner_cleans_page_aliases() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(
        &pool,
        "PURGE_PA_CMD",
        "page",
        "page with alias",
        None,
        Some(1),
    )
    .await;
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_PA_CMD")
        .bind("my-alias")
        .execute(&pool)
        .await
        .unwrap();

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_CMD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "alias should exist before purge");

    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "PURGE_PA_CMD")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_PA_CMD".into())
        .await
        .unwrap();

    let alias_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_CMD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        alias_count, 0,
        "page_aliases should be cleaned after purge_block_inner"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_inner_cleans_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PURGE_PAC_CMD", "content", "task", None, Some(1)).await;
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_PAC_CMD")
    .bind("2025-06-15")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_CMD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "projected_agenda_cache row should exist before purge"
    );

    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "PURGE_PAC_CMD")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_PAC_CMD".into())
        .await
        .unwrap();

    let cache_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_CMD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cache_count, 0,
        "projected_agenda_cache should be cleaned after purge_block_inner"
    );
}

// ======================================================================
// PEND-35 Tier 2.2 — restore_blocks_by_ids / purge_blocks_by_ids
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_clears_deleted_at_for_n_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed N=4 independently soft-deleted top-level blocks. Different
    // `deleted_at` values stress the multi-root semantic — the "all"
    // variant's roots-share-timestamp shortcut does not apply here.
    for i in 0..4 {
        let id = format!("RBBI{i:03}");
        insert_block(&pool, &id, "content", "rbbi", None, Some(1)).await;
        soft_delete::cascade_soft_delete(&pool, &mat, DEV, &id)
            .await
            .unwrap();
    }

    let ids: Vec<String> = (0..4).map(|i| format!("RBBI{i:03}")).collect();
    let resp = restore_blocks_by_ids_inner(&pool, DEV, &mat, ids.clone())
        .await
        .unwrap();

    assert_eq!(resp.affected_count, 4, "all 4 roots should restore");

    for id in &ids {
        let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.deleted_at.is_none(),
            "block {id} should no longer be soft-deleted"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_restores_descendants_too() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Two roots, each with a child — cascade-deleted as a single subtree
    // per root. The batch restore should clear `deleted_at` on parents
    // AND children for both roots.
    insert_block(&pool, "RBBIPAR1", "page", "p1", None, Some(1)).await;
    insert_block(
        &pool,
        "RBBICHD1",
        "content",
        "c1",
        Some("RBBIPAR1"),
        Some(1),
    )
    .await;
    insert_block(&pool, "RBBIPAR2", "page", "p2", None, Some(2)).await;
    insert_block(
        &pool,
        "RBBICHD2",
        "content",
        "c2",
        Some("RBBIPAR2"),
        Some(1),
    )
    .await;
    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "RBBIPAR1")
        .await
        .unwrap();
    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "RBBIPAR2")
        .await
        .unwrap();

    let resp =
        restore_blocks_by_ids_inner(&pool, DEV, &mat, vec!["RBBIPAR1".into(), "RBBIPAR2".into()])
            .await
            .unwrap();

    assert_eq!(
        resp.affected_count, 4,
        "two parents + two children should all restore"
    );
    for id in &["RBBIPAR1", "RBBICHD1", "RBBIPAR2", "RBBICHD2"] {
        let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.deleted_at.is_none(), "{id} should be restored");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_skips_non_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Mix: one alive, one missing. Both should be silent no-ops.
    insert_block(&pool, "RBBIALIVE", "content", "alive", None, Some(1)).await;

    let resp = restore_blocks_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec!["RBBIALIVE".into(), "RBBIGHOST".into()],
    )
    .await
    .unwrap();

    assert_eq!(
        resp.affected_count, 0,
        "alive + missing ids both skip; count must be 0"
    );

    // Live block is still alive (i.e. NOT now soft-deleted by the call).
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "RBBIALIVE")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        row.deleted_at.is_none(),
        "live block must remain alive after no-op restore call"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_empty_input_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = restore_blocks_by_ids_inner(&pool, DEV, &mat, vec![]).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty input must return Validation error"
    );
}

/// PEND-35 Tier 2.2 — input list above the batch cap rejects with
/// `Validation`. Mirrors the delete + purge sibling rejection paths so
/// the per-call cap is uniformly enforced across the four `*_by_ids`
/// commands.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_rejects_oversize_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let oversize: Vec<String> = (0..(crate::commands::properties::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| format!("ID{i}"))
        .collect();
    let result = restore_blocks_by_ids_inner(&pool, DEV, &mat, oversize).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize list must reject with Validation, got {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_writes_one_op_log_seq_range() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed 3 soft-deleted roots.
    for i in 0..3 {
        let id = format!("RBBOPS{i}");
        insert_block(&pool, &id, "content", "rbbops", None, Some(1)).await;
        soft_delete::cascade_soft_delete(&pool, &mat, DEV, &id)
            .await
            .unwrap();
    }

    // Snapshot the current max seq before the batch call.
    let before_max: i64 =
        sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(seq) FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);

    let ids: Vec<String> = (0..3).map(|i| format!("RBBOPS{i}")).collect();
    restore_blocks_by_ids_inner(&pool, DEV, &mat, ids)
        .await
        .unwrap();

    // The 3 RestoreBlock ops should have consecutive seqs (no gaps,
    // i.e. one tx, atomic). Read all RestoreBlock op seqs since the
    // baseline; assert they form a contiguous run of length 3.
    let seqs: Vec<i64> = sqlx::query_scalar::<_, i64>(
        "SELECT seq FROM op_log \
         WHERE device_id = ? AND op_type = 'restore_block' AND seq > ? \
         ORDER BY seq ASC",
    )
    .bind(DEV)
    .bind(before_max)
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(seqs.len(), 3, "exactly 3 RestoreBlock ops appended");
    for w in seqs.windows(2) {
        assert_eq!(
            w[1] - w[0],
            1,
            "ops should be a contiguous seq range (no interleaved writes from other txs)"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_blocks_by_ids_clears_all_related_state() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed a soft-deleted block with rows in several dependent tables;
    // assert each table is wiped after the batch purge.
    insert_block(&pool, "PBBISTATE", "content", "doomed", None, Some(1)).await;
    // block_properties — owned property
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind("PBBISTATE")
        .bind("note")
        .bind("hello")
        .execute(&pool)
        .await
        .unwrap();
    // attachments
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATTPBBI001")
    .bind("PBBISTATE")
    .bind("text/plain")
    .bind("pbbistate.txt")
    .bind(11_i64)
    .bind("attachments/pbbistate.txt")
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();
    // block_drafts (post-migration 0038 schema: block_id PK + content + updated_at)
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("PBBISTATE")
        .bind("draft text")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();
    // page_aliases (the row only matters per-id; block_type is content
    // here but the aliases FK only checks block existence)
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PBBISTATE")
        .bind("doomed-alias")
        .execute(&pool)
        .await
        .unwrap();
    // projected_agenda_cache
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PBBISTATE")
    .bind("2025-06-15")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "PBBISTATE")
        .await
        .unwrap();

    let resp = purge_blocks_by_ids_inner(&pool, DEV, &mat, vec!["PBBISTATE".into()])
        .await
        .unwrap();
    assert_eq!(resp.affected_count, 1, "single block should have purged");

    // Each cleanup-chain table should be empty for this block_id.
    let assertions: &[(&str, &str)] = &[
        ("blocks", "id"),
        ("block_properties", "block_id"),
        ("attachments", "block_id"),
        ("block_drafts", "block_id"),
        ("page_aliases", "page_id"),
        ("projected_agenda_cache", "block_id"),
    ];
    for (table, col) in assertions {
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM {table} WHERE {col} = ?"
        )))
        .bind("PBBISTATE")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            n, 0,
            "{table}.{col}=PBBISTATE rows should be gone after purge"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_blocks_by_ids_skips_non_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PBBIALIVE", "content", "alive", None, Some(1)).await;
    let resp = purge_blocks_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec!["PBBIALIVE".into(), "PBBIGHOST".into()],
    )
    .await
    .unwrap();
    assert_eq!(
        resp.affected_count, 0,
        "alive + missing ids both skip; count must be 0"
    );

    // Live block should still be in the DB and not soft-deleted.
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "PBBIALIVE")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        row.deleted_at.is_none(),
        "live block must remain alive after no-op purge call"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_blocks_by_ids_empty_input_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = purge_blocks_by_ids_inner(&pool, DEV, &mat, vec![]).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty input must return Validation error"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_blocks_by_ids_atomic_rollback_on_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Capacity check kicks in BEFORE any tx work — the cap rejection
    // path is itself a fast `Validation` return. We use it as the
    // "trigger an error" surface to assert no row is touched on error.
    insert_block(&pool, "PBBIROLL", "content", "doomed", None, Some(1)).await;
    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "PBBIROLL")
        .await
        .unwrap();

    let oversized: Vec<String> = (0..1001).map(|i| format!("X{i:04}")).collect();
    let result = purge_blocks_by_ids_inner(&pool, DEV, &mat, oversized).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversized input must return Validation"
    );

    // The pre-existing soft-deleted block must still be there — i.e.
    // the rejected call did not partially mutate state.
    let exists: Option<i64> = sqlx::query_scalar::<_, i64>("SELECT 1 FROM blocks WHERE id = ?")
        .bind("PBBIROLL")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        exists.is_some(),
        "block must remain after a rejected oversized batch"
    );
}

// ======================================================================
// list_blocks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_no_filters_returns_top_level() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TOP1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "TOP2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "CHILD1", "content", "c", Some("TOP1"), Some(1)).await;

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
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

    assert_eq!(
        resp.items.len(),
        2,
        "should only return top-level blocks (parent_id IS NULL)"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"TOP1"), "TOP1 should be in results");
    assert!(ids.contains(&"TOP2"), "TOP2 should be in results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_block_type_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE1", "page", "my page", None, Some(1)).await;
    insert_block(&pool, "TAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "CONT1", "content", "hello", None, Some(2)).await;

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        Some("page".into()),
        None,
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

    assert_eq!(resp.items.len(), 1, "should filter to page type only");
    assert_eq!(resp.items[0].id, "PAGE1", "only page block should match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_parent_id_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "CH1", "content", "child 1", Some("PAR"), Some(1)).await;
    insert_block(&pool, "CH2", "content", "child 2", Some("PAR"), Some(2)).await;
    insert_block(&pool, "OTHER", "content", "other", None, Some(2)).await;

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        Some("PAR".into()),
        None,
        None,
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

    assert_eq!(resp.items.len(), 2, "should return only children of PAR");
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"CH1"), "CH1 should be in children results");
    assert!(ids.contains(&"CH2"), "CH2 should be in children results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_tag_id_filter() {
    let (pool, _dir) = test_pool().await;

    // Create a tag and a content block, then associate them
    insert_block(&pool, "TAG_FILTER", "tag", "urgent", None, None).await;
    insert_block(&pool, "TAGGED_BLK", "content", "tagged item", None, Some(1)).await;
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("TAGGED_BLK")
        .bind("TAG_FILTER")
        .execute(&pool)
        .await
        .unwrap();

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        Some("TAG_FILTER".into()),
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

    assert_eq!(
        resp.items.len(),
        1,
        "should return blocks tagged with TAG_FILTER"
    );
    assert_eq!(
        resp.items[0].id, "TAGGED_BLK",
        "tagged block should be returned"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_show_deleted_returns_trash() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "ALIVE", "content", "alive", None, Some(1)).await;
    insert_block(&pool, "DEAD", "content", "dead", None, Some(2)).await;

    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DEAD'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    assign_all_to_test_space(&pool).await;
    let resp = list_trash_inner(&pool, None, None, TEST_SPACE_ID.into())
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "trash should contain only deleted blocks"
    );
    assert_eq!(
        resp.items[0].id, "DEAD",
        "only deleted block should appear in trash"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_rejects_conflicting_filters() {
    let (pool, _dir) = test_pool().await;

    // parent_id + block_type
    assign_all_to_test_space(&pool).await;
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "parent_id + block_type should be rejected: {result:?}"
    );

    // parent_id + agenda_date
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        None,
        None,
        Some("2025-01-15".into()),
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "parent_id + agenda_date should be rejected: {result:?}"
    );

    // Three filters at once
    let result = list_blocks_inner(
        &pool,
        Some("P1".into()),
        Some("page".into()),
        Some("T1".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
        "three filters should be rejected: {result:?}"
    );
}

// FEAT-3 Phase 4 — the legacy `list_blocks_rejects_space_id_with_*`
// tests (agenda_date / agenda_date_range / tag_id) have been removed.
// Phase 4 dropped the rejection guard: agenda and tag filters now
// thread `space_id` through their pagination helpers
// (`pagination::list_agenda`, `list_agenda_range`, `list_by_tag`), so
// the combination is supported and returns the correct space-scoped
// result set. Coverage of the success path lives alongside the other
// space-scoped tests in `agenda_cmd_tests.rs::*_feat3p4` and
// `block_cmd_tests.rs::list_blocks_single_filter_is_accepted`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_single_filter_is_accepted() {
    let (pool, _dir) = test_pool().await;
    assign_all_to_test_space(&pool).await;

    // Each single filter should succeed (may return empty results — that's fine).
    assert!(
        list_blocks_inner(
            &pool,
            Some("P1".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "parent_id alone should be accepted"
    );
    assert!(
        list_blocks_inner(
            &pool,
            None,
            Some("page".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            TEST_SPACE_ID.into(), // FEAT-3 Phase 2: space_id unscoped
        )
        .await
        .is_ok(),
        "block_type alone should be accepted"
    );
    assert!(
        list_trash_inner(&pool, None, None, TEST_SPACE_ID.into())
            .await
            .is_ok(),
        "list_trash alone should be accepted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_empty_db_returns_empty_page() {
    let (pool, _dir) = test_pool().await;

    assign_all_to_test_space(&pool).await;
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
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
        resp.items.is_empty(),
        "empty DB should return empty items list"
    );
    assert!(
        resp.next_cursor.is_none(),
        "empty DB should have no next cursor"
    );
}

// ======================================================================
// get_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_single_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLK001", "content", "hello", None, Some(1)).await;

    let block = get_block_inner(&pool, "BLK001".into()).await.unwrap();
    assert_eq!(block.id, "BLK001", "returned block ID should match");
    assert_eq!(block.block_type, "content", "block_type should be content");
    assert_eq!(
        block.content,
        Some("hello".into()),
        "content should match inserted value"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = get_block_inner(&pool, "NOPE".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_block on nonexistent ID should return NotFound"
    );
}

/// M-98 — Pin the deliberate "include soft-deleted rows" contract on
/// `get_block_inner`. Trash UI / restore / purge / undo / snapshot
/// flows depend on this shape: the public read surfaces moved to
/// [`get_active_block_inner`] (which filters `deleted_at IS NULL`)
/// in the M-98 audit, leaving `get_block_inner` for callers that
/// genuinely need to inspect tombstoned rows. If a future refactor
/// adds the filter back into this function, this test fails — at
/// which point either the trash/restore flows need their own helper
/// or the audit conclusion needs to be revisited.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_inner_returns_soft_deleted_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "DELBLK", "content", "will be deleted", None, Some(1)).await;

    // Soft-delete the block
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DELBLK'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    // get_block_inner must still return soft-deleted rows so trash /
    // restore / undo paths can inspect them (unlike list_blocks which
    // excludes deleted rows by default, and unlike get_active_block_inner
    // which surfaces them as NotFound).
    let block = get_block_inner(&pool, "DELBLK".into()).await.unwrap();
    assert_eq!(
        block.id, "DELBLK",
        "deleted block should still be retrievable"
    );
    assert_eq!(
        block.deleted_at,
        Some(FIXED_TS.into()),
        "get_block_inner should return deleted_at for soft-deleted blocks"
    );
}

// ======================================================================
// get_active_block_inner
// ======================================================================

/// M-98 — Pin that `get_active_block_inner` returns active rows.
/// The active-only counterpart of `get_block_inner` is the public
/// read surface (Tauri IPC `get_block`, MCP `get_block`,
/// `export_page_markdown_inner`, `get_page_inner`). On a live row
/// it must round-trip the same shape as `get_block_inner`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_active_block_inner_returns_live_block() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LIVE01", "content", "alive", None, Some(1)).await;

    let block = get_active_block_inner(&pool, "LIVE01".into())
        .await
        .unwrap();
    assert_eq!(block.id, "LIVE01", "returned block ID should match");
    assert_eq!(
        block.content,
        Some("alive".into()),
        "content should match inserted value"
    );
    assert!(
        block.deleted_at.is_none(),
        "live block must not carry deleted_at"
    );
}

/// M-98 — Pin that `get_active_block_inner` rejects soft-deleted
/// rows with `NotFound`. This is the bug-fix contract: a tombstoned
/// row must NEVER reach the public read surface. If a future
/// refactor drops the `AND deleted_at IS NULL` predicate from the
/// SQL, this test fails and the leak is caught at CI time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_active_block_inner_returns_not_found_for_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TOMB01", "content", "tombstoned", None, Some(1)).await;

    // Soft-delete the block.
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'TOMB01'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = get_active_block_inner(&pool, "TOMB01".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_active_block_inner must surface soft-deleted rows as NotFound (M-98), got: {result:?}"
    );
}

/// M-98 — Pin that `get_active_block_inner` returns NotFound for
/// IDs that don't exist at all (same shape as `get_block_inner` for
/// missing rows — the predicate just adds a second case where we
/// hit NotFound).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_active_block_inner_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = get_active_block_inner(&pool, "NOPE".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_active_block_inner on a missing ID should return NotFound, got: {result:?}"
    );
}

// ======================================================================
// move_block
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_basic_reparent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Setup: two parents and a child under parent A
    insert_block(&pool, "MV_PAR_A", "page", "parent A", None, Some(1)).await;
    insert_block(&pool, "MV_PAR_B", "page", "parent B", None, Some(2)).await;
    insert_block(
        &pool,
        "MV_CHILD",
        "content",
        "child",
        Some("MV_PAR_A"),
        Some(1),
    )
    .await;

    let resp = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_CHILD".into(),
        Some("MV_PAR_B".into()),
        5,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.block_id, "MV_CHILD",
        "block_id should match moved block"
    );
    assert_eq!(
        resp.new_parent_id,
        Some("MV_PAR_B".into()),
        "new_parent_id should be parent B"
    );
    assert_eq!(
        resp.new_position, 5,
        "new_position should match requested value"
    );

    // Verify DB state
    let row = sqlx::query!(
        "SELECT parent_id, position FROM blocks WHERE id = ?",
        "MV_CHILD"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.parent_id,
        Some("MV_PAR_B".into()),
        "parent_id should be updated in DB"
    );
    assert_eq!(row.position, Some(5), "position should be updated in DB");

    // Verify op_log entry
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'move_block'",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "exactly one move_block op should be logged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_root() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Setup: a parent and a child under it
    insert_block(&pool, "MV_ROOT_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "MV_ROOT_CHD",
        "content",
        "child",
        Some("MV_ROOT_PAR"),
        Some(1),
    )
    .await;

    // Move child to root (new_parent_id = None)
    let resp = move_block_inner(&pool, DEV, &mat, "MV_ROOT_CHD".into(), None, 10)
        .await
        .unwrap();

    assert_eq!(
        resp.block_id, "MV_ROOT_CHD",
        "block_id should match moved block"
    );
    assert!(
        resp.new_parent_id.is_none(),
        "new_parent_id should be None for root move"
    );
    assert_eq!(
        resp.new_position, 10,
        "new_position should match requested value"
    );

    // Verify DB state
    let row = sqlx::query!(
        "SELECT parent_id, position FROM blocks WHERE id = ?",
        "MV_ROOT_CHD"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        row.parent_id.is_none(),
        "parent_id should be NULL in DB after move to root"
    );
    assert_eq!(row.position, Some(10), "position should be updated in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = move_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for nonexistent block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_deleted_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_DEL", "content", "deleted block", None, Some(1)).await;

    // Soft-delete the block
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, "MV_DEL".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving a deleted block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_deleted_parent_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_BLK", "content", "block", None, Some(1)).await;
    insert_block(&pool, "MV_DEL_PAR", "page", "deleted parent", None, Some(2)).await;

    // Soft-delete the parent
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL_PAR'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_BLK".into(),
        Some("MV_DEL_PAR".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to a deleted parent should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_self_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MV_SELF", "content", "self ref", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_SELF".into(),
        Some("MV_SELF".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "block_id == new_parent_id should return InvalidOperation, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_cycle_grandchild_to_grandparent_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build A→B→C hierarchy
    insert_block(&pool, "CYC_A", "page", "A", None, Some(1)).await;
    insert_block(&pool, "CYC_B", "content", "B", Some("CYC_A"), Some(1)).await;
    insert_block(&pool, "CYC_C", "content", "C", Some("CYC_B"), Some(1)).await;

    // Try moving A under C — should create cycle A→B→C→A
    let result = move_block_inner(&pool, DEV, &mat, "CYC_A".into(), Some("CYC_C".into()), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving A under its grandchild C should detect cycle, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_non_ancestor_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build A→B and separate C
    insert_block(&pool, "NC_A", "page", "A", None, Some(1)).await;
    insert_block(&pool, "NC_B", "content", "B", Some("NC_A"), Some(1)).await;
    insert_block(&pool, "NC_C", "page", "C", None, Some(2)).await;

    // Move B under C — no cycle, should succeed
    let resp = move_block_inner(&pool, DEV, &mat, "NC_B".into(), Some("NC_C".into()), 1)
        .await
        .unwrap();

    assert_eq!(
        resp.new_parent_id,
        Some("NC_C".into()),
        "block should be reparented to C"
    );
}

// ── #74: max nesting depth guard ─────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH levels: page→b1→b2→...→b20
    insert_block(&pool, "DEPTH_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "DEPTH_PAGE".to_string();
    for i in 1..=MAX_BLOCK_DEPTH {
        let id = format!("DEPTH_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Create a loose block to try nesting under the deepest
    insert_block(&pool, "DEPTH_EXTRA", "content", "extra", None, Some(99)).await;

    // Try moving the loose block under the deepest level — should fail
    let result = move_block_inner(&pool, DEV, &mat, "DEPTH_EXTRA".into(), Some(parent), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_at_depth_limit_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH - 1 levels
    insert_block(&pool, "DLIM_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "DLIM_PAGE".to_string();
    for i in 1..MAX_BLOCK_DEPTH {
        let id = format!("DLIM_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Create a loose block and move under the (MAX_BLOCK_DEPTH - 1)th level — should succeed
    insert_block(&pool, "DLIM_OK", "content", "ok", None, Some(99)).await;

    let result = move_block_inner(&pool, DEV, &mat, "DLIM_OK".into(), Some(parent), 1).await;

    assert!(
        result.is_ok(),
        "moving to exactly MAX_BLOCK_DEPTH should succeed, got: {result:?}"
    );
}

// ── L-37: MAX_BLOCK_DEPTH enforced in create_block_in_tx ─────────────────
//
// `move_block_inner` already rejects moves that would push the subtree past
// the documented limit (docs/ARCHITECTURE.md §20). L-37 closed the asymmetry on
// the create side: a user used to be able to repeatedly create blocks under
// the deepest leaf and drift past the bound. The recursive CTE inside
// `create_block_in_tx` now computes parent_depth and rejects when
// parent_depth + 1 > MAX_BLOCK_DEPTH.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_at_max_depth_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH - 1 levels under a page. The deepest
    // existing block is at depth (MAX_BLOCK_DEPTH - 1); creating one more
    // under it lands at exactly MAX_BLOCK_DEPTH = OK.
    insert_block(&pool, "CDLIM_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "CDLIM_PAGE".to_string();
    for i in 1..MAX_BLOCK_DEPTH {
        let id = format!("CDLIM_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "at-limit".into(),
        Some(parent),
        Some(1),
    )
    .await;

    assert!(
        result.is_ok(),
        "create at exactly MAX_BLOCK_DEPTH should succeed, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a chain of MAX_BLOCK_DEPTH levels: page→b1→...→b20. The deepest
    // existing block is at depth MAX_BLOCK_DEPTH; creating one more under it
    // would push the new block to depth MAX_BLOCK_DEPTH + 1 = rejected.
    insert_block(&pool, "CDOVER_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "CDOVER_PAGE".to_string();
    for i in 1..=MAX_BLOCK_DEPTH {
        let id = format!("CDOVER_{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("level {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "over-limit".into(),
        Some(parent),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "creating beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_at_root_with_no_parent_skips_depth_check() {
    // L-37 regression guard: when `parent_id = None`, the new depth check
    // must NOT fire — root-level page creation is unconstrained by the
    // depth limit (the page itself sits at depth 0).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "root-page".into(),
        None,
        Some(1),
    )
    .await;

    assert!(
        result.is_ok(),
        "creating a root-level block (no parent) must succeed regardless of depth, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_with_subtree_exceeding_max_depth_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Build a deep parent chain of 17 levels: page→d1→d2→...→d17
    insert_block(&pool, "SUB_PAGE", "page", "root", None, Some(1)).await;
    let mut parent = "SUB_PAGE".to_string();
    for i in 1..=17_i64 {
        let id = format!("SUB_P{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("parent {i}"),
            Some(&parent),
            Some(1),
        )
        .await;
        parent = id;
    }

    // Build a detached subtree: A→B→C→D (depth 3 below A)
    insert_block(&pool, "SUB_A", "content", "a", None, Some(90)).await;
    insert_block(&pool, "SUB_B", "content", "b", Some("SUB_A"), Some(1)).await;
    insert_block(&pool, "SUB_C", "content", "c", Some("SUB_B"), Some(1)).await;
    insert_block(&pool, "SUB_D", "content", "d", Some("SUB_C"), Some(1)).await;

    // Moving A under d17 means D ends up at depth 17+1+3 = 21 > 20
    let result = move_block_inner(&pool, DEV, &mat, "SUB_A".into(), Some(parent), 1).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "moving subtree that would exceed depth limit should fail, got: {result:?}"
    );
}

// ======================================================================
// Attachment commands (F-7, F-11)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_creates_row() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block to attach to
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // M-29: file must exist on disk under app_data_dir before the row commits.
    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 1024];
    std::fs::write(app_data_dir.join("attachments/photo.png"), &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "photo.png".into(),
        "image/png".into(),
        1024,
        "attachments/photo.png".into(),
    )
    .await
    .unwrap();

    assert_eq!(att.block_id, block.id, "attachment block_id should match");
    assert_eq!(
        att.filename, "photo.png",
        "attachment filename should match"
    );
    assert_eq!(
        att.mime_type, "image/png",
        "attachment mime_type should match"
    );
    assert_eq!(att.size_bytes, 1024, "attachment size should match");
    assert_eq!(
        att.fs_path, "attachments/photo.png",
        "attachment fs_path should match"
    );
    assert!(!att.id.is_empty(), "attachment should have a generated ID");
    assert!(!att.created_at.is_empty(), "created_at should be set");

    // Verify persistence in DB via direct query
    let db_row = sqlx::query_as!(
        AttachmentRow,
        "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at \
         FROM attachments WHERE id = ?",
        att.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(db_row.id, att.id, "DB row id should match returned id");
    assert_eq!(db_row.block_id, block.id, "DB row block_id should match");
    assert_eq!(db_row.filename, "photo.png", "DB row filename should match");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_removes_row() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block and an attachment
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 2048];
    std::fs::write(app_data_dir.join("attachments/doc.pdf"), &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "doc.pdf".into(),
        "application/pdf".into(),
        2048,
        "attachments/doc.pdf".into(),
    )
    .await
    .unwrap();

    // Delete it
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .unwrap();

    // Verify it's gone from the DB
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "attachment should be deleted from DB");

    // C-3b: file should be unlinked from disk too.
    assert!(
        !app_data_dir.join("attachments/doc.pdf").exists(),
        "attachment file should be removed from disk after delete_attachment_inner"
    );

    mat.shutdown();
}

/// C-3a/b happy path: `delete_attachment_inner` must (a) commit a
/// `DeleteAttachment` op-log entry whose `fs_path` matches the original
/// `add_attachment` fs_path, and (b) unlink the on-disk file under
/// `app_data_dir`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_unlinks_file_and_records_fs_path_in_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "with attachment".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let bytes: Vec<u8> = vec![0u8; 64];
    let rel_path = "attachments/c3b_happy.pdf";
    let full_path = app_data_dir.join(rel_path);
    std::fs::write(&full_path, &bytes).unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "c3b_happy.pdf".into(),
        "application/pdf".into(),
        64,
        rel_path.into(),
    )
    .await
    .unwrap();

    // Sanity: file is present before delete.
    assert!(
        full_path.exists(),
        "fixture file must be on disk before delete"
    );

    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .expect("delete_attachment_inner happy path must succeed");

    // (a) DB row gone.
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "attachment row must be deleted from DB");

    // (b) On-disk file gone.
    assert!(
        !full_path.exists(),
        "attachment file at {} must be unlinked",
        full_path.display()
    );

    // (c) Op log contains a `delete_attachment` whose payload carries the
    // expected `fs_path`. Walk the log directly so we check the persisted
    // shape (this is what remote peers and the C-3c GC pass will see).
    let ops = crate::op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    let del_op = ops
        .iter()
        .find(|o| o.op_type == "delete_attachment")
        .expect("op log must contain a delete_attachment entry");
    let parsed: crate::op::DeleteAttachmentPayload =
        serde_json::from_str(&del_op.payload).expect("delete_attachment payload must parse");
    assert_eq!(
        parsed.attachment_id.as_str(),
        att.id,
        "op-log payload attachment_id must match"
    );
    assert_eq!(
        parsed.fs_path, rel_path,
        "C-3a: op-log payload fs_path must match the original add_attachment fs_path"
    );

    mat.shutdown();
}

/// C-3b: when the on-disk file has already been removed (e.g., the user
/// pruned the attachments directory by hand, or a previous failed delete
/// already unlinked it), `delete_attachment_inner` must still succeed —
/// the op-log entry is authoritative, the missing file is logged at info
/// level, and the row is removed from the DB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_attachment_succeeds_when_file_already_missing_on_disk() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ghost".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let rel_path = "attachments/c3b_ghost.pdf";
    let full_path = app_data_dir.join(rel_path);
    std::fs::write(&full_path, b"x").unwrap();

    let att = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "c3b_ghost.pdf".into(),
        "application/pdf".into(),
        1,
        rel_path.into(),
    )
    .await
    .unwrap();

    // Simulate the user (or a previous botched delete) removing the file
    // out from under us.
    std::fs::remove_file(&full_path).unwrap();
    assert!(
        !full_path.exists(),
        "precondition: file must be missing before delete"
    );

    // Must still succeed: missing file is non-fatal.
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, att.id.clone())
        .await
        .expect("delete must succeed even if the on-disk file is already gone");

    // DB row is gone.
    let maybe = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
        att.id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(maybe.is_none(), "DB row must be deleted");

    // Op log entry was still written.
    let ops = crate::op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert!(
        ops.iter().any(|o| o.op_type == "delete_attachment"),
        "op-log must contain a delete_attachment entry"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_validates_size_limit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Attempt to attach a file exceeding 50 MB
    let over_limit = MAX_ATTACHMENT_SIZE + 1;
    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        _dir.path(),
        block.id.clone().into_string(),
        "big.bin".into(),
        "application/zip".into(),
        over_limit,
        "attachments/big.bin".into(),
    )
    .await;

    assert!(result.is_err(), "should reject oversized attachment");
    match result.unwrap_err() {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("exceeds maximum"),
                "error should mention size limit: {msg}"
            );
        }
        other => panic!("expected Validation error, got: {other:?}"),
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_validates_mime_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        _dir.path(),
        block.id.clone().into_string(),
        "virus.exe".into(),
        "application/x-msdownload".into(),
        1024,
        "attachments/virus.exe".into(),
    )
    .await;

    assert!(result.is_err(), "should reject disallowed MIME type");
    match result.unwrap_err() {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("not allowed"),
                "error should mention MIME not allowed: {msg}"
            );
        }
        other => panic!("expected Validation error, got: {other:?}"),
    }

    mat.shutdown();
}

/// L-56: `add_attachment_inner` must reject a `size_bytes` that disagrees
/// with the on-disk file's `metadata.len()` in *all* builds (previously
/// only checked via `debug_assert_eq!`, which compiled out in release).
/// The mismatch surfaces as `AppError::Validation` and the IMMEDIATE
/// transaction rolls back so no row is committed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_size_mismatch_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Write a 32-byte file but tell `add_attachment_inner` it is 64 bytes.
    // Both values are well under MAX_ATTACHMENT_SIZE and use an allowed
    // MIME, so the only failure path here is the size-mismatch guard.
    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let rel_path = "attachments/mismatch.png";
    std::fs::write(app_data_dir.join(rel_path), vec![0u8; 32]).unwrap();

    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "mismatch.png".into(),
        "image/png".into(),
        64, // declared, not the actual on-disk size
        rel_path.into(),
    )
    .await;

    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("size mismatch") && msg.contains("64") && msg.contains("32"),
                "error message must report both declared and on-disk sizes: {msg}"
            );
        }
        other => panic!("expected AppError::Validation for size mismatch, got: {other:?}"),
    }

    // Rollback: no attachment row may be committed when the guard trips.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "size-mismatch failure must not leave an attachment row"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_returns_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create two blocks
    let block_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block a".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let block_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block b".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    // Set up the on-disk attachment fixtures (M-29: stat-check inside tx).
    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    std::fs::write(app_data_dir.join("attachments/a1.png"), vec![0u8; 100]).unwrap();
    std::fs::write(app_data_dir.join("attachments/a2.pdf"), vec![0u8; 200]).unwrap();
    std::fs::write(app_data_dir.join("attachments/b1.txt"), vec![0u8; 50]).unwrap();

    // Add 2 attachments to block_a
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "a1.png".into(),
        "image/png".into(),
        100,
        "attachments/a1.png".into(),
    )
    .await
    .unwrap();

    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "a2.pdf".into(),
        "application/pdf".into(),
        200,
        "attachments/a2.pdf".into(),
    )
    .await
    .unwrap();

    // Add 1 attachment to block_b
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_b.id.clone().into_string(),
        "b1.txt".into(),
        "text/plain".into(),
        50,
        "attachments/b1.txt".into(),
    )
    .await
    .unwrap();

    // List for block_a — should get 2
    let list_a = list_attachments_inner(&pool, block_a.id.clone().into_string())
        .await
        .unwrap();
    assert_eq!(list_a.len(), 2, "block_a should have 2 attachments");
    assert_eq!(
        list_a[0].filename, "a1.png",
        "first attachment should be a1.png"
    );
    assert_eq!(
        list_a[1].filename, "a2.pdf",
        "second attachment should be a2.pdf"
    );

    // List for block_b — should get 1
    let list_b = list_attachments_inner(&pool, block_b.id.clone().into_string())
        .await
        .unwrap();
    assert_eq!(list_b.len(), 1, "block_b should have 1 attachment");
    assert_eq!(
        list_b[0].filename, "b1.txt",
        "block_b attachment should be b1.txt"
    );

    mat.shutdown();
}

// ======================================================================
// list_attachments_batch (MAINT-131)
//
// PEND-35 Tier 2.7a: the previous `get_batch_attachment_counts_*` tests
// were retired with the command — counts are now derived as `rows.len()`
// from this batch's response on the frontend.
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_batch_returns_full_lists_per_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three blocks: A (2 attachments), B (1 attachment), C (0 attachments).
    let block_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block a".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let block_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block b".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    let block_c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block c".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    std::fs::write(app_data_dir.join("attachments/a1.png"), vec![0u8; 10]).unwrap();
    std::fs::write(app_data_dir.join("attachments/a2.pdf"), vec![0u8; 20]).unwrap();
    std::fs::write(app_data_dir.join("attachments/b1.txt"), vec![0u8; 5]).unwrap();

    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "a1.png".into(),
        "image/png".into(),
        10,
        "attachments/a1.png".into(),
    )
    .await
    .unwrap();
    // `now_rfc3339()` resolves to millisecond precision; sleep so the two
    // block_a attachments get strictly increasing `created_at` values and
    // the ORDER BY-driven assertion below is deterministic.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "a2.pdf".into(),
        "application/pdf".into(),
        20,
        "attachments/a2.pdf".into(),
    )
    .await
    .unwrap();
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_b.id.clone().into_string(),
        "b1.txt".into(),
        "text/plain".into(),
        5,
        "attachments/b1.txt".into(),
    )
    .await
    .unwrap();

    let grouped = list_attachments_batch_inner(
        &pool,
        vec![
            block_a.id.to_string(),
            block_b.id.to_string(),
            block_c.id.to_string(),
        ],
    )
    .await
    .unwrap();

    let a_rows = grouped
        .get(block_a.id.as_str())
        .expect("block_a must be present");
    assert_eq!(a_rows.len(), 2, "block_a should have 2 attachments");
    assert_eq!(
        a_rows[0].filename, "a1.png",
        "block_a's first attachment (by created_at) should be a1.png"
    );
    assert_eq!(a_rows[0].mime_type, "image/png");
    assert_eq!(
        a_rows[1].filename, "a2.pdf",
        "block_a's second attachment (by created_at) should be a2.pdf"
    );
    assert_eq!(a_rows[1].mime_type, "application/pdf");

    let b_rows = grouped
        .get(block_b.id.as_str())
        .expect("block_b must be present");
    assert_eq!(b_rows.len(), 1, "block_b should have 1 attachment");
    assert_eq!(b_rows[0].filename, "b1.txt");
    assert_eq!(b_rows[0].mime_type, "text/plain");

    assert!(
        !grouped.contains_key(block_c.id.as_str()),
        "block_c (no attachments) must be absent from the map, not present with an empty Vec"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_batch_empty_input_returns_empty_map() {
    let (pool, _dir) = test_pool().await;

    let grouped = list_attachments_batch_inner(&pool, vec![]).await.unwrap();
    assert!(
        grouped.is_empty(),
        "empty input must return an empty map (not an error)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_batch_unknown_ids_omitted() {
    let (pool, _dir) = test_pool().await;

    let grouped = list_attachments_batch_inner(&pool, vec!["NONEXISTENT_ULID_01HZ".into()])
        .await
        .unwrap();
    assert!(
        grouped.is_empty(),
        "unknown block IDs must be silently omitted from the result map"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_batch_filters_by_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block a".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let block_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block b".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    std::fs::write(app_data_dir.join("attachments/a1.png"), vec![0u8; 10]).unwrap();
    std::fs::write(app_data_dir.join("attachments/b1.txt"), vec![0u8; 5]).unwrap();

    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "a1.png".into(),
        "image/png".into(),
        10,
        "attachments/a1.png".into(),
    )
    .await
    .unwrap();
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_b.id.clone().into_string(),
        "b1.txt".into(),
        "text/plain".into(),
        5,
        "attachments/b1.txt".into(),
    )
    .await
    .unwrap();

    // Only ask about block_a — block_b's row must be filtered out by the IN clause.
    let grouped = list_attachments_batch_inner(&pool, vec![block_a.id.to_string()])
        .await
        .unwrap();

    let a_rows = grouped
        .get(block_a.id.as_str())
        .expect("block_a must be present");
    assert_eq!(a_rows.len(), 1, "block_a should have 1 attachment");
    assert_eq!(a_rows[0].filename, "a1.png");
    assert!(
        !grouped.contains_key(block_b.id.as_str()),
        "block_b must not appear when only block_a was requested"
    );
    assert_eq!(
        grouped.len(),
        1,
        "result map must contain exactly the one queried block"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_batch_attachment_row_shape_matches_list_attachments() {
    // Pins the contract that the batch IPC returns identical per-row shape
    // to the single-block IPC. Frontend code that previously read a row
    // from `list_attachments` must be able to read the same row from
    // `list_attachments_batch` without any field mapping.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "shape block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    std::fs::write(app_data_dir.join("attachments/shape.png"), vec![0u8; 7]).unwrap();

    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "shape.png".into(),
        "image/png".into(),
        7,
        "attachments/shape.png".into(),
    )
    .await
    .unwrap();

    let single = list_attachments_inner(&pool, block.id.clone().into_string())
        .await
        .unwrap();
    let batch = list_attachments_batch_inner(&pool, vec![block.id.to_string()])
        .await
        .unwrap();

    assert_eq!(single.len(), 1, "single-block IPC should return 1 row");
    let batch_rows = batch
        .get(block.id.as_str())
        .expect("block must be present in batch");
    assert_eq!(batch_rows.len(), 1, "batch IPC should return 1 row");

    let s = &single[0];
    let b = &batch_rows[0];
    assert_eq!(s.id, b.id, "id must match");
    assert_eq!(s.block_id, b.block_id, "block_id must match");
    assert_eq!(s.mime_type, b.mime_type, "mime_type must match");
    assert_eq!(s.filename, b.filename, "filename must match");
    assert_eq!(s.size_bytes, b.size_bytes, "size_bytes must match");
    assert_eq!(s.fs_path, b.fs_path, "fs_path must match");
    assert_eq!(s.created_at, b.created_at, "created_at must match");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_attachments_returns_rows_with_deleted_at_set() {
    // M-28: `attachments.deleted_at` is dead code — no production path ever
    // writes a non-NULL value (both `delete_attachment_inner` and the
    // materializer's `DeleteAttachment` handler hard-delete). The historical
    // `AND deleted_at IS NULL` filter in `list_attachments_inner` was
    // therefore a no-op on real data.
    //
    // This test pins that the filter is gone: we bypass the normal command
    // path and write a row with `deleted_at` populated directly. Pre-fix,
    // the filter would have hidden it; post-fix, the row must come back.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "m28 block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Insert a row directly into `attachments` with `deleted_at` set.
    // This simulates the (unreachable in production) state the old filter
    // was guarding against.
    sqlx::query(
        "INSERT INTO attachments \
         (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("01HZ000000000000000000ATM28")
    .bind(&block.id)
    .bind("image/png")
    .bind("ghost.png")
    .bind(42_i64)
    .bind("attachments/ghost.png")
    .bind("2025-01-01T00:00:00Z")
    .bind("2025-01-02T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let rows = list_attachments_inner(&pool, block.id.clone().into_string())
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "M-28: row with deleted_at set must be returned (the old filter was a no-op)"
    );
    assert_eq!(rows[0].filename, "ghost.png");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_returns_io_error_when_file_missing_on_disk() {
    // M-29: when the frontend's `@tauri-apps/plugin-fs` write fails or
    // races so the file is never actually persisted, `add_attachment`
    // must surface `AppError::Io` rather than committing a row that
    // points at a non-existent file (which would later trip the sync
    // layer's `MissingAttachment` path).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "missing fs".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Note: we deliberately do NOT create the file on disk.
    let app_data_dir = _dir.path();

    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "ghost.png".into(),
        "image/png".into(),
        1024,
        "attachments/ghost.png".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Io(_))),
        "missing fs_path file must surface as AppError::Io, got: {result:?}"
    );

    // No row inserted — the IMMEDIATE tx rolled back on the metadata error.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "missing-file failure must not leave an attachment row"
    );

    mat.shutdown();
}

/// M-30: a second `add_attachment_inner` for the same `fs_path` (with the
/// underlying file present on disk and a different `attachment_id` /
/// `block_id`) must surface as `AppError::Database` — the partial unique
/// index `idx_attachments_fs_path_unique` (migration 0037) trips the
/// SQLite UNIQUE-constraint check inside the IMMEDIATE transaction, which
/// `sqlx` reports as `sqlx::Error::Database` and our `From` impl wraps as
/// `AppError::Database`. Pre-fix, the second insert silently succeeded
/// and produced two rows pointing at the same file; once
/// `delete_attachment` actually unlinks (C-3a/b), that would let one
/// row's delete clobber the other row's content.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_duplicate_fs_path_returns_error_m30() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Two distinct blocks so the test exercises the *cross-block*
    // collision case (M-30 explicitly calls out "different attachment_id,
    // even different block_id"). If a same-block re-add were the only
    // case, it might be argued the frontend should dedupe; the schema
    // guard has to cover the cross-block case too.
    let block_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block a".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let block_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block b".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let rel_path = "attachments/m30_dup.png";
    let bytes: Vec<u8> = vec![0u8; 16];
    std::fs::write(app_data_dir.join(rel_path), &bytes).unwrap();

    // First insert: succeeds normally.
    add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_a.id.clone().into_string(),
        "m30_dup.png".into(),
        "image/png".into(),
        16,
        rel_path.into(),
    )
    .await
    .expect("first add_attachment must succeed");

    // Second insert against the same `fs_path`: must fail with
    // AppError::Database because the partial unique index trips.
    let result = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block_b.id.clone().into_string(),
        "m30_dup.png".into(),
        "image/png".into(),
        16,
        rel_path.into(),
    )
    .await;

    // Issue #106: `From<sqlx::Error>` now lifts unique-constraint
    // violations out of the generic `Database` bucket into a dedicated
    // `Conflict` variant so the frontend can render a tailored toast.
    // The schema guarantee being pinned here is unchanged — the partial
    // unique index still has to trip — only the discriminant moved.
    assert!(
        matches!(result, Err(AppError::Conflict(_))),
        "M-30: duplicate fs_path must surface as AppError::Conflict, got: {result:?}"
    );

    // Schema guarantee: only one row exists for this fs_path. The
    // failed second insert rolled back inside the IMMEDIATE tx.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE fs_path = ?")
        .bind(rel_path)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "M-30: only the first add must have produced a row at this fs_path"
    );

    mat.shutdown();
}

/// M-30: the partial unique index excludes soft-deleted rows
/// (`WHERE deleted_at IS NULL`). A tombstone row at a given `fs_path`
/// must NOT block a fresh `add_attachment_inner` at the same path —
/// otherwise a user who deletes a file and re-adds it would be locked
/// out forever. Today's `delete_attachment_inner` hard-deletes (the
/// `deleted_at` column is dead code per the M-28 audit), so the only
/// way to materialise a tombstone is by direct SQL. This test is
/// therefore phrased as a schema-level guarantee on the partial index,
/// not as a workflow assertion against the command path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_after_soft_delete_can_reuse_fs_path_m30() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "soft-delete reuse".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let app_data_dir = _dir.path();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    let rel_path = "attachments/m30_reuse.png";
    let bytes: Vec<u8> = vec![0u8; 8];
    std::fs::write(app_data_dir.join(rel_path), &bytes).unwrap();

    // First add via the normal path.
    let first = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "m30_reuse.png".into(),
        "image/png".into(),
        8,
        rel_path.into(),
    )
    .await
    .expect("first add_attachment must succeed");

    // Simulate a soft-delete by stamping `deleted_at` directly. Today
    // no production path writes this column, but the partial unique
    // index is designed to be forward-compatible with a future
    // soft-delete code path.
    sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
        .bind("2025-01-02T00:00:00Z")
        .bind(&first.id)
        .execute(&pool)
        .await
        .unwrap();

    // Second add at the same `fs_path` — must succeed because the
    // first row is now outside the partial index's predicate.
    let second = add_attachment_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "m30_reuse.png".into(),
        "image/png".into(),
        8,
        rel_path.into(),
    )
    .await
    .expect("M-30: re-adding a fs_path after soft-delete must succeed");

    assert_ne!(
        first.id, second.id,
        "second add must produce a fresh attachment_id"
    );

    // One tombstone + one live row at the same fs_path.
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE fs_path = ?")
        .bind(rel_path)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        total, 2,
        "tombstone row and fresh row must coexist at the same fs_path"
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM attachments WHERE fs_path = ? AND deleted_at IS NULL",
    )
    .bind(rel_path)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        live, 1,
        "exactly one non-soft-deleted row may exist at a given fs_path"
    );

    mat.shutdown();
}

// ======================================================================
// Draft autosave commands (F-17)
// ======================================================================

#[tokio::test]
async fn save_and_flush_draft() {
    let (pool, _dir) = test_pool().await;

    // H-12a precondition: target block must exist + not be soft-deleted for the
    // flush to actually emit an edit_block op. Without this row, flush_draft_inner
    // (correctly) drops the orphan draft and returns Ok with zero ops appended.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'initial', NULL, 1)",
    )
    .bind("01HZ000000000000000000DRF01")
    .execute(&pool)
    .await
    .unwrap();

    // Save a draft
    draft::save_draft(&pool, "01HZ000000000000000000DRF01", "draft content")
        .await
        .unwrap();

    // Verify it persists
    let d = draft::get_draft(&pool, "01HZ000000000000000000DRF01")
        .await
        .unwrap()
        .expect("draft should exist after save");
    assert_eq!(
        d.content, "draft content",
        "saved draft content should match"
    );

    // Flush the draft (writes edit_block op + deletes draft row)
    flush_draft_inner(&pool, DEV, "01HZ000000000000000000DRF01".into())
        .await
        .unwrap();

    // Draft should be gone
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF01")
            .await
            .unwrap()
            .is_none(),
        "draft must be deleted after flush"
    );

    // An edit_block op should exist in the log
    let ops = crate::op_log::get_ops_since(&ReadPool(pool.clone()), DEV, 0)
        .await
        .unwrap();
    assert_eq!(ops.len(), 1, "flush must produce one op");
    assert_eq!(
        ops[0].op_type, "edit_block",
        "flushed op should be edit_block"
    );
}

#[tokio::test]
async fn delete_draft_removes_entry() {
    let (pool, _dir) = test_pool().await;

    // M-93 / migration 0038: seed the parent block so save_draft satisfies
    // the FK from block_drafts.block_id to blocks(id).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', '', NULL, 0)",
    )
    .bind("01HZ000000000000000000DRF02")
    .execute(&pool)
    .await
    .unwrap();

    // Save a draft
    draft::save_draft(&pool, "01HZ000000000000000000DRF02", "to be deleted")
        .await
        .unwrap();

    // Verify it exists
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF02")
            .await
            .unwrap()
            .is_some(),
        "draft should exist after save"
    );

    // Delete it
    draft::delete_draft(&pool, "01HZ000000000000000000DRF02")
        .await
        .unwrap();

    // Verify it's gone
    assert!(
        draft::get_draft(&pool, "01HZ000000000000000000DRF02")
            .await
            .unwrap()
            .is_none(),
        "draft must be gone after delete"
    );
}

#[tokio::test]
async fn list_drafts_returns_all_drafts() {
    let (pool, _dir) = test_pool().await;

    // Start with no drafts
    let result = list_drafts_inner(&pool).await.unwrap();
    assert!(result.is_empty(), "should start with zero drafts");

    // Seed parent blocks so save_draft satisfies the M-93 FK
    // (`block_drafts.block_id REFERENCES blocks(id) ON DELETE CASCADE`,
    // migration 0038).
    for id in ["01HZ000000000000000000DRF03", "01HZ000000000000000000DRF04"] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Save two drafts
    draft::save_draft(&pool, "01HZ000000000000000000DRF03", "content one")
        .await
        .unwrap();
    draft::save_draft(&pool, "01HZ000000000000000000DRF04", "content two")
        .await
        .unwrap();

    let result = list_drafts_inner(&pool).await.unwrap();
    assert_eq!(result.len(), 2, "should return both drafts");
}

// ======================================================================
// PEND-35 Tier 2.12: flush_all_drafts — single-IPC boot recovery
// ======================================================================

/// No drafts → 0 flushed, no op_log rows, single tx commits cleanly.
#[tokio::test]
async fn flush_all_drafts_no_drafts_returns_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let baseline_ops = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    let result = flush_all_drafts_inner(&pool, DEV, &mat).await.unwrap();

    assert_eq!(result.flushed, 0, "no drafts → flushed must be 0");

    let after_ops = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        after_ops, baseline_ops,
        "no-op flush must not append any op_log rows"
    );

    mat.shutdown();
}

/// Three drafts on three live blocks → exactly 3 new `edit_block` ops
/// AND all 3 drafts deleted from `block_drafts`.
#[tokio::test]
async fn flush_all_drafts_writes_one_op_log_row_per_draft() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three live blocks. M-93 FK requires the `blocks` row first.
    let block_ids = [
        "01HZ000000000000000FA00001",
        "01HZ000000000000000FA00002",
        "01HZ000000000000000FA00003",
    ];
    for id in block_ids {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'initial', NULL, 1)",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Seed three drafts.
    for (i, id) in block_ids.iter().enumerate() {
        draft::save_draft(&pool, id, &format!("flushed-content-{i}"))
            .await
            .unwrap();
    }

    let baseline_edit_ops: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block'")
            .fetch_one(&pool)
            .await
            .unwrap();

    let result = flush_all_drafts_inner(&pool, DEV, &mat).await.unwrap();

    assert_eq!(result.flushed, 3, "all three drafts must be flushed");

    let after_edit_ops: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        after_edit_ops - baseline_edit_ops,
        3,
        "exactly one edit_block op must be appended per flushed draft"
    );

    // Every draft row is gone.
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "all draft rows must be deleted after flush_all_drafts"
    );

    // Each block has its own edit_block op (per-block, not lumped).
    for id in block_ids {
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block' AND block_id = ?",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            n, 1,
            "block {id} must receive exactly one edit_block op from the batch"
        );
    }

    mat.shutdown();
}

/// All-or-nothing: a single draft that errors during flush rolls back the
/// entire batch — no op_log rows added, **no** drafts deleted.
///
/// Trigger: oversized content (H-12b path) on one draft. The other two
/// drafts in the batch are perfectly valid but must remain untouched
/// because the tx rolls back on the validation error.
#[tokio::test]
async fn flush_all_drafts_atomic_rollback_on_inner_failure() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three live blocks: two valid + one that will hold oversized content.
    let valid_a = "01HZ000000000000000FA00010";
    let valid_b = "01HZ000000000000000FA00011";
    let oversized_id = "01HZ000000000000000FA00012";
    for id in [valid_a, valid_b, oversized_id] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'initial', NULL, 1)",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Two healthy drafts via the public API.
    draft::save_draft(&pool, valid_a, "valid content A")
        .await
        .unwrap();
    draft::save_draft(&pool, valid_b, "valid content B")
        .await
        .unwrap();

    // Third draft seeded directly with oversized content so it slips past
    // any future cap on `save_draft`. `flush_all_drafts_inner` will hit
    // the H-12b guard and propagate `AppError::Validation`, rolling back
    // the outer tx.
    let oversized = "x".repeat(crate::commands::MAX_CONTENT_LENGTH + 1);
    sqlx::query(
        "INSERT INTO block_drafts (block_id, content, updated_at) \
         VALUES (?, ?, '2025-01-01T00:00:00Z')",
    )
    .bind(oversized_id)
    .bind(&oversized)
    .execute(&pool)
    .await
    .unwrap();

    let baseline_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    let baseline_drafts: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(baseline_drafts, 3, "fixture must seed exactly three drafts");

    let err = flush_all_drafts_inner(&pool, DEV, &mat)
        .await
        .expect_err("oversized draft must propagate AppError::Validation");
    match err {
        AppError::Validation(_) => {}
        other => panic!("expected AppError::Validation, got {other:?}"),
    }

    // Outer tx rolled back: drafts table unchanged, no op_log rows added.
    let after_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        after_ops, baseline_ops,
        "all-or-nothing: a single draft failure must add zero op_log rows"
    );
    let after_drafts: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        after_drafts, baseline_drafts,
        "all-or-nothing: a single draft failure must leave every draft row in place"
    );

    mat.shutdown();
}

// ======================================================================
// PEND-18 Phase 2 — SpaceScope parity test (blocks/queries.rs)
// ======================================================================
//
// Asserts that `batch_resolve_inner` honours the `&SpaceScope` boundary:
// `Global` returns the union across spaces (FEAT-3p4 cross-space behaviour),
// while `Active(SpaceId)` drops foreign-space targets so the frontend's
// resolve store renders them via the broken-link branch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend18_batch_resolve_scope_parity() {
    let (pool, _dir) = test_pool().await;

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "P18_BR_A", "page", "Page A", None, None).await;
    insert_block(&pool, "P18_BR_B", "page", "Page B", None, None).await;
    assign_to_space(&pool, "P18_BR_A", TEST_SPACE_ID).await;
    assign_to_space(&pool, "P18_BR_B", TEST_SPACE_B_ID).await;

    let global = batch_resolve_inner(
        &pool,
        vec!["P18_BR_A".into(), "P18_BR_B".into()],
        &SpaceScope::Global,
    )
    .await
    .unwrap();
    assert_eq!(
        global.len(),
        2,
        "Global must resolve both spaces' pages; got {global:?}"
    );

    let active_a = batch_resolve_inner(
        &pool,
        vec!["P18_BR_A".into(), "P18_BR_B".into()],
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        active_a.len(),
        1,
        "Active(TEST_SPACE_ID) must drop the foreign-space target; got {active_a:?}"
    );
    assert_eq!(active_a[0].id, "P18_BR_A");
}

// ======================================================================
// PEND-35 Tier 2.8 — first_child_for_blocks_inner
// ======================================================================
//
// Asserts the per-parent first-child batch query used by the templates
// preview path: `(position ASC, id ASC)` ordering, conflict/soft-delete
// exclusion, and empty-input contract.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_child_for_blocks_returns_first_by_position() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FC_PAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "FC_C2", "content", "second", Some("FC_PAR"), Some(2)).await;
    insert_block(&pool, "FC_C1", "content", "first", Some("FC_PAR"), Some(1)).await;
    insert_block(&pool, "FC_C3", "content", "third", Some("FC_PAR"), Some(3)).await;

    let map = first_child_for_blocks_inner(&pool, vec!["FC_PAR".into()])
        .await
        .unwrap();

    let row = map.get("FC_PAR").expect("FC_PAR has children");
    assert_eq!(
        row.id, "FC_C1",
        "the position=1 child must win the (position ASC, id ASC) ordering; got {row:?}"
    );
    assert_eq!(row.content.as_deref(), Some("first"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_child_for_blocks_breaks_ties_by_id() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FC_TIE_PAR", "page", "parent", None, Some(1)).await;
    // Two children at the same position. ULID `01...A` lex-precedes
    // `01...B`, so the lower-id row must surface as the first child.
    insert_block(
        &pool,
        "01TIE0000000000000000000A",
        "content",
        "low-id",
        Some("FC_TIE_PAR"),
        Some(5),
    )
    .await;
    insert_block(
        &pool,
        "01TIE0000000000000000000B",
        "content",
        "high-id",
        Some("FC_TIE_PAR"),
        Some(5),
    )
    .await;

    let map = first_child_for_blocks_inner(&pool, vec!["FC_TIE_PAR".into()])
        .await
        .unwrap();

    let row = map.get("FC_TIE_PAR").expect("FC_TIE_PAR has children");
    assert_eq!(
        row.id, "01TIE0000000000000000000A",
        "ties on `position` must break by `id ASC`; lower ULID must win. got {row:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_child_for_blocks_excludes_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "FC_EX_PAR", "page", "parent", None, Some(1)).await;
    // Position-1 child is soft-deleted; position-3 child is the active
    // first sibling. The query must skip the deleted row and surface
    // position-3.
    insert_block(
        &pool,
        "FC_EX_DEL",
        "content",
        "deleted",
        Some("FC_EX_PAR"),
        Some(1),
    )
    .await;
    sqlx::query("UPDATE blocks SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'FC_EX_DEL'")
        .execute(&pool)
        .await
        .unwrap();
    insert_block(
        &pool,
        "FC_EX_OK",
        "content",
        "active",
        Some("FC_EX_PAR"),
        Some(3),
    )
    .await;

    let map = first_child_for_blocks_inner(&pool, vec!["FC_EX_PAR".into()])
        .await
        .unwrap();

    let row = map
        .get("FC_EX_PAR")
        .expect("FC_EX_PAR has at least one active child");
    assert_eq!(
        row.id, "FC_EX_OK",
        "the deleted (pos=1) row must be excluded so position-3 wins as \
         the first ACTIVE sibling. got {row:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_child_for_blocks_empty_input_returns_empty_map() {
    let (pool, _dir) = test_pool().await;

    let map = first_child_for_blocks_inner(&pool, vec![]).await.unwrap();
    assert!(
        map.is_empty(),
        "empty input must short-circuit to an empty map (no DB hit), got {map:?}"
    );
}

// ======================================================================
// PEND-35 Tier 2.1 — delete_blocks_by_ids batch
// ======================================================================

/// PEND-35 Tier 2.1 — seeded parent + child + grandchild, calling
/// `delete_blocks_by_ids_inner` with the parent's id alone must
/// soft-delete every descendant via the recursive CTE. Mirrors the
/// single-row `delete_block_cascades_descendants` regression
/// behaviourally (one root, full subtree affected).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_cascades_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
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
        "child".into(),
        Some(parent.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(child.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let affected = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![parent.id.to_string()])
        .await
        .unwrap();
    assert_eq!(
        affected, 3,
        "parent + child + grandchild = 3 rows soft-deleted"
    );

    for id in [&parent.id, &child.id, &grandchild.id] {
        let deleted_at: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            deleted_at.is_some(),
            "block {id} must be soft-deleted by the cascade"
        );
    }
}

/// PEND-35 Tier 2.1 — `delete_blocks_by_ids_inner` writes ONE
/// `delete_block` op_log row per RESOLVED root. Two independent roots
/// + their children = 2 op_log rows total (cascade is captured by
/// the recursive UPDATE, not re-emitted as ops).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_writes_one_op_per_root_in_one_tx() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let r1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "r1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let r2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "r2".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    let _r1c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "r1c".into(),
        Some(r1.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();
    let _r2c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "r2c".into(),
        Some(r2.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Snapshot current op_log seq range so we can assert ONE
    // contiguous range covers the entire batch (no foreign tx
    // sneaking in between).
    let pre_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let affected =
        delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![r1.id.to_string(), r2.id.to_string()])
            .await
            .unwrap();
    assert_eq!(affected, 4, "2 roots + 2 children = 4 cascade rows");

    let post_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let delete_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE device_id = ? AND op_type = 'delete_block' AND seq > ?",
        DEV,
        pre_max,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        delete_count, 2,
        "exactly two delete_block ops (one per root) — descendants \
         covered by the recursive UPDATE, not re-emitted"
    );
    // Op_log seq range must be contiguous (no gaps from competing tx).
    assert_eq!(
        post_max - pre_max,
        2,
        "the 2 ops must occupy a single contiguous seq range under \
         one IMMEDIATE tx; got pre={pre_max} post={post_max}"
    );
}

/// PEND-35 Tier 2.1 — already-soft-deleted block in the input list
/// is silently skipped (no double-delete, no extra op_log row).
/// Calling with the SAME id twice in a row yields zero work the
/// second time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_skips_already_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "b".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let first = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![b.id.to_string()])
        .await
        .unwrap();
    assert_eq!(first, 1, "first call soft-deletes the block");

    let second = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![b.id.to_string()])
        .await
        .unwrap();
    assert_eq!(
        second, 0,
        "second call must skip the now-deleted block — zero affected"
    );

    let op_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'delete_block' AND block_id = ?",
        b.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        op_count, 1,
        "exactly one delete_block op total — the no-op second call \
         must NOT append a duplicate op_log row"
    );
}

/// PEND-35 Tier 2.1 — missing ids in the input list silently drop out
/// (mirror of the `set_todo_state_batch` lenient-skip semantic). A
/// batch that contains ONLY ghosts must commit cleanly with zero
/// affected rows and zero op_log writes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_only_ghosts_returns_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let pre_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let affected =
        delete_blocks_by_ids_inner(&pool, DEV, &mat, vec!["GHOST1".into(), "GHOST2".into()])
            .await
            .unwrap();
    assert_eq!(affected, 0, "no live roots → zero affected");

    let post_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pre_max, post_max,
        "no op_log rows must be appended when every input id is missing"
    );
}

/// PEND-35 Tier 2.1 — mixed input (one live, one ghost): the live
/// root is soft-deleted, the ghost is silently dropped. The whole tx
/// commits — partial misses must NOT abort the batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_partial_miss_commits_live_subset() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let live = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "live".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let affected =
        delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![live.id.to_string(), "GHOST".into()])
            .await
            .unwrap();
    assert_eq!(affected, 1, "the live root is soft-deleted; ghost ignored");

    let deleted_at: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&live.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(deleted_at.is_some(), "live root must be soft-deleted");
}

/// PEND-35 Tier 2.1 — empty input list rejects with `Validation`
/// (mirrors every other batch boundary in the surface).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_rejects_empty_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![]).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty list must reject with Validation, got {result:?}"
    );
}

/// PEND-35 Tier 2.1 — input list above the batch cap rejects with
/// `Validation` (defends the writer-lock blast radius).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_rejects_oversize_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let oversize: Vec<String> = (0..(crate::commands::properties::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| format!("ID{i}"))
        .collect();
    let result = delete_blocks_by_ids_inner(&pool, DEV, &mat, oversize).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize list must reject with Validation, got {result:?}"
    );
}

/// PEND-35 Tier 2.1 — selecting both an ancestor and one of its
/// descendants in the same batch must NOT double-count (the
/// recursive CTE walks the union; the descendant is already covered
/// by the ancestor's subtree). Anchors the FE refactor: the FE no
/// longer needs the MAINT-173 ancestor-pre-walk because the backend
/// coalesces.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_coalesces_ancestor_plus_descendant() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let ancestor = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "anc".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let descendant = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "desc".into(),
        Some(ancestor.id.clone().into_string()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let affected = delete_blocks_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec![ancestor.id.to_string(), descendant.id.to_string()],
    )
    .await
    .unwrap();
    assert_eq!(
        affected, 2,
        "the descendant is reachable from the ancestor's subtree, so \
         the cascade marks each row exactly once"
    );

    // Two delete_block ops: one per RESOLVED root in the input list.
    // The descendant was a live root at probe time too — we don't
    // pre-filter the input set on the backend, so its op fires.
    // Verify exactly TWO ops landed (no descendant-cascade ops).
    let op_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE device_id = ? AND op_type = 'delete_block' \
           AND (block_id = ? OR block_id = ?)",
        DEV,
        ancestor.id,
        descendant.id,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        op_count, 2,
        "one op per resolved root in the input list (ancestor + descendant); \
         the cascade UPDATE does NOT emit ops for the implicit subtree members"
    );
}

/// PEND-35 Tier 2.1 — id casing must be normalised to uppercase
/// before SQL touch (AGENTS.md invariant #8). Lower-case input
/// resolves the same row as upper-case.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_blocks_by_ids_normalises_lowercase_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "DBI_NORM_01", "content", "lowered", None, Some(1)).await;

    let affected = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec!["dbi_norm_01".into()])
        .await
        .unwrap();
    assert_eq!(
        affected, 1,
        "lowercase id must be normalised to uppercase before SQL membership probe"
    );
}

// ======================================================================
// #81 / PEND-57 — move_blocks_to_space (bulk move-to-space)
// ======================================================================

/// Seed the synthetic test space as a real space block (so the upfront
/// `is_space = 'true'` validation passes).
async fn seed_space(pool: &SqlitePool, space_id: &str) {
    insert_block(pool, space_id, "page", "Space", None, None).await;
    mark_block_as_space(pool, space_id).await;
}

/// Happy path: N blocks moved to a target space writes N `set_property`
/// (space) ops in a single contiguous seq range and N materialised
/// `block_properties(space)` rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_moves_all_in_one_tx() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    seed_space(&pool, "MBS_SPACE").await;
    let mut ids = Vec::new();
    for i in 0..4 {
        let id = format!("MBS_BLK_{i}");
        insert_block(&pool, &id, "page", "pg", None, Some(i + 1)).await;
        ids.push(id);
    }

    let pre_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let moved = move_blocks_to_space_inner(&pool, DEV, &mat, ids.clone(), "MBS_SPACE".into())
        .await
        .unwrap();
    assert_eq!(moved, 4, "all four blocks should be reported as moved");

    let post_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        post_max - pre_max,
        4,
        "the 4 set_property(space) ops must occupy a single contiguous seq range"
    );

    for id in &ids {
        let space_ref: Option<String> = sqlx::query_scalar::<_, Option<String>>(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
        )
        .bind(id)
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
        assert_eq!(
            space_ref.as_deref(),
            Some("MBS_SPACE"),
            "block {id} must carry the target space ref"
        );
    }
}

/// Re-homing: a block already in space A moves to space B (the `space`
/// ref is overwritten, not duplicated).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_rehomes_existing_member() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    seed_space(&pool, "MBS2_SPACE_A").await;
    seed_space(&pool, "MBS2_SPACE_B").await;
    insert_block(&pool, "MBS2_BLK", "page", "pg", None, Some(1)).await;
    assign_to_space(&pool, "MBS2_BLK", "MBS2_SPACE_A").await;

    let moved = move_blocks_to_space_inner(
        &pool,
        DEV,
        &mat,
        vec!["MBS2_BLK".into()],
        "MBS2_SPACE_B".into(),
    )
    .await
    .unwrap();
    assert_eq!(moved, 1);

    // Exactly one `space` row, pointing at B.
    let rows: Vec<Option<String>> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
    )
    .bind("MBS2_BLK")
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "INSERT OR REPLACE keeps a single space row");
    assert_eq!(rows[0].as_deref(), Some("MBS2_SPACE_B"));
}

/// Lenient batch: missing / soft-deleted ids are silently skipped; only
/// the live subset is moved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_skips_missing_and_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    seed_space(&pool, "MBS3_SPACE").await;
    let live = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "live".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let deleted = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "gone".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;
    delete_block_inner(&pool, DEV, &mat, deleted.id.clone().into_string())
        .await
        .unwrap();
    settle(&mat).await;

    let moved = move_blocks_to_space_inner(
        &pool,
        DEV,
        &mat,
        vec![
            live.id.to_string(),
            deleted.id.to_string(),
            "MBS3_GHOST".into(),
        ],
        "MBS3_SPACE".into(),
    )
    .await
    .unwrap();
    assert_eq!(moved, 1, "only the live block is moved");

    let space_ref: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
    )
    .bind(&live.id)
    .fetch_optional(&pool)
    .await
    .unwrap()
    .flatten();
    assert_eq!(space_ref.as_deref(), Some("MBS3_SPACE"));
}

/// ULID normalisation: lowercase block + space ids resolve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_normalises_lowercase_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    seed_space(&pool, "MBS4_SPACE").await;
    insert_block(&pool, "MBS4_BLK01", "page", "pg", None, Some(1)).await;

    let moved = move_blocks_to_space_inner(
        &pool,
        DEV,
        &mat,
        vec!["mbs4_blk01".into()],
        "mbs4_space".into(),
    )
    .await
    .unwrap();
    assert_eq!(moved, 1, "lowercase ids must normalise to uppercase match");
}

/// Empty input list rejected up-front.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_rejects_empty_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    seed_space(&pool, "MBS5_SPACE").await;

    let result = move_blocks_to_space_inner(&pool, DEV, &mat, vec![], "MBS5_SPACE".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_ids must be rejected, got {result:?}"
    );
}

/// Over-cap input list rejected up-front.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_rejects_oversize_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    seed_space(&pool, "MBS6_SPACE").await;

    let oversize: Vec<String> = (0..(crate::commands::properties::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| format!("MBS6_{i:026}"))
        .collect();
    let result = move_blocks_to_space_inner(&pool, DEV, &mat, oversize, "MBS6_SPACE".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize block_ids must be rejected, got {result:?}"
    );
}

/// A `space_id` that is not a live `is_space = 'true'` block aborts the
/// whole batch with `Validation` and writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_to_space_rejects_non_space_target() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // A plain page that is NOT flagged is_space.
    insert_block(&pool, "MBS7_NOTSPACE", "page", "not a space", None, None).await;
    insert_block(&pool, "MBS7_BLK", "page", "pg", None, Some(1)).await;

    let result = move_blocks_to_space_inner(
        &pool,
        DEV,
        &mat,
        vec!["MBS7_BLK".into()],
        "MBS7_NOTSPACE".into(),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "non-space target must be rejected, got {result:?}"
    );

    // Nothing was written by the aborted batch.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'space'",
    )
    .bind("MBS7_BLK")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0, "aborted batch must write no space property rows");
}

// ======================================================================
// PEND-35 Tier 4.3 — create_blocks_batch
// ======================================================================

/// PEND-35 Tier 4.3 — N input specs land as N blocks AND N op_log
/// rows that all share a single contiguous seq range (one tx, no
/// foreign tx interleaving). Mirrors the
/// `delete_blocks_by_ids_writes_one_op_per_root_in_one_tx` pattern.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_blocks_batch_inserts_n_blocks_in_one_tx() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let pre_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let n: usize = 5;
    let specs: Vec<crate::commands::CreateBlockSpec> = (0..n)
        .map(|i| crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: format!("line {i}"),
            parent_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
        })
        .collect();

    let created = crate::commands::create_blocks_batch_inner(&pool, DEV, &mat, specs)
        .await
        .unwrap();
    assert_eq!(created.len(), n, "returned vec length matches input length");

    // Block rows persisted.
    for (i, row) in created.iter().enumerate() {
        let persisted: Option<String> =
            sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(&row.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            persisted,
            Some(format!("line {i}")),
            "block {i} content must be persisted"
        );
    }

    // Op_log rows: exactly N create_block ops, all in one contiguous
    // seq range from `pre_max + 1` to `pre_max + n`.
    let post_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        post_max - pre_max,
        i64::try_from(n).expect("count fits in i64"),
        "exactly N seq slots consumed under one IMMEDIATE tx; \
         pre={pre_max} post={post_max}"
    );

    let create_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE device_id = ? AND op_type = 'create_block' AND seq > ?",
        DEV,
        pre_max,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        create_count,
        i64::try_from(n).expect("count fits in i64"),
        "exactly N create_block op_log rows under this batch"
    );
}

/// PEND-35 Tier 4.3 — an invalid `block_type` mid-batch must roll the
/// whole transaction back. After the call returns Err, neither the
/// blocks table nor the op_log carries any rows from the attempted
/// batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_blocks_batch_atomic_rollback() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let pre_block_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    let pre_op_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE device_id = ?", DEV)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Spec 0 is valid, spec 1 has an unknown block_type, spec 2 is
    // valid but should never run because spec 1 aborts the tx via `?`.
    let specs = vec![
        crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: "valid first".into(),
            parent_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
        },
        crate::commands::CreateBlockSpec {
            block_type: "not_a_real_type".into(),
            content: "this errors".into(),
            parent_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
        },
        crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: "valid third".into(),
            parent_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
        },
    ];

    let result = crate::commands::create_blocks_batch_inner(&pool, DEV, &mat, specs).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid block_type must reject with Validation, got {result:?}"
    );

    let post_block_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    let post_op_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE device_id = ?", DEV)
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        pre_block_count, post_block_count,
        "atomic rollback: zero new rows in `blocks` (the valid first spec must NOT survive)"
    );
    assert_eq!(
        pre_op_count, post_op_count,
        "atomic rollback: zero new rows in `op_log` (no partial create_block ops persisted)"
    );
}

/// PEND-35 Tier 4.3 — empty input rejects with Validation; oversize
/// input rejects with Validation. Mirror of
/// `delete_blocks_by_ids_rejects_empty_list` /
/// `…_rejects_oversize_list`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_blocks_batch_rejects_empty_oversize() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let empty = crate::commands::create_blocks_batch_inner(&pool, DEV, &mat, vec![]).await;
    assert!(
        matches!(empty, Err(AppError::Validation(_))),
        "empty list must reject with Validation, got {empty:?}"
    );

    let oversize: Vec<crate::commands::CreateBlockSpec> = (0
        ..(crate::commands::properties::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: format!("c{i}"),
            parent_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
        })
        .collect();
    let result = crate::commands::create_blocks_batch_inner(&pool, DEV, &mat, oversize).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize list must reject with Validation, got {result:?}"
    );
}

/// PEND-35 Tier 4.3 — each spec carries `properties`. After commit,
/// every spec's block exists AND its properties land in either
/// `block_properties` (non-reserved keys) or the corresponding column
/// on `blocks` (reserved keys: `todo_state` / `priority` / `due_date`
/// / `scheduled_date`). Mirrors `import_markdown_inner`'s
/// per-block + per-property loop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_blocks_batch_with_properties() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let mut props_a: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Reserved → blocks column. Property def for `priority` only
    // accepts `1` / `2` / `3` (see `crate::commands::properties` defaults),
    // so we use `1` here rather than the alphabetic `A` from earlier
    // schemas.
    props_a.insert("priority".into(), "1".into());
    props_a.insert("project".into(), "agaric".into()); // non-reserved → block_properties

    let mut props_b: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    props_b.insert("todo_state".into(), "TODO".into()); // reserved → blocks column

    let specs = vec![
        crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: "with reserved + non-reserved props".into(),
            parent_id: None,
            position: None,
            properties: props_a,
        },
        crate::commands::CreateBlockSpec {
            block_type: "content".into(),
            content: "todo block".into(),
            parent_id: None,
            position: None,
            properties: props_b,
        },
    ];

    let created = crate::commands::create_blocks_batch_inner(&pool, DEV, &mat, specs)
        .await
        .unwrap();
    assert_eq!(created.len(), 2);

    let id_a = &created[0].id;
    let id_b = &created[1].id;

    // Reserved key on block A: `priority` lives on the blocks row.
    let prio_a: Option<String> = sqlx::query_scalar("SELECT priority FROM blocks WHERE id = ?")
        .bind(id_a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        prio_a,
        Some("1".into()),
        "priority must land on blocks.priority via reserved-key dispatch"
    );

    // Non-reserved on block A: `project` lives on block_properties.
    let project_a: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'project'",
    )
    .bind(id_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        project_a,
        Some("agaric".into()),
        "non-reserved key must land in block_properties.value_text"
    );

    // Reserved on block B: `todo_state` lives on blocks row.
    let todo_b: Option<String> = sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
        .bind(id_b)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        todo_b,
        Some("TODO".into()),
        "todo_state must land on blocks.todo_state via reserved-key dispatch"
    );

    // Op_log: 2 create_block + 3 set_property (priority, project for A
    // + todo_state for B). All under one device. Verify the count
    // matches the property + block ops we sent.
    let create_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE device_id = ? AND op_type = 'create_block' \
           AND (block_id = ? OR block_id = ?)",
        DEV,
        id_a,
        id_b,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(create_count, 2, "exactly 2 create_block ops");

    let set_prop_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE device_id = ? AND op_type = 'set_property' \
           AND (block_id = ? OR block_id = ?)",
        DEV,
        id_a,
        id_b,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        set_prop_count, 3,
        "exactly 3 set_property ops (priority + project for A, todo_state for B)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_cross_space_content_rejected() {
    // PEND-76 F5: editing a block to reference a block in a different
    // space is rejected.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    let src = create_block_inner(&pool, DEV, &mat, "content".into(), "src".into(), None, None)
        .await
        .unwrap();
    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "target".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assign_to_space(&pool, src.id.as_str(), TEST_SPACE_ID).await;
    assign_to_space(&pool, target.id.as_str(), TEST_SPACE_B_ID).await;

    let result = edit_block_inner(
        &pool,
        DEV,
        &mat,
        src.id.clone().into_string(),
        format!("see [[{}]]", target.id),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "cross-space content edit must be rejected, got {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_cross_space_content_rejected() {
    // PEND-76 F5: creating a block (under a page in space A) whose content
    // references a block in space B is rejected.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    assign_to_space(&pool, page_a.id.as_str(), TEST_SPACE_ID).await;
    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "target".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assign_to_space(&pool, target.id.as_str(), TEST_SPACE_B_ID).await;

    // A child under page_a (resolves to space A) referencing the space-B target.
    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", target.id),
        Some(page_a.id.clone().into_string()),
        None,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "cross-space content on create must be rejected, got {result:?}"
    );
}

// ======================================================================
// PEND-76 F2 — bytes-over-IPC attachment add/read
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_with_bytes_writes_persists_and_reads_back() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let app_data_dir = _dir.path();

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let bytes: Vec<u8> = vec![1, 2, 3, 4, 5, 6, 7, 8];
    let att = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "photo.png".into(),
        "image/png".into(),
        bytes.clone(),
    )
    .await
    .unwrap();

    assert_eq!(att.block_id, block.id);
    assert_eq!(att.size_bytes, 8);
    assert!(
        att.fs_path.starts_with("attachments/"),
        "backend-generated path must live under attachments/, got {}",
        att.fs_path
    );

    // Bytes were written to disk at the generated path.
    let on_disk = std::fs::read(app_data_dir.join(&att.fs_path)).unwrap();
    assert_eq!(on_disk, bytes, "file on disk must match the uploaded bytes");

    // read_attachment returns the same bytes.
    let read_back = read_attachment_inner(&pool, app_data_dir, att.id.clone())
        .await
        .unwrap();
    assert_eq!(
        read_back, bytes,
        "read_attachment must return the uploaded bytes"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_with_bytes_rejects_disallowed_mime_without_writing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let app_data_dir = _dir.path();
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "x".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let result = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        block.id.clone().into_string(),
        "evil.exe".into(),
        "application/x-msdownload".into(),
        vec![0u8; 16],
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "disallowed MIME must be rejected, got {result:?}"
    );
    assert!(
        !attachments_dir_has_files(app_data_dir),
        "a rejected (bad-MIME) upload must not write any file"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_attachment_with_bytes_cleans_up_when_block_missing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let app_data_dir = _dir.path();

    // No such block → add_attachment_inner returns NotFound *after* the bytes
    // were written → the wrapper must unlink them (no leak).
    let result = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        "01HZ0000000000000000NOBLK1".into(),
        "photo.png".into(),
        "image/png".into(),
        vec![9u8; 32],
    )
    .await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "missing block must be NotFound, got {result:?}"
    );
    assert!(
        !attachments_dir_has_files(app_data_dir),
        "bytes written before a rejected add must be cleaned up"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_attachment_missing_id_is_not_found() {
    let (pool, _dir) = test_pool().await;
    let app_data_dir = _dir.path();
    let result =
        read_attachment_inner(&pool, app_data_dir, "01HZ0000000000000000NOATT1".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "unknown attachment id must be NotFound, got {result:?}"
    );
}

/// True iff `<app_data_dir>/attachments` exists and contains at least one entry.
fn attachments_dir_has_files(app_data_dir: &std::path::Path) -> bool {
    let dir = app_data_dir.join("attachments");
    std::fs::read_dir(&dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}
