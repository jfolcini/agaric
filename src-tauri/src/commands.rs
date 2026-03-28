//! Tauri command handlers for the block-notes app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, OpPayload, PurgeBlockPayload,
    RestoreBlockPayload,
};
use crate::op_log;
use crate::pagination::{self, BlockRow, PageResponse};
use crate::recovery;
use crate::soft_delete;
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct BlockResponse {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteResponse {
    pub block_id: String,
    pub deleted_at: String,
    pub descendants_affected: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreResponse {
    pub block_id: String,
    pub restored_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurgeResponse {
    pub block_id: String,
    pub purged_count: u64,
}

// ---------------------------------------------------------------------------
// Inner functions (testable without Tauri State)
// ---------------------------------------------------------------------------

pub async fn create_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockResponse, AppError> {
    // 1. Generate new BlockId
    let block_id = BlockId::new();

    // 2. If parent_id is Some, validate it exists and is not deleted
    if let Some(ref pid) = parent_id {
        let exists: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL")
                .bind(pid)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }
    }

    // 3. Build OpPayload
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: block_id.as_str().to_owned(),
        block_type: block_type.clone(),
        parent_id: parent_id.clone(),
        position,
        content: content.clone(),
    });

    // 4. Append to op_log
    let op_record = op_log::append_local_op(pool, device_id, payload).await?;

    // 5. Insert into blocks table directly
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(block_id.as_str())
    .bind(&block_type)
    .bind(&content)
    .bind(&parent_id)
    .bind(position)
    .execute(pool)
    .await?;

    // 6. Dispatch background cache tasks
    materializer.dispatch_background(&op_record)?;

    // 7. Return response
    Ok(BlockResponse {
        id: block_id.into_string(),
        block_type,
        content: Some(content),
        parent_id,
        position,
        deleted_at: None,
    })
}

pub async fn edit_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    to_text: String,
) -> Result<BlockResponse, AppError> {
    // 1. Validate block exists and is not deleted
    let existing: Option<BlockRow> = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position, \
                deleted_at, archived_at, is_conflict \
         FROM blocks WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(&block_id)
    .fetch_optional(pool)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let block_type = existing.block_type;
    let parent_id = existing.parent_id;
    let position = existing.position;

    // 2. Find prev_edit
    let prev_edit = recovery::find_prev_edit(pool, &block_id).await?;

    // 3. Build OpPayload
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id.clone(),
        to_text: to_text.clone(),
        prev_edit,
    });

    // 4. Append to op_log
    let op_record = op_log::append_local_op(pool, device_id, payload).await?;

    // 5. Update blocks table directly
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
        .bind(&to_text)
        .bind(&block_id)
        .execute(pool)
        .await?;

    // 6. Dispatch background cache tasks
    materializer.dispatch_background(&op_record)?;

    // 7. Return response
    Ok(BlockResponse {
        id: block_id,
        block_type,
        content: Some(to_text),
        parent_id,
        position,
        deleted_at: None,
    })
}

pub async fn delete_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    // 1. Validate block exists
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(pool)
            .await?;

    let (deleted_at,) = row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;

    // 2. Check not already deleted
    if deleted_at.is_some() {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' is already deleted"
        )));
    }

    // 3. Build OpPayload
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: block_id.clone(),
        cascade: true,
    });

    // 4. Append to op_log
    let op_record = op_log::append_local_op(pool, device_id, payload).await?;

    // 5. Cascade soft delete
    let (timestamp, count) = soft_delete::cascade_soft_delete(pool, &block_id).await?;

    // 6. Dispatch background cache tasks
    materializer.dispatch_background(&op_record)?;

    // 7. Return response
    Ok(DeleteResponse {
        block_id,
        deleted_at: timestamp,
        descendants_affected: count,
    })
}

pub async fn restore_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    // 1. Validate block exists and IS deleted
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(pool)
            .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block '{block_id}'")));
        }
        Some((None,)) => {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' is not deleted"
            )));
        }
        Some((Some(_),)) => {} // block is deleted, proceed
    }

    // 2. Build OpPayload
    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: block_id.clone(),
        deleted_at_ref: deleted_at_ref.clone(),
    });

    // 3. Append to op_log
    let op_record = op_log::append_local_op(pool, device_id, payload).await?;

    // 4. Restore block and descendants
    let count = soft_delete::restore_block(pool, &block_id, &deleted_at_ref).await?;

    // 5. Dispatch background cache tasks
    materializer.dispatch_background(&op_record)?;

    // 6. Return response
    Ok(RestoreResponse {
        block_id,
        restored_count: count,
    })
}

pub async fn purge_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    // 1. Validate block exists
    let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM blocks WHERE id = ?")
        .bind(&block_id)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("block '{block_id}'")));
    }

    // 2. Build OpPayload
    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: block_id.clone(),
    });

    // 3. Append to op_log
    let op_record = op_log::append_local_op(pool, device_id, payload).await?;

    // 4. Purge block physically
    let count = soft_delete::purge_block(pool, &block_id).await?;

    // 5. Dispatch background cache tasks
    materializer.dispatch_background(&op_record)?;

    // 6. Return response
    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

pub async fn list_blocks_inner(
    pool: &SqlitePool,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;

    if show_deleted == Some(true) {
        pagination::list_trash(pool, &page).await
    } else if let Some(ref t) = tag_id {
        pagination::list_by_tag(pool, t, &page).await
    } else if let Some(ref bt) = block_type {
        pagination::list_by_type(pool, bt, &page).await
    } else {
        pagination::list_children(pool, parent_id.as_deref(), &page).await
    }
}

pub async fn get_block_inner(pool: &SqlitePool, block_id: String) -> Result<BlockRow, AppError> {
    let row: Option<BlockRow> = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position, \
                deleted_at, archived_at, is_conflict \
         FROM blocks WHERE id = ?",
    )
    .bind(&block_id)
    .fetch_optional(pool)
    .await?;

    row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockResponse, AppError> {
    create_block_inner(
        &pool,
        &device_id.0,
        &materializer,
        block_type,
        content,
        parent_id,
        position,
    )
    .await
}

#[tauri::command]
pub async fn edit_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    to_text: String,
) -> Result<BlockResponse, AppError> {
    edit_block_inner(&pool, &device_id.0, &materializer, block_id, to_text).await
}

#[tauri::command]
pub async fn delete_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    delete_block_inner(&pool, &device_id.0, &materializer, block_id).await
}

#[tauri::command]
pub async fn restore_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    restore_block_inner(&pool, &device_id.0, &materializer, block_id, deleted_at_ref).await
}

#[tauri::command]
pub async fn purge_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    purge_block_inner(&pool, &device_id.0, &materializer, block_id).await
}

#[tauri::command]
pub async fn list_blocks(
    pool: State<'_, SqlitePool>,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_blocks_inner(
        &pool,
        parent_id,
        block_type,
        tag_id,
        show_deleted,
        cursor,
        limit,
    )
    .await
}

#[tauri::command]
pub async fn get_block(
    pool: State<'_, SqlitePool>,
    block_id: String,
) -> Result<BlockRow, AppError> {
    get_block_inner(&pool, block_id).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Helper: create a SQLite pool backed by a temp file.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Helper: insert a block directly into the blocks table.
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

    const DEV: &str = "test-device";

    // ======================================================================
    // create_block
    // ======================================================================

    #[tokio::test]
    async fn create_block_returns_correct_fields() {
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

        assert_eq!(resp.block_type, "content");
        assert_eq!(resp.content, Some("hello world".into()));
        assert!(resp.parent_id.is_none());
        assert_eq!(resp.position, Some(1));
        assert!(resp.deleted_at.is_none());
    }

    #[tokio::test]
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

        // ULID is 26 uppercase Crockford base32 characters
        assert_eq!(resp.id.len(), 26);
        assert!(resp.id.chars().all(|c| c.is_ascii_alphanumeric()));
        // Verify it parses as a valid ULID
        assert!(BlockId::from_string(&resp.id).is_ok());
    }

    #[tokio::test]
    async fn create_block_with_valid_parent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a parent block first
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

        // Create a child
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

        assert_eq!(child.parent_id, Some(parent.id));
    }

    #[tokio::test]
    async fn create_block_nonexistent_parent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some("NONEXISTENT".into()),
            Some(1),
        )
        .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn create_block_deleted_parent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create and delete a parent
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

        delete_block_inner(&pool, DEV, &mat, parent.id.clone())
            .await
            .unwrap();

        // Try to create a child under the deleted parent
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

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[tokio::test]
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

        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'create_block'",
        )
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(count.0, 1);
    }

    // ======================================================================
    // edit_block
    // ======================================================================

    #[tokio::test]
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

        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
            .await
            .unwrap();

        assert_eq!(edited.content, Some("updated".into()));

        // Verify in DB
        let row: (Option<String>,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(&created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, Some("updated".into()));
    }

    #[tokio::test]
    async fn edit_block_finds_prev_edit_automatically() {
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
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
            .await
            .unwrap();

        // Second edit — should have prev_edit pointing to the first edit
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
            .await
            .unwrap();

        // Check the last op_log entry has prev_edit set
        let row: (String,) = sqlx::query_as(
            "SELECT payload FROM op_log \
             WHERE op_type = 'edit_block' \
             ORDER BY seq DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let payload: serde_json::Value = serde_json::from_str(&row.0).unwrap();
        assert!(
            !payload["prev_edit"].is_null(),
            "prev_edit should be set on second edit"
        );
    }

    #[tokio::test]
    async fn edit_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[tokio::test]
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

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    // ======================================================================
    // delete_block
    // ======================================================================

    #[tokio::test]
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

        let _child = create_block_inner(
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

        let resp = delete_block_inner(&pool, DEV, &mat, parent.id)
            .await
            .unwrap();

        // Parent + child = 2 affected
        assert_eq!(resp.descendants_affected, 2);
        assert!(!resp.deleted_at.is_empty());
    }

    #[tokio::test]
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

        // First delete
        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        // Second delete should fail
        let result = delete_block_inner(&pool, DEV, &mat, created.id).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::InvalidOperation(_)));
    }

    // ======================================================================
    // restore_block
    // ======================================================================

    #[tokio::test]
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
        let (ts, _) = soft_delete::cascade_soft_delete(&pool, "RST_PAR")
            .await
            .unwrap();

        // Now test restore through the command handler
        let rest_resp = restore_block_inner(&pool, DEV, &mat, "RST_PAR".into(), ts)
            .await
            .unwrap();

        assert_eq!(rest_resp.restored_count, 2);

        // Verify parent is no longer deleted
        let row: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind("RST_PAR")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.0.is_none());
    }

    // ======================================================================
    // purge_block
    // ======================================================================

    #[tokio::test]
    async fn purge_block_physically_removes() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
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

        let resp = purge_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        assert_eq!(resp.purged_count, 1);

        // Verify block is gone
        let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM blocks WHERE id = ?")
            .bind(&created.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(exists.is_none());
    }

    // ======================================================================
    // list_blocks
    // ======================================================================

    #[tokio::test]
    async fn list_blocks_no_filters_returns_top_level() {
        let (pool, _dir) = test_pool().await;

        // Insert top-level blocks directly
        insert_block(&pool, "TOP1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "TOP2", "content", "b", None, Some(2)).await;
        insert_block(&pool, "CHILD1", "content", "c", Some("TOP1"), Some(1)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None)
            .await
            .unwrap();

        // Should only return top-level blocks (parent_id IS NULL)
        assert_eq!(resp.items.len(), 2);
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"TOP1"));
        assert!(ids.contains(&"TOP2"));
    }

    #[tokio::test]
    async fn list_blocks_with_block_type_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE1", "page", "my page", None, Some(1)).await;
        insert_block(&pool, "TAG1", "tag", "urgent", None, None).await;
        insert_block(&pool, "CONT1", "content", "hello", None, Some(2)).await;

        let resp = list_blocks_inner(&pool, None, Some("page".into()), None, None, None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, "PAGE1");
    }

    #[tokio::test]
    async fn list_blocks_with_parent_id_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CH1", "content", "child 1", Some("PAR"), Some(1)).await;
        insert_block(&pool, "CH2", "content", "child 2", Some("PAR"), Some(2)).await;
        insert_block(&pool, "OTHER", "content", "other", None, Some(2)).await;

        let resp = list_blocks_inner(&pool, Some("PAR".into()), None, None, None, None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2);
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"CH1"));
        assert!(ids.contains(&"CH2"));
    }

    #[tokio::test]
    async fn list_blocks_show_deleted_returns_trash() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "ALIVE", "content", "alive", None, Some(1)).await;
        insert_block(&pool, "DEAD", "content", "dead", None, Some(2)).await;

        // Soft-delete one block
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'DEAD'")
            .execute(&pool)
            .await
            .unwrap();

        let resp = list_blocks_inner(&pool, None, None, None, Some(true), None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, "DEAD");
    }

    // ======================================================================
    // get_block
    // ======================================================================

    #[tokio::test]
    async fn get_block_returns_single_block() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK001", "content", "hello", None, Some(1)).await;

        let block = get_block_inner(&pool, "BLK001".into()).await.unwrap();
        assert_eq!(block.id, "BLK001");
        assert_eq!(block.block_type, "content");
        assert_eq!(block.content, Some("hello".into()));
    }

    #[tokio::test]
    async fn get_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = get_block_inner(&pool, "NOPE".into()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    // ======================================================================
    // Additional edge cases
    // ======================================================================

    #[tokio::test]
    async fn delete_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = delete_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn purge_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = purge_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn restore_block_not_deleted_returns_invalid_operation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
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

        let result =
            restore_block_inner(&pool, DEV, &mat, created.id, "2025-01-01T00:00:00Z".into()).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::InvalidOperation(_)));
    }

    #[tokio::test]
    async fn restore_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = restore_block_inner(
            &pool,
            DEV,
            &mat,
            "GHOST".into(),
            "2025-01-01T00:00:00Z".into(),
        )
        .await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn create_block_persists_to_blocks_table() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "persisted".into(),
            None,
            Some(5),
        )
        .await
        .unwrap();

        // Verify in DB via direct query
        let row = get_block_inner(&pool, resp.id.clone()).await.unwrap();
        assert_eq!(row.id, resp.id);
        assert_eq!(row.block_type, "page");
        assert_eq!(row.content, Some("persisted".into()));
        assert_eq!(row.position, Some(5));
        assert!(row.deleted_at.is_none());
    }
}
