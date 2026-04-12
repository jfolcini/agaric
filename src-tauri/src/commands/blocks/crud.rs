use crate::db::WritePool;
use crate::device::DeviceId;
use crate::op::{
    validate_set_property, CreateBlockPayload, DeleteBlockPayload, EditBlockPayload,
    PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};

use super::super::*;

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
/// Create a new block inside an existing transaction.
///
/// This is the core implementation shared by [`create_block_inner`] (which
/// wraps it in its own transaction) and the recurrence path in
/// [`set_todo_state_inner`] (which batches multiple operations in one tx).
///
/// Returns the new [`BlockRow`] and the [`op_log::OpRecord`] so the caller
/// can commit the transaction and dispatch background work afterward.
pub(crate) async fn create_block_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
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

    // F01: Validate parent_id inside the transaction to prevent TOCTOU race.
    // A concurrent purge_block could physically delete the parent between
    // our check and the INSERT, violating the FK constraint.
    if let Some(ref pid) = parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut **tx)
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
                 WHERE parent_id IS ? AND deleted_at IS NULL AND position < 9223372036854775807",
                parent_id
            )
            .fetch_optional(&mut **tx)
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

    let op_record = op_log::append_local_op_in_tx(tx, device_id, payload, now_rfc3339()).await?;

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
    .execute(&mut **tx)
    .await?;

    // P-4: Inherit parent tags for the new block
    crate::tag_inheritance::inherit_parent_tags(tx, block_id.as_str(), parent_id.as_deref())
        .await?;

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: block_id.into_string(),
            block_type,
            content: Some(content),
            parent_id,
            position: Some(effective_position),
            deleted_at: None,
            is_conflict: false,
            conflict_type: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
        },
        op_record,
    ))
}

pub async fn create_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockRow, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let (block, op_record) =
        create_block_in_tx(&mut tx, device_id, block_type, content, parent_id, position).await?;
    tx.commit().await?;
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }
    Ok(block)
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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
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
    if let Err(e) = materializer.dispatch_edit_background(&op_record, &block_type) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

    // 6. Return response
    Ok(BlockRow {
        id: block_id,
        block_type,
        content: Some(to_text),
        parent_id,
        position,
        deleted_at: None,
        is_conflict: false,
        conflict_type: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
    })
}

/// Soft-delete a block and all its descendants (cascade).
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

    // P-4: Remove inherited entries for soft-deleted subtree
    crate::tag_inheritance::remove_subtree_inherited(&mut tx, &block_id).await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

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
            if let Some(ref actual_deleted_at) = r.deleted_at {
                if *actual_deleted_at != deleted_at_ref {
                    return Err(AppError::InvalidOperation(format!(
                        "block '{block_id}' deleted_at mismatch: expected '{}', got '{}'",
                        deleted_at_ref, actual_deleted_at
                    )));
                }
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

    // P-4: Recompute inherited tags for restored subtree
    crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &block_id).await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

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

    // block_tag_inherited (P-4)
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR inherited_from IN (SELECT id FROM descendants)"
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

    // page_aliases
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM descendants)"
    ))
    .bind(&block_id)
    .execute(&mut *tx)
    .await?;

    // projected_agenda_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM projected_agenda_cache \
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
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

/// Restore ALL soft-deleted blocks in a single transaction.
///
/// Finds root-level deleted blocks (those whose parent is not deleted with the
/// same timestamp), creates a `RestoreBlock` op for each, then clears
/// `deleted_at` on ALL deleted blocks. Recomputes tag inheritance afterward.
pub async fn restore_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Find root-level deleted blocks for op-log entries.
    // A "root" is a deleted block whose parent is either NULL, doesn't exist,
    // or has a different deleted_at (i.e., wasn't cascade-deleted together).
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           b.parent_id IS NULL \
           OR NOT EXISTS ( \
             SELECT 1 FROM blocks p \
             WHERE p.id = b.parent_id \
             AND p.deleted_at = b.deleted_at \
           ) \
         )"
    )
    .fetch_all(&mut *tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = now_rfc3339();
    let mut op_records = Vec::new();
    // Append one RestoreBlock op per root for sync compatibility
    for root in &roots {
        let deleted_at_ref = root.deleted_at.clone().unwrap_or_default();
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
            deleted_at_ref,
        });
        let op_record =
            op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;
        op_records.push(op_record);
    }

    // Bulk restore: clear deleted_at on ALL deleted blocks
    let result = sqlx::query!("UPDATE blocks SET deleted_at = NULL WHERE deleted_at IS NOT NULL")
        .execute(&mut *tx)
        .await?;

    let count = result.rows_affected();

    // Recompute tag inheritance for all restored root blocks
    for root in &roots {
        crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &root.id).await?;
    }

    tx.commit().await?;

    // Dispatch background cache tasks for each root
    for op_record in &op_records {
        if let Err(e) = materializer.dispatch_background(op_record) {
            tracing::warn!(error = %e, "failed to dispatch background cache task");
        }
    }

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Permanently purge ALL soft-deleted blocks in a single transaction.
///
/// Creates `PurgeBlock` ops for root-level deleted blocks, then bulk-deletes
/// all dependent rows and the blocks themselves. Irreversible.
pub async fn purge_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Find root-level deleted blocks for op-log entries
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           b.parent_id IS NULL \
           OR NOT EXISTS ( \
             SELECT 1 FROM blocks p \
             WHERE p.id = b.parent_id \
             AND p.deleted_at = b.deleted_at \
           ) \
         )"
    )
    .fetch_all(&mut *tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = now_rfc3339();
    let mut op_records = Vec::new();
    for root in &roots {
        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
        });
        let op_record =
            op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;
        op_records.push(op_record);
    }

    // Defer FK checks until commit
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // The deleted block set — used for all cleanup queries below.
    // Since we're purging ALL deleted blocks (and their descendants are also
    // deleted), we can use a simple `deleted_at IS NOT NULL` predicate instead
    // of per-block recursive CTEs.
    let deleted_set = "SELECT id FROM blocks WHERE deleted_at IS NOT NULL";

    // block_tags
    sqlx::query(&format!(
        "DELETE FROM block_tags WHERE block_id IN ({deleted_set}) OR tag_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // block_tag_inherited
    sqlx::query(&format!(
        "DELETE FROM block_tag_inherited WHERE block_id IN ({deleted_set}) OR inherited_from IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // block_properties: owned by deleted blocks
    sqlx::query(&format!(
        "DELETE FROM block_properties WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // block_properties: value_ref pointing to deleted blocks
    sqlx::query(&format!(
        "UPDATE block_properties SET value_ref = NULL WHERE value_ref IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // block_links
    sqlx::query(&format!(
        "DELETE FROM block_links WHERE source_id IN ({deleted_set}) OR target_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // agenda_cache
    sqlx::query(&format!(
        "DELETE FROM agenda_cache WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // tags_cache
    sqlx::query(&format!(
        "DELETE FROM tags_cache WHERE tag_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // pages_cache
    sqlx::query(&format!(
        "DELETE FROM pages_cache WHERE page_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // Collect attachment paths BEFORE deleting rows
    let attachment_rows = sqlx::query_scalar::<_, String>(
        "SELECT fs_path FROM attachments WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)",
    )
    .fetch_all(&mut *tx)
    .await?;

    // attachments
    sqlx::query(&format!(
        "DELETE FROM attachments WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // block_drafts
    sqlx::query(&format!(
        "DELETE FROM block_drafts WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // Nullify conflict_source refs from non-deleted blocks
    sqlx::query(&format!(
        "UPDATE blocks SET conflict_source = NULL WHERE conflict_source IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // fts_blocks
    sqlx::query(&format!(
        "DELETE FROM fts_blocks WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // page_aliases
    sqlx::query(&format!(
        "DELETE FROM page_aliases WHERE page_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // projected_agenda_cache
    sqlx::query(&format!(
        "DELETE FROM projected_agenda_cache WHERE block_id IN ({deleted_set})"
    ))
    .execute(&mut *tx)
    .await?;

    // Delete all deleted blocks
    let result = sqlx::query!("DELETE FROM blocks WHERE deleted_at IS NOT NULL")
        .execute(&mut *tx)
        .await?;

    let count = result.rows_affected();
    tx.commit().await?;

    // Post-commit: delete physical attachment files
    for path in &attachment_rows {
        let p = std::path::Path::new(path.as_str());
        if p.is_absolute()
            || p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            tracing::warn!(path, "skipping attachment deletion: unsafe path");
            continue;
        }
        if let Err(e) = std::fs::remove_file(path) {
            tracing::warn!(path, error = %e, "failed to remove attachment file after purge");
        }
    }

    // Dispatch background cache tasks
    for op_record in &op_records {
        if let Err(e) = materializer.dispatch_background(op_record) {
            tracing::warn!(error = %e, "failed to dispatch background cache task");
        }
    }

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Set (upsert) a property on a block inside an existing transaction.
///
/// This is the core implementation shared by [`set_property_inner`] (which
/// wraps it in its own transaction) and the recurrence path in
/// [`set_todo_state_inner`] (which batches multiple operations in one tx).
///
/// Returns the updated [`BlockRow`] and the [`op_log::OpRecord`] so the
/// caller can commit the transaction and dispatch background work afterward.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Build and validate the payload before touching the DB
    let prop_payload = SetPropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.to_owned(),
        value_text: value_text.clone(),
        value_num,
        value_date: value_date.clone(),
        value_ref: value_ref.clone(),
    };
    validate_set_property(&prop_payload)?;

    // 1b. Date format validation
    if let Some(ref date_str) = value_date {
        if !is_valid_iso_date(date_str) {
            return Err(AppError::Validation(format!(
                "Invalid date format: '{}'. Expected YYYY-MM-DD.",
                date_str
            )));
        }
    }

    // 1c. Reserved key field validation (skip for clear operations where all values are None)
    let is_clear =
        value_text.is_none() && value_num.is_none() && value_date.is_none() && value_ref.is_none();
    if !is_clear {
        match key {
            "due_date" | "scheduled_date" => {
                if value_date.is_none() {
                    return Err(AppError::Validation(format!(
                        "Property '{}' requires value_date, not value_text/value_num/value_ref.",
                        key
                    )));
                }
            }
            "todo_state" | "priority" => {
                if value_text.is_none() {
                    return Err(AppError::Validation(format!(
                        "Property '{}' requires value_text, not value_date/value_num/value_ref.",
                        key
                    )));
                }
            }
            _ => {}
        }
    }

    // 1d. Type validation against property_definitions (non-reserved keys only)
    if !is_clear && !is_reserved_property_key(key) {
        let def_type: Option<String> =
            sqlx::query_scalar("SELECT value_type FROM property_definitions WHERE key = ?")
                .bind(key)
                .fetch_optional(&mut **tx)
                .await?;

        if let Some(expected_type) = def_type {
            let type_matches = match expected_type.as_str() {
                "text" | "select" => value_text.is_some() || value_ref.is_some(),
                "ref" => value_ref.is_some(),
                "number" => value_num.is_some(),
                "date" => value_date.is_some(),
                _ => true,
            };
            if !type_matches {
                let actual_type = if value_text.is_some() {
                    "text"
                } else if value_num.is_some() {
                    "number"
                } else if value_date.is_some() {
                    "date"
                } else if value_ref.is_some() {
                    "ref"
                } else {
                    "unknown"
                };
                return Err(AppError::Validation(format!(
                    "Property '{}' expects type '{}', got '{}'.",
                    key, expected_type, actual_type
                )));
            }
        }
    }

    // 2. Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;

    // 3. Append SetProperty op to the op_log
    let payload = OpPayload::SetProperty(prop_payload);
    let op_record = op_log::append_local_op_in_tx(tx, device_id, payload, now_rfc3339()).await?;

    // 4. Materialize: route reserved keys to blocks columns, others to block_properties
    if is_reserved_property_key(key) {
        let col = match key {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            "scheduled_date" => "scheduled_date",
            _ => unreachable!(),
        };
        let value = match col {
            "due_date" | "scheduled_date" => &value_date,
            _ => &value_text,
        };
        sqlx::query(&format!("UPDATE blocks SET {col} = ? WHERE id = ?"))
            .bind(value)
            .bind(&block_id)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&block_id)
        .bind(key)
        .bind(&value_text)
        .bind(value_num)
        .bind(&value_date)
        .bind(&value_ref)
        .execute(&mut **tx)
        .await?;
    }

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: existing.id,
            block_type: existing.block_type,
            content: existing.content,
            parent_id: existing.parent_id,
            position: existing.position,
            deleted_at: existing.deleted_at,
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
            scheduled_date: if key == "scheduled_date" {
                value_date.clone()
            } else {
                existing.scheduled_date
            },
        },
        op_record,
    ))
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

/// Tauri command: restore all soft-deleted blocks. Delegates to [`restore_all_deleted_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_all_deleted(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<BulkTrashResponse, AppError> {
    restore_all_deleted_inner(&pool.0, device_id.as_str(), &materializer)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge all soft-deleted blocks. Delegates to [`purge_all_deleted_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn purge_all_deleted(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<BulkTrashResponse, AppError> {
    purge_all_deleted_inner(&pool.0, device_id.as_str(), &materializer)
        .await
        .map_err(sanitize_internal_error)
}
