//! Queue task entry points: foreground/background task dispatch and
//! the read/write-split helper.

use super::*;

// `handle_foreground_task` previously took an unused
// `_metrics: &QueueMetrics` parameter. Counters live on the consumer
// loop (see `consumer::process_single_foreground_task`) which inspects
// the handler's `Result` and bumps the appropriate counter; the handler
// itself never needed access. Reintroduce the parameter only when a
// future code path needs metric mutation from inside the handler.
pub async fn handle_foreground_task(
    pool: &SqlitePool,
    task: &MaterializeTask,
    state: &crate::loro::shared::LoroState,
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
                agaric_store::db::begin_immediate_logged(pool, "materializer_apply_batch").await?;
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
                // #4390: the un-sweep's engine mirror, on the batch path too.
                // A `MoveBlock` whose subject arrives already tombstoned by a
                // concurrent cascade is exactly the shape a REMOTE batch
                // delivers, so leaving this off the batch arm would leave the
                // fix on the single-op path only.
                super::apply::dispatch_unswept_cohort(
                    record,
                    &effects.unswept_cohort,
                    effects.unswept_space_id.as_ref(),
                    state,
                )
                .await;
                // #4285: repair the LINK edges of everything this record's
                // restore un-deleted — the whole cohort, not just the seed.
                // Mirrors `apply_op`'s single-op call; a batch of remote ops
                // is exactly where a restore arrives without ever passing
                // through `invalidations_for_op`.
                super::apply::reindex_restored_cohort_links(
                    pool,
                    &effects.restored_cohort,
                    &effects.restored_ancestors,
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

/// The body of the [`MaterializeTask::ReindexBlockLinks`] arm, extracted so
/// the [`MaterializeTask::SetBlockPageId`] arm can re-run it (#3842) when it
/// changes the block's `page_id` — i.e. when the `page_link_cache` roll-up key
/// `COALESCE(page_id, parent_id, id)` moves out from under rows an earlier
/// reindex already wrote.
///
/// Re-running the WHOLE arm (not just the roll-up) is deliberate: it is
/// literally the "re-enqueue a per-block `ReindexBlockLinks`" of #3842's
/// option 2, and `pages_cache.inbound_link_count` is keyed on the source
/// block's `page_id` too (`recompute_all_pages_cache_counts` filters
/// `src.page_id IS NOT NULL AND src.page_id != p.page_id`), so the count
/// refresh is stale for exactly the same reason the roll-up is. The
/// `block_links` diff it repeats is idempotent and, for a block whose content
/// did not change, empty.
/// #4285 raised this to `pub(super)` so the restore fan-out
/// ([`super::apply::reindex_restored_cohort_links`]) repairs a restored cohort
/// member by running the SAME body the `ReindexBlockLinks` task runs, rather
/// than open-coding a second version of the repair.
pub(super) async fn run_reindex_block_links(
    pool: &SqlitePool,
    read_pool: Option<&SqlitePool>,
    block_id: &str,
    metrics: Option<&crate::materializer::metrics::QueueMetrics>,
) -> Result<(), AppError> {
    reindex_one_block_links(pool, read_pool, block_id).await?;
    resolve_referrers_of(pool, read_pool, block_id, metrics).await
}

/// One block's own outbound-link maintenance: the `block_links` diff, the
/// `page_link_cache` roll-up, and the `pages_cache.inbound_link_count`
/// refresh. Reads NOTHING about who references this block.
///
/// Split out of [`run_reindex_block_links`] by #4118 so the referrer repair
/// that function performs can re-run this for each referrer WITHOUT recursing:
/// a reindex cannot change whether its own block is linkable (that is a
/// function of the block's existence, liveness and space, none of which a
/// reindex writes), so one level is not an arbitrary depth cap — it is the
/// fixed point. Recursing would additionally loop forever on a pair of blocks
/// that reference each other and are both unresolved.
async fn reindex_one_block_links(
    pool: &SqlitePool,
    read_pool: Option<&SqlitePool>,
    block_id: &str,
) -> Result<(), AppError> {
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

/// #4118 — the PUSH half: re-link the referrers that were waiting for
/// `target_id` to become linkable.
///
/// # The defect
///
/// `reindex_block_links_conn` drops a parsed link token whose target does not
/// yet exist / is not yet live / has no `space_id` stamped. All three are
/// properties of the TARGET, all three can become true later — a peer can
/// deliver the referrer before the referent, `space_id` is stamped post-commit
/// by `SetBlockPageId`, and a tombstoned target can be RESTORED — and the
/// reindexer's only trigger is a change to the SOURCE's content. With no
/// vault-wide `rebuild_block_links` behind it, the edge was lost permanently.
///
/// # Which events reach this pass
///
/// Every one that enqueues a per-block `ReindexBlockLinks` for the target:
/// `CreateBlock` and `EditBlock` (#3296), `SetBlockPageId` (#3842 — it re-runs
/// the whole arm when it stamps the space), and `RestoreBlock` (#4209 — the
/// third transition, which the original fix did not observe; its arm emitted
/// only `lifecycle_rebuild_tasks` + `UpdateFtsBlock`, and the sole link member
/// of that set, the vault-wide `RebuildPageLinkCache`, folds `block_links`
/// rather than re-deriving it). Adding a fourth means enqueueing the task, not
/// touching this function.
///
/// All four are arms of `invalidations_for_op`, which is reached only from
/// `CommandTx::commit_and_dispatch` — so this pass is bound to the LOCAL
/// command path. An inbound-sync import maintains a changed block's OUTBOUND
/// edges in-tx (`agaric-engine`'s `maintain_pages_cache_counts_after_op` calls
/// `reindex_block_links_conn` directly, which records the unresolved debt) but
/// fans out through `enqueue_inbound_sync_rebuilds`, which enqueues no
/// per-block `ReindexBlockLinks` — so a target that becomes linkable by a
/// REMOTE op does not reach this push half until something local touches it.
///
/// # Why push and not pull
///
/// The alternative shape is to stop maintaining the edge set and resolve
/// tokens at read time. This codebase has already committed to the opposite:
/// `block_links` is a maintained table with a `REFERENCES blocks(id)` foreign
/// key on `target_id` (so it *cannot* hold a dangling token), and two further
/// artefacts — `page_link_cache` and `pages_cache.inbound_link_count` — fold
/// it as ground truth rather than re-deriving from content. Moving resolution
/// to read time means dropping that FK, re-filtering in every consumer, and
/// giving up the precomputed roll-up the graph view reads
/// (`list_page_links_inner`) — a rewrite of the whole link stack to fix a
/// missing row. Push keeps every existing consumer and every existing
/// invariant, and its per-event cost is one indexed seek that almost always
/// returns nothing.
///
/// # The trade-off actually accepted
///
/// Push needs a reverse index, and the only honest place to get one was a new
/// table (`block_links_unresolved`, migration 0112): `block_links` is itself
/// the reverse index and the row being looked up is the one that is missing,
/// a `content LIKE` scan is O(vault) per created block, and `fts_blocks`
/// erases the ULID it would be probed by. So the cost of this fix is one extra
/// table, kept honest by being recomputed from scratch for a source on every
/// reindex of that source rather than accumulated. What it buys is that the
/// repair is proportional to the blocks that actually named this target —
/// unlike the vault-wide `rebuild_block_links` alternative, which is O(vault)
/// per trigger and, more importantly, would still only be a *narrowing*: it
/// fires on restore/purge-shaped events, not on "a target became linkable", so
/// the reported scenario (write a reference, create its target, never touch
/// either again) would remain permanently broken.
///
/// # Durability
///
/// The `block_links_unresolved` rows are durable, but the *trigger* is not:
/// nothing would re-run this pass if the process died between the target
/// becoming linkable and the referrers being reindexed. So each referrer gets
/// a durable `RetryKind::ReindexBlockLinks` obligation seeded BEFORE the
/// inline repair and cleared after it succeeds — the #2831 / #3842 shape,
/// verbatim. A referrer whose repair fails keeps its obligation and its
/// unresolved row, so the sweeper retries it and the next touch of the target
/// finds it again.
///
/// It departs from #3842 in ONE respect, and deliberately: the clear is
/// conditional on this pass having actually inserted the row. #3842's inline
/// attempt is the whole `ReindexBlockLinks` task, so discharging a
/// pre-existing row of the same key is honest there. Here the inline attempt
/// is only [`reindex_one_block_links`] — half the task — so a pre-existing row
/// (a real failure, or an import-time SHED row for a task that never ran)
/// must survive. See the loop body.
///
/// Errors from an individual referrer are logged and swallowed for #3842's
/// reason: returning `Err` would fail the TARGET's task and seed a retry for
/// a block whose own reindex succeeded, which is churn. The referrer's own
/// obligation is the recovery path.
async fn resolve_referrers_of(
    pool: &SqlitePool,
    read_pool: Option<&SqlitePool>,
    target_id: &str,
    metrics: Option<&crate::materializer::metrics::QueueMetrics>,
) -> Result<(), AppError> {
    let referrers = cache::unresolved_link_sources(pool, target_id).await?;
    if referrers.is_empty() {
        return Ok(());
    }

    let mut tx =
        agaric_store::db::begin_immediate_logged(pool, "resolve_unresolved_block_links_4118")
            .await?;
    // Per referrer, whether THIS pass is the row's author. See the loop below
    // for why that has to be tracked rather than counted.
    let mut is_ours: Vec<bool> = Vec::with_capacity(referrers.len());
    for source_id in &referrers {
        is_ours.push(
            crate::materializer::retry_queue::seed_obligation_tx(
                &mut tx,
                &crate::materializer::retry_queue::RetryKind::ReindexBlockLinks,
                source_id,
                crate::materializer::retry_queue::SEED_UNRESOLVED_LINK_LAST_ERROR,
            )
            .await?,
        );
    }
    tx.commit().await?;

    // Gauge accounting only AFTER a successful commit — mirrors #2831/#3842.
    if let Some(m) = metrics {
        for _ in 0..is_ours.iter().filter(|seeded| **seeded).count() {
            m.note_retry_row_inserted();
        }
    }

    tracing::debug!(
        target_id = %target_id,
        referrers = referrers.len(),
        "#4118: target became linkable; re-linking the referrers that named it"
    );

    for (source_id, seeded_here) in referrers.iter().zip(is_ours) {
        match reindex_one_block_links(pool, read_pool, source_id).await {
            Ok(()) => {
                // Clear ONLY the obligation this pass authored.
                //
                // `clear_obligation`'s DELETE is unconditional, and
                // `seed_obligation_tx` is `ON CONFLICT DO NOTHING`, so a
                // referrer that ALREADY owed a `ReindexBlockLinks` — a real
                // earlier failure, or (overwhelmingly the common case during
                // an import, per #3843's 74–90% shed measurement) a row
                // recorded when its own create-time task was SHED at enqueue
                // and never executed — would have that pre-existing row
                // deleted here too.
                //
                // That would be a silent downgrade, because the two
                // obligations are not the same work. The pre-existing row owes
                // the WHOLE `ReindexBlockLinks` task, which is
                // `reindex_one_block_links` PLUS this very
                // `resolve_referrers_of` pass for the referrer's own id — the
                // half that re-links whoever is waiting on the REFERRER as a
                // target. The inline repair below runs only the first half (it
                // must: running the second would recurse). Discharging the
                // row on the strength of half the work reintroduces exactly
                // #4118's permanent loss one hop away.
                //
                // So a row we did not author is LEFT for the sweeper, which
                // re-enqueues the full task and lets `clear_on_success` retire
                // it. The cost of being wrong in this direction is one
                // redundant idempotent reindex; the cost of the other
                // direction is a lost edge nothing will ever re-derive.
                if !seeded_here {
                    continue;
                }
                if let Err(e) = crate::materializer::retry_queue::clear_obligation(
                    pool,
                    &crate::materializer::retry_queue::RetryKind::ReindexBlockLinks,
                    source_id,
                    metrics,
                )
                .await
                {
                    tracing::warn!(
                        source_id = %source_id,
                        target_id = %target_id,
                        error = %e,
                        "#4118: failed to clear the referrer re-link obligation after an \
                         inline success; the sweeper will re-run the reindex (idempotent) \
                         and re-clear"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    source_id = %source_id,
                    target_id = %target_id,
                    error = %e,
                    "#4118: inline referrer re-link failed; the durable ReindexBlockLinks \
                     obligation is left for the retry sweeper"
                );
            }
        }
    }

    Ok(())
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
pub async fn handle_background_task(
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
pub async fn handle_background_task_metered(
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
            run_reindex_block_links(pool, read_pool, block_id, metrics).await
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
                agaric_store::db::begin_immediate_logged(pool, "reindex_block_tag_refs_2831")
                    .await?;
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
            // #3842 — the ordering/idempotency rule, and its DURABILITY.
            //
            // `page_link_cache` is keyed on `COALESCE(page_id, parent_id,
            // id)`. When the in-tx create hook could not resolve the owning
            // page (`resolve_owning_page` → `None`, e.g. the parent row had
            // not been delivered yet on an out-of-order replay) the block's
            // `page_id` was still NULL when `ReindexBlockLinks` ran, so its
            // edges were rolled up under a CONTENT-BLOCK key. Nothing re-ran
            // the per-block reindex afterwards, leaving a spurious row keyed
            // on a non-page block AND the correct row missing — and
            // `list_page_links_inner` reads `src_deleted` off that block, so
            // the bogus edge is user-visible in the graph.
            //
            // The repair is a re-run of the block's `ReindexBlockLinks`: its
            // stale-key sweep drops the row left under the old key and the
            // recompute writes the row under the real page. Ordering the two
            // tasks (`SetBlockPageId` before `ReindexBlockLinks` in
            // `invalidations_for_op`'s create arm — also done) is NOT
            // sufficient on its own: a parent delivered in a LATER op batch
            // changes the key long after the create's fan-out drained.
            //
            // This is the #2831 defect class (see the `ReindexBlockTagRefs`
            // arm above), so it takes the #2831 SHAPE. The `page_id` write
            // commits on its own; the reindex runs after it. If the reindex
            // errors (`begin_immediate_logged` can surface `SQLITE_BUSY`
            // under a sync burst) or the process is killed in between, a
            // re-run's null-safe guard matches ZERO rows — "the column
            // changed" is a TRANSIENT signal, exactly like #2659's reindex
            // diff was — and the repair would be skipped forever. So: seed a
            // durable, idempotent `ReindexBlockLinks` obligation INSIDE the
            // same transaction that commits the `page_id` write. After that
            // commit the repair is owed no matter what happens next, and the
            // periodic sweeper drives it to completion.
            let mut tx =
                agaric_store::db::begin_immediate_logged(pool, "set_block_page_id_3842").await?;
            let write = cache::set_block_page_id_from_parent_in_tx(&mut tx, block_id).await?;
            // #3842 P1 → P2 GUARD (executable, not prose).
            //
            // The per-block reindex's stale-key sweep covers `{parent_id, own
            // id}`. That is sufficient ONLY while the key this block vacates is
            // NULL-derived: `set_block_page_id_from_parent_in_tx` writes the
            // PARENT's `page_id` onto a block whose own `page_id` was derived
            // moments earlier by `resolve_owning_page`. A `page_id` move
            // between two REAL pages (P1 → P2) would strand rows under P1,
            // which the sweep never visits — reintroducing #3842 silently.
            // Nothing in the type system pins that, so it is pinned here: loud,
            // and degraded to a durable full `RebuildPageLinkCache` obligation
            // rather than a silent strand. Cross-page MOVES do not reach this
            // arm (they fan out `FULL_CACHE_REBUILD_TASKS`, which already
            // contains `RebuildPageLinkCache`).
            //
            // #3894 — the guard tests BOTH ends, not just `previous`. Two
            // different transitions vacate a real page key:
            //
            //   * `Some(P1) → Some(P2)` — a page-to-page MOVE.
            //   * `Some(P) → NULL` — a DEMOTION, which #3894 found reachable:
            //     `resolve_owning_page` stamps `page_id` by walking the
            //     `parent_id` chain, whereas the write copies only
            //     `parent.page_id`, so a retried `SetBlockPageId` whose
            //     parent's own stamp is still pending — or whose parent was
            //     purged — inherited NULL off a block that already had a real
            //     page.
            //
            // #3908 CLOSED the demotion at the source instead of repairing it
            // downstream. `set_block_page_id_from_parent_in_tx` now REFUSES to
            // overwrite a non-NULL `page_id` with NULL: a NULL inherited value
            // means "the parent cannot tell me the owning page yet", not "this
            // block has no owning page", and only `rebuild_page_ids`'s
            // vault-wide re-derivation has the authority to decide the latter.
            // Seeding a `RebuildPageIds` obligation here would have repaired
            // the roll-up key eventually while leaving the block DETACHED from
            // its page in the meantime — wrong for
            // `pages_cache.inbound_link_count`, for the
            // `COALESCE(b.space_id, p.space_id)` space resolution, and for
            // every other `page_id` consumer, none of which the seeded
            // `RebuildPageLinkCache` touches.
            //
            // Consequence for the guard below: a refused demotion reports
            // `changed: false`, so inside `if vacated_page` the `P1 → P2` shape
            // is not a narrower case — it is the ONLY surviving way to vacate a
            // real page key on this path. An earlier draft carried a
            // `moved_between_pages` log field for it; that field was provably
            // the constant `true` at its only use site, so it distinguished
            // nothing and every reader filtering on it would have matched every
            // vacate event. `previous_page_id` and `current_page_id` already
            // carry the shape, so the field is gone rather than pinned.
            //
            // # #3909 — why this is a LOG and not a `debug_assert!`
            //
            // #3894 asserted `!moved_between_pages`, justified by the claim
            // that `dispatch.rs`'s create arm is the SOLE production enqueue
            // site, so `Some(P1) → Some(P2)` could only come from a future
            // second one. There has always been a second one: the retry
            // sweeper, via `RetryKind::SetBlockPageId.to_task()`
            // (`retry_queue.rs`). The premise is "the create arm PLUS the retry
            // sweeper's rehydration", and that changes the conclusion, because
            // the sweeper re-runs the task against state that has moved on:
            //
            //   1. a `SetBlockPageId` fails and seeds a retry row;
            //   2. the backoff is ≥ 1 minute;
            //   3. in that window the block's parent moves to another page;
            //   4. the retry fires and copies the parent's NEW `page_id` over
            //      the child's OLD one → `Some(P1) → Some(P2)`.
            //
            // #3919 closed the one such window we could actually demonstrate
            // (a move's in-tx `rederive_page_and_space_ids` skipped SOFT-
            // DELETED descendants, so a tombstoned child kept the pre-move page
            // while its parent moved on). But "we closed the window we found"
            // is not "no window exists": the shape is a DATA disagreement
            // between a parent and its child, not a programming error, and an
            // assert is the wrong instrument for one. Its cost is a panicking
            // background worker with a write transaction open — in exactly the
            // dev and test builds where a transient disagreement is most likely
            // to be manufactured — while the release build already degrades
            // correctly through the seeded full `RebuildPageLinkCache` below.
            // So: log it at ERROR with the same payload (that was the assert's
            // only job — make a developer notice) and let the durable
            // obligation do the repair. The enqueue-site set the #3908 guard
            // depends on is pinned executably instead, by
            // `set_block_page_id_is_enqueued_only_by_the_create_arm_3920` in
            // `dispatch.rs` — a test that fails the moment a move- or
            // delete-path enqueue is added, which is the change that would
            // genuinely invalidate the reasoning here.
            let vacated_page = write.changed && write.previous.is_some();
            let mut seeded_repair = false;
            let mut seeded_full_rebuild = false;
            if write.changed {
                seeded_repair = crate::materializer::retry_queue::seed_obligation_tx(
                    &mut tx,
                    &crate::materializer::retry_queue::RetryKind::ReindexBlockLinks,
                    block_id,
                    crate::materializer::retry_queue::SEED_PAGE_LINK_REPAIR_LAST_ERROR,
                )
                .await?;
                if vacated_page {
                    seeded_full_rebuild = crate::materializer::retry_queue::seed_obligation_tx(
                        &mut tx,
                        &crate::materializer::retry_queue::RetryKind::RebuildPageLinkCache,
                        crate::materializer::retry_queue::GLOBAL_TASK_SENTINEL,
                        crate::materializer::retry_queue::SEED_PAGE_LINK_FULL_REBUILD_LAST_ERROR,
                    )
                    .await?;
                    tracing::error!(
                        block_id = %block_id,
                        previous_page_id = ?write.previous,
                        current_page_id = ?write.current,
                        "#3842/#3909: SetBlockPageId moved page_id OFF a real page; the \
                         per-block stale-key sweep only covers {{parent_id, own id}} and \
                         cannot reach the vacated key, so a full RebuildPageLinkCache \
                         obligation was seeded instead. Since #3908 refuses the \
                         Some(P) → NULL demotion at the write itself, the shape reaching \
                         this branch is Some(P1) → Some(P2), reachable via the retry \
                         sweeper's re-enqueue after the parent has moved on (#3909) — it \
                         is logged, not asserted, because panicking a background worker \
                         mid-write-tx is a worse answer than the durable rebuild this \
                         already owes."
                    );
                }
            }
            tx.commit().await?;

            // Gauge accounting only AFTER a successful commit (a bump before
            // commit would over-count on rollback) — mirrors #2831.
            if let Some(m) = metrics {
                for _ in 0..usize::from(seeded_repair) + usize::from(seeded_full_rebuild) {
                    m.note_retry_row_inserted();
                }
            }

            // #533: space_id rides the same task — a fresh block inherits
            // its parent's space. Must run after page_id is set.
            cache::set_block_space_id_from_parent(pool, block_id).await?;

            if write.changed {
                // Happy path: run the repair inline and clear its obligation.
                // A failure is SWALLOWED and left to the sweeper, for #2831's
                // reason: returning `Err` here would seed a `SetBlockPageId`
                // retry row whose re-run is a guaranteed no-op (the `page_id`
                // write already committed, so the guard matches zero rows) —
                // pure churn. The durable `ReindexBlockLinks` obligation is
                // the recovery path, and swallowing keeps `SetBlockPageId`
                // idempotent, which is what `metrics.rs` classifies it as.
                match run_reindex_block_links(pool, read_pool, block_id, metrics).await {
                    Ok(()) => {
                        if let Err(e) = crate::materializer::retry_queue::clear_obligation(
                            pool,
                            &crate::materializer::retry_queue::RetryKind::ReindexBlockLinks,
                            block_id,
                            metrics,
                        )
                        .await
                        {
                            tracing::warn!(
                                block_id = %block_id,
                                error = %e,
                                "#3842: failed to clear the page_link_cache repair obligation \
                                 after an inline success; the sweeper will re-run the reindex \
                                 (idempotent) and re-clear"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            block_id = %block_id,
                            error = %e,
                            "#3842: inline page_link_cache repair failed after the page_id \
                             write; durable ReindexBlockLinks obligation left for the retry \
                             sweeper"
                        );
                    }
                }
            } else if let Err(e) = resolve_referrers_of(pool, read_pool, block_id, metrics).await {
                // #4118 — the `changed: false` arm, and why it is defence in
                // depth rather than a demonstrated hole.
                //
                // `write.changed` gates the block's OWN reindex, but the
                // linkability transition #4118 is about on this task is the
                // SPACE stamp, and `set_block_space_id_from_parent` above runs
                // UNCONDITIONALLY. So the arm's guard and the arm's linkability
                // effect are not the same condition, and the referrer repair
                // was attached to the guard.
                //
                // No production trace is claimed for the gap, and the honest
                // reason is that the cross-space filter's owning-page fallback
                // (`COALESCE(tgt.space_id, tp.space_id)`, #3894) keeps closing
                // it: a target that already carries the `page_id` this arm
                // would have written resolves its space THROUGH that page, so
                // it was never dropped and there is no unresolved row to
                // repair. Reaching this branch with a real NULL → stamped
                // transition needs a block whose `page_id` is unchanged AND
                // NULL-or-space-less while its PARENT already carries a space —
                // constructible (`space_id` is inherited from `parent_id`,
                // `page_id` from the parent's `page_id`, and those are two
                // different edges), but not observed.
                //
                // It is wired anyway, on the same standing as the
                // `seeded_full_rebuild` fallback above: the cost is one indexed
                // seek on an arm that is already the rare one, and the failure
                // mode it covers is the exact permanent loss this issue exists
                // to end. `set_block_page_id_space_stamp_relinks_referrers_
                // without_a_page_id_change_4118` pins it executably so it
                // cannot rot into dead code unnoticed.
                //
                // Only the REFERRER half is owed here: a source whose own space
                // is unstamped resolves `?3 IS NULL`, which passes every
                // target, so the source side records nothing to repair.
                //
                // Swallowed for the same reason the `changed` arm swallows:
                // failing `SetBlockPageId` would seed a retry whose re-run is a
                // no-op. Each referrer carries its own durable obligation.
                tracing::warn!(
                    block_id = %block_id,
                    error = %e,
                    "#4118: referrer re-link pass failed after an unchanged-page_id space \
                     stamp; each referrer's durable ReindexBlockLinks obligation is the \
                     recovery path"
                );
            }
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
