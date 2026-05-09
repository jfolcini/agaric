//! Extracted handler functions for the materializer queues.

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
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

// MAINT-148g — `handle_foreground_task` previously took an unused
// `_metrics: &QueueMetrics` parameter. Counters live on the consumer
// loop (see `consumer::process_single_foreground_task`) which inspects
// the handler's `Result` and bumps the appropriate counter; the handler
// itself never needed access. Reintroduce the parameter only when a
// future code path needs metric mutation from inside the handler.
pub(super) async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
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
            // C-2b: track the highest seq across the batch so we can
            // advance the apply cursor exactly once before commit. An
            // empty batch leaves `max_seq` at None so the cursor is not
            // touched (the MAX query is skipped entirely).
            let mut max_seq: Option<i64> = None;
            // PEND-09 Phase 2 day-9 — buffer the per-record `ApplyEffects`
            // so the post-commit shadow-dispatch fanout has the
            // RestoreBlock descendant cohorts available.  Indexed by
            // record position to mirror the `records.iter()` order; an
            // empty effects struct is the default for non-RestoreBlock
            // ops so the post-commit walk just no-ops on those slots.
            #[cfg(feature = "loro-shadow")]
            let mut per_record_effects: Vec<ApplyEffects> = Vec::with_capacity(records.len());
            // M-10: `records` is `&Arc<Vec<OpRecord>>`; `.iter()` derefs
            // through `Arc -> Vec` to yield `&OpRecord` without copying.
            for record in records.iter() {
                let snapshot = snapshot_for_op(&mut tx, record).await?;
                let _effects = match apply_op_tx(&mut tx, record).await {
                    Ok(eff) => eff,
                    Err(e) => {
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
                };
                #[cfg(feature = "loro-shadow")]
                per_record_effects.push(_effects);
                max_seq = Some(max_seq.map_or(record.seq, |prev| prev.max(record.seq)));
                if gcal_handle.get().is_some() {
                    // PEND-25 L2: wrap in `Arc` so `DeferredNotification`
                    // holds the record by refcount. Batch input is
                    // `Arc<Vec<OpRecord>>` (shared) and individual records
                    // do not have their own `Arc` upstream, so one
                    // `OpRecord::clone` is unavoidable here — the win is
                    // that the field type is consistent with the single-op
                    // `apply_op` path, which `Arc::clone`s without a deep
                    // clone.
                    pending_events.push(DeferredNotification {
                        record: Arc::new((*record).clone()),
                        snapshot,
                    });
                }
            }
            // C-2b: advance the cursor to the highest seq in the batch
            // inside the same tx so `apply + cursor` are atomic. Empty
            // batches skip the update entirely (no seq to record).
            if let Some(seq) = max_seq {
                advance_apply_cursor(&mut tx, seq).await?;
            }
            tx.commit().await?;

            // PEND-09 Phase 1 day-3 — shadow-mode dual-write hook on
            // the batched materializer path.  Walks the batch AFTER
            // `tx.commit` so any record whose sibling rolled the tx
            // back is not visible here (an Err inside the loop above
            // returns early before we reach this point).  See the
            // single-op `apply_op` path for the rationale; this is
            // the same hook applied per-record.  No-op when
            // `loro-shadow` is off.
            //
            // PEND-09 Phase 2 day-9 — also fan out the RestoreBlock
            // descendant cohorts captured in `per_record_effects`, in
            // the same order as the records themselves, so the engine
            // sees per-descendant `apply_restore_block` calls that
            // mirror the SQL cascade.  Records with empty
            // `restored_cohort` (every op type other than
            // RestoreBlock) are no-ops in the fanout helper.
            #[cfg(feature = "loro-shadow")]
            {
                for (record, effects) in records.iter().zip(per_record_effects.iter()) {
                    crate::merge::shadow_dispatch_for_record(pool, record).await;
                    dispatch_restore_descendants_shadow(pool, record, &effects.restored_cohort)
                        .await;
                }
            }

            notify_gcal_for_events(gcal_handle, pending_events);
            Ok(())
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
        _ => {
            // L-14: a non-Apply / non-Batch / non-Barrier variant landed in
            // the foreground queue — that is a dispatch bug, not a runtime
            // condition. Return `Err(Validation)` so the consumer's
            // outcome inspection bumps `fg_errors` (see
            // `consumer::process_single_foreground_task`) and reviewers /
            // operators see a real signal instead of a silently-dropped op.
            //
            // L-14: Err return + error! log is sufficient — debug_assert
            // removed because tests assert the Err contract directly, and a
            // `debug_assert!(false, …)` would force every test exercising
            // this path to dance around `#[should_panic]`.
            tracing::error!(
                ?task,
                "unexpected task in foreground queue — misrouted dispatch"
            );
            Err(AppError::Validation(format!(
                "unexpected task in foreground queue: {task:?}"
            )))
        }
    }
}

/// PEND-25 L2/L9: takes `&Arc<OpRecord>` so the post-commit
/// `DeferredNotification` push is a cheap `Arc::clone` (atomic refcount
/// bump) rather than a deep clone of the record's owned `String`
/// payloads. Callers (the `MaterializeTask::ApplyOp` arm) already hold
/// the record as `Arc<OpRecord>`, so the borrow threads through.
pub(super) async fn apply_op(
    pool: &SqlitePool,
    record: &Arc<OpRecord>,
    gcal_handle: &OnceLock<GcalConnectorHandle>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let snapshot = snapshot_for_op(&mut tx, record).await?;
    let _effects = apply_op_tx(&mut tx, record).await?;
    // C-2b: advance the cursor in the same tx so `apply + cursor` are
    // atomic. A crash between the apply and the commit rolls both back
    // together; the cursor never points ahead of materialised state.
    advance_apply_cursor(&mut tx, record.seq).await?;
    tx.commit().await?;

    // PEND-09 Phase 1 day-3 — shadow-mode dual-write hook on the
    // materializer hot path.  Dispatched AFTER `tx.commit` so the
    // per-space `LoroEngine` only ever observes durably-applied ops
    // (a rolled-back tx must not leak into Loro's in-process state).
    // No-op when `loro-shadow` is off (compile-time elided); even with
    // the feature on, `shadow_dispatch_for_record` swallows its own
    // errors and never propagates failure back to the materializer.
    //
    // PEND-09 Phase 2 day-9 — RestoreBlock cascade fan-out.  The SQL
    // restore walks the descendant cohort but the Loro engine is
    // per-block-id only; without fan-out a 10-descendant subtree
    // restore leaves 9 blocks marked `deleted_at != Null` in Loro.
    // We synthesise per-descendant `RestoreBlock` records (sharing
    // the root record's metadata) and dispatch each through the same
    // shadow-dispatch path.  See `dispatch_restore_descendants_shadow`.
    #[cfg(feature = "loro-shadow")]
    {
        crate::merge::shadow_dispatch_for_record(pool, record).await;
        dispatch_restore_descendants_shadow(pool, record, &_effects.restored_cohort).await;
    }

    notify_gcal_for_events(
        gcal_handle,
        vec![DeferredNotification {
            record: Arc::clone(record),
            snapshot,
        }],
    );
    Ok(())
}

/// PEND-09 Phase 2 day-9 — fan out shadow-mode `RestoreBlock` for the
/// full cohort the SQL cascade restored (seed + every descendant).
/// The engine's `apply_restore_block` is per-block-id only, so without
/// this fanout a SQL restore of a 10-descendant subtree leaves 9 blocks
/// marked `deleted_at != Null` in the Loro doc.
///
/// ## Decision (cutover plan §3 day-9)
///
/// Three options were on the table:
/// - **(a)** materializer fans out per-descendant on the shadow path
/// - (b) engine's `apply_restore_block` walks descendants
/// - (c) thread `deleted_at_ref` through and gate the engine walk
///
/// Day 9 picks **(a)**: keeps the engine API simple (one block_id in,
/// one mutation out) and keeps cohort semantics with the SQL that
/// owns them.  The engine doesn't (and shouldn't) know about
/// `parent_id` walks; SQL is the source of truth for the descendant
/// cohort.
///
/// ## Why the cohort INCLUDES the seed
///
/// The upstream `shadow_dispatch_for_record` call in `apply_op` also
/// targets the seed block, so in a hypothetically healthy world the
/// seed would be applied twice (once via dispatch, once via this
/// helper).  Engine `apply_restore_block` is idempotent (no-op on an
/// already-restored block).  Including the seed here makes this helper
/// the canonical cohort-restore function regardless of whether
/// `shadow_dispatch_for_record` reaches the engine for any specific
/// op record.  Net cost: one extra idempotent engine call per
/// RestoreBlock.
///
/// ## Implementation note
///
/// We call `shadow_apply` directly with a synthesised
/// [`OpPayload::RestoreBlock`] rather than re-marshalling through
/// `shadow_dispatch_for_record`.  Synthetic records don't have a
/// stored payload to JSON-parse; going direct skips a serialise +
/// deserialise round-trip per cohort entry and keeps the per-call cost
/// bounded by the registry lock + the engine's per-block-id mutation
/// (single-digit microseconds).
///
/// Errors inside `shadow_apply` are already absorbed by the parity
/// sampler (a Loro-side error becomes a parity-log row, never a hot-
/// path failure), so this helper has nothing to propagate.  Every
/// per-block call reuses the root op's metadata (`device_id`, `seq`,
/// `space_id`) so log lines + parity rows stay anchored to the
/// user-visible op.
#[cfg(feature = "loro-shadow")]
async fn dispatch_restore_descendants_shadow(
    pool: &SqlitePool,
    root_record: &OpRecord,
    cohort: &[String],
) {
    use crate::op::{OpPayload, RestoreBlockPayload};
    use crate::ulid::BlockId;

    if cohort.is_empty() {
        return;
    }

    let Some(state) = crate::loro::shared::get() else {
        // Shadow mode not initialised (test environment that
        // bypasses the boot setup).  Nothing to do.
        return;
    };

    // Parse the root's payload once to extract `deleted_at_ref`.  The
    // payload is the raw inner-only JSON (per `serialize_inner_payload`
    // in `op_log.rs`), not the tagged `OpPayload` form, so we go
    // through the inner struct directly.
    let root_payload: RestoreBlockPayload = match serde_json::from_str(&root_record.payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                seq = root_record.seq,
                error = %e,
                "restore-cascade fanout: failed to parse root RestoreBlockPayload; \
                 skipping descendant fan-out",
            );
            return;
        }
    };

    // Resolve the space once via the root's block_id (every descendant
    // is in the same space — the descendant CTE walks within a single
    // `blocks.parent_id` graph).  Keeps fanout O(N) on the engine call
    // and not O(N) on `resolve_block_space` SQL queries.
    let root_block = BlockId::from_trusted(root_payload.block_id.as_str());
    let space_id = match crate::space::resolve_block_space(pool, &root_block).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            tracing::trace!(
                block_id = root_payload.block_id.as_str(),
                "restore-cascade fanout: no space for root block; skipping",
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "restore-cascade fanout: resolve_block_space failed; skipping",
            );
            return;
        }
    };

    for cohort_id in cohort {
        // Build the typed payload directly (no JSON round-trip).
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(cohort_id),
            deleted_at_ref: root_payload.deleted_at_ref.clone(),
        });

        let op_id = format!(
            "{}/{}#cohort/{}",
            root_record.device_id, root_record.seq, cohort_id,
        );
        let diffy_summary = crate::merge::diffy_summary_for(&payload);
        crate::merge::shadow_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            &space_id,
            diffy_summary,
            state,
        );
    }
}

/// C-2b: advance the materializer apply cursor inside the apply tx so
/// `apply + cursor` are atomic. The cursor is monotonic (`MAX`), so
/// out-of-order replay attempts (or mixed-direction batches) are no-ops.
///
/// The single-row table is seeded by migration `0040`; this UPDATE
/// always targets `id = 1`. The MAX semantics guarantee that
/// re-applying an already-applied op is a no-op for the cursor.
async fn advance_apply_cursor(conn: &mut sqlx::SqliteConnection, seq: i64) -> Result<(), AppError> {
    let updated_at = crate::now_rfc3339();
    sqlx::query!(
        "UPDATE materializer_apply_cursor \
         SET materialized_through_seq = MAX(materialized_through_seq, ?), \
             updated_at = ? \
         WHERE id = 1",
        seq,
        updated_at,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Pair of (op record, pre-mutation snapshot) buffered for emission
/// after a successful commit.  See the `BatchApplyOps` arm.
///
/// PEND-25 L2: `record` is `Arc<OpRecord>` so the per-event push only
/// performs an atomic refcount bump rather than deep-cloning the
/// record's owned `String` payloads. Pairs with PEND-25 L9 (the
/// `Arc<OpRecord>` shift in `enqueue_*_background`).
struct DeferredNotification {
    record: Arc<OpRecord>,
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

/// Side-effects an `apply_op_tx` call may produce that the caller needs
/// to fan out AFTER the SQL transaction commits.  Today the only such
/// effect is the cohort restored by a `RestoreBlock` op — the SQL
/// UPDATE walks the descendant CTE and clears `deleted_at` for every
/// block in the matching `deleted_at_ref` cohort, but the per-space
/// `LoroEngine`'s `apply_restore_block` is per-block-id only.
///
/// PEND-09 Phase 2 day-9 fix (review of day-8.5): without fanning out
/// the cohort on the shadow path, a SQL restore of a 10-descendant
/// subtree would leave 9 blocks marked `deleted_at != Null` in the Loro
/// doc.  Day-9 picks **option (a)** of the three the cutover plan §3
/// day-9 lists — fan out on the materializer side rather than walking
/// descendants inside the engine — so the engine API stays simple and
/// cohort semantics live with the SQL that defines them.
///
/// The cohort vec INCLUDES the seed `block_id` so the post-commit
/// helper (`dispatch_restore_descendants_shadow`) is the canonical path
/// for driving Loro on the whole subtree.  The engine's
/// `apply_restore_block` is idempotent so the duplicate seed-apply (the
/// upstream `shadow_dispatch_for_record` call also reaches the seed
/// when the parse path is healthy) is harmless.  Empty for every op
/// type other than `RestoreBlock`.
#[derive(Debug, Default)]
pub(super) struct ApplyEffects {
    /// Block ids restored by a `RestoreBlock` apply — seed AND every
    /// descendant the SQL CTE walked.  Empty unless the op was
    /// `RestoreBlock`.  Order is whatever SQLite's CTE walk produces
    /// (no guarantee but stable across calls on a fixed schema).
    pub restored_cohort: Vec<String>,
}

/// Core apply-op logic operating on a bare [`SqliteConnection`].
///
/// Both the single-op path (`apply_op`) and the batched-transaction path
/// (`BatchApplyOps`) delegate here so that a batch can be wrapped in a
/// single transaction for atomicity.
///
/// Returns an [`ApplyEffects`] describing post-commit fan-out the
/// caller is responsible for running.  Today the only populated field
/// is `restored_cohort` (see the struct docs); every other op type
/// returns the default-empty effects.
async fn apply_op_tx(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
) -> Result<ApplyEffects, AppError> {
    use std::str::FromStr;
    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::Validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;
    let mut effects = ApplyEffects::default();
    match op_type {
        OpType::CreateBlock => {
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            apply_create_block_tx(conn, p).await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            apply_edit_block_tx(conn, p).await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            apply_delete_block_tx(conn, p, &record.created_at).await?;
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture the descendant cohort BEFORE the UPDATE — once
            // the UPDATE clears `deleted_at`, the cohort is no longer
            // identifiable by `(seed_id, deleted_at_ref)`.  This SELECT
            // mirrors the same CTE the UPDATE uses so the captured set
            // is exactly what gets restored.
            //
            // We keep the seed in the cohort: the post-commit fanout
            // (`dispatch_restore_descendants_shadow`) is the canonical
            // path that drives Loro for the entire cohort.  Including
            // the seed makes the helper self-contained and avoids
            // depending on the upstream `shadow_dispatch_for_record`
            // call also reaching the engine — the duplicate apply on
            // the seed is idempotent (engine's `apply_restore_block`
            // is a no-op on an already-restored block).
            let cohort = collect_restore_cohort(conn, &p).await?;
            apply_restore_block_tx(conn, p).await?;
            effects.restored_cohort = cohort;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            apply_purge_block_tx(conn, p).await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            apply_move_block_tx(conn, p).await?;
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            apply_add_tag_tx(conn, p).await?;
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            apply_remove_tag_tx(conn, p).await?;
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            apply_set_property_tx(conn, p).await?;
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            apply_delete_property_tx(conn, p).await?;
        }
        OpType::AddAttachment => {
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_add_attachment_tx(conn, p, &record.created_at).await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_delete_attachment_tx(conn, p).await?;
        }
    }
    tracing::debug!(op_type = %record.op_type, seq = record.seq, "applied op to materialized tables");
    Ok(effects)
}

/// PEND-09 Phase 2 day-9 — capture the descendant cohort that
/// `apply_restore_block_tx` is about to clear.  Mirrors the CTE +
/// `deleted_at = ?` filter used by the UPDATE so the captured set is
/// exactly the rows that will be restored.  Run inside the same tx,
/// before the UPDATE, so the snapshot reflects the soft-deleted state.
///
/// The list ALWAYS includes the seed `block_id` if it matches the
/// filter; the caller is responsible for excluding the seed when
/// constructing the per-descendant fan-out (the seed's shadow dispatch
/// already happens once for the root op record).
async fn collect_restore_cohort(
    conn: &mut sqlx::SqliteConnection,
    p: &RestoreBlockPayload,
) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as::<_, (String,)>(concat!(
        crate::descendants_cte_standard!(),
        "SELECT id FROM blocks \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(p.block_id.as_str())
    .bind(&p.deleted_at_ref)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// PEND-28a H2: per-variant body for [`OpType::CreateBlock`].
async fn apply_create_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: CreateBlockPayload,
) -> Result<(), AppError> {
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
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::EditBlock`].
async fn apply_edit_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: EditBlockPayload,
) -> Result<(), AppError> {
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(&p.to_text)
        .bind(p.block_id.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::DeleteBlock`].
async fn apply_delete_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteBlockPayload,
    now: &str,
) -> Result<(), AppError> {
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
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::RestoreBlock`].
async fn apply_restore_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: RestoreBlockPayload,
) -> Result<(), AppError> {
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
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::PurgeBlock`].
async fn apply_purge_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: PurgeBlockPayload,
) -> Result<(), AppError> {
    let block_id = p.block_id.as_str();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    // PEND-20 C: materialise the descendants set ONCE into a
    // TEMP table, then have the 15 DELETE / UPDATE statements
    // below read from the table via `WHERE ... IN (SELECT id
    // FROM _purge_descendants)`. Pre-refactor each statement
    // re-evaluated the recursive `descendants_cte_purge!()` CTE
    // end-to-end against the same subtree (15× walks per
    // cascade), needlessly extending the writer-lock window.
    //
    // The seed query mirrors `descendants_cte_purge!()` exactly:
    // PURGE intentionally does NOT filter `is_conflict = 0`
    // because the goal is to erase every row that descends from
    // the purged block, INCLUDING conflict copies. This is the
    // only subtree walk that intentionally walks conflicts —
    // invariant #9's documented exception. `depth < 100` is
    // preserved as the runaway-recursion guard.
    //
    // Cleanup pattern: SQLite TEMP tables are connection-scoped
    // and the connection comes from a pool, so the table can
    // outlive the handler unless we explicitly DROP it. The
    // defensive `DROP TABLE IF EXISTS` at the top guards against
    // a prior crash that leaked the table on this connection;
    // the explicit `DROP TABLE` at the bottom keeps the
    // connection's temp namespace clean for the next caller.
    sqlx::query("DROP TABLE IF EXISTS _purge_descendants")
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "CREATE TEMP TABLE _purge_descendants AS \
         WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         SELECT id FROM descendants",
    )
    .bind(block_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants) \
            OR inherited_from IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM _purge_descendants) \
            OR target_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM projected_agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM blocks \
         WHERE id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // PEND-20 C: explicitly drop the temp table so the pooled
    // connection's temp namespace is empty for the next caller.
    // SQLite drops it automatically at connection close, but the
    // pool may keep this connection alive indefinitely.
    sqlx::query("DROP TABLE _purge_descendants")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::MoveBlock`].
async fn apply_move_block_tx(
    conn: &mut sqlx::SqliteConnection,
    p: MoveBlockPayload,
) -> Result<(), AppError> {
    let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(new_parent_str.as_deref())
        .bind(p.new_position)
        .bind(p.block_id.as_str())
        .execute(&mut *conn)
        .await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::AddTag`].
async fn apply_add_tag_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddTagPayload,
) -> Result<(), AppError> {
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
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::RemoveTag`].
async fn apply_remove_tag_tx(
    conn: &mut sqlx::SqliteConnection,
    p: RemoveTagPayload,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(p.block_id.as_str())
        .bind(p.tag_id.as_str())
        .execute(&mut *conn)
        .await?;
    tag_inheritance::remove_inherited_tag(&mut *conn, p.block_id.as_str(), p.tag_id.as_str())
        .await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::SetProperty`].
async fn apply_set_property_tx(
    conn: &mut sqlx::SqliteConnection,
    p: SetPropertyPayload,
) -> Result<(), AppError> {
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
        // PEND-14: persist `value_bool` as INTEGER (0/1).
        let value_bool_int: Option<i64> = p.value_bool.map(|b| b as i64);
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(p.block_id.as_str())
        .bind(&p.key)
        .bind(&p.value_text)
        .bind(p.value_num)
        .bind(&p.value_date)
        .bind(&p.value_ref)
        .bind(value_bool_int)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::DeleteProperty`].
async fn apply_delete_property_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeletePropertyPayload,
) -> Result<(), AppError> {
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
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::AddAttachment`].
async fn apply_add_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddAttachmentPayload,
    created_at: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR IGNORE INTO attachments \
             (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(p.attachment_id.as_str())
    .bind(p.block_id.as_str())
    .bind(&p.filename)
    .bind(&p.fs_path)
    .bind(&p.mime_type)
    .bind(p.size_bytes)
    .bind(created_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::DeleteAttachment`].
async fn apply_delete_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteAttachmentPayload,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(p.attachment_id.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Maximum number of attachment files inspected per batch before
/// yielding the runtime. Bounding the chunk size prevents a vault with
/// thousands of attachments from blocking the materializer for seconds
/// at a time. See REVIEW-LATER.md item C-3c for context.
const CLEANUP_BATCH_SIZE: usize = 1000;

/// Inter-batch yield duration in milliseconds. Combined with
/// `CLEANUP_BATCH_SIZE`, this caps the materializer's GC stall to the
/// time it takes to stat 1000 files plus a 10ms sleep, even on
/// pathologically large vaults.
const CLEANUP_BATCH_SLEEP_MS: u64 = 10;

/// REVIEW-LATER C-3c — reconcile the `attachments/` directory under
/// `app_data_dir` against the rows of the `attachments` table.
///
/// For every file under `<app_data_dir>/attachments/` (recursively),
/// we check whether the file's relative path is referenced by any row
/// in the `attachments` table. Files with no referencing row are
/// orphans (left behind by the historical leak before C-3a/b shipped,
/// or by any future code path that drops `fs_path` from a payload)
/// and are unlinked.
///
/// Threat model: single-user, multi-device. There are no concurrent
/// writers for a given attachment row, so there is no TOCTOU concern
/// between the `SELECT 1` existence check and the `remove_file`
/// unlink — the row cannot appear between the two operations.
///
/// Robustness guarantees:
/// - Missing or empty `attachments/` directory is a no-op (early
///   return), so a "vault never seeded" install never accidentally
///   touches anything.
/// - Per-file unlink errors (other than `NotFound`, which is logged at
///   info as already-clean) are logged at warn and the pass continues
///   — the GC must complete even if individual files cannot be
///   removed.
/// - Subdirectories under `attachments/` are walked recursively. The
///   `add_attachment_inner` path validator
///   (`check_attachment_fs_path_shape`) accepts subdirectories, and
///   FEAT-3 large-vault layouts may organize attachments in subdirs.
///
/// Returns `Ok(())` always — failures are logged, never propagated,
/// because a partial GC pass is strictly better than no GC pass.
pub(super) async fn cleanup_orphaned_attachments(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let attachments_root = app_data_dir.join("attachments");

    // Safety check: missing directory is an explicit no-op. A vault
    // that has never received an attachment will not have this
    // directory at all on most platforms — touching anything in this
    // case would be surprising.
    if !tokio::fs::try_exists(&attachments_root)
        .await
        .unwrap_or(false)
    {
        tracing::debug!(
            path = %attachments_root.display(),
            "cleanup_orphaned_attachments: attachments directory missing — no-op"
        );
        return Ok(());
    }

    // Walk the attachments subtree iteratively (DFS via a Vec stack)
    // to avoid stack-recursion overhead on deeply nested layouts. We
    // collect file paths first, then process them in batches of
    // `CLEANUP_BATCH_SIZE` so a vault with thousands of attachments
    // does not block the materializer for seconds.
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dir_stack: Vec<PathBuf> = vec![attachments_root.clone()];
    while let Some(dir) = dir_stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) => {
                tracing::warn!(
                    path = %dir.display(),
                    error = %e,
                    "cleanup_orphaned_attachments: failed to read directory; skipping subtree"
                );
                continue;
            }
        };
        loop {
            match rd.next_entry().await {
                Ok(Some(entry)) => {
                    let path = entry.path();
                    let file_type = match entry.file_type().await {
                        Ok(ft) => ft,
                        Err(e) => {
                            tracing::warn!(
                                path = %path.display(),
                                error = %e,
                                "cleanup_orphaned_attachments: failed to stat entry; skipping"
                            );
                            continue;
                        }
                    };
                    if file_type.is_dir() {
                        dir_stack.push(path);
                    } else if file_type.is_file() {
                        files.push(path);
                    }
                    // Symlinks and other entry types are intentionally
                    // ignored: the writer (`add_attachment_inner`) only
                    // produces regular files, so anything else under
                    // the tree is user-managed and out of scope.
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(
                        path = %dir.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: error iterating directory entries"
                    );
                    break;
                }
            }
        }
    }

    // Safety check: even if the directory exists, it may be empty
    // (e.g. all attachments were already deleted). Treat as no-op so
    // a pathological "vault never seeded" install never accidentally
    // touches anything.
    if files.is_empty() {
        tracing::debug!(
            path = %attachments_root.display(),
            "cleanup_orphaned_attachments: attachments directory empty — no-op"
        );
        return Ok(());
    }

    let mut scanned: u64 = 0;
    let mut unlinked: u64 = 0;
    let mut errors: u64 = 0;

    for chunk in files.chunks(CLEANUP_BATCH_SIZE) {
        for full_path in chunk {
            scanned += 1;
            // Strip the app_data_dir prefix so we compare against the
            // relative path stored in `attachments.fs_path` by
            // `add_attachment_inner`.
            let Ok(relative) = full_path.strip_prefix(app_data_dir) else {
                tracing::warn!(
                    path = %full_path.display(),
                    "cleanup_orphaned_attachments: file path outside app_data_dir; skipping"
                );
                continue;
            };
            // The writer stores `fs_path` with forward slashes (the
            // frontend's `path` plugin normalizes). On Windows the
            // walked path uses backslashes; coerce to the writer's
            // shape before the lookup so the comparison agrees.
            let Some(relative_str_raw) = relative.to_str() else {
                tracing::warn!(
                    path = %full_path.display(),
                    "cleanup_orphaned_attachments: non-UTF8 path; skipping"
                );
                continue;
            };
            let relative_str = relative_str_raw.replace('\\', "/");

            let referenced = sqlx::query_scalar!(
                r#"SELECT 1 as "v: i32" FROM attachments WHERE fs_path = ?"#,
                relative_str,
            )
            .fetch_optional(pool)
            .await;

            match referenced {
                Ok(Some(_)) => {
                    // File is referenced — keep it.
                }
                Ok(None) => {
                    // Orphan: unlink. Errors are logged but never
                    // propagated, so the rest of the pass continues.
                    match tokio::fs::remove_file(&full_path).await {
                        Ok(()) => {
                            unlinked += 1;
                            tracing::debug!(
                                path = %full_path.display(),
                                "cleanup_orphaned_attachments: removed orphan"
                            );
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            tracing::info!(
                                path = %full_path.display(),
                                "cleanup_orphaned_attachments: orphan already missing; skipping"
                            );
                        }
                        Err(e) => {
                            errors += 1;
                            tracing::warn!(
                                path = %full_path.display(),
                                error = %e,
                                "cleanup_orphaned_attachments: failed to unlink orphan"
                            );
                        }
                    }
                }
                Err(e) => {
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: DB lookup failed; skipping file"
                    );
                }
            }
        }
        // Yield between batches so a vault with thousands of
        // attachments cannot starve the rest of the materializer.
        tokio::time::sleep(std::time::Duration::from_millis(CLEANUP_BATCH_SLEEP_MS)).await;
    }

    tracing::info!(
        scanned,
        unlinked,
        errors,
        "cleanup_orphaned_attachments: scanned {scanned} files, unlinked {unlinked} orphans, {errors} errors"
    );

    Ok(())
}

/// Dispatch a background task to either the read/write split implementation
/// (when a separate read pool is configured) or the single-pool implementation.
///
/// MAINT-148a — collapses ~10 identical `match read_pool { Some(rp) => …_split,
/// None => … }` arms in [`handle_background_task`] to a single helper. Each
/// call site becomes one expression that constructs both branches as closures.
async fn dispatch_split_or_single<'a, FSplit, FSingle, FutSplit, FutSingle, T>(
    pool: &'a SqlitePool,
    read_pool: Option<&'a SqlitePool>,
    split_fn: FSplit,
    single_fn: FSingle,
) -> Result<T, AppError>
where
    FSplit: FnOnce(&'a SqlitePool, &'a SqlitePool) -> FutSplit,
    FSingle: FnOnce(&'a SqlitePool) -> FutSingle,
    FutSplit: std::future::Future<Output = Result<T, AppError>>,
    FutSingle: std::future::Future<Output = Result<T, AppError>>,
{
    match read_pool {
        Some(rp) => split_fn(pool, rp).await,
        None => single_fn(pool).await,
    }
}

pub(super) async fn handle_background_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
    app_data_dir: Option<&Path>,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::RebuildTagsCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_tags_cache_split,
                cache::rebuild_tags_cache,
            )
            .await
        }
        MaterializeTask::RebuildBlockTagRefsCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_block_tag_refs_cache_split,
                cache::rebuild_block_tag_refs_cache,
            )
            .await
        }
        MaterializeTask::RebuildPagesCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_pages_cache_split,
                cache::rebuild_pages_cache,
            )
            .await
        }
        MaterializeTask::RebuildAgendaCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_agenda_cache_split,
                cache::rebuild_agenda_cache,
            )
            .await
        }
        MaterializeTask::ReindexBlockLinks { ref block_id } => {
            dispatch_split_or_single(
                pool,
                read_pool,
                |w, r| cache::reindex_block_links_split(w, r, block_id),
                |p| cache::reindex_block_links(p, block_id),
            )
            .await
        }
        MaterializeTask::ReindexBlockTagRefs { ref block_id } => {
            dispatch_split_or_single(
                pool,
                read_pool,
                |w, r| cache::reindex_block_tag_refs_split(w, r, block_id),
                |p| cache::reindex_block_tag_refs(p, block_id),
            )
            .await
        }
        MaterializeTask::UpdateFtsBlock { ref block_id } => {
            // PEND-20 E: load tag/page reference maps once at the call site
            // (the materializer's per-task entry into the FTS update path)
            // and feed them into `_with_maps` variants. The previous
            // implementation called the convenience wrappers, which loaded
            // the maps internally on every block via the per-ref `IN(…)`
            // queries embedded in `strip_for_fts`. Pulling the load out to
            // the call site lays the groundwork for batch-level reuse and
            // makes the data-flow explicit (the strip path is now sync —
            // no DB round-trip).
            let read_pool_for_maps = read_pool.unwrap_or(pool);
            let (tag_names, page_titles) = fts::load_ref_maps(read_pool_for_maps).await?;
            dispatch_split_or_single(
                pool,
                read_pool,
                |w, r| {
                    fts::update_fts_for_block_split_with_maps(
                        w,
                        r,
                        block_id,
                        &tag_names,
                        &page_titles,
                    )
                },
                |p| fts::update_fts_for_block_with_maps(p, block_id, &tag_names, &page_titles),
            )
            .await
        }
        MaterializeTask::ReindexFtsReferences { ref block_id } => {
            fts::reindex_fts_references(pool, block_id).await
        }
        MaterializeTask::RemoveFtsBlock { ref block_id } => {
            fts::remove_fts_for_block(pool, block_id).await
        }
        MaterializeTask::RebuildFtsIndex => {
            dispatch_split_or_single(
                pool,
                read_pool,
                fts::rebuild_fts_index_split,
                fts::rebuild_fts_index,
            )
            .await
        }
        MaterializeTask::FtsOptimize => fts::fts_optimize(pool).await,
        MaterializeTask::CleanupOrphanedAttachments => match app_data_dir {
            Some(dir) => cleanup_orphaned_attachments(pool, dir).await,
            None => {
                // C-3c — without `app_data_dir` we cannot locate the
                // `attachments/` subtree. This is the expected state in
                // unit tests that use `Materializer::new(pool)` without
                // calling `set_app_data_dir`. Production wiring in
                // `lib.rs` always installs the dir.
                tracing::debug!(
                    "CleanupOrphanedAttachments skipped: app_data_dir not set on Materializer"
                );
                Ok(())
            }
        },
        MaterializeTask::RebuildTagInheritanceCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                tag_inheritance::rebuild_all_split,
                tag_inheritance::rebuild_all,
            )
            .await
        }
        MaterializeTask::RebuildProjectedAgendaCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_projected_agenda_cache_split,
                cache::rebuild_projected_agenda_cache,
            )
            .await
        }
        MaterializeTask::RebuildPageIds => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_page_ids_split,
                cache::rebuild_page_ids,
            )
            .await
        }
        MaterializeTask::ApplyOp(ref record) => {
            // L-14 (bg mirror): mirror the foreground catch-all — an
            // `ApplyOp` in the background queue is a dispatch bug. Promote
            // to error level and return `Err(Validation)` so the bg
            // consumer's outcome inspection bumps `bg_errors`.
            //
            // L-14: Err return + error! log is sufficient — debug_assert
            // removed because tests assert the Err contract directly.
            tracing::error!(
                op_type = %record.op_type,
                device_id = %record.device_id,
                seq = record.seq,
                "unexpected ApplyOp in background queue — misrouted dispatch"
            );
            Err(AppError::Validation(format!(
                "unexpected ApplyOp in background queue: device_id={}, seq={}, op_type={}",
                record.device_id, record.seq, record.op_type
            )))
        }
        MaterializeTask::BatchApplyOps(records) => {
            // L-14 (bg mirror): same rationale as the `ApplyOp` arm above.
            if let Some(first) = records.first() {
                tracing::error!(
                    device_id = %first.device_id,
                    seq = first.seq,
                    batch_size = records.len(),
                    "unexpected BatchApplyOps in background queue — misrouted dispatch"
                );
                Err(AppError::Validation(format!(
                    "unexpected BatchApplyOps in background queue: device_id={}, seq={}, batch_size={}",
                    first.device_id,
                    first.seq,
                    records.len()
                )))
            } else {
                tracing::error!(
                    "unexpected empty BatchApplyOps in background queue — misrouted dispatch"
                );
                Err(AppError::Validation(
                    "unexpected empty BatchApplyOps in background queue".into(),
                ))
            }
        }
        MaterializeTask::Barrier(ref notify) => {
            notify.notify_one();
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 2 day-9 — RestoreBlock cascade fanout tests.
//
// Verifies the materializer's restore-cascade fans out shadow-mode
// `RestoreBlock` calls to every descendant in the SQL cohort, not just
// the seed block.  Without this fanout a 10-descendant subtree restore
// would leave 9 blocks marked `deleted_at != Null` in the Loro doc.
//
// `cfg(all(test, feature = "loro-shadow"))` so the default-build test
// count is unchanged.
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "loro-shadow"))]
mod restore_cascade_tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::shared::ShadowState;
    use crate::op::OpPayload;
    use crate::space::SpaceId;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const PAGE_ID: &str = "01HZ00000000000000000000PA";
    const CHILD_1: &str = "01HZ00000000000000000000C1";
    const CHILD_2: &str = "01HZ00000000000000000000C2";
    const CHILD_3: &str = "01HZ00000000000000000000C3";
    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const DEVICE_ID: &str = "device-restore-cascade";
    const DELETED_AT: &str = "2025-01-01T00:00:00Z";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("restore_cascade.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Build a tree: page (PAGE_ID) → child (CHILD_1) → grandchild
    /// (CHILD_2) → great-grandchild (CHILD_3). Each block gets
    /// `deleted_at = DELETED_AT` so the restore CTE will sweep all four.
    /// The page also gets a `space` block_property so
    /// `resolve_block_space` returns SPACE.
    async fn seed_deleted_subtree(pool: &SqlitePool) {
        // Space block (referenced by `block_properties.value_ref` →
        // FK → `blocks(id)`).  Spaces are stored as 'tag' blocks today
        // — see `commands::spaces::create_space`; for the test the
        // block_type just needs to satisfy the schema's CHECK
        // constraint (`content | tag | page`).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'space', NULL, 0, 0)",
        )
        .bind(SPACE)
        .execute(pool)
        .await
        .unwrap();
        // Page (no parent, page_id = self).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                 is_conflict, deleted_at) \
             VALUES (?, 'page', 'P', NULL, 0, ?, 0, ?)",
        )
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .bind(DELETED_AT)
        .execute(pool)
        .await
        .unwrap();
        // Space property on the page so resolve_block_space succeeds.
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(PAGE_ID)
        .bind(SPACE)
        .execute(pool)
        .await
        .unwrap();
        // Three nested children.
        for (id, parent, pos) in [
            (CHILD_1, PAGE_ID, 0_i64),
            (CHILD_2, CHILD_1, 0),
            (CHILD_3, CHILD_2, 0),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                     is_conflict, deleted_at) \
                 VALUES (?, 'content', 'C', ?, ?, ?, 0, ?)",
            )
            .bind(id)
            .bind(parent)
            .bind(pos)
            .bind(PAGE_ID)
            .bind(DELETED_AT)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// Returns a fresh ShadowState — install_for_test pattern.  Unlike
    /// `loro::shared::install_for_test` the global is process-local and
    /// per-nextest-process, so tests don't conflict.
    fn fresh_shadow_state() -> &'static ShadowState {
        crate::loro::shared::install_for_test()
    }

    /// Pre-populate the engine with the four blocks (alive), then mark
    /// each deleted via `apply_delete_block`.  This sets up an engine
    /// state that mirrors the SQL "all four deleted at the same ref"
    /// shape so the `apply_restore_block` calls have something to
    /// restore.
    fn seed_engine_with_deleted_subtree(state: &ShadowState) {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        // Seed four alive blocks with the same parent shape as SQL.
        engine
            .apply_create_block(PAGE_ID, "page", "P", None, 0)
            .unwrap();
        engine
            .apply_create_block(CHILD_1, "content", "C", Some(PAGE_ID), 0)
            .unwrap();
        engine
            .apply_create_block(CHILD_2, "content", "C", Some(CHILD_1), 0)
            .unwrap();
        engine
            .apply_create_block(CHILD_3, "content", "C", Some(CHILD_2), 0)
            .unwrap();
        // Soft-delete all four.
        for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
            engine.apply_delete_block(id).unwrap();
        }
    }

    /// Read the engine's `deleted_at` flag for `block_id`.  Returns
    /// `Some(true)` if the engine reports the block as deleted,
    /// `Some(false)` if alive, `None` if the block is absent in the
    /// engine.
    fn engine_block_deleted(state: &ShadowState, block_id: &str) -> Option<bool> {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        let snap = engine.read_block(block_id).expect("read_block");
        snap.as_ref()?;
        // `read_deleted` returns Ok(false) when `deleted_at` is missing
        // (engine never marked it deleted) or LoroValue::Null (engine
        // explicitly cleared the flag — i.e. the block is alive).
        Some(engine.read_deleted(block_id).expect("read_deleted"))
    }

    /// Drives the materializer's `apply_op` path for a `RestoreBlock`
    /// op against a 4-block subtree, then asserts that the per-space
    /// `LoroEngine` has `deleted_at = Null` on EVERY block — the seed
    /// AND its three descendants.  Without the day-9 fanout the
    /// engine-side state would still report `deleted_at != Null` on
    /// the three descendants.
    #[tokio::test]
    async fn restore_block_dispatches_to_loro_for_each_descendant() {
        let (pool, _dir) = fresh_pool().await;
        seed_deleted_subtree(&pool).await;
        let state = fresh_shadow_state();
        seed_engine_with_deleted_subtree(state);

        // Sanity: every block is currently deleted in the engine.
        for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
            assert_eq!(
                engine_block_deleted(state, id),
                Some(true),
                "{id} must start deleted",
            );
        }

        // Build a RestoreBlock op record by appending it to op_log so
        // the rest of the apply path sees a real OpRecord.  The seed
        // block is the page; the cascade walks every descendant
        // matching `deleted_at = DELETED_AT`.
        let payload = OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
            block_id: BlockId::from_trusted(PAGE_ID),
            deleted_at_ref: DELETED_AT.into(),
        });
        let record = std::sync::Arc::new(
            crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
                .await
                .expect("append op_log"),
        );

        // Drive the materializer's apply path (which fans out the
        // shadow dispatch under the loro-shadow feature).
        let gcal_handle: OnceLock<GcalConnectorHandle> = OnceLock::new();
        super::apply_op(&pool, &record, &gcal_handle)
            .await
            .expect("apply_op");

        // Every block in the cohort — root + three descendants — must
        // now be alive in the engine.  This is the load-bearing
        // assertion: the day-9 fanout is what makes the descendants
        // alive.  Without it CHILD_1, CHILD_2, CHILD_3 would still
        // report deleted_at != Null.
        for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
            assert_eq!(
                engine_block_deleted(state, id),
                Some(false),
                "{id} must be restored after RestoreBlock cascade fanout",
            );
        }
    }

    /// Direct-helper test — exercises `dispatch_restore_descendants_shadow`
    /// in isolation, bypassing the full `apply_op` path.  Asserts the
    /// helper's empty-input fast path AND the per-descendant fanout
    /// shape.
    #[tokio::test]
    async fn dispatch_restore_descendants_empty_list_is_noop() {
        let (pool, _dir) = fresh_pool().await;
        seed_deleted_subtree(&pool).await;
        let state = fresh_shadow_state();
        seed_engine_with_deleted_subtree(state);

        // Build a synthetic root record (we don't actually run the SQL
        // restore here — only the empty-list fanout path).
        let payload = serde_json::to_string(&serde_json::json!({
            "block_id": PAGE_ID,
            "deleted_at_ref": DELETED_AT,
        }))
        .unwrap();
        let root = OpRecord {
            device_id: DEVICE_ID.into(),
            seq: 1,
            parent_seqs: None,
            hash: "0000".into(),
            op_type: "restore_block".into(),
            payload,
            created_at: DELETED_AT.into(),
            block_id: Some(PAGE_ID.into()),
        };

        // Empty descendant list — no engine mutations expected.
        super::dispatch_restore_descendants_shadow(&pool, &root, &[]).await;

        // Engine state unchanged: every block is still deleted (we
        // seeded them deleted in seed_engine_with_deleted_subtree).
        for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
            assert_eq!(
                engine_block_deleted(state, id),
                Some(true),
                "{id} must remain deleted on empty-fanout path",
            );
        }
    }
}
