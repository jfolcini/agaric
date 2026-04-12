//! Extracted handler functions for the materializer queues.

use super::metrics::QueueMetrics;
use super::MaterializeTask;
use crate::cache;
use crate::error::AppError;
use crate::fts;
use crate::op::{
    is_reserved_property_key, AddAttachmentPayload, AddTagPayload, CreateBlockPayload,
    DeleteAttachmentPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpType, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::tag_inheritance;
use sqlx::SqlitePool;

pub(super) async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    _metrics: &QueueMetrics,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            if let Err(e) = apply_op(pool, record).await {
                tracing::warn!(op_type = %record.op_type, seq = record.seq, error = %e, "failed to apply remote op — will retry");
                return Err(e);
            }
            Ok(())
        }
        MaterializeTask::BatchApplyOps(records) => {
            let mut tx = pool.begin().await?;
            for record in records {
                if let Err(e) = apply_op_tx(&mut tx, record).await {
                    tracing::warn!(op_type = %record.op_type, seq = record.seq, error = %e, "failed to apply remote op in batch — rolling back");
                    // tx is dropped here, which rolls back automatically
                    return Err(e);
                }
            }
            tx.commit().await?;
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
        _ => {
            tracing::warn!(?task, "unexpected task in foreground queue");
            Ok(())
        }
    }
}

pub(super) async fn apply_op(pool: &SqlitePool, record: &OpRecord) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    apply_op_tx(&mut tx, record).await?;
    tx.commit().await?;
    Ok(())
}

/// Core apply-op logic operating on a bare [`SqliteConnection`].
///
/// Both the single-op path (`apply_op`) and the batched-transaction path
/// (`BatchApplyOps`) delegate here so that a batch can be wrapped in a
/// single transaction for atomicity.
async fn apply_op_tx(conn: &mut sqlx::SqliteConnection, record: &OpRecord) -> Result<(), AppError> {
    use std::str::FromStr;
    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::Validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;
    match op_type {
        OpType::CreateBlock => {
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query("INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, is_conflict) VALUES (?, ?, ?, ?, ?, 0)")
                .bind(p.block_id.as_str()).bind(&p.block_type).bind(&p.content).bind(parent_id_str.as_deref()).bind(p.position).execute(&mut *conn).await?;
            let parent_str = parent_id_str.as_deref();
            tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str)
                .await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
                .bind(&p.to_text)
                .bind(p.block_id.as_str())
                .execute(&mut *conn)
                .await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            let now = &record.created_at;
            sqlx::query("WITH RECURSIVE descendants(id) AS ( SELECT id FROM blocks WHERE id = ? UNION ALL SELECT b.id FROM blocks b INNER JOIN descendants d ON b.parent_id = d.id WHERE b.deleted_at IS NULL ) UPDATE blocks SET deleted_at = ? WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL")
                .bind(p.block_id.as_str()).bind(now).execute(&mut *conn).await?;
            tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("WITH RECURSIVE descendants(id) AS ( SELECT id FROM blocks WHERE id = ? UNION ALL SELECT b.id FROM blocks b INNER JOIN descendants d ON b.parent_id = d.id ) UPDATE blocks SET deleted_at = NULL WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?")
                .bind(p.block_id.as_str()).bind(&p.deleted_at_ref).execute(&mut *conn).await?;
            tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            let block_id = p.block_id.as_str();
            sqlx::query("PRAGMA defer_foreign_keys = ON")
                .execute(&mut *conn)
                .await?;
            const DESC_CTE: &str = "WITH RECURSIVE descendants(id) AS ( SELECT id FROM blocks WHERE id = ? UNION ALL SELECT b.id FROM blocks b INNER JOIN descendants d ON b.parent_id = d.id )";
            sqlx::query(&format!("{DESC_CTE} DELETE FROM block_tags WHERE block_id IN (SELECT id FROM descendants) OR tag_id IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} DELETE FROM block_tag_inherited WHERE block_id IN (SELECT id FROM descendants) OR inherited_from IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} DELETE FROM block_properties WHERE block_id IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} UPDATE block_properties SET value_ref = NULL WHERE value_ref IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} DELETE FROM block_links WHERE source_id IN (SELECT id FROM descendants) OR target_id IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} DELETE FROM agenda_cache WHERE block_id IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM tags_cache WHERE tag_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM pages_cache WHERE page_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM attachments WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!("{DESC_CTE} DELETE FROM block_drafts WHERE block_id IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!("{DESC_CTE} UPDATE blocks SET conflict_source = NULL WHERE conflict_source IN (SELECT id FROM descendants)")).bind(block_id).execute(&mut *conn).await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM fts_blocks WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM page_aliases WHERE page_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM projected_agenda_cache WHERE block_id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(&format!(
                "{DESC_CTE} DELETE FROM blocks WHERE id IN (SELECT id FROM descendants)"
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
            sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                .bind(new_parent_str.as_deref())
                .bind(p.new_position)
                .bind(p.block_id.as_str())
                .execute(&mut *conn)
                .await?;
            tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut *conn)
                .await?;
            tag_inheritance::propagate_tag_to_descendants(
                &mut *conn,
                p.block_id.as_str(),
                p.tag_id.as_str(),
            )
            .await?;
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut *conn)
                .await?;
            tag_inheritance::remove_inherited_tag(
                &mut *conn,
                p.block_id.as_str(),
                p.tag_id.as_str(),
            )
            .await?;
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
                    .execute(&mut *conn)
                    .await?;
            } else {
                sqlx::query("INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(p.block_id.as_str()).bind(&p.key).bind(&p.value_text).bind(p.value_num).bind(&p.value_date).bind(&p.value_ref).execute(&mut *conn).await?;
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
                    .execute(&mut *conn)
                    .await?;
            } else {
                sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                    .bind(p.block_id.as_str())
                    .bind(&p.key)
                    .execute(&mut *conn)
                    .await?;
            }
        }
        OpType::AddAttachment => {
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("INSERT OR IGNORE INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(&p.attachment_id).bind(p.block_id.as_str()).bind(&p.filename).bind(&p.fs_path).bind(&p.mime_type).bind(p.size_bytes).bind(&record.created_at).execute(&mut *conn).await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(&p.attachment_id)
                .execute(&mut *conn)
                .await?;
        }
    }
    tracing::debug!(op_type = %record.op_type, seq = record.seq, "applied op to materialized tables");
    Ok(())
}

pub(super) async fn cleanup_orphaned_attachments(pool: &SqlitePool) -> Result<(), AppError> {
    let _ = pool;
    tracing::debug!("orphaned attachment cleanup: no-op (file storage not yet established)");
    Ok(())
}

pub(super) async fn handle_background_task(
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
