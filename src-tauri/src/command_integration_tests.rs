//! Command-layer integration tests — bulletproof API surface coverage.
//!
//! These tests exercise every Tauri command `_inner` function as an API
//! contract.  They complement:
//! - **Unit tests** (per-module, in each `mod tests`)
//! - **Integration tests** (cross-module pipelines in `integration_tests.rs`)
//!
//! Focus: verify every command's happy path, error variants, edge cases,
//! and cross-cutting lifecycle interactions at the command boundary.

use crate::commands::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op_log;
use crate::soft_delete;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::PathBuf;
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/// Device ID used across all command integration tests.
const DEV: &str = "cmd-test-device-001";

/// Creates a temporary SQLite database with all migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Create a Materializer backed by the given pool.
fn test_materializer(pool: &SqlitePool) -> Materializer {
    Materializer::new(pool.clone())
}

/// Insert a block directly into the blocks table (bypasses command layer).
async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .execute(pool)
    .await
    .unwrap();
}

/// Allow materializer background tasks to settle before the next write.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

// ======================================================================
// create_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_content_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    assert_eq!(resp.block_type, "content", "block_type must be content");
    assert_eq!(
        resp.content,
        Some("hello world".into()),
        "content must match input"
    );
    assert!(resp.parent_id.is_none(), "top-level block has no parent");
    assert_eq!(resp.position, Some(1), "position must match input");
    assert!(resp.deleted_at.is_none(), "new block must not be deleted");
    assert_eq!(resp.id.len(), 26, "ULID must be 26 chars");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_tag_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(&pool, DEV, &mat, "tag".into(), "urgent".into(), None, None)
        .await
        .unwrap();

    assert_eq!(resp.block_type, "tag", "block_type must be tag");
    assert_eq!(resp.content, Some("urgent".into()), "content must match");
    assert_eq!(
        resp.position,
        Some(1),
        "auto-assigned position for first block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_block_returns_correct_fields() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        Some(10),
    )
    .await
    .unwrap();

    assert_eq!(resp.block_type, "page", "block_type must be page");
    assert_eq!(resp.content, Some("My Page".into()), "content must match");
    assert_eq!(resp.position, Some(10), "position must match");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_parent_sets_parent_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    settle().await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    assert_eq!(
        child.parent_id,
        Some(parent.id),
        "child.parent_id must match parent's ID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_position_preserves_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "positioned".into(),
        None,
        Some(42),
    )
    .await
    .unwrap();

    assert_eq!(
        resp.position,
        Some(42),
        "position must be preserved exactly"
    );

    // Verify in DB
    let row = get_block_inner(&pool, resp.id).await.unwrap();
    assert_eq!(row.position, Some(42), "position must be persisted in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_empty_content_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(&pool, DEV, &mat, "content".into(), "".into(), None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.content,
        Some("".into()),
        "empty content must be stored as-is"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_with_large_unicode_content_preserves_data() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Build ~100KB of unicode content
    let unit = "日本語テスト🌍Ñ ";
    let repeat = 100_000 / unit.len() + 1;
    let large_content: String = unit.repeat(repeat);
    assert!(
        large_content.len() >= 100_000,
        "test content must be at least 100KB"
    );

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        large_content.clone(),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp.content,
        Some(large_content.clone()),
        "large unicode content must be preserved in response"
    );

    // Round-trip through DB
    let row = get_block_inner(&pool, resp.id).await.unwrap();
    assert_eq!(
        row.content,
        Some(large_content),
        "large unicode content must survive DB round-trip"
    );
}

// ======================================================================
// create_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_invalid_block_type_returns_validation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "invalid_type".into(),
        "text".into(),
        None,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid block_type must return AppError::Validation"
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("unknown block_type"),
        "error message must mention unknown block_type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some("NONEXISTENT_PARENT_000".into()),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent parent must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
    settle().await;

    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    settle().await;

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id),
        Some(1),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "deleted parent must return AppError::NotFound"
    );
}

// ======================================================================
// create_block — concurrency & op_log
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_multiple_blocks_rapidly_all_get_unique_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let mut ids = HashSet::new();
    for i in 0..20 {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await
        .unwrap();
        ids.insert(resp.id);
    }

    assert_eq!(
        ids.len(),
        20,
        "all 20 rapid creates must produce unique IDs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let resp = create_block_inner(
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

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op should be logged after create");
    assert_eq!(ops[0].seq, 1, "first op should have seq=1");
    assert_eq!(
        ops[0].op_type, "create_block",
        "op_type must be create_block"
    );
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains(&resp.id),
        "payload must contain the block ID"
    );
}

// ======================================================================
// edit_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_updates_content_and_returns_new_value() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("updated".into()),
        "edit must return new content"
    );
    assert_eq!(edited.id, created.id, "ID must not change on edit");
    assert_eq!(
        edited.block_type, "content",
        "block_type must not change on edit"
    );

    // Verify in DB
    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        row.content,
        Some("updated".into()),
        "DB must reflect updated content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_unicode_content_preserved() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let unicode = "日本語テスト 🎌 über café résumé Ñoño";
    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), unicode.into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some(unicode.into()),
        "unicode content must survive edit round-trip"
    );

    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert_eq!(
        row.content,
        Some(unicode.into()),
        "unicode must survive DB round-trip"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_empty_string_succeeds() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "".into())
        .await
        .unwrap();

    assert_eq!(
        edited.content,
        Some("".into()),
        "edit to empty string must succeed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_sequential_edits_chain_prev_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
        .await
        .unwrap();
    settle().await;

    // Second edit — should chain prev_edit
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
        .await
        .unwrap();

    // Inspect the last edit_block op_log entry
    let row = sqlx::query!(
        "SELECT payload FROM op_log WHERE op_type = 'edit_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
    assert!(
        !payload["prev_edit"].is_null(),
        "second edit must have prev_edit set in op_log payload"
    );
}

// ======================================================================
// edit_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT_BLK".into(), "text".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "will delete".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();
    settle().await;

    let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "editing a deleted block must return AppError::NotFound"
    );
}

// ======================================================================
// delete_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_marks_as_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    let del = delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    assert!(
        !del.deleted_at.is_empty(),
        "deleted_at timestamp must be set"
    );
    assert_eq!(del.block_id, created.id, "block_id must match");

    let row = get_block_inner(&pool, created.id).await.unwrap();
    assert!(
        row.deleted_at.is_some(),
        "block must be marked as deleted in DB"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_cascades_to_children() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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
    settle().await;

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let del = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();

    assert_eq!(
        del.descendants_affected, 2,
        "parent + child = 2 descendants affected"
    );

    let child_row = get_block_inner(&pool, child.id).await.unwrap();
    assert!(
        child_row.deleted_at.is_some(),
        "child must be cascade-deleted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_blocks_excluded_from_list_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "alive".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();

    let live = list_blocks_inner(&pool, None, None, None, None, None, None, None)
        .await
        .unwrap();

    assert_eq!(live.items.len(), 1, "only alive blocks in normal list");
    assert_eq!(live.items[0].id, b1.id, "surviving block must be b1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_blocks_visible_in_list_blocks_show_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "alive".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();

    let trash = list_blocks_inner(&pool, None, None, None, Some(true), None, None, None)
        .await
        .unwrap();

    assert_eq!(trash.items.len(), 1, "only deleted blocks in trash view");
    assert_eq!(trash.items[0].id, b2.id, "deleted block must be b2");

    // alive block must NOT appear in trash
    let trash_ids: Vec<&str> = trash.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        !trash_ids.contains(&b1.id.as_str()),
        "alive block must not appear in trash"
    );
}

// ======================================================================
// delete_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = delete_block_inner(&pool, DEV, &mat, "GHOST_BLK_999".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "deleting nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_already_deleted_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "delete twice".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    let result = delete_block_inner(&pool, DEV, &mat, created.id).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "double-delete must return AppError::InvalidOperation"
    );
}

// ======================================================================
// restore_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_clears_deleted_at() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "REST01", "content", "restore me", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "REST01")
        .await
        .unwrap();

    let resp = restore_block_inner(&pool, DEV, &mat, "REST01".into(), ts)
        .await
        .unwrap();

    assert_eq!(resp.block_id, "REST01", "block_id must match");
    assert!(resp.restored_count >= 1, "at least one block restored");

    let row = get_block_inner(&pool, "REST01".into()).await.unwrap();
    assert!(
        row.deleted_at.is_none(),
        "deleted_at must be cleared after restore"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_cascades_to_descendants() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RPAR", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "RCHD", "content", "child", Some("RPAR"), Some(1)).await;
    insert_block(
        &pool,
        "RGCH",
        "content",
        "grandchild",
        Some("RCHD"),
        Some(1),
    )
    .await;

    let (ts, count) = soft_delete::cascade_soft_delete(&pool, "RPAR")
        .await
        .unwrap();
    assert_eq!(count, 3, "cascade must delete parent + child + grandchild");

    let resp = restore_block_inner(&pool, DEV, &mat, "RPAR".into(), ts)
        .await
        .unwrap();

    assert_eq!(resp.restored_count, 3, "all 3 descendants must be restored");

    for id in &["RPAR", "RCHD", "RGCH"] {
        let row = get_block_inner(&pool, id.to_string()).await.unwrap();
        assert!(
            row.deleted_at.is_none(),
            "block {id} must have deleted_at cleared after restore"
        );
    }
}

// ======================================================================
// restore_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = restore_block_inner(
        &pool,
        DEV,
        &mat,
        "GHOST_REST".into(),
        "2025-01-01T00:00:00Z".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "restoring nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_non_deleted_block_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ALIVE01", "content", "alive", None, Some(1)).await;

    let result = restore_block_inner(
        &pool,
        DEV,
        &mat,
        "ALIVE01".into(),
        "2025-01-01T00:00:00Z".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "restoring non-deleted block must return AppError::InvalidOperation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_with_wrong_deleted_at_ref_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MISMATCH01", "content", "test", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "MISMATCH01")
        .await
        .unwrap();

    let wrong_ts = format!("{ts}_WRONG");
    let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH01".into(), wrong_ts).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "mismatched deleted_at must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("deleted_at mismatch"),
        "error message must mention mismatch"
    );
}

// ======================================================================
// purge_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_removes_from_db() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE01", "content", "doomed", None, Some(1)).await;
    soft_delete::cascade_soft_delete(&pool, "PURGE01")
        .await
        .unwrap();

    let resp = purge_block_inner(&pool, DEV, &mat, "PURGE01".into())
        .await
        .unwrap();

    assert_eq!(resp.purged_count, 1, "one block must be purged");
    assert_eq!(resp.block_id, "PURGE01", "block_id must match");

    let exists = sqlx::query_scalar!("SELECT id FROM blocks WHERE id = ?", "PURGE01")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        exists.is_none(),
        "block must be physically removed from DB after purge"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_removes_tags_properties_attachments_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block and tag
    insert_block(
        &pool,
        "PURGE_REL",
        "content",
        "has relations",
        None,
        Some(1),
    )
    .await;
    insert_block(&pool, "PURGE_TAG", "tag", "my-tag", None, None).await;
    insert_block(&pool, "PURGE_TGT", "content", "link target", None, Some(2)).await;

    // Add related rows
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("PURGE_TAG")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind("PURGE_REL")
        .bind("priority")
        .bind("high")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATT-PURGE-001")
    .bind("PURGE_REL")
    .bind("text/plain")
    .bind("readme.txt")
    .bind(256_i64)
    .bind("/tmp/readme.txt")
    .bind("2024-01-01T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("PURGE_REL")
        .bind("PURGE_TGT")
        .execute(&pool)
        .await
        .unwrap();

    // Soft-delete then purge
    soft_delete::cascade_soft_delete(&pool, "PURGE_REL")
        .await
        .unwrap();
    purge_block_inner(&pool, DEV, &mat, "PURGE_REL".into())
        .await
        .unwrap();

    // Verify all gone
    let tags: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = ?",
        "PURGE_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tags, 0, "block_tags must be purged");

    let props: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
        "PURGE_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(props, 0, "block_properties must be purged");

    let atts: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
        "PURGE_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(atts, 0, "attachments must be purged");

    let links: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_links WHERE source_id = ?",
        "PURGE_REL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(links, 0, "block_links must be purged");
}

// ======================================================================
// purge_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = purge_block_inner(&pool, DEV, &mat, "GHOST_PURGE".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "purging nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_non_deleted_block_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE_ALIVE", "content", "alive", None, Some(1)).await;

    let result = purge_block_inner(&pool, DEV, &mat, "PURGE_ALIVE".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "purging non-deleted block must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("soft-deleted before purging"),
        "error message must explain the requirement"
    );
}

// ======================================================================
// list_blocks — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_top_level_returns_root_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "ROOT1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "ROOT2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "CHILD1", "content", "c", Some("ROOT1"), Some(1)).await;

    let resp = list_blocks_inner(&pool, None, None, None, None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "must only return top-level blocks (parent_id IS NULL)"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"ROOT1"), "ROOT1 must be in results");
    assert!(ids.contains(&"ROOT2"), "ROOT2 must be in results");
    assert!(
        !ids.contains(&"CHILD1"),
        "CHILD1 must not be in top-level results"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_parent_id_returns_children_only() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LP01", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "LC01", "content", "child 1", Some("LP01"), Some(1)).await;
    insert_block(&pool, "LC02", "content", "child 2", Some("LP01"), Some(2)).await;
    insert_block(&pool, "LOTHER", "content", "other", None, Some(2)).await;

    let resp = list_blocks_inner(
        &pool,
        Some("LP01".into()),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2, "must return only children of LP01");
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"LC01"), "LC01 must be in children");
    assert!(ids.contains(&"LC02"), "LC02 must be in children");
    assert!(
        !ids.contains(&"LOTHER"),
        "LOTHER must not be in children of LP01"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_block_type_filter_returns_matching_type() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LPAGE1", "page", "my page", None, Some(1)).await;
    insert_block(&pool, "LTAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "LCONT1", "content", "hello", None, Some(2)).await;

    let resp = list_blocks_inner(
        &pool,
        None,
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "must return only page type blocks");
    assert_eq!(resp.items[0].id, "LPAGE1", "page block must be LPAGE1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_empty_db_returns_empty_page_no_more() {
    let (pool, _dir) = test_pool().await;

    let resp = list_blocks_inner(&pool, None, None, None, None, None, None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "empty DB must return empty items");
    assert!(!resp.has_more, "empty DB must have has_more=false");
    assert!(
        resp.next_cursor.is_none(),
        "empty DB must have no next_cursor"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_show_deleted_returns_only_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LD_ALIVE", "content", "alive", None, Some(1)).await;
    insert_block(&pool, "LD_DEAD1", "content", "dead1", None, Some(2)).await;
    insert_block(&pool, "LD_DEAD2", "content", "dead2", None, Some(3)).await;

    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-15T00:00:00+00:00' WHERE id = 'LD_DEAD1'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-16T00:00:00+00:00' WHERE id = 'LD_DEAD2'")
        .execute(&pool)
        .await
        .unwrap();

    let trash = list_blocks_inner(&pool, None, None, None, Some(true), None, None, None)
        .await
        .unwrap();

    assert_eq!(
        trash.items.len(),
        2,
        "trash must contain only 2 deleted blocks"
    );
    let ids: Vec<&str> = trash.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"LD_DEAD1"), "LD_DEAD1 must be in trash");
    assert!(ids.contains(&"LD_DEAD2"), "LD_DEAD2 must be in trash");
    assert!(
        !ids.contains(&"LD_ALIVE"),
        "alive block must not appear in trash"
    );
}

// ======================================================================
// list_blocks — pagination
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_walk_all_pages_no_duplicates() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create 15 blocks
    for i in 0..15 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await
        .unwrap();
    }

    let mut all_ids = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let page = list_blocks_inner(&pool, None, None, None, None, None, cursor, Some(4))
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

    assert_eq!(all_ids.len(), 15, "must collect all 15 blocks across pages");
    assert!(pages >= 2, "must require multiple pages");

    let unique: HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
    assert_eq!(
        unique.len(),
        15,
        "no duplicate blocks across paginated pages"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_limit_1_produces_single_item_pages() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PG1", "content", "a", None, Some(1)).await;
    insert_block(&pool, "PG2", "content", "b", None, Some(2)).await;
    insert_block(&pool, "PG3", "content", "c", None, Some(3)).await;

    let mut cursor: Option<String> = None;
    let mut all_ids = Vec::new();
    let mut pages = 0;

    loop {
        let page = list_blocks_inner(&pool, None, None, None, None, None, cursor, Some(1))
            .await
            .unwrap();
        assert!(
            page.items.len() <= 1,
            "limit=1 must produce at most 1 item per page"
        );
        for item in &page.items {
            all_ids.push(item.id.clone());
        }
        pages += 1;
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }

    assert_eq!(all_ids.len(), 3, "must collect all 3 blocks");
    assert_eq!(pages, 3, "limit=1 with 3 items must produce 3 pages");
}

// ======================================================================
// get_block — happy & error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_full_row() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "GET01", "page", "my page", None, Some(5)).await;

    let row = get_block_inner(&pool, "GET01".into()).await.unwrap();

    assert_eq!(row.id, "GET01", "id must match");
    assert_eq!(row.block_type, "page", "block_type must match");
    assert_eq!(row.content, Some("my page".into()), "content must match");
    assert!(row.parent_id.is_none(), "parent_id must be None");
    assert_eq!(row.position, Some(5), "position must match");
    assert!(row.deleted_at.is_none(), "deleted_at must be None");
    assert!(row.archived_at.is_none(), "archived_at must be None");
    assert!(!row.is_conflict, "is_conflict must be false");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = get_block_inner(&pool, "NOPE_BLK_999".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "get_block on nonexistent ID must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_returns_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "GET_DEL", "content", "was alive", None, Some(1)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'GET_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let row = get_block_inner(&pool, "GET_DEL".into()).await.unwrap();

    assert_eq!(row.id, "GET_DEL", "must return the deleted block");
    assert!(
        row.deleted_at.is_some(),
        "deleted_at must be present on deleted block"
    );
}

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
    settle().await;

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
    settle().await;

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
                Some((i + 1) as i64),
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

    let unique: HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
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
            assert_eq!(op.seq, (i + 1) as i64, "device {dev} seq must be monotonic");
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
            Some((i + 1) as i64),
        )
        .await
        .unwrap();
    }

    let mut all_ids = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let page = list_blocks_inner(&pool, None, None, None, None, None, cursor, Some(PAGE_SIZE))
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

    let unique: HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
    assert_eq!(
        unique.len(),
        TOTAL,
        "no duplicate blocks in paginated results"
    );

    // Expected pages: ceil(50/7) = 8
    let expected_pages = (TOTAL as i64 + PAGE_SIZE - 1) / PAGE_SIZE;
    assert_eq!(
        pages, expected_pages,
        "expected {expected_pages} pages for {TOTAL} items at page size {PAGE_SIZE}"
    );
}

// ======================================================================
// move_block — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_reparents_and_updates_position() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

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

    assert_eq!(resp.block_id, "MV_CHILD", "block_id must match");
    assert_eq!(
        resp.new_parent_id,
        Some("MV_PAR_B".into()),
        "new parent must be MV_PAR_B"
    );
    assert_eq!(resp.new_position, 5, "position must match");

    // Verify DB state
    let row = get_block_inner(&pool, "MV_CHILD".into()).await.unwrap();
    assert_eq!(row.parent_id, Some("MV_PAR_B".into()), "parent_id in DB");
    assert_eq!(row.position, Some(5), "position in DB");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_root_clears_parent() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV2_PAR", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "MV2_CHD",
        "content",
        "child",
        Some("MV2_PAR"),
        Some(1),
    )
    .await;

    let resp = move_block_inner(&pool, DEV, &mat, "MV2_CHD".into(), None, 10)
        .await
        .unwrap();

    assert!(
        resp.new_parent_id.is_none(),
        "root move must have None parent"
    );
    assert_eq!(resp.new_position, 10, "position must match");

    let row = get_block_inner(&pool, "MV2_CHD".into()).await.unwrap();
    assert!(
        row.parent_id.is_none(),
        "parent_id must be NULL after root move"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_LOG", "content", "block", None, Some(1)).await;

    move_block_inner(&pool, DEV, &mat, "MV_LOG".into(), None, 3)
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "move_block", "op_type must be move_block");
    assert!(
        ops[0].payload.contains("MV_LOG"),
        "payload must contain block_id"
    );
}

// ======================================================================
// move_block — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = move_block_inner(&pool, DEV, &mat, "GHOST_MV".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_DEL", "content", "deleted", None, Some(1)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'MV_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(&pool, DEV, &mat, "MV_DEL".into(), None, 1).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_self_parent_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_SELF", "content", "self", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_SELF".into(),
        Some("MV_SELF".into()),
        1,
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "self-parent must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("cannot be its own parent"),
        "error message must mention self-parent constraint"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_nonexistent_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_NP", "content", "block", None, Some(1)).await;

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_NP".into(),
        Some("GHOST_PARENT".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to nonexistent parent must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_to_deleted_parent_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "MV_DP_BLK", "content", "block", None, Some(1)).await;
    insert_block(&pool, "MV_DP_PAR", "page", "deleted parent", None, Some(2)).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'MV_DP_PAR'")
        .execute(&pool)
        .await
        .unwrap();

    let result = move_block_inner(
        &pool,
        DEV,
        &mat,
        "MV_DP_BLK".into(),
        Some("MV_DP_PAR".into()),
        1,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "moving to deleted parent must return AppError::NotFound"
    );
}

// ======================================================================
// add_tag — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_associates_block_with_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

    let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "AT_BLK", "block_id must match");
    assert_eq!(resp.tag_id, "AT_TAG", "tag_id must match");

    // Verify block_tags row
    let row = sqlx::query_scalar!(
        "SELECT block_id FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "AT_BLK",
        "AT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_some(), "block_tags row must exist after add_tag");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATL_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATL_BLK".into(), "ATL_TAG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "add_tag", "op_type must be add_tag");
    assert!(
        ops[0].payload.contains("ATL_BLK"),
        "payload must contain block_id"
    );
    assert!(
        ops[0].payload.contains("ATL_TAG"),
        "payload must contain tag_id"
    );
}

// ======================================================================
// add_tag — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNB_TAG", "tag", "urgent", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "GHOST_BLK".into(), "ATNB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATDB_BLK", "content", "deleted", None, Some(1)).await;
    insert_block(&pool, "ATDB_TAG", "tag", "urgent", None, None).await;
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'ATDB_BLK'")
        .execute(&pool)
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATDB_BLK".into(), "ATDB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_tag_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "GHOST_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding nonexistent tag must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_with_non_tag_block_type_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATNTT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATNTT_CONT", "content", "not a tag", None, Some(2)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNTT_BLK".into(), "ATNTT_CONT".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "using content block as tag_id must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("expected 'tag'"),
        "error message must mention expected tag type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_duplicate_returns_invalid_operation() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "ATDUP_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATDUP_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATDUP_BLK".into(), "ATDUP_TAG".into())
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATDUP_BLK".into(), "ATDUP_TAG".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "duplicate add_tag must return AppError::InvalidOperation"
    );
    assert!(
        err.to_string().contains("tag already applied"),
        "error message must mention tag already applied"
    );
}

// ======================================================================
// remove_tag — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_deletes_association() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "RT_BLK", "block_id must match");
    assert_eq!(resp.tag_id, "RT_TAG", "tag_id must match");

    // Verify association gone
    let row = sqlx::query_scalar!(
        "SELECT block_id FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "RT_BLK",
        "RT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "block_tags row must be gone after remove_tag"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTL_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RTL_BLK".into(), "RTL_TAG".into())
        .await
        .unwrap();

    remove_tag_inner(&pool, DEV, &mat, "RTL_BLK".into(), "RTL_TAG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "add_tag + remove_tag = 2 ops");
    assert_eq!(ops[1].op_type, "remove_tag", "second op must be remove_tag");
    assert!(
        ops[1].payload.contains("RTL_BLK"),
        "payload must contain block_id"
    );
}

// ======================================================================
// remove_tag — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = remove_tag_inner(&pool, DEV, &mat, "GHOST_BLK".into(), "GHOST_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing tag from nonexistent block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTDB_BLK", "content", "deleted", None, Some(1)).await;
    insert_block(&pool, "RTDB_TAG", "tag", "urgent", None, None).await;
    // Add tag before deleting block
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("RTDB_BLK")
        .bind("RTDB_TAG")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'RTDB_BLK'")
        .execute(&pool)
        .await
        .unwrap();

    let result = remove_tag_inner(&pool, DEV, &mat, "RTDB_BLK".into(), "RTDB_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing tag from deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_not_applied_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

    let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "removing unapplied tag must return AppError::NotFound"
    );
    assert!(
        err.to_string().contains("tag association"),
        "error message must mention tag association"
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
    settle().await;

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
    settle().await;

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

    settle().await;

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

    settle().await;

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

    settle().await;

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
