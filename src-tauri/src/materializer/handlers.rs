//! Extracted handler functions for the materializer queues.

use super::metrics::QueueMetrics;
use super::MaterializeTask;
use crate::cache;
use crate::error::AppError;
use crate::fts;
use crate::gcal_push::connector::GcalConnectorHandle;
use crate::gcal_push::dirty_producer::{compute_dirty_event, snapshot_for_op, BlockDateSnapshot};
use crate::op::{
    is_reserved_property_key, AddAttachmentPayload, AddTagPayload, CreateBlockPayload,
    DeleteAttachmentPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpType, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::tag_inheritance;
use sqlx::SqlitePool;
use std::sync::OnceLock;

pub(super) async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    _metrics: &QueueMetrics,
    gcal_handle: &OnceLock<GcalConnectorHandle>,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            if let Err(e) = apply_op(pool, record, gcal_handle).await {
                tracing::warn!(
                    op_type = %record.op_type,
                    device_id = %record.device_id,
                    seq = record.seq,
                    error = %e,
                    "failed to apply remote op — will retry"
                );
                return Err(e);
            }
            Ok(())
        }
        MaterializeTask::BatchApplyOps(records) => {
            // FEAT-5h — collect per-op pre-mutation snapshots so we
            // can emit DirtyEvents for every op in the batch after
            // the outer transaction commits.  Emitting during the tx
            // would violate the "notify only on durable state"
            // invariant — a DirtyEvent fired mid-batch and then
            // rolled back would send the connector chasing a ghost.
            let mut tx = pool.begin().await?;
            let mut pending_events: Vec<DeferredNotification> = Vec::new();
            for record in records {
                let snapshot = snapshot_for_op(&mut tx, record).await?;
                if let Err(e) = apply_op_tx(&mut tx, record).await {
                    tracing::warn!(
                        op_type = %record.op_type,
                        device_id = %record.device_id,
                        seq = record.seq,
                        error = %e,
                        "failed to apply remote op in batch — rolling back"
                    );
                    // tx is dropped here, which rolls back automatically
                    return Err(e);
                }
                if gcal_handle.get().is_some() {
                    pending_events.push(DeferredNotification {
                        record: (*record).clone(),
                        snapshot,
                    });
                }
            }
            tx.commit().await?;
            notify_gcal_for_events(gcal_handle, pending_events);
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

pub(super) async fn apply_op(
    pool: &SqlitePool,
    record: &OpRecord,
    gcal_handle: &OnceLock<GcalConnectorHandle>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let snapshot = snapshot_for_op(&mut tx, record).await?;
    apply_op_tx(&mut tx, record).await?;
    tx.commit().await?;
    notify_gcal_for_events(
        gcal_handle,
        vec![DeferredNotification {
            record: record.clone(),
            snapshot,
        }],
    );
    Ok(())
}

/// Pair of (op record, pre-mutation snapshot) buffered for emission
/// after a successful commit.  See the `BatchApplyOps` arm.
struct DeferredNotification {
    record: OpRecord,
    snapshot: BlockDateSnapshot,
}

/// Fire [`GcalConnectorHandle::notify_dirty`] for every event in
/// `events`.  No-op when the handle is unset (dev tests, headless
/// environments) or when a record produces no dirty event.
fn notify_gcal_for_events(
    gcal_handle: &OnceLock<GcalConnectorHandle>,
    events: Vec<DeferredNotification>,
) {
    let Some(handle) = gcal_handle.get() else {
        return;
    };
    let today = chrono::Local::now().date_naive();
    for DeferredNotification { record, snapshot } in events {
        if let Some(event) = compute_dirty_event(&record, &snapshot, today) {
            handle.notify_dirty(event);
        }
    }
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
            sqlx::query(
                "INSERT OR IGNORE INTO blocks \
                     (id, block_type, content, parent_id, position, is_conflict) \
                 VALUES (?, ?, ?, ?, ?, 0)",
            )
            .bind(p.block_id.as_str())
            .bind(&p.block_type)
            .bind(&p.content)
            .bind(parent_id_str.as_deref())
            .bind(p.position)
            .execute(&mut *conn)
            .await?;
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
            // Cascade soft-delete: mark the target and every not-yet-deleted
            // descendant. Mirror of the cascade in `commands/blocks/crud.rs`
            // delete_block_inner, applied by the materializer on remote ops.
            //
            // `descendants_cte_active!()` filters `is_conflict = 0` (conflict
            // copies have independent lifecycles — invariant #9) AND
            // `deleted_at IS NULL` (don't re-sweep already-deleted subtrees).
            // Shared CTE lives in `crate::block_descendants`.
            sqlx::query(concat!(
                crate::descendants_cte_active!(),
                "UPDATE blocks SET deleted_at = ? \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
            ))
            .bind(p.block_id.as_str())
            .bind(now)
            .execute(&mut *conn)
            .await?;
            tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
            // Restore every descendant that was soft-deleted at the same
            // `deleted_at_ref` timestamp — i.e., the exact cohort that
            // `delete_block` soft-deleted together.
            //
            // `descendants_cte_standard!()` filters `is_conflict = 0` —
            // conflict copies have independent deleted_at timestamps and
            // must not be bulk-restored with the original (invariant #9).
            // Shared CTE lives in `crate::block_descendants`.
            sqlx::query(concat!(
                crate::descendants_cte_standard!(),
                "UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
            ))
            .bind(p.block_id.as_str())
            .bind(&p.deleted_at_ref)
            .execute(&mut *conn)
            .await?;
            tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            let block_id = p.block_id.as_str();
            sqlx::query("PRAGMA defer_foreign_keys = ON")
                .execute(&mut *conn)
                .await?;
            // Shared purge CTE from `crate::block_descendants`.
            //
            // PURGE intentionally does NOT filter `is_conflict = 0` — the
            // goal is to erase every row that descends from the purged
            // block, INCLUDING conflict copies. This is the only subtree
            // CTE in the codebase that walks conflicts on purpose
            // (invariant #9 allows this documented exception). `depth < 100`
            // still bounds runaway recursion on corrupted data.
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM block_tags \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR tag_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM block_tag_inherited \
                 WHERE block_id IN (SELECT id FROM descendants) \
                    OR tag_id IN (SELECT id FROM descendants) \
                    OR inherited_from IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM block_properties \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "UPDATE block_properties SET value_ref = NULL \
                 WHERE value_ref IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM block_links \
                 WHERE source_id IN (SELECT id FROM descendants) \
                    OR target_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM agenda_cache \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM tags_cache \
                 WHERE tag_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM pages_cache \
                 WHERE page_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM attachments \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM block_drafts \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "UPDATE blocks SET conflict_source = NULL \
                 WHERE conflict_source IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM fts_blocks \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM page_aliases \
                 WHERE page_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM projected_agenda_cache \
                 WHERE block_id IN (SELECT id FROM descendants)",
            ))
            .bind(block_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(concat!(
                crate::descendants_cte_purge!(),
                "DELETE FROM blocks \
                 WHERE id IN (SELECT id FROM descendants)",
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
                // Match-arms preserve compile-time SQL validation.
                let block_id = p.block_id.as_str();
                match p.key.as_str() {
                    "todo_state" => {
                        sqlx::query!(
                            "UPDATE blocks SET todo_state = ? WHERE id = ?",
                            p.value_text,
                            block_id
                        )
                        .execute(&mut *conn)
                        .await?;
                    }
                    "priority" => {
                        sqlx::query!(
                            "UPDATE blocks SET priority = ? WHERE id = ?",
                            p.value_text,
                            block_id
                        )
                        .execute(&mut *conn)
                        .await?;
                    }
                    "due_date" => {
                        sqlx::query!(
                            "UPDATE blocks SET due_date = ? WHERE id = ?",
                            p.value_date,
                            block_id
                        )
                        .execute(&mut *conn)
                        .await?;
                    }
                    "scheduled_date" => {
                        sqlx::query!(
                            "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
                            p.value_date,
                            block_id
                        )
                        .execute(&mut *conn)
                        .await?;
                    }
                    other => unreachable!(
                        "is_reserved_property_key('{other}') returned true for an unrecognised key"
                    ),
                }
            } else {
                sqlx::query(
                    "INSERT OR REPLACE INTO block_properties \
                         (block_id, key, value_text, value_num, value_date, value_ref) \
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(p.block_id.as_str())
                .bind(&p.key)
                .bind(&p.value_text)
                .bind(p.value_num)
                .bind(&p.value_date)
                .bind(&p.value_ref)
                .execute(&mut *conn)
                .await?;
            }
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            if is_reserved_property_key(&p.key) {
                // Match-arms preserve compile-time SQL validation.
                let block_id = p.block_id.as_str();
                match p.key.as_str() {
                    "todo_state" => {
                        sqlx::query!("UPDATE blocks SET todo_state = NULL WHERE id = ?", block_id)
                            .execute(&mut *conn)
                            .await?;
                    }
                    "priority" => {
                        sqlx::query!("UPDATE blocks SET priority = NULL WHERE id = ?", block_id)
                            .execute(&mut *conn)
                            .await?;
                    }
                    "due_date" => {
                        sqlx::query!("UPDATE blocks SET due_date = NULL WHERE id = ?", block_id)
                            .execute(&mut *conn)
                            .await?;
                    }
                    "scheduled_date" => {
                        sqlx::query!(
                            "UPDATE blocks SET scheduled_date = NULL WHERE id = ?",
                            block_id
                        )
                        .execute(&mut *conn)
                        .await?;
                    }
                    other => unreachable!(
                        "is_reserved_property_key('{other}') returned true for an unrecognised key"
                    ),
                }
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
            sqlx::query(
                "INSERT OR IGNORE INTO attachments \
                     (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&p.attachment_id)
            .bind(p.block_id.as_str())
            .bind(&p.filename)
            .bind(&p.fs_path)
            .bind(&p.mime_type)
            .bind(p.size_bytes)
            .bind(&record.created_at)
            .execute(&mut *conn)
            .await?;
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
        MaterializeTask::UpdateFtsBlock { ref block_id } => match read_pool {
            Some(rp) => fts::update_fts_for_block_split(pool, rp, block_id).await,
            None => fts::update_fts_for_block(pool, block_id).await,
        },
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
        MaterializeTask::RebuildPageIds => match read_pool {
            Some(rp) => cache::rebuild_page_ids_split(pool, rp).await,
            None => cache::rebuild_page_ids(pool).await,
        },
        MaterializeTask::ApplyOp(ref record) => {
            tracing::warn!(
                op_type = %record.op_type,
                device_id = %record.device_id,
                seq = record.seq,
                "unexpected ApplyOp in background queue"
            );
            Ok(())
        }
        MaterializeTask::BatchApplyOps(records) => {
            if let Some(first) = records.first() {
                tracing::warn!(
                    device_id = %first.device_id,
                    seq = first.seq,
                    batch_size = records.len(),
                    "unexpected BatchApplyOps in background queue"
                );
            } else {
                tracing::warn!("unexpected empty BatchApplyOps in background queue");
            }
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
    }
}
