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
            // #382 — SINGLE-DEVICE-BATCH ASSUMPTION.
            //
            // `op_log.seq` is a PER-DEVICE counter (the PK is
            // `(device_id, seq)`); it is NOT a global key. This arm
            // computes a single `max_seq` across every record and
            // advances ONE global apply cursor to it (see below). That
            // is only correct when every record in the batch shares one
            // `device_id` — otherwise a per-device watermark cannot be
            // represented by a single scalar cursor.
            //
            // Today this holds: `BatchApplyOps` is only ever fed
            // single-device, local-command batches (the remote/merge
            // path applies ops one-at-a-time via `apply_op`). If a
            // future caller mixes devices in one batch, this cursor
            // advancement must be PARTITIONED per `device_id` (track and
            // advance a separate watermark for each device's seq), not
            // collapsed into one `max_seq`. The `debug_assert!` below
            // makes the assumption loud in debug/test builds rather than
            // silently advancing the cursor past another device's ops.
            debug_assert!(
                records
                    .first()
                    .is_none_or(|first| records.iter().all(|r| r.device_id == first.device_id)),
                "BatchApplyOps assumes a single-device batch (op_log seq is per-device); \
                 mixing devices requires per-device cursor partitioning — see #382"
            );
            // FEAT-5h — collect per-op pre-mutation snapshots so we
            // can emit DirtyEvents for every op in the batch after
            // the outer transaction commits.  Emitting during the tx
            // would violate the "notify only on durable state"
            // invariant — a DirtyEvent fired mid-batch and then
            // rolled back would send the connector chasing a ghost.
            //
            // SQL-review M-1: route through `begin_immediate_logged`
            // so sync-burst contention surfaces as upfront serialised
            // wait (with a `warn!` if slow) instead of mid-tx
            // `busy_timeout` stalls under SQLite's default DEFERRED
            // isolation.
            let mut tx =
                crate::db::begin_immediate_logged(pool, "materializer_apply_batch").await?;
            let mut pending_events: Vec<DeferredNotification> = Vec::new();
            // C-2b: track the highest seq across the batch so we can
            // advance the apply cursor exactly once before commit. An
            // empty batch leaves `max_seq` at None so the cursor is not
            // touched (the MAX query is skipped entirely).
            let mut max_seq: Option<i64> = None;
            // Buffer the per-record `ApplyEffects` so the post-commit
            // dispatch fanout has the RestoreBlock descendant cohorts
            // available. Indexed by record position to mirror the
            // `records.iter()` order; an empty effects struct is the
            // default for non-RestoreBlock ops so the post-commit walk
            // just no-ops on those slots.
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
            //
            // #382: `seq` here is the max of a PER-DEVICE counter and the
            // cursor is a single global scalar — correct only under the
            // single-device-batch assumption documented (and
            // `debug_assert!`ed) at the top of this arm. A multi-device
            // batch would need this advancement partitioned per device_id.
            if let Some(seq) = max_seq {
                advance_apply_cursor(&mut tx, seq).await?;
            }
            tx.commit().await?;

            // Post-commit engine-dispatch fan-out for the batch. Runs
            // AFTER `tx.commit` so any record whose sibling rolled the
            // tx back is not visible here (an Err inside the loop above
            // returns early before we reach this point). Each record
            // dispatches its op to the engine and, for Restore/Delete
            // ops, fans out the captured descendant cohort so the
            // engine's per-block-id mutation matches the SQL cascade.
            for (record, effects) in records.iter().zip(per_record_effects.iter()) {
                crate::merge::dispatch_for_record(pool, record).await;
                dispatch_restore_descendants(pool, record, &effects.restored_cohort).await;
                dispatch_delete_descendants(
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
    // SQL-review M-1: route through `begin_immediate_logged` so
    // sync-burst contention surfaces as upfront serialised wait (with
    // a `warn!` if slow) instead of mid-tx `busy_timeout` stalls
    // under SQLite's default DEFERRED isolation.
    let mut tx = crate::db::begin_immediate_logged(pool, "materializer_apply_op").await?;
    let snapshot = snapshot_for_op(&mut tx, record).await?;
    let effects = apply_op_tx(&mut tx, record).await?;
    // C-2b: advance the cursor in the same tx so `apply + cursor` are
    // atomic. A crash between the apply and the commit rolls both back
    // together; the cursor never points ahead of materialised state.
    advance_apply_cursor(&mut tx, record.seq).await?;
    tx.commit().await?;

    // Engine-dispatch hook on the materializer hot path. Dispatched
    // AFTER `tx.commit` so the per-space `LoroEngine` only ever
    // observes durably-applied ops (a rolled-back tx must not leak
    // into Loro's in-process state). `dispatch_for_record` swallows
    // its own errors and never propagates failure back to the
    // materializer.
    //
    // RestoreBlock / DeleteBlock cascade fan-out. The SQL helpers
    // walk the descendant cohort but the Loro engine is per-block-id
    // only; without fan-out a 10-descendant subtree restore would
    // leave 9 blocks with stale `deleted_at` state in Loro. We
    // synthesise per-descendant ops sharing the root record's
    // metadata and apply each to the engine. Space id was captured
    // PRE-UPDATE in `apply_op_tx` because `resolve_block_space`
    // filters `deleted_at IS NULL`; a post-commit lookup would return
    // `None` for every cohort row.
    crate::merge::dispatch_for_record(pool, record).await;
    dispatch_restore_descendants(pool, record, &effects.restored_cohort).await;
    dispatch_delete_descendants(
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

/// Fan out `RestoreBlock` for the full cohort the SQL cascade
/// restored (seed + every descendant). The engine's
/// `apply_restore_block` is per-block-id only, so without this fanout
/// a SQL restore of a 10-descendant subtree would leave 9 blocks
/// marked `deleted_at != Null` in the Loro doc. The materializer owns
/// the fan-out so the engine API stays per-block-id and SQL remains
/// the source of truth for the descendant cohort.
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
async fn dispatch_restore_descendants(
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
        // Loro state not initialised (test environment that bypasses
        // the boot setup). Nothing to do.
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
            deleted_at_ref: root_payload.deleted_at_ref,
        });

        let op_id = format!(
            "{}/{}#cohort/{}",
            root_record.device_id, root_record.seq, cohort_id,
        );
        crate::merge::engine_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            &space_id,
            &root_record.created_at.to_string(),
            state,
        );
    }
}

/// Symmetric companion to [`dispatch_restore_descendants`] for the
/// `DeleteBlock` cascade.
///
/// The SQL `apply_delete_block_tx` walks `descendants_cte_active!()`
/// and stamps `deleted_at` on every active descendant. The Loro
/// engine's `apply_delete_block` is per-block-id only, so without this
/// fanout a 10-descendant subtree delete would leave 9 blocks alive in
/// the engine while SQL reports them deleted. The materializer owns
/// the fan-out so the engine API stays per-block-id and SQL remains
/// the source of truth for the descendant cohort.
///
/// ## Why the cohort INCLUDES the seed
///
/// Same idempotent-seed rationale as `dispatch_restore_descendants`:
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
async fn dispatch_delete_descendants(
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
        // page never received a `space` SetProperty). Nothing to do —
        // there's no canonical engine to mirror onto. The SQL-side
        // delete already stands as the durable outcome.
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
        crate::merge::engine_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            space_id,
            &root_record.created_at.to_string(),
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
    let updated_at = crate::db::now_ms();
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
/// to fan out AFTER the SQL transaction commits. The SQL UPDATE for a
/// `RestoreBlock` walks the descendant CTE and clears `deleted_at` for
/// every block in the matching `deleted_at_ref` cohort, but the per-
/// space `LoroEngine`'s `apply_restore_block` is per-block-id only —
/// without fanning out, a 10-descendant subtree restore would leave 9
/// blocks marked `deleted_at != Null` in the Loro doc.
///
/// The cohort vec INCLUDES the seed `block_id` so the post-commit
/// helper (`dispatch_restore_descendants`) is the canonical path for
/// driving Loro on the whole subtree. The engine's
/// `apply_restore_block` is idempotent so the duplicate seed-apply
/// (the upstream `dispatch_for_record` call also reaches the seed
/// when the parse path is healthy) is harmless. Empty for every op
/// type other than `RestoreBlock`.
///
/// `deleted_cohort` is the symmetric companion for the `DeleteBlock`
/// cascade. Same shape, same rationale: the SQL soft-delete walks N
/// descendants, the engine's `apply_delete_block` is per-block-id
/// only, so without per-descendant fan-out the engine state for the
/// descendants is "alive" while SQL says "deleted". Empty unless the
/// op was `DeleteBlock`. Includes the seed for the same
/// idempotent-seed-apply reason as `restored_cohort`.
///
/// `delete_space_id` is captured alongside `deleted_cohort` because
/// `resolve_block_space` filters `deleted_at IS NULL` — once the SQL
/// UPDATE has stamped the cohort as deleted, a post-commit
/// `resolve_block_space` lookup would return `None` for every row.
/// This is the asymmetry with `restored_cohort`: post-restore-UPDATE
/// the cohort is alive again so `dispatch_restore_descendants`
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
    /// Block ids soft-deleted by a `DeleteBlock` apply — seed AND
    /// every active descendant the SQL CTE walked. Empty unless the op
    /// was `DeleteBlock`. Captured BEFORE the UPDATE so the
    /// `descendants_cte_active!()` filter still matches (post-UPDATE
    /// every cohort row has `deleted_at IS NOT NULL` and the CTE would
    /// skip them all).
    pub deleted_cohort: Vec<String>,
    /// Space id resolved for the `DeleteBlock` seed at PRE-UPDATE
    /// time. `None` for every other op type and for delete ops on
    /// blocks that have no resolvable space (a permitted but rare
    /// state — pre-FEAT-3 data). Required because
    /// `resolve_block_space` filters `deleted_at IS NULL`; a
    /// post-commit resolve attempt would fail on every cohort row.
    pub delete_space_id: Option<crate::space::SpaceId>,
}

// ---------------------------------------------------------------------------
// PEND-56b — `pages_cache.{inbound_link_count,child_block_count}` maintenance
// ---------------------------------------------------------------------------
//
// Migrations 0069/0070 added two materialised aggregate columns to
// `pages_cache` (`inbound_link_count`, `child_block_count`) and backfilled
// them. The materializer is the only thing that mutates caches (AGENTS.md
// invariant), so it must keep the two columns equal to what a live recompute
// over `blocks` + `block_links` would produce.
//
// Strategy: **recompute-on-touch**. For every per-op handler that can
// affect the counts we (a) compute the bounded set of pages whose counts
// may have changed, and (b) UPDATE each row to the value of the canonical
// recompute SELECT in `recompute_pages_cache_counts_for_pages` (below). The
// per-op cost is bounded by the few link targets / outbound edges of a
// single block; total correctness is asserted by the integration parity
// test (see the `pages_cache_count_parity` mod in `materializer/tests.rs`).
//
// The single source of truth for the count SELECT shape is
// `recompute_pages_cache_counts_for_pages`. The migration-0070 backfill and
// the parity test's `canonical_counts` use the same shape; the parity test
// fails the build if the materialised columns ever diverge from a
// from-first-principles recompute.

/// Recompute and persist both `inbound_link_count` and `child_block_count`
/// for every `pages_cache` row whose `page_id` appears in `page_ids`.
///
/// Idempotent: missing `pages_cache` rows (e.g., the target was a content
/// block, or the page was soft-deleted and its cache row already removed)
/// are silently skipped — the `WHERE page_id = ?` filter matches zero
/// rows. Duplicate ids in the slice are deduplicated upfront.
///
/// This recompute SELECT is the **single source of truth** for the two
/// count columns. The migration-0070 backfill
/// (`migrations/0070_pages_cache_inbound_link_count_exclude_same_page.sql`)
/// and the parity test's `canonical_counts` derive the same values; if you
/// change either subquery here, change them there too — the parity test
/// catches drift on every run.
///
/// `child_block_count` is page-wide: every non-deleted block whose
/// `page_id` is this page (excluding the page block itself). The backfill
/// in migration 0069 seeded this column with the same shape.
///
/// `inbound_link_count` is also page-wide (NOT the single-block-scoped
/// backlink count in `backlink/grouped.rs`, which evaluates one block's
/// inbound edges): it counts distinct source blocks that link into the
/// page or any of its descendants while EXCLUDING same-page/self links (a
/// source whose own `page_id` is the target page) and deleted/orphan
/// sources (`src.deleted_at IS NULL`, `src.page_id IS NOT NULL`). The
/// original 0069 backfill omitted those exclusions and over-counted;
/// migration 0070 re-backfills existing rows with this corrected shape,
/// which is what makes `Orphan` / `HasNoInboundLinks` / `MostLinked` /
/// the `↗N` badge agree with the live backlink panel.
async fn recompute_pages_cache_counts_for_pages(
    conn: &mut sqlx::SqliteConnection,
    page_ids: &[String],
) -> Result<(), AppError> {
    if page_ids.is_empty() {
        return Ok(());
    }
    // B-C2 (issue #108): dedupe the touched set and apply both counts
    // in one statement, replacing the per-page loop. The correlated
    // subqueries reference the outer UPDATE's `pages_cache.page_id`
    // (one row at a time), so a multi-row UPDATE is semantically
    // identical to N single-row UPDATEs but does it in one round-trip.
    use std::collections::HashSet;
    let unique: HashSet<&String> = page_ids.iter().collect();
    let unique: Vec<&String> = unique.into_iter().collect();
    let json = serde_json::to_string(&unique)?;
    sqlx::query!(
        "UPDATE pages_cache SET \
             inbound_link_count = ( \
                 SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                     JOIN blocks descendant ON bl.target_id = descendant.id \
                     JOIN blocks src ON src.id = bl.source_id \
                     WHERE descendant.page_id = pages_cache.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND src.deleted_at IS NULL \
                       AND src.page_id IS NOT NULL \
                       AND src.page_id != pages_cache.page_id \
             ), \
             child_block_count = ( \
                 SELECT COUNT(*) FROM blocks descendant \
                     WHERE descendant.page_id = pages_cache.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND descendant.id != pages_cache.page_id \
             ) \
         WHERE page_id IN (SELECT value FROM json_each(?))",
        json,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Read every `page_id` set on the given block ids (NULLs filtered out)
/// and return the unique values. Used to map a set of affected blocks to
/// the set of pages whose counts must be refreshed.
async fn distinct_pages_for_blocks(
    conn: &mut sqlx::SqliteConnection,
    block_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if block_ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(block_ids)?;
    let rows = sqlx::query!(
        "SELECT DISTINCT page_id AS \"page_id!\" FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?)) \
           AND page_id IS NOT NULL",
        json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Parse all `[[ULID]]` / `((ULID))` link tokens from a block's content
/// and return the unique target ids. Mirrors the regex used by
/// `cache::reindex_block_links` so the materialised counts and the
/// `block_links` table see the same edge set.
fn parse_link_targets_from_content(content: &str) -> Vec<String> {
    use std::collections::HashSet;
    let mut out: HashSet<String> = HashSet::new();
    for cap in crate::cache::ULID_LINK_RE.captures_iter(content) {
        out.insert(cap[1].to_string());
    }
    out.into_iter().collect()
}

/// Return the set of pages whose `inbound_link_count` could be affected
/// by `block_id`'s outbound edges currently recorded in `block_links`.
/// Resolved as the distinct `page_id` of every `bl.target_id` where
/// `bl.source_id = block_id`. NULL page ids (e.g., orphan targets) are
/// filtered out.
async fn outbound_target_pages_for_block(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Resolve the set of pages each candidate target block would contribute
/// to as an `inbound_link_count` source if it were linked from a content
/// block. For each `target_id` we read `blocks.page_id`; if the target is
/// itself a page the value equals its own id; if the target is a content
/// block, the value is its owning page; if the row is missing (dangling
/// token) the target is dropped.
async fn target_pages_for_block_ids(
    conn: &mut sqlx::SqliteConnection,
    target_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(target_ids)?;
    let rows = sqlx::query!(
        "SELECT DISTINCT page_id AS \"page_id!\" FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?)) \
           AND page_id IS NOT NULL",
        json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// PEND-56b: maintenance hook called from `apply_op_tx` after each per-op
/// projection commits. Computes the bounded set of pages whose counts may
/// have changed and refreshes them via the canonical SELECT.
///
/// Per-op affected-page set:
///
/// - `CreateBlock`: the new block's owning page (`+= 1` child for non-page
///   creates; `pages_cache` row insert for page creates) + every page
///   targeted by `[[ULID]]`/`((ULID))` tokens in the new content.
/// - `EditBlock`: the edited block's owning page + every page targeted by
///   the OLD `block_links` rows (will lose an edge if the token is gone) +
///   every page parsed out of the NEW content (will gain an edge once
///   `ReindexBlockLinks` runs in the background).
/// - `DeleteBlock` (cohort-aware): every page the cohort blocks lived on
///   (lose a child) + every page each cohort block's outbound edges
///   pointed to (lose an inbound) + every page that was inbound-linked
///   FROM the cohort (their outbound counts unchanged but inbound was
///   the descendants which are now deleted).
/// - `RestoreBlock`: symmetric to delete — same affected set.
/// - `PurgeBlock`: same as delete, plus the cohort's source-pages of
///   inbound edges that get cleared by FK CASCADE on `block_links`.
///
/// NOTE on `EditBlock` / `CreateBlock` with link tokens: the new
/// `block_links` rows are written by the background `ReindexBlockLinks`
/// task. The recompute here will pick up edge REMOVALS (the SELECT
/// re-runs against current `block_links` which still has the removed
/// edge briefly — wait, no, block_links isn't updated until ReindexBlockLinks
/// runs in the background, so the OLD edges are still present here).
/// The per-op recompute captures count changes driven by `blocks` mutations
/// (deletions, restorations); link-token additions / removals are picked
/// up by the matching pass in the `ReindexBlockLinks` handler below.
async fn maintain_pages_cache_counts_after_op(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
    pre_state: &PreOpState,
) -> Result<(), AppError> {
    use std::collections::HashSet;
    use std::str::FromStr;

    // Unknown op types are surfaced as errors upstream; here we just
    // skip count maintenance. (`apply_op_tx` already errored.)
    let Ok(op_type) = OpType::from_str(&record.op_type) else {
        return Ok(());
    };

    let mut affected: HashSet<String> = HashSet::new();

    match op_type {
        OpType::CreateBlock => {
            // The new block exists in `blocks` post-projection. Resolve
            // its owning page from the parent chain.
            //
            // For page creates the projection writes (id, block_type=page,
            // content, parent_id=None). The block's `page_id` is set by
            // the background `RebuildPageIds` task to its own id. To make
            // the count visible immediately, we INSERT a `pages_cache`
            // row here so the recompute UPDATE below has a target row.
            if let Some(block_id) = &pre_state.create_block_id {
                let parent_id = &pre_state.create_parent_id;
                // Determine the owning page.
                let owning_page = resolve_owning_page(conn, block_id, parent_id.as_deref()).await?;
                if pre_state.create_block_type.as_deref() == Some("page") {
                    // INSERT the pages_cache row if missing so the
                    // `UPDATE` below sees a target. Title = content
                    // (matches `rebuild_pages_cache`'s desired-state SQL).
                    let title = pre_state.create_content.as_deref().unwrap_or("");
                    let now = crate::db::now_ms();
                    sqlx::query!(
                        "INSERT OR IGNORE INTO pages_cache \
                             (page_id, title, updated_at, inbound_link_count, child_block_count) \
                         VALUES (?, ?, ?, 0, 0)",
                        block_id,
                        title,
                        now,
                    )
                    .execute(&mut *conn)
                    .await?;
                    affected.insert(block_id.clone());
                }
                if let Some(p) = owning_page {
                    affected.insert(p);
                }
                // Parse [[ULID]]/((ULID)) tokens from the new content
                // and add the inferred target pages.
                if let Some(content) = &pre_state.create_content {
                    let tokens = parse_link_targets_from_content(content);
                    if !tokens.is_empty() {
                        for p in target_pages_for_block_ids(conn, &tokens).await? {
                            affected.insert(p);
                        }
                    }
                }
            }
        }
        OpType::EditBlock => {
            if let Some(block_id) = &pre_state.edit_block_id {
                // Owning page of the edited block.
                let row = sqlx::query!("SELECT page_id FROM blocks WHERE id = ?", block_id)
                    .fetch_optional(&mut *conn)
                    .await?;
                if let Some(Some(p)) = row.map(|r| r.page_id) {
                    affected.insert(p);
                }
                // Pages reachable via OLD outbound edges (still in
                // `block_links` until `ReindexBlockLinks` runs in BG).
                for p in outbound_target_pages_for_block(conn, block_id).await? {
                    affected.insert(p);
                }
                // Pages parsed from the NEW content — caught via target's
                // page_id. The block_links row may not be written yet but
                // the SELECT joins against `block_links` so newly-arrived
                // edges aren't reflected until `ReindexBlockLinks` runs.
                // Capture the candidate pages so the matching pass in the
                // `ReindexBlockLinks` arm can refresh them. We add them
                // here too so the `pages_cache.inbound_link_count` is
                // monotonic — never temporarily higher than the live
                // SELECT would produce.
                if let Some(new_content) = &pre_state.edit_to_text {
                    let tokens = parse_link_targets_from_content(new_content);
                    if !tokens.is_empty() {
                        for p in target_pages_for_block_ids(conn, &tokens).await? {
                            affected.insert(p);
                        }
                    }
                }
            }
        }
        OpType::DeleteBlock | OpType::RestoreBlock => {
            // The cohort is captured upstream in `apply_op_tx` (see
            // `collect_delete_cohort` / `collect_restore_cohort`). We
            // mirror the same set here via `pre_state.cohort`.
            for p in distinct_pages_for_blocks(conn, &pre_state.cohort).await? {
                affected.insert(p);
            }
            // Pages targeted by outbound edges from any cohort block.
            // For DeleteBlock those edges still exist in `block_links`
            // (CASCADE FK fires on row DELETE, not on `deleted_at` stamp);
            // for RestoreBlock the edges remain throughout, so the union
            // of `outbound_target_pages_for_block` over the cohort is
            // identical pre- and post-projection.
            for block_id in &pre_state.cohort {
                for p in outbound_target_pages_for_block(conn, block_id).await? {
                    affected.insert(p);
                }
            }
            // Inbound: blocks whose links pointed INTO the cohort. Their
            // page_id's `inbound_link_count` doesn't change because the
            // inbound count is keyed on the TARGET page (the cohort's
            // page), not the source. So nothing to add here beyond what
            // we already collected via `distinct_pages_for_blocks`.
            //
            // Edge case: the cohort may include a page block. That page
            // contributed to its own descendants' inbound count via
            // `descendant.page_id = page_id`. After soft-delete, the
            // page's own `pages_cache` row is still present (it's
            // removed by the later `RebuildPagesCache` rebuild); the
            // recompute UPDATE will set its inbound_link_count to 0
            // (all descendants are now deleted_at IS NOT NULL).
        }
        OpType::PurgeBlock => {
            // PurgeBlock removes the cohort's `blocks` rows entirely; FK
            // CASCADE on `block_links` (mig 0061) clears outbound and
            // inbound edges. We captured the affected pages BEFORE the
            // cascade ran (see `pre_state`).
            for p in &pre_state.pre_purge_affected_pages {
                affected.insert(p.clone());
            }
        }
        OpType::MoveBlock => {
            // E4: a MoveBlock CAN alter `page_id`. `commands/blocks/move_ops.rs`
            // recomputes `page_id` for the moved block + its descendants on a
            // cross-page reparent, so the source page loses children and the
            // destination page gains them. The earlier "MoveBlock never alters
            // page_id" assumption was false and left both pages'
            // `child_block_count` stale until an unrelated op touched each one.
            //
            // The materializer's own MoveBlock projection
            // (`apply_move_block_via_loro` → `project_move_block_to_sql`) only
            // writes `parent_id`/`position`; it defers the `page_id` recompute
            // to the background `RebuildPageIds` task. The page-wide count
            // recompute below keys on `blocks.page_id`, so we mirror
            // `move_ops.rs` and update the moved subtree's `page_id` HERE
            // (bounded, depth-capped) before recomputing — that keeps the
            // in-tx recompute correct without waiting for `RebuildPageIds`,
            // and is idempotent with it.
            if let Some(block_id) = &pre_state.move_block_id {
                let dest_page = reparent_moved_subtree_page_id(conn, block_id).await?;
                if let Some(src) = &pre_state.move_src_page {
                    affected.insert(src.clone());
                }
                if let Some(dest) = dest_page {
                    affected.insert(dest);
                }
            }
        }
        // No-ops for count maintenance: tag / property / attachment ops
        // never affect either count (they don't change the
        // `blocks.page_id`/`deleted_at` membership of any page).
        OpType::AddTag
        | OpType::RemoveTag
        | OpType::SetProperty
        | OpType::DeleteProperty
        | OpType::AddAttachment
        | OpType::DeleteAttachment => {}
    }

    if affected.is_empty() {
        return Ok(());
    }
    let v: Vec<String> = affected.into_iter().collect();
    recompute_pages_cache_counts_for_pages(conn, &v).await?;
    Ok(())
}

/// E4: recompute `blocks.page_id` for a just-moved block and its
/// descendants, mirroring `commands/blocks/move_ops.rs`, and return the
/// block's new owning page id (the destination page) for count-refresh.
///
/// The materializer's MoveBlock projection only writes
/// `parent_id`/`position`; the canonical full `page_id` rebuild is the
/// background `RebuildPageIds` task. But the page-wide count recompute in
/// `maintain_pages_cache_counts_after_op` keys on `blocks.page_id`, so we
/// reproduce the bounded subtree update here (depth-capped per invariant
/// #9) so the in-tx recompute reflects the new page membership without
/// waiting for `RebuildPageIds`. Running both is idempotent — they
/// converge on the same `page_id` for the subtree.
///
/// Returns the moved block's destination page (its own id when the moved
/// block is itself a page; the parent's owning page otherwise; `None`
/// when the block was moved to the top level / has no page ancestor).
async fn reparent_moved_subtree_page_id(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<String>, AppError> {
    // The block's current parent_id reflects the post-projection move.
    let row = sqlx::query!(
        "SELECT block_type, parent_id FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some((block_type, parent_id)) = row.map(|r| (r.block_type, r.parent_id)) else {
        // Block vanished (e.g. concurrent purge); nothing to recompute.
        return Ok(None);
    };

    // Destination page derived from the NEW parent: a page parent owns
    // itself; any other parent contributes its own `page_id`. No parent
    // → top-level → no owning page (page_id NULL). Mirrors `move_ops.rs`.
    let new_page_id: Option<String> = if let Some(pid) = &parent_id {
        sqlx::query_scalar!(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END \
             AS \"v?\" FROM blocks WHERE id = ?",
            pid,
        )
        .fetch_optional(&mut *conn)
        .await?
        .flatten()
    } else {
        None
    };

    let is_page = block_type == "page";
    // Pages always own themselves regardless of parent; content/other
    // blocks inherit the destination page id.
    let effective_page_id = if is_page {
        Some(block_id.to_owned())
    } else {
        new_page_id.clone()
    };

    // Update the moved block itself (pages keep page_id = self).
    if !is_page {
        let new_page_id_ref = new_page_id.as_deref();
        sqlx::query!(
            "UPDATE blocks SET page_id = ? WHERE id = ?",
            new_page_id_ref,
            block_id,
        )
        .execute(&mut *conn)
        .await?;
    }

    // Update all non-page descendants to inherit the moved block's page
    // id. Recursive CTE bounds `depth < 100` (invariant #9) and filters
    // `deleted_at IS NULL` in both members so soft-deleted conflict
    // copies don't leak into the walk. Mirrors `move_ops.rs`.
    let effective_page_id_ref = effective_page_id.as_deref();
    sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ?2 \
         WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
        block_id,
        effective_page_id_ref,
    )
    .execute(&mut *conn)
    .await?;

    Ok(effective_page_id)
}

/// Walk `blocks.parent_id` from `block_id` and return the page-typed
/// ancestor's id, or `None` if no ancestor of `block_type = 'page'`
/// exists. For the seed block itself the function returns `block_id`
/// when its `block_type = 'page'`. Matches the shape of the recursive
/// CTE in `cache::page_id::rebuild_page_ids_impl` (single-block scope,
/// depth-bounded).
async fn resolve_owning_page(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    parent_hint: Option<&str>,
) -> Result<Option<String>, AppError> {
    // B-I1 (issue #108): collapse the per-row ancestor walk into the
    // canonical `ancestors_cte_standard!()` CTE — one round-trip
    // (or two, with the `parent_hint` fallback) instead of one per
    // depth-step. Depth-cap 100 (invariant #9) is preserved by the
    // macro's recursive guard. The `JOIN blocks` + `ORDER BY depth ASC
    // LIMIT 1` selects the nearest page-typed ancestor; for a seed that
    // is itself a page the depth-0 row wins.
    if let Some(page_id) = nearest_page_ancestor(conn, block_id).await? {
        return Ok(Some(page_id));
    }
    // Seed row may not exist yet (the createBlock path can call this
    // before projection has inserted the row in some legacy call sites);
    // fall back to `parent_hint` if provided.
    if let Some(hint) = parent_hint {
        return nearest_page_ancestor(conn, hint).await;
    }
    Ok(None)
}

/// Issue #108 (B-I1) helper: walk ancestors of `seed` via the canonical
/// recursive CTE and return the id of the nearest `block_type = 'page'`
/// ancestor (or the seed itself if it is a page). `None` when the seed
/// row doesn't exist or no page-typed ancestor is reachable within the
/// invariant-#9 depth-100 bound.
async fn nearest_page_ancestor(
    conn: &mut sqlx::SqliteConnection,
    seed: &str,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(concat!(
        crate::ancestors_cte_standard!(),
        "SELECT a.id FROM ancestors a \
         JOIN blocks b ON b.id = a.id \
         WHERE b.block_type = 'page' \
         ORDER BY a.depth ASC \
         LIMIT 1",
    ))
    .bind(seed)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Capture the set of pages this block was linking to BEFORE the
/// pending `reindex_block_links` diff runs. Returned to the caller so
/// it can union the pre- and post-diff target page sets when refreshing
/// `pages_cache.inbound_link_count` — covers both edges that just
/// disappeared (no longer in `block_links` post-diff, only in pre-set)
/// and edges that stayed (in both).
async fn pre_diff_target_pages(
    pool: &sqlx::SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Refresh `pages_cache.inbound_link_count` for every page reachable
/// via this block's outbound edges (pre-diff PLUS post-diff) and every
/// target page currently in `page_link_cache` from this block's source
/// page.
///
/// Called from the `MaterializeTask::ReindexBlockLinks` arm AFTER
/// `cache::reindex_block_links` + `cache::reindex_page_link_cache_for_block`
/// have written the canonical post-diff state. The set of affected
/// target pages is the union of:
///
/// 1. `pre` — page ids captured BEFORE the diff ran (catches edges
///    that just disappeared; the post-diff `block_links` no longer
///    references them, so we'd miss the decrement otherwise).
/// 2. Distinct `page_id` of each block currently in `block_links`
///    under `source_id = block_id` (catches edges that just appeared
///    or stayed put — new inbound counts to refresh).
/// 3. Distinct `target_page_id` in `page_link_cache` where
///    `source_page_id = blocks.parent_id` (or `block_id` if the block
///    itself is a page) — covers the page-link-cache's view of the
///    block's outbound page edges.
///
/// Bounded by the block's outbound edge cardinality (a few targets
/// per block in practice). Each iteration runs a single UPDATE with
/// two SELECT subqueries; the SELECTs are index-served by
/// `idx_block_links_target_source` + `idx_blocks_page_id`.
async fn refresh_inbound_counts_after_reindex(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    pre: &[String],
) -> Result<(), AppError> {
    use std::collections::HashSet;
    // SQL-review M-1: write txs must use `begin_immediate_logged` so
    // sync-burst contention serialises upfront with a `warn!` log
    // instead of stalling mid-tx under SQLite's default DEFERRED
    // isolation. Mirrors the convention in `apply_op` / `apply_op` batch.
    let mut tx =
        crate::db::begin_immediate_logged(pool, "materializer_pages_cache_inbound_refresh").await?;
    let mut affected: HashSet<String> = HashSet::new();
    for p in pre {
        affected.insert(p.clone());
    }

    // (2) Current outbound targets' page ids.
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in rows {
        affected.insert(r.page_id);
    }

    // (3) Resolve the source page (the page this block rolls up to in
    // `page_link_cache` — `COALESCE(parent_id, block_id)` to mirror
    // `cache::reindex_page_link_cache_for_block`).
    let parent_row = sqlx::query!("SELECT parent_id FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut *tx)
        .await?;
    let source_page: String = match parent_row.map(|r| r.parent_id) {
        Some(Some(parent)) => parent,
        _ => block_id.to_owned(),
    };

    // Add every target_page_id currently in page_link_cache from this
    // source so we catch any remaining cached edges that point out.
    let cached = sqlx::query!(
        "SELECT target_page_id FROM page_link_cache WHERE source_page_id = ?",
        source_page,
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in cached {
        affected.insert(r.target_page_id);
    }

    if affected.is_empty() {
        return Ok(());
    }
    let v: Vec<String> = affected.into_iter().collect();
    recompute_pages_cache_counts_for_pages(&mut tx, &v).await?;
    tx.commit().await?;
    Ok(())
}

/// Per-op state captured BEFORE projection mutates `blocks` so the
/// post-projection recompute knows exactly which page rows to refresh.
/// Field semantics are op-specific; unrelated fields stay at default.
#[derive(Default)]
struct PreOpState {
    // CreateBlock fields.
    create_block_id: Option<String>,
    create_parent_id: Option<String>,
    create_block_type: Option<String>,
    create_content: Option<String>,
    // EditBlock fields.
    edit_block_id: Option<String>,
    edit_to_text: Option<String>,
    // DeleteBlock / RestoreBlock cohort (mirrors `ApplyEffects`).
    cohort: Vec<String>,
    // PurgeBlock affected-pages snapshot (captured pre-cascade because
    // FK CASCADE on `block_links` clears outbound/inbound edges before
    // the post-op recompute runs).
    pre_purge_affected_pages: Vec<String>,
    // MoveBlock fields (E4). Captured BEFORE the projection reparents
    // the block so the count hook can refresh BOTH the source page (the
    // block's `page_id` at move time) and the destination page (derived
    // post-move from the new parent chain). A cross-page reparent
    // recomputes `page_id` for the moved subtree in `move_ops.rs`, so
    // the two pages' `child_block_count` would otherwise drift.
    move_block_id: Option<String>,
    move_src_page: Option<String>,
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
    let mut pre_state = PreOpState::default();
    match op_type {
        OpType::CreateBlock => {
            // The engine path is the only path; the SQL-only
            // `apply_*_sql_only` helpers remain as fallbacks for
            // test-scaffolding cases (uninitialised Loro state,
            // unresolved space) inside the `via_loro` helpers
            // themselves.
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture payload fields for the post-projection
            // pages_cache count refresh (`maintain_pages_cache_counts_after_op`).
            pre_state.create_block_id = Some(p.block_id.as_str().to_owned());
            pre_state.create_parent_id = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
            pre_state.create_block_type = Some(p.block_type.clone());
            pre_state.create_content = Some(p.content.clone());
            apply_create_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture the new text so the post-projection
            // recompute knows which target pages to refresh.
            pre_state.edit_block_id = Some(p.block_id.as_str().to_owned());
            pre_state.edit_to_text = Some(p.to_text.clone());
            apply_edit_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture the descendant cohort BEFORE the UPDATE. The SQL
            // cascade uses `descendants_cte_active!()` which filters
            // `deleted_at IS NULL`, so once the UPDATE stamps the
            // cohort as deleted the CTE no longer matches them. We
            // mirror the same CTE here so the captured set is exactly
            // the rows the UPDATE will touch. The cohort INCLUDES the
            // seed (mirrors `restored_cohort`'s shape).
            //
            // The space resolve runs at the same pre-UPDATE moment so
            // the post-commit fanout has a known-good space id to
            // pass to `engine_apply` (post-UPDATE every cohort row has
            // `deleted_at IS NOT NULL`, so a fresh `resolve_block_space`
            // call would return `None` — see `ApplyEffects` doc).
            let cohort = collect_delete_cohort(conn, &p).await?;
            let delete_space_id =
                crate::space::resolve_block_space(&mut *conn, &p.block_id).await?;
            // PEND-56b: feed the cohort into the count-refresh hook.
            pre_state.cohort = cohort.clone();
            apply_delete_block_via_loro(conn, &record.device_id, &p, record.created_at).await?;
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
            // Keep the seed in the cohort: the post-commit fanout
            // (`dispatch_restore_descendants`) is the canonical path
            // that drives Loro for the entire cohort. Including the
            // seed makes the helper self-contained and avoids
            // depending on the upstream `dispatch_for_record` call
            // also reaching the engine — the duplicate apply on the
            // seed is idempotent (engine's `apply_restore_block` is a
            // no-op on an already-restored block).
            let cohort = collect_restore_cohort(conn, &p).await?;
            // PEND-56b: cohort feeds the count refresh.
            pre_state.cohort = cohort.clone();
            apply_restore_block_via_loro(conn, &record.device_id, &p).await?;
            effects.restored_cohort = cohort;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture the affected pages BEFORE the SQL
            // cascade clears `block_links` (FK CASCADE on mig 0061).
            // The cascade walks the descendant CTE so we mirror that
            // shape to collect the set we need to refresh.
            pre_state.pre_purge_affected_pages =
                collect_purge_affected_pages(conn, p.block_id.as_str()).await?;
            apply_purge_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            // E4: capture the moved block's owning page BEFORE the
            // projection reparents it. A cross-page reparent recomputes
            // `page_id` for the moved subtree, so the source page loses
            // descendants and the destination page gains them — both
            // `child_block_count`s must be refreshed post-projection.
            pre_state.move_block_id = Some(p.block_id.as_str().to_owned());
            let move_block_id_str = p.block_id.as_str();
            pre_state.move_src_page =
                sqlx::query_scalar!("SELECT page_id FROM blocks WHERE id = ?", move_block_id_str)
                    .fetch_optional(&mut *conn)
                    .await?
                    .flatten();
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
            // through Loro.
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_add_attachment_tx(conn, p, record.created_at).await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_delete_attachment_tx(conn, p).await?;
        }
    }
    // PEND-56b: maintain `pages_cache.{inbound_link_count,child_block_count}`.
    // Runs after every per-op projection inside the same transaction, so
    // the count UPDATEs commit atomically with the block mutations. The
    // hook is a no-op for op types that cannot affect the counts (see
    // `maintain_pages_cache_counts_after_op`).
    maintain_pages_cache_counts_after_op(conn, record, &pre_state).await?;
    tracing::debug!(op_type = %record.op_type, seq = record.seq, "applied op to materialized tables");
    Ok(effects)
}

/// Capture the set of pages whose `pages_cache` counts may be affected
/// by a `PurgeBlock` cascade. The cascade walks the descendant CTE and
/// removes `blocks` + cascading edges from `block_links`. We need to
/// refresh every page that:
///   1. owns one of the cohort blocks (its `child_block_count` drops),
///   2. is targeted by an outbound edge from a cohort block (its
///      `inbound_link_count` drops by 1 per distinct source).
///
/// Plus the cohort's own page ids if any cohort block is a page (their
/// `pages_cache` row is itself dropped by the cascade — the UPDATE filter
/// matches zero rows so it's a no-op, which is the desired outcome).
async fn collect_purge_affected_pages(
    conn: &mut sqlx::SqliteConnection,
    seed_block_id: &str,
) -> Result<Vec<String>, AppError> {
    use std::collections::HashSet;
    // Walk the descendant CTE (PurgeBlock's `purge_block_sql_cascade`
    // uses the same shape) to find the cohort. Then read each block's
    // page_id + outbound target page_ids.
    let cohort = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         SELECT id AS \"id!\" FROM descendants",
        seed_block_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    let cohort_ids: Vec<String> = cohort.into_iter().map(|r| r.id).collect();
    let mut affected: HashSet<String> = HashSet::new();
    for p in distinct_pages_for_blocks(conn, &cohort_ids).await? {
        affected.insert(p);
    }
    for id in &cohort_ids {
        for p in outbound_target_pages_for_block(conn, id).await? {
            affected.insert(p);
        }
    }
    Ok(affected.into_iter().collect())
}

/// Capture the descendant cohort that `apply_restore_block_tx` is
/// about to clear. Mirrors the CTE + `deleted_at = ?` filter used by
/// the UPDATE so the captured set is exactly the rows that will be
/// restored. Run inside the same tx, before the UPDATE, so the
/// snapshot reflects the soft-deleted state.
///
/// The list ALWAYS includes the seed `block_id` if it matches the
/// filter; the caller is responsible for excluding the seed when
/// constructing the per-descendant fan-out (the seed's engine
/// dispatch already happens once for the root op record).
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
    .bind(p.deleted_at_ref)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Capture the descendant cohort that `apply_delete_block_tx` is
/// about to soft-delete. Mirrors the CTE + `deleted_at IS NULL`
/// filter used by the UPDATE so the captured set is exactly the rows
/// that will be touched.
///
/// MUST run BEFORE the UPDATE: `descendants_cte_active!()` filters
/// `deleted_at IS NULL` in the recursive step, so once the UPDATE has
/// stamped the cohort as deleted the CTE no longer matches them and a
/// post-UPDATE call would return an empty list (or worse, the seed only
/// — depending on the recursion order).
///
/// The list ALWAYS includes the seed `block_id` if it's currently
/// active; the seed is the CTE's anchor row and is yielded at depth 0.
/// `dispatch_delete_descendants` re-applies the seed alongside
/// the descendants (idempotent — `apply_delete_block` is a no-op on an
/// already-deleted block) so the helper is the canonical cohort-delete
/// path regardless of whether the upstream `dispatch_for_record`
/// reaches the engine for any specific op record.
///
/// The captured cohort feeds the post-commit
/// `dispatch_delete_descendants` fanout; the SELECT itself is
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

/// Apply CreateBlock through the engine then project to SQL.
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
/// `apply_op_tx` work (cursor advance, etc.). The engine's apply is
/// NOT rolled back automatically.
///
/// ## Space resolution
///
/// For a `CreateBlock`, the `parent_id` is the resolution anchor when
/// present (content blocks descend from a page); otherwise the
/// block's own id is used (page-create with no parent).
///
/// ## Fallback modes
///
/// The engine path falls back to a SQL-only path
/// (`apply_*_sql_only` below) when:
/// - Loro state isn't initialised (test scaffolding without
///   `install_for_test`).
/// - Space cannot be resolved (orphan block, no `space` ancestor,
///   pre-FEAT-3 row, fresh page-create with no SetProperty(space)
///   yet).
///
/// In production both arms are unreachable — `init` runs at boot and
/// space resolution succeeds on every well-formed op. The SQL-only
/// fallback exists so that materializer / recovery / sync_daemon
/// tests can thread synthetic bare-block ops through `apply_op`
/// without a registered space.
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
    let (snapshot, siblings): (BlockSnapshot, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_create_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        // #400 routing: new ops carry a 0-based `index`; pre-#400 ops carry the
        // legacy sparse `position` (mapped to a slot by the engine); neither ⇒
        // append at the end.
        match p.index {
            Some(index) => engine.apply_create_block_at(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_create_block(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                p.position.unwrap_or(i64::MAX), // None ⇒ sort last (append)
            )?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        // Authoritative sibling order for the dense-rank reprojection.
        let siblings = engine.children_ordered_block_ids(parent)?;
        drop(guard);
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_create_block_via_loro: engine read_block returned None \
                 immediately after apply_create_block for {}",
                p.block_id.as_str()
            ))
        })?;
        (snap, siblings)
    };

    // Project the engine's post-apply state into SQL, then reproject the whole
    // sibling group to dense 1-based positions matching the tree order (#400).
    projection::project_create_block_to_sql(conn, &snapshot).await?;
    projection::reproject_dense_positions(conn, &siblings).await?;

    // Tag inheritance — derived tag rows for the new block.
    let parent_str = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// Apply EditBlock through the engine then project to SQL.
///
/// Same shape as [`apply_create_block_via_loro`]: resolve space, take
/// the engine guard inside a sync scope, apply
/// `apply_edit_via_diff_splice`, read the post-apply snapshot, drop
/// the guard, project. Edit ops carry no `parent_id`, so the
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

/// Apply SetProperty through the engine then project to SQL.
///
/// Same shape as the per-block helpers: resolve space via the block's
/// id, take the engine guard, apply, drop, project. The engine apply
/// flattens all property values to a single string; the SQL projection
/// reads the typed-shape fields straight off the payload (the engine's
/// post-apply state for the typed fields equals the payload's fields
/// by construction, so this is correct — see the projection helper's
/// docstring). An unresolvable space falls back to the SQL-only
/// path.
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
        // PEND-80 §2.1: store the value with its native type so the engine is
        // type-lossless (`value_num`→`Num`, `value_bool`→`Bool`); text/date/ref
        // are all strings, disambiguated at the SQL projection by
        // `property_definitions.value_type`. No typed field set ⇒ explicit
        // clear (`Null`). The typed SQL columns are still written from the
        // payload directly by `project_set_property_to_sql` below.
        use crate::loro::engine::PropertyValue;
        let value = if let Some(v) = &p.value_text {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = p.value_num {
            PropertyValue::Num(v)
        } else if let Some(v) = &p.value_date {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = &p.value_ref {
            PropertyValue::Str(v.clone())
        } else if let Some(b) = p.value_bool {
            PropertyValue::Bool(b)
        } else {
            PropertyValue::Null
        };
        engine.apply_set_property_typed(p.block_id.as_str(), &p.key, &value)?;
        drop(guard);
    }

    projection::project_set_property_to_sql(conn, p).await?;
    Ok(())
}

/// Apply DeleteBlock through the engine then project to SQL.
///
/// Engine `apply_delete_block` now stores the real `record.created_at`
/// timestamp on the seed (PEND-80 Phase 2) — the same value the SQL
/// projection stamps — so cohort identity for restore lookups is
/// consistent between the engine and SQL, and lossless across sync.
/// The cascade (descendant fanout) is handled on the SQL side via the
/// projection's CTE-driven UPDATE; the engine only sees the seed
/// block's apply, with the post-commit
/// `dispatch_delete_descendants` fanning out the cohort to the
/// engine. An unresolvable space falls back to the SQL-only path.
async fn apply_delete_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeleteBlockPayload,
    now: i64,
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
        // #109 Phase 2: the engine seed carries `deleted_at` as a String
        // slot (bridged to i64 at the SQL boundary); stringify here.
        engine.apply_delete_block(p.block_id.as_str(), &now.to_string())?;
        drop(guard);
    }

    projection::project_delete_block_to_sql(conn, p.block_id.as_str(), now).await?;
    // Sweep inherited tag rows for the deleted subtree.
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply MoveBlock through the engine then project to SQL.
///
/// Engine `apply_move_block` writes parent_id + position via per-key
/// LWW; we read back the engine's post-apply snapshot and project
/// both fields into SQL. No sibling-shift on either side (see
/// projection helper's docstring for the rationale).
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

    // `(snapshot, old_parent_siblings, new_parent_siblings)`. A move can change
    // parent, so both the source and the target sibling groups need a dense
    // reprojection (#400). The resulting parent may differ from the requested
    // one (a cyclic/unknown-parent move keeps the current parent), so the
    // authoritative new parent is the post-apply snapshot's `parent_id`.
    let (snapshot, old_siblings, new_siblings): (BlockSnapshot, Vec<String>, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_move_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let new_parent = p.new_parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        let old_parent = engine.read_parent(p.block_id.as_str())?;
        // #400 routing: new ops carry a 0-based `new_index`; pre-#400 ops carry
        // the legacy sparse `new_position` (mapped to a slot by the engine).
        match p.new_index {
            Some(index) => engine.apply_move_block_to(
                p.block_id.as_str(),
                new_parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_move_block(p.block_id.as_str(), new_parent, p.new_position)?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_move_block_via_loro: engine read_block returned None for {} \
                 (a MoveBlock op presupposes the block exists)",
                p.block_id.as_str()
            ))
        })?;
        let old_siblings = engine.children_ordered_block_ids(old_parent.as_deref())?;
        // Same-parent reorder (the common DnD / moveUp / moveDown case): source
        // and target groups are identical, so reproject once. Only fetch the
        // second group when the parent actually changed (#400, review perf).
        let new_siblings = if old_parent.as_deref() == snap.parent_id.as_deref() {
            Vec::new()
        } else {
            engine.children_ordered_block_ids(snap.parent_id.as_deref())?
        };
        drop(guard);
        (snap, old_siblings, new_siblings)
    };

    projection::project_move_block_to_sql(conn, &snapshot).await?;
    // Reproject the source group (it shrank, or — for a same-parent move — it is
    // the single affected group). `new_siblings` is empty on a same-parent move.
    projection::reproject_dense_positions(conn, &old_siblings).await?;
    if !new_siblings.is_empty() {
        projection::reproject_dense_positions(conn, &new_siblings).await?;
    }
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply RestoreBlock through the engine then project to SQL.
///
/// Engine apply for the SEED only + SQL projection that walks the
/// cohort via the descendants CTE. The per-descendant engine fan-out
/// lives in the post-commit helper `dispatch_restore_descendants`
/// (the engine apply is idempotent, so re-running it is safe).
///
/// **Why the engine sees only the seed.** The engine's
/// `apply_restore_block` is per-block-id; walking descendants would
/// duplicate work that `dispatch_restore_descendants` already does
/// post-commit. The split keeps the engine API simple (1 block in, 1
/// mutation out) and keeps cohort semantics on the SQL side. If a
/// crash drops the fanout, the next op-log replay rebuilds the engine
/// from scratch.
///
/// **Space resolution on a soft-deleted block.** `resolve_block_space`
/// filters `deleted_at IS NULL` (AGENTS.md invariant #9 — tombstones
/// must not participate in space resolution). But a `RestoreBlock` op
/// TARGETS a tombstoned block by definition, so the canonical resolver
/// returns `None`. We work around this by reading `parent_id` directly
/// from `blocks` (no `deleted_at` filter) and resolving the parent's
/// space — correct because the parent is in the same space as the
/// soft-deleted child by the per-space-tree invariant. When the block
/// has no parent (orphan / page-level restore), the path falls back to
/// the SQL-only restore.
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
    let parent_row = sqlx::query!("SELECT parent_id FROM blocks WHERE id = ?", block_id_str)
        .fetch_optional(&mut *conn)
        .await?;
    let resolution_anchor: BlockId = match parent_row.and_then(|r| r.parent_id) {
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

    projection::project_restore_block_to_sql(conn, p.block_id.as_str(), p.deleted_at_ref).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply PurgeBlock through the engine then run the SQL cascade.
///
/// Engine apply is per-block-id (deletes the seed's `blocks`,
/// `block_properties`, `block_tags` entries from the LoroDoc). The
/// SQL side then runs the full cascade inline — the cascade is much
/// wider than the engine state (purges agenda_cache, tags_cache,
/// fts_blocks, etc. that the engine doesn't model) so it stays in
/// this helper rather than getting absorbed into a projection. The
/// engine descendant state is reconciled via op-log replay; per-
/// descendant engine purges may be added later if needed. The SQL
/// cascade is the source of truth users observe. SQL-only fallback
/// shape mirrors the other helpers; in production both arms are
/// unreachable.
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

/// SQL-side purge cascade.
///
/// PURGE walks many tables — much broader than the engine's three
/// (`blocks`, `block_properties`, `block_tags`) — so it stays SQL-side
/// rather than being absorbed into a projection. Every row that
/// descends from the purged block must go. `depth < 100` is the
/// runaway-recursion guard.
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
    // block_properties: value_ref pointing into the subtree — DELETE the
    // property row rather than NULLing the ref. Under migration 0062's
    // exactly_one_value CHECK a `value_ref`-typed property has no other
    // typed value to fall back on, so a SET-NULL produces an invariant-
    // violating all-NULL row. Mirrors the equivalent crud.rs change
    // (see crud.rs:~1249 / 1613 / 2063 and migration 0062's header).
    sqlx::query(
        "DELETE FROM block_properties \
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

/// Apply AddTag through the engine then project to SQL.
///
/// Engine apply pushes the tag id onto the block's `block_tags` list
/// (idempotent — engine de-dupes). SQL projection writes the
/// `block_tags` row via `INSERT OR IGNORE`. Tag inheritance fanout
/// runs AFTER the projection. An unresolvable space falls back to the
/// SQL-only path.
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

/// Apply RemoveTag through the engine then project to SQL.
///
/// Engine apply removes the tag id from the block's `block_tags` list
/// (idempotent — engine no-ops on missing tag). SQL projection
/// deletes the `block_tags` row. Tag inheritance cleanup runs AFTER
/// the projection. An unresolvable space falls back to the SQL-only
/// path.
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

/// Apply DeleteProperty through the engine then project to SQL.
///
/// Engine apply removes the key from the block's properties map
/// (idempotent — engine no-ops on missing key). SQL projection runs
/// the per-key match (reserved key → UPDATE column to NULL;
/// non-reserved key → DELETE block_properties row). No
/// tag-inheritance fanout — properties don't propagate. An
/// unresolvable space falls back to the SQL-only path.
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
// SQL-only fallback helpers.
//
// Used by the `apply_*_via_loro` helpers when:
//
// - Loro state is uninitialised (test scaffolding that doesn't call
//   `crate::loro::shared::install_for_test`). Production always
//   initialises via `crate::loro::shared::init` at boot.
// - Space resolution fails (orphan block, no `space` ancestor, pre-
//   FEAT-3 row). These rows write SQL but skip the engine apply; a
//   later op-log replay will reconcile engine state if the row gets a
//   space.
//
// In production both arms are unreachable. The fallback exists so
// that ~55 materializer / recovery / sync_daemon tests can thread
// synthetic ops through `apply_op` against bare-block fixtures with
// no space chain.
// ---------------------------------------------------------------------------

/// SQL-only CreateBlock fallback.
async fn apply_create_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: CreateBlockPayload,
) -> Result<(), AppError> {
    let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
    let block_id_str = p.block_id.as_str();
    let parent_id_ref = parent_id_str.as_deref();
    // #400: a new-scheme op carries a 0-based `index` and no legacy `position`;
    // fall back to a 1-based position for this engine-less (test-only) path.
    let position = p.position.or_else(|| {
        p.index
            .map(crate::pagination::index_to_provisional_position)
    });
    sqlx::query!(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
        block_id_str,
        p.block_type,
        p.content,
        parent_id_ref,
        position,
    )
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
    let block_id_str = p.block_id.as_str();
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL",
        p.to_text,
        block_id_str,
    )
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
    now: i64,
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
    .bind(p.deleted_at_ref)
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
    let new_parent_ref = new_parent_str.as_deref();
    let block_id_str = p.block_id.as_str();

    // #383: defensive cycle probe before the bare UPDATE. The engine path
    // (`commands/blocks/move_ops.rs::move_block_inner`) rejects a move that
    // would make the new parent a descendant of (or equal to) the block being
    // moved, but this SQL-only fallback wrote `parent_id` unconditionally — a
    // malformed/replayed op could install a parent_id cycle that then makes
    // every recursive CTE walk this subtree saturate at the depth-100 bound.
    // Mirror the cycle check from `move_block_inner`: walk the new parent's
    // ancestors (via `ancestors_cte_standard!`) and, if `block_id` appears
    // among them — or `new_parent == block_id` — skip the write and warn
    // rather than persisting the cycle. No-op-warn (not error) because this is
    // the sync-replay fallback arm; aborting would wedge inbound sync, whereas
    // dropping a self-evidently invalid move is recoverable.
    if let Some(parent) = new_parent_ref {
        let would_cycle = if parent == block_id_str {
            true
        } else {
            sqlx::query(concat!(
                crate::ancestors_cte_standard!(),
                "SELECT 1 FROM ancestors WHERE id = ?",
            ))
            .bind(parent)
            .bind(block_id_str)
            .fetch_optional(&mut *conn)
            .await?
            .is_some()
        };
        if would_cycle {
            tracing::warn!(
                block_id = %block_id_str,
                new_parent_id = %parent,
                "apply_move_block_sql_only: move would create a parent_id cycle \
                 (new parent is the block itself or one of its descendants); \
                 skipping the UPDATE (#383)"
            );
            return Ok(());
        }
    }

    // #400: prefer the new-scheme 0-based `new_index` (as a 1-based position)
    // on this engine-less (test-only) path; else the legacy `new_position`.
    let position = p
        .new_index
        .map(crate::pagination::index_to_provisional_position)
        .unwrap_or(p.new_position);
    sqlx::query!(
        "UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?",
        new_parent_ref,
        position,
        block_id_str,
    )
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
    let block_id_str = p.block_id.as_str();
    let tag_id_str = p.tag_id.as_str();
    sqlx::query!(
        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        block_id_str,
        tag_id_str,
    )
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
    let block_id_str = p.block_id.as_str();
    let tag_id_str = p.tag_id.as_str();
    sqlx::query!(
        "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
        block_id_str,
        tag_id_str,
    )
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
        let block_id_str = p.block_id.as_str();
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            block_id_str,
            p.key,
            p.value_text,
            p.value_num,
            p.value_date,
            p.value_ref,
            value_bool_int,
        )
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
        let block_id_str = p.block_id.as_str();
        sqlx::query!(
            "DELETE FROM block_properties WHERE block_id = ? AND key = ?",
            block_id_str,
            p.key,
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::AddAttachment`].
async fn apply_add_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddAttachmentPayload,
    created_at: i64,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    let block_id_str = p.block_id.as_str();
    sqlx::query!(
        "INSERT OR IGNORE INTO attachments \
             (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        attachment_id_str,
        block_id_str,
        p.filename,
        p.fs_path,
        p.mime_type,
        p.size_bytes,
        created_at,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// PEND-28a H2: per-variant body for [`OpType::DeleteAttachment`].
async fn apply_delete_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteAttachmentPayload,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    sqlx::query!("DELETE FROM attachments WHERE id = ?", attachment_id_str)
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
///
/// # Pool usage (#385)
///
/// The set of referenced `fs_path`s is loaded **once** via a single
/// `SELECT fs_path FROM attachments` on `read_pool` (the dedicated
/// reader, when configured) into an in-memory `HashSet`, and membership
/// is tested per file in memory. This replaces the historical
/// per-file `SELECT 1 FROM attachments WHERE fs_path = ?` against the
/// write pool, which (a) contended with the foreground apply path for
/// the single SQLite writer and (b) could not use the *partial*
/// `fs_path` index (`WHERE deleted_at IS NULL`, migrations 0061/0081)
/// because the predicate-less lookup forced a per-file scan.
///
/// Semantics are preserved exactly: the old query had **no**
/// `deleted_at IS NULL` predicate, so it matched soft-deleted rows too;
/// the bulk `SELECT fs_path FROM attachments` likewise loads every row
/// (active and soft-deleted). A file is an orphan iff its normalized
/// relative path is not present in the set.
pub(super) async fn cleanup_orphaned_attachments(
    pool: &SqlitePool,
    read_pool: Option<&SqlitePool>,
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

    // #385: load the full set of referenced `fs_path`s ONCE on the read
    // pool, rather than issuing one write-pool `SELECT 1 WHERE fs_path = ?`
    // per walked file. The read pool (when configured) keeps this off the
    // single SQLite writer; falling back to the write pool preserves the
    // legacy behaviour for single-pool (test / legacy) materializers.
    //
    // The legacy per-file query had NO `deleted_at IS NULL` predicate, so
    // it matched soft-deleted rows too — we replicate that by selecting
    // every row's `fs_path` (no predicate). `fs_path` is stored as a
    // relative, forward-slash path by `add_attachment_inner`, which is the
    // exact normalized shape we compute per walked file below, so an
    // in-memory `HashSet` membership test is byte-equivalent to the old
    // `WHERE fs_path = ?` comparison.
    let lookup_pool = read_pool.unwrap_or(pool);
    let referenced_paths: std::collections::HashSet<String> = match sqlx::query_scalar!(
        r#"SELECT fs_path as "fs_path!: String" FROM attachments"#
    )
    .fetch_all(lookup_pool)
    .await
    {
        Ok(rows) => rows.into_iter().collect(),
        Err(e) => {
            // A failure to load the reference set must NOT cause the
            // GC to treat every file as an orphan. Abort the pass
            // (Ok, since the contract is "never propagate") and leave
            // all files untouched.
            tracing::warn!(
                error = %e,
                "cleanup_orphaned_attachments: failed to load referenced fs_paths; aborting pass"
            );
            return Ok(());
        }
    };

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

            // #385: in-memory membership test against the pre-loaded set,
            // replacing the per-file write-pool `SELECT 1 WHERE fs_path = ?`.
            if referenced_paths.contains(&relative_str) {
                // File is referenced — keep it.
                continue;
            }

            // Orphan: unlink. Errors are logged but never propagated, so
            // the rest of the pass continues.
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
            // SQL-review §H-2: after the per-block `block_links` diff is
            // written, roll up to the page-level `page_link_cache` so
            // `list_page_links_inner` can read from a precomputed
            // `(source_page, target_page, edge_count)` table instead of
            // the 3-JOIN superlinear query. The rollup uses the same
            // `pool` (single-pool variant) so the cache write sees the
            // post-diff `block_links` state; in the split-pool variant
            // both steps share `write_pool` for the same reason.
            //
            // PEND-56b: capture the **pre-diff** outbound target pages
            // BEFORE `reindex_block_links` runs so we can refresh
            // `pages_cache.inbound_link_count` for pages that just lost
            // an edge (otherwise the post-diff `block_links` no longer
            // references them and the refresh would miss the decrement).
            // Then refresh the union of pre- and post-diff target
            // pages after the diff + rollup commit.
            dispatch_split_or_single(
                pool,
                read_pool,
                |w, r| async move {
                    let pre = pre_diff_target_pages(r, block_id).await?;
                    cache::reindex_block_links_split(w, r, block_id).await?;
                    cache::reindex_page_link_cache_for_block(w, block_id).await?;
                    refresh_inbound_counts_after_reindex(w, block_id, &pre).await
                },
                |p| async move {
                    let pre = pre_diff_target_pages(p, block_id).await?;
                    cache::reindex_block_links(p, block_id).await?;
                    cache::reindex_page_link_cache_for_block(p, block_id).await?;
                    refresh_inbound_counts_after_reindex(p, block_id, &pre).await
                },
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
            // Load tag/page reference maps scoped to THIS block's own refs and
            // feed them into the `_with_maps` variants (which keep the strip
            // path sync — no DB round-trip inside the regex replace).
            //
            // Audit #418 — this previously called `load_ref_maps`, which scans
            // every page + tag block in the vault into memory on every single
            // edited block (O(pages + tags) per edit). `load_ref_maps_for_block`
            // extracts only the refs present in this block's content and fetches
            // just those rows, so a debounced-typing stream no longer re-reads
            // the whole page/tag set per edited block.
            let read_pool_for_maps = read_pool.unwrap_or(pool);
            let (tag_names, page_titles) =
                fts::load_ref_maps_for_block(read_pool_for_maps, block_id).await?;
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
            Some(dir) => cleanup_orphaned_attachments(pool, read_pool, dir).await,
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
        MaterializeTask::RebuildPageLinkCache => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_page_link_cache_split,
                cache::rebuild_page_link_cache,
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
// RestoreBlock cascade fanout tests.
//
// Verifies the materializer's restore-cascade fans out `RestoreBlock`
// engine calls to every descendant in the SQL cohort, not just the
// seed block. Without this fanout a 10-descendant subtree restore
// would leave 9 blocks marked `deleted_at != Null` in the Loro doc.
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
    const DELETED_AT: i64 = 1_735_689_600_000;

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
        // Soft-delete all four at the same cohort timestamp (mirrors the
        // SQL "all four deleted at the same ref" shape).
        for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
            engine
                .apply_delete_block(id, "2025-01-15T12:00:00Z")
                .unwrap();
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
            deleted_at_ref: DELETED_AT,
        });
        let record = std::sync::Arc::new(
            crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
                .await
                .expect("append op_log"),
        );

        // Drive the materializer's apply path (which fans out the
        // engine cohort dispatch).
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

    /// Direct-helper test — exercises `dispatch_restore_descendants`
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
            created_at: DELETED_AT,
            block_id: Some(PAGE_ID.into()),
        };

        // Empty descendant list — no engine mutations expected.
        super::dispatch_restore_descendants(&pool, &root, &[]).await;

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
// DeleteBlock cascade fanout tests.
//
// Symmetric companion to `restore_cascade_tests` above. Asserts that
// the materializer fans out the engine-side soft-delete to every
// descendant the SQL UPDATE touches, and that the cohort SELECT runs
// BEFORE the UPDATE so the `descendants_cte_active!()` filter still
// matches (post-UPDATE the filter would skip the just-deleted rows).
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
    // through the process-local Loro state is impossible.
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

        // Run the UPDATE. The cascade UPDATE lives inside the
        // engine-side projection in production; we inline the same
        // CTE-driven UPDATE here because the test's load-bearing
        // assertion is about ordering between `collect_delete_cohort`
        // and the descendants-stamping UPDATE, not about which
        // production helper drives the UPDATE.
        sqlx::query(concat!(
            crate::descendants_cte_active!(),
            "UPDATE blocks SET deleted_at = ? \
             WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
        ))
        .bind(payload.block_id.as_str())
        .bind(1_767_225_600_000_i64)
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
// `apply_op_tx` engine-path tests.
//
// Verifies the engine-path wiring in `apply_op_tx` for every op type.
// Each test installs Loro state, drives an op through `apply_op_tx`,
// and asserts both SQL row shape (load-bearing invariant) AND engine
// state (proves the engine path actually ran).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod engine_path_tests {
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
    const DEVICE_ID: &str = "device-engine-path";

    async fn fresh_pool_with_page() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("engine_path.db");
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

    /// `apply_op_tx` for a CreateBlock op routes through the engine
    /// plus projection helpers and produces the expected SQL row
    /// shape. Load-bearing invariant: the engine path produces stable
    /// SQL output for single-author ops.
    #[tokio::test]
    async fn apply_op_tx_create_block_engine_path() {
        let (pool, _dir) = fresh_pool_with_page().await;
        // The engine path reads the Loro state global; install it for
        // the test.
        let _state = crate::loro::shared::install_for_test();
        // PEND-80 Phase 3: the parent page must exist in the engine tree.
        seed_page_via_loro(&pool).await;

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(7),
            index: None,
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

        // SQL row matches what reading from the engine projected.
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
        // #400: the engine projects the authoritative DENSE 1-based rank from
        // the fractional sibling order, not the legacy sparse `position`. This
        // is the only child of PAGE_ID, so its dense rank is 1 (was 7).
        assert_eq!(row.3, 1);

        // Engine actually saw the apply (proves the loro path ran).
        let state = crate::loro::shared::get().expect("Loro state present");
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
        // #400: the engine's projected position is the dense 1-based rank from
        // the fractional sibling order; sole child of PAGE_ID ⇒ rank 1.
        assert_eq!(engine_snap.position, 1);

        // Reset the flag for any other tests in this binary.  The
        // OnceLock-installed flag is process-global; tests that rely on
        // default-off must explicitly install `false` themselves.
    }

    /// EditBlock loro path: pre-existing block, run an EditBlock op
    /// with the flag on, verify the SQL `content` column matches the
    /// engine's post-edit content (which is also the payload's
    /// `to_text` for a single-author op).
    #[tokio::test]
    async fn apply_op_tx_edit_block_engine_path() {
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
            index: None,
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
        // projection helper does not. Without page_id the EditBlock's
        // `resolve_block_space` cannot reach the page's `space`
        // property and the engine path falls back to the SQL-only
        // fallback. Mirror the rebuild's effect inline so the
        // EditBlock path resolves cleanly.
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
        let state = crate::loro::shared::get().expect("Loro state");
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
    /// Create the PAGE_ID node in the Loro engine (not just SQL). PEND-80
    /// Phase 3: the block hierarchy is a LoroTree, so a child's parent must
    /// exist in the engine for `read_block` to derive its `parent_id`.
    /// Production always creates pages through the op-log → engine; the
    /// `fresh_pool_with_page` SQL-only shortcut does not, so the
    /// engine-path tests seed the page node here. Idempotent in SQL
    /// (`INSERT OR IGNORE` — the row already exists).
    async fn seed_page_via_loro(pool: &SqlitePool) {
        let create_page = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(PAGE_ID),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "page-content".into(),
        });
        let record = crate::op_log::append_local_op(pool, DEVICE_ID, create_page)
            .await
            .expect("append create page");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply create page");
        tx.commit().await.expect("commit");
    }

    async fn seed_block_via_loro(pool: &SqlitePool) {
        seed_page_via_loro(pool).await;
        let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            position: Some(0),
            index: None,
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
    async fn apply_op_tx_set_property_engine_path() {
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
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_delete_block_engine_path() {
        // Verifies BOTH (a) the engine path runs (engine `read_deleted`
        // returns true for the seed) AND (b) the projection's
        // CTE-driven cascade fires — seed + two children are all
        // soft-deleted in SQL after a single DeleteBlock op against
        // the seed. The engine path only sees the seed apply; the
        // descendant cohort fans out to the engine post-commit.
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
                index: None,
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
        let record_created_at = record.created_at;
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record)
            .await
            .expect("apply_op_tx");
        tx.commit().await.expect("commit");

        // SQL: seed + both children all carry the projection's
        // `deleted_at = record.created_at` — the CTE-driven cascade
        // mirrors `apply_delete_block_tx`.
        for id in [BLOCK_ID, CHILD_1, CHILD_2] {
            let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch row");
            assert_eq!(
                row.0,
                Some(record_created_at),
                "cascade must soft-delete {id}",
            );
        }

        // Engine sees the seed delete (engine fanout is deferred).
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_move_block_engine_path() {
        let (pool, _dir) = fresh_pool_with_page().await;
        let _state = crate::loro::shared::install_for_test();

        seed_block_via_loro(&pool).await;

        // Move to (parent=PAGE_ID, position=42).
        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            new_position: 42,
            new_index: None,
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
        // #400: the engine projects the authoritative DENSE 1-based rank from
        // the fractional sibling order, not the legacy sparse `new_position`.
        // The moved block is the only child of PAGE_ID ⇒ dense rank 1 (was 42).
        assert_eq!(row.1, 1);

        // Engine sees the move.
        let state = crate::loro::shared::get().expect("Loro state");
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
        // #400: the engine's projected position is the dense 1-based rank from
        // the fractional sibling order; sole child of PAGE_ID ⇒ rank 1.
        assert_eq!(engine_snap.position, 1);
    }

    // -----------------------------------------------------------------
    // RestoreBlock / PurgeBlock / AddTag / RemoveTag / DeleteProperty
    // engine-path tests.
    // -----------------------------------------------------------------

    /// RestoreBlock engine-path: seed via engine, soft-delete, then
    /// restore. Verifies SQL `deleted_at` is cleared for the seed AND
    /// that the engine's `read_deleted` returns `false`. The
    /// descendant cohort fan-out lives in
    /// `dispatch_restore_descendants` (post-
    /// commit) — we inspect engine state for the seed only here.
    #[tokio::test]
    async fn apply_op_tx_restore_block_engine_path() {
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
        let deleted_at_ref = delete_record.created_at;
        let mut tx = pool.begin().await.expect("begin1");
        super::apply_op_tx(&mut tx, &delete_record)
            .await
            .expect("apply delete");
        tx.commit().await.expect("commit1");

        // Sanity: SQL has deleted_at set, engine `read_deleted` is true.
        let pre: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch pre");
        assert!(pre.0.is_some(), "delete must have run");

        // Now restore.
        let restore_payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ID),
            deleted_at_ref,
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
        let post: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch post");
        assert_eq!(post.0, None, "restore must clear deleted_at");

        // Engine: seed is no longer marked deleted.
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_purge_block_engine_path() {
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
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_add_tag_engine_path() {
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
            index: None,
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
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_remove_tag_engine_path() {
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
            index: None,
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
        let state = crate::loro::shared::get().expect("Loro state");
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
    async fn apply_op_tx_delete_property_engine_path() {
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
        let state = crate::loro::shared::get().expect("Loro state");
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

#[cfg(test)]
mod static_source_checks {
    /// SQL-review M-1: the two production apply-tx sites in this file —
    /// `apply_op` and the `BatchApplyOps` arm of
    /// `handle_foreground_task` — must open their write transaction
    /// via [`crate::db::begin_immediate_logged`], NOT the sqlx default
    /// `pool.begin()` (which uses DEFERRED isolation). Under sync
    /// burst, two materializer batches starting with DEFERRED
    /// transactions only collide on the first write and stall silently
    /// on `busy_timeout` mid-tx; routing through
    /// `begin_immediate_logged` forces upfront write-lock acquisition
    /// and surfaces contention as a loud `warn!` log line. This guard
    /// reads `handlers.rs` from disk and asserts the immediate-helper
    /// labels are present and that the production paths do not
    /// re-introduce a bare `pool.begin()`. Test-only `pool.begin()`
    /// sites under `#[cfg(test)]` are explicitly out of scope.
    ///
    /// Style mirrors `op_log::tests::dag_queries_no_longer_use_json_extract_block_id`
    /// (the canonical static-source regression pattern in this repo).
    #[test]
    fn apply_tx_uses_begin_immediate_not_deferred() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/materializer/handlers.rs");
        let contents =
            std::fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));

        assert!(
            contents.contains("crate::db::begin_immediate_logged(pool, \"materializer_apply_op\")"),
            "apply_op must open its write tx via `begin_immediate_logged` with the \
             `materializer_apply_op` label — see SQL-review M-1.",
        );
        assert!(
            contents
                .contains("crate::db::begin_immediate_logged(pool, \"materializer_apply_batch\")"),
            "BatchApplyOps must open its write tx via `begin_immediate_logged` with \
             the `materializer_apply_batch` label — see SQL-review M-1.",
        );

        // Defence in depth: the production paths must not regress to a
        // bare `pool.begin()`. Test modules in this file legitimately
        // use `pool.begin()` (rollback semantics suit unit tests that
        // never commit), so split the file at the first `#[cfg(test)]`
        // attribute and only scan the production prefix.
        let prod_prefix = contents
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields at least one element");
        assert!(
            !prod_prefix.contains("pool.begin()"),
            "production code in src/materializer/handlers.rs must not call bare \
             `pool.begin()` (DEFERRED isolation) — use `begin_immediate_logged` \
             so sync-burst contention serialises upfront. See SQL-review M-1.",
        );
    }
}

#[cfg(test)]
mod move_sql_only_cycle_tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::MoveBlockPayload;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const A: &str = "01HZ0000000000000000000MVA";
    const B: &str = "01HZ0000000000000000000MVB";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("move_cycle.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// #383: the SQL-only MoveBlock fallback must refuse to write a
    /// `parent_id` cycle. Seed A → B (B is a child of A); a replayed/malformed
    /// op that tries to move A *under* B would make B (A's descendant) A's
    /// parent — a cycle. The fallback must detect it and skip the UPDATE,
    /// leaving A's parent_id untouched.
    #[tokio::test]
    async fn apply_move_block_sql_only_skips_cycle() {
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'A', NULL, 1)",
        )
        .bind(A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'B', ?, 1)",
        )
        .bind(B)
        .bind(A)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        // Attempt the cycle: move A under B (B is A's descendant).
        apply_move_block_sql_only(
            &mut conn,
            MoveBlockPayload {
                block_id: BlockId::from_trusted(A),
                new_parent_id: Some(BlockId::from_trusted(B)),
                new_position: 1,
                new_index: None,
            },
        )
        .await
        .expect("fallback returns Ok (no-op-warn, not error)");
        drop(conn);

        // A's parent_id must still be NULL — the cycle write was skipped.
        let parent: Option<String> =
            sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
                .bind(A)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            parent.is_none(),
            "cycle move must be skipped; A.parent_id should remain NULL, got {parent:?}"
        );
    }

    /// Control: a legitimate (non-cycle) move via the SQL-only fallback still
    /// writes the new parent_id.
    #[tokio::test]
    async fn apply_move_block_sql_only_allows_non_cycle() {
        let (pool, _dir) = fresh_pool().await;
        // Two unrelated blocks: A (root) and B (root). Move A under B — no cycle.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'A', NULL, 1)",
        )
        .bind(A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'B', NULL, 2)",
        )
        .bind(B)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        apply_move_block_sql_only(
            &mut conn,
            MoveBlockPayload {
                block_id: BlockId::from_trusted(A),
                new_parent_id: Some(BlockId::from_trusted(B)),
                new_position: 3,
                new_index: None,
            },
        )
        .await
        .expect("non-cycle move");
        drop(conn);

        let parent: Option<String> =
            sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
                .bind(A)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            parent.as_deref(),
            Some(B),
            "non-cycle move must write the new parent_id"
        );
    }
}
