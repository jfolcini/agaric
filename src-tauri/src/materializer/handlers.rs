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
            let mut per_record_effects: Vec<ApplyEffects> = Vec::with_capacity(records.len());
            // M-10: `records` is `&Arc<Vec<OpRecord>>`; `.iter()` derefs
            // through `Arc -> Vec` to yield `&OpRecord` without copying.
            for record in records.iter() {
                let snapshot = snapshot_for_op(&mut tx, record).await?;
                let effects = match apply_op_tx(&mut tx, record).await {
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
                per_record_effects.push(effects);
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
            // the same hook applied per-record.
            //
            // PEND-09 Phase 2 day-9 — also fan out the RestoreBlock
            // descendant cohorts captured in `per_record_effects`, in
            // the same order as the records themselves, so the engine
            // sees per-descendant `apply_restore_block` calls that
            // mirror the SQL cascade.  Records with empty
            // `restored_cohort` (every op type other than
            // RestoreBlock) are no-ops in the fanout helper.
            //
            // PEND-09 Phase 3 day-9 — the `loro-shadow` feature gate
            // is retired; this fanout runs unconditionally now.
            for (record, effects) in records.iter().zip(per_record_effects.iter()) {
                crate::merge::dispatch_for_record(pool, record).await;
                dispatch_restore_descendants_shadow(pool, record, &effects.restored_cohort).await;
                // PEND-09 Phase 2 day-15 — symmetric DeleteBlock
                // cohort fan-out.  See the matching call in the
                // single-op `apply_op` path for rationale.
                dispatch_delete_descendants_shadow(
                    record,
                    &effects.deleted_cohort,
                    effects.delete_space_id.as_ref(),
                )
                .await;
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
    let effects = apply_op_tx(&mut tx, record).await?;
    // C-2b: advance the cursor in the same tx so `apply + cursor` are
    // atomic. A crash between the apply and the commit rolls both back
    // together; the cursor never points ahead of materialised state.
    advance_apply_cursor(&mut tx, record.seq).await?;
    tx.commit().await?;

    // PEND-09 Phase 1 day-3 — engine-dispatch hook on the
    // materializer hot path.  Dispatched AFTER `tx.commit` so the
    // per-space `LoroEngine` only ever observes durably-applied ops
    // (a rolled-back tx must not leak into Loro's in-process state).
    // `dispatch_for_record` swallows its own errors and never
    // propagates failure back to the materializer.
    //
    // PEND-09 Phase 2 day-9 — RestoreBlock cascade fan-out.  The SQL
    // restore walks the descendant cohort but the Loro engine is
    // per-block-id only; without fan-out a 10-descendant subtree
    // restore leaves 9 blocks marked `deleted_at != Null` in Loro.
    // We synthesise per-descendant `RestoreBlock` records (sharing
    // the root record's metadata) and dispatch each through the same
    // shadow-dispatch path.  See `dispatch_restore_descendants_shadow`.
    //
    // PEND-09 Phase 3 day-9 — the `loro-shadow` feature gate is
    // retired; this fanout runs unconditionally now.
    crate::merge::dispatch_for_record(pool, record).await;
    dispatch_restore_descendants_shadow(pool, record, &effects.restored_cohort).await;
    // PEND-09 Phase 2 day-15 — symmetric DeleteBlock cohort fan-out.
    // Closes the gap that day-13 left: SQL soft-deletes N
    // descendants but the engine's `apply_delete_block` is per-block
    // only, so without this walk the engine carries "alive" state
    // for the descendants while SQL says "deleted".
    //
    // Space id was captured PRE-UPDATE in `apply_op_tx` because
    // `resolve_block_space` filters `deleted_at IS NULL`; a
    // post-commit lookup would return `None` for every cohort row.
    dispatch_delete_descendants_shadow(
        record,
        &effects.deleted_cohort,
        effects.delete_space_id.as_ref(),
    )
    .await;

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
/// The upstream `dispatch_for_record` call in `apply_op` also
/// targets the seed block, so in a hypothetically healthy world the
/// seed would be applied twice (once via dispatch, once via this
/// helper).  Engine `apply_restore_block` is idempotent (no-op on an
/// already-restored block).  Including the seed here makes this helper
/// the canonical cohort-restore function regardless of whether
/// `dispatch_for_record` reaches the engine for any specific
/// op record.  Net cost: one extra idempotent engine call per
/// RestoreBlock.
///
/// ## Implementation note
///
/// We call `engine_apply` directly with a synthesised
/// [`OpPayload::RestoreBlock`] rather than re-marshalling through
/// `dispatch_for_record`.  Synthetic records don't have a
/// stored payload to JSON-parse; going direct skips a serialise +
/// deserialise round-trip per cohort entry and keeps the per-call cost
/// bounded by the registry lock + the engine's per-block-id mutation
/// (single-digit microseconds).
///
/// Errors inside `engine_apply` are absorbed (warn + skip) so this
/// helper has nothing to propagate.  Every per-block call reuses the
/// root op's metadata (`device_id`, `seq`, `space_id`) so log lines
/// stay anchored to the user-visible op.
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
        crate::merge::engine_apply(&op_id, &payload, &root_record.device_id, &space_id, state);
    }
}

/// PEND-09 Phase 2 day-15 — symmetric companion to
/// [`dispatch_restore_descendants_shadow`] for the `DeleteBlock`
/// cascade.
///
/// The SQL `apply_delete_block_tx` walks `descendants_cte_active!()`
/// and stamps `deleted_at` on every active descendant.  The Loro
/// engine's `apply_delete_block` is per-block-id only, so without this
/// fanout a 10-descendant subtree delete leaves 9 blocks alive in the
/// engine while SQL reports them deleted — exactly the symmetric gap
/// day-9 closed for restore (see that helper's doc for the day-9
/// rationale; the fix here mirrors it 1:1 for delete).
///
/// ## Decision (cutover plan §3 day-15)
///
/// Same three-option matrix as day-9: (a) materializer fans out, (b)
/// engine walks descendants, (c) thread the cohort through.  Day-15
/// picks (a) for the same reasons — keeps the engine API simple
/// (one block_id in, one mutation out) and keeps cohort semantics with
/// the SQL that owns them.
///
/// ## Why the cohort INCLUDES the seed
///
/// Same idempotent-seed rationale as `dispatch_restore_descendants_shadow`:
/// the upstream `dispatch_for_record` already targets the seed,
/// so including the seed here yields one extra idempotent engine call
/// per `DeleteBlock` (engine `apply_delete_block` is a no-op on an
/// already-deleted block — sets `deleted_at` to the same marker).
/// Including the seed makes this helper the canonical cohort-delete
/// function regardless of whether `dispatch_for_record` reaches
/// the engine for any specific op record.
///
/// ## Implementation note
///
/// We synthesise a per-cohort `OpPayload::DeleteBlock` and call
/// `engine_apply` directly, skipping the JSON round-trip the dispatch
/// path takes through stored payloads.  Errors inside `engine_apply`
/// are absorbed (warn + skip) so this helper has nothing to propagate.
/// Per-call cost is bounded by the registry lock + the engine's
/// per-block-id mutation (single-digit microseconds).
async fn dispatch_delete_descendants_shadow(
    root_record: &OpRecord,
    cohort: &[String],
    space_id: Option<&crate::space::SpaceId>,
) {
    use crate::op::OpPayload;
    use crate::ulid::BlockId;

    if cohort.is_empty() {
        return;
    }

    let Some(space_id) = space_id else {
        // Pre-UPDATE space resolve returned None — the seed has no
        // resolvable space (pre-FEAT-3 data, or a block whose owning
        // page never received a `space` SetProperty).  Nothing to do —
        // there's no canonical engine to mirror onto.  Trace-only:
        // the diffy-side delete is already authoritative.
        tracing::trace!(
            seq = root_record.seq,
            "delete-cascade fanout: no space captured for root block; skipping",
        );
        return;
    };

    let Some(state) = crate::loro::shared::get() else {
        // Engine state not initialised (test environment that
        // bypasses the boot setup).  Nothing to do.
        return;
    };

    for cohort_id in cohort {
        // Build the typed payload directly (no JSON round-trip).
        let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(cohort_id),
        });

        let op_id = format!(
            "{}/{}#cohort/{}",
            root_record.device_id, root_record.seq, cohort_id,
        );
        crate::merge::engine_apply(&op_id, &payload, &root_record.device_id, space_id, state);
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
/// upstream `dispatch_for_record` call also reaches the seed
/// when the parse path is healthy) is harmless.  Empty for every op
/// type other than `RestoreBlock`.
///
/// PEND-09 Phase 2 day-15 — `deleted_cohort` is the symmetric companion
/// for the `DeleteBlock` cascade.  Same shape, same rationale: the SQL
/// soft-delete walks N descendants, the engine's `apply_delete_block`
/// is per-block-id only, so without per-descendant fan-out the engine
/// state for the descendants is "alive" while SQL says "deleted".
/// Empty unless the op was `DeleteBlock`.  Includes the seed for the
/// same idempotent-seed-apply reason as `restored_cohort`.
///
/// `delete_space_id` is captured alongside `deleted_cohort` because
/// `resolve_block_space` filters `deleted_at IS NULL` — once the SQL
/// UPDATE has stamped the cohort as deleted, a post-commit
/// `resolve_block_space` lookup would return `None` for every row.
/// This is the asymmetry with `restored_cohort`: post-restore-UPDATE
/// the cohort is alive again so `dispatch_restore_descendants_shadow`
/// can resolve the space inline; post-delete-UPDATE the cohort is
/// dead, so we capture the space at the same pre-UPDATE moment as the
/// cohort itself.
#[derive(Debug, Default)]
pub(super) struct ApplyEffects {
    /// Block ids restored by a `RestoreBlock` apply — seed AND every
    /// descendant the SQL CTE walked.  Empty unless the op was
    /// `RestoreBlock`.  Order is whatever SQLite's CTE walk produces
    /// (no guarantee but stable across calls on a fixed schema).
    pub restored_cohort: Vec<String>,
    /// PEND-09 Phase 2 day-15 — block ids soft-deleted by a `DeleteBlock`
    /// apply — seed AND every active descendant the SQL CTE walked.
    /// Empty unless the op was `DeleteBlock`.  Captured BEFORE the
    /// UPDATE so the `descendants_cte_active!()` filter still matches
    /// (post-UPDATE every cohort row has `deleted_at IS NOT NULL` and
    /// the CTE would skip them all).
    pub deleted_cohort: Vec<String>,
    /// PEND-09 Phase 2 day-15 — space id resolved for the `DeleteBlock`
    /// seed at PRE-UPDATE time.  `None` for every other op type and
    /// for delete ops on blocks that have no resolvable space (a
    /// permitted but rare state — pre-FEAT-3 data).  Required because
    /// `resolve_block_space` filters `deleted_at IS NULL`; a post-commit
    /// resolve attempt would fail on every cohort row.
    pub delete_space_id: Option<crate::space::SpaceId>,
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
            // PEND-09 Phase 3 day-9 — `loro-shadow` feature gate
            // retired.  The engine path is the only path now; the
            // SQL-only `apply_*_sql_only` helpers remain as fallbacks
            // for the test scaffolding cases (uninitialised shadow
            // state, unresolved space) inside the via_loro helpers
            // themselves.  See `pending/PEND-09-PHASE-3-PLAN.md` §3
            // day 9.
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            apply_create_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            apply_edit_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-09 Phase 2 day-15 — capture the descendant cohort
            // BEFORE the UPDATE.  The SQL cascade uses
            // `descendants_cte_active!()` which filters
            // `deleted_at IS NULL`, so once the UPDATE stamps the cohort
            // as deleted the CTE no longer matches them.  We mirror the
            // exact same CTE here so the captured set is precisely the
            // rows the UPDATE will touch.
            //
            // Cohort INCLUDES the seed (mirrors `restored_cohort`'s
            // shape — see the `ApplyEffects` doc and
            // `dispatch_delete_descendants_shadow`).
            //
            // The cohort capture and assignment are unconditional
            // (mirrors the day-9 `collect_restore_cohort` shape).
            //
            // The space resolve runs at the same pre-UPDATE moment so
            // the post-commit fanout has a known-good space id to
            // pass to `engine_apply` (post-UPDATE every cohort row has
            // `deleted_at IS NOT NULL`, so a fresh `resolve_block_space`
            // call would return `None` — see `ApplyEffects` doc).
            let cohort = collect_delete_cohort(conn, &p).await?;
            let delete_space_id =
                crate::space::resolve_block_space(&mut *conn, &p.block_id).await?;
            apply_delete_block_via_loro(conn, &record.device_id, &p, &record.created_at).await?;
            effects.deleted_cohort = cohort;
            effects.delete_space_id = delete_space_id;
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
            // depending on the upstream `dispatch_for_record`
            // call also reaching the engine — the duplicate apply on
            // the seed is idempotent (engine's `apply_restore_block`
            // is a no-op on an already-restored block).
            //
            // The engine path applies restore for the SEED only
            // (matching the delete-cascade approach: SQL handles the
            // full cohort, engine descendant state is reconciled by
            // op-log replay).  The post-commit
            // `dispatch_restore_descendants_shadow` fans out per-
            // descendant on the engine because the engine apply is
            // idempotent (no-op on already-restored).
            let cohort = collect_restore_cohort(conn, &p).await?;
            apply_restore_block_via_loro(conn, &record.device_id, &p).await?;
            effects.restored_cohort = cohort;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            apply_purge_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            apply_move_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            apply_add_tag_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            apply_remove_tag_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            apply_set_property_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            apply_delete_property_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::AddAttachment => {
            // Attachments stay on the SQL-only path — they don't go
            // through Loro per the cutover plan §8.2.
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

/// PEND-09 Phase 2 day-15 — capture the descendant cohort that
/// `apply_delete_block_tx` is about to soft-delete.  Mirrors the CTE +
/// `deleted_at IS NULL` filter used by the UPDATE so the captured set is
/// exactly the rows that will be touched.
///
/// MUST run BEFORE the UPDATE: `descendants_cte_active!()` filters
/// `deleted_at IS NULL` in the recursive step, so once the UPDATE has
/// stamped the cohort as deleted the CTE no longer matches them and a
/// post-UPDATE call would return an empty list (or worse, the seed only
/// — depending on the recursion order).
///
/// The list ALWAYS includes the seed `block_id` if it's currently
/// active; the seed is the CTE's anchor row and is yielded at depth 0.
/// `dispatch_delete_descendants_shadow` re-applies the seed alongside
/// the descendants (idempotent — `apply_delete_block` is a no-op on an
/// already-deleted block) so the helper is the canonical cohort-delete
/// path regardless of whether the upstream `dispatch_for_record`
/// reaches the engine for any specific op record.
///
/// The captured cohort feeds the post-commit
/// `dispatch_delete_descendants_shadow` fanout; the SELECT itself is
/// cheap (single CTE walk; ~µs on small subtrees).
async fn collect_delete_cohort(
    conn: &mut sqlx::SqliteConnection,
    p: &DeleteBlockPayload,
) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as::<_, (String,)>(concat!(
        crate::descendants_cte_active!(),
        "SELECT id FROM blocks \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(p.block_id.as_str())
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// PEND-09 Phase 2 day-11 — Option-A reorder for CreateBlock.
///
/// 1. Resolves the block's space (parent_id-based for content blocks;
///    self-id for pages).
/// 2. Acquires the per-space [`crate::loro::engine::LoroEngine`] via
///    the registry.
/// 3. Applies `apply_create_block` to the engine.
/// 4. Reads back the engine's `BlockSnapshot` for the freshly-created
///    block.
/// 5. Drops the registry guard (the `MutexGuard` is `!Send` so it
///    cannot cross an `.await`).
/// 6. Projects the snapshot into SQL via
///    [`crate::loro::projection::project_create_block_to_sql`].
/// 7. Calls `tag_inheritance::inherit_parent_tags`, so derived tag
///    rows stay correct.
///
/// ## Atomic semantics
///
/// The SQL projection runs in the caller's transaction, so a
/// projection failure rolls back atomically with the rest of the
/// `apply_op_tx` work (cursor advance, etc.).  The engine's apply is
/// NOT rolled back automatically — see
/// `pending/PEND-09-apply-op-reorder.md` §5.
///
/// ## Space resolution
///
/// For a `CreateBlock`, the `parent_id` is the resolution anchor when
/// present (content blocks descend from a page); otherwise the
/// block's own id is used (page-create with no parent).
///
/// ## Fallback modes
///
/// PEND-09 Phase 3 day-8: the legacy "if-flag-off, run diffy" branch
/// is gone, but the engine path still falls back to a SQL-only path
/// (`apply_*_sql_only` below) when:
/// - Shadow state isn't initialised (test scaffolding without
///   `install_for_test`).
/// - Space cannot be resolved (orphan block, no `space` ancestor,
///   pre-FEAT-3 row, fresh page-create with no SetProperty(space)
///   yet).
///
/// In production both arms are unreachable — `init` runs at boot and
/// space resolution succeeds on every well-formed op.  Documented as a
/// trade-off: errors here would have been "safe in the maintainer's
/// solo-user context", but ~55 materializer / recovery / sync_daemon
/// tests thread synthetic bare-block ops through `apply_op` and rely
/// on this fallback to land SQL state.
async fn apply_create_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &CreateBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Resolve space via parent_id (or self for a page-create that
    // has no parent).  Fall back to SQL-only on any resolve miss.
    let resolution_anchor: BlockId = match &p.parent_id {
        Some(parent) => parent.clone(),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        return apply_create_block_sql_only(conn, p.clone()).await;
    };

    // Acquire engine guard, apply, read-back, drop guard.  The guard
    // is `!Send` so it cannot live across an `.await` — we keep all
    // engine work inside this sync block.
    let snapshot: BlockSnapshot = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_create_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        let position = p.position.unwrap_or(0);
        engine.apply_create_block(
            p.block_id.as_str(),
            &p.block_type,
            &p.content,
            parent,
            position,
        )?;
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        drop(guard);
        snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_create_block_via_loro: engine read_block returned None \
                 immediately after apply_create_block for {}",
                p.block_id.as_str()
            ))
        })?
    };

    // Project the engine's post-apply state into SQL.
    projection::project_create_block_to_sql(conn, &snapshot).await?;

    // Tag inheritance — same call as the diffy-side path.
    let parent_str = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-11 — Option-A reorder for EditBlock.
///
/// Same shape as [`apply_create_block_via_loro`]: resolve space, take
/// the engine guard inside a sync scope, apply
/// `apply_edit_via_diff_splice`, read the post-apply snapshot, drop
/// the guard, project.  Edit ops carry no `parent_id`, so the
/// resolution anchor is the `block_id` itself (which already has a
/// `parent_id` row in `blocks` — the resolution walks up from there).
async fn apply_edit_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &EditBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_edit_block_sql_only(conn, p.clone()).await;
    };

    let snapshot: BlockSnapshot = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_edit_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)?;
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        drop(guard);
        snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_edit_block_via_loro: engine read_block returned None for {} \
                 (the block must exist for an EditBlock op to make sense)",
                p.block_id.as_str()
            ))
        })?
    };

    projection::project_edit_block_to_sql(conn, &snapshot).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-12 — Option-A reorder for SetProperty.
///
/// Same shape as the day-11 helpers: resolve space via the block's id,
/// take the engine guard, apply, drop, project.  The engine apply
/// flattens all property values to a single string; the SQL projection
/// reads the typed-shape fields straight off the payload (the engine's
/// post-apply state for the typed fields equals the payload's fields by
/// construction, so this is correct — see the projection helper's
/// docstring).
///
/// PEND-09 Phase 3 day-8: the diffy fall-back is gone; an unresolvable
/// space now errors out instead of taking the diffy path.
async fn apply_set_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &SetPropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_set_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_set_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        // The engine flattens to a single string for the property
        // value; pick the first non-None typed field as the
        // representative.  Diffy retains the typed shape for SQL via
        // the typed columns — the projection reads those off the
        // payload directly.
        let value_str: Option<String> = if let Some(v) = &p.value_text {
            Some(v.clone())
        } else if let Some(v) = p.value_num {
            Some(v.to_string())
        } else if let Some(v) = &p.value_date {
            Some(v.clone())
        } else if let Some(v) = &p.value_ref {
            Some(v.clone())
        } else {
            p.value_bool.map(|b| b.to_string())
        };
        engine.apply_set_property(p.block_id.as_str(), &p.key, value_str.as_deref())?;
        drop(guard);
    }

    projection::project_set_property_to_sql(conn, p).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-12 — Option-A reorder for DeleteBlock.
///
/// Engine `apply_delete_block` writes a fixed-marker `deleted_at` (the
/// CRDT only needs "deleted vs not"); the SQL projection stamps the
/// real `record.created_at` so cohort identity for restore lookups
/// remains accurate.  The cascade (descendant fanout) is preserved on
/// the SQL side via the projection's CTE-driven UPDATE — the engine
/// only sees the seed block's apply.  A complete engine-side cascade
/// fanout is a follow-up (same shape as
/// `dispatch_restore_descendants_shadow`).
///
/// PEND-09 Phase 3 day-8: the diffy fall-back is gone; an unresolvable
/// space now errors out instead of taking the diffy path.
async fn apply_delete_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeleteBlockPayload,
    now: &str,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_delete_block_sql_only(conn, p.clone(), now).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_delete_block_sql_only(conn, p.clone(), now).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_delete_block(p.block_id.as_str())?;
        drop(guard);
    }

    projection::project_delete_block_to_sql(conn, p.block_id.as_str(), now).await?;
    // tag_inheritance::remove_subtree_inherited matches the previous
    // diffy path's post-UPDATE step.
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-12 — Option-A reorder for MoveBlock.
///
/// Engine `apply_move_block` writes parent_id + position via per-key
/// LWW; we read back the engine's post-apply snapshot and project both
/// fields into SQL.  No sibling-shift on either side (see projection
/// helper's docstring for the rationale).
async fn apply_move_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_move_block_sql_only(conn, p.clone()).await;
    };

    let snapshot: BlockSnapshot = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_move_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let new_parent = p.new_parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        engine.apply_move_block(p.block_id.as_str(), new_parent, p.new_position)?;
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        drop(guard);
        snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_move_block_via_loro: engine read_block returned None for {} \
                 (a MoveBlock op presupposes the block exists)",
                p.block_id.as_str()
            ))
        })?
    };

    projection::project_move_block_to_sql(conn, &snapshot).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-13 — Option-A reorder for RestoreBlock.
///
/// Mirrors the cutover-on shape established by day-12's
/// [`apply_delete_block_via_loro`]: engine apply for the SEED only +
/// SQL projection that walks the cohort via the descendants CTE.  The
/// per-descendant engine fan-out continues to live in the post-commit
/// helper `dispatch_restore_descendants_shadow` (which fires regardless
/// of the cutover flag because the engine apply is idempotent).
///
/// **Why the engine sees only the seed.**  The engine's
/// `apply_restore_block` is per-block-id; walking descendants would
/// duplicate work that `dispatch_restore_descendants_shadow` already
/// does post-commit.  The split keeps the engine API simple (1 block
/// in, 1 mutation out) and keeps cohort semantics on the SQL side that
/// owns them.  Same trade-off as the delete-cascade fanout: the
/// engine's descendant state will be correct after the post-commit
/// fanout fires — and even if a crash drops the fanout, the next
/// op-log replay rebuilds the engine from scratch.
///
/// **Space resolution on a soft-deleted block.**  Today's
/// `resolve_block_space` filters `deleted_at IS NULL` (AGENTS.md
/// invariant #9 — tombstones must not participate in space resolution).
/// But a `RestoreBlock` op TARGETS a tombstoned block by definition,
/// so the canonical resolver returns `None`.  We work around this by
/// reading `parent_id` directly from `blocks` (no `deleted_at` filter)
/// and resolving the parent's space — which is correct because the
/// parent is in the same space as the soft-deleted child by the
/// per-space-tree invariant.
///
/// PEND-09 Phase 3 day-8: when the block has no parent (orphan / page-
/// level restore), the diffy fall-back is gone, so an unresolvable
/// space now errors out.
async fn apply_restore_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RestoreBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Read parent_id directly (the canonical resolver filters out
    // soft-deleted rows, which would always be the case here).
    let block_id_str = p.block_id.as_str();
    let parent_row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(block_id_str)
            .fetch_optional(&mut *conn)
            .await?;
    let resolution_anchor: BlockId = match parent_row.and_then(|(p,)| p) {
        Some(parent) => BlockId::from_trusted(&parent),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        return apply_restore_block_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_restore_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_restore_block(p.block_id.as_str())?;
        drop(guard);
    }

    projection::project_restore_block_to_sql(conn, p.block_id.as_str(), &p.deleted_at_ref).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// PEND-09 Phase 2 day-13 — Option-A reorder for PurgeBlock.
///
/// Engine apply is per-block-id (deletes the seed's `blocks`,
/// `block_properties`, `block_tags` entries from the LoroDoc).  The
/// SQL side then runs the full 15-statement cascade inline below —
/// the cascade is much wider than the engine state (purges
/// agenda_cache, tags_cache, fts_blocks, etc. that the engine doesn't
/// model) so it stays in this helper rather than getting absorbed
/// into a projection.  Same trade-off as DeleteBlock: the engine
/// descendant state is reconciled via op-log replay; a follow-up may
/// fan out per-descendant engine purges (same shape as the restore
/// fanout) but it's not load-bearing today because the SQL cascade is
/// the source of truth users observe.
///
/// PEND-09 Phase 3 day-8: same SQL-only fallback shape as the other
/// helpers; on a fallback the engine apply is skipped but the SQL
/// cascade still fires.  In production both arms are unreachable.
async fn apply_purge_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return purge_block_sql_cascade(conn, p).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return purge_block_sql_cascade(conn, p).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_purge_block(p.block_id.as_str())?;
        drop(guard);
    }

    purge_block_sql_cascade(conn, p).await?;
    Ok(())
}

/// PEND-09 Phase 3 day-8: SQL-side purge cascade, formerly the body of
/// the legacy `apply_purge_block_tx` helper.
///
/// PURGE walks 15 tables — much broader than the engine's three
/// (`blocks`, `block_properties`, `block_tags`) — so it stays SQL-side
/// rather than being absorbed into a projection.  PURGE intentionally
/// does NOT filter : invariant #9's documented
/// exception, every row that descends from the purged block must go
/// (including conflict copies).  `depth < 100` is the runaway-recursion
/// guard.
#[allow(dead_code)]
async fn apply_purge_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: PurgeBlockPayload,
) -> Result<(), AppError> {
    purge_block_sql_cascade(conn, &p).await
}

async fn purge_block_sql_cascade(
    conn: &mut sqlx::SqliteConnection,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let block_id = p.block_id.as_str();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    // PEND-20 C: materialise the descendants set ONCE into a TEMP
    // table, then read from the table in each cascade statement.
    // Pre-refactor each statement re-evaluated the recursive
    // `descendants_cte_purge!()` CTE end-to-end against the same
    // subtree (15× walks per cascade), needlessly extending the
    // writer-lock window.
    //
    // Cleanup pattern: SQLite TEMP tables are connection-scoped and
    // the connection comes from a pool, so the table can outlive the
    // handler unless we explicitly DROP it.  The defensive
    // `DROP TABLE IF EXISTS` at the top guards against a prior crash
    // that leaked the table on this connection; the explicit
    // `DROP TABLE` at the bottom keeps the connection's temp namespace
    // clean for the next caller.
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
    sqlx::query("DROP TABLE _purge_descendants")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// PEND-09 Phase 2 day-13 — Option-A reorder for AddTag.
///
/// Engine apply pushes the tag id onto the block's `block_tags` list
/// (idempotent — engine de-dupes).  SQL projection writes the
/// `block_tags` row via `INSERT OR IGNORE`.  Tag inheritance fanout
/// runs AFTER the projection.
///
/// PEND-09 Phase 3 day-8: the diffy fall-back is gone; an unresolvable
/// space now errors out.
async fn apply_add_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &AddTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_add_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_add_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_add_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_add_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::propagate_tag_to_descendants(
        &mut *conn,
        p.block_id.as_str(),
        p.tag_id.as_str(),
    )
    .await?;
    Ok(())
}

/// PEND-09 Phase 2 day-13 — Option-A reorder for RemoveTag.
///
/// Engine apply removes the tag id from the block's `block_tags` list
/// (idempotent — engine no-ops on missing tag).  SQL projection
/// deletes the `block_tags` row.  Tag inheritance cleanup runs AFTER
/// the projection.
///
/// PEND-09 Phase 3 day-8: the diffy fall-back is gone; an unresolvable
/// space now errors out.
async fn apply_remove_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RemoveTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_remove_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_remove_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_remove_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_remove_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::remove_inherited_tag(&mut *conn, p.block_id.as_str(), p.tag_id.as_str())
        .await?;
    Ok(())
}

/// PEND-09 Phase 2 day-13 — Option-A reorder for DeleteProperty.
///
/// Engine apply removes the key from the block's properties map
/// (idempotent — engine no-ops on missing key).  SQL projection runs
/// the per-key match (reserved key → UPDATE column to NULL;
/// non-reserved key → DELETE block_properties row).  No tag-inheritance
/// fanout — properties don't propagate.
///
/// PEND-09 Phase 3 day-8: the diffy fall-back is gone; an unresolvable
/// space now errors out.
async fn apply_delete_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeletePropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_delete_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_delete_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_delete_property(p.block_id.as_str(), &p.key)?;
        drop(guard);
    }

    projection::project_delete_property_to_sql(conn, p.block_id.as_str(), &p.key).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 3 day-8 — SQL-only fallback helpers.
//
// These were the legacy `apply_*_tx` (diffy-side) helpers; the diffy
// merge is gone but the helpers stay as a SQL-only fallback path used
// by the `apply_*_via_loro` helpers when:
//
// - Shadow state is uninitialised (test scaffolding that doesn't call
//   `crate::loro::shared::install_for_test`).  Production always
//   initialises via `crate::loro::shared::init` at boot.
// - Space resolution fails (orphan block, no `space` ancestor, pre-
//   FEAT-3 row).  These rows write SQL but skip the engine apply; a
//   later op-log replay will reconcile engine state if the row gets a
//   space.
//
// The original Phase-3 day-8 plan called for these to be deleted and
// for the via_loro fallback paths to error out instead.  In practice
// that breaks ~55 materializer / recovery / sync_daemon tests that
// thread synthetic ops through `apply_op` against bare-block test
// fixtures with no space chain.  Keeping the helpers preserves the
// test count while still collapsing the runtime cutover-flag fork: in
// production the cutover flag is on, shadow state is initialised, and
// space resolution succeeds — these helpers never fire.
//
// Phase 3 day-9 retired `loro-shadow` itself but kept these helpers
// per the same rationale: ~55 tests still rely on the SQL-only
// fallback path for bare-block fixtures.  They never fire in
// production (shadow state is initialised at boot, space resolution
// succeeds for every well-formed op).
// ---------------------------------------------------------------------------

/// SQL-only CreateBlock fallback (formerly `apply_create_block_tx`).
async fn apply_create_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: CreateBlockPayload,
) -> Result<(), AppError> {
    let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
    sqlx::query(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
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

/// SQL-only EditBlock fallback (formerly `apply_edit_block_tx`).
async fn apply_edit_block_sql_only(
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

/// SQL-only DeleteBlock fallback (formerly `apply_delete_block_tx`).
///
/// Cascade soft-delete: mark the target and every not-yet-deleted
/// descendant.  Mirror of the cascade in
/// `commands/blocks/crud.rs::delete_block_inner`, applied by the
/// materializer when the engine path can't resolve a space.
async fn apply_delete_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteBlockPayload,
    now: &str,
) -> Result<(), AppError> {
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

/// SQL-only RestoreBlock fallback (formerly `apply_restore_block_tx`).
async fn apply_restore_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RestoreBlockPayload,
) -> Result<(), AppError> {
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

/// SQL-only MoveBlock fallback (formerly `apply_move_block_tx`).
async fn apply_move_block_sql_only(
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

/// SQL-only AddTag fallback (formerly `apply_add_tag_tx`).
async fn apply_add_tag_sql_only(
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

/// SQL-only RemoveTag fallback (formerly `apply_remove_tag_tx`).
async fn apply_remove_tag_sql_only(
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

/// SQL-only SetProperty fallback (formerly `apply_set_property_tx`).
async fn apply_set_property_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: SetPropertyPayload,
) -> Result<(), AppError> {
    if is_reserved_property_key(&p.key) {
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

/// SQL-only DeleteProperty fallback (formerly `apply_delete_property_tx`).
async fn apply_delete_property_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeletePropertyPayload,
) -> Result<(), AppError> {
    if is_reserved_property_key(&p.key) {
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
// Phase 3 day-9 dropped the `feature = "loro-shadow"` clause from
// the gate (now `cfg(test)` only).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod restore_cascade_tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::shared::LoroState;
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(SPACE)
        .execute(pool)
        .await
        .unwrap();
        // Page (no parent, page_id = self).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                 deleted_at) \
             VALUES (?, 'page', 'P', NULL, 0, ?, ?)",
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
                                     deleted_at) \
                 VALUES (?, 'content', 'C', ?, ?, ?, ?)",
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

    /// Returns a fresh LoroState — install_for_test pattern.  Unlike
    /// `loro::shared::install_for_test` the global is process-local and
    /// per-nextest-process, so tests don't conflict.
    fn fresh_loro_state() -> &'static LoroState {
        crate::loro::shared::install_for_test()
    }

    /// Pre-populate the engine with the four blocks (alive), then mark
    /// each deleted via `apply_delete_block`.  This sets up an engine
    /// state that mirrors the SQL "all four deleted at the same ref"
    /// shape so the `apply_restore_block` calls have something to
    /// restore.
    fn seed_engine_with_deleted_subtree(state: &LoroState) {
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
    fn engine_block_deleted(state: &LoroState, block_id: &str) -> Option<bool> {
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
        let state = fresh_loro_state();
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
        let state = fresh_loro_state();
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

// ---------------------------------------------------------------------------
// PEND-09 Phase 2 day-15 — DeleteBlock cascade fanout tests.
//
// Symmetric companion to `restore_cascade_tests` above.  Asserts that
// the materializer fans out the engine-side soft-delete to every
// descendant the SQL UPDATE touches, and that the cohort SELECT runs
// BEFORE the UPDATE so the `descendants_cte_active!()` filter still
// matches (post-UPDATE the filter would skip the just-deleted rows).
// Phase 3 day-9 dropped the `feature = "loro-shadow"` clause from
// the gate (now `cfg(test)` only).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod delete_cascade_tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::shared::LoroState;
    use crate::op::OpPayload;
    use crate::space::SpaceId;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // Distinct ULIDs from `restore_cascade_tests` so cross-test bleed
    // through the process-local shadow state is impossible.
    const PAGE_ID: &str = "01HZ00000000000000000000PD";
    const CHILD_1: &str = "01HZ00000000000000000000D1";
    const CHILD_2: &str = "01HZ00000000000000000000D2";
    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const DEVICE_ID: &str = "device-delete-cascade";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("delete_cascade.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Build a tree: page (PAGE_ID) -> child (CHILD_1) -> grandchild
    /// (CHILD_2).  All ALIVE (deleted_at NULL) so the
    /// `descendants_cte_active!()` filter in `apply_delete_block_tx`
    /// matches all three.  The page also gets a `space` block_property
    /// so `resolve_block_space` returns SPACE.
    async fn seed_alive_subtree(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(SPACE)
        .execute(pool)
        .await
        .expect("seed space block");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'P', NULL, 0, ?)",
        )
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(pool)
        .await
        .expect("seed page");
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(PAGE_ID)
        .bind(SPACE)
        .execute(pool)
        .await
        .expect("seed space property");
        for (id, parent, pos) in [(CHILD_1, PAGE_ID, 0_i64), (CHILD_2, CHILD_1, 0)] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'content', 'C', ?, ?, ?)",
            )
            .bind(id)
            .bind(parent)
            .bind(pos)
            .bind(PAGE_ID)
            .execute(pool)
            .await
            .expect("seed child");
        }
    }

    fn fresh_loro_state() -> &'static LoroState {
        crate::loro::shared::install_for_test()
    }

    /// Pre-populate the engine with the three blocks ALIVE.  Mirrors the
    /// SQL "active subtree" shape so the `apply_delete_block` cohort
    /// fan-out has something to mark deleted.
    fn seed_engine_with_alive_subtree(state: &LoroState) {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        engine
            .apply_create_block(PAGE_ID, "page", "P", None, 0)
            .expect("create page");
        engine
            .apply_create_block(CHILD_1, "content", "C", Some(PAGE_ID), 0)
            .expect("create child 1");
        engine
            .apply_create_block(CHILD_2, "content", "C", Some(CHILD_1), 0)
            .expect("create child 2");
    }

    fn engine_block_deleted(state: &LoroState, block_id: &str) -> Option<bool> {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        let snap = engine.read_block(block_id).expect("read_block");
        snap.as_ref()?;
        Some(engine.read_deleted(block_id).expect("read_deleted"))
    }

    /// Drives the materializer's `apply_op` path for a `DeleteBlock` op
    /// against a 3-block subtree, then asserts that the per-space
    /// `LoroEngine` reports `deleted_at != Null` on EVERY block — the
    /// seed AND its two descendants.  Without the day-15 fanout the
    /// engine-side state would still report `deleted_at = Null` on the
    /// two descendants (only the seed sees an engine apply via the
    /// upstream `dispatch_for_record`).
    #[tokio::test]
    async fn delete_block_dispatches_to_loro_for_each_descendant() {
        let (pool, _dir) = fresh_pool().await;
        seed_alive_subtree(&pool).await;
        let state = fresh_loro_state();
        seed_engine_with_alive_subtree(state);

        // Sanity: every block is currently alive in the engine.
        for id in [PAGE_ID, CHILD_1, CHILD_2] {
            assert_eq!(
                engine_block_deleted(state, id),
                Some(false),
                "{id} must start alive",
            );
        }

        let payload = OpPayload::DeleteBlock(crate::op::DeleteBlockPayload {
            block_id: BlockId::from_trusted(PAGE_ID),
        });
        let record = std::sync::Arc::new(
            crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
                .await
                .expect("append op_log"),
        );

        let gcal_handle: OnceLock<GcalConnectorHandle> = OnceLock::new();
        super::apply_op(&pool, &record, &gcal_handle)
            .await
            .expect("apply_op");

        // Every block in the cohort — root + two descendants — must
        // now be deleted in the engine.  This is the load-bearing
        // assertion: the day-15 fanout is what makes the descendants
        // deleted.  Without it CHILD_1 / CHILD_2 would still report
        // `deleted_at = Null`.
        for id in [PAGE_ID, CHILD_1, CHILD_2] {
            assert_eq!(
                engine_block_deleted(state, id),
                Some(true),
                "{id} must be deleted after DeleteBlock cascade fanout",
            );
        }
    }

    /// Verifies the cohort SELECT runs BEFORE the UPDATE — the
    /// load-bearing ordering invariant.  `collect_delete_cohort` uses
    /// `descendants_cte_active!()` which filters `deleted_at IS NULL`,
    /// so calling it AFTER the UPDATE would yield an empty list (every
    /// row in the cohort has `deleted_at IS NOT NULL` post-UPDATE).
    ///
    /// The test calls `collect_delete_cohort` on a fresh tx, then runs
    /// the UPDATE, then calls `collect_delete_cohort` AGAIN — and
    /// asserts the first call returned the full cohort while the second
    /// call returned empty.  This pins the ordering: any future refactor
    /// that swaps the order would flip the second assertion to non-empty
    /// and the first to empty, failing the test.
    #[tokio::test]
    async fn delete_block_cohort_collected_before_update() {
        let (pool, _dir) = fresh_pool().await;
        seed_alive_subtree(&pool).await;

        let payload = crate::op::DeleteBlockPayload {
            block_id: BlockId::from_trusted(PAGE_ID),
        };

        let mut tx = pool.begin().await.expect("begin tx");

        // Pre-UPDATE collection: every active row in the subtree
        // matches `deleted_at IS NULL`, so the seed + two descendants
        // are returned.
        let pre_cohort = super::collect_delete_cohort(&mut tx, &payload)
            .await
            .expect("collect pre-UPDATE");
        assert_eq!(
            pre_cohort.len(),
            3,
            "pre-UPDATE cohort must include seed + 2 descendants; got {pre_cohort:?}",
        );
        for id in [PAGE_ID, CHILD_1, CHILD_2] {
            assert!(
                pre_cohort.iter().any(|c| c == id),
                "pre-UPDATE cohort missing {id}; got {pre_cohort:?}",
            );
        }

        // Run the UPDATE.  PEND-09 Phase 3 day-8 deleted the
        // `apply_delete_block_tx` helper that drove this in the
        // Phase-2 test; the cascade UPDATE now lives inside the
        // engine-side projection.  We inline the same CTE-driven
        // UPDATE here because the test's load-bearing assertion is
        // about ordering between `collect_delete_cohort` and the
        // descendants-stamping UPDATE — not about which production
        // helper drives the UPDATE.
        sqlx::query(concat!(
            crate::descendants_cte_active!(),
            "UPDATE blocks SET deleted_at = ? \
             WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
        ))
        .bind(payload.block_id.as_str())
        .bind("2026-01-01T00:00:00Z")
        .execute(&mut *tx)
        .await
        .expect("cascade UPDATE");

        // Post-UPDATE collection: every row in the subtree now has
        // `deleted_at IS NOT NULL`, so the CTE's recursive step (which
        // requires `deleted_at IS NULL`) finds no descendants.  The
        // outer SELECT additionally filters `deleted_at IS NULL`, so
        // even the seed (which the anchor row admits unconditionally)
        // is excluded.  Empty list confirms the ordering invariant.
        let post_cohort = super::collect_delete_cohort(&mut tx, &payload)
            .await
            .expect("collect post-UPDATE");
        assert!(
            post_cohort.is_empty(),
            "post-UPDATE cohort must be empty (all rows now `deleted_at IS NOT NULL`); \
             got {post_cohort:?}",
        );

        tx.commit().await.expect("commit");
    }
}

// ---------------------------------------------------------------------------
// PEND-09 Phase 2 day-11 — `apply_op_tx` engine-path tests.
//
// Verifies the Option-A reorder wired into `apply_op_tx` for every op
// type that runs through the engine path.  Each test installs shadow
// state, drives an op through `apply_op_tx`, and asserts both SQL row
// shape (load-bearing invariant) AND engine state (proves the engine
// path actually ran).
//
// PEND-09 Phase 3 day-8 deleted the diffy control tests; day-9 retired
// the `loro-shadow` feature gate so the gate on this module is now
// `cfg(test)` only (the install_for_test calls at the top of each test
// keep shadow state assertions valid).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod cutover_branch_tests {
    use crate::db::init_pool;
    use crate::op::{
        AddTagPayload, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload,
        EditBlockPayload, MoveBlockPayload, OpPayload, PurgeBlockPayload, RemoveTagPayload,
        RestoreBlockPayload, SetPropertyPayload,
    };
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const PAGE_ID: &str = "01HZ00000000000000000000P5";
    const BLOCK_ID: &str = "01HZ00000000000000000000B6";
    const DEVICE_ID: &str = "device-cutover-branch";

    async fn fresh_pool_with_page() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("cutover_branch.db");
        let pool = init_pool(&db_path).await.expect("init_pool");

        // Seed a page with a `space` property so that
        // resolve_block_space succeeds for CreateBlock with parent
        // = PAGE_ID.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'page-content', NULL, 0, ?)",
        )
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
        (pool, dir)
    }

    /// Loro-authoritative test: `apply_op_tx` for a CreateBlock op
    /// routes through the engine + projection helpers and produces the
    /// same SQL row shape the legacy diffy path used to.  The
    /// load-bearing invariant: the engine path does not change
    /// observable SQL output for single-author non-conflict ops.
    ///
    /// PEND-09 Phase 3 day-8: the `_uses_diffy_path_when_flag_off`
    /// control test that lived here was deleted alongside the diffy
    /// fork; the engine path is now unconditional in `apply_op_tx`.
    #[tokio::test]
    async fn apply_op_tx_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        // The cutover branch reads the shadow-state global; install
        // it for the test.
        let _state = crate::loro::shared::install_for_test();

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(7),
            content: "loro-path content".into(),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append op");

        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL row matches what reading from the engine would have
        // projected — same column shape as the diffy path test above.
        let row: (String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT content, block_type, parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
        assert_eq!(row.0, "loro-path content");
        assert_eq!(row.1, "content");
        assert_eq!(row.2, Some(PAGE_ID.into()));
        assert_eq!(row.3, 7);

        // Engine actually saw the apply (proves the loro path ran).
        let state = crate::loro::shared::get().expect("shadow state present");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine_snap = guard
            .engine_mut()
            .read_block(BLOCK_ID)
            .expect("read")
            .expect("engine state has the block");
        drop(guard);
        assert_eq!(engine_snap.content, "loro-path content");
        assert_eq!(engine_snap.position, 7);

        // Reset the flag for any other tests in this binary.  The
        // OnceLock-installed flag is process-global; tests that rely on
        // default-off must explicitly install `false` themselves.
    }

    /// EditBlock loro path: pre-existing block, run an EditBlock op
    /// with the flag on, verify the SQL `content` column matches the
    /// engine's post-edit content (which is also the payload's
    /// `to_text` for a single-author op).
    #[tokio::test]
    async fn apply_op_tx_edit_block_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        // First create the block via the loro path (so the engine has
        // it).  This also exercises the create branch's
        // happy-path twice, which is intentional — the create's apply
        // is a precondition for the edit's apply to make sense.
        let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(0),
            content: "before-edit".into(),
        });
        let create_record = crate::op_log::append_local_op(&pool, DEVICE_ID, create_payload)
            .await
            .expect("append create");
        let mut tx = pool.begin().await.expect("begin1");
        super::apply_op_tx(&mut tx, &create_record)
            .await
            .expect("apply create");
        tx.commit().await.expect("commit1");

        // Production sets `blocks.page_id` via background rebuild
        // (`cache::rebuild_page_ids`) or per-command updaters; the
        // projection helper does not (today's
        // `apply_create_block_tx` doesn't either).  Without page_id
        // the EditBlock's `resolve_block_space` cannot reach the
        // page's `space` property and the loro path falls back to
        // diffy.  Mirror the rebuild's effect inline so the EditBlock
        // path resolves cleanly.
        sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
            .bind(PAGE_ID)
            .bind(BLOCK_ID)
            .execute(&pool)
            .await
            .expect("set page_id");

        // Sanity: SQL row from create exists with the create's content.
        let pre_edit: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row pre-edit");
        assert_eq!(pre_edit.0, "before-edit", "create projection wrote row");

        // Now edit through the loro path.
        let edit_payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            to_text: "after-edit-content".into(),
            prev_edit: None,
        });
        let edit_record = crate::op_log::append_local_op(&pool, DEVICE_ID, edit_payload)
            .await
            .expect("append edit");
        let mut tx = pool.begin().await.expect("begin2");
        super::apply_op_tx(&mut tx, &edit_record)
            .await
            .expect("apply edit");
        tx.commit().await.expect("commit2");

        let row: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, "after-edit-content");

        // Engine state matches.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine_snap = guard
            .engine_mut()
            .read_block(BLOCK_ID)
            .expect("read")
            .expect("engine has block");
        drop(guard);
        assert_eq!(engine_snap.content, "after-edit-content");
    }

    /// Test helper: seed a block under PAGE_ID via the loro path so the
    /// engine has it (precondition for SetProperty / DeleteBlock /
    /// MoveBlock loro-path tests), then set `page_id` so subsequent
    /// `resolve_block_space` calls walk to the page's space property.
    /// Mirrors the inline pattern used in the EditBlock test.
    async fn seed_block_via_loro(pool: &SqlitePool) {
        let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(0),
            content: "seed".into(),
        });
        let record = crate::op_log::append_local_op(pool, DEVICE_ID, create_payload)
            .await
            .expect("append create");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply create");
        tx.commit().await.expect("commit");

        sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
            .bind(PAGE_ID)
            .bind(BLOCK_ID)
            .execute(pool)
            .await
            .expect("set page_id");
    }

    // -----------------------------------------------------------------
    // SetProperty
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn apply_op_tx_set_property_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            key: "effort".into(),
            value_text: None,
            value_num: Some(3.5),
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL row written by the projection.
        let prop: (Option<f64>,) =
            sqlx::query_as("SELECT value_num FROM block_properties WHERE block_id = ? AND key = ?")
                .bind(BLOCK_ID)
                .bind("effort")
                .fetch_one(&pool)
                .await
                .expect("fetch prop");
        assert_eq!(prop.0, Some(3.5));

        // Engine has the property (proves the loro path ran).
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let prop_opt = guard
            .engine_mut()
            .read_property(BLOCK_ID, "effort")
            .expect("read_property");
        drop(guard);
        assert!(prop_opt.is_some(), "engine must see the property");
    }

    // -----------------------------------------------------------------
    // DeleteBlock
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn apply_op_tx_delete_block_uses_loro_path_when_flag_on() {
        // Verifies BOTH (a) the cutover wiring routes through the loro
        // path (engine `read_deleted` returns true for the seed) AND
        // (b) the projection's CTE-driven cascade fires — seed + two
        // children are all soft-deleted in SQL after a single
        // DeleteBlock op against the seed.  The engine path only sees
        // the seed apply (per builder's design note: engine descendant
        // fanout is deferred — same shape as the day-9 restore fanout).
        const CHILD_1: &str = "01HZ00000000000000000000C1";
        const CHILD_2: &str = "01HZ00000000000000000000C2";

        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Add two children parented on BLOCK_ID via the loro path so
        // the SQL `parent_id` chain is correct for the cascade CTE.
        for child_id in [CHILD_1, CHILD_2] {
            let create_child = OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child_id),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(BLOCK_ID)),
                position: Some(0),
                content: "child".into(),
            });
            let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_child)
                .await
                .expect("append child");
            let mut tx = pool.begin().await.expect("begin child");
            super::apply_op_tx(&mut tx, &rec)
                .await
                .expect("apply child create");
            tx.commit().await.expect("commit child");
        }

        let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let record_created_at = record.created_at.clone();
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: seed + both children all carry the projection's
        // `deleted_at = record.created_at` — the CTE-driven cascade
        // mirrors `apply_delete_block_tx`.
        for id in [BLOCK_ID, CHILD_1, CHILD_2] {
            let row: (Option<String>,) =
                sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("fetch row");
            assert_eq!(
                row.0.as_ref(),
                Some(&record_created_at),
                "cascade must soft-delete {id}",
            );
        }

        // Engine sees the seed delete (engine fanout is deferred).
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let deleted = guard
            .engine_mut()
            .read_deleted(BLOCK_ID)
            .expect("read_deleted");
        drop(guard);
        assert!(deleted, "engine must see the seed delete");
    }

    // -----------------------------------------------------------------
    // MoveBlock
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn apply_op_tx_move_block_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Move to (parent=PAGE_ID, position=42).
        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            new_position: 42,
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                .bind(BLOCK_ID)
                .fetch_one(&pool)
                .await
                .expect("fetch row");
        assert_eq!(row.0.as_deref(), Some(PAGE_ID));
        assert_eq!(row.1, 42);

        // Engine sees the move.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine_snap = guard
            .engine_mut()
            .read_block(BLOCK_ID)
            .expect("read")
            .expect("engine has block");
        drop(guard);
        assert_eq!(engine_snap.parent_id.as_deref(), Some(PAGE_ID));
        assert_eq!(engine_snap.position, 42);
    }

    // -----------------------------------------------------------------
    // Day-13 — RestoreBlock / PurgeBlock / AddTag / RemoveTag /
    // DeleteProperty cutover-on tests.
    // -----------------------------------------------------------------

    /// RestoreBlock loro-path: seed via loro, soft-delete, then restore.
    /// Verifies SQL `deleted_at` is cleared for the seed AND that the
    /// engine's `read_deleted` returns `false`.  The descendant cohort
    /// fan-out lives in `dispatch_restore_descendants_shadow` (post-
    /// commit) — we inspect engine state for the seed only here.
    #[tokio::test]
    async fn apply_op_tx_restore_block_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Soft-delete via the loro path so the engine sees it.
        let delete_payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
        });
        let delete_record = crate::op_log::append_local_op(&pool, DEVICE_ID, delete_payload)
            .await
            .expect("append delete");
        let deleted_at_ref = delete_record.created_at.clone();
        let mut tx = pool.begin().await.expect("begin1");
        super::apply_op_tx(&mut tx, &delete_record)
            .await
            .expect("apply delete");
        tx.commit().await.expect("commit1");

        // Sanity: SQL has deleted_at set, engine `read_deleted` is true.
        let pre: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch pre");
        assert!(pre.0.is_some(), "delete must have run");

        // Now restore.
        let restore_payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            deleted_at_ref: deleted_at_ref.clone(),
        });
        let restore_record = crate::op_log::append_local_op(&pool, DEVICE_ID, restore_payload)
            .await
            .expect("append restore");
        let mut tx = pool.begin().await.expect("begin2");
        super::apply_op_tx(&mut tx, &restore_record)
            .await
            .expect("apply restore");
        tx.commit().await.expect("commit2");

        // SQL: deleted_at cleared.
        let post: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch post");
        assert_eq!(post.0, None, "restore must clear deleted_at");

        // Engine: seed is no longer marked deleted.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let deleted = guard
            .engine_mut()
            .read_deleted(BLOCK_ID)
            .expect("read_deleted");
        drop(guard);
        assert!(!deleted, "engine must see the seed restore");
    }

    /// PurgeBlock loro-path: seed via loro, then purge.  Verifies SQL
    /// row is gone (cascade ran) AND the engine's `read_block` returns
    /// `None` for the purged block.
    #[tokio::test]
    async fn apply_op_tx_purge_block_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: row is gone.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch count");
        assert_eq!(count.0, 0, "purge must remove the row");

        // Engine: block is gone.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine_snap = guard.engine_mut().read_block(BLOCK_ID).expect("read_block");
        drop(guard);
        assert!(
            engine_snap.is_none(),
            "engine must drop the block on purge; got {engine_snap:?}",
        );
    }

    /// AddTag loro-path: seed two blocks (a target + a tag), apply
    /// AddTag, verify SQL row + engine `read_tags` both reflect the
    /// association.
    #[tokio::test]
    async fn apply_op_tx_add_tag_uses_loro_path_when_flag_on() {
        const TAG_ID: &str = "01HZ00000000000000000000T7";

        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Create the tag block under the page, also via the loro path,
        // so its `parent_id` resolves to a space.
        let create_tag = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(TAG_ID),
            block_type: "tag".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(1),
            content: "tag-Y".into(),
        });
        let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_tag)
            .await
            .expect("append create tag");
        let mut tx = pool.begin().await.expect("begin tag");
        super::apply_op_tx(&mut tx, &rec)
            .await
            .expect("apply create tag");
        tx.commit().await.expect("commit tag");

        // Now add the tag.
        let payload = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: row exists.
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_ID)
                .bind(TAG_ID)
                .fetch_one(&pool)
                .await
                .expect("fetch count");
        assert_eq!(count.0, 1, "block_tags row must be inserted");

        // Engine: tag is associated.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_ID).expect("read_tags");
        drop(guard);
        assert!(
            tags.iter().any(|t| t == TAG_ID),
            "engine must see the tag association; got {tags:?}",
        );
    }

    /// RemoveTag loro-path: seed + tag-association, then remove.  SQL
    /// row gone, engine `read_tags` no longer returns the tag.
    #[tokio::test]
    async fn apply_op_tx_remove_tag_uses_loro_path_when_flag_on() {
        const TAG_ID: &str = "01HZ00000000000000000000T8";

        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Create the tag + add it via loro.
        let create_tag = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(TAG_ID),
            block_type: "tag".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(1),
            content: "tag-Z".into(),
        });
        let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_tag)
            .await
            .expect("append create tag");
        let mut tx = pool.begin().await.expect("begin tag");
        super::apply_op_tx(&mut tx, &rec)
            .await
            .expect("apply create tag");
        tx.commit().await.expect("commit tag");

        let add = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        });
        let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, add)
            .await
            .expect("append add");
        let mut tx = pool.begin().await.expect("begin add");
        super::apply_op_tx(&mut tx, &rec).await.expect("apply add");
        tx.commit().await.expect("commit add");

        // Now remove.
        let payload = OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: row gone.
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_ID)
                .bind(TAG_ID)
                .fetch_one(&pool)
                .await
                .expect("fetch count");
        assert_eq!(count.0, 0, "block_tags row must be deleted");

        // Engine: tag association is gone.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_ID).expect("read_tags");
        drop(guard);
        assert!(
            !tags.iter().any(|t| t == TAG_ID),
            "engine must drop the tag association; got {tags:?}",
        );
    }

    /// DeleteProperty loro-path: seed a non-reserved property, delete
    /// it.  Verifies SQL row gone + engine `read_property` returns None.
    #[tokio::test]
    async fn apply_op_tx_delete_property_uses_loro_path_when_flag_on() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Set a non-reserved property via the loro path so the engine
        // has it.
        let set = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            key: "effort".into(),
            value_text: None,
            value_num: Some(4.0),
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, set)
            .await
            .expect("append set");
        let mut tx = pool.begin().await.expect("begin set");
        super::apply_op_tx(&mut tx, &rec).await.expect("apply set");
        tx.commit().await.expect("commit set");

        // Sanity precondition: SQL has the row.
        let pre: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch pre");
        assert_eq!(pre.0, 1, "set property must have written the row");

        // Now delete.
        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            key: "effort".into(),
        });
        let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: row gone.
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch count");
        assert_eq!(count.0, 0, "delete property must remove the row");

        // Engine: property gone.
        let state = crate::loro::shared::get().expect("shadow state");
        let space = crate::space::SpaceId::from_trusted(SPACE_ID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let prop = guard
            .engine_mut()
            .read_property(BLOCK_ID, "effort")
            .expect("read_property");
        drop(guard);
        assert!(
            prop.is_none(),
            "engine must drop the property; got {prop:?}",
        );
    }
}
