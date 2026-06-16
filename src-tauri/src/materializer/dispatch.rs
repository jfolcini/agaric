//! Dispatch methods for routing ops to the appropriate materializer queues.

use super::coordinator::Materializer;
use super::{CreateBlockHint, MaterializeTask, TagOpHint};
use crate::error::AppError;
use crate::op::OpType;
use crate::op_log::OpRecord;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;

/// L-1: shared shape of [`Materializer::fg_sender`] /
/// [`Materializer::bg_sender`].
///
/// The senders live in `OnceLock`s and are populated once during
/// construction. Reads are lock-free; the `shutdown_flag` short-circuit
/// preserves the prior `Channel("…queue closed")` error semantics so
/// callers (notably `try_enqueue_background`) keep behaving as before
/// the L-1 refactor.
fn sender_or_closed(
    cell: &std::sync::OnceLock<mpsc::Sender<MaterializeTask>>,
    is_shutdown: bool,
    closed_msg: &'static str,
) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
    if is_shutdown {
        return Err(AppError::Channel(closed_msg.into()));
    }
    cell.get()
        .cloned()
        .ok_or_else(|| AppError::Channel(closed_msg.into()))
}

/// Fixed set of rebuild tasks enqueued after any `delete_block` /
/// `restore_block` / `purge_block` op, in their canonical order.
///
/// Exposed at module scope so tests can assert the exact sequence and so
/// `enqueue_full_cache_rebuild` has a single source of truth to iterate.
/// Adding a new block-referencing cache should only require appending to
/// this array — the three dispatch arms pick up the change automatically.
///
/// ## Ordering semantics (MAINT-148h)
///
/// Each arm is enqueued in this order via `try_enqueue_background`, then
/// the background queue's [`super::dedup::dedup_tasks`] pass collapses
/// adjacent duplicates (e.g. two `delete_block` mutations in the same
/// drain only run each rebuild once). The materializer then processes
/// the deduped batch FIFO, so the order observed at the handler is the
/// order shown here.
///
/// **The arms are *independent transactions*** — each rebuild owns its
/// own transaction, so a failure in arm `n` does not roll back arm
/// `n - 1`. They are not, however, *logically* independent: certain
/// rebuilds read columns or rows produced by others (e.g.
/// `RebuildAgendaCache` reads `blocks.page_id` populated by
/// `RebuildPageIds`; `RebuildTagsCache.usage_count` UNIONs
/// `block_tag_refs` populated by `RebuildBlockTagRefsCache`). Because
/// the materializer is intentionally eventually-consistent, running an
/// older snapshot of those inputs only delays convergence by one drain
/// — the next `delete_block` / `restore_block` / `purge_block` (or a
/// snapshot restore) re-enqueues the full set and the dependent reads
/// see the freshly-populated rows. The strictly dependency-correct
/// order is in [`crate::cache::rebuild_all_caches`] (test-only); that
/// function is the canonical reference for which rebuild reads which
/// upstream column/table. Keeping the array in this loose order keeps
/// the test assertions stable; the dedup + eventual consistency
/// combine to make the discrepancy invisible to users in practice.
pub(super) const FULL_CACHE_REBUILD_TASKS: [MaterializeTask; 8] = [
    MaterializeTask::RebuildTagsCache,
    MaterializeTask::RebuildPagesCache,
    MaterializeTask::RebuildAgendaCache,
    MaterializeTask::RebuildProjectedAgendaCache,
    MaterializeTask::RebuildTagInheritanceCache,
    MaterializeTask::RebuildPageIds,
    // UX-250: inline `#[ULID]` references may disappear when a block
    // (or a subtree containing referencing blocks) is deleted; the
    // full recompute picks that up on the same queue drain as the
    // other caches.
    MaterializeTask::RebuildBlockTagRefsCache,
    // SQL-review §H-2: the page-level link roll-up cache feeds
    // `list_page_links_inner`. Soft-delete / restore / purge cascades
    // can drop or re-introduce page edges (every block under the
    // deleted subtree had its `block_links` rows removed by the CASCADE
    // FK from migration 0061), so the per-page roll-up must run on the
    // same drain.
    MaterializeTask::RebuildPageLinkCache,
];

/// #421: inbound-sync FTS-reindex strategy threshold. When an inbound sync
/// message changes at most this many blocks, FTS is reindexed per-block via
/// `UpdateFtsBlock` (targeted, O(changed)); above it, a single chunked full
/// `RebuildFtsIndex` is enqueued instead (the snapshot/boot re-sync case,
/// which can change ~every block).
///
/// This is a **queue-safety** bound, not a measured perf crossover: each
/// `UpdateFtsBlock` is one task in the bounded background channel
/// ([`super::BACKGROUND_CAPACITY`] = 1024), and `enqueue_inbound_sync_rebuilds`
/// uses the non-blocking `try_enqueue_background` (drops on a full channel).
/// Capping the per-block fan-out at a quarter of the channel leaves headroom
/// for the `FULL_CACHE_REBUILD_TASKS` fan-out enqueued alongside and for
/// concurrent foreground/background work, so a large import falls back to the
/// single-task rebuild rather than risking saturation drops.
const SYNC_FTS_PER_BLOCK_MAX: usize = super::BACKGROUND_CAPACITY / 4;

/// #421: choose the FTS-reindex task(s) for an inbound-sync import that
/// changed `changed_blocks`. Pure (no queue/IO) so the strategy is unit
/// testable: empty set → no FTS work; small set → one targeted
/// `UpdateFtsBlock` per block; large set → a single full `RebuildFtsIndex`
/// (see [`SYNC_FTS_PER_BLOCK_MAX`] for why the large case falls back).
fn inbound_sync_fts_tasks(changed_blocks: &[crate::ulid::BlockId]) -> Vec<MaterializeTask> {
    if changed_blocks.is_empty() {
        Vec::new()
    } else if changed_blocks.len() > SYNC_FTS_PER_BLOCK_MAX {
        vec![MaterializeTask::RebuildFtsIndex]
    } else {
        changed_blocks
            .iter()
            .map(|block_id| MaterializeTask::UpdateFtsBlock {
                block_id: Arc::from(block_id.as_str()),
            })
            .collect()
    }
}

impl Materializer {
    pub(super) fn fg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        sender_or_closed(
            &self.fg_tx,
            self.shutdown_flag.load(Ordering::Acquire),
            "foreground queue closed",
        )
    }

    pub(super) fn bg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
        sender_or_closed(
            &self.bg_tx,
            self.shutdown_flag.load(Ordering::Acquire),
            "background queue closed",
        )
    }

    pub fn dispatch_background(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, None)
    }

    /// Dispatch background cache rebuild tasks for `record`, logging a `warn`
    /// on failure instead of propagating the error.
    ///
    /// Centralises the 17+ identical call sites across `commands/**` that all
    /// fire-and-forget background work after a successful op-log append. The
    /// convention is deliberate: background task enqueue failures (queue
    /// closed, serialization failure) should not unwind the command handler
    /// because the op itself has already been durably written to the op log.
    /// Callers that need propagation should use [`dispatch_background`]
    /// directly.
    pub fn dispatch_background_or_warn(&self, record: &OpRecord) {
        if let Err(e) = self.dispatch_background(record) {
            tracing::warn!(
                op_type = %record.op_type,
                seq = record.seq,
                device_id = %record.device_id,
                error = %e,
                "failed to dispatch background cache task"
            );
        }
    }

    pub fn dispatch_edit_background(
        &self,
        record: &OpRecord,
        block_type: &str,
    ) -> Result<(), AppError> {
        self.enqueue_background_tasks(record, Some(block_type))
    }

    /// Enqueue the full cache-rebuild fan-out that every block-structure
    /// mutation (`delete_block` / `restore_block` / `purge_block`) triggers.
    ///
    /// Any of these ops can invalidate every block-referencing cache
    /// simultaneously, so the three dispatch arms enqueue an identical set
    /// of rebuild tasks. Centralising the list here means adding a future
    /// cache only requires one edit, not three, and the materializer's
    /// dedup layer collapses duplicates across consecutive mutations.
    ///
    /// Order is fixed by [`FULL_CACHE_REBUILD_TASKS`] so tests can assert
    /// the exact sequence against `BackgroundQueue::inspect()` / metrics.
    ///
    /// PEND-28a M4: production dispatch now reads
    /// [`FULL_CACHE_REBUILD_TASKS`] directly from
    /// [`invalidations_for_op`] instead of round-tripping through this
    /// method, so the helper survives only as a test affordance for
    /// `enqueue_full_cache_rebuild_*` cases in `materializer::tests`.
    /// `#[cfg(test)]`-gated to keep release builds free of dead-code
    /// warnings.
    #[cfg(test)]
    pub(super) fn enqueue_full_cache_rebuild(&self) -> Result<(), AppError> {
        for task in FULL_CACHE_REBUILD_TASKS {
            self.try_enqueue_background(task.clone())?;
        }
        Ok(())
    }

    /// Enqueue the read-path derived-cache + FTS rebuild fan-out after an
    /// inbound sync import (PEND-81 §2A #4).
    ///
    /// The loro-sync receiver ([`crate::sync_protocol::loro_sync::apply_remote`])
    /// writes each changed block's per-block SQL projection — core columns,
    /// properties incl. the reserved hot-path columns, and direct tag edges —
    /// and synchronously rebuilds `block_tag_inherited`. But the read-path
    /// derived caches (`tags_cache`, `pages_cache`, `agenda_cache`,
    /// projected-agenda, `page_id`, `block_tag_refs`, the page-link roll-up)
    /// and the FTS index are NOT refreshed by that per-block projection, so a
    /// remote tag/property/content change would silently diverge in those
    /// caches until the next local mutation or snapshot restore. This enqueues
    /// a global rebuild of each via the background queue — eventually
    /// consistent + deduped — mirroring the fan-out a local block-structure
    /// mutation triggers ([`FULL_CACHE_REBUILD_TASKS`]) plus a full FTS
    /// reindex.
    ///
    /// `RebuildTagInheritanceCache` is part of [`FULL_CACHE_REBUILD_TASKS`]
    /// and is enqueued here even though `apply_remote` already rebuilt
    /// `block_tag_inherited` synchronously. That synchronous rebuild runs
    /// directly against the pool, so the queue's dedup pass does NOT collapse
    /// it (dedup only spans queue-side tasks within one drain) — `rebuild_all`
    /// simply runs once more. This is harmless: it is a fully idempotent
    /// DELETE-all + recursive-CTE recompute. Keeping the canonical
    /// [`FULL_CACHE_REBUILD_TASKS`] set whole (rather than hand-excluding the
    /// tag-inheritance task) means a future change to that set reaches the sync
    /// path automatically.
    ///
    /// Non-fatal by convention at the call site: a queue-closed / serialization
    /// error must not unwind the sync session (the per-block projection has
    /// already committed), so the orchestrator logs and continues.
    ///
    /// ## Queue-saturation safety (#483 M1)
    ///
    /// `RebuildFtsIndex` is the single task that can be produced by
    /// [`inbound_sync_fts_tasks`] for a large import (above
    /// [`SYNC_FTS_PER_BLOCK_MAX`]). It is NOT persistable via
    /// `RetryKind::from_task` (returns `None`), so the normal
    /// `try_enqueue_background` shed path would silently lose it on a full
    /// queue, leaving FTS permanently stale. For this task only we use the
    /// blocking `enqueue_background(..).await` which back-pressures the
    /// caller rather than dropping the task. Per-block `UpdateFtsBlock` tasks
    /// remain non-blocking (`try_enqueue_background`) — they can be shed
    /// because the consumer retry path handles them.
    pub async fn enqueue_inbound_sync_rebuilds(
        &self,
        changed_blocks: &[crate::ulid::BlockId],
    ) -> Result<(), AppError> {
        for task in FULL_CACHE_REBUILD_TASKS {
            self.try_enqueue_background(task.clone())?;
        }
        // FTS is not in `FULL_CACHE_REBUILD_TASKS` (local edits reindex
        // per-block via `UpdateFtsBlock`). #421: drive FTS from the exact
        // `changed_blocks` set `apply_remote` already computed, instead of
        // an unconditional full O(vault) `RebuildFtsIndex` on every inbound
        // sync message. For an ordinary incremental update (a handful of
        // changed blocks) this enqueues one `UpdateFtsBlock` per block —
        // the same targeted, delete-correct, queue-deduped path local edits
        // use — turning O(vault) into O(changed). A `RebuildFtsIndex` is
        // reserved for the large-import case (a snapshot/boot re-sync can
        // change ~every block): enqueueing one `UpdateFtsBlock` each would
        // risk saturating the bounded background queue (`BACKGROUND_CAPACITY`)
        // and dropping tasks, so above the threshold a single chunked full
        // rebuild is both safer and cheaper. The threshold is a queue-safety
        // bound (a fraction of the channel capacity leaving headroom for the
        // cache fan-out above and concurrent ops), NOT a measured perf
        // crossover. The selection itself is the pure, unit-tested
        // [`inbound_sync_fts_tasks`].
        for task in inbound_sync_fts_tasks(changed_blocks) {
            match task {
                MaterializeTask::RebuildFtsIndex => {
                    // #483 M1: cannot be shed — use blocking enqueue so it
                    // cannot be lost on a full queue.
                    self.enqueue_background(task).await?;
                }
                _ => {
                    self.try_enqueue_background(task)?;
                }
            }
        }
        Ok(())
    }

    /// Enqueue a foreground `ApplyOp` and the matching background fan-out
    /// for `record`, ensuring the bg tasks land **after** ApplyOp has
    /// drained.
    ///
    /// L-17: the fg and bg queues have independent consumers, so naively
    /// enqueueing bg right after fg let the bg consumer pull e.g.
    /// `RebuildTagsCache` and execute it against pre-`CreateBlock` state.
    /// Awaiting `flush_foreground` (which appends a Barrier and blocks
    /// until the consumer signals it) gates the bg enqueue on ApplyOp
    /// completion, so every bg task runs against fully-committed `blocks`
    /// rows. The extra round-trip is fine in practice because
    /// `dispatch_op` is only used by test code and one snapshot-transfer
    /// helper — production paths use `dispatch_background_or_warn` after
    /// the command handler has already committed the op itself.
    pub async fn dispatch_op(&self, record: &OpRecord) -> Result<(), AppError> {
        self.enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(record.clone())))
            .await?;
        self.flush_foreground().await?;
        self.enqueue_background_tasks(record, None)
    }

    /// Enqueue the background fan-out for `record`, then drive any
    /// metric-driven side effects (FTS optimize threshold) that aren't
    /// captured by the pure dispatch table.
    ///
    /// PEND-28a M4: the per-op-type → required-task matrix lives in
    /// [`invalidations_for_op`] as a focused, side-effect-free function
    /// returning `Vec<MaterializeTask>` so tests can pin "every op of
    /// kind X invalidates cache Y" without driving the full materializer.
    /// This dispatcher is a thin loop over that vec plus the
    /// metric-conditional FTS-optimize enqueue for `edit_block`.
    fn enqueue_background_tasks(
        &self,
        record: &OpRecord,
        block_type_hint: Option<&str>,
    ) -> Result<(), AppError> {
        for task in invalidations_for_op(record, block_type_hint)? {
            self.try_enqueue_background(task)?;
        }
        if record.op_type == "edit_block" {
            self.maybe_enqueue_fts_optimize()?;
        }
        Ok(())
    }

    /// Drive the FTS-optimize threshold counter and conditionally enqueue
    /// [`MaterializeTask::FtsOptimize`].
    ///
    /// Extracted from the former inline `edit_block` arm of
    /// [`Self::enqueue_background_tasks`] because it is the one piece of
    /// the per-op fan-out that mutates `&self` state (atomic counter,
    /// last-optimize timestamp, block-count cache refresh) rather than
    /// just enqueueing tasks. Keeping it here, side-by-side with its sole
    /// caller, preserves the original ordering guarantee that
    /// `FtsOptimize` lands after every other `edit_block` task.
    fn maybe_enqueue_fts_optimize(&self) -> Result<(), AppError> {
        let edits = self
            .metrics
            .fts_edits_since_optimize
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        // Millis since epoch fits in u64 for millions of years; saturate on overflow.
        let now_ms = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(u64::MAX);
        let last_ms = self.metrics.fts_last_optimize_ms.load(Ordering::Relaxed);
        let elapsed_ms = now_ms.saturating_sub(last_ms);
        let block_count = self.metrics.cached_block_count.load(Ordering::Relaxed);
        let threshold = std::cmp::max(500, block_count / 10_000);
        if (edits >= threshold || elapsed_ms >= 3_600_000)
            && self
                .metrics
                .fts_edits_since_optimize
                .compare_exchange(edits, 0, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
        {
            self.try_enqueue_background(MaterializeTask::FtsOptimize)?;
            self.metrics
                .fts_last_optimize_ms
                .store(now_ms, Ordering::Relaxed);
            self.refresh_block_count_cache();
        }
        Ok(())
    }
}

/// Pure mapping from an [`OpRecord`] (and optional `block_type_hint`
/// for `edit_block`) to the ordered list of background
/// [`MaterializeTask`]s that should be enqueued for it.
///
/// PEND-28a M4: lifted out of the former imperative match in
/// [`Materializer::enqueue_background_tasks`] so the per-op-type cache
/// invalidation matrix is auditable and testable as data. Adding a new
/// op type or changing which caches an existing op invalidates is a
/// single arm edit here, with a matching pinning test next to the
/// existing ones in `mod tests` below.
///
/// #1260: `record.op_type` is parsed once into the typed [`OpType`]
/// (via [`FromStr`], as `reverse::compute_reverse` and `apply_op_tx`
/// already do) and the dispatch matches the enum **exhaustively, with no
/// catch-all `_` arm**. This is the consumer the no-`#[non_exhaustive]`
/// invariant on [`OpType`] exists for (op.rs §27): adding a new op
/// variant now fails to compile here until its invalidations are
/// declared, rather than silently degrading to a runtime warning and
/// dropped cache invalidations. Ops that legitimately fan out nothing
/// (`add_attachment` / `delete_attachment` / `rename_attachment`) are
/// explicit empty arms.
///
/// The function is side-effect-free with two carve-outs: a string that
/// does **not** parse to any [`OpType`] (a corrupt/forward-version
/// `op_log` row, not a known variant) emits a `tracing::warn!` and
/// returns no tasks (preserving the prior unknown-op behaviour), and the
/// `create_block` arm propagates JSON parse failures via `?`. The
/// metric-driven FTS-optimize threshold for `edit_block` is **not**
/// captured here — it depends on `&Materializer` state and is driven
/// by [`Materializer::maybe_enqueue_fts_optimize`] after the returned
/// vec has been enqueued.
fn invalidations_for_op(
    record: &OpRecord,
    block_type_hint: Option<&str>,
) -> Result<Vec<MaterializeTask>, AppError> {
    let mut tasks: Vec<MaterializeTask> = Vec::new();
    // #1260: parse the raw `op_type` string once into the typed enum and
    // match exhaustively below. A string that does not correspond to any
    // known variant (corrupt or forward-version row) keeps the prior
    // warn-and-drop behaviour rather than aborting the dispatch loop.
    let Ok(op_type) = OpType::from_str(&record.op_type) else {
        tracing::warn!(
            op_type = %record.op_type,
            device_id = %record.device_id,
            seq = record.seq,
            "unknown op_type in dispatch_op"
        );
        return Ok(tasks);
    };
    match op_type {
        OpType::CreateBlock => {
            let hint: CreateBlockHint = serde_json::from_str(&record.payload)?;
            match hint.block_type.as_str() {
                "tag" => tasks.push(MaterializeTask::RebuildTagsCache),
                "page" => tasks.push(MaterializeTask::RebuildPagesCache),
                _ => {}
            }
            if !hint.block_id.is_empty() {
                let block_id: Arc<str> = Arc::from(hint.block_id.as_str());
                tasks.push(MaterializeTask::UpdateFtsBlock {
                    block_id: Arc::clone(&block_id),
                });
                // UX-250: a freshly created block can already contain
                // inline `#[ULID]` tag refs if the creator passed
                // non-empty content (imports, paste, programmatic
                // creates). Scan for them.
                tasks.push(MaterializeTask::ReindexBlockTagRefs {
                    block_id: Arc::clone(&block_id),
                });
                // Incremental page_id set for the new block (no descendants to walk).
                // Skipped for page blocks: their page_id = id invariant is enforced
                // by the page_id_self_for_pages CHECK constraint at INSERT time.
                // Falls through to the unconditional RebuildPageIds only if block_id
                // is empty (defensive).
                if hint.block_type != "page" {
                    tasks.push(MaterializeTask::SetBlockPageId { block_id });
                }
            } else {
                // Defensive fallback: no block_id in payload → full rebuild.
                tasks.push(MaterializeTask::RebuildPageIds);
            }
            tasks.push(MaterializeTask::RebuildTagInheritanceCache);
            tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
        }
        OpType::EditBlock => {
            // L-13: use the cached `OpRecord::block_id` sidecar
            // populated at append-time (or parsed once on the sync
            // ingress in `From<OpTransfer> for OpRecord`) so this
            // dispatch path no longer re-parses `record.payload`
            // for the same value.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            debug_assert!(
                !block_id.is_empty(),
                "edit_block payload has empty block_id"
            );
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::ReindexBlockLinks {
                    block_id: Arc::from(block_id),
                });
                // UX-250: reindex inline tag refs regardless of
                // `block_type_hint` — every content edit may gain or
                // lose `#[ULID]` tokens. Tag/page blocks typically
                // don't contain inline refs themselves but the cost
                // of scanning an empty diff is negligible vs. the
                // correctness risk of skipping.
                tasks.push(MaterializeTask::ReindexBlockTagRefs {
                    block_id: Arc::from(block_id),
                });
            }
            match block_type_hint {
                Some("tag") => {
                    tasks.push(MaterializeTask::RebuildTagsCache);
                    if !block_id.is_empty() {
                        tasks.push(MaterializeTask::ReindexFtsReferences {
                            block_id: Arc::from(block_id),
                        });
                    }
                }
                Some("page") => {
                    tasks.push(MaterializeTask::RebuildPagesCache);
                    if !block_id.is_empty() {
                        tasks.push(MaterializeTask::ReindexFtsReferences {
                            block_id: Arc::from(block_id),
                        });
                    }
                }
                Some("content") => {}
                _ => {
                    tasks.push(MaterializeTask::RebuildTagsCache);
                    tasks.push(MaterializeTask::RebuildPagesCache);
                    tasks.push(MaterializeTask::RebuildAgendaCache);
                }
            }
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::UpdateFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
            // FTS-optimize threshold (metric-driven) is enqueued
            // separately by `Materializer::maybe_enqueue_fts_optimize`
            // after the caller has drained this vec.
        }
        OpType::DeleteBlock => {
            // L-13: use the cached sidecar instead of re-parsing
            // `record.payload`.  Same rationale as the `edit_block`
            // arm above.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(FULL_CACHE_REBUILD_TASKS.iter().cloned());
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::RemoveFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
        }
        OpType::RestoreBlock => {
            // L-13: cached sidecar — no JSON re-parse.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(FULL_CACHE_REBUILD_TASKS.iter().cloned());
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::UpdateFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
        }
        OpType::PurgeBlock => {
            // L-13: cached sidecar — no JSON re-parse.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(FULL_CACHE_REBUILD_TASKS.iter().cloned());
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::RemoveFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
        }
        OpType::AddTag | OpType::RemoveTag => {
            // #676: `add_tag` / `remove_tag` mutate exactly one
            // `(block_id, tag_id)` edge, so the only `tags_cache` change
            // they can cause is the affected tag's `usage_count`. Replace
            // the former full O(vault) `RebuildTagsCache` (which streamed
            // every tag block + the whole `block_tags`/`block_tag_refs`
            // union to sort-merge-diff the entire cache, on every tag
            // click) with a scoped `RefreshTagUsageCount { tag_id }` that
            // recomputes just that one row — provably identical to the
            // full rebuild's effect for this op (the tag's name and the
            // set of cached tags are invariant under tag-edge mutations).
            //
            // The `tag_id` is read from the op payload. Both `add_tag` and
            // `remove_tag` carry `{ block_id, tag_id }` (op.rs
            // `AddTagPayload` / `RemoveTagPayload`). If the payload fails to
            // parse (corrupt row) we fall back to the full `RebuildTagsCache`
            // so the cache cannot silently go stale.
            match serde_json::from_str::<TagOpHint>(&record.payload) {
                Ok(hint) if !hint.tag_id.is_empty() => {
                    tasks.push(MaterializeTask::RefreshTagUsageCount {
                        tag_id: Arc::from(hint.tag_id.as_str()),
                    });
                }
                _ => {
                    tracing::warn!(
                        op_type = %record.op_type,
                        device_id = %record.device_id,
                        seq = record.seq,
                        "add_tag/remove_tag payload missing tag_id — falling back to full RebuildTagsCache"
                    );
                    tasks.push(MaterializeTask::RebuildTagsCache);
                }
            }
            tasks.push(MaterializeTask::RebuildAgendaCache);
            tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
            tasks.push(MaterializeTask::RebuildTagInheritanceCache);
        }
        OpType::SetProperty | OpType::DeleteProperty => {
            tasks.push(MaterializeTask::RebuildAgendaCache);
            tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
        }
        OpType::MoveBlock => {
            tasks.push(MaterializeTask::RebuildTagInheritanceCache);
            // E4: a cross-page move reparents the block's `page_id`
            // (`commands/blocks/move_ops.rs`). `RebuildPageIds` is the
            // canonical full recompute of that column; it MUST run before
            // `RebuildPagesCache` so the page-cache rebuild observes the
            // corrected membership. The per-op `pages_cache` count refresh
            // happens synchronously in `apply_op_tx`
            // (`maintain_pages_cache_counts_after_op`), but enqueue the page
            // cache rebuild too so the invalidation matrix is honest that a
            // move can touch `pages_cache` — the prior arm omitted it,
            // leaving page-cache state unwired for cross-page reparents.
            tasks.push(MaterializeTask::RebuildPageIds);
            tasks.push(MaterializeTask::RebuildPagesCache);
            // #627: a cross-page move reparents the block's `page_id`, which
            // is the source-page attribution `page_link_cache` rolls up by
            // (`COALESCE(page_id, …)`, `cache/page_links.rs`). Without this
            // rebuild, the OLD page's link rows stay over-counted and the
            // NEW page's rows stay missing until an unrelated
            // delete/restore/purge/sync triggers FULL_CACHE_REBUILD_TASKS.
            // A targeted `ReindexBlockLinks` is insufficient — it keys on the
            // block's *current* source page, so the old page's stale rows
            // would survive; the full page-link roll-up is the correct fix.
            tasks.push(MaterializeTask::RebuildPageLinkCache);
        }
        // #1260: attachment ops fan out no cache invalidations. These are
        // explicit empty arms (not a catch-all) so the no-`#[non_exhaustive]`
        // OpType invariant holds: a future variant must be handled here or
        // the build fails. `rename_attachment` previously fell into the
        // removed `other` catch-all — also a no-op, so behaviour is
        // unchanged; it is now an intentional empty arm rather than an
        // accidental silent drop.
        OpType::AddAttachment | OpType::DeleteAttachment | OpType::RenameAttachment => {}
    }
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    //! PEND-28a M4: pinning tests for the per-op-type cache invalidation
    //! matrix. Each test asserts the exact ordered list of background
    //! tasks that [`invalidations_for_op`] returns for a given op-type
    //! (and `block_type_hint`, where applicable). These are the
    //! regression-pinning sentinels for "every op that mutates X
    //! invalidates Y" claims that were previously only auditable by
    //! reading the imperative match arms.
    //!
    //! The metric-driven `FtsOptimize` enqueue in
    //! [`Materializer::maybe_enqueue_fts_optimize`] is intentionally
    //! out of scope here — these tests pin the structural matrix only.
    //! End-to-end coverage of the FtsOptimize threshold lives in
    //! `materializer::tests`.
    use super::*;
    use crate::op_log::OpRecord;
    use std::mem::discriminant;
    use std::sync::Arc;

    const TEST_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn make_record(op_type: &str, payload: &str, block_id: Option<&str>) -> OpRecord {
        OpRecord {
            device_id: "test-dispatch".into(),
            seq: 1,
            parent_seqs: None,
            hash: TEST_HASH.into(),
            op_type: op_type.into(),
            payload: payload.into(),
            created_at: 1_735_689_600_000,
            block_id: block_id.map(str::to_owned),
        }
    }

    /// Stable string label per [`MaterializeTask`] variant so test
    /// assertions can compare ordered task lists without requiring
    /// `MaterializeTask: PartialEq` (the type wraps `Arc<str>` /
    /// `Arc<Notify>` payloads where pointer-equality is the wrong
    /// comparison anyway).
    fn task_label(t: &MaterializeTask) -> String {
        match t {
            MaterializeTask::ApplyOp(_) => "ApplyOp".into(),
            MaterializeTask::BatchApplyOps(_) => "BatchApplyOps".into(),
            MaterializeTask::RebuildTagsCache => "RebuildTagsCache".into(),
            MaterializeTask::RefreshTagUsageCount { tag_id } => {
                format!("RefreshTagUsageCount({tag_id})")
            }
            MaterializeTask::RebuildPagesCache => "RebuildPagesCache".into(),
            MaterializeTask::RebuildPagesCacheCounts => "RebuildPagesCacheCounts".into(),
            MaterializeTask::RebuildAgendaCache => "RebuildAgendaCache".into(),
            MaterializeTask::ReindexBlockLinks { block_id } => {
                format!("ReindexBlockLinks({block_id})")
            }
            MaterializeTask::ReindexBlockTagRefs { block_id } => {
                format!("ReindexBlockTagRefs({block_id})")
            }
            MaterializeTask::UpdateFtsBlock { block_id } => format!("UpdateFtsBlock({block_id})"),
            MaterializeTask::ReindexFtsReferences { block_id } => {
                format!("ReindexFtsReferences({block_id})")
            }
            MaterializeTask::RemoveFtsBlock { block_id } => format!("RemoveFtsBlock({block_id})"),
            MaterializeTask::RebuildFtsIndex => "RebuildFtsIndex".into(),
            MaterializeTask::FtsOptimize => "FtsOptimize".into(),
            MaterializeTask::CleanupOrphanedAttachments => "CleanupOrphanedAttachments".into(),
            MaterializeTask::RebuildTagInheritanceCache => "RebuildTagInheritanceCache".into(),
            MaterializeTask::RebuildProjectedAgendaCache => "RebuildProjectedAgendaCache".into(),
            MaterializeTask::RebuildPageIds => "RebuildPageIds".into(),
            MaterializeTask::SetBlockPageId { block_id } => {
                format!("SetBlockPageId({block_id})")
            }
            MaterializeTask::RebuildBlockTagRefsCache => "RebuildBlockTagRefsCache".into(),
            MaterializeTask::RebuildPageLinkCache => "RebuildPageLinkCache".into(),
            MaterializeTask::Barrier(_) => "Barrier".into(),
        }
    }

    fn labels(tasks: &[MaterializeTask]) -> Vec<String> {
        tasks.iter().map(task_label).collect()
    }

    fn contains_kind(tasks: &[MaterializeTask], probe: &MaterializeTask) -> bool {
        let want = discriminant(probe);
        tasks.iter().any(|t| discriminant(t) == want)
    }

    // ── #421 inbound-sync FTS strategy ───────────────────────────────

    /// An empty changed set (no-op import) enqueues NO FTS work — the old
    /// path always ran a full O(vault) `RebuildFtsIndex` here.
    #[test]
    fn inbound_sync_fts_tasks_empty_is_noop() {
        assert!(inbound_sync_fts_tasks(&[]).is_empty());
    }

    /// A small incremental import reindexes per-block via `UpdateFtsBlock`
    /// (one per changed block, carrying the right id) — NOT a full rebuild.
    #[test]
    fn inbound_sync_fts_tasks_small_set_is_per_block() {
        let changed = [
            crate::ulid::BlockId::test_id("B1"),
            crate::ulid::BlockId::test_id("B2"),
        ];
        let tasks = inbound_sync_fts_tasks(&changed);
        assert_eq!(
            labels(&tasks),
            vec![
                "UpdateFtsBlock(B1)".to_string(),
                "UpdateFtsBlock(B2)".to_string()
            ],
            "small set must reindex per-block, not full-rebuild",
        );
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildFtsIndex),
            "small set must NOT enqueue a full RebuildFtsIndex",
        );
    }

    /// At the threshold the per-block path still applies (boundary is `>`).
    #[test]
    fn inbound_sync_fts_tasks_at_threshold_is_per_block() {
        let changed: Vec<_> = (0..SYNC_FTS_PER_BLOCK_MAX)
            .map(|i| crate::ulid::BlockId::test_id(&format!("B{i}")))
            .collect();
        let tasks = inbound_sync_fts_tasks(&changed);
        assert_eq!(tasks.len(), SYNC_FTS_PER_BLOCK_MAX);
        assert!(
            tasks
                .iter()
                .all(|t| matches!(t, MaterializeTask::UpdateFtsBlock { .. }))
        );
    }

    /// Above the threshold (snapshot/boot re-sync) a SINGLE full
    /// `RebuildFtsIndex` is enqueued instead of N per-block tasks, so the
    /// bounded background queue cannot be saturated by the FTS fan-out.
    #[test]
    fn inbound_sync_fts_tasks_large_set_is_single_full_rebuild() {
        let changed: Vec<_> = (0..=SYNC_FTS_PER_BLOCK_MAX)
            .map(|i| crate::ulid::BlockId::test_id(&format!("B{i}")))
            .collect();
        let tasks = inbound_sync_fts_tasks(&changed);
        assert_eq!(
            labels(&tasks),
            vec!["RebuildFtsIndex".to_string()],
            "above threshold must collapse to one full rebuild",
        );
    }

    // ── create_block ─────────────────────────────────────────────────

    #[test]
    fn invalidations_for_op_create_block_with_tag_hint_includes_tags_cache() {
        let payload = r#"{"block_id":"BLK1","block_type":"tag"}"#;
        let r = make_record("create_block", payload, Some("BLK1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "RebuildTagsCache",
                "UpdateFtsBlock(BLK1)",
                "ReindexBlockTagRefs(BLK1)",
                "SetBlockPageId(BLK1)",
                "RebuildTagInheritanceCache",
                "RebuildProjectedAgendaCache",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_create_block_with_page_hint_includes_pages_cache() {
        let payload = r#"{"block_id":"PG1","block_type":"page"}"#;
        let r = make_record("create_block", payload, Some("PG1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        // Page blocks don't get SetBlockPageId: page_id = id is enforced
        // by the page_id_self_for_pages CHECK constraint at INSERT time.
        assert_eq!(
            labels(&tasks),
            vec![
                "RebuildPagesCache",
                "UpdateFtsBlock(PG1)",
                "ReindexBlockTagRefs(PG1)",
                "RebuildTagInheritanceCache",
                "RebuildProjectedAgendaCache",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_create_block_with_content_hint_skips_typed_caches() {
        let payload = r#"{"block_id":"C1","block_type":"content"}"#;
        let r = make_record("create_block", payload, Some("C1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        // No RebuildTagsCache / RebuildPagesCache for content blocks.
        assert_eq!(
            labels(&tasks),
            vec![
                "UpdateFtsBlock(C1)",
                "ReindexBlockTagRefs(C1)",
                "SetBlockPageId(C1)",
                "RebuildTagInheritanceCache",
                "RebuildProjectedAgendaCache",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_create_block_propagates_serde_error() {
        let r = make_record("create_block", "not-json", None);
        let err = invalidations_for_op(&r, None).unwrap_err();
        // Preserves the prior `?` propagation — exact variant comes
        // from `From<serde_json::Error> for AppError`; we only need
        // to confirm the error is surfaced, not swallowed.
        let msg = format!("{err}");
        assert!(!msg.is_empty(), "error must surface a non-empty message");
    }

    // ── edit_block (one test per `block_type_hint` branch) ──────────

    #[test]
    fn invalidations_for_op_edit_block_with_tag_hint_includes_tags_cache() {
        let r = make_record("edit_block", r#"{"block_id":"E1"}"#, Some("E1"));
        let tasks = invalidations_for_op(&r, Some("tag")).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "ReindexBlockLinks(E1)",
                "ReindexBlockTagRefs(E1)",
                "RebuildTagsCache",
                "ReindexFtsReferences(E1)",
                "UpdateFtsBlock(E1)",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_edit_block_with_page_hint_includes_pages_cache() {
        let r = make_record("edit_block", r#"{"block_id":"E2"}"#, Some("E2"));
        let tasks = invalidations_for_op(&r, Some("page")).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "ReindexBlockLinks(E2)",
                "ReindexBlockTagRefs(E2)",
                "RebuildPagesCache",
                "ReindexFtsReferences(E2)",
                "UpdateFtsBlock(E2)",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_edit_block_with_content_hint_skips_global_caches() {
        let r = make_record("edit_block", r#"{"block_id":"E3"}"#, Some("E3"));
        let tasks = invalidations_for_op(&r, Some("content")).unwrap();
        // Content edits never invalidate the tags/pages/agenda caches —
        // this is the perf carve-out the hint exists for.
        assert_eq!(
            labels(&tasks),
            vec![
                "ReindexBlockLinks(E3)",
                "ReindexBlockTagRefs(E3)",
                "UpdateFtsBlock(E3)",
            ],
        );
    }

    #[test]
    fn invalidations_for_op_edit_block_without_hint_falls_back_to_full_fan_out() {
        let r = make_record("edit_block", r#"{"block_id":"E4"}"#, Some("E4"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "ReindexBlockLinks(E4)",
                "ReindexBlockTagRefs(E4)",
                "RebuildTagsCache",
                "RebuildPagesCache",
                "RebuildAgendaCache",
                "UpdateFtsBlock(E4)",
            ],
        );
    }

    // ── delete / restore / purge (full cache rebuild) ───────────────

    fn full_rebuild_labels() -> Vec<String> {
        FULL_CACHE_REBUILD_TASKS.iter().map(task_label).collect()
    }

    #[test]
    fn invalidations_for_op_delete_block_includes_full_cache_rebuild() {
        let r = make_record("delete_block", r#"{"block_id":"D1"}"#, Some("D1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        let mut want = full_rebuild_labels();
        want.push("RemoveFtsBlock(D1)".into());
        assert_eq!(labels(&tasks), want);
    }

    #[test]
    fn invalidations_for_op_restore_block_includes_full_cache_rebuild() {
        let r = make_record("restore_block", r#"{"block_id":"R1"}"#, Some("R1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        let mut want = full_rebuild_labels();
        // Restore re-adds to FTS rather than removing.
        want.push("UpdateFtsBlock(R1)".into());
        assert_eq!(labels(&tasks), want);
    }

    #[test]
    fn invalidations_for_op_purge_block_includes_full_cache_rebuild() {
        let r = make_record("purge_block", r#"{"block_id":"P1"}"#, Some("P1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        let mut want = full_rebuild_labels();
        want.push("RemoveFtsBlock(P1)".into());
        assert_eq!(labels(&tasks), want);
    }

    /// #417 — the full-table `RebuildPagesCacheCounts` recompute is a
    /// RESET-only repair (enqueued by `apply_snapshot`). NO per-op
    /// invalidation fan-out — for ANY op type, with or without a block-type
    /// hint — may enqueue it; per-op count maintenance happens in-tx on the
    /// sync `ApplyOp` and local command paths. This pins the gate: a future
    /// edit that re-adds the full-table pass to a per-op trigger (the exact
    /// O(pages) regression #417 removed) fails here.
    #[test]
    fn no_per_op_invalidation_enqueues_rebuild_pages_cache_counts() {
        let probe = MaterializeTask::RebuildPagesCacheCounts;
        let cases: &[(&str, &str, Option<&str>)] = &[
            (
                "create_block",
                r#"{"block_id":"X1","block_type":"page"}"#,
                None,
            ),
            (
                "create_block",
                r#"{"block_id":"X2","block_type":"content"}"#,
                None,
            ),
            ("edit_block", r#"{"block_id":"X3"}"#, Some("page")),
            ("edit_block", r#"{"block_id":"X4"}"#, Some("content")),
            ("edit_block", r#"{"block_id":"X5"}"#, None),
            ("delete_block", r#"{"block_id":"X6"}"#, None),
            ("restore_block", r#"{"block_id":"X7"}"#, None),
            ("purge_block", r#"{"block_id":"X8"}"#, None),
            ("move_block", r#"{"block_id":"X9"}"#, None),
        ];
        for (op_type, payload, hint) in cases {
            let r = make_record(op_type, payload, Some("XID"));
            let tasks = invalidations_for_op(&r, *hint).unwrap();
            assert!(
                !contains_kind(&tasks, &probe),
                "op `{op_type}` (hint {hint:?}) must NOT enqueue RebuildPagesCacheCounts \
                 — it is a RESET-only task (#417); got {:?}",
                labels(&tasks),
            );
        }
    }

    // ── tag mutations ────────────────────────────────────────────────

    /// #676: `add_tag` enqueues a SCOPED `RefreshTagUsageCount(tag_id)`
    /// instead of the former full O(vault) `RebuildTagsCache`. The agenda
    /// family + inheritance rebuild are unchanged.
    #[test]
    fn invalidations_for_op_add_tag_uses_scoped_tag_refresh() {
        let r = make_record(
            "add_tag",
            r#"{"block_id":"BLK1","tag_id":"TAG1"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "RefreshTagUsageCount(TAG1)",
                "RebuildAgendaCache",
                "RebuildProjectedAgendaCache",
                "RebuildTagInheritanceCache",
            ],
        );
        // #676 regression sentinel: the full O(vault) rebuild MUST NOT be
        // enqueued for a well-formed tag op.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildTagsCache),
            "add_tag must not enqueue the full O(vault) RebuildTagsCache; got {:?}",
            labels(&tasks),
        );
    }

    /// #676: `remove_tag` shares the arm — same scoped refresh of the
    /// affected tag, no full rebuild.
    #[test]
    fn invalidations_for_op_remove_tag_uses_scoped_tag_refresh() {
        let r = make_record(
            "remove_tag",
            r#"{"block_id":"BLK1","tag_id":"TAG1"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "RefreshTagUsageCount(TAG1)",
                "RebuildAgendaCache",
                "RebuildProjectedAgendaCache",
                "RebuildTagInheritanceCache",
            ],
        );
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildTagsCache),
            "remove_tag must not enqueue the full O(vault) RebuildTagsCache; got {:?}",
            labels(&tasks),
        );
    }

    /// #676: a corrupt tag-op payload (no parseable `tag_id`) falls back to
    /// the full `RebuildTagsCache` rather than silently skipping the tags
    /// cache — correctness over the perf win when the scope is unknown.
    #[test]
    fn invalidations_for_op_add_tag_missing_tag_id_falls_back_to_full_rebuild() {
        let r = make_record("add_tag", r#"{"block_id":"BLK1"}"#, Some("BLK1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec![
                "RebuildTagsCache",
                "RebuildAgendaCache",
                "RebuildProjectedAgendaCache",
                "RebuildTagInheritanceCache",
            ],
        );
        assert!(
            !contains_kind(
                &tasks,
                &MaterializeTask::RefreshTagUsageCount {
                    tag_id: Arc::from("x")
                }
            ),
            "missing tag_id must NOT enqueue a scoped (empty-id) refresh; got {:?}",
            labels(&tasks),
        );
    }

    // ── property mutations ───────────────────────────────────────────

    #[test]
    fn invalidations_for_op_set_property_includes_agenda_caches() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"due"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
        );
    }

    #[test]
    fn invalidations_for_op_delete_property_matches_set_property() {
        let r = make_record(
            "delete_property",
            r#"{"block_id":"BLK1","key":"due"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
        );
    }

    // ── move_block ───────────────────────────────────────────────────

    #[test]
    fn invalidations_for_op_move_block_includes_inheritance_page_ids_and_pages_cache() {
        let r = make_record(
            "move_block",
            r#"{"block_id":"BLK1","new_position":0}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        // E4: a cross-page move reparents `page_id`, so the page-id rebuild
        // and the page-cache rebuild are both enqueued — `RebuildPageIds`
        // strictly before `RebuildPagesCache` so the latter observes the
        // corrected membership. #627: the page-link roll-up cache is keyed
        // by source `page_id`, so a cross-page move must rebuild it too or
        // link attribution goes stale on both the old and new pages.
        assert_eq!(
            labels(&tasks),
            vec![
                "RebuildTagInheritanceCache",
                "RebuildPageIds",
                "RebuildPagesCache",
                "RebuildPageLinkCache",
            ],
        );
    }

    // ── attachments (no fan-out) ─────────────────────────────────────

    #[test]
    fn invalidations_for_op_add_attachment_returns_empty() {
        let r = make_record(
            "add_attachment",
            r#"{"attachment_id":"ATT1","block_id":"BLK1"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(tasks.is_empty(), "add_attachment must not enqueue tasks");
    }

    #[test]
    fn invalidations_for_op_delete_attachment_returns_empty() {
        let r = make_record("delete_attachment", r#"{"attachment_id":"ATT1"}"#, None);
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(tasks.is_empty(), "delete_attachment must not enqueue tasks");
    }

    /// #1260: `rename_attachment` previously fell into the removed `other`
    /// catch-all (an accidental no-op); it is now an explicit empty arm in
    /// the exhaustive `OpType` match. This pins that the fan-out stays empty
    /// — the behaviour is unchanged, only the safety is.
    #[test]
    fn invalidations_for_op_rename_attachment_returns_empty() {
        let r = make_record(
            "rename_attachment",
            r#"{"attachment_id":"ATT1","new_name":"x.png"}"#,
            None,
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(tasks.is_empty(), "rename_attachment must not enqueue tasks");
    }

    // ── unknown / unparseable op (warn-only) ─────────────────────────

    /// #1260: a string that does not parse to any [`OpType`] (corrupt or
    /// forward-version `op_log` row) keeps the prior warn-and-drop
    /// behaviour — it is NOT a compile-time concern, since it is not a
    /// known variant. The exhaustive enum match below it guards the
    /// *known* variants; this guards the parse boundary.
    #[test]
    fn invalidations_for_op_unknown_op_returns_empty() {
        let r = make_record("future_unknown_op", "{}", None);
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(tasks.is_empty(), "unknown op_type must not enqueue tasks");
    }

    /// #1260: assert every known [`OpType`] variant routes through
    /// `invalidations_for_op` without panicking and that the typed-string
    /// round-trip the dispatch relies on is intact. The compile-time
    /// exhaustiveness of the enum match is the primary guarantee (a new
    /// variant breaks the build at the `match op_type` above); this is a
    /// runtime belt-and-braces that the `OpType::as_str` ↔ `FromStr`
    /// mapping every arm depends on stays round-trippable.
    #[test]
    fn invalidations_for_op_covers_every_op_type() {
        use std::str::FromStr;
        // Exhaustively enumerated by hand — kept in lockstep with the
        // `OpType` enum. The `let OpType::… = probe` destructure below is a
        // compile-time tripwire: a new variant makes this `match` non-
        // exhaustive and fails the build, flagging that this list (and the
        // dispatch arm) need updating.
        let all = [
            OpType::CreateBlock,
            OpType::EditBlock,
            OpType::DeleteBlock,
            OpType::RestoreBlock,
            OpType::PurgeBlock,
            OpType::MoveBlock,
            OpType::AddTag,
            OpType::RemoveTag,
            OpType::SetProperty,
            OpType::DeleteProperty,
            OpType::AddAttachment,
            OpType::DeleteAttachment,
            OpType::RenameAttachment,
        ];
        for probe in &all {
            // Round-trip guard: the dispatch parses the stored string back
            // to this exact variant.
            assert_eq!(
                OpType::from_str(probe.as_str()).unwrap(),
                *probe,
                "OpType::as_str ↔ FromStr must round-trip for {probe:?}",
            );
            // A payload that satisfies the one arm (`create_block`) that
            // parses its JSON; harmless for every other arm.
            let payload = r#"{"block_id":"COV1","block_type":"content"}"#;
            let r = make_record(probe.as_str(), payload, Some("COV1"));
            // Must not panic / must return Ok for every known variant.
            let _ = invalidations_for_op(&r, None).unwrap();
        }
    }

    // ── Arc reuse pin: create_block reuses one Arc<str> for the
    //    UpdateFtsBlock + ReindexBlockTagRefs pair (preserves the
    //    refcount-bump optimisation from the imperative original). ───

    #[test]
    fn invalidations_for_op_create_block_shares_block_id_arc() {
        let payload = r#"{"block_id":"BLKSHARE","block_type":"content"}"#;
        let r = make_record("create_block", payload, Some("BLKSHARE"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        let fts_arc = tasks.iter().find_map(|t| match t {
            MaterializeTask::UpdateFtsBlock { block_id } => Some(Arc::clone(block_id)),
            _ => None,
        });
        let tag_ref_arc = tasks.iter().find_map(|t| match t {
            MaterializeTask::ReindexBlockTagRefs { block_id } => Some(Arc::clone(block_id)),
            _ => None,
        });
        let (fts_arc, tag_ref_arc) = (fts_arc.unwrap(), tag_ref_arc.unwrap());
        assert!(
            Arc::ptr_eq(&fts_arc, &tag_ref_arc),
            "create_block must reuse a single Arc<str> for the FTS + tag-ref tasks",
        );
    }
}
