//! History command handlers.

use sqlx::SqlitePool;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{OpPayload, OpRef, UndoResult};
use crate::op_log;
use crate::pagination;
use crate::pagination::HistoryEntry;
use crate::pagination::PageResponse;
use crate::ulid::BlockId;

use super::*;

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
    let mut op_records = Vec::with_capacity(reverses.len());

    for (op_ref, reverse_payload, _created_at) in reverses {
        let new_op_type = reverse_payload.op_type_str().to_owned();

        // Apply to blocks/tags/properties tables (borrows)
        apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

        // Append reverse op to log (consumes)
        let op_record =
            op_log::append_local_op_in_tx(&mut tx, device_id, reverse_payload, now_rfc3339())
                .await?;

        results.push(UndoResult {
            reversed_op: op_ref,
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
        if let Err(e) = materializer.dispatch_background(record) {
            tracing::warn!(error = %e, "failed to dispatch background cache task");
        }
    }

    Ok(results)
}

/// Restore a page to its state at a specific operation (point-in-time restore).
///
/// Finds all ops that occurred AFTER the target op on blocks belonging to the
/// given page (or all blocks if `page_id == "__all__"`), filters out non-reversible
/// ops, and calls `revert_ops_inner()` with the remainder.
pub async fn restore_page_to_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    target_device_id: String,
    target_seq: i64,
) -> Result<RestoreToOpResult, AppError> {
    // Fetch the target op's created_at timestamp
    let target_record = op_log::get_op_by_seq(pool, &target_device_id, target_seq).await?;
    let target_ts = &target_record.created_at;

    // Query all ops after the target.
    // NOTE: We intentionally do NOT filter by deleted_at IS NULL in the blocks subquery.
    // We need to find ops on blocks that may have been deleted after the target point,
    // since restoring to that point means un-deleting those blocks.
    let ops_after: Vec<(String, i64, String)> = if page_id == "__all__" {
        sqlx::query_as::<_, (String, i64, String)>(
            "SELECT device_id, seq, op_type FROM op_log \
             WHERE (created_at > ?1 OR (created_at = ?1 AND (seq > ?2 OR (seq = ?2 AND device_id > ?3)))) \
             ORDER BY created_at DESC, seq DESC, device_id DESC",
        )
        .bind(target_ts)
        .bind(target_seq)
        .bind(&target_device_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, (String, i64, String)>(
            "WITH RECURSIVE page_blocks(id) AS ( \
               SELECT id FROM blocks WHERE id = ?1 \
               UNION ALL \
               SELECT b.id FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             ) \
             SELECT o.device_id, o.seq, o.op_type FROM op_log o \
             WHERE json_extract(o.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
             AND (o.created_at > ?2 OR (o.created_at = ?2 AND (o.seq > ?3 OR (o.seq = ?3 AND o.device_id > ?4)))) \
             ORDER BY o.created_at DESC, o.seq DESC, o.device_id DESC",
        )
        .bind(&page_id)
        .bind(target_ts)
        .bind(target_seq)
        .bind(&target_device_id)
        .fetch_all(pool)
        .await?
    };

    // Separate reversible from non-reversible ops
    let non_reversible = ["purge_block", "delete_attachment"];
    let mut reversible_ops = Vec::new();
    let mut non_reversible_count: u64 = 0;

    for (dev_id, seq, op_type) in &ops_after {
        if non_reversible.contains(&op_type.as_str()) {
            non_reversible_count += 1;
        } else {
            reversible_ops.push(OpRef {
                device_id: dev_id.clone(),
                seq: *seq,
            });
        }
    }

    // Revert the reversible ops using existing infrastructure
    let results = if reversible_ops.is_empty() {
        vec![]
    } else {
        revert_ops_inner(pool, device_id, materializer, reversible_ops).await?
    };

    Ok(RestoreToOpResult {
        ops_reverted: results.len() as u64,
        non_reversible_skipped: non_reversible_count,
        results,
    })
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
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

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
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

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

/// Tauri command: point-in-time restore. Delegates to [`restore_page_to_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_page_to_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    page_id: String,
    target_device_id: String,
    target_seq: i64,
) -> Result<RestoreToOpResult, AppError> {
    restore_page_to_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        page_id,
        target_device_id,
        target_seq,
    )
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
