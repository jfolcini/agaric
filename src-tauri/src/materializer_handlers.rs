//! Extracted handler functions for the materializer queues.
//!
//! These are pure task handlers — they do not access the `Materializer` struct
//! and only operate on the SQLite pool via the arguments they receive.

use sqlx::SqlitePool;

use crate::cache;
use crate::error::AppError;
use crate::fts;
use crate::materializer::{MaterializeTask, QueueMetrics};
use crate::op::{
    is_reserved_property_key, AddAttachmentPayload, AddTagPayload, CreateBlockPayload,
    DeleteAttachmentPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpType, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::tag_inheritance;

pub(crate) async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    _metrics: &QueueMetrics,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            // Phase 4: apply remote ops to the blocks table.
            // Remote ops arrive as raw op_log entries without going through
            // the command layer, so the materializer must apply them.
            // Uses INSERT OR IGNORE / idempotent patterns so local ops that
            // were already applied by command handlers are harmless no-ops.
            if let Err(e) = apply_op(pool, record).await {
                tracing::warn!(
                    op_type = %record.op_type,
                    seq = record.seq,
                    error = %e,
                    "failed to apply remote op — will retry"
                );
                return Err(e);
            }
            Ok(())
        }
        MaterializeTask::BatchApplyOps(records) => {
            let mut failed = 0u32;
            let mut last_err = None;
            for record in records {
                if let Err(e) = apply_op(pool, record).await {
                    tracing::warn!(
                        op_type = %record.op_type,
                        seq = record.seq,
                        error = %e,
                        "failed to apply remote op in batch — will retry batch"
                    );
                    failed += 1;
                    last_err = Some(e);
                }
            }
            match last_err {
                Some(e) => {
                    tracing::warn!(failed_count = failed, "batch had failures");
                    Err(e)
                }
                None => Ok(()),
            }
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
        _ => {
            // Foreground queue shouldn't receive non-ApplyOp tasks
            tracing::warn!(?task, "unexpected task in foreground queue");
            Ok(())
        }
    }
}

/// Apply a single op record to the materialized tables (blocks, block_tags,
/// block_properties, attachments).
///
/// Parses the `op_type` string to [`OpType`], deserializes the JSON `payload`
/// to the matching payload struct, then executes the appropriate SQL.
///
/// Uses idempotent patterns (`INSERT OR IGNORE`, `deleted_at IS NULL` guards)
/// so that re-applying an op that was already materialized by the local
/// command handler is a harmless no-op.
pub(crate) async fn apply_op(pool: &SqlitePool, record: &OpRecord) -> Result<(), AppError> {
    use std::str::FromStr;

    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::Validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;

    match op_type {
        OpType::CreateBlock => {
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
                 VALUES (?, ?, ?, ?, ?, 0)",
            )
            .bind(p.block_id.as_str())
            .bind(&p.block_type)
            .bind(&p.content)
            .bind(parent_id_str.as_deref())
            .bind(p.position)
            .execute(pool)
            .await?;
            // P-4: Inherit parent tags for the new block
            let parent_str = parent_id_str.as_deref();
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::inherit_parent_tags(&mut conn, p.block_id.as_str(), parent_str)
                    .await?;
            }
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
                .bind(&p.to_text)
                .bind(p.block_id.as_str())
                .execute(pool)
                .await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            let now = &record.created_at;
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
            .bind(now)
            .execute(pool)
            .await?;
            // P-4: Remove inherited entries for soft-deleted subtree
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::remove_subtree_inherited(&mut conn, p.block_id.as_str()).await?;
            }
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
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
            .execute(pool)
            .await?;
            // P-4: Recompute inherited tags for restored subtree
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::recompute_subtree_inheritance(&mut conn, p.block_id.as_str())
                    .await?;
            }
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            let block_id = p.block_id.as_str();

            // Wrap the entire cascade in a transaction for atomicity.
            // Without this, a mid-cascade failure would leave partially-purged
            // data. Mirrors the IMMEDIATE transaction in commands::purge_block_inner.
            let mut tx = pool.begin().await?;

            // Defer FK checks until commit — the entire subtree will be gone.
            sqlx::query("PRAGMA defer_foreign_keys = ON")
                .execute(&mut *tx)
                .await?;

            const DESC_CTE: &str = "WITH RECURSIVE descendants(id) AS ( \
                SELECT id FROM blocks WHERE id = ? \
                UNION ALL \
                SELECT b.id FROM blocks b \
                INNER JOIN descendants d ON b.parent_id = d.id \
            )";

            // block_tags
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_tags \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR tag_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_tag_inherited (P-4)
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_tag_inherited \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR inherited_from IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_properties
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_properties \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_properties: value_ref pointing into subtree
            sqlx::query(&format!(
                "{DESC_CTE} UPDATE block_properties SET value_ref = NULL \
                 WHERE value_ref IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_links
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_links \
                 WHERE source_id IN (SELECT id FROM descendants) \
                    OR target_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // agenda_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM agenda_cache \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // tags_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM tags_cache \
                 WHERE tag_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // pages_cache
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM pages_cache \
                 WHERE page_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // attachments
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM attachments \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // block_drafts
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM block_drafts \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // Nullify conflict_source refs
            sqlx::query(&format!(
                "{DESC_CTE} UPDATE blocks SET conflict_source = NULL \
                 WHERE conflict_source IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // FTS
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM fts_blocks \
                 WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            // Finally delete blocks
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM blocks \
                 WHERE id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                .bind(new_parent_str.as_deref())
                .bind(p.new_position)
                .bind(p.block_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Recompute inherited tags for the moved subtree
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::recompute_subtree_inheritance(&mut conn, p.block_id.as_str())
                    .await?;
            }
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Propagate inherited tag to descendants
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::propagate_tag_to_descendants(
                    &mut conn,
                    p.block_id.as_str(),
                    p.tag_id.as_str(),
                )
                .await?;
            }
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(pool)
                .await?;
            // P-4: Clean up inherited tag entries
            {
                let mut conn = pool.acquire().await?;
                tag_inheritance::remove_inherited_tag(
                    &mut conn,
                    p.block_id.as_str(),
                    p.tag_id.as_str(),
                )
                .await?;
            }
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            if is_reserved_property_key(&p.key) {
                let col = match p.key.as_str() {
                    "todo_state" => "todo_state",
                    "priority" => "priority",
                    "due_date" => "due_date",
                    "scheduled_date" => "scheduled_date",
                    _ => unreachable!(),
                };
                let value = match col {
                    "due_date" | "scheduled_date" => &p.value_date,
                    _ => &p.value_text,
                };
                sqlx::query(&format!("UPDATE blocks SET {col} = ? WHERE id = ?"))
                    .bind(value)
                    .bind(p.block_id.as_str())
                    .execute(pool)
                    .await?;
            } else {
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
                .execute(pool)
                .await?;
            }
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            if is_reserved_property_key(&p.key) {
                let col = match p.key.as_str() {
                    "todo_state" => "todo_state",
                    "priority" => "priority",
                    "due_date" => "due_date",
                    "scheduled_date" => "scheduled_date",
                    _ => unreachable!(),
                };
                sqlx::query(&format!("UPDATE blocks SET {col} = NULL WHERE id = ?"))
                    .bind(p.block_id.as_str())
                    .execute(pool)
                    .await?;
            } else {
                sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                    .bind(p.block_id.as_str())
                    .bind(&p.key)
                    .execute(pool)
                    .await?;
            }
        }
        OpType::AddAttachment => {
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query(
                "INSERT OR IGNORE INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&p.attachment_id)
            .bind(p.block_id.as_str())
            .bind(&p.filename)
            .bind(&p.fs_path)
            .bind(&p.mime_type)
            .bind(p.size_bytes)
            .bind(&record.created_at)
            .execute(pool)
            .await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(&p.attachment_id)
                .execute(pool)
                .await?;
        }
    }

    tracing::debug!(
        op_type = %record.op_type,
        seq = record.seq,
        "applied op to materialized tables"
    );

    Ok(())
}

/// Scan the attachments directory, cross-reference with the database,
/// and delete files with no matching row.
pub(crate) async fn cleanup_orphaned_attachments(pool: &SqlitePool) -> Result<(), AppError> {
    // For now, this is a no-op placeholder — the actual file scanning
    // requires access to the app data directory path, which is not
    // available in the materializer context. The infrastructure is in
    // place for when the file storage convention is established (F-7/F-9).
    //
    // Implementation plan:
    // 1. List all files in attachments/ directory
    // 2. Query all fs_path values from attachments table
    // 3. Delete files not in the DB set
    let _ = pool;
    tracing::debug!("orphaned attachment cleanup: no-op (file storage not yet established)");
    Ok(())
}

pub(crate) async fn handle_background_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::RebuildTagsCache => match read_pool {
            Some(rp) => cache::rebuild_tags_cache_split(pool, rp).await,
            None => cache::rebuild_tags_cache(pool).await,
        },
        MaterializeTask::RebuildPagesCache => match read_pool {
            Some(rp) => cache::rebuild_pages_cache_split(pool, rp).await,
            None => cache::rebuild_pages_cache(pool).await,
        },
        MaterializeTask::RebuildAgendaCache => match read_pool {
            Some(rp) => cache::rebuild_agenda_cache_split(pool, rp).await,
            None => cache::rebuild_agenda_cache(pool).await,
        },
        MaterializeTask::ReindexBlockLinks { ref block_id } => match read_pool {
            Some(rp) => cache::reindex_block_links_split(pool, rp, block_id).await,
            None => cache::reindex_block_links(pool, block_id).await,
        },
        MaterializeTask::UpdateFtsBlock { ref block_id } => {
            fts::update_fts_for_block(pool, block_id).await
        }
        MaterializeTask::ReindexFtsReferences { ref block_id } => {
            fts::reindex_fts_references(pool, block_id).await
        }
        MaterializeTask::RemoveFtsBlock { ref block_id } => {
            fts::remove_fts_for_block(pool, block_id).await
        }
        MaterializeTask::RebuildFtsIndex => match read_pool {
            Some(rp) => fts::rebuild_fts_index_split(pool, rp).await,
            None => fts::rebuild_fts_index(pool).await,
        },
        MaterializeTask::FtsOptimize => fts::fts_optimize(pool).await,
        MaterializeTask::CleanupOrphanedAttachments => cleanup_orphaned_attachments(pool).await,
        MaterializeTask::RebuildTagInheritanceCache => match read_pool {
            Some(rp) => tag_inheritance::rebuild_all_split(pool, rp).await,
            None => tag_inheritance::rebuild_all(pool).await,
        },
        MaterializeTask::RebuildProjectedAgendaCache => match read_pool {
            Some(rp) => cache::rebuild_projected_agenda_cache_split(pool, rp).await,
            None => cache::rebuild_projected_agenda_cache(pool).await,
        },
        MaterializeTask::ApplyOp(ref record) => {
            tracing::warn!(seq = record.seq, "unexpected ApplyOp in background queue");
            Ok(())
        }
        MaterializeTask::BatchApplyOps(_) => {
            tracing::warn!("unexpected BatchApplyOps in background queue");
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
    }
}
