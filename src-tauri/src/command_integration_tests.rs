//! Command-layer integration tests — bulletproof API surface coverage.
//!
//! These tests exercise every Tauri command `_inner` function as an API
//! contract.  They complement:
//! - **Unit tests** (per-module, in each `mod tests`)
//! - **Integration tests** (cross-module pipelines in `integration_tests.rs`)
//!
//! Focus: verify every command's happy path, error variants, edge cases,
//! and cross-cutting lifecycle interactions at the command boundary.

use crate::backlink_query::{BacklinkFilter, BacklinkSort, CompareOp, SortDir};
use crate::commands::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op_log;
use crate::peer_refs;
use crate::soft_delete;
use crate::sync_scheduler::SyncScheduler;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
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
///
/// Uses the deterministic barrier-flush mechanism so tests are not
/// race-condition-prone on slow CI.
async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
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

    settle(&mat).await;

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
    settle(&mat).await;

    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

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
    settle(&mat).await;

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
    settle(&mat).await;

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
    settle(&mat).await;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "log-delete".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block
    delete_block_inner(&pool, DEV, &mat, created.id.clone())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "create + delete = 2 ops");
    assert_eq!(
        ops[1].op_type, "delete_block",
        "op_type must be delete_block"
    );
    assert_eq!(ops[1].device_id, DEV, "device_id must match");
    assert!(
        ops[1].payload.contains(&created.id),
        "payload must contain the block ID"
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "REST_LOG", "content", "restore-log", None, Some(1)).await;
    let (ts, _) = soft_delete::cascade_soft_delete(&pool, "REST_LOG")
        .await
        .unwrap();

    restore_block_inner(&pool, DEV, &mat, "REST_LOG".into(), ts)
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(
        ops[0].op_type, "restore_block",
        "op_type must be restore_block"
    );
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains("REST_LOG"),
        "payload must contain block_id"
    );
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
    .bind("attachments/readme.txt")
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    insert_block(&pool, "PURGE_LOG", "content", "purge-log", None, Some(1)).await;
    soft_delete::cascade_soft_delete(&pool, "PURGE_LOG")
        .await
        .unwrap();

    purge_block_inner(&pool, DEV, &mat, "PURGE_LOG".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "exactly one op must be logged");
    assert_eq!(ops[0].op_type, "purge_block", "op_type must be purge_block");
    assert_eq!(ops[0].device_id, DEV, "device_id must match");
    assert!(
        ops[0].payload.contains("PURGE_LOG"),
        "payload must contain block_id"
    );
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
// list_tags_for_block — happy paths & lifecycle
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_block_returns_both_tags_then_one_after_removal() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block and two tags
    insert_block(&pool, "LTFB_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "LTFB_TAG1", "tag", "urgent", None, None).await;
    insert_block(&pool, "LTFB_TAG2", "tag", "personal", None, None).await;

    // Add both tags
    add_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG1".into())
        .await
        .unwrap();
    add_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG2".into())
        .await
        .unwrap();

    // Verify both tags returned
    let tags = list_tags_for_block_inner(&pool, "LTFB_BLK".into())
        .await
        .unwrap();
    assert_eq!(tags.len(), 2, "block must have 2 tags after adding both");
    assert!(
        tags.contains(&"LTFB_TAG1".to_string()),
        "tag list must contain LTFB_TAG1"
    );
    assert!(
        tags.contains(&"LTFB_TAG2".to_string()),
        "tag list must contain LTFB_TAG2"
    );

    // Remove one tag
    remove_tag_inner(&pool, DEV, &mat, "LTFB_BLK".into(), "LTFB_TAG1".into())
        .await
        .unwrap();

    // Verify only one tag remains
    let tags_after = list_tags_for_block_inner(&pool, "LTFB_BLK".into())
        .await
        .unwrap();
    assert_eq!(tags_after.len(), 1, "block must have 1 tag after removal");
    assert_eq!(
        tags_after[0], "LTFB_TAG2",
        "remaining tag must be LTFB_TAG2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_block_no_tags_returns_empty() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LTFB_EMPTY", "content", "no tags", None, Some(1)).await;

    let tags = list_tags_for_block_inner(&pool, "LTFB_EMPTY".into())
        .await
        .unwrap();
    assert!(tags.is_empty(), "block with no tags must return empty vec");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_for_nonexistent_block_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let tags = list_tags_for_block_inner(&pool, "GHOST_LTFB_999".into())
        .await
        .unwrap();
    assert!(
        tags.is_empty(),
        "nonexistent block must return empty vec (no error)"
    );
}

// ======================================================================
// set_property / delete_property — op_log verification
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prop-log".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 2, "create + set_property = 2 ops");
    assert_eq!(
        ops[1].op_type, "set_property",
        "op_type must be set_property"
    );
    assert_eq!(ops[1].device_id, DEV, "device_id must match");
    assert!(
        ops[1].payload.contains(&block.id),
        "payload must contain block_id"
    );
    assert!(
        ops[1].payload.contains("status"),
        "payload must contain property key"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_writes_op_log_entry() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "prop-del-log".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // seq 1 = create_block, seq 2 = set_property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "priority".into(),
        Some("high".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "priority".into())
        .await
        .unwrap();

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 3, "create + set + delete = 3 ops");
    assert_eq!(
        ops[2].op_type, "delete_property",
        "op_type must be delete_property"
    );
    assert_eq!(ops[2].device_id, DEV, "device_id must match");
    assert!(
        ops[2].payload.contains(&block.id),
        "payload must contain block_id"
    );
    assert!(
        ops[2].payload.contains("priority"),
        "payload must contain property key"
    );
}

// ======================================================================
// delete_property on deleted block — error path
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_on_deleted_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create block, set a property, then delete the block
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    // Attempt to delete property on the now-deleted block
    let result = delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete_property on deleted block must return AppError::NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_on_nonexistent_block_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let result = delete_property_inner(
        &pool,
        DEV,
        &mat,
        "GHOST_PROP_BLK_999".into(),
        "whatever".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete_property on nonexistent block must return AppError::NotFound"
    );
}

// ======================================================================
// get_batch_properties — happy paths & error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create two blocks via the command layer
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block A".into(),
        None,
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
        "block B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set properties via command layer
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "priority".into(),
        Some("high".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("done".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Batch-fetch
    let result = get_batch_properties_inner(&pool, vec![b1.id.clone(), b2.id.clone()])
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "both blocks must be in result");
    assert_eq!(result[&b1.id][0].key, "priority");
    assert_eq!(result[&b1.id][0].value_text, Some("high".into()));
    assert_eq!(result[&b2.id][0].key, "status");
    assert_eq!(result[&b2.id][0].value_text, Some("done".into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_empty_ids_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let result = get_batch_properties_inner(&pool, vec![]).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_ids must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_batch_properties_does_not_affect_op_log() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "op-log check".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "key1".into(),
        Some("val".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Count op_log entries before the read-only batch call
    let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();

    // Read-only batch fetch
    let _ = get_batch_properties_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    // op_log must not change
    let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(
        ops_before.len(),
        ops_after.len(),
        "get_batch_properties must not write to op_log"
    );
}

// ======================================================================
// Date validation edge cases — comprehensive format checks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_invalid_month_13_returns_validation() {
    let (pool, _dir) = test_pool().await;

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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_short_format_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01".into()),
        None,
        None,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "short date '2025-01' must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_two_digit_year_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("25-1-1".into()),
        None,
        None,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "'25-1-1' must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_day_32_returns_validation() {
    let (pool, _dir) = test_pool().await;

    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-01-32".into()),
        None,
        None,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "day=32 must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn date_validation_non_date_string_returns_validation() {
    let (pool, _dir) = test_pool().await;

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
}

// ======================================================================
// query_by_property — integration
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_by_property_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create blocks via command layer
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task one".into(),
        None,
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
        "task two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task three".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set properties via command layer
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "todo".into(),
        Some("TODO".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "todo".into(),
        Some("DONE".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        "priority".into(),
        Some("high".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Query all blocks with 'todo' property (any value)
    let result = query_by_property_inner(&pool, "todo".into(), None, None, None)
        .await
        .unwrap();

    assert_eq!(result.items.len(), 2, "two blocks have 'todo' property");

    // Query with value filter: only TODO
    let filtered = query_by_property_inner(&pool, "todo".into(), Some("TODO".into()), None, None)
        .await
        .unwrap();

    assert_eq!(filtered.items.len(), 1, "only one block has todo=TODO");
    assert_eq!(filtered.items[0].id, b1.id);

    // Query nonexistent key: empty
    let empty = query_by_property_inner(&pool, "nonexistent".into(), None, None, None)
        .await
        .unwrap();

    assert!(empty.items.is_empty(), "nonexistent key must return empty");
}

// ======================================================================
// query_backlinks_filtered — happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_returns_linking_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a target page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create two content blocks that reference the page
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("links to [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("also links to [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    let ids: HashSet<String> = resp.items.iter().map(|b| b.id.clone()).collect();
    assert!(ids.contains(&b1.id), "b1 must be in backlinks");
    assert!(ids.contains(&b2.id), "b2 must be in backlinks");
    assert_eq!(resp.items.len(), 2, "exactly two backlinks expected");
    assert_eq!(resp.total_count, 2, "total_count must be 2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_empty_for_no_links() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Lonely Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "no backlinks expected");
    assert_eq!(resp.total_count, 0, "total_count must be 0");
    assert!(!resp.has_more, "has_more must be false");
    assert!(resp.next_cursor.is_none(), "no cursor for empty results");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_excludes_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("link [[{}]]", page.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Verify backlink exists
    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();
    assert_eq!(resp.items.len(), 1, "one backlink before deletion");

    // Delete the linking block
    delete_block_inner(&pool, DEV, &mat, b1.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, page.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "deleted backlink must be excluded");
    assert_eq!(resp.total_count, 0, "total_count must be 0 after deletion");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_block_type_filter() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a page-type block linking to target
    let page_linker = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        page_linker.id.clone(),
        format!("page ref [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a content-type block linking to target
    let content_linker = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        content_linker.id.clone(),
        format!("content ref [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Filter by block_type = content
    let filters = vec![BacklinkFilter::BlockType {
        block_type: "content".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only content backlink returned");
    assert_eq!(resp.items[0].id, content_linker.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_contains_filter() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("foo bar [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("baz qux [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let filters = vec![BacklinkFilter::Contains {
        query: "foo".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only 'foo' content returned");
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_property_text_filter() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("second [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("archived".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let filters = vec![BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "only active status returned");
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_sort_created() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create blocks with slight time gaps so ULIDs differ
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("second [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Sort ascending (oldest first)
    let resp_asc = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp_asc.items.len(), 2);
    assert_eq!(
        resp_asc.items[0].id, b1.id,
        "b1 created first → first in Asc"
    );
    assert_eq!(
        resp_asc.items[1].id, b2.id,
        "b2 created second → second in Asc"
    );

    // Sort descending (newest first)
    let resp_desc = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp_desc.items.len(), 2);
    assert_eq!(resp_desc.items[0].id, b2.id, "b2 newest → first in Desc");
    assert_eq!(resp_desc.items[1].id, b1.id, "b1 oldest → second in Desc");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_with_sort_property() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("low [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "priority".into(),
        None,
        Some(1.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("high [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "priority".into(),
        None,
        Some(10.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Sort by priority Desc (highest first)
    let resp = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::PropertyNum {
            key: "priority".into(),
            dir: SortDir::Desc,
        }),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2);
    assert_eq!(resp.items[0].id, b2.id, "priority=10 first in Desc");
    assert_eq!(resp.items[1].id, b1.id, "priority=1 second in Desc");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_pagination() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create 7 backlinks
    let mut block_ids = Vec::new();
    for i in 0..7 {
        let b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            None,
            Some(i + 10),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            b.id.clone(),
            format!("link {} [[{}]]", i, target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;

        block_ids.push(b.id);
    }

    // First page: limit=3
    let resp1 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        None,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp1.items.len(), 3, "first page has 3 items");
    assert!(resp1.has_more, "more pages expected");
    assert!(resp1.next_cursor.is_some(), "cursor must be present");
    assert_eq!(resp1.total_count, 7, "total_count reflects all backlinks");

    // Second page
    let resp2 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        resp1.next_cursor,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp2.items.len(), 3, "second page has 3 items");
    assert!(resp2.has_more, "still more pages");
    assert!(resp2.next_cursor.is_some(), "cursor for third page");

    // Third page (last)
    let resp3 = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        resp2.next_cursor,
        Some(3),
    )
    .await
    .unwrap();

    assert_eq!(resp3.items.len(), 1, "third page has remaining 1 item");
    assert!(!resp3.has_more, "no more pages");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_total_count_matches() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create 5 backlinks
    for i in 0..5 {
        let b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "placeholder".into(),
            None,
            Some(i + 10),
        )
        .await
        .unwrap();
        settle(&mat).await;

        edit_block_inner(
            &pool,
            DEV,
            &mat,
            b.id.clone(),
            format!("link {} [[{}]]", i, target.id),
        )
        .await
        .unwrap();
        settle(&mat).await;
    }

    // Query with limit=2 — total_count should still be 5
    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, Some(2))
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "page has 2 items");
    assert_eq!(
        resp.total_count, 5,
        "total_count reflects all 5 matches, not just page"
    );
    assert!(resp.has_more, "more pages available");
}

// ======================================================================
// query_backlinks_filtered — error paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_empty_block_id_returns_error() {
    let (pool, _dir) = test_pool().await;

    let result = query_backlinks_filtered_inner(&pool, "".into(), None, None, None, None).await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_id must return Validation error, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_nonexistent_block_id_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let resp = query_backlinks_filtered_inner(
        &pool,
        "NONEXISTENT_BLOCK_XYZ".into(),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(
        resp.items.is_empty(),
        "nonexistent block_id returns empty, not error"
    );
    assert_eq!(resp.total_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_and_filter_intersection() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // b1: content type, status=active
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("b1 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // b2: content type, status=archived
    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        format!("b2 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "status".into(),
        Some("archived".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // b3: page type, status=active
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "placeholder".into(),
        None,
        Some(4),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        format!("b3 [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b3.id.clone(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // AND filter: content type AND status=active → only b1
    let filters = vec![BacklinkFilter::And {
        filters: vec![
            BacklinkFilter::BlockType {
                block_type: "content".into(),
            },
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
        ],
    }];

    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "AND intersection must return 1 block");
    assert_eq!(resp.items[0].id, b1.id, "only b1 matches both conditions");
}

// ======================================================================
// query_backlinks_filtered — edge cases
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_unicode_content() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let unicode_content = format!("日本語テスト 🚀 [[{}]]", target.id);
    edit_block_inner(&pool, DEV, &mat, b1.id.clone(), unicode_content.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 1, "unicode backlink must be returned");
    assert_eq!(
        resp.items[0].content.as_deref(),
        Some(unicode_content.as_str()),
        "unicode content preserved"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_self_referencing() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "placeholder".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Block references itself
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("self-ref [[{}]]", b1.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, b1.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "self-referencing block returned as backlink"
    );
    assert_eq!(resp.items[0].id, b1.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_multiple_refs_same_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Block has [[target]] twice in content
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("first [[{}]] second [[{}]]", target.id, target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = query_backlinks_filtered_inner(&pool, target.id.clone(), None, None, None, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "duplicate refs produce only one backlink entry"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_filtered_created_in_range() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
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
        "placeholder".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        format!("link [[{}]]", target.id),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Use a range that covers "now" — blocks just created should match
    let filters = vec![BacklinkFilter::CreatedInRange {
        after: Some("2020-01-01".into()),
        before: Some("2099-12-31".into()),
    }];
    let resp =
        query_backlinks_filtered_inner(&pool, target.id.clone(), Some(filters), None, None, None)
            .await
            .unwrap();

    assert_eq!(resp.items.len(), 1, "block within date range is returned");

    // Use a range in the past — no blocks should match
    let filters_past = vec![BacklinkFilter::CreatedInRange {
        after: Some("2000-01-01".into()),
        before: Some("2001-01-01".into()),
    }];
    let resp_past = query_backlinks_filtered_inner(
        &pool,
        target.id.clone(),
        Some(filters_past),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(resp_past.items.is_empty(), "no blocks in past date range");
}

// ======================================================================
// list_property_keys — integration
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_returns_distinct_sorted() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block one".into(),
        None,
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
        "block two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set properties: b1 has "zebra" and "alpha", b2 has "alpha"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "zebra".into(),
        Some("z".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "alpha".into(),
        Some("a".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    set_property_inner(
        &pool,
        DEV,
        &mat,
        b2.id.clone(),
        "alpha".into(),
        Some("a2".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert_eq!(
        keys,
        vec!["alpha", "zebra"],
        "keys must be distinct and sorted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_empty_when_no_properties() {
    let (pool, _dir) = test_pool().await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert!(keys.is_empty(), "no properties → empty vec");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backlinks_list_property_keys_includes_all_types() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "block".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set text property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "note".into(),
        Some("hello".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set numeric property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "count".into(),
        None,
        Some(42.0),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set date property
    set_property_inner(
        &pool,
        DEV,
        &mat,
        b1.id.clone(),
        "due".into(),
        None,
        None,
        Some("2025-06-15".into()),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let keys = list_property_keys_inner(&pool).await.unwrap();

    assert_eq!(keys.len(), 3, "three distinct keys");
    assert!(keys.contains(&"note".to_string()), "text key included");
    assert!(keys.contains(&"count".to_string()), "num key included");
    assert!(keys.contains(&"due".to_string()), "date key included");
}

// ======================================================================
// batch_resolve — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "resolve-page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "resolve-tag".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let resolved = batch_resolve_inner(
        &pool,
        vec![b1.id.clone(), b2.id.clone(), "NONEXISTENT".into()],
    )
    .await
    .unwrap();

    assert_eq!(resolved.len(), 2, "only existing blocks should be returned");
    let ids: HashSet<&str> = resolved.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(b1.id.as_str()), "page block must be resolved");
    assert!(ids.contains(b2.id.as_str()), "tag block must be resolved");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_resolve_marks_deleted_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "soon-deleted".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    let resolved = batch_resolve_inner(&pool, vec![block.id.clone()])
        .await
        .unwrap();

    assert_eq!(resolved.len(), 1, "deleted block should still be resolved");
    assert!(resolved[0].deleted, "deleted flag must be true");
}

// ======================================================================
// get_backlinks — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_returns_linking_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let target = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "target-page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let source = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("links to [[{}]]", target.id),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Insert a block_link row (normally done by materializer)
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&source.id)
        .bind(&target.id)
        .execute(&pool)
        .await
        .unwrap();

    let resp = get_backlinks_inner(&pool, target.id.clone(), None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 1, "one backlink expected");
    assert_eq!(
        resp.items[0].id, source.id,
        "source block must be the backlink"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_backlinks_empty_when_no_links() {
    let (pool, _dir) = test_pool().await;

    insert_block(
        &pool,
        "BL_ORPHAN",
        "content",
        "no links here",
        None,
        Some(1),
    )
    .await;

    let resp = get_backlinks_inner(&pool, "BL_ORPHAN".into(), None, None)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "no backlinks expected for isolated block"
    );
}

// ======================================================================
// get_block_history — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_returns_ops_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "history-test".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "v2".into())
        .await
        .unwrap();

    let resp = get_block_history_inner(&pool, block.id.clone(), None, None)
        .await
        .unwrap();

    assert!(
        resp.items.len() >= 2,
        "at least create + edit ops expected, got {}",
        resp.items.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_empty_for_nonexistent_block() {
    let (pool, _dir) = test_pool().await;

    let resp = get_block_history_inner(&pool, "GHOST_HIST".into(), None, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "no history for nonexistent block");
}

// ======================================================================
// get_conflicts — wiring tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_conflicts_empty_when_none_exist() {
    let (pool, _dir) = test_pool().await;

    let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

    assert!(
        resp.items.is_empty(),
        "no conflicts should exist in a fresh DB"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_conflicts_returns_conflict_blocks() {
    let (pool, _dir) = test_pool().await;

    // Insert a conflict block directly
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, is_conflict, position) \
         VALUES (?, ?, ?, 1, ?)",
    )
    .bind("CONFLICT01")
    .bind("content")
    .bind("conflict copy")
    .bind(1_i64)
    .execute(&pool)
    .await
    .unwrap();

    let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

    assert_eq!(resp.items.len(), 1, "one conflict block expected");
    assert_eq!(
        resp.items[0].id, "CONFLICT01",
        "conflict block ID must match"
    );
}

// ======================================================================
// list_peer_refs / update_peer_name / delete_peer_ref — wiring tests (#455)
// ======================================================================

#[tokio::test]
async fn list_peer_refs_returns_empty_when_no_peers() {
    let (pool, _dir) = test_pool().await;
    let result = list_peer_refs_inner(&pool).await.unwrap();
    assert!(result.is_empty(), "no peers should exist in fresh DB");
}

#[tokio::test]
async fn list_peer_refs_returns_peers_ordered_by_synced_at() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref(&pool, "PEER_A").await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_B").await.unwrap();

    // PEER_A synced earlier, PEER_B synced later → PEER_B should appear first.
    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        "2025-01-01T00:00:00Z",
        "PEER_A"
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        "2025-01-02T00:00:00Z",
        "PEER_B"
    )
    .execute(&pool)
    .await
    .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();

    assert_eq!(peers.len(), 2, "both peers should be returned");
    assert_eq!(
        peers[0].peer_id, "PEER_B",
        "most recently synced peer should be first"
    );
    assert_eq!(
        peers[1].peer_id, "PEER_A",
        "earlier synced peer should be second"
    );
}

#[tokio::test]
async fn update_peer_name_sets_and_clears_name() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_X").await.unwrap();

    // Set a device name.
    update_peer_name_inner(&pool, "PEER_X".into(), Some("My Phone".into()))
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer should exist");
    assert_eq!(
        peers[0].device_name.as_deref(),
        Some("My Phone"),
        "device_name should be set to 'My Phone'"
    );

    // Clear the device name.
    update_peer_name_inner(&pool, "PEER_X".into(), None)
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers[0].device_name, None,
        "device_name should be cleared to None"
    );
}

#[tokio::test]
async fn update_peer_name_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let err = update_peer_name_inner(&pool, "NO_SUCH_PEER".into(), Some("Name".into()))
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound for nonexistent peer, got {err:?}"
    );
}

#[tokio::test]
async fn delete_peer_ref_removes_peer() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref(&pool, "PEER_KEEP")
        .await
        .unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_DEL").await.unwrap();

    delete_peer_ref_inner(&pool, "PEER_DEL".into())
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "only one peer should remain after delete");
    assert_eq!(
        peers[0].peer_id, "PEER_KEEP",
        "the surviving peer should be PEER_KEEP"
    );
}

#[tokio::test]
async fn delete_peer_ref_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let err = delete_peer_ref_inner(&pool, "GHOST_PEER".into())
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound for nonexistent peer, got {err:?}"
    );
}

#[tokio::test]
async fn update_peer_name_special_characters() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_UNI").await.unwrap();

    let fancy_name = "Javier's 📱 Phone";
    update_peer_name_inner(&pool, "PEER_UNI".into(), Some(fancy_name.into()))
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer should exist");
    assert_eq!(
        peers[0].device_name.as_deref(),
        Some(fancy_name),
        "unicode/special-char device name should roundtrip correctly"
    );
}

// =========================================================================
// Sync command integration tests — pairing + sync workflows
// =========================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_lifecycle_creates_peer_ref() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let device_id = "dev-local";

    // Start pairing
    let info = start_pairing_inner(&pairing.0, device_id).unwrap();
    assert!(!info.passphrase.is_empty(), "passphrase must be non-empty");

    // Confirm pairing with remote device
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        device_id,
        info.passphrase.clone(),
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Verify peer_ref was created
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer_ref should exist after confirm");
    assert_eq!(
        peers[0].peer_id, "dev-remote",
        "peer_id should be the remote device"
    );

    // Verify pairing session was cleared
    assert!(
        pairing.0.lock().unwrap().is_none(),
        "pairing session must be cleared after confirm"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_start_then_cancel_clears_session() {
    let pairing = PairingState(Mutex::new(None));

    let _info = start_pairing_inner(&pairing.0, "dev-1").unwrap();
    assert!(
        pairing.0.lock().unwrap().is_some(),
        "session must exist after start"
    );

    cancel_pairing_inner(&pairing.0).unwrap();
    assert!(
        pairing.0.lock().unwrap().is_none(),
        "session must be cleared after cancel"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_without_prior_start_still_creates_peer() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));

    // Confirm without starting — confirm_pairing_inner doesn't validate against
    // a stored session; it creates a new one from the passphrase directly.
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        "dev-1",
        "some random phrase".into(),
        "dev-remote".into(),
    )
    .await
    .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        1,
        "peer_ref should be created on confirm regardless of prior start"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_sync_returns_complete_info() {
    let scheduler = SyncScheduler::new();

    let info = start_sync_inner(&scheduler, "dev-local", "dev-remote".into()).unwrap();
    assert_eq!(info.state, "complete", "sync state should be complete");
    assert_eq!(info.local_device_id, "dev-local");
    assert_eq!(info.remote_device_id, "dev-remote");
    assert_eq!(info.ops_received, 0);
    assert_eq!(info.ops_sent, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_sync_rejects_peer_in_backoff() {
    let scheduler = SyncScheduler::new();

    // Record a failure to trigger backoff
    scheduler.record_failure("dev-remote");

    let result = start_sync_inner(&scheduler, "dev-local", "dev-remote".into());
    assert!(
        result.is_err(),
        "sync should be rejected when peer is in backoff"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("backoff"),
        "error should mention backoff"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_pair_then_sync_workflow() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();

    // Pair
    let info = start_pairing_inner(&pairing.0, "dev-local").unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        "dev-local",
        info.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Sync
    let sync_info = start_sync_inner(&scheduler, "dev-local", "dev-remote".into()).unwrap();
    assert_eq!(sync_info.state, "complete");

    // Verify peer_ref persists
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_sync_succeeds() {
    let result = cancel_sync_inner();
    assert!(
        result.is_ok(),
        "cancel_sync should always succeed (placeholder)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pair_multiple_devices_creates_separate_peer_refs() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let device_id = "dev-local";

    // Pair with first device
    let info1 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        device_id,
        info1.passphrase,
        "dev-phone".into(),
    )
    .await
    .unwrap();

    // Pair with second device
    let info2 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        device_id,
        info2.passphrase,
        "dev-tablet".into(),
    )
    .await
    .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 2, "two separate peer_refs should exist");

    let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
    assert!(ids.contains(&"dev-phone"), "phone peer should exist");
    assert!(ids.contains(&"dev-tablet"), "tablet peer should exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_pairing_same_device_upserts_peer_ref() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let device_id = "dev-local";

    // Pair with device
    let info1 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        device_id,
        info1.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Re-pair with same device
    let info2 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        device_id,
        info2.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Should still be 1 peer_ref (upsert, not duplicate)
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        1,
        "re-pairing same device should upsert, not create duplicate"
    );
}
