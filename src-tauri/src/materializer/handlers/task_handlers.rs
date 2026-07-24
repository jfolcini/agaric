//! Queue task entry points: foreground/background task dispatch and
//! the read/write-split helper.

use super::*;

// `handle_foreground_task` previously took an unused
// `_metrics: &QueueMetrics` parameter. Counters live on the consumer
// loop (see `consumer::process_single_foreground_task`) which inspects
// the handler's `Result` and bumps the appropriate counter; the handler
// itself never needed access. Reintroduce the parameter only when a
// future code path needs metric mutation from inside the handler.
pub(crate) async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    state: &agaric_engine::loro::shared::LoroState,
) -> Result<(), AppError> {
    match task {
        MaterializeTask::ApplyOp(record) => {
            if let Err(e) = apply_op(pool, record, state).await {
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
        // #2896 — a boot-replay op: apply in `ApplyMode::ReplaySuppressed` so
        // its inline reprojection defers into the replay-owned sink (`dirty`).
        // Identical to `ApplyOp` apart from the explicit mode.
        MaterializeTask::ReplayApplyOp(record, dirty) => {
            let mode = ApplyMode::ReplaySuppressed(dirty.clone());
            if let Err(e) = apply_op_with_mode(pool, record, mode, state).await {
                tracing::warn!(
                    op_type = %record.op_type,
                    device_id = %record.device_id,
                    seq = record.seq,
                    error = %e,
                    "failed to apply boot-replay op — will retry"
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
            // SQL-review route through `begin_immediate_logged`
            // so sync-burst contention surfaces as upfront serialised
            // wait (with a `warn!` if slow) instead of mid-tx
            // `busy_timeout` stalls under SQLite's default DEFERRED
            // isolation.
            let mut tx =
                crate::db::begin_immediate_logged(pool, "materializer_apply_batch").await?;
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
            // #2200 Tier-2 import scaling: a `BatchApplyOps` IS the chunk. The
            // accumulator collects (a) the latest sibling ordering per touched
            // parent group and (b) the distinct affected page ids across the
            // whole batch, so the two derived maintenance passes
            // (`reproject_dense_positions`, `recompute_pages_cache_counts_for_pages`)
            // run ONCE per parent/page at end-of-chunk instead of once per block
            // — collapsing the import's per-block O(N) passes into a per-chunk
            // O(N) pass. Threaded as `Some(&mut chunk)` into every `apply_op_tx`
            // and flushed below (inside the same tx, before commit) so the
            // deferred writes stay atomic with the block mutations.
            //
            // CORRECTNESS GATE — the dense-position reprojection deferral is
            // ONLY safe when the ENTIRE chunk is `CreateBlock` ops. The
            // accumulator snapshots each touched parent's sibling order at
            // create-time and replays it once at flush; Move/Restore/Delete
            // still reproject INLINE (loro_apply.rs), so a later same-parent
            // op in a mixed batch would be clobbered by the stale snapshot
            // replay (e.g. Create(a→P),Create(b→P) snapshots [a,b], then
            // Move(b before a) reprojects inline to b=1,a=2, but the flush
            // replays stale [a,b] → a=1,b=2 — WRONG). So we defer ONLY for an
            // all-create batch; a mixed batch passes `None` to every op so ALL
            // ops — creates included — reproject inline exactly as before this
            // optimization (the known-correct path). The common import path is
            // all-`CreateBlock`, so it keeps the perf win. (The accumulator's
            // reproject key is additionally space-qualified so an all-create
            // batch spanning spaces cannot collide on the top-level `None`
            // key — see `ChunkAccumulator`.)
            let all_create = records
                .iter()
                .all(|r| r.op_type == OpType::CreateBlock.as_str());
            let mut chunk = if all_create {
                Some(ChunkAccumulator::default())
            } else {
                None
            };
            // `records` is `&Arc<Vec<OpRecord>>`; `.iter()` derefs
            // through `Arc -> Vec` to yield `&OpRecord` without copying.
            for record in records.iter() {
                let effects = match apply_op_tx(&mut tx, record, chunk.as_mut(), state).await {
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
            }
            // #2200: end-of-chunk flush — reproject every touched sibling group
            // ONCE and recompute every distinct affected page's counts ONCE,
            // INSIDE this tx so the deferred writes commit atomically with the
            // block mutations (and roll back together with them on the error
            // paths above, which return before reaching here). A `?` here rolls
            // the whole batch back, same as an in-loop failure. `None` on the
            // mixed-batch path (deferral gated off) — nothing was accumulated,
            // every op already reprojected/recomputed inline, so skip the flush.
            if let Some(chunk) = chunk {
                chunk.flush(&mut tx).await?;
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
                dispatch_restore_descendants(pool, record, &effects.restored_cohort, state).await;
                // #2017: symmetric UPWARD fan-out for the restored ancestor
                // chain (see `apply_op` for the divergence rationale). Mirrors
                // the descendant fan-out on the batch path too.
                dispatch_restore_ancestors(pool, record, &effects.restored_ancestors, state).await;
                dispatch_delete_descendants(
                    record,
                    &effects.deleted_cohort,
                    effects.delete_space_id.as_ref(),
                    state,
                )
                .await;
            }

            Ok(())
        }
        MaterializeTask::Barrier(notify) => {
            notify.notify_one();
            Ok(())
        }
        _ => {
            // A non-Apply / non-Batch / non-Barrier variant landed in
            // the foreground queue — that is a dispatch bug, not a runtime
            // condition. Return `Err(Validation)` so the consumer's
            // outcome inspection bumps `fg_errors` (see
            // `consumer::process_single_foreground_task`) and reviewers /
            // operators see a real signal instead of a silently-dropped op.
            //
            // Err return + error! log is sufficient — debug_assert
            // removed because tests assert the Err contract directly, and a
            // `debug_assert!(false, …)` would force every test exercising
            // this path to dance around `#[should_panic]`.
            tracing::error!(
                ?task,
                "unexpected task in foreground queue — misrouted dispatch"
            );
            Err(AppError::validation(format!(
                "unexpected task in foreground queue: {task:?}"
            )))
        }
    }
}

/// Dispatch a background task to either the read/write split implementation
/// (when a separate read pool is configured) or the single-pool implementation.
///
/// Collapses ~10 identical `match read_pool { Some(rp) => …_split,
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

/// Metrics-unaware entry point (unit tests, and any caller without a live
/// [`QueueMetrics`]). Retry-queue `pending_retry_rows` gauge accounting is
/// skipped for the #2831 obligation seed — safe because that gauge is only
/// ever consulted to SKIP work, and no sweeper runs in these callers.
///
/// #2831: the production background consumer routes through
/// [`handle_background_task_metered`], so in a non-test lib build this
/// unmetered wrapper is exercised only by the materializer test suite.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn handle_background_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
    app_data_dir: Option<&Path>,
) -> Result<(), AppError> {
    handle_background_task_inner(pool, task, read_pool, app_data_dir, None).await
}

/// #2831: metrics-aware entry point used by the background consumer so the
/// durable `RefreshTagUsageCount` obligation seeded by the
/// `ReindexBlockTagRefs` arm keeps the `pending_retry_rows` gauge accurate.
pub(crate) async fn handle_background_task_metered(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
    app_data_dir: Option<&Path>,
    metrics: &crate::materializer::metrics::QueueMetrics,
) -> Result<(), AppError> {
    handle_background_task_inner(pool, task, read_pool, app_data_dir, Some(metrics)).await
}

async fn handle_background_task_inner(
    pool: &SqlitePool,
    task: &MaterializeTask,
    read_pool: Option<&SqlitePool>,
    app_data_dir: Option<&Path>,
    metrics: Option<&crate::materializer::metrics::QueueMetrics>,
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
        MaterializeTask::RefreshTagUsageCount { tag_id } => {
            // #676: scoped single-tag usage_count refresh. Single-pool only —
            // it reads `blocks`/`block_tags`/`block_tag_refs` and writes the
            // one `tags_cache` row on the same write tx, so the split-pool
            // reader-snapshot dance buys nothing here (the read is one indexed
            // row, not a full-table stream).
            cache::refresh_tag_usage_count(pool, tag_id).await
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
            // #2397 LOAD-BEARING: this task is the SOLE writer of the
            // `page_link_cache` rollup (`reindex_page_link_cache_for_block`
            // below). The in-tx `apply_op_projected` covers `block_links` +
            // `inbound_link_count` but NOT this page-level rollup, so the
            // background enqueue that reaches here must not be dropped as
            // redundant. Option A keeps `page_link_cache` eventually-consistent.
            //
            // SQL-review §H-2: after the per-block `block_links` diff is
            // written, roll up to the page-level `page_link_cache` so
            // `list_page_links_inner` can read from a precomputed
            // `(source_page, target_page, edge_count)` table instead of
            // the 3-JOIN superlinear query. The rollup uses the same
            // `pool` (single-pool variant) so the cache write sees the
            // post-diff `block_links` state; in the split-pool variant
            // both steps share `write_pool` for the same reason.
            //
            // Capture the **pre-diff** outbound target pages
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
            // #2659 + #2831: reindex this block's inline `#[ULID]` tag-refs AND
            // make the dependent `tags_cache.usage_count` refresh DURABLE and
            // idempotent.
            //
            // #2659 rewrote `block_tag_refs` and refreshed each changed tag's
            // usage_count inline, but coupled that refresh to the reindex
            // *diff*: on a retry (WAL contention on a `refresh_tag_usage_count`,
            // or a crash mid-loop) the `block_tag_refs` table already holds the
            // new state, so the retry's diff is EMPTY, `changed_tags` is empty,
            // the refresh loop runs zero times, and `usage_count` stays stale
            // until an unrelated AddTag/RemoveTag or a full RebuildTagsCache
            // heals it (#2831 — the "a refresh is owed" signal was transient).
            //
            // Fix: seed a durable, tag_id-keyed `RetryKind::RefreshTagUsageCount`
            // obligation INSIDE the same write transaction that commits the
            // `block_tag_refs` diff (`*_in_tx` variants). A crash or error
            // anywhere after that commit leaves a durable row the periodic
            // sweeper drives to completion, independent of any future (empty)
            // reindex diff. After the diff + obligations commit, each changed
            // tag's usage_count is refreshed inline (the #2659 happy path) and
            // its obligation cleared on success; a failed refresh is swallowed
            // and left to the sweeper — re-running the whole reindex would only
            // produce an empty diff, so returning `Err` here would not help the
            // refresh and would just churn the `ReindexBlockTagRefs` retry row.
            let mut tx =
                crate::db::begin_immediate_logged(pool, "reindex_block_tag_refs_2831").await?;
            let changed_tags = match read_pool {
                Some(rp) => {
                    cache::reindex_block_tag_refs_split_in_tx(&mut tx, rp, block_id).await?
                }
                None => cache::reindex_block_tag_refs_in_tx(&mut tx, block_id).await?,
            };
            // Seed one durable obligation per changed tag, atomic with the diff.
            let mut freshly_seeded = 0usize;
            for tag_id in &changed_tags {
                let inserted =
                    crate::materializer::retry_queue::seed_refresh_tag_usage_count_obligation_tx(
                        &mut tx, tag_id,
                    )
                    .await?;
                if inserted {
                    freshly_seeded += 1;
                }
            }
            tx.commit().await?;

            // Gauge accounting only AFTER a successful commit (a bump before
            // commit would over-count on rollback).
            if let Some(m) = metrics {
                for _ in 0..freshly_seeded {
                    m.note_retry_row_inserted();
                }
            }

            // #2659 happy path: refresh each changed tag inline and clear its
            // now-redundant obligation. A failure leaves the durable row for
            // the sweeper (which re-enqueues `RefreshTagUsageCount { tag_id }`
            // and, on durable success, clears it via `clear_on_success`).
            for tag_id in &changed_tags {
                match cache::refresh_tag_usage_count(pool, tag_id).await {
                    Ok(()) => {
                        if let Err(e) =
                            crate::materializer::retry_queue::clear_refresh_tag_usage_count_obligation(
                                pool, tag_id, metrics,
                            )
                            .await
                        {
                            tracing::warn!(
                                tag_id = %tag_id,
                                error = %e,
                                "#2831: failed to clear usage_count refresh obligation after \
                                 inline success; sweeper will re-run (idempotent) and re-clear"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            tag_id = %tag_id,
                            error = %e,
                            "#2831: inline usage_count refresh failed after reindex; durable \
                             obligation left for the retry sweeper"
                        );
                    }
                }
            }
            Ok(())
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
        MaterializeTask::CleanupOrphanedAttachments => {
            if let Some(dir) = app_data_dir {
                cleanup_orphaned_attachments(pool, read_pool, dir).await
            } else {
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
        }
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
        MaterializeTask::ApplyOp(record) | MaterializeTask::ReplayApplyOp(record, _) => {
            // (bg mirror): mirror the foreground catch-all — an
            // `ApplyOp` / `ReplayApplyOp` in the background queue is a dispatch
            // bug (#2896: both are foreground-only). Promote
            // to error level and return `Err(Validation)` so the bg
            // consumer's outcome inspection bumps `bg_errors`.
            //
            // Err return + error! log is sufficient — debug_assert
            // removed because tests assert the Err contract directly.
            tracing::error!(
                op_type = %record.op_type,
                device_id = %record.device_id,
                seq = record.seq,
                "unexpected ApplyOp in background queue — misrouted dispatch"
            );
            Err(AppError::validation(format!(
                "unexpected ApplyOp in background queue: device_id={}, seq={}, op_type={}",
                record.device_id, record.seq, record.op_type
            )))
        }
        MaterializeTask::BatchApplyOps(records) => {
            // (bg mirror): same rationale as the `ApplyOp` arm above.
            if let Some(first) = records.first() {
                tracing::error!(
                    device_id = %first.device_id,
                    seq = first.seq,
                    batch_size = records.len(),
                    "unexpected BatchApplyOps in background queue — misrouted dispatch"
                );
                Err(AppError::validation(format!(
                    "unexpected BatchApplyOps in background queue: device_id={}, seq={}, batch_size={}",
                    first.device_id,
                    first.seq,
                    records.len()
                )))
            } else {
                tracing::error!(
                    "unexpected empty BatchApplyOps in background queue — misrouted dispatch"
                );
                Err(AppError::validation(
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
