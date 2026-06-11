//! Queue task entry points: foreground/background task dispatch and
//! the read/write-split helper.

use super::*;

// MAINT-148g — `handle_foreground_task` previously took an unused
// `_metrics: &QueueMetrics` parameter. Counters live on the consumer
// loop (see `consumer::process_single_foreground_task`) which inspects
// the handler's `Result` and bumps the appropriate counter; the handler
// itself never needed access. Reintroduce the parameter only when a
// future code path needs metric mutation from inside the handler.
pub(crate) async fn handle_foreground_task(
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
            // #412: release-build counterpart to the debug_assert above. A
            // mixed-device batch cannot be represented by the single global
            // apply cursor (it would advance past another device's
            // unmaterialised ops), so reject it loudly in ALL builds rather
            // than silently corrupting the cursor. Removed once the per-device
            // watermark cursor lands (deferred with multi-device sync).
            if let Some(first) = records.first()
                && records.iter().any(|r| r.device_id != first.device_id)
            {
                return Err(AppError::InvalidOperation(
                    "BatchApplyOps received a mixed-device batch; the single global \
                         apply cursor cannot represent per-device watermarks — per-device \
                         cursor partitioning is required (backend audit #412)"
                        .into(),
                ));
            }
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
            // #482: hoist the gcal-active check once before the loop so
            // `snapshot_for_op` (a SELECT inside the writer lock) is
            // skipped entirely when Google Calendar is not connected —
            // the snapshot result is only consumed when `gcal_on` is true.
            // The snapshot MUST be taken BEFORE `apply_op_tx` to capture
            // the pre-mutation state (old dates), which is why the
            // conditional read stays at the top of the per-record body.
            let gcal_on = gcal_handle.get().is_some();
            // M-10: `records` is `&Arc<Vec<OpRecord>>`; `.iter()` derefs
            // through `Arc -> Vec` to yield `&OpRecord` without copying.
            for record in records.iter() {
                let snapshot = if gcal_on {
                    snapshot_for_op(&mut tx, record).await?
                } else {
                    BlockDateSnapshot::default()
                };
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
                if gcal_on {
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

            // Post-commit cohort fan-out for the batch. Runs AFTER
            // `tx.commit` so any record whose sibling rolled the tx
            // back is not visible here (an Err inside the loop above
            // returns early before we reach this point). Each op was
            // already engine-applied INSIDE the tx (`apply_op_tx` →
            // `apply_*_via_loro`) — there is deliberately NO per-op
            // re-dispatch here (#603: a second engine apply routed
            // new-scheme create/move ops through the legacy position
            // path, converging sibling order toward ULID order). Only
            // the Restore/Delete descendant cohorts fan out, so the
            // engine's per-block-id mutation matches the SQL cascade.
            for (record, effects) in records.iter().zip(per_record_effects.iter()) {
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
        MaterializeTask::Barrier(notify) => {
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

/// Dispatch a background task to either the read/write split implementation
/// (when a separate read pool is configured) or the single-pool implementation.
///
/// MAINT-148a — collapses ~10 identical `match read_pool { Some(rp) => …_split,
/// None => … }` arms in [`handle_background_task`] to a single helper. Each
/// call site becomes one expression that constructs both branches as closures.
pub(super) async fn dispatch_split_or_single<'a, FSplit, FSingle, FutSplit, FutSingle, T>(
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

pub(crate) async fn handle_background_task(
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
        MaterializeTask::RebuildPagesCacheCounts => {
            // #417: count-only full-table recompute. Single-pool only —
            // SQLite is one file regardless of split, and the recompute
            // reads `blocks`/`block_links` and writes `pages_cache` on the
            // same write tx (no separate reader snapshot needed).
            cache::rebuild_pages_cache_counts(pool).await
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
        MaterializeTask::ReindexBlockLinks { block_id } => {
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
        MaterializeTask::ReindexBlockTagRefs { block_id } => {
            dispatch_split_or_single(
                pool,
                read_pool,
                |w, r| cache::reindex_block_tag_refs_split(w, r, block_id),
                |p| cache::reindex_block_tag_refs(p, block_id),
            )
            .await
        }
        MaterializeTask::UpdateFtsBlock { block_id } => {
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
        MaterializeTask::ReindexFtsReferences { block_id } => {
            fts::reindex_fts_references(pool, block_id).await
        }
        MaterializeTask::RemoveFtsBlock { block_id } => {
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
        MaterializeTask::SetBlockPageId { block_id } => {
            cache::set_block_page_id_from_parent(pool, block_id).await?;
            // #533: space_id rides the same task — a fresh block inherits
            // its parent's space. Must run after page_id is set.
            cache::set_block_space_id_from_parent(pool, block_id).await?;
            Ok(())
        }
        MaterializeTask::RebuildPageIds => {
            dispatch_split_or_single(
                pool,
                read_pool,
                cache::rebuild_page_ids_split,
                cache::rebuild_page_ids,
            )
            .await?;
            // #533: space_id is derived from the freshly rebuilt page_id,
            // so it reconciles on the same task right after.
            cache::rebuild_space_ids(pool).await
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
        MaterializeTask::ApplyOp(record) => {
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
        MaterializeTask::Barrier(notify) => {
            notify.notify_one();
            Ok(())
        }
    }
}
