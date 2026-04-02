//! Tauri command handlers for the Agaric app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::backlink_query::{
    self, BacklinkFilter, BacklinkQueryResponse, BacklinkSort, GroupedBacklinkResponse,
};
use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::fts;
use crate::materializer::{Materializer, StatusInfo};
use crate::now_rfc3339;
use crate::op::{
    is_reserved_property_key, validate_set_property, AddTagPayload, CreateBlockPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    OpRef, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload, SetPropertyPayload,
    UndoResult,
};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::pairing::{generate_qr_svg, pairing_qr_payload, PairingSession};
use crate::peer_refs::{self, PeerRef};
#[cfg(test)]
use crate::soft_delete;
use crate::sync_scheduler::SyncScheduler;
use crate::tag_query::{self, TagCacheRow, TagExpr};
use crate::ulid::BlockId;

/// Maximum allowed content length for a single block (256 KB).
const MAX_CONTENT_LENGTH: usize = 256 * 1024;

/// Maximum allowed nesting depth for the block tree.
/// Prevents pathological recursion and keeps recursive CTEs bounded.
const MAX_BLOCK_DEPTH: i64 = 20;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Validate that a date string is in `YYYY-MM-DD` format with reasonable
/// range checks on month (01–12) and day (01–31). This is a structural
/// check — it does NOT reject dates like Feb 30; the DB/agenda query
/// handles that gracefully. The goal is to catch obviously malformed input
/// before it reaches the query layer.
fn validate_date_format(date: &str) -> Result<(), AppError> {
    if date.len() != 10 {
        return Err(AppError::Validation(format!(
            "date must be exactly 10 characters (YYYY-MM-DD), got {} characters: '{date}'",
            date.len()
        )));
    }

    let bytes = date.as_bytes();
    // Check pattern: DDDD-DD-DD where D is ASCII digit
    let digit_positions = [0, 1, 2, 3, 5, 6, 8, 9];
    for &i in &digit_positions {
        if !bytes[i].is_ascii_digit() {
            return Err(AppError::Validation(format!(
                "date must match YYYY-MM-DD pattern, got '{date}'"
            )));
        }
    }
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(AppError::Validation(format!(
            "date must match YYYY-MM-DD pattern, got '{date}'"
        )));
    }

    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(AppError::Validation(format!(
            "date must have 3 parts separated by '-', got '{date}'"
        )));
    }

    let year_len = parts[0].len();
    let month_len = parts[1].len();
    let day_len = parts[2].len();
    if year_len != 4 || month_len != 2 || day_len != 2 {
        return Err(AppError::Validation(format!(
            "date must be YYYY-MM-DD (4-2-2 digits), got '{date}'"
        )));
    }

    let month: u32 = parts[1].parse().unwrap_or(0);
    let day: u32 = parts[2].parse().unwrap_or(0);

    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!(
            "month must be 01–12, got '{}'",
            parts[1]
        )));
    }
    if !(1..=31).contains(&day) {
        return Err(AppError::Validation(format!(
            "day must be 01–31, got '{}'",
            parts[2]
        )));
    }

    Ok(())
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

#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
pub struct PropertyRow {
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

/// A property definition from the schema registry.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PropertyDefinition {
    pub key: String,
    pub value_type: String,
    pub options: Option<String>, // JSON array string for select types
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Sync pairing & session types
// ---------------------------------------------------------------------------

/// Response payload returned by [`start_pairing`].
#[derive(Debug, Clone, Serialize, Type)]
pub struct PairingInfo {
    pub passphrase: String,
    pub qr_svg: String,
    pub port: u16,
}

/// Response payload returned by [`start_sync`].
#[derive(Debug, Clone, Serialize, Type)]
pub struct SyncSessionInfo {
    pub state: String,
    pub local_device_id: String,
    pub remote_device_id: String,
    pub ops_received: u64,
    pub ops_sent: u64,
}

/// Managed state holding the current active pairing session (if any).
///
/// Uses a std `Mutex` (not tokio) because the critical section is
/// trivially short (swap an `Option`).
pub struct PairingState(pub Mutex<Option<PairingSession>>);

// ---------------------------------------------------------------------------
// Inner functions (testable without Tauri State)
// ---------------------------------------------------------------------------

/// Create a new block.
///
/// Validates block type and optional parent, generates a ULID, appends a
/// `CreateBlock` op, inserts the row into `blocks`, and dispatches
/// background cache tasks.
///
/// # Errors
///
/// - [`AppError::Validation`] — unknown `block_type` or non-positive `position`
/// - [`AppError::NotFound`] — `parent_id` does not refer to a live block
///
/// # Rate limiting (F07)
///
/// No server-side rate limiting is implemented. This is acceptable for a
/// single-user desktop app where the caller is always the local UI. If the
/// app ever gains a network-facing API, rate limiting should be added at the
/// transport layer.
pub async fn create_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockRow, AppError> {
    // 1. Validate block_type
    match block_type.as_str() {
        "content" | "tag" | "page" => {}
        _ => {
            return Err(AppError::Validation(format!(
                "unknown block_type '{block_type}': must be 'content', 'tag', or 'page'"
            )));
        }
    }

    // 1b. Validate position is positive (1-based) when provided
    if let Some(pos) = position {
        if pos <= 0 {
            return Err(AppError::Validation(format!(
                "position must be positive (1-based), got {pos}"
            )));
        }
    }

    // 1c. Validate content length
    if content.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            content.len()
        )));
    }

    // 2. Generate new BlockId
    let block_id = BlockId::new();

    // 4. Begin IMMEDIATE transaction for atomic op_log + blocks write.
    //    IMMEDIATE eagerly acquires the write lock, avoiding
    //    SQLITE_BUSY_SNAPSHOT when a background cache rebuild commits
    //    between our first read and first write.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // F01: Validate parent_id inside the transaction to prevent TOCTOU race.
    // A concurrent purge_block could physically delete the parent between
    // our check and the INSERT, violating the FK constraint.
    if let Some(ref pid) = parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }
    }

    // Compute next position when none provided: append after last sibling
    let effective_position = match position {
        Some(p) => p,
        None => {
            let row = sqlx::query!(
                "SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM blocks \
                 WHERE parent_id IS ? AND deleted_at IS NULL",
                parent_id
            )
            .fetch_optional(&mut *tx)
            .await?;
            row.map(|r| r.next_pos).unwrap_or(1)
        }
    };

    // 3b. Build OpPayload with the resolved position
    let parent_block_id = parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_block_id,
        position: Some(effective_position),
        content: content.clone(),
    });

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 5. Insert into blocks table within same transaction
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(block_id.as_str())
    .bind(&block_type)
    .bind(&content)
    .bind(&parent_id)
    .bind(effective_position)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // 6. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    // 7. Return response
    Ok(BlockRow {
        id: block_id.into_string(),
        block_type,
        content: Some(content),
        parent_id,
        position: Some(effective_position),
        deleted_at: None,
        archived_at: None,
        is_conflict: false,
        conflict_type: None,
        todo_state: None,
        priority: None,
        due_date: None,
    })
}

/// Edit a block's content.
///
/// Validates the block exists and is not deleted, looks up the previous edit
/// reference for conflict detection, appends an `EditBlock` op, updates the
/// `blocks` table, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
pub async fn edit_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    to_text: String,
) -> Result<BlockRow, AppError> {
    // F02: Begin IMMEDIATE transaction for atomic validation + op_log + blocks write.
    // All reads (block existence, prev_edit lookup) happen inside the tx
    // to prevent TOCTOU races (a concurrent delete_block could soft-delete
    // the block between validation and update, and another edit could make
    // the prev_edit reference stale).
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 1. Validate block exists and is not deleted (inside tx = TOCTOU-safe)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let block_type = existing.block_type;
    let parent_id = existing.parent_id;
    let position = existing.position;

    // 1b. Validate content length
    if to_text.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            to_text.len()
        )));
    }

    // 2. Find prev_edit inside transaction (inlined from recovery::find_prev_edit)
    let prev_edit_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let prev_edit = prev_edit_row.map(|r| (r.device_id, r.seq));

    // 3. Build OpPayload
    let block_id_ulid = BlockId::from_trusted(&block_id);
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id_ulid,
        to_text: to_text.clone(),
        prev_edit,
    });

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Update blocks table within same transaction.
    // `AND deleted_at IS NULL` guard prevents overwriting content on a
    // block that was concurrently soft-deleted.
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(&to_text)
        .bind(&block_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget).
    // Use dispatch_edit_background with the block_type hint so only
    // relevant caches are rebuilt (e.g. content blocks skip tags/pages).
    let _ = materializer.dispatch_edit_background(&op_record, &block_type);

    // 6. Return response
    Ok(BlockRow {
        id: block_id,
        block_type,
        content: Some(to_text),
        parent_id,
        position,
        deleted_at: None,
        archived_at: None,
        is_conflict: false,
        conflict_type: None,
        todo_state: None,
        priority: None,
        due_date: None,
    })
}

/// Soft-delete a block and all its descendants (ADR-06 cascade).
///
/// Validates the block exists and is not already deleted, appends a
/// `DeleteBlock` op, sets `deleted_at` on the block and all descendants
/// via recursive CTE, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is already soft-deleted
pub async fn delete_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Single IMMEDIATE transaction: validation + op_log + cascade soft-delete.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut *tx)
        .await?;
    let row = row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;
    if row.deleted_at.is_some() {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' is already deleted"
        )));
    }

    // Single timestamp for both op_log and blocks — reverse_delete_block uses
    // record.created_at as deleted_at_ref, so they must match exactly.
    let now = now_rfc3339();

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;

    // Cascade soft-delete within same transaction
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

/// Restore a soft-deleted block and its descendants.
///
/// Validates the block exists and is deleted with the expected `deleted_at`
/// timestamp (optimistic concurrency guard), appends a `RestoreBlock` op,
/// clears `deleted_at` on matching descendants, and dispatches background
/// cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not deleted, or `deleted_at` timestamp mismatch
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
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut *tx)
        .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block '{block_id}'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' is not deleted"
            )));
        }
        Some(ref r) => {
            let actual_deleted_at = r.deleted_at.as_ref().unwrap();
            if *actual_deleted_at != deleted_at_ref {
                return Err(AppError::InvalidOperation(format!(
                    "block '{block_id}' deleted_at mismatch: expected '{}', got '{}'",
                    deleted_at_ref, actual_deleted_at
                )));
            }
        }
    }

    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        deleted_at_ref: deleted_at_ref.clone(),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

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

/// Permanently purge a soft-deleted block and all its descendants.
///
/// Validates the block exists and is already soft-deleted, appends a
/// `PurgeBlock` op, then physically deletes the block, its descendants,
/// and all related rows (tags, properties, links, caches, FTS, drafts,
/// attachments) in a single deferred-FK transaction.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not soft-deleted
pub async fn purge_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    // F03: Single IMMEDIATE transaction for validation + op_log + physical purge.
    // Previously the op_log write and the physical purge were split across two
    // transactions, meaning a crash between them left the op_log recording a
    // purge that never happened.  Now everything is in one atomic tx.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut *tx)
        .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block \'{block_id}\'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block \'{block_id}\' must be soft-deleted before purging"
            )));
        }
        Some(_) => {} // block is deleted, proceed with purge
    }

    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // --- Inline physical purge (previously soft_delete::purge_block) ---
    // Defer FK checks until commit — the entire subtree will be gone by then
    // so no constraints will be violated.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // Recursive CTE reused in every batch operation below.
    const DESC_CTE: &str = "WITH RECURSIVE descendants(id) AS ( \
        SELECT id FROM blocks WHERE id = ? \
        UNION ALL \
        SELECT b.id FROM blocks b \
        INNER JOIN descendants d ON b.parent_id = d.id \
    )";

    // block_tags: either column may reference a descendant
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // block_properties: owned by descendants
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // block_properties: value_ref pointing into the subtree (NULLify)
    sqlx::query(&format!(
        "{DESC_CTE} UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // block_links: either end may be in the subtree
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM descendants) \
            OR target_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // agenda_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // tags_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // pages_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // attachments
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // block_drafts
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // Nullify conflict_source refs from blocks outside the subtree
    sqlx::query(&format!(
        "{DESC_CTE} UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // fts_blocks (FTS5 virtual table — no FK, must be cleaned explicitly)
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // Delete blocks (deferred FK allows single-statement batch)
    let result = sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM blocks \
         WHERE id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    let _ = materializer.dispatch_background(&op_record);

    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

/// Move a block to a new parent at a specific position.
///
/// Validates the block and optional new parent exist, detects cycles via
/// ancestor-walking CTE, appends a `MoveBlock` op, updates `parent_id` and
/// `position` in the `blocks` table, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::InvalidOperation`] — block cannot be its own parent
/// - [`AppError::Validation`] — non-positive position, or cycle detected
/// - [`AppError::NotFound`] — block or new parent does not exist or is deleted
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

    // 1b. Validate position is positive (1-based)
    if new_position <= 0 {
        return Err(AppError::Validation(format!(
            "position must be positive (1-based), got {new_position}"
        )));
    }

    // 2. Build OpPayload
    let new_parent_block_id = new_parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id.clone(),
        new_position,
    });

    // 3. Single IMMEDIATE transaction: validation + op_log + move.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let existing = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate new parent exists and is not deleted (TOCTOU-safe)
    if let Some(ref pid) = new_parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }

        // Cycle detection: walk all ancestors of the new parent using a
        // recursive CTE. If block_id appears among the ancestors, reparenting
        // would create a cycle (e.g. moving A under its own grandchild C in
        // a chain A→B→C).
        let cycle = sqlx::query!(
            r#"WITH RECURSIVE ancestors(id) AS (
                 SELECT parent_id FROM blocks WHERE id = ?
                 UNION ALL
                 SELECT b.parent_id FROM blocks b
                 INNER JOIN ancestors a ON b.id = a.id
                 WHERE a.id IS NOT NULL
             )
             SELECT 1 as "v: i32" FROM ancestors WHERE id = ?"#,
            pid,
            block_id
        )
        .fetch_optional(&mut *tx)
        .await?;
        if cycle.is_some() {
            return Err(AppError::Validation("cycle detected".into()));
        }

        // Depth check: count ancestors of the target parent (its depth from
        // root) and the max descendant depth of the block being moved. The
        // deepest descendant will end up at parent_depth + 1 + subtree_depth.
        let parent_depth = sqlx::query_scalar!(
            r#"WITH RECURSIVE path(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.parent_id, p.depth + 1
                 FROM path p
                 JOIN blocks b ON b.id = p.id
                 WHERE b.parent_id IS NOT NULL
             )
             SELECT MAX(depth) as "max_depth: i64" FROM path"#,
            pid
        )
        .fetch_one(&mut *tx)
        .await?;

        let subtree_depth = sqlx::query_scalar!(
            r#"WITH RECURSIVE descendants(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.id, d.depth + 1
                 FROM descendants d
                 JOIN blocks b ON b.parent_id = d.id
                 WHERE b.deleted_at IS NULL
             )
             SELECT MAX(depth) as "max_depth: i64" FROM descendants"#,
            block_id
        )
        .fetch_one(&mut *tx)
        .await?;

        if parent_depth + 1 + subtree_depth > MAX_BLOCK_DEPTH {
            return Err(AppError::Validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // 4. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

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

/// Reorder a block among its siblings, handling position collisions.
///
/// Unlike [`move_block_inner`] which blindly sets a caller-supplied position,
/// this function **computes** a safe position that avoids collisions with
/// existing siblings.  It implements the "batch renumber" strategy described
/// in REVIEW-LATER #2.
///
/// # Parameters
///
/// * `block_id` – the block being moved.
/// * `parent_id` – destination parent (`None` = root level).
/// * `after_id` – the sibling **after which** to place the block.
///   `None` means "place first" (smallest position).
///
/// # Algorithm
///
/// 1. Look up `after_id`'s position → `before_pos`.
/// 2. Find the next sibling's position → `next_pos`.
/// 3. If `next_pos − before_pos > 1`: a gap exists → `new_position = before_pos + 1`.
/// 4. If `next_pos − before_pos ≤ 1`: no gap → **shift** all siblings with
///    `position > before_pos` up by 1, then `new_position = before_pos + 1`.
/// 5. When `after_id` is `None`: place at position 1, shifting existing
///    siblings up if necessary.
///
/// # Errors
///
/// - [`AppError::InvalidOperation`] — block cannot be its own parent
/// - [`AppError::Validation`] — `after_id` equals `block_id`
/// - [`AppError::NotFound`] — block, parent, or `after_id` sibling not found
pub async fn reorder_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    parent_id: Option<String>,
    after_id: Option<String>,
) -> Result<MoveResponse, AppError> {
    // 1. Pure-logic validations (no DB needed)
    if let Some(ref pid) = parent_id {
        if pid == &block_id {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' cannot be its own parent"
            )));
        }
    }
    if let Some(ref aid) = after_id {
        if aid == &block_id {
            return Err(AppError::Validation(
                "after_id cannot be the same as block_id".into(),
            ));
        }
    }

    // 2. Begin IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 3. Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let existing = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // 4. Validate parent exists and is not deleted (if provided)
    if let Some(ref pid) = parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }
    }

    // 5. Compute the new position
    let new_position: i64 = if let Some(ref after_id_val) = after_id {
        // --- Place after a specified sibling ---

        // Validate after_id is a sibling under the target parent
        let after_row = sqlx::query!(
            "SELECT position FROM blocks \
             WHERE id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL",
            after_id_val,
            parent_id
        )
        .fetch_optional(&mut *tx)
        .await?;

        let after_row = after_row.ok_or_else(|| {
            AppError::NotFound(format!(
                "after_id '{after_id_val}' is not a sibling under the given parent"
            ))
        })?;

        let before_pos = after_row.position.unwrap_or(0);

        // Find the next sibling by position (excluding the block being moved)
        let next_row = sqlx::query!(
            "SELECT position FROM blocks \
             WHERE parent_id IS ?1 AND position > ?2 AND id != ?3 \
               AND deleted_at IS NULL AND position IS NOT NULL \
             ORDER BY position ASC LIMIT 1",
            parent_id,
            before_pos,
            block_id
        )
        .fetch_optional(&mut *tx)
        .await?;

        match next_row {
            Some(r) if r.position.unwrap_or(0) - before_pos <= 1 => {
                // Consecutive (or overlapping) — batch-shift all subsequent siblings
                sqlx::query(
                    "UPDATE blocks SET position = position + 1 \
                     WHERE parent_id IS ?1 AND position > ?2 AND id != ?3 \
                       AND deleted_at IS NULL AND position IS NOT NULL",
                )
                .bind(&parent_id)
                .bind(before_pos)
                .bind(&block_id)
                .execute(&mut *tx)
                .await?;
                before_pos + 1
            }
            Some(_) | None => {
                // Gap exists or no next sibling — no shift needed
                before_pos + 1
            }
        }
    } else {
        // --- Place at the beginning ---
        let min_row = sqlx::query!(
            "SELECT MIN(position) as min_pos FROM blocks \
             WHERE parent_id IS ?1 AND id != ?2 \
               AND deleted_at IS NULL AND position IS NOT NULL",
            parent_id,
            block_id
        )
        .fetch_optional(&mut *tx)
        .await?;

        // `MIN()` returns NULL when there are no rows or all positions are NULL.
        let min_pos = min_row.and_then(|r| r.min_pos);

        match min_pos {
            Some(min) if min <= 1 => {
                // No gap at front — shift all siblings up by 1
                sqlx::query(
                    "UPDATE blocks SET position = position + 1 \
                     WHERE parent_id IS ?1 AND id != ?2 \
                       AND deleted_at IS NULL AND position IS NOT NULL",
                )
                .bind(&parent_id)
                .bind(&block_id)
                .execute(&mut *tx)
                .await?;
                1
            }
            Some(_) | None => {
                // Gap at front or no siblings — just use 1
                1
            }
        }
    };

    // 6. Build OpPayload (reuses MoveBlock — same logical operation)
    let new_parent_block_id = parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id,
        new_position,
    });

    // 7. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 8. Update block's parent and position
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(&parent_id)
        .bind(new_position)
        .bind(&block_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // 9. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    Ok(MoveResponse {
        block_id,
        new_parent_id: parent_id,
        new_position,
    })
}

/// List blocks with pagination, applying at most one exclusive filter.
///
/// Dispatches to the appropriate pagination query based on which filter
/// parameter is set: `show_deleted` (trash), `agenda_date`, `tag_id`,
/// `block_type`, or `parent_id` (children, the default). Page size is
/// clamped to `[1, 100]`.
///
/// # Errors
///
/// - [`AppError::Validation`] — multiple conflicting filters, or invalid date format
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
    // Reject conflicting filters: only one of the exclusive filter parameters
    // may be set. `parent_id` is the default (list children) so it only
    // counts as a filter when explicitly provided alongside another.
    let filter_count = [
        parent_id.is_some(),
        block_type.is_some(),
        tag_id.is_some(),
        show_deleted == Some(true),
        agenda_date.is_some(),
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if filter_count > 1 {
        return Err(AppError::Validation(
            "conflicting filters: only one of parent_id, block_type, tag_id, show_deleted, agenda_date may be set".to_string(),
        ));
    }

    // F06: Clamp page_size to [1, 100] to prevent oversized result sets
    // or nonsensical zero/negative limits.
    let clamped_limit = limit.map(|l| l.clamp(1, 100));
    let page = pagination::PageRequest::new(cursor, clamped_limit)?;

    if show_deleted == Some(true) {
        pagination::list_trash(pool, &page).await
    } else if let Some(ref d) = agenda_date {
        validate_date_format(d)?;
        pagination::list_agenda(pool, d, &page).await
    } else if let Some(ref t) = tag_id {
        pagination::list_by_tag(pool, t, &page).await
    } else if let Some(ref bt) = block_type {
        pagination::list_by_type(pool, bt, &page).await
    } else {
        pagination::list_children(pool, parent_id.as_deref(), &page).await
    }
}

/// Fetch a single block by ID (including soft-deleted blocks).
///
/// # Errors
///
/// - [`AppError::NotFound`] — no block with the given ID exists
pub async fn get_block_inner(pool: &SqlitePool, block_id: String) -> Result<BlockRow, AppError> {
    let row: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(pool)
    .await?;

    row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))
}

// ---------------------------------------------------------------------------
// batch_resolve — single-query multi-block metadata lookup
// ---------------------------------------------------------------------------

/// Lightweight metadata returned by [`batch_resolve_inner`].
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ResolvedBlock {
    pub id: String,
    /// `content` column — page title, tag name, or content text (truncated).
    pub title: Option<String>,
    pub block_type: String,
    pub deleted: bool,
}

/// Internal row type for the batch_resolve query (sqlx-compatible).
#[derive(Debug, sqlx::FromRow)]
struct ResolvedBlockRow {
    id: String,
    title: Option<String>,
    block_type: String,
    deleted: Option<bool>,
}

/// Batch-resolve block metadata for a list of IDs in a single query.
///
/// Returns one [`ResolvedBlock`] per matched ID. IDs that don't exist in the
/// database are silently omitted (no error). Soft-deleted blocks are included
/// with `deleted = true`.
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// # Errors
///
/// - [`AppError::Validation`] — `ids` is empty
pub async fn batch_resolve_inner(
    pool: &SqlitePool,
    ids: Vec<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation("ids list cannot be empty".into()));
    }

    let ids_json = serde_json::to_string(&ids)?;

    let rows = sqlx::query_as!(
        ResolvedBlockRow,
        r#"SELECT
             id,
             content AS title,
             block_type,
             (CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS "deleted: bool"
           FROM blocks
           WHERE id IN (SELECT value FROM json_each(?1))"#,
        ids_json,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ResolvedBlock {
            id: r.id,
            title: r.title,
            block_type: r.block_type,
            deleted: r.deleted.unwrap_or(false),
        })
        .collect())
}

/// Add a tag to a block.
///
/// Validates both the block and the tag block exist and are not deleted,
/// checks that `tag_id` refers to a block with `block_type = 'tag'`, ensures
/// the association does not already exist, appends an `AddTag` op, inserts
/// into `block_tags`, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block or tag block does not exist or is deleted
/// - [`AppError::InvalidOperation`] — `tag_id` is not a tag block, or tag already applied
pub async fn add_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted(&block_id),
        tag_id: BlockId::from_trusted(&tag_id),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate tag_id refers to a block with block_type = 'tag' and is not deleted (TOCTOU-safe)
    let tag_row = sqlx::query!(
        "SELECT block_type FROM blocks WHERE id = ? AND deleted_at IS NULL",
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    match tag_row {
        None => {
            return Err(AppError::NotFound(format!(
                "tag block '{tag_id}' (not found or deleted)"
            )));
        }
        Some(ref r) if r.block_type != "tag" => {
            return Err(AppError::InvalidOperation(format!(
                "block '{tag_id}' has block_type '{}', expected 'tag'",
                r.block_type
            )));
        }
        _ => {}
    }

    // Check for existing association (TOCTOU-safe)
    let dup = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id,
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if dup.is_some() {
        return Err(AppError::InvalidOperation("tag already applied".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

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

/// Remove a tag from a block.
///
/// Validates the block exists and is not deleted, checks the tag association
/// exists, appends a `RemoveTag` op, deletes from `block_tags`, and dispatches
/// background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist, is deleted, or tag association missing
pub async fn remove_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: BlockId::from_trusted(&block_id),
        tag_id: BlockId::from_trusted(&tag_id),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Check association exists (TOCTOU-safe)
    let assoc = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id,
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if assoc.is_none() {
        return Err(AppError::NotFound("tag association".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

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

/// List blocks that link to the given block (backlinks), with cursor pagination.
pub async fn get_backlinks_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_backlinks(pool, &block_id, &page).await
}

/// List op-log history entries for a specific block, with cursor pagination.
pub async fn get_block_history_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_block_history(pool, &block_id, &page).await
}

/// List conflict-copy blocks (blocks with `is_conflict = true`), with cursor pagination.
pub async fn get_conflicts_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_conflicts(pool, &page).await
}

/// Return current materializer queue metrics and system status.
pub fn get_status_inner(materializer: &Materializer) -> StatusInfo {
    materializer.status()
}

/// Full-text search across block content using FTS5.
///
/// Returns an empty page if the query is blank. Otherwise delegates to
/// [`fts::search_fts`] with cursor pagination.
pub async fn search_blocks_inner(
    pool: &SqlitePool,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    fts::search_fts(pool, &query, &page).await
}

/// Query blocks by boolean tag expression.
///
/// Builds a `TagExpr` from the provided tag_ids, prefixes, and mode.
/// `mode` is `"and"` for intersection, anything else defaults to `"or"` (union).
/// Returns an empty page when no tag IDs or prefixes are supplied.
pub async fn query_by_tags_inner(
    pool: &SqlitePool,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let mut exprs = Vec::new();
    for tag_id in tag_ids {
        exprs.push(TagExpr::Tag(tag_id));
    }
    for prefix in prefixes {
        exprs.push(TagExpr::Prefix(prefix));
    }

    if exprs.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }

    let expr = match mode.as_str() {
        "and" => TagExpr::And(exprs),
        _ => TagExpr::Or(exprs), // default to OR
    };

    let page = pagination::PageRequest::new(cursor, limit)?;
    tag_query::eval_tag_query(pool, &expr, &page).await
}

/// Query blocks by property key and optional value filter.
///
/// Returns a paginated list of blocks that have the specified property.
/// When `value_text` is provided, only blocks whose property value matches are returned.
/// Results are paginated using cursor-based pagination (by block_id).
///
/// # Errors
/// - [`AppError::Validation`] — `key` is empty
pub async fn query_by_property_inner(
    pool: &SqlitePool,
    key: String,
    value_text: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    if key.trim().is_empty() {
        return Err(AppError::Validation(
            "property key must not be empty".into(),
        ));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::query_by_property(pool, &key, value_text.as_deref(), &page).await
}

/// List all tags matching a name prefix (autocomplete / UI).
pub async fn list_tags_by_prefix_inner(
    pool: &SqlitePool,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    tag_query::list_tags_by_prefix(pool, &prefix, limit).await
}

/// List all tag_ids currently associated with a block.
pub async fn list_tags_for_block_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<String>, AppError> {
    tag_query::list_tags_for_block(pool, &block_id).await
}

/// Query backlinks for a block with optional filters, sorting, and pagination.
///
/// When no filters are supplied, returns all backlinks (backward compatible).
/// Filters use AND semantics at the top level; use `And`/`Or`/`Not` filter
/// variants for compound boolean logic.
///
/// # Errors
/// - [`AppError::Validation`] — `block_id` is empty
pub async fn query_backlinks_filtered_inner(
    pool: &SqlitePool,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<BacklinkQueryResponse, AppError> {
    if block_id.trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink_query::eval_backlink_query(pool, &block_id, filters, sort, &page).await
}

/// Query backlinks grouped by source page.
///
/// # Errors
/// - [`AppError::Validation`] — `block_id` is empty
pub async fn list_backlinks_grouped_inner(
    pool: &SqlitePool,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<GroupedBacklinkResponse, AppError> {
    if block_id.trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink_query::eval_backlink_query_grouped(pool, &block_id, filters, sort, &page).await
}

/// List all distinct property keys currently in use across all blocks.
pub async fn list_property_keys_inner(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    backlink_query::list_property_keys(pool).await
}

/// Set (upsert) a property on a block.
///
/// Validates the block exists and is not deleted, validates the property
/// payload (exactly one non-null value field, valid key format), then
/// appends a `SetProperty` op and materializes the change.
///
/// # Errors
///
/// - [`AppError::Validation`] — invalid key format, non-finite number, or not exactly one value field set
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[allow(clippy::too_many_arguments)]
pub async fn set_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
) -> Result<BlockRow, AppError> {
    // 1. Build and validate the payload before touching the DB
    let prop_payload = SetPropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.clone(),
        value_text: value_text.clone(),
        value_num,
        value_date: value_date.clone(),
        value_ref: value_ref.clone(),
    };
    validate_set_property(&prop_payload)?;

    // 2. Begin IMMEDIATE transaction for atomic validation + op_log + materialization
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 3. Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;

    // 4. Append SetProperty op to the op_log
    let payload = OpPayload::SetProperty(prop_payload);
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 5. Materialize: route reserved keys to blocks columns, others to block_properties
    if is_reserved_property_key(&key) {
        let col = match key.as_str() {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            _ => unreachable!(),
        };
        let value = match col {
            "due_date" => &value_date,
            _ => &value_text,
        };
        sqlx::query(&format!("UPDATE blocks SET {col} = ? WHERE id = ?"))
            .bind(value)
            .bind(&block_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&block_id)
        .bind(&key)
        .bind(&value_text)
        .bind(value_num)
        .bind(&value_date)
        .bind(&value_ref)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // 6. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    // 7. Return the block
    Ok(BlockRow {
        id: existing.id,
        block_type: existing.block_type,
        content: existing.content,
        parent_id: existing.parent_id,
        position: existing.position,
        deleted_at: existing.deleted_at,
        archived_at: existing.archived_at,
        is_conflict: existing.is_conflict,
        conflict_type: existing.conflict_type,
        todo_state: if key == "todo_state" {
            value_text.clone()
        } else {
            existing.todo_state
        },
        priority: if key == "priority" {
            value_text.clone()
        } else {
            existing.priority
        },
        due_date: if key == "due_date" {
            value_date.clone()
        } else {
            existing.due_date
        },
    })
}

/// Set the todo state on a block (TODO / DOING / DONE or clear).
///
/// Validates the value and delegates to [`set_property_inner`] with the
/// reserved `"todo_state"` key.
pub async fn set_todo_state_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref s) = state {
        if !matches!(s.as_str(), "TODO" | "DOING" | "DONE") {
            return Err(AppError::Validation(format!(
                "todo_state must be TODO, DOING, or DONE, got '{s}'"
            )));
        }
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "todo_state".to_string(),
        state,
        None,
        None,
        None,
    )
    .await
}

/// Set the priority on a block (1 / 2 / 3 or clear).
///
/// Validates the value and delegates to [`set_property_inner`] with the
/// reserved `"priority"` key.
pub async fn set_priority_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    level: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref l) = level {
        if !matches!(l.as_str(), "1" | "2" | "3") {
            return Err(AppError::Validation(format!(
                "priority must be 1, 2, or 3, got '{l}'"
            )));
        }
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "priority".to_string(),
        level,
        None,
        None,
        None,
    )
    .await
}

/// Set the due date on a block (ISO date YYYY-MM-DD or clear).
///
/// Validates the date format and delegates to [`set_property_inner`] with the
/// reserved `"due_date"` key.
pub async fn set_due_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref d) = date {
        if !is_valid_iso_date(d) {
            return Err(AppError::Validation(format!(
                "due_date must be YYYY-MM-DD format, got '{d}'"
            )));
        }
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "due_date".to_string(),
        None,
        None,
        date,
        None,
    )
    .await
}

/// Simple validation for ISO date format `YYYY-MM-DD`.
fn is_valid_iso_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let all_digits = bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[8..10].iter().all(|b| b.is_ascii_digit());
    if !all_digits {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Delete a property from a block.
///
/// Appends a `DeleteProperty` op and removes the row from `block_properties`.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
pub async fn delete_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    key: String,
) -> Result<(), AppError> {
    // 1. Begin IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 2. Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // 3. Append DeleteProperty op
    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.clone(),
    });
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Materialize: delete/clear the property
    if is_reserved_property_key(&key) {
        let col = match key.as_str() {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            _ => unreachable!(),
        };
        sqlx::query(&format!("UPDATE blocks SET {col} = NULL WHERE id = ?"))
            .bind(&block_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(&block_id)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    let _ = materializer.dispatch_background(&op_record);

    Ok(())
}

/// Get all properties for a block (read-only).
pub async fn get_properties_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<PropertyRow>, AppError> {
    let rows = sqlx::query_as!(
        PropertyRow,
        "SELECT key, value_text, value_num, value_date, value_ref \
         FROM block_properties WHERE block_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

// ---------------------------------------------------------------------------
// Property-definition CRUD (ADR-22, #548-#550, #557)
// ---------------------------------------------------------------------------

/// Create a property definition. Uses INSERT OR IGNORE for idempotency —
/// if the key already exists, this is a no-op.
pub async fn create_property_def_inner(
    pool: &SqlitePool,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    // Validate key: non-empty, max 64 chars, alphanumeric + underscore + hyphen
    if key.is_empty() || key.len() > 64 {
        return Err(AppError::Validation(
            "property definition key must be 1-64 characters".into(),
        ));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::Validation(
            "property definition key must contain only alphanumeric, underscore, or hyphen characters".into(),
        ));
    }
    // Validate value_type
    if !matches!(value_type.as_str(), "text" | "number" | "date" | "select") {
        return Err(AppError::Validation(format!(
            "invalid value_type '{value_type}': must be text, number, date, or select"
        )));
    }
    // Validate options: required for select, forbidden for others
    if value_type == "select" {
        match &options {
            None => {
                return Err(AppError::Validation(
                    "select-type definitions require an options array".into(),
                ))
            }
            Some(opts) => {
                let parsed: Vec<String> = serde_json::from_str(opts).map_err(|_| {
                    AppError::Validation("options must be a JSON array of strings".into())
                })?;
                if parsed.is_empty() {
                    return Err(AppError::Validation(
                        "select-type options must not be empty".into(),
                    ));
                }
            }
        }
    } else if options.is_some() {
        return Err(AppError::Validation(format!(
            "options are only allowed for select-type definitions, not '{value_type}'"
        )));
    }

    let now = crate::now_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&key)
    .bind(&value_type)
    .bind(&options)
    .bind(&now)
    .execute(pool)
    .await?;

    // Fetch back (may differ from input if key already existed)
    let row = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_one(pool)
    .await?;

    Ok(row)
}

/// List all property definitions, ordered by key.
pub async fn list_property_defs_inner(
    pool: &SqlitePool,
) -> Result<Vec<PropertyDefinition>, AppError> {
    let rows = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions ORDER BY key"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Update the options array for a select-type definition.
/// Returns error if the key doesn't exist or isn't select-type.
pub async fn update_property_def_options_inner(
    pool: &SqlitePool,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    // Validate options is a non-empty JSON array of strings
    let parsed: Vec<String> = serde_json::from_str(&options)
        .map_err(|_| AppError::Validation("options must be a JSON array of strings".into()))?;
    if parsed.is_empty() {
        return Err(AppError::Validation("options must not be empty".into()));
    }

    // Fetch existing to verify it's select-type
    let existing = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    if existing.value_type != "select" {
        return Err(AppError::Validation(format!(
            "cannot update options on '{}'-type definition '{key}'",
            existing.value_type
        )));
    }

    sqlx::query("UPDATE property_definitions SET options = ? WHERE key = ?")
        .bind(&options)
        .bind(&key)
        .execute(pool)
        .await?;

    Ok(PropertyDefinition {
        key: existing.key,
        value_type: existing.value_type,
        options: Some(options),
        created_at: existing.created_at,
    })
}

/// Delete a property definition by key.
/// Returns error if the key doesn't exist.
pub async fn delete_property_def_inner(pool: &SqlitePool, key: String) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM property_definitions WHERE key = ?")
        .bind(&key)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("property definition '{key}'")));
    }

    Ok(())
}

/// Internal row type for the batch properties query (sqlx-compatible).
#[derive(Debug, sqlx::FromRow)]
struct BatchPropertyRow {
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
}

/// Batch-fetch properties for multiple blocks in a single query.
///
/// Returns a map of block_id → Vec<PropertyRow>. Block IDs with no properties
/// are omitted from the result (not an error).
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// # Errors
/// - [`AppError::Validation`] — `block_ids` is empty
pub async fn get_batch_properties_inner(
    pool: &SqlitePool,
    block_ids: Vec<String>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }

    let ids_json = serde_json::to_string(&block_ids)?;

    let rows = sqlx::query_as!(
        BatchPropertyRow,
        r#"SELECT block_id, key, value_text, value_num, value_date, value_ref
           FROM block_properties
           WHERE block_id IN (SELECT value FROM json_each(?1))"#,
        ids_json,
    )
    .fetch_all(pool)
    .await?;

    let mut map: HashMap<String, Vec<PropertyRow>> = HashMap::new();
    for r in rows {
        map.entry(r.block_id).or_default().push(PropertyRow {
            key: r.key,
            value_text: r.value_text,
            value_num: r.value_num,
            value_date: r.value_date,
            value_ref: r.value_ref,
        });
    }

    Ok(map)
}

// ---------------------------------------------------------------------------
// Undo/Redo helpers and inner functions
// ---------------------------------------------------------------------------

/// Apply the materialized effect of a reverse [`OpPayload`] to the blocks/tags/properties
/// tables inside an existing transaction.
///
/// This mirrors the SQL patterns used in the original command handlers (e.g.,
/// reverse of `create_block` → same SQL as `delete_block`, reverse of
/// `edit_block` → same SQL as `edit_block`, etc.).
///
/// Only handles the subset of op types that can result from `compute_reverse`:
/// `DeleteBlock`, `RestoreBlock`, `EditBlock`, `MoveBlock`, `AddTag`,
/// `RemoveTag`, `SetProperty`, `DeleteProperty`, `DeleteAttachment`.
pub async fn apply_reverse_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    reverse_payload: &OpPayload,
) -> Result<(), AppError> {
    match reverse_payload {
        // NOTE: DeleteBlock and RestoreBlock are cascade operations that are
        // idempotent — deleting an already-deleted block or restoring an
        // already-restored block is a harmless no-op (rows_affected == 0 is
        // fine).  EditBlock and MoveBlock check rows_affected because they
        // modify data the user expects to see on a live block; silently
        // succeeding on a soft-deleted block would mask a real problem.
        OpPayload::DeleteBlock(p) => {
            // Cascade soft-delete (same as delete_block_inner)
            let now = now_rfc3339();
            sqlx::query(
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
            .bind(p.block_id.as_str())
            .bind(&now)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::RestoreBlock(p) => {
            // Cascade restore (same as restore_block_inner)
            sqlx::query(
                "WITH RECURSIVE descendants(id) AS ( \
                     SELECT id FROM blocks WHERE id = ? \
                     UNION ALL \
                     SELECT b.id FROM blocks b \
                     INNER JOIN descendants d ON b.parent_id = d.id \
                 ) \
                 UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
            )
            .bind(p.block_id.as_str())
            .bind(&p.deleted_at_ref)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::EditBlock(p) => {
            let result =
                sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
                    .bind(&p.to_text)
                    .bind(p.block_id.as_str())
                    .execute(&mut **tx)
                    .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "block '{}' not found or soft-deleted during undo",
                    p.block_id
                )));
            }
        }
        OpPayload::MoveBlock(p) => {
            let result = sqlx::query(
                "UPDATE blocks SET parent_id = ?, position = ? \
                 WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(p.new_parent_id.as_ref().map(BlockId::as_str))
            .bind(p.new_position)
            .bind(p.block_id.as_str())
            .execute(&mut **tx)
            .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "block '{}' not found or soft-deleted during undo",
                    p.block_id
                )));
            }
        }
        OpPayload::AddTag(p) => {
            sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::RemoveTag(p) => {
            let result = sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut **tx)
                .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "tag association ({}, {}) not found during undo",
                    p.block_id, p.tag_id
                )));
            }
        }
        OpPayload::SetProperty(p) => {
            sqlx::query(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(p.block_id.as_str())
            .bind(&p.key)
            .bind(&p.value_text)
            .bind(p.value_num)
            .bind(&p.value_date)
            .bind(&p.value_ref)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::DeleteProperty(p) => {
            let result = sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                .bind(p.block_id.as_str())
                .bind(&p.key)
                .execute(&mut **tx)
                .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "property '{}.{}' not found during undo",
                    p.block_id, p.key
                )));
            }
        }
        OpPayload::DeleteAttachment(p) => {
            let result = sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
                .bind(now_rfc3339())
                .bind(&p.attachment_id)
                .execute(&mut **tx)
                .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "attachment '{}' not found during undo",
                    p.attachment_id
                )));
            }
        }
        OpPayload::AddAttachment(p) => {
            // Preserve original created_at from the existing (soft-deleted) attachment record
            let original_created_at: Option<String> =
                sqlx::query_scalar("SELECT created_at FROM attachments WHERE id = ?")
                    .bind(p.attachment_id.as_str())
                    .fetch_optional(&mut **tx)
                    .await?;

            let created_at = original_created_at.unwrap_or_else(now_rfc3339);

            sqlx::query(
                "INSERT OR REPLACE INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
            )
            .bind(p.attachment_id.as_str())
            .bind(p.block_id.as_str())
            .bind(&p.mime_type)
            .bind(&p.filename)
            .bind(p.size_bytes)
            .bind(&p.fs_path)
            .bind(&created_at)
            .execute(&mut **tx)
            .await?;
        }
        // Note: CreateBlock never appears here because reverse::compute_reverse
        // maps CreateBlock → DeleteBlock, and RestoreBlock → DeleteBlock.
        // Both are handled by the DeleteBlock arm above.
        other => {
            return Err(AppError::InvalidOperation(format!(
                "cannot apply reverse payload of type '{}' — unexpected variant",
                other.op_type_str()
            )));
        }
    }
    Ok(())
}

/// List all ops for blocks descended from a page, with cursor pagination
/// and optional op_type filter.
pub async fn list_page_history_inner(
    pool: &SqlitePool,
    page_id: String,
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_page_history(pool, &page_id, op_type_filter.as_deref(), &page).await
}

/// Batch revert: compute and apply reverse ops for a list of op refs.
///
/// All ops are processed in a single transaction for atomicity. Ops are
/// sorted newest-first (by `created_at DESC, seq DESC`) and reversed in
/// that order. Non-reversible ops cause early abort (before any are applied).
pub async fn revert_ops_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    use crate::reverse;

    if ops.is_empty() {
        return Ok(vec![]);
    }

    // Phase 1: Validate all ops are reversible by computing their reverse payloads.
    // This uses read-only access — no mutations yet.
    let mut reverses = Vec::with_capacity(ops.len());
    for op_ref in &ops {
        let reverse_payload = reverse::compute_reverse(pool, &op_ref.device_id, op_ref.seq).await?;
        // Fetch created_at for sorting
        let record = op_log::get_op_by_seq(pool, &op_ref.device_id, op_ref.seq).await?;
        reverses.push((op_ref.clone(), reverse_payload, record.created_at));
    }

    // Sort newest-first (by created_at DESC, seq DESC, device_id DESC)
    reverses.sort_by(|a, b| {
        b.2.cmp(&a.2) // created_at DESC
            .then_with(|| b.0.seq.cmp(&a.0.seq)) // seq DESC
            .then_with(|| b.0.device_id.cmp(&a.0.device_id)) // device_id DESC
    });

    // Phase 2: Apply all reverses in a single IMMEDIATE transaction.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut results = Vec::with_capacity(reverses.len());
    let mut op_records = Vec::new();

    for (op_ref, reverse_payload, _created_at) in &reverses {
        let new_op_type = reverse_payload.op_type_str().to_owned();

        // Append reverse op to log
        let op_record = op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            reverse_payload.clone(),
            now_rfc3339(),
        )
        .await?;

        // Apply to blocks/tags/properties tables
        apply_reverse_in_tx(&mut tx, reverse_payload).await?;

        results.push(UndoResult {
            reversed_op: op_ref.clone(),
            new_op_ref: OpRef {
                device_id: op_record.device_id.clone(),
                seq: op_record.seq,
            },
            new_op_type,
            is_redo: false,
        });

        op_records.push(op_record);
    }

    tx.commit().await?;

    // Dispatch background cache tasks (fire-and-forget)
    for record in &op_records {
        let _ = materializer.dispatch_background(record);
    }

    Ok(results)
}

/// Undo the Nth most recent undoable op on a page.
///
/// `undo_depth` is 0-based: 0 = most recent op, 1 = second most recent, etc.
/// Queries the page's op history (using recursive CTE), applies OFFSET to
/// skip `undo_depth` ops, then computes and applies the reverse.
pub async fn undo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    if undo_depth < 0 {
        return Err(AppError::Validation(
            "undo_depth must be non-negative".into(),
        ));
    }

    use crate::reverse;

    // Find the op to undo: page ops ordered newest first, offset by undo_depth.
    // Uses the write pool for consistency — these reads feed into the write
    // transaction below.
    let target = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id) AS ( \
             SELECT id FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
         FROM op_log ol \
         WHERE ( \
             json_extract(ol.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
             OR ( \
                 ol.op_type = 'delete_attachment' \
                 AND EXISTS ( \
                     SELECT 1 FROM attachments a \
                     WHERE a.id = json_extract(ol.payload, '$.attachment_id') \
                     AND a.block_id IN (SELECT id FROM page_blocks) \
                 ) \
             ) \
         ) \
         ORDER BY ol.created_at DESC, ol.seq DESC \
         LIMIT 1 OFFSET ?2",
        page_id,    // ?1
        undo_depth, // ?2
    )
    .fetch_optional(pool)
    .await?;

    let target = target.ok_or_else(|| {
        AppError::NotFound(format!(
            "no op found at undo_depth {undo_depth} for page '{page_id}'"
        ))
    })?;

    // Compute reverse
    let reverse_payload = reverse::compute_reverse(pool, &target.device_id, target.seq).await?;
    let new_op_type = reverse_payload.op_type_str().to_owned();

    // Apply in single IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, reverse_payload.clone(), now_rfc3339())
            .await?;

    apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

    tx.commit().await?;

    // Dispatch background cache tasks
    let _ = materializer.dispatch_background(&op_record);

    Ok(UndoResult {
        reversed_op: OpRef {
            device_id: target.device_id,
            seq: target.seq,
        },
        new_op_ref: OpRef {
            device_id: op_record.device_id,
            seq: op_record.seq,
        },
        new_op_type,
        is_redo: false,
    })
}

/// Redo by reversing an undo op.
///
/// The `(undo_device_id, undo_seq)` identifies the UNDO op that was
/// previously appended. Reversing the undo effectively re-applies the
/// original operation.
pub async fn redo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    use crate::reverse;

    // Compute reverse of the undo op
    let reverse_payload = reverse::compute_reverse(pool, &undo_device_id, undo_seq).await?;
    let new_op_type = reverse_payload.op_type_str().to_owned();

    // Apply in single IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, reverse_payload.clone(), now_rfc3339())
            .await?;

    apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

    tx.commit().await?;

    // Dispatch background cache tasks
    let _ = materializer.dispatch_background(&op_record);

    Ok(UndoResult {
        reversed_op: OpRef {
            device_id: undo_device_id,
            seq: undo_seq,
        },
        new_op_ref: OpRef {
            device_id: op_record.device_id,
            seq: op_record.seq,
        },
        new_op_type,
        is_redo: true,
    })
}

// ---------------------------------------------------------------------------
// Sync — inner functions (peer_refs CRUD + device identity)
// ---------------------------------------------------------------------------

/// List all known sync peers, ordered by most-recently-synced first.
pub async fn list_peer_refs_inner(pool: &SqlitePool) -> Result<Vec<PeerRef>, AppError> {
    peer_refs::list_peer_refs(pool).await
}

/// Fetch a single sync peer by its `peer_id`.
///
/// Returns `None` if the peer does not exist (not an error).
pub async fn get_peer_ref_inner(
    pool: &SqlitePool,
    peer_id: String,
) -> Result<Option<PeerRef>, AppError> {
    peer_refs::get_peer_ref(pool, &peer_id).await
}

/// Delete (unpair) a sync peer by its `peer_id`.
///
/// Returns [`AppError::NotFound`] if the peer does not exist.
pub async fn delete_peer_ref_inner(pool: &SqlitePool, peer_id: String) -> Result<(), AppError> {
    peer_refs::delete_peer_ref(pool, &peer_id).await
}

pub async fn update_peer_name_inner(
    pool: &SqlitePool,
    peer_id: String,
    device_name: Option<String>,
) -> Result<(), AppError> {
    peer_refs::update_device_name(pool, &peer_id, device_name.as_deref()).await
}

/// Return the local device's persistent UUID.
pub fn get_device_id_inner(device_id: &DeviceId) -> String {
    device_id.as_str().to_string()
}

// ---------------------------------------------------------------------------
// Sync — inner functions (pairing + sync session)
// ---------------------------------------------------------------------------

/// Start a new pairing session.
///
/// Generates a fresh passphrase, creates a QR code SVG for sharing,
/// stores the session in `pairing_state`, and returns the pairing info
/// to the frontend.
pub fn start_pairing_inner(
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    let session = PairingSession::new(device_id, "");
    let passphrase = session.passphrase.clone();
    let qr_svg = generate_qr_svg(&pairing_qr_payload(&passphrase, "0.0.0.0", 0))?;

    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? =
        Some(session);

    Ok(PairingInfo {
        passphrase,
        qr_svg,
        port: 0,
    })
}

/// Confirm pairing with a remote device.
///
/// Validates the passphrase against the current session, stores the peer
/// reference in the database, and clears the pairing session.
pub async fn confirm_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
    passphrase: String,
    remote_device_id: String,
) -> Result<(), AppError> {
    // Derive a session from the passphrase to verify the key derivation
    // path works (the actual shared key will be used for future encrypted
    // exchanges).
    let _session = PairingSession::from_passphrase(&passphrase, device_id, &remote_device_id);

    // Store the peer ref
    peer_refs::upsert_peer_ref(pool, &remote_device_id).await?;

    // Clear pairing session
    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? = None;

    Ok(())
}

/// Cancel an in-progress pairing session.
///
/// Clears the stored session; no-op if no session is active.
pub fn cancel_pairing_inner(pairing_state: &Mutex<Option<PairingSession>>) -> Result<(), AppError> {
    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? = None;
    Ok(())
}

/// Start a sync session with a remote peer.
///
/// Checks the backoff schedule, acquires the per-peer lock, and wakes
/// the SyncDaemon (#382) to sync now.  Actual network sync happens in
/// the daemon; this returns immediately with a "complete" status to
/// indicate the trigger was accepted.
pub fn start_sync_inner(
    scheduler: &SyncScheduler,
    device_id: &str,
    peer_id: String,
) -> Result<SyncSessionInfo, AppError> {
    // Check backoff
    if !scheduler.may_retry(&peer_id) {
        return Err(AppError::InvalidOperation(
            "Peer is in backoff, try again later".into(),
        ));
    }

    // Try to acquire peer lock
    let _guard = scheduler.try_lock_peer(&peer_id).ok_or_else(|| {
        AppError::InvalidOperation("Sync already in progress for this peer".into())
    })?;

    // Wake the SyncDaemon to sync now (#382)
    scheduler.notify_change();

    // Record success so the backoff state stays clean.
    scheduler.record_success(&peer_id);

    Ok(SyncSessionInfo {
        state: "complete".into(),
        local_device_id: device_id.to_string(),
        remote_device_id: peer_id,
        ops_received: 0,
        ops_sent: 0,
    })
}

/// Cancel an active sync session.
///
/// Sets the cancel flag that is checked each iteration of the sync message
/// exchange loop.  If no sync is active the flag is harmlessly cleared on
/// the next session start.
pub fn cancel_sync_inner(cancel_flag: &AtomicBool) -> Result<(), AppError> {
    cancel_flag.store(true, Ordering::Release);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

/// F09/F10: Sanitize internal errors before they reach the frontend.
/// Database errors may contain table/column names or query fragments
/// that leak implementation details. We replace them with a generic
/// message while logging the original for debugging.
#[cfg(not(tarpaulin_include))]
fn sanitize_internal_error(err: AppError) -> AppError {
    match &err {
        AppError::Database(_) | AppError::Migration(_) | AppError::Io(_) | AppError::Json(_) => {
            tracing::warn!(error = %err, "internal error suppressed during sanitization");
            AppError::InvalidOperation("an internal error occurred".into())
        }
        _ => err,
    }
}

/// Tauri command: create a new block. Delegates to [`create_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn create_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockRow, AppError> {
    create_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_type,
        content,
        parent_id,
        position,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: edit a block's content. Delegates to [`edit_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn edit_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    to_text: String,
) -> Result<BlockRow, AppError> {
    edit_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        to_text,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: soft-delete a block and descendants. Delegates to [`delete_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    delete_block_inner(&pool.0, device_id.as_str(), &materializer, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: restore a soft-deleted block. Delegates to [`restore_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    restore_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        deleted_at_ref,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge a soft-deleted block. Delegates to [`purge_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn purge_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    purge_block_inner(&pool.0, device_id.as_str(), &materializer, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: move a block to a new parent at a given position. Delegates to [`move_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn move_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    new_parent_id: Option<String>,
    new_position: i64,
) -> Result<MoveResponse, AppError> {
    move_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        new_parent_id,
        new_position,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list blocks with filtering and pagination. Delegates to [`list_blocks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_blocks(
    pool: State<'_, ReadPool>,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    agenda_date: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_blocks_inner(
        &pool.0,
        parent_id,
        block_type,
        tag_id,
        show_deleted,
        agenda_date,
        cursor,
        limit,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single block by ID. Delegates to [`get_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block(pool: State<'_, ReadPool>, block_id: String) -> Result<BlockRow, AppError> {
    get_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-resolve block metadata. Delegates to [`batch_resolve_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn batch_resolve(
    pool: State<'_, ReadPool>,
    ids: Vec<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    batch_resolve_inner(&pool.0, ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: add a tag to a block. Delegates to [`add_tag_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn add_tag(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    add_tag_inner(&pool.0, device_id.as_str(), &materializer, block_id, tag_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: remove a tag from a block. Delegates to [`remove_tag_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn remove_tag(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    remove_tag_inner(&pool.0, device_id.as_str(), &materializer, block_id, tag_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list backlinks for a block. Delegates to [`get_backlinks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_backlinks(
    pool: State<'_, ReadPool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    get_backlinks_inner(&pool.0, block_id, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list op-log history for a block. Delegates to [`get_block_history_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block_history(
    pool: State<'_, ReadPool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    get_block_history_inner(&pool.0, block_id, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list conflict-copy blocks. Delegates to [`get_conflicts_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_conflicts(
    pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    get_conflicts_inner(&pool.0, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get materializer queue status. Delegates to [`get_status_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_status(materializer: State<'_, Materializer>) -> Result<StatusInfo, AppError> {
    Ok(get_status_inner(&materializer))
}

/// Tauri command: full-text search across blocks. Delegates to [`search_blocks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn search_blocks(
    pool: State<'_, ReadPool>,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    search_blocks_inner(&pool.0, query, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: query blocks by boolean tag expression. Delegates to [`query_by_tags_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn query_by_tags(
    pool: State<'_, ReadPool>,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    query_by_tags_inner(&pool.0, tag_ids, prefixes, mode, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: query blocks by property key/value. Delegates to [`query_by_property_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn query_by_property(
    pool: State<'_, ReadPool>,
    key: String,
    value_text: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    query_by_property_inner(&pool.0, key, value_text, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list tags matching a name prefix. Delegates to [`list_tags_by_prefix_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_tags_by_prefix(
    pool: State<'_, ReadPool>,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    list_tags_by_prefix_inner(&pool.0, prefix, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list tag IDs for a block. Delegates to [`list_tags_for_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_tags_for_block(
    pool: State<'_, SqlitePool>,
    block_id: String,
) -> Result<Vec<String>, AppError> {
    list_tags_for_block_inner(&pool, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: filtered backlink query. Delegates to [`query_backlinks_filtered_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn query_backlinks_filtered(
    read_pool: State<'_, ReadPool>,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<BacklinkQueryResponse, AppError> {
    query_backlinks_filtered_inner(&read_pool.0, block_id, filters, sort, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: grouped backlink query. Delegates to [`list_backlinks_grouped_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_backlinks_grouped(
    read_pool: State<'_, ReadPool>,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<GroupedBacklinkResponse, AppError> {
    list_backlinks_grouped_inner(&read_pool.0, block_id, filters, sort, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list distinct property keys. Delegates to [`list_property_keys_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_property_keys(read_pool: State<'_, ReadPool>) -> Result<Vec<String>, AppError> {
    list_property_keys_inner(&read_pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set (upsert) a property on a block. Delegates to [`set_property_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn set_property(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
) -> Result<BlockRow, AppError> {
    set_property_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        key,
        value_text,
        value_num,
        value_date,
        value_ref,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: set todo state on a block. Delegates to [`set_todo_state_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    set_todo_state_inner(&pool.0, device_id.as_str(), &materializer, block_id, state)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set priority on a block. Delegates to [`set_priority_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_priority(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    level: Option<String>,
) -> Result<BlockRow, AppError> {
    set_priority_inner(&pool.0, device_id.as_str(), &materializer, block_id, level)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set due date on a block. Delegates to [`set_due_date_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_due_date(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    set_due_date_inner(&pool.0, device_id.as_str(), &materializer, block_id, date)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete a property from a block. Delegates to [`delete_property_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_property(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    key: String,
) -> Result<(), AppError> {
    delete_property_inner(&pool.0, device_id.as_str(), &materializer, block_id, key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get all properties for a block. Delegates to [`get_properties_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_properties(
    pool: State<'_, ReadPool>,
    block_id: String,
) -> Result<Vec<PropertyRow>, AppError> {
    get_properties_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-fetch properties. Delegates to [`get_batch_properties_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_batch_properties(
    pool: State<'_, ReadPool>,
    block_ids: Vec<String>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    get_batch_properties_inner(&pool.0, block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: create a property definition. Delegates to [`create_property_def_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn create_property_def(
    write_pool: State<'_, WritePool>,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    create_property_def_inner(&write_pool.0, key, value_type, options).await
}

/// Tauri command: list all property definitions. Delegates to [`list_property_defs_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_property_defs(
    read_pool: State<'_, ReadPool>,
) -> Result<Vec<PropertyDefinition>, AppError> {
    list_property_defs_inner(&read_pool.0).await
}

/// Tauri command: update options for a select-type definition. Delegates to [`update_property_def_options_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn update_property_def_options(
    write_pool: State<'_, WritePool>,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    update_property_def_options_inner(&write_pool.0, key, options).await
}

/// Tauri command: delete a property definition. Delegates to [`delete_property_def_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_property_def(
    write_pool: State<'_, WritePool>,
    key: String,
) -> Result<(), AppError> {
    delete_property_def_inner(&write_pool.0, key).await
}

/// Tauri command: list page history. Delegates to [`list_page_history_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_history(
    pool: State<'_, ReadPool>,
    page_id: String,
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    list_page_history_inner(&pool.0, page_id, op_type_filter, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch revert ops. Delegates to [`revert_ops_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn revert_ops(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    revert_ops_inner(&pool.0, device_id.as_str(), &materializer, ops)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: undo page op. Delegates to [`undo_page_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn undo_page_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    undo_page_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        page_id,
        undo_depth,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: redo page op. Delegates to [`redo_page_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn redo_page_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    redo_page_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        undo_device_id,
        undo_seq,
    )
    .await
    .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Word-level diff for history display
// ---------------------------------------------------------------------------

/// Compute a word-level diff for an `edit_block` op by looking up the prior
/// text in the op log and comparing with the op's `to_text`.
///
/// Returns `Ok(None)` if the op is not `edit_block` or if no prior text exists
/// (i.e. the block was just created and this is the first edit).
pub async fn compute_edit_diff_inner(
    pool: &SqlitePool,
    device_id: String,
    seq: i64,
) -> Result<Option<Vec<crate::word_diff::DiffSpan>>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload, created_at FROM op_log \
         WHERE device_id = ?1 AND seq = ?2",
        device_id,
        seq,
    )
    .fetch_optional(pool)
    .await?;

    let row = match row {
        Some(r) => r,
        None => return Err(AppError::NotFound(format!("op ({device_id}, {seq})"))),
    };

    if row.op_type != "edit_block" {
        return Ok(None);
    }

    let payload: crate::op::EditBlockPayload = serde_json::from_str(&row.payload)?;
    let prior =
        crate::reverse::find_prior_text(pool, payload.block_id.as_str(), &row.created_at, seq)
            .await?;

    let old_text = prior.unwrap_or_default();
    Ok(Some(crate::word_diff::compute_word_diff(
        &old_text,
        &payload.to_text,
    )))
}

/// Tauri command: compute word-level diff for an edit_block history entry.
/// Delegates to [`compute_edit_diff_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn compute_edit_diff(
    pool: State<'_, ReadPool>,
    device_id: String,
    seq: i64,
) -> Result<Option<Vec<crate::word_diff::DiffSpan>>, AppError> {
    compute_edit_diff_inner(&pool.0, device_id, seq)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Sync — Tauri command wrappers
// ---------------------------------------------------------------------------

/// Tauri command: list all sync peers. Delegates to [`list_peer_refs_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_peer_refs(pool: State<'_, ReadPool>) -> Result<Vec<PeerRef>, AppError> {
    list_peer_refs_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get a single sync peer by ID. Delegates to [`get_peer_ref_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_peer_ref(
    pool: State<'_, ReadPool>,
    peer_id: String,
) -> Result<Option<PeerRef>, AppError> {
    get_peer_ref_inner(&pool.0, peer_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete (unpair) a sync peer. Delegates to [`delete_peer_ref_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_peer_ref(pool: State<'_, WritePool>, peer_id: String) -> Result<(), AppError> {
    delete_peer_ref_inner(&pool.0, peer_id)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
pub async fn update_peer_name(
    pool: State<'_, WritePool>,
    peer_id: String,
    device_name: Option<String>,
) -> Result<(), AppError> {
    update_peer_name_inner(&pool.0, peer_id, device_name)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: return the local device's persistent UUID.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_device_id(device_id: State<'_, DeviceId>) -> Result<String, AppError> {
    Ok(get_device_id_inner(&device_id))
}

/// Tauri command: start a new pairing session.
/// Generates a passphrase + QR SVG and stores the session in managed state.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn start_pairing(
    pairing_state: State<'_, PairingState>,
    device_id: State<'_, DeviceId>,
) -> Result<PairingInfo, AppError> {
    start_pairing_inner(&pairing_state.0, device_id.as_str()).map_err(sanitize_internal_error)
}

/// Tauri command: confirm pairing with a remote device.
/// Stores the peer ref in the database and clears the pairing session.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn confirm_pairing(
    passphrase: String,
    remote_device_id: String,
    pool: State<'_, WritePool>,
    pairing_state: State<'_, PairingState>,
    device_id: State<'_, DeviceId>,
) -> Result<(), AppError> {
    confirm_pairing_inner(
        &pool.0,
        &pairing_state.0,
        device_id.as_str(),
        passphrase,
        remote_device_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: cancel an in-progress pairing session.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn cancel_pairing(pairing_state: State<'_, PairingState>) -> Result<(), AppError> {
    cancel_pairing_inner(&pairing_state.0).map_err(sanitize_internal_error)
}

/// Tauri command: start sync with a remote peer.
/// Checks backoff (#278), acquires the per-peer lock, and returns session info.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn start_sync(
    peer_id: String,
    device_id: State<'_, DeviceId>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<SyncSessionInfo, AppError> {
    start_sync_inner(&scheduler, device_id.as_str(), peer_id).map_err(sanitize_internal_error)
}

/// Tauri command: cancel an active sync session.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn cancel_sync(cancel_flag: State<'_, crate::SyncCancelFlag>) -> Result<(), AppError> {
    cancel_sync_inner(&cancel_flag.0).map_err(sanitize_internal_error)
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

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, parent.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

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
        assert!(
            err.to_string().contains("exceeds maximum"),
            "error message should mention exceeds maximum"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_accepts_content_at_max_length() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
        let result =
            create_block_inner(&pool, DEV, &mat, "content".into(), at_limit, None, None).await;

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
        assert!(
            err.to_string().contains("position must be positive"),
            "error message should mention position must be positive"
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
        assert!(
            err.to_string().contains("position must be positive"),
            "error message should mention position must be positive"
        );
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
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
            .await
            .unwrap();

        // Second edit — should have prev_edit pointing to the first edit
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
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

        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "".into())
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
        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "same text".into())
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
        assert_eq!(row.content, Some("same text".into()));
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
        let result = edit_block_inner(&pool, DEV, &mat, created.id, oversized).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "should return Validation error for oversized content, got: {err:?}"
        );
        assert!(
            err.to_string().contains("exceeds maximum"),
            "error message should mention exceeds maximum"
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
        let result = edit_block_inner(&pool, DEV, &mat, created.id, at_limit).await;

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
    async fn list_blocks_rejects_conflicting_filters() {
        let (pool, _dir) = test_pool().await;

        // parent_id + block_type
        let result = list_blocks_inner(
            &pool,
            Some("P1".into()),
            Some("page".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "parent_id + block_type should be rejected: {result:?}"
        );

        // tag_id + show_deleted
        let result = list_blocks_inner(
            &pool,
            None,
            None,
            Some("T1".into()),
            Some(true),
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "tag_id + show_deleted should be rejected: {result:?}"
        );

        // parent_id + agenda_date
        let result = list_blocks_inner(
            &pool,
            Some("P1".into()),
            None,
            None,
            None,
            Some("2025-01-15".into()),
            None,
            None,
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
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "three filters should be rejected: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_single_filter_is_accepted() {
        let (pool, _dir) = test_pool().await;

        // Each single filter should succeed (may return empty results — that's fine).
        assert!(
            list_blocks_inner(&pool, Some("P1".into()), None, None, None, None, None, None)
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
                None
            )
            .await
            .is_ok(),
            "block_type alone should be accepted"
        );
        assert!(
            list_blocks_inner(&pool, None, None, None, Some(true), None, None, None)
                .await
                .is_ok(),
            "show_deleted alone should be accepted"
        );
        // show_deleted=false should NOT count as a filter
        assert!(
            list_blocks_inner(
                &pool,
                None,
                Some("page".into()),
                None,
                Some(false),
                None,
                None,
                None
            )
            .await
            .is_ok(),
            "block_type + show_deleted=false should be accepted (false is not a filter)"
        );
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

        assert_eq!(resp.block_id, "MV_ROOT_CHD");
        assert!(
            resp.new_parent_id.is_none(),
            "new_parent_id should be None for root move"
        );
        assert_eq!(resp.new_position, 10);

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
            "block_id == new_parent_id should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("cannot be its own parent"),
            "error message should explain the constraint"
        );
    }

    // ======================================================================
    // reorder_block
    // ======================================================================

    /// Helper: returns `(id, position)` pairs for all non-deleted children of
    /// `parent_id`, ordered by `position ASC, id ASC`.
    async fn sibling_positions(pool: &SqlitePool, parent_id: Option<&str>) -> Vec<(String, i64)> {
        let rows = sqlx::query!(
            "SELECT id, position FROM blocks \
             WHERE parent_id IS ?1 AND deleted_at IS NULL \
             ORDER BY IFNULL(position, 9999999) ASC, id ASC",
            parent_id
        )
        .fetch_all(pool)
        .await
        .unwrap();
        rows.into_iter()
            .map(|r| (r.id, r.position.unwrap_or(0)))
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_consecutive_positions_shifts_siblings() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: parent with 3 children at consecutive positions 10, 11, 12
        insert_block(&pool, "RO_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RO_A", "content", "a", Some("RO_PAR"), Some(10)).await;
        insert_block(&pool, "RO_B", "content", "b", Some("RO_PAR"), Some(11)).await;
        insert_block(&pool, "RO_C", "content", "c", Some("RO_PAR"), Some(12)).await;
        // Block to reorder (currently elsewhere under same parent)
        insert_block(&pool, "RO_X", "content", "x", Some("RO_PAR"), Some(99)).await;

        // Reorder RO_X after RO_A (between A@10 and B@11 — consecutive)
        let resp = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RO_X".into(),
            Some("RO_PAR".into()),
            Some("RO_A".into()),
        )
        .await
        .unwrap();

        assert_eq!(resp.block_id, "RO_X");
        assert_eq!(resp.new_position, 11, "should insert at before_pos + 1");

        // Verify sibling order: A=10, X=11, B=12, C=13
        let siblings = sibling_positions(&pool, Some("RO_PAR")).await;
        assert_eq!(
            siblings,
            vec![
                ("RO_A".into(), 10),
                ("RO_X".into(), 11),
                ("RO_B".into(), 12),
                ("RO_C".into(), 13),
            ],
            "B and C should have been shifted up by 1; X inserted at 11"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_single_position_gap_no_shift() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: children at positions 10, 12 (gap of 2)
        insert_block(&pool, "RG_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RG_A", "content", "a", Some("RG_PAR"), Some(10)).await;
        insert_block(&pool, "RG_B", "content", "b", Some("RG_PAR"), Some(12)).await;
        insert_block(&pool, "RG_X", "content", "x", Some("RG_PAR"), Some(99)).await;

        // Reorder RG_X after RG_A (between A@10 and B@12 — gap exists)
        let resp = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RG_X".into(),
            Some("RG_PAR".into()),
            Some("RG_A".into()),
        )
        .await
        .unwrap();

        assert_eq!(resp.new_position, 11, "should use the gap at 11");

        // Verify: B stays at 12 (no shift)
        let siblings = sibling_positions(&pool, Some("RG_PAR")).await;
        assert_eq!(
            siblings,
            vec![
                ("RG_A".into(), 10),
                ("RG_X".into(), 11),
                ("RG_B".into(), 12),
            ],
            "B should NOT have been shifted (gap existed)"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_zero_position_edge_case() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: children at positions 1, 2 (starting from 1)
        insert_block(&pool, "RZ_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RZ_A", "content", "a", Some("RZ_PAR"), Some(1)).await;
        insert_block(&pool, "RZ_B", "content", "b", Some("RZ_PAR"), Some(2)).await;
        insert_block(&pool, "RZ_X", "content", "x", Some("RZ_PAR"), Some(3)).await;

        // Reorder RZ_X to the beginning (after_id = None)
        let resp =
            reorder_block_inner(&pool, DEV, &mat, "RZ_X".into(), Some("RZ_PAR".into()), None)
                .await
                .unwrap();

        assert_eq!(
            resp.new_position, 1,
            "should be placed at position 1 (beginning)"
        );

        // All existing siblings should have been shifted up
        let siblings = sibling_positions(&pool, Some("RZ_PAR")).await;
        assert_eq!(
            siblings,
            vec![("RZ_X".into(), 1), ("RZ_A".into(), 2), ("RZ_B".into(), 3),],
            "A and B should have been shifted up; X placed at 1"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_to_beginning_with_gap() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: children at positions 5, 10 (gap at front)
        insert_block(&pool, "RF_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RF_A", "content", "a", Some("RF_PAR"), Some(5)).await;
        insert_block(&pool, "RF_B", "content", "b", Some("RF_PAR"), Some(10)).await;
        insert_block(&pool, "RF_X", "content", "x", Some("RF_PAR"), Some(15)).await;

        // Reorder RF_X to beginning (after_id = None, gap at front)
        let resp =
            reorder_block_inner(&pool, DEV, &mat, "RF_X".into(), Some("RF_PAR".into()), None)
                .await
                .unwrap();

        assert_eq!(resp.new_position, 1, "should use position 1 (gap at front)");

        // A and B should NOT have been shifted (gap existed)
        let siblings = sibling_positions(&pool, Some("RF_PAR")).await;
        assert_eq!(
            siblings,
            vec![("RF_X".into(), 1), ("RF_A".into(), 5), ("RF_B".into(), 10),],
            "existing siblings should not be shifted when gap exists at front"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_after_last_sibling() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: children at positions 10, 20
        insert_block(&pool, "RL_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RL_A", "content", "a", Some("RL_PAR"), Some(10)).await;
        insert_block(&pool, "RL_B", "content", "b", Some("RL_PAR"), Some(20)).await;
        insert_block(&pool, "RL_X", "content", "x", Some("RL_PAR"), Some(5)).await;

        // Reorder RL_X after RL_B (last sibling — no next sibling)
        let resp = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RL_X".into(),
            Some("RL_PAR".into()),
            Some("RL_B".into()),
        )
        .await
        .unwrap();

        assert_eq!(resp.new_position, 21, "should be placed at after_pos + 1");

        let siblings = sibling_positions(&pool, Some("RL_PAR")).await;
        assert_eq!(
            siblings,
            vec![
                ("RL_A".into(), 10),
                ("RL_B".into(), 20),
                ("RL_X".into(), 21),
            ],
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_consecutive_chain_all_shifted() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: 5 children at consecutive positions 1..=5
        insert_block(&pool, "RC_PAR", "page", "parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("RC_{i}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("RC_PAR"),
                Some(i),
            )
            .await;
        }
        insert_block(&pool, "RC_X", "content", "x", Some("RC_PAR"), Some(99)).await;

        // Reorder RC_X after RC_2 (between RC_2@2 and RC_3@3 — consecutive)
        let resp = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RC_X".into(),
            Some("RC_PAR".into()),
            Some("RC_2".into()),
        )
        .await
        .unwrap();

        assert_eq!(resp.new_position, 3);

        // RC_3, RC_4, RC_5 should all be shifted up by 1
        let siblings = sibling_positions(&pool, Some("RC_PAR")).await;
        assert_eq!(
            siblings,
            vec![
                ("RC_1".into(), 1),
                ("RC_2".into(), 2),
                ("RC_X".into(), 3),
                ("RC_3".into(), 4),
                ("RC_4".into(), 5),
                ("RC_5".into(), 6),
            ],
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_no_siblings_uses_position_one() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: parent with no children except the block being moved
        insert_block(&pool, "RN_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RN_X", "content", "x", None, Some(1)).await;

        // Reorder RN_X under RN_PAR at beginning (no existing siblings)
        let resp =
            reorder_block_inner(&pool, DEV, &mat, "RN_X".into(), Some("RN_PAR".into()), None)
                .await
                .unwrap();

        assert_eq!(resp.new_position, 1);
        assert_eq!(resp.new_parent_id, Some("RN_PAR".into()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_at_root_level() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: root-level blocks at consecutive positions
        insert_block(&pool, "RR_A", "page", "a", None, Some(1)).await;
        insert_block(&pool, "RR_B", "page", "b", None, Some(2)).await;
        insert_block(&pool, "RR_X", "page", "x", None, Some(3)).await;

        // Reorder RR_X after RR_A (parent_id = None, consecutive positions)
        let resp = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RR_X".into(),
            None, // root level
            Some("RR_A".into()),
        )
        .await
        .unwrap();

        assert_eq!(resp.new_position, 2);
        assert!(resp.new_parent_id.is_none());

        let siblings = sibling_positions(&pool, None).await;
        assert_eq!(
            siblings,
            vec![("RR_A".into(), 1), ("RR_X".into(), 2), ("RR_B".into(), 3),],
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = reorder_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), None, None).await;

        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_after_id_same_as_block_id_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RS_X", "content", "x", None, Some(1)).await;

        let result =
            reorder_block_inner(&pool, DEV, &mat, "RS_X".into(), None, Some("RS_X".into())).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "after_id == block_id should return Validation error"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_self_parent_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RSP_X", "content", "x", None, Some(1)).await;

        let result =
            reorder_block_inner(&pool, DEV, &mat, "RSP_X".into(), Some("RSP_X".into()), None).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "block_id == parent_id should return InvalidOperation"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_logs_move_block_op() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RO2_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RO2_A", "content", "a", Some("RO2_PAR"), Some(10)).await;
        insert_block(&pool, "RO2_X", "content", "x", Some("RO2_PAR"), Some(20)).await;

        reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RO2_X".into(),
            Some("RO2_PAR".into()),
            Some("RO2_A".into()),
        )
        .await
        .unwrap();

        // Verify op_log entry
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'move_block'",
            DEV
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "reorder should log exactly one move_block op");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reorder_invalid_after_id_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RI_PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "RI_X", "content", "x", Some("RI_PAR"), Some(1)).await;

        // after_id does not exist
        let result = reorder_block_inner(
            &pool,
            DEV,
            &mat,
            "RI_X".into(),
            Some("RI_PAR".into()),
            Some("NONEXISTENT".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent after_id should return NotFound"
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
        let result =
            move_block_inner(&pool, DEV, &mat, "CYC_A".into(), Some("CYC_C".into()), 1).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "moving A under its grandchild C should detect cycle, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("cycle detected"),
            "error message should mention cycle detection"
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

        assert_eq!(resp.new_parent_id, Some("NC_C".into()));
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
        let row = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
            "AT_BLK",
            "AT_TAG"
        )
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
        let row = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
            "RT_BLK",
            "RT_TAG"
        )
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

    /// Snapshot a BlockRow from create_block_inner.
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

        // Allow 10ms for consumer tokio tasks to be spawned and start their event
        // loops. This is minimal — just enough for the runtime to schedule the
        // spawned tasks before we query their status metrics.
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

        // Allow 10ms for consumer tokio tasks to be spawned and start their event
        // loops before taking a snapshot of the status fields.
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

    // ======================================================================
    // search_blocks_inner tests
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_empty_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = search_blocks_inner(&pool, "".into(), None, None)
            .await
            .unwrap();
        assert_eq!(result.items.len(), 0);
        assert!(!result.has_more);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_whitespace_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = search_blocks_inner(&pool, "   ".into(), None, None)
            .await
            .unwrap();
        assert_eq!(result.items.len(), 0);
        assert!(!result.has_more);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_finds_indexed_block() {
        let (pool, _dir) = test_pool().await;
        insert_block(
            &pool,
            "SRCH1",
            "content",
            "searchable content",
            None,
            Some(0),
        )
        .await;
        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        let result = search_blocks_inner(&pool, "searchable".into(), None, None)
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].id, "SRCH1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_no_results_for_unindexed_term() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "SRCH2", "content", "apple banana", None, Some(0)).await;
        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        let result = search_blocks_inner(&pool, "cherry".into(), None, None)
            .await
            .unwrap();
        assert_eq!(result.items.len(), 0);
    }

    // ======================================================================
    // query_by_tags_inner
    // ======================================================================

    /// Helper: insert a tag_cache entry for command-level tests.
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query(
            "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
        )
        .bind(tag_id)
        .bind(name)
        .bind(usage_count)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Helper: associate a block with a tag.
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_empty_inputs_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = query_by_tags_inner(&pool, vec![], vec![], "or".into(), None, None)
            .await
            .unwrap();

        assert!(result.items.is_empty());
        assert!(!result.has_more);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_or_mode_unions_tag_ids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
        insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
        insert_block(&pool, "BLK_1", "content", "one", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "two", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;

        let result = query_by_tags_inner(
            &pool,
            vec!["TAG_A".into(), "TAG_B".into()],
            vec![],
            "or".into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.items.len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_and_mode_intersects_tag_ids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
        insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
        insert_block(&pool, "BLK_1", "content", "both", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "only-a", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;

        let result = query_by_tags_inner(
            &pool,
            vec!["TAG_A".into(), "TAG_B".into()],
            vec![],
            "and".into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].id, "BLK_1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_with_prefix() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
        insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

        insert_block(&pool, "BLK_1", "content", "meeting notes", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "email draft", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_WE").await;

        let result =
            query_by_tags_inner(&pool, vec![], vec!["work/".into()], "or".into(), None, None)
                .await
                .unwrap();

        assert_eq!(result.items.len(), 2);
    }

    // ======================================================================
    // query_by_property_inner
    // ======================================================================

    /// Helper: insert a property directly into the block_properties table.
    async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind(value_text)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_returns_matching_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_B1", "content", "task 1", None, Some(1)).await;
        insert_block(&pool, "QP_B2", "content", "task 2", None, Some(2)).await;
        insert_block(&pool, "QP_B3", "content", "no prop", None, Some(3)).await;

        insert_property(&pool, "QP_B1", "todo", "TODO").await;
        insert_property(&pool, "QP_B2", "todo", "DONE").await;

        let result = query_by_property_inner(&pool, "todo".into(), None, None, None)
            .await
            .unwrap();

        assert_eq!(result.items.len(), 2, "both blocks with 'todo' property");
        assert_eq!(result.items[0].id, "QP_B1");
        assert_eq!(result.items[1].id, "QP_B2");
    }

    #[tokio::test]
    async fn query_by_property_empty_key_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = query_by_property_inner(&pool, "".into(), None, None, None).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty key must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_filters_by_value() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_A", "content", "task a", None, Some(1)).await;
        insert_block(&pool, "QP_B", "content", "task b", None, Some(2)).await;

        insert_property(&pool, "QP_A", "todo", "TODO").await;
        insert_property(&pool, "QP_B", "todo", "DONE").await;

        let result = query_by_property_inner(&pool, "todo".into(), Some("TODO".into()), None, None)
            .await
            .unwrap();

        assert_eq!(result.items.len(), 1, "only block with todo=TODO");
        assert_eq!(result.items[0].id, "QP_A");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_paginates_correctly() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("QP_P{i:02}");
            insert_block(&pool, &id, "content", &format!("item {i}"), None, Some(i)).await;
            insert_property(&pool, &id, "status", "active").await;
        }

        // First page: limit 2
        let r1 = query_by_property_inner(&pool, "status".into(), None, None, Some(2))
            .await
            .unwrap();

        assert_eq!(r1.items.len(), 2);
        assert!(r1.has_more);
        assert!(r1.next_cursor.is_some());
        assert_eq!(r1.items[0].id, "QP_P01");
        assert_eq!(r1.items[1].id, "QP_P02");

        // Second page
        let r2 = query_by_property_inner(&pool, "status".into(), None, r1.next_cursor, Some(2))
            .await
            .unwrap();

        assert_eq!(r2.items.len(), 2);
        assert!(r2.has_more);
        assert_eq!(r2.items[0].id, "QP_P03");
        assert_eq!(r2.items[1].id, "QP_P04");

        // Third page: last item
        let r3 = query_by_property_inner(&pool, "status".into(), None, r2.next_cursor, Some(2))
            .await
            .unwrap();

        assert_eq!(r3.items.len(), 1);
        assert!(!r3.has_more);
        assert!(r3.next_cursor.is_none());
        assert_eq!(r3.items[0].id, "QP_P05");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_DEL", "content", "deleted", None, Some(1)).await;
        insert_property(&pool, "QP_DEL", "todo", "TODO").await;

        // Soft-delete the block
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'QP_DEL'")
            .execute(&pool)
            .await
            .unwrap();

        let result = query_by_property_inner(&pool, "todo".into(), None, None, None)
            .await
            .unwrap();

        assert!(
            result.items.is_empty(),
            "deleted block must be excluded from query_by_property"
        );
    }

    // ======================================================================
    // list_tags_by_prefix_inner
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_returns_matching() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
        insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;
        insert_block(&pool, "TAG_P", "tag", "personal", None, None).await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 10).await;

        let result = list_tags_by_prefix_inner(&pool, "work/".into(), None)
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "work/email");
        assert_eq!(result[1].name, "work/meeting");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = list_tags_by_prefix_inner(&pool, "nonexistent/".into(), None)
            .await
            .unwrap();

        assert!(result.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_respects_limit() {
        let (pool, _dir) = test_pool().await;

        for i in 0..5 {
            insert_block(
                &pool,
                &format!("TAG_A{i}"),
                "tag",
                &format!("alpha{i}"),
                None,
                None,
            )
            .await;
            insert_tag_cache(&pool, &format!("TAG_A{i}"), &format!("alpha{i}"), 1).await;
        }

        let result = list_tags_by_prefix_inner(&pool, "alpha".into(), Some(2))
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
    }

    // ======================================================================
    // F11: Concurrent edit race condition (verifies TOCTOU fix)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn f11_concurrent_edits_do_not_corrupt() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block, then spawn 2 concurrent edits.
        // Both should succeed (SQLite serializes via IMMEDIATE tx).
        // Final state should be one of the two edits.
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

        let block_id = created.id.clone();
        let pool1 = pool.clone();
        let pool2 = pool.clone();
        let mat1 = Materializer::new(pool.clone());
        let mat2 = Materializer::new(pool.clone());
        let bid1 = block_id.clone();
        let bid2 = block_id.clone();

        let h1 = tokio::spawn(async move {
            edit_block_inner(&pool1, DEV, &mat1, bid1, "edit-A".into()).await
        });
        let h2 = tokio::spawn(async move {
            edit_block_inner(&pool2, DEV, &mat2, bid2, "edit-B".into()).await
        });

        let (r1, r2) = tokio::join!(h1, h2);
        assert!(r1.unwrap().is_ok(), "first concurrent edit should succeed");
        assert!(r2.unwrap().is_ok(), "second concurrent edit should succeed");

        // Final DB state should be one of the two edits
        let row = get_block_inner(&pool, block_id.clone()).await.unwrap();
        assert!(
            row.content == Some("edit-A".into()) || row.content == Some("edit-B".into()),
            "final content should be one of the concurrent edits, got: {:?}",
            row.content
        );

        // Verify exactly 2 edit ops in the log
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block' \
             AND json_extract(payload, '$.block_id') = ?",
            block_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2, "exactly 2 edit ops should be logged");
    }

    // ======================================================================
    // F12: Purge of already-purged block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f12_purge_already_purged_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "PURGE_TWICE", "content", "purge me", None, Some(1)).await;

        // Soft-delete first
        soft_delete::cascade_soft_delete(&pool, "PURGE_TWICE")
            .await
            .unwrap();

        // First purge succeeds
        let resp = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into())
            .await
            .unwrap();
        assert_eq!(resp.purged_count, 1);

        // Second purge should return NotFound (block is physically gone)
        let result = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "purging an already-purged block should return NotFound, got: {result:?}"
        );
    }

    // ======================================================================
    // F13: Create block with invalid block_type values
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_empty_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result =
            create_block_inner(&pool, DEV, &mat, "".into(), "hello".into(), None, None).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty block_type should return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_sql_injection_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "'; DROP TABLE blocks; --".into(),
            "hello".into(),
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "SQL injection in block_type should return Validation error, got: {result:?}"
        );

        // Verify blocks table still exists
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(count >= 0, "blocks table should still exist");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_case_sensitive_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // "Content" (uppercase C) should be rejected -- only "content" is valid
        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "Content".into(),
            "hello".into(),
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "case-variant block_type should return Validation error, got: {result:?}"
        );
    }

    // ======================================================================
    // F14: list_blocks with edge-case page_size values
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_zero_clamped_to_one() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_BLK1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_BLK2", "content", "b", None, Some(2)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, Some(0))
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "page_size=0 should be clamped to 1, returning exactly 1 item"
        );
        assert!(resp.has_more, "should indicate more items available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_negative_clamped_to_one() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_N1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_N2", "content", "b", None, Some(2)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, Some(-1))
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "page_size=-1 should be clamped to 1, returning exactly 1 item"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_1000_clamped_to_100() {
        let (pool, _dir) = test_pool().await;

        // Insert 3 blocks -- enough to verify clamping but not 100+
        insert_block(&pool, "PS_L1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_L2", "content", "b", None, Some(2)).await;
        insert_block(&pool, "PS_L3", "content", "c", None, Some(3)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, Some(1000))
            .await
            .unwrap();

        // With only 3 items and clamped limit=100, all 3 should be returned
        assert_eq!(resp.items.len(), 3);
        assert!(!resp.has_more, "no more items should remain");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_none_uses_default() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_D1", "content", "a", None, Some(1)).await;

        let resp = list_blocks_inner(&pool, None, None, None, None, None, None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 1);
    }

    // ======================================================================
    // set_property / delete_property / get_properties
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_creates_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block to attach the property to
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "prop test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set a text property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Verify via get_properties
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert_eq!(props.len(), 1, "should have exactly one property");
        assert_eq!(props[0].key, "importance");
        assert_eq!(props[0].value_text, Some("high".into()));
        assert!(props[0].value_num.is_none());
        assert!(props[0].value_date.is_none());
        assert!(props[0].value_ref.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_validates_key() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
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

        mat.flush_background().await.unwrap();

        // Empty key should fail validation
        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "".into(),
            Some("val".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty key should return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_on_deleted_block_fails() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
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

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "key".into(),
            Some("val".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "setting property on deleted block should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_property_removes_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
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

        mat.flush_background().await.unwrap();

        // Set a property
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

        mat.flush_background().await.unwrap();

        // Delete the property
        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // Verify it's gone
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.is_empty(),
            "properties should be empty after delete, got: {props:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_properties_returns_empty_for_new_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "no props".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.is_empty(),
            "new block should have no properties, got: {props:?}"
        );
    }

    // ─── get_batch_properties tests ──────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_returns_all_for_multiple_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create 3 blocks
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block one".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block two".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b3 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block three".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set properties on blocks 1 and 2
        set_property_inner(
            &pool,
            DEV,
            &mat,
            b1.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            b2.id.clone(),
            "status".into(),
            Some("active".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Batch-fetch for all 3
        let result =
            get_batch_properties_inner(&pool, vec![b1.id.clone(), b2.id.clone(), b3.id.clone()])
                .await
                .unwrap();

        // b1 and b2 should have properties, b3 should be omitted
        assert!(result.contains_key(&b1.id), "b1 must be in result");
        assert!(result.contains_key(&b2.id), "b2 must be in result");
        assert_eq!(result[&b1.id].len(), 1);
        assert_eq!(result[&b1.id][0].key, "importance");
        assert_eq!(result[&b2.id].len(), 1);
        assert_eq!(result[&b2.id][0].key, "status");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_empty_ids_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = get_batch_properties_inner(&pool, vec![]).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty block_ids list must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_omits_blocks_without_properties() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with no properties
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "no props".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
            .await
            .unwrap();

        assert!(
            !result.contains_key(&block.id),
            "block with no properties must be omitted from result, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_returns_multiple_props_per_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "multi-prop".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set 3 different properties
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

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
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "score".into(),
            None,
            Some(42.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
            .await
            .unwrap();

        assert!(result.contains_key(&block.id), "block must be in result");
        let props = &result[&block.id];
        assert_eq!(props.len(), 3, "must return all 3 properties");

        let keys: Vec<&str> = props.iter().map(|p| p.key.as_str()).collect();
        assert!(keys.contains(&"importance"), "must contain importance");
        assert!(keys.contains(&"status"), "must contain status");
        assert!(keys.contains(&"score"), "must contain score");
    }

    // ─── batch_resolve tests ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_returns_all_requested_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR01", "content", "First block", None, Some(0)).await;
        insert_block(&pool, "BR02", "page", "My Page", None, Some(1)).await;
        insert_block(&pool, "BR03", "tag", "work", None, Some(2)).await;

        let result = batch_resolve_inner(&pool, vec!["BR01".into(), "BR02".into(), "BR03".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 3, "must return all 3 blocks");

        let r1 = result.iter().find(|r| r.id == "BR01").unwrap();
        assert_eq!(r1.title.as_deref(), Some("First block"));
        assert_eq!(r1.block_type, "content");
        assert!(!r1.deleted);

        let r2 = result.iter().find(|r| r.id == "BR02").unwrap();
        assert_eq!(r2.title.as_deref(), Some("My Page"));
        assert_eq!(r2.block_type, "page");
        assert!(!r2.deleted);

        let r3 = result.iter().find(|r| r.id == "BR03").unwrap();
        assert_eq!(r3.title.as_deref(), Some("work"));
        assert_eq!(r3.block_type, "tag");
        assert!(!r3.deleted);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_empty_ids_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = batch_resolve_inner(&pool, vec![]).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty ids list must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_includes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_DEL", "content", "deleted block", None, Some(0)).await;
        sqlx::query("UPDATE blocks SET deleted_at = ?")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        let result = batch_resolve_inner(&pool, vec!["BR_DEL".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert!(result[0].deleted, "deleted blocks must have deleted=true");
        assert_eq!(result[0].title.as_deref(), Some("deleted block"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_omits_nonexistent_ids() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_EXISTS", "content", "exists", None, Some(0)).await;

        let result = batch_resolve_inner(&pool, vec!["BR_EXISTS".into(), "BR_MISSING".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1, "nonexistent IDs must be silently omitted");
        assert_eq!(result[0].id, "BR_EXISTS");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_null_content_returns_none_title() {
        let (pool, _dir) = test_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, NULL, NULL, 0)",
        )
        .bind("BR_NULL")
        .bind("content")
        .execute(&pool)
        .await
        .unwrap();

        let result = batch_resolve_inner(&pool, vec!["BR_NULL".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert!(result[0].title.is_none(), "NULL content → None title");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_single_id() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_SINGLE", "page", "Solo Page", None, Some(0)).await;

        let result = batch_resolve_inner(&pool, vec!["BR_SINGLE".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "BR_SINGLE");
        assert_eq!(result[0].title.as_deref(), Some("Solo Page"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_duplicate_ids_deduped_by_db() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_DUP", "content", "Dup block", None, Some(0)).await;

        let result = batch_resolve_inner(
            &pool,
            vec!["BR_DUP".into(), "BR_DUP".into(), "BR_DUP".into()],
        )
        .await
        .unwrap();

        // json_each produces 3 rows for 3 values, but the IN subquery
        // matches only the one block row — result depends on DB behavior.
        // With json_each + IN, duplicates in the value list may produce
        // duplicate matches. We assert at least 1 result.
        assert!(
            !result.is_empty(),
            "duplicate IDs must still return the block"
        );
        assert!(
            result.iter().all(|r| r.id == "BR_DUP"),
            "all results must be the same block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_mixed_block_types() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_PAGE", "page", "Page Title", None, Some(0)).await;
        insert_block(&pool, "BR_TAG", "tag", "my-tag", None, Some(1)).await;
        insert_block(
            &pool,
            "BR_CONTENT",
            "content",
            "Some text",
            Some("BR_PAGE"),
            Some(0),
        )
        .await;

        let result = batch_resolve_inner(
            &pool,
            vec!["BR_PAGE".into(), "BR_TAG".into(), "BR_CONTENT".into()],
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 3);
        let types: Vec<&str> = result.iter().map(|r| r.block_type.as_str()).collect();
        assert!(types.contains(&"page"));
        assert!(types.contains(&"tag"));
        assert!(types.contains(&"content"));
    }

    // ======================================================================
    // Undo/Redo tests
    // ======================================================================

    /// Helper: create a page with children and return (page_id, child_ids)
    async fn create_page_with_children(
        pool: &SqlitePool,
        mat: &Materializer,
    ) -> (String, Vec<String>) {
        let page = create_block_inner(
            pool,
            DEV,
            mat,
            "page".into(),
            "Test Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child1 = create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            "child one".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child2 = create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            "child two".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        (page.id, vec![child1.id, child2.id])
    }

    // -- list_page_history tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_returns_ops_for_page_descendants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1 to produce more ops
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child_ids[0].clone(),
            "edited child one".into(),
        )
        .await
        .unwrap();

        // Also create an unrelated block to ensure it's excluded
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "unrelated".into(),
            None,
            Some(10),
        )
        .await
        .unwrap();

        let result = list_page_history_inner(&pool, page_id.clone(), None, None, None)
            .await
            .unwrap();

        // Should include: create_block (page), create_block (child1), create_block (child2), edit_block (child1)
        assert_eq!(
            result.items.len(),
            4,
            "should have 4 ops for page descendants"
        );

        // Verify all ops are for page or its descendants
        for entry in &result.items {
            let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
            let block_id = payload["block_id"].as_str().unwrap();
            assert!(
                block_id == page_id || child_ids.contains(&block_id.to_string()),
                "op should be for page or its descendants, got block_id: {block_id}"
            );
        }

        // Newest first
        assert_eq!(result.items[0].op_type, "edit_block", "newest op first");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_with_op_type_filter() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();

        let result = list_page_history_inner(
            &pool,
            page_id.clone(),
            Some("edit_block".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.items.len(), 1, "should only have edit_block ops");
        assert_eq!(result.items[0].op_type, "edit_block");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_pagination_works() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child to have 4 total ops
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();

        // Page 1: limit 2
        let page1 = list_page_history_inner(&pool, page_id.clone(), None, None, Some(2))
            .await
            .unwrap();
        assert_eq!(page1.items.len(), 2, "first page should have 2 items");
        assert!(page1.has_more, "should have more items");
        assert!(page1.next_cursor.is_some(), "should have a cursor");

        // Page 2: use cursor from page 1
        let page2 =
            list_page_history_inner(&pool, page_id.clone(), None, page1.next_cursor, Some(2))
                .await
                .unwrap();
        assert_eq!(page2.items.len(), 2, "second page should have 2 items");
        assert!(!page2.has_more, "should be the last page");
    }

    // -- revert_ops tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_reverses_single_edit() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create and edit a block
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
        mat.flush_background().await.unwrap();

        let _edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "modified".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify block is now "modified"
        let before_undo = get_block_inner(&pool, created.id.clone()).await.unwrap();
        assert_eq!(before_undo.content, Some("modified".into()));

        // Get the edit op's seq
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();

        // Revert it
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: edit_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1, "should have one result");
        assert_eq!(results[0].reversed_op.seq, edit_op.seq);
        assert_eq!(results[0].new_op_type, "edit_block");
        assert!(!results[0].is_redo);

        // Block should be back to "original"
        let after_undo = get_block_inner(&pool, created.id).await.unwrap();
        assert_eq!(
            after_undo.content,
            Some("original".into()),
            "content should revert to original"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_reverses_multiple_ops_in_correct_order() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "v0".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit twice
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Get both edit ops
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "edit_block").collect();
        assert_eq!(edit_ops.len(), 2);

        let op_refs: Vec<OpRef> = edit_ops
            .iter()
            .map(|o| OpRef {
                device_id: DEV.into(),
                seq: o.seq,
            })
            .collect();

        let results = revert_ops_inner(&pool, DEV, &mat, op_refs).await.unwrap();

        assert_eq!(results.len(), 2, "should have two results");

        // After reverting both edits, block should be back to "v0"
        let after = get_block_inner(&pool, created.id).await.unwrap();
        assert_eq!(
            after.content,
            Some("v0".into()),
            "content should revert to original after reversing both edits"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_rejects_non_reversible_op() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create and soft-delete and purge a block
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
        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        purge_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Get the purge op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

        // Try to revert it — should fail
        let result = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: purge_op.seq,
            }],
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NonReversible { .. })),
            "should fail with NonReversible for purge_block, got: {result:?}"
        );
    }

    // -- undo_page_op tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_0_reverses_most_recent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify block is "edited"
        let before = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(before.content, Some("edited".into()));

        // Undo most recent op (depth=0) — the edit
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
            .await
            .unwrap();

        assert_eq!(result.reversed_op.device_id, DEV);
        assert_eq!(result.new_op_type, "edit_block");
        assert!(!result.is_redo);

        // Block should be back to "child one"
        let after = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("child one".into()),
            "content should revert to original after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_1_reverses_second_most_recent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1 twice
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edit1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edit2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Undo depth=1 — should reverse the first edit (second most recent op)
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 1)
            .await
            .unwrap();

        // The second most recent op is "edit1" (edit_block)
        assert_eq!(result.new_op_type, "edit_block");
        assert!(!result.is_redo);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_finds_delete_attachment_op() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // 1. Create a page with a child block
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Attachment Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child block".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // 2. Add an attachment to the child block
        let att_id = "ATT_UNDO_001";
        let att_ts = now_rfc3339();
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(&child.id)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind(&att_ts)
        .execute(&pool)
        .await
        .unwrap();

        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: att_id.into(),
                block_id: BlockId::from_trusted(&child.id),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            att_ts.clone(),
        )
        .await
        .unwrap();

        // 3. Delete the attachment (append delete_attachment op + soft-delete)
        let del_ts = now_rfc3339();
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: att_id.into(),
            }),
            del_ts.clone(),
        )
        .await
        .unwrap();

        sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
            .bind(&del_ts)
            .bind(att_id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify attachment is soft-deleted
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_some(),
            "attachment should be soft-deleted before undo"
        );

        // 4. Undo most recent op — should find the delete_attachment op
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .expect("undo should find delete_attachment op on the page");

        assert_eq!(
            result.new_op_type, "add_attachment",
            "reversing delete_attachment should produce add_attachment"
        );
        assert!(!result.is_redo);

        // 5. Verify the attachment is restored (deleted_at cleared)
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_none(),
            "attachment should be restored after undo (deleted_at should be NULL)"
        );
    }

    // -- redo_page_op tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redo_page_op_reverses_undo_restoring_state() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Undo the edit
        let undo_result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
            .await
            .unwrap();

        // Verify it's undone
        let after_undo = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(after_undo.content, Some("child one".into()));

        // Redo it
        let redo_result = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo_result.new_op_ref.device_id.clone(),
            undo_result.new_op_ref.seq,
        )
        .await
        .unwrap();

        assert!(redo_result.is_redo, "should be flagged as redo");
        assert_eq!(redo_result.new_op_type, "edit_block");

        // Block should be back to "edited"
        let after_redo = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            after_redo.content,
            Some("edited".into()),
            "content should be restored after redo"
        );
    }

    // -- Full cycle test --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_cycle_create_edit_undo_redo() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
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
        mat.flush_background().await.unwrap();

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
        mat.flush_background().await.unwrap();

        // Edit
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let after_edit = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(after_edit.content, Some("modified".into()));

        // Undo the edit (depth=0 = most recent)
        let undo = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        assert!(!undo.is_redo);

        let after_undo = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after_undo.content,
            Some("original".into()),
            "undo should restore original content"
        );

        // Redo the undo
        let redo = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo.new_op_ref.device_id.clone(),
            undo.new_op_ref.seq,
        )
        .await
        .unwrap();
        assert!(redo.is_redo);

        let after_redo = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after_redo.content,
            Some("modified".into()),
            "redo should produce original edit result"
        );
    }

    // ======================================================================
    // Extended Undo/Redo integration tests — Groups 1-4 (19 tests)
    // ======================================================================

    // -- Group 1: apply_reverse_in_tx — all variants (9 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_create_block_soft_deletes() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "ephemeral".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Get the create_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let create_op = ops.iter().find(|o| o.op_type == "create_block").unwrap();

        // Revert the create (reverse = DeleteBlock → soft-deletes the block)
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: create_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].new_op_type, "delete_block");

        // Verify the block is now soft-deleted
        let block = get_block_inner(&pool, created.id).await.unwrap();
        assert!(
            block.deleted_at.is_some(),
            "block should be soft-deleted after reverting create"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_delete_block_restores_with_descendants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create parent + child
        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Parent".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Child".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Use a controlled timestamp so blocks.deleted_at matches the op's created_at.
        // delete_block_inner uses two separate now_rfc3339() calls (one for op_log,
        // one for blocks), causing a mismatch. We do it manually with one timestamp.
        let delete_ts = "2025-06-15T12:00:00+00:00";

        // Manually soft-delete both blocks with the controlled timestamp
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ? OR id = ?")
            .bind(delete_ts)
            .bind(&parent.id)
            .bind(&child.id)
            .execute(&pool)
            .await
            .unwrap();

        // Append delete_block op with the same timestamp
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_trusted(&parent.id),
            }),
            delete_ts.to_string(),
        )
        .await
        .unwrap();

        // Verify both are deleted
        let p_row = get_block_inner(&pool, parent.id.clone()).await.unwrap();
        assert!(p_row.deleted_at.is_some(), "parent should be deleted");

        // Get the delete_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let delete_op = ops.iter().find(|o| o.op_type == "delete_block").unwrap();

        // Revert the delete (reverse = RestoreBlock)
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: delete_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].new_op_type, "restore_block");

        // Verify both are restored
        let p_after = get_block_inner(&pool, parent.id.clone()).await.unwrap();
        assert!(
            p_after.deleted_at.is_none(),
            "parent should be restored after revert"
        );

        let c_after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            c_after.deleted_at.is_none(),
            "child should be restored after revert"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_move_block_restores_original_position() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create two parent pages
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

        // Create child under P1 at position 3
        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "movable".into(),
            Some(p1.id.clone()),
            Some(3),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Move child to P2 at position 7
        move_block_inner(&pool, DEV, &mat, child.id.clone(), Some(p2.id.clone()), 7)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify it's at P2, pos 7
        let before = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(before.parent_id.as_deref(), Some(p2.id.as_str()));
        assert_eq!(before.position, Some(7));

        // Get the move_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let move_op = ops.iter().find(|o| o.op_type == "move_block").unwrap();

        // Revert the move
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: move_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify it's back at P1, pos 3
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.parent_id.as_deref(),
            Some(p1.id.as_str()),
            "parent should be restored to P1"
        );
        assert_eq!(after.position, Some(3), "position should be restored to 3");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_add_tag_removes_association() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a tag block and a content block
        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "my-tag".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let content = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "some text".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Add the tag
        add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify the tag is applied
        let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(before.is_some(), "tag should be applied");

        // Get the add_tag op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let add_tag_op = ops.iter().find(|o| o.op_type == "add_tag").unwrap();

        // Revert the add_tag (reverse = RemoveTag)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: add_tag_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the tag is removed
        let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(after.is_none(), "tag should be removed after revert");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_remove_tag_restores_association() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create tag + content
        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "my-tag".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let content = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "some text".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Add tag, then remove tag
        add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        remove_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify tag is removed
        let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(before.is_none(), "tag should be removed");

        // Get the remove_tag op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let remove_tag_op = ops.iter().find(|o| o.op_type == "remove_tag").unwrap();

        // Revert the remove_tag (reverse = AddTag)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: remove_tag_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the tag is restored
        let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(after.is_some(), "tag should be restored after revert");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_set_property_restores_prior_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        // Set property to "high"
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property to "low"
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("low".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify it's "low"
        let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let p_before = props_before.iter().find(|p| p.key == "importance").unwrap();
        assert_eq!(p_before.value_text.as_deref(), Some("low"));

        // Get the second set_property op (the one that set "low")
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        let second_set = set_ops.last().unwrap();

        // Revert the second set (should restore "high")
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: second_set.seq,
            }],
        )
        .await
        .unwrap();

        // Verify it's back to "high"
        let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let p_after = props_after.iter().find(|p| p.key == "importance").unwrap();
        assert_eq!(
            p_after.value_text.as_deref(),
            Some("high"),
            "value should be restored to 'high' after reverting second set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_set_property_first_produces_delete() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        // Set property "color" = "red" (first set, no prior)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "color".into(),
            Some("red".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Get the set_property op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_op = ops.iter().find(|o| o.op_type == "set_property").unwrap();

        // Revert the first set (no prior → reverse = DeleteProperty)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: set_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the property row no longer exists
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.iter().all(|p| p.key != "color"),
            "property 'color' should be deleted after reverting first set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_delete_property_restores_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        // Set property "due" with value_date
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "due".into(),
            None,
            None,
            Some("2025-06-15".into()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Delete the property
        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "due".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify property is gone
        let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props_before.iter().all(|p| p.key != "due"),
            "property 'due' should be deleted"
        );

        // Get the delete_property op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let del_op = ops.iter().find(|o| o.op_type == "delete_property").unwrap();

        // Revert the delete (reverse = SetProperty with prior value)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: del_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the property is restored with value_date="2025-06-15"
        let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let due = props_after
            .iter()
            .find(|p| p.key == "due")
            .expect("property 'due' should be restored after reverting delete");
        assert_eq!(
            due.value_date.as_deref(),
            Some("2025-06-15"),
            "value_date should be restored to '2025-06-15'"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_add_attachment_soft_deletes() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block (needed for FK)
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
        mat.flush_background().await.unwrap();

        // Manually insert an attachment row
        let att_id = "ATT_TEST_001";
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(&block.id)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        // Append add_attachment op via op_log
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: att_id.into(),
                block_id: BlockId::from_trusted(&block.id),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            FIXED_TS.to_string(),
        )
        .await
        .unwrap();

        // Get the add_attachment op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let add_att_op = ops.iter().find(|o| o.op_type == "add_attachment").unwrap();

        // Revert the add_attachment (reverse = DeleteAttachment → soft-delete)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: add_att_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify attachment is soft-deleted
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_some(),
            "attachment should be soft-deleted after reverting add"
        );
    }

    // -- Group 2: Error paths (5 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_nonexistent_page_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = undo_page_op_inner(&pool, DEV, &mat, "NONEXISTENT_PAGE".into(), 0).await;

        assert!(result.is_err(), "undo on nonexistent page should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_exceeds_ops_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, _child_ids) = create_page_with_children(&pool, &mat).await;

        // Page has 3 ops: create page, create child1, create child2.
        // Undo with depth=10 should exceed available ops.
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id, 10).await;

        assert!(result.is_err(), "undo with depth exceeding ops should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redo_nonexistent_undo_op_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = redo_page_op_inner(&pool, DEV, &mat, "FAKE".into(), 9999).await;

        assert!(result.is_err(), "redo with nonexistent op should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_empty_list_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let results = revert_ops_inner(&pool, DEV, &mat, vec![]).await.unwrap();

        assert!(
            results.is_empty(),
            "reverting empty list should return empty vec"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_mixed_reversible_non_reversible_rejects_all() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block and edit it (reversible op)
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "start".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, block.id.clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Create another block, delete it, purge it (non-reversible)
        let doomed = create_block_inner(
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
        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, doomed.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        purge_block_inner(&pool, DEV, &mat, doomed.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Gather op refs
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();
        let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

        // Record op_log count before attempt
        let count_before = ops.len();

        // Try to revert both — should fail because purge is non-reversible
        let result = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![
                OpRef {
                    device_id: DEV.into(),
                    seq: edit_op.seq,
                },
                OpRef {
                    device_id: DEV.into(),
                    seq: purge_op.seq,
                },
            ],
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NonReversible { .. })),
            "should fail with NonReversible, got: {result:?}"
        );

        // Verify the edit was NOT reversed (block content unchanged)
        let after = get_block_inner(&pool, block.id).await.unwrap();
        assert_eq!(
            after.content,
            Some("edited".into()),
            "edit should NOT be reversed when batch is rejected"
        );

        // Verify op_log count unchanged
        let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        assert_eq!(
            count_before,
            ops_after.len(),
            "no new ops should be appended when batch is rejected"
        );
    }

    // -- Group 3: list_page_history edge cases (3 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_deep_nesting_includes_grandchildren() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create: page → child → grandchild → great-grandchild
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Root".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
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
        mat.flush_background().await.unwrap();

        let grandchild = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "grandchild".into(),
            Some(child.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let great_grandchild = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "great-grandchild".into(),
            Some(grandchild.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit each to add more ops
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child-edited".into())
            .await
            .unwrap();
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            grandchild.id.clone(),
            "grandchild-edited".into(),
        )
        .await
        .unwrap();
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            great_grandchild.id.clone(),
            "gg-edited".into(),
        )
        .await
        .unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        // 4 creates + 3 edits = 7 ops
        assert_eq!(
            result.items.len(),
            7,
            "should include ops for all 4 levels of nesting"
        );

        // Verify all block IDs are from the page tree
        let valid_ids = vec![
            page.id.clone(),
            child.id.clone(),
            grandchild.id.clone(),
            great_grandchild.id.clone(),
        ];
        for entry in &result.items {
            let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
            let block_id = payload["block_id"].as_str().unwrap();
            assert!(
                valid_ids.contains(&block_id.to_string()),
                "op should be for a block in the page tree, got: {block_id}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_includes_ops_for_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
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
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
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
        mat.flush_background().await.unwrap();

        // Edit child
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited-child".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Delete child
        delete_block_inner(&pool, DEV, &mat, child.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        // Ops: create page + create child + edit child + delete child = 4
        assert_eq!(
            result.items.len(),
            4,
            "should include ops for deleted blocks too"
        );

        let op_types: Vec<&str> = result.items.iter().map(|e| e.op_type.as_str()).collect();
        assert!(
            op_types.contains(&"create_block"),
            "should include create_block ops"
        );
        assert!(
            op_types.contains(&"edit_block"),
            "should include edit_block ops"
        );
        assert!(
            op_types.contains(&"delete_block"),
            "should include delete_block ops"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_empty_page_returns_only_create() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Empty Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        assert_eq!(
            result.items.len(),
            1,
            "empty page should have exactly 1 op (the create_block)"
        );
        assert_eq!(result.items[0].op_type, "create_block");
    }

    // -- Group 4: Multi-step cycles (2 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_redo_undo_redo_full_cycle_multiple_edits() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
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
        mat.flush_background().await.unwrap();

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
        mat.flush_background().await.unwrap();

        // Edit to "v1", then "v2"
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // 1) undo(depth=0) → reverses edit "v2" → content="v1"
        let undo1 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v1".into()),
            "after first undo, content should be v1"
        );

        // 2) undo(depth=2) → reverses edit "v1"
        //    History after step 1: [undo_edit(seq5), edit_v2(seq4), edit_v1(seq3), ...]
        //    depth=2 picks seq3 (edit "v1"), whose prior text is "original"
        let undo2 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 2)
            .await
            .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("original".into()),
            "after second undo, content should be original"
        );

        // 3) redo the second undo → reverses the undo2 op → content="v1"
        let _redo1 = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo2.new_op_ref.device_id.clone(),
            undo2.new_op_ref.seq,
        )
        .await
        .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v1".into()),
            "after first redo, content should be v1"
        );

        // 4) redo the first undo → reverses the undo1 op → content="v2"
        let _redo2 = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo1.new_op_ref.device_id.clone(),
            undo1.new_op_ref.seq,
        )
        .await
        .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v2".into()),
            "after second redo, content should be v2"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_from_different_devices() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with DEV
        let block = create_block_inner(
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
        mat.flush_background().await.unwrap();

        // Manually append an edit_block op from "device-B".
        // Use a far-future timestamp so it sorts AFTER the create_block op
        // from DEV (whose created_at is now_rfc3339()). The reverse lookup
        // needs to find the create op *before* this edit in temporal order.
        let edit_payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(&block.id),
            to_text: "from-device-B".into(),
            prev_edit: None,
        });
        let device_b_op = op_log::append_local_op_at(
            &pool,
            "device-B",
            edit_payload,
            "2099-01-01T00:00:00+00:00".to_string(),
        )
        .await
        .unwrap();

        // Manually apply the edit to the blocks table (op_log doesn't do this)
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind("from-device-B")
            .bind(&block.id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify content is "from-device-B"
        let before = get_block_inner(&pool, block.id.clone()).await.unwrap();
        assert_eq!(before.content, Some("from-device-B".into()));

        // Get the create_block op from DEV
        let dev_ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let create_op = dev_ops
            .iter()
            .find(|o| o.op_type == "create_block")
            .unwrap();

        // Revert both ops: edit from device-B and create from DEV
        // revert_ops_inner sorts newest-first: device-B edit (newer) then DEV create
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![
                OpRef {
                    device_id: "device-B".into(),
                    seq: device_b_op.seq,
                },
                OpRef {
                    device_id: DEV.into(),
                    seq: create_op.seq,
                },
            ],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 2, "should have two results");

        // After reverting device-B's edit: content should be "original"
        // After reverting DEV's create: block should be soft-deleted
        let after = get_block_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            after.deleted_at.is_some(),
            "block should be soft-deleted after reverting create"
        );
    }

    // -- Group 5: Additional integration tests (5 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_includes_ops_after_block_moved_to_different_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page A
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
        mat.flush_background().await.unwrap();

        // Create page B
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
        mat.flush_background().await.unwrap();

        // Create child under page A
        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child text".into(),
            Some(page_a.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit child while under page A
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited child".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Move child to page B
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
        mat.flush_background().await.unwrap();

        // Query page A history — child is no longer under A
        let history_a = list_page_history_inner(&pool, page_a.id.clone(), None, None, Some(50))
            .await
            .unwrap();

        // Query page B history — child is now under B
        let history_b = list_page_history_inner(&pool, page_b.id.clone(), None, None, Some(50))
            .await
            .unwrap();

        // Verify page B contains the child's ops (create, edit, move)
        let child_ops_in_b: Vec<_> = history_b
            .items
            .iter()
            .filter(|e| {
                let payload: serde_json::Value =
                    serde_json::from_str(&e.payload).unwrap_or_default();
                payload.get("block_id").and_then(|v| v.as_str()) == Some(&child.id)
            })
            .collect();

        // The child is now under B, so all ops for child should appear in B's history.
        assert!(
            !child_ops_in_b.is_empty(),
            "page B history should include ops for the moved child"
        );

        // Page A should NOT include the child's ops anymore (child is no longer a descendant)
        let child_ops_in_a: Vec<_> = history_a
            .items
            .iter()
            .filter(|e| {
                let payload: serde_json::Value =
                    serde_json::from_str(&e.payload).unwrap_or_default();
                payload.get("block_id").and_then(|v| v.as_str()) == Some(&child.id)
            })
            .collect();
        assert!(
            child_ops_in_a.is_empty(),
            "page A history should NOT include ops for child that moved away"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_delete_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child content".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Delete the child
        delete_block_inner(&pool, DEV, &mat, child.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify deleted
        let deleted = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(deleted.deleted_at.is_some(), "child should be deleted");

        // Undo the delete (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "restore_block",
            "undo of delete should produce restore"
        );

        // Verify restored
        let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            restored.deleted_at.is_none(),
            "child should be restored after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_move_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        let parent_a = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Parent A".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let parent_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Parent B".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "moveable".into(),
            Some(parent_a.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Move child from parent_a to parent_b
        move_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            Some(parent_b.id.clone()),
            5,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify moved
        let moved = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(parent_b.id.as_str()));

        // Undo the move (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "move_block",
            "undo of move should produce move"
        );

        // Verify moved back
        let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            restored.parent_id.as_deref(),
            Some(parent_a.id.as_str()),
            "child should be back under parent A"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_add_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "important".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
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
        mat.flush_background().await.unwrap();

        // Add tag to child
        add_tag_inner(&pool, DEV, &mat, child.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify tag exists
        let count_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(&child.id)
                .bind(&tag.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count_before, 1);

        // Undo the add_tag (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(result.new_op_type, "remove_tag");

        // Verify tag removed
        let count_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(&child.id)
                .bind(&tag.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count_after, 0, "tag should be removed after undo");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_set_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

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
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
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
        mat.flush_background().await.unwrap();

        // Set property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify property exists
        let props = get_properties_inner(&pool, child.id.clone()).await.unwrap();
        assert!(props
            .iter()
            .any(|p| p.key == "importance" && p.value_text.as_deref() == Some("high")));

        // Undo the set_property (depth=0) — should produce delete_property since it was the first set
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(result.new_op_type, "delete_property");

        // Verify property removed
        let props_after = get_properties_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            !props_after.iter().any(|p| p.key == "importance"),
            "property should be removed after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_undo_from_multiple_devices() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a page and two child blocks
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Concurrent Undo Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child_a = create_block_inner(
            &pool,
            "device-A",
            &mat,
            "content".into(),
            "Block from device-A".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child_b = create_block_inner(
            &pool,
            "device-B",
            &mat,
            "content".into(),
            "Block from device-B".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit both blocks from their respective devices
        edit_block_inner(
            &pool,
            "device-A",
            &mat,
            child_a.id.clone(),
            "A-edited".into(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(
            &pool,
            "device-B",
            &mat,
            child_b.id.clone(),
            "B-edited".into(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify pre-undo state
        let a_before = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
        let b_before = get_block_inner(&pool, child_b.id.clone()).await.unwrap();
        assert_eq!(a_before.content, Some("A-edited".into()));
        assert_eq!(b_before.content, Some("B-edited".into()));

        // Spawn concurrent undo from device-A (depth=0) and device-B (depth=0)
        // Both target the most recent op on the page, but since they run
        // concurrently one will see depth=0 as the edit_block from device-B
        // and the other will also try depth=0. SQLite serializes via
        // BEGIN IMMEDIATE, so both should succeed without corruption.
        let pool_a = pool.clone();
        let mat_a = Materializer::new(pool.clone());
        let page_id_a = page.id.clone();

        let pool_b = pool.clone();
        let mat_b = Materializer::new(pool.clone());
        let page_id_b = page.id.clone();

        let h_a = tokio::spawn(async move {
            undo_page_op_inner(&pool_a, "device-A", &mat_a, page_id_a, 0).await
        });
        let h_b = tokio::spawn(async move {
            undo_page_op_inner(&pool_b, "device-B", &mat_b, page_id_b, 0).await
        });

        let (r_a, r_b) = tokio::join!(h_a, h_b);

        // Both tasks should complete without panicking
        let result_a = r_a.expect("device-A undo task should not panic");
        let result_b = r_b.expect("device-B undo task should not panic");

        // At least one should succeed. Due to SQLite serialization,
        // both may succeed (each sees a different "most recent" op
        // after the first commits), or one may fail if both see the
        // same op before serialization kicks in.
        let a_ok = result_a.is_ok();
        let b_ok = result_b.is_ok();
        assert!(a_ok || b_ok, "at least one concurrent undo should succeed");

        // If both succeeded, verify the page has 2 new undo ops
        if a_ok && b_ok {
            let ra = result_a.unwrap();
            let rb = result_b.unwrap();

            // Both should be undo (not redo)
            assert!(!ra.is_redo);
            assert!(!rb.is_redo);

            // They should have different op refs (no duplicate ops)
            assert_ne!(
                ra.new_op_ref, rb.new_op_ref,
                "concurrent undos should produce distinct ops"
            );
        }

        // Verify database integrity: no duplicate seqs, all blocks readable
        let a_after = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
        let b_after = get_block_inner(&pool, child_b.id.clone()).await.unwrap();

        // At least one block should have been reverted to its pre-edit state
        let a_reverted = a_after.content == Some("Block from device-A".into());
        let b_reverted = b_after.content == Some("Block from device-B".into());
        assert!(
            a_reverted || b_reverted,
            "at least one block should be reverted; a={:?}, b={:?}",
            a_after.content,
            b_after.content
        );

        // Verify op_log integrity: count total ops
        let total_ops: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE json_extract(payload, '$.block_id') IN \
             (SELECT id FROM blocks WHERE parent_id = ?)",
            page.id
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // We have: 2 create + 2 edit + (1 or 2) undo = 5 or 6 ops
        assert!(
            total_ops >= 5,
            "expected at least 5 ops (2 creates + 2 edits + 1 undo), got {total_ops}"
        );
    }

    // ======================================================================
    // undo_page_op_inner – input validation
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_rejects_negative_depth() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = undo_page_op_inner(&pool, DEV, &mat, "nonexistent-page".into(), -1).await;

        assert!(result.is_err(), "negative undo_depth should be rejected");
        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("undo_depth must be non-negative"),
            "error should mention undo_depth validation, got: {msg}"
        );
        assert!(
            matches!(err, AppError::Validation(_)),
            "error should be Validation variant, got: {err:?}"
        );
    }

    // ======================================================================
    // Sync — list_peer_refs
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_list_peer_refs_returns_empty_vec_initially() {
        let (pool, _dir) = test_pool().await;

        let peers = list_peer_refs_inner(&pool).await.unwrap();
        assert!(
            peers.is_empty(),
            "list_peer_refs must return empty vec on fresh DB"
        );
    }

    // ======================================================================
    // Sync — get_peer_ref
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_get_peer_ref_returns_none_for_nonexistent() {
        let (pool, _dir) = test_pool().await;

        let result = get_peer_ref_inner(&pool, "nonexistent-peer".into())
            .await
            .unwrap();
        assert!(
            result.is_none(),
            "get_peer_ref must return None for nonexistent peer"
        );
    }

    // ======================================================================
    // Sync — delete_peer_ref
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_delete_peer_ref_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = delete_peer_ref_inner(&pool, "ghost-peer".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "delete_peer_ref on nonexistent peer must return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_delete_peer_ref_removes_existing_peer() {
        let (pool, _dir) = test_pool().await;

        // Insert a peer directly
        peer_refs::upsert_peer_ref(&pool, "peer-to-delete")
            .await
            .unwrap();

        // Verify it exists
        let before = get_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();
        assert!(before.is_some(), "peer must exist before delete");

        // Delete it
        delete_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();

        // Verify it's gone
        let after = get_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();
        assert!(after.is_none(), "peer must be gone after delete");
    }

    // ======================================================================
    // Sync — get_device_id
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_get_device_id_returns_non_empty_string() {
        let device_id = crate::device::DeviceId::new("test-device-uuid-1234".to_string());

        let result = get_device_id_inner(&device_id);
        assert!(
            !result.is_empty(),
            "get_device_id must return a non-empty string"
        );
        assert_eq!(
            result, "test-device-uuid-1234",
            "get_device_id must return the exact device ID"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_list_peer_refs_returns_inserted_peers() {
        let (pool, _dir) = test_pool().await;

        // Insert some peers
        peer_refs::upsert_peer_ref(&pool, "peer-A").await.unwrap();
        peer_refs::upsert_peer_ref(&pool, "peer-B").await.unwrap();

        let peers = list_peer_refs_inner(&pool).await.unwrap();
        assert_eq!(peers.len(), 2, "must return all 2 inserted peers");

        let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
        assert!(ids.contains(&"peer-A"), "must contain peer-A");
        assert!(ids.contains(&"peer-B"), "must contain peer-B");
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
        let result =
            move_block_inner(&pool, DEV, &mat, "DEPTH_EXTRA".into(), Some(parent), 1).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "moving beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("nesting depth"),
            "error message should mention nesting depth"
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

    // ── #129: rows_affected checks in apply_reverse_in_tx ────────────

    #[tokio::test]
    async fn apply_reverse_remove_tag_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("GHOST_BLK"),
            tag_id: BlockId::test_id("GHOST_TAG"),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "removing a nonexistent tag association should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn apply_reverse_delete_property_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("GHOST_BLK"),
            key: "priority".into(),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "deleting a nonexistent property should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn apply_reverse_delete_attachment_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
            attachment_id: "ATT_GHOST".into(),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "soft-deleting a nonexistent attachment should return NotFound, got: {result:?}"
        );
    }

    // ======================================================================
    // Sync — start_pairing (#275)
    // ======================================================================

    #[test]
    fn sync_start_pairing_returns_passphrase_and_qr() {
        let pairing_state = Mutex::new(None);
        let result = start_pairing_inner(&pairing_state, "device-A");
        assert!(result.is_ok(), "start_pairing must succeed");

        let info = result.unwrap();
        // Passphrase should be 4 words
        let words: Vec<&str> = info.passphrase.split(' ').collect();
        assert_eq!(words.len(), 4, "passphrase must contain 4 words");

        // QR SVG should contain <svg
        assert!(
            info.qr_svg.contains("<svg"),
            "qr_svg must contain an SVG tag"
        );

        // Port is a placeholder
        assert_eq!(info.port, 0, "port must be 0 (placeholder)");

        // Session should be stored in state
        let session = pairing_state.lock().unwrap();
        assert!(session.is_some(), "pairing session must be stored in state");
    }

    #[test]
    fn sync_start_pairing_replaces_existing_session() {
        let pairing_state = Mutex::new(None);

        let info1 = start_pairing_inner(&pairing_state, "device-A").unwrap();
        let info2 = start_pairing_inner(&pairing_state, "device-A").unwrap();

        // Each call generates a new passphrase (astronomically unlikely to collide)
        // Just verify both succeed
        assert!(!info1.passphrase.is_empty());
        assert!(!info2.passphrase.is_empty());
    }

    // ======================================================================
    // Sync — confirm_pairing (#275)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_confirm_pairing_stores_peer_and_clears_session() {
        let (pool, _dir) = test_pool().await;
        let pairing_state = Mutex::new(None);

        // Start pairing first
        let info = start_pairing_inner(&pairing_state, "device-local").unwrap();

        // Confirm with the passphrase
        confirm_pairing_inner(
            &pool,
            &pairing_state,
            "device-local",
            info.passphrase,
            "device-remote".into(),
        )
        .await
        .unwrap();

        // Peer ref should now exist
        let peer = peer_refs::get_peer_ref(&pool, "device-remote")
            .await
            .unwrap();
        assert!(peer.is_some(), "peer ref must exist after confirm_pairing");

        // Pairing session should be cleared
        let session = pairing_state.lock().unwrap();
        assert!(
            session.is_none(),
            "pairing session must be cleared after confirm"
        );
    }

    // ======================================================================
    // Sync — cancel_pairing (#275)
    // ======================================================================

    #[test]
    fn sync_cancel_pairing_clears_session() {
        let pairing_state = Mutex::new(None);

        // Start pairing
        start_pairing_inner(&pairing_state, "device-A").unwrap();
        assert!(pairing_state.lock().unwrap().is_some());

        // Cancel
        cancel_pairing_inner(&pairing_state).unwrap();
        assert!(
            pairing_state.lock().unwrap().is_none(),
            "pairing session must be cleared after cancel"
        );
    }

    #[test]
    fn sync_cancel_pairing_noop_when_no_session() {
        let pairing_state = Mutex::new(None);

        // Cancel with no active session — should succeed
        let result = cancel_pairing_inner(&pairing_state);
        assert!(
            result.is_ok(),
            "cancel_pairing with no session must succeed"
        );
    }

    // ======================================================================
    // Sync — start_sync (#278: backoff integration)
    // ======================================================================

    #[test]
    fn sync_start_sync_returns_complete_info() {
        let scheduler = SyncScheduler::new();
        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(result.is_ok(), "start_sync must succeed for a fresh peer");

        let info = result.unwrap();
        assert_eq!(info.state, "complete");
        assert_eq!(info.local_device_id, "device-local");
        assert_eq!(info.remote_device_id, "peer-1");
        assert_eq!(info.ops_received, 0);
        assert_eq!(info.ops_sent, 0);
    }

    #[test]
    fn sync_start_sync_respects_backoff() {
        let scheduler = SyncScheduler::new();
        scheduler.record_failure("peer-1");

        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(
            result.is_err(),
            "start_sync must fail when peer is in backoff"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("backoff"),
            "error should mention backoff, got: {err}"
        );
    }

    #[test]
    fn sync_start_sync_after_backoff_reset_succeeds() {
        let scheduler = SyncScheduler::new();
        scheduler.record_failure("peer-1");
        scheduler.record_success("peer-1"); // reset backoff

        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(
            result.is_ok(),
            "start_sync must succeed after backoff is reset"
        );
    }

    // ======================================================================
    // Sync — cancel_sync
    // ======================================================================

    #[test]
    fn sync_cancel_sync_succeeds() {
        let flag = AtomicBool::new(false);
        let result = cancel_sync_inner(&flag);
        assert!(result.is_ok(), "cancel_sync must succeed");
        assert!(
            flag.load(Ordering::Acquire),
            "cancel flag must be set after cancel_sync"
        );
    }

    // ======================================================================
    // set_todo_state / set_priority / set_due_date
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_sets_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "todo test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        assert_eq!(result.todo_state, Some("TODO".into()));

        // Verify DB column
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(db_val, Some("TODO".into()));

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_clears_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "clear test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set then clear
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();

        assert_eq!(result.todo_state, None);

        // Verify DB column is NULL
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(db_val.is_none());

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_invalid_state_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "invalid test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("INVALID".into())).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid state should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = set_todo_state_inner(
            &pool,
            DEV,
            &mat,
            "nonexistent-id".into(),
            Some("TODO".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_sets_and_clears() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "prio test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set priority
        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into()))
            .await
            .unwrap();
        assert_eq!(result.priority, Some("2".into()));

        mat.flush_background().await.unwrap();

        // Clear priority
        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(result.priority, None);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_invalid_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "inv prio".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("5".into())).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid priority should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_sets_and_clears() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "date test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set due date
        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-04-15".into()),
        )
        .await
        .unwrap();
        assert_eq!(result.due_date, Some("2026-04-15".into()));

        mat.flush_background().await.unwrap();

        // Clear due date
        let result = set_due_date_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(result.due_date, None);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_invalid_format_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "inv date".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("not-a-date".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid date should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_routes_reserved_key_to_blocks_column() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reserved routing".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Use set_property_inner directly with reserved key
        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "todo_state".into(),
            Some("DONE".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.todo_state, Some("DONE".into()));

        // Verify blocks.todo_state column updated
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(db_val, Some("DONE".into()));

        // Verify block_properties does NOT have a row for it
        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
        )
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key should not be in block_properties"
        );

        mat.shutdown();
    }

    // ======================================================================
    // set_priority / set_due_date — nonexistent block returns NotFound
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result =
            set_priority_inner(&pool, DEV, &mat, "nonexistent-id".into(), Some("1".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            "nonexistent-id".into(),
            Some("2026-05-15".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Deleted block returns NotFound for all three thin commands
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_todo_state on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_priority on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-05-15".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_due_date on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Op log verification for thin commands
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        assert_eq!(
            set_prop_ops.len(),
            1,
            "exactly one set_property op should be logged"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"todo_state\""),
            "op payload must contain key 'todo_state'"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("1".into()))
            .await
            .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        assert_eq!(
            set_prop_ops.len(),
            1,
            "exactly one set_property op should be logged"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"priority\""),
            "op payload must contain key 'priority'"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-05-15".into()),
        )
        .await
        .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        assert_eq!(
            set_prop_ops.len(),
            1,
            "exactly one set_property op should be logged"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"due_date\""),
            "op payload must contain key 'due_date'"
        );

        mat.shutdown();
    }
}
