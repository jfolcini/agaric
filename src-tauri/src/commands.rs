//! Tauri command handlers for the block-notes app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use chrono::Utc;
use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::{Materializer, StatusInfo};
use crate::op::{
    AddTagPayload, CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload,
    OpPayload, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::recovery;
use crate::soft_delete;
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
pub struct BlockResponse {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct DeleteResponse {
    pub block_id: String,
    pub deleted_at: String,
    pub descendants_affected: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct RestoreResponse {
    pub block_id: String,
    pub restored_count: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct PurgeResponse {
    pub block_id: String,
    pub purged_count: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MoveResponse {
    pub block_id: String,
    pub new_parent_id: Option<String>,
    pub new_position: i64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct TagResponse {
    pub block_id: String,
    pub tag_id: String,
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
    // 1. Validate block_type
    match block_type.as_str() {
        "content" | "tag" | "page" => {}
        _ => {
            return Err(AppError::Validation(format!(
                "unknown block_type '{block_type}': must be 'content', 'tag', or 'page'"
            )));
        }
    }

    // 2. Generate new BlockId
    let block_id = BlockId::new();

    // 3. If parent_id is Some, validate it exists and is not deleted
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

    // 4. Begin IMMEDIATE transaction for atomic op_log + blocks write.
    //    IMMEDIATE eagerly acquires the write lock, avoiding
    //    SQLITE_BUSY_SNAPSHOT when a background cache rebuild commits
    //    between our first read and first write.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // 5. Insert into blocks table within same transaction
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(block_id.as_str())
    .bind(&block_type)
    .bind(&content)
    .bind(&parent_id)
    .bind(position)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // 6. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

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

    // 4. Begin IMMEDIATE transaction for atomic op_log + blocks write.
    //    IMMEDIATE eagerly acquires the write lock, avoiding
    //    SQLITE_BUSY_SNAPSHOT when a background cache rebuild commits
    //    between our first read and first write.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // 5. Update blocks table within same transaction
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
        .bind(&to_text)
        .bind(&block_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 6. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

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
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: block_id.clone(),
        cascade: true,
    });

    // Single IMMEDIATE transaction: validation + op_log + cascade soft-delete.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (deleted_at,) = row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;
    if deleted_at.is_some() {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' is already deleted"
        )));
    }

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // Cascade soft-delete within same transaction
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    )
    .bind(&block_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    let _ = materializer.dispatch_background(&op_record);

    Ok(DeleteResponse {
        block_id,
        deleted_at: now,
        descendants_affected: result.rows_affected(),
    })
}

pub async fn restore_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    // Single IMMEDIATE transaction: validation + op_log + restore.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
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
        Some((Some(ref actual_deleted_at),)) => {
            if *actual_deleted_at != deleted_at_ref {
                return Err(AppError::InvalidOperation(format!(
                    "block '{block_id}' deleted_at mismatch: expected '{}', got '{}'",
                    deleted_at_ref, actual_deleted_at
                )));
            }
        }
    }

    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: block_id.clone(),
        deleted_at_ref: deleted_at_ref.clone(),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // Restore within same transaction
    let result = sqlx::query(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    )
    .bind(&block_id)
    .bind(&deleted_at_ref)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    let _ = materializer.dispatch_background(&op_record);

    Ok(RestoreResponse {
        block_id,
        restored_count: result.rows_affected(),
    })
}

pub async fn purge_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    // Single IMMEDIATE transaction: validation + op_log.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
            .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block '{block_id}'")));
        }
        Some((None,)) => {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' must be soft-deleted before purging"
            )));
        }
        Some((Some(_),)) => {} // block is deleted, proceed with purge
    }

    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: block_id.clone(),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    tx.commit().await?;

    // Purge block physically (uses its own transaction internally).
    // TODO(Phase 2): Inline purge logic into the main transaction above
    // for full atomicity. Currently the validation + op_log are atomic,
    // but the physical purge is a separate transaction.
    let count = soft_delete::purge_block(pool, &block_id).await?;

    // Fire-and-forget background cache dispatch
    let _ = materializer.dispatch_background(&op_record);

    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

pub async fn move_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    new_parent_id: Option<String>,
    new_position: i64,
) -> Result<MoveResponse, AppError> {
    // 1. Validate block cannot become its own parent (pure-logic check, no DB)
    if let Some(ref pid) = new_parent_id {
        if pid == &block_id {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' cannot be its own parent"
            )));
        }
    }

    // 2. Build OpPayload
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: block_id.clone(),
        new_parent_id: new_parent_id.clone(),
        new_position,
    });

    // 3. Single IMMEDIATE transaction: validation + op_log + move.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate new parent exists and is not deleted (TOCTOU-safe)
    if let Some(ref pid) = new_parent_id {
        let exists: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL")
                .bind(pid)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }
    }

    // 4. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // 5. Update blocks table within same transaction
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(&new_parent_id)
        .bind(new_position)
        .bind(&block_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 6. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    // 7. Return response
    Ok(MoveResponse {
        block_id,
        new_parent_id,
        new_position,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn list_blocks_inner(
    pool: &SqlitePool,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    agenda_date: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;

    if show_deleted == Some(true) {
        pagination::list_trash(pool, &page).await
    } else if let Some(ref d) = agenda_date {
        pagination::list_agenda(pool, d, &page).await
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

pub async fn add_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate tag_id refers to a block with block_type = 'tag' and is not deleted (TOCTOU-safe)
    let tag_row: Option<(String,)> =
        sqlx::query_as("SELECT block_type FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(&tag_id)
            .fetch_optional(&mut *tx)
            .await?;
    match tag_row {
        None => {
            return Err(AppError::NotFound(format!(
                "tag block '{tag_id}' (not found or deleted)"
            )));
        }
        Some((ref bt,)) if bt != "tag" => {
            return Err(AppError::InvalidOperation(format!(
                "block '{tag_id}' has block_type '{bt}', expected 'tag'"
            )));
        }
        _ => {}
    }

    // Check for existing association (TOCTOU-safe)
    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&block_id)
            .bind(&tag_id)
            .fetch_optional(&mut *tx)
            .await?;
    if dup.is_some() {
        return Err(AppError::InvalidOperation("tag already applied".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // 4. Insert into block_tags within same transaction
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&block_id)
        .bind(&tag_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    // 6. Return response
    Ok(TagResponse { block_id, tag_id })
}

pub async fn remove_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(&block_id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Check association exists (TOCTOU-safe)
    let assoc: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&block_id)
            .bind(&tag_id)
            .fetch_optional(&mut *tx)
            .await?;
    if assoc.is_none() {
        return Err(AppError::NotFound("tag association".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // 4. Delete from block_tags within same transaction
    sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&block_id)
        .bind(&tag_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    // 6. Return response
    Ok(TagResponse { block_id, tag_id })
}

pub async fn get_backlinks_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_backlinks(pool, &block_id, &page).await
}

pub async fn get_block_history_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_block_history(pool, &block_id, &page).await
}

pub async fn get_conflicts_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_conflicts(pool, &page).await
}

pub fn get_status_inner(materializer: &Materializer) -> StatusInfo {
    materializer.status()
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
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

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn edit_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    to_text: String,
) -> Result<BlockResponse, AppError> {
    edit_block_inner(&pool, &device_id.0, &materializer, block_id, to_text).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    delete_block_inner(&pool, &device_id.0, &materializer, block_id).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    restore_block_inner(&pool, &device_id.0, &materializer, block_id, deleted_at_ref).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn purge_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    purge_block_inner(&pool, &device_id.0, &materializer, block_id).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn move_block(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    new_parent_id: Option<String>,
    new_position: i64,
) -> Result<MoveResponse, AppError> {
    move_block_inner(
        &pool,
        &device_id.0,
        &materializer,
        block_id,
        new_parent_id,
        new_position,
    )
    .await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_blocks(
    pool: State<'_, SqlitePool>,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    agenda_date: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_blocks_inner(
        &pool,
        parent_id,
        block_type,
        tag_id,
        show_deleted,
        agenda_date,
        cursor,
        limit,
    )
    .await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block(
    pool: State<'_, SqlitePool>,
    block_id: String,
) -> Result<BlockRow, AppError> {
    get_block_inner(&pool, block_id).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn add_tag(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    add_tag_inner(&pool, &device_id.0, &materializer, block_id, tag_id).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn remove_tag(
    pool: State<'_, SqlitePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    remove_tag_inner(&pool, &device_id.0, &materializer, block_id, tag_id).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_backlinks(
    pool: State<'_, SqlitePool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    get_backlinks_inner(&pool, block_id, cursor, limit).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block_history(
    pool: State<'_, SqlitePool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    get_block_history_inner(&pool, block_id, cursor, limit).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_conflicts(
    pool: State<'_, SqlitePool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    get_conflicts_inner(&pool, cursor, limit).await
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_status(materializer: State<'_, Materializer>) -> Result<StatusInfo, AppError> {
    Ok(get_status_inner(&materializer))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Integration-style tests for command handlers.
    //!
    //! Each test uses a temporary SQLite database with full migrations.
    //! The Materializer is created for commands that require it; sleeps
    //! between operations allow background cache tasks to settle and avoid
    //! write-lock contention.

    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // -- Deterministic test fixtures --

    const DEV: &str = "test-device-001";
    const FIXED_TS: &str = "2025-01-01T00:00:00Z";

    // -- Helpers --

    /// Creates a temporary SQLite database with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
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
        assert_eq!(resp.content, Some("hello world".into()));
        assert!(resp.parent_id.is_none(), "top-level block has no parent");
        assert_eq!(resp.position, Some(1));
        assert!(resp.deleted_at.is_none(), "new block should not be deleted");

        // Verify persistence in DB via direct query
        let row = get_block_inner(&pool, resp.id.clone()).await.unwrap();
        assert_eq!(row.id, resp.id, "DB row should match response ID");
        assert_eq!(row.block_type, "content");
        assert_eq!(row.content, Some("hello world".into()));
        assert_eq!(row.position, Some(1));
        assert!(row.deleted_at.is_none());
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
            resp.id.len(),
            26,
            "ULID should be 26 Crockford base32 characters"
        );
        assert!(
            resp.id.chars().all(|c| c.is_ascii_alphanumeric()),
            "ULID should only contain alphanumeric characters"
        );
        assert!(
            BlockId::from_string(&resp.id).is_ok(),
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

        // Allow bg cache tasks to settle before delete
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        delete_block_inner(&pool, DEV, &mat, parent.id.clone())
            .await
            .unwrap();

        // Allow bg cache tasks from delete to settle
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

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

        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'create_block'",
        )
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(count.0, 1, "exactly one create_block op should be logged");
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
            "should return Validation error"
        );
        assert!(
            err.to_string().contains("unknown block_type"),
            "error message should mention unknown block_type"
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
            assert_eq!(resp.unwrap().block_type, *block_type);
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
        let row = get_block_inner(&pool, resp.id).await.unwrap();
        assert_eq!(row.content, Some(unicode_content.into()));
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
        assert_eq!(
            row.0,
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

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

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
        let edited = edit_block_inner(&pool, DEV, &mat, created.id, unicode.into())
            .await
            .unwrap();

        assert_eq!(
            edited.content,
            Some(unicode.into()),
            "unicode content should survive edit round-trip"
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

        assert_eq!(resp.descendants_affected, 2, "parent + child = 2 affected");
        assert!(
            !resp.deleted_at.is_empty(),
            "deleted_at timestamp should be set"
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

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        let result = delete_block_inner(&pool, DEV, &mat, created.id).await;
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
        let (ts, _) = soft_delete::cascade_soft_delete(&pool, "RST_PAR")
            .await
            .unwrap();

        let rest_resp = restore_block_inner(&pool, DEV, &mat, "RST_PAR".into(), ts)
            .await
            .unwrap();

        assert_eq!(rest_resp.restored_count, 2, "parent + child restored");

        let row: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind("RST_PAR")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.0.is_none(),
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
        let (ts, _) = soft_delete::cascade_soft_delete(&pool, "MISMATCH1")
            .await
            .unwrap();

        let wrong_ts = format!("{ts}_wrong");
        let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH1".into(), wrong_ts).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "mismatched deleted_at should return InvalidOperation"
        );
        assert!(
            err.to_string().contains("deleted_at mismatch"),
            "error message should mention mismatch"
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
        soft_delete::cascade_soft_delete(&pool, "PURGE1")
            .await
            .unwrap();

        let resp = purge_block_inner(&pool, DEV, &mat, "PURGE1".into())
            .await
            .unwrap();

        assert_eq!(resp.purged_count, 1);

        let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM blocks WHERE id = ?")
            .bind("PURGE1")
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
            "purging a non-deleted block should return InvalidOperation"
        );
        assert!(
            err.to_string().contains("soft-deleted before purging"),
            "error message should explain the requirement"
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

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, None)
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "should only return top-level blocks (parent_id IS NULL)"
        );
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"TOP1"));
        assert!(ids.contains(&"TOP2"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_block_type_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE1", "page", "my page", None, Some(1)).await;
        insert_block(&pool, "TAG1", "tag", "urgent", None, None).await;
        insert_block(&pool, "CONT1", "content", "hello", None, Some(2)).await;

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

        assert_eq!(resp.items.len(), 1, "should filter to page type only");
        assert_eq!(resp.items[0].id, "PAGE1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_parent_id_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CH1", "content", "child 1", Some("PAR"), Some(1)).await;
        insert_block(&pool, "CH2", "content", "child 2", Some("PAR"), Some(2)).await;
        insert_block(&pool, "OTHER", "content", "other", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            Some("PAR".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 2, "should return only children of PAR");
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"CH1"));
        assert!(ids.contains(&"CH2"));
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

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            Some("TAG_FILTER".into()),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "should return blocks tagged with TAG_FILTER"
        );
        assert_eq!(resp.items[0].id, "TAGGED_BLK");
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

        let resp = list_blocks_inner(&pool, None, None, None, Some(true), None, None, None)
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "trash should contain only deleted blocks"
        );
        assert_eq!(resp.items[0].id, "DEAD");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_empty_db_returns_empty_page() {
        let (pool, _dir) = test_pool().await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, None)
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
        assert_eq!(block.id, "BLK001");
        assert_eq!(block.block_type, "content");
        assert_eq!(block.content, Some("hello".into()));
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_returns_deleted_block_too() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DELBLK", "content", "will be deleted", None, Some(1)).await;

        // Soft-delete the block
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DELBLK'")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        // get_block should still return it (unlike list_blocks which excludes deleted)
        let block = get_block_inner(&pool, "DELBLK".into()).await.unwrap();
        assert_eq!(block.id, "DELBLK");
        assert_eq!(
            block.deleted_at,
            Some(FIXED_TS.into()),
            "get_block should return deleted_at for soft-deleted blocks"
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

        assert_eq!(resp.block_id, "MV_CHILD");
        assert_eq!(resp.new_parent_id, Some("MV_PAR_B".into()));
        assert_eq!(resp.new_position, 5);

        // Verify DB state
        let row: (Option<String>, Option<i64>) =
            sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                .bind("MV_CHILD")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            row.0,
            Some("MV_PAR_B".into()),
            "parent_id should be updated in DB"
        );
        assert_eq!(row.1, Some(5), "position should be updated in DB");

        // Verify op_log entry
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'move_block'",
        )
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count.0, 1, "exactly one move_block op should be logged");
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

        assert_eq!(resp.block_id, "MV_ROOT_CHD");
        assert!(
            resp.new_parent_id.is_none(),
            "new_parent_id should be None for root move"
        );
        assert_eq!(resp.new_position, 10);

        // Verify DB state
        let row: (Option<String>, Option<i64>) =
            sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                .bind("MV_ROOT_CHD")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            row.0.is_none(),
            "parent_id should be NULL in DB after move to root"
        );
        assert_eq!(row.1, Some(10), "position should be updated in DB");
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
            "block_id == new_parent_id should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("cannot be its own parent"),
            "error message should explain the constraint"
        );
    }

    // ======================================================================
    // add_tag
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_success() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

        let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
            .await
            .unwrap();

        assert_eq!(resp.block_id, "AT_BLK");
        assert_eq!(resp.tag_id, "AT_TAG");

        // Verify block_tags row
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind("AT_BLK")
                .bind("AT_TAG")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(row.is_some(), "block_tags row should exist after add_tag");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_duplicate_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATD_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "ATD_TAG", "tag", "urgent", None, None).await;

        add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into())
            .await
            .unwrap();

        let result = add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "adding same tag twice should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("tag already applied"),
            "error message should mention tag already applied"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_nonexistent_block_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATN_TAG", "tag", "urgent", None, None).await;

        let result = add_tag_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "ATN_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "adding tag to nonexistent block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_nonexistent_tag_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

        let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "NONEXISTENT".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "adding nonexistent tag should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_non_tag_block_type_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATNBT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "ATNBT_CONT", "content", "not a tag", None, Some(2)).await;

        let result = add_tag_inner(&pool, DEV, &mat, "ATNBT_BLK".into(), "ATNBT_CONT".into()).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "using a content block as tag_id should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("expected 'tag'"),
            "error message should mention expected tag type"
        );
    }

    // ======================================================================
    // remove_tag
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_tag_success() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

        add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
            .await
            .unwrap();

        let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
            .await
            .unwrap();

        assert_eq!(resp.block_id, "RT_BLK");
        assert_eq!(resp.tag_id, "RT_TAG");

        // Verify block_tags is empty
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind("RT_BLK")
                .bind("RT_TAG")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(
            row.is_none(),
            "block_tags row should be gone after remove_tag"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_tag_not_applied_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

        let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "removing a tag that was never applied should return NotFound"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("tag association"),
            "error message should mention tag association"
        );
    }

    // ======================================================================
    // insta snapshot tests — command responses
    // ======================================================================

    /// Snapshot a BlockResponse from create_block_inner.
    /// Redacts `id` (ULID is non-deterministic).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_create_block_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "snapshot test content".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".id" => "[ULID]",
        });
    }

    /// Snapshot a DeleteResponse from delete_block_inner.
    /// Redacts `deleted_at` (wall-clock timestamp).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_delete_block_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Use direct insert to avoid materializer contention
        insert_block(&pool, "SNAP_DEL", "content", "doomed", None, Some(1)).await;

        let resp = delete_block_inner(&pool, DEV, &mat, "SNAP_DEL".into())
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".deleted_at" => "[TIMESTAMP]",
        });
    }

    /// Snapshot a PageResponse from list_blocks_inner.
    /// Redacts `id` fields since they are ULIDs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_blocks_response() {
        let (pool, _dir) = test_pool().await;

        // Insert deterministic blocks
        insert_block(&pool, "SNAP_BLK1", "content", "first", None, Some(1)).await;
        insert_block(&pool, "SNAP_BLK2", "page", "second", None, Some(2)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, Some(10))
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp);
    }

    // ======================================================================
    // get_backlinks
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_backlinks_returns_linked_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BL_TGT", "page", "target", None, None).await;
        insert_block(&pool, "BL_SRC1", "content", "src1", None, None).await;
        insert_block(&pool, "BL_SRC2", "content", "src2", None, None).await;

        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BL_SRC1")
            .bind("BL_TGT")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BL_SRC2")
            .bind("BL_TGT")
            .execute(&pool)
            .await
            .unwrap();

        let resp = get_backlinks_inner(&pool, "BL_TGT".into(), None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "BL_SRC1");
        assert_eq!(resp.items[1].id, "BL_SRC2");
    }

    // ======================================================================
    // get_block_history
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_history_returns_ops_for_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
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

        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
            .await
            .unwrap();

        let resp = get_block_history_inner(&pool, created.id, None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2, "create + edit = 2 ops");
        // Newest first (seq DESC)
        assert_eq!(resp.items[0].op_type, "edit_block");
        assert_eq!(resp.items[1].op_type, "create_block");
    }

    // ======================================================================
    // get_conflicts
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_conflicts_returns_conflict_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "CF_NORM", "content", "normal", None, None).await;
        insert_block(&pool, "CF_CONF", "content", "conflict", None, None).await;

        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind("CF_CONF")
            .execute(&pool)
            .await
            .unwrap();

        let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, "CF_CONF");
        assert!(resp.items[0].is_conflict);
    }

    // ======================================================================
    // get_status
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_status_returns_initial_metrics() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Allow consumer tasks to start before checking status
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let status = get_status_inner(&mat);

        // Fresh materializer — all counters at zero
        assert_eq!(status.total_ops_dispatched, 0);
        assert_eq!(status.total_background_dispatched, 0);
    }

    // ======================================================================
    // insta snapshot tests — new response types
    // ======================================================================

    /// Snapshot a StatusInfo from get_status_inner.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_status_info_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Allow consumer tasks to start
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let status = get_status_inner(&mat);

        insta::assert_yaml_snapshot!(status);
    }

    /// Snapshot a PageResponse<HistoryEntry> from get_block_history_inner.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_block_history_response() {
        let (pool, _dir) = test_pool().await;

        // Insert deterministic op_log entries directly
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("snap-device")
        .bind(1_i64)
        .bind("snap-hash")
        .bind("create_block")
        .bind(r#"{"block_id":"SNAP_HIST","block_type":"content","content":"hi"}"#)
        .bind("2025-06-15T12:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

        let resp = get_block_history_inner(&pool, "SNAP_HIST".into(), None, None)
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp);
    }
}
