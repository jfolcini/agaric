//! Tauri command handlers for the block-notes app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use std::collections::HashMap;

use chrono::Utc;
use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::fts;
use crate::materializer::{Materializer, StatusInfo};
use crate::now_rfc3339;
use crate::op::{
    validate_set_property, AddTagPayload, CreateBlockPayload, DeleteBlockPayload,
    DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload, PurgeBlockPayload,
    RemoveTagPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
#[cfg(test)]
use crate::soft_delete;
use crate::tag_query::{self, TagCacheRow, TagExpr};
use crate::ulid::BlockId;

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
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: block_id.as_str().to_owned(),
        block_type: block_type.clone(),
        parent_id: parent_id.clone(),
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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let block_type = existing.block_type;
    let parent_id = existing.parent_id;
    let position = existing.position;

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
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id.clone(),
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
        block_id: block_id.clone(),
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

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // Cascade soft-delete within same transaction
    let now = now_rfc3339();
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
        block_id: block_id.clone(),
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
        block_id: block_id.clone(),
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
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: block_id.clone(),
        new_parent_id: parent_id.clone(),
        new_position,
    });

    // 7. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ?"#,
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
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
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
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
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
) -> Result<Vec<TagCacheRow>, AppError> {
    tag_query::list_tags_by_prefix(pool, &prefix).await
}

/// List all tag_ids currently associated with a block.
pub async fn list_tags_for_block_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<String>, AppError> {
    tag_query::list_tags_for_block(pool, &block_id).await
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
        block_id: block_id.clone(),
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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, archived_at, is_conflict as "is_conflict: bool" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
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

    // 5. Materialize: upsert into block_properties
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
    })
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
        block_id: block_id.clone(),
        key: key.clone(),
    });
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Materialize: delete from block_properties
    sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
        .bind(&block_id)
        .bind(&key)
        .execute(&mut *tx)
        .await?;

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
        &device_id.0,
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
    edit_block_inner(&pool.0, &device_id.0, &materializer, block_id, to_text)
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
    delete_block_inner(&pool.0, &device_id.0, &materializer, block_id)
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
        &device_id.0,
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
    purge_block_inner(&pool.0, &device_id.0, &materializer, block_id)
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
        &device_id.0,
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
    add_tag_inner(&pool.0, &device_id.0, &materializer, block_id, tag_id)
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
    remove_tag_inner(&pool.0, &device_id.0, &materializer, block_id, tag_id)
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
) -> Result<Vec<TagCacheRow>, AppError> {
    list_tags_by_prefix_inner(&pool.0, prefix)
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
        &device_id.0,
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
    delete_property_inner(&pool.0, &device_id.0, &materializer, block_id, key)
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

        let result = list_tags_by_prefix_inner(&pool, "work/".into())
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "work/email");
        assert_eq!(result[1].name, "work/meeting");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = list_tags_by_prefix_inner(&pool, "nonexistent/".into())
            .await
            .unwrap();

        assert!(result.is_empty());
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
            "priority".into(),
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
        assert_eq!(props[0].key, "priority");
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
            "priority".into(),
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
        assert_eq!(result[&b1.id][0].key, "priority");
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
            "priority".into(),
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
        assert!(keys.contains(&"priority"), "must contain priority");
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
}
