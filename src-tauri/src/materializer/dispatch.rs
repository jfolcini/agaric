//! Dispatch methods for routing ops to the appropriate materializer queues.

use super::coordinator::{INBOUND_REBUILD_DEBOUNCE, INBOUND_REBUILD_MAX_WAIT, Materializer};
use super::{CreateBlockHint, MaterializeTask, TagOpHint};
use crate::error::AppError;
use crate::op::OpType;
use crate::op_log::OpRecord;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// Shared shape of [`Materializer::fg_sender`] /
/// [`Materializer::bg_sender`].
///
/// The senders live in `OnceLock`s and are populated once during
/// construction. Reads are lock-free; the `shutdown_flag` short-circuit
/// preserves the prior `Channel("…queue closed")` error semantics so
/// callers (notably `try_enqueue_background`) keep behaving as before
/// The refactor.
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
/// ## Ordering semantics
///
/// Each arm is enqueued in this order via `try_enqueue_background`, then
/// the background queue's [`super::dedup::dedup_tasks`] pass collapses
/// duplicate rebuild tasks across the *entire* drained batch — not just
/// adjacent ones (the per-key sets are allocated once before the loop, so
/// the first occurrence of each key wins and later duplicates anywhere in
/// the drain are dropped; e.g. two `delete_block` mutations in the same
/// drain only run each rebuild once). Relative order is preserved. The
/// materializer then processes the deduped batch FIFO, so the order
/// observed at the handler is the order shown here.
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
/// order is in `cache::rebuild_all_caches` (test-only); that
/// function is the canonical reference for which rebuild reads which
/// upstream column/table. Keeping the array in this loose order keeps
/// the test assertions stable; the dedup + eventual consistency
/// combine to make the discrepancy invisible to users in practice.
pub(super) const FULL_CACHE_REBUILD_TASKS: [MaterializeTask; 9] = [
    MaterializeTask::RebuildTagsCache,
    MaterializeTask::RebuildPagesCache,
    // #2042: the page-wide `pages_cache.{inbound_link_count,child_block_count}`
    // recompute used to run SYNCHRONOUSLY in the foreground command / apply tx
    // (`recompute_pages_cache_counts_for_pages`), holding the single-writer
    // lock for the whole descendant walk on a large-subtree delete / restore /
    // purge. It now runs here on the background queue instead. It MUST come
    // AFTER `RebuildPagesCache` (which re-inserts the page ROWS); the count
    // UPDATE only touches existing `pages_cache` rows, so a restored page needs
    // its row back first. `dedup_tasks` preserves enqueue order (global tasks
    // dedup by discriminant, first occurrence kept), so this ordering holds.
    MaterializeTask::RebuildPagesCacheCounts,
    MaterializeTask::RebuildAgendaCache,
    MaterializeTask::RebuildProjectedAgendaCache,
    MaterializeTask::RebuildTagInheritanceCache,
    MaterializeTask::RebuildPageIds,
    // Inline `#[ULID]` references may disappear when a block
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

/// #2037 pt2: the lifecycle rebuild set for a CONTENT block delete /
/// restore / purge — [`FULL_CACHE_REBUILD_TASKS`] minus `RebuildPagesCache`.
///
/// `RebuildPagesCache` (`cache::rebuild_pages_cache`) only rebuilds
/// the page *rows* `(page_id, title)` from `block_type = 'page'` blocks and
/// deletes orphaned rows — the `inbound_link_count` / `child_block_count`
/// recompute was extracted out of it (#417) into the separate
/// `RebuildPagesCacheCounts` task. A CONTENT block's lifecycle (soft-delete /
/// restore / hard purge) cannot add, remove, or rename a `block_type = 'page'`
/// row, so the O(pages) row rebuild is pure waste for a content-block delete.
/// So `RebuildPagesCache` is the one rebuild we can safely drop — but a content
/// block's lifecycle DOES change its owning page's counts, so
/// `RebuildPagesCacheCounts` is RETAINED below (#2042: it took over the
/// page-cache count recompute that used to run synchronously in the foreground
/// `maintain_pages_cache_counts_after_op` / `recompute_pages_cache_counts_for_pages`).
///
/// `RebuildTagsCache` is DELIBERATELY KEPT (this is the correction for the
/// #2172 review): although the `tags_cache` *rows* are keyed by
/// `block_type = 'tag'` blocks, its `usage_count` column counts the DISTINCT
/// *live* blocks referencing each tag via `block_tags` / `block_tag_refs`
/// (`DESIRED_TAGS_SQL`, `cache/tags.rs`) — and those reference sources are
/// overwhelmingly CONTENT blocks (inline `#tag` / `#[ULID]`). Deleting /
/// restoring / purging a content block that carries tags therefore changes
/// those tags' `usage_count`, and ONLY `RebuildTagsCache` recomputes it
/// (`RebuildBlockTagRefsCache` rebuilds the refs *table*, not the count).
/// Dropping it would leave `usage_count` stale until an unrelated page/tag
/// op or an `add_tag`/`remove_tag` healed it, breaking eventual consistency.
///
/// Everything else in the full set is RETAINED, because a content block's
/// lifecycle DOES affect it:
///   * `RebuildTagsCache` — see the `usage_count` note above.
///   * `RebuildTagInheritanceCache` — the inheritance recursive CTE filters
///     `deleted_at IS NULL`, so soft-deleting / restoring a content block
///     changes which tags its descendants inherit.
///   * `RebuildAgendaCache` / `RebuildProjectedAgendaCache` — a content
///     block can carry `due`/`scheduled`/`repeat` and appear in either
///     agenda projection.
///   * `RebuildPageIds` — the block's `page_id` membership changes.
///   * `RebuildBlockTagRefsCache` — inline `#[ULID]` refs in the (sub)tree
///     disappear / reappear.
///   * `RebuildPageLinkCache` — the page-level link roll-up changes when a
///     subtree's `block_links` rows are cascaded away / restored.
///   * `RebuildPagesCacheCounts` (#2042) — a content block's delete / restore /
///     purge changes its owning page's `child_block_count` and (via its
///     subtree's `block_links`) other pages' `inbound_link_count`. This is the
///     background replacement for the former synchronous foreground recompute.
///
/// This narrowing is applied ONLY when the dispatch site can prove the
/// block is `"content"` (see `lifecycle_rebuild_tasks`). For `"page"` /
/// `"tag"` / an unknown / absent hint the full set is kept — correctness
/// over the perf win when the scope is uncertain (a page block's delete DOES
/// change `pages_cache`).
const CONTENT_LIFECYCLE_REBUILD_TASKS: [MaterializeTask; 8] = [
    MaterializeTask::RebuildTagsCache,
    // #2042: see the doc comment above — a content block's lifecycle changes
    // its owning page's counts, now recomputed on the background queue. Placed
    // right after `RebuildTagsCache` so this set stays exactly FULL minus
    // `RebuildPagesCache` with order preserved (the
    // `content_lifecycle_set_is_full_minus_pages_cache` invariant).
    MaterializeTask::RebuildPagesCacheCounts,
    MaterializeTask::RebuildAgendaCache,
    MaterializeTask::RebuildProjectedAgendaCache,
    MaterializeTask::RebuildTagInheritanceCache,
    MaterializeTask::RebuildPageIds,
    MaterializeTask::RebuildBlockTagRefsCache,
    MaterializeTask::RebuildPageLinkCache,
];

/// #2265: the derived-cache rebuild set for an INBOUND sync import —
/// [`FULL_CACHE_REBUILD_TASKS`] minus `RebuildTagInheritanceCache`.
///
/// `apply_remote` → `import_and_project` refreshes `block_tag_inherited`
/// synchronously, scoped to exactly the subtrees whose tag edges or tree
/// position changed (`TagScope`, #2036), and itself falls back to the global
/// `rebuild_all` when the import diff cannot be resolved incrementally. The
/// cache is therefore already correct by the time the inbound fan-out is
/// enqueued; re-running the full-vault DELETE + recursive-CTE recompute here
/// (deltas arrive at typing cadence) would turn every remote keystroke back
/// into an O(vault) writer-lock rebuild and defeat the scoping. Everything
/// else in the full set is RETAINED — the per-block projection touches only
/// base tables, so every derived cache (tag/page rows + counts, agenda,
/// `page_id` — which is how a moved subtree's descendants get their new
/// `page_id` — block-tag refs, page links) still needs its rebuild.
///
/// Exact-membership invariant pinned by
/// `inbound_sync_set_is_full_minus_tag_inheritance`.
const INBOUND_SYNC_CACHE_REBUILD_TASKS: [MaterializeTask; 8] = [
    MaterializeTask::RebuildTagsCache,
    MaterializeTask::RebuildPagesCache,
    // Must stay AFTER `RebuildPagesCache` (count UPDATE only touches
    // existing `pages_cache` rows) — same ordering note as the full set.
    MaterializeTask::RebuildPagesCacheCounts,
    MaterializeTask::RebuildAgendaCache,
    MaterializeTask::RebuildProjectedAgendaCache,
    MaterializeTask::RebuildPageIds,
    MaterializeTask::RebuildBlockTagRefsCache,
    MaterializeTask::RebuildPageLinkCache,
];

/// #2037 pt2: pick the lifecycle (delete / restore / purge) rebuild set
/// for a block of the given `block_type_hint`.
///
/// A hint of exactly `Some("content")` narrows to
/// [`CONTENT_LIFECYCLE_REBUILD_TASKS`] (drops the page-row `RebuildPagesCache`
/// rebuild only; `RebuildTagsCache` is kept for its content-aggregated
/// `usage_count`). Every other hint — `Some("page")`, `Some("tag")`,
/// `Some(<unknown>)`, or `None` — falls back to the full
/// [`FULL_CACHE_REBUILD_TASKS`], the correctness-preserving default.
fn lifecycle_rebuild_tasks(block_type_hint: Option<&str>) -> &'static [MaterializeTask] {
    match block_type_hint {
        Some("content") => &CONTENT_LIFECYCLE_REBUILD_TASKS,
        _ => &FULL_CACHE_REBUILD_TASKS,
    }
}

/// #2037: property keys that drive `agenda_cache` irrespective of value type.
/// `template` is the page-level agenda carve-out in `DESIRED_AGENDA_SQL`. The
/// RESERVED column-backed keys `due_date`/`scheduled_date` (stored in
/// `blocks.due_date`/`blocks.scheduled_date`, written via `SetProperty` —
/// `set_due_date_inner`/`set_scheduled_date_inner`) are read by Source 3/4 of
/// `DESIRED_AGENDA_SQL` (`WHERE b.due_date IS NOT NULL` / `b.scheduled_date IS
/// NOT NULL`), so clearing them (value_date=None) MUST still rebuild — they
/// cannot be caught by the payload's `value_date`. `due`/`scheduled` are the
/// non-reserved date-property aliases (date value caught via `value_date`, but
/// kept here so the value-cleared case is covered too). A date-VALUED property
/// of ANY key also drives it (a `property:<key>` source where `value_date IS NOT
/// NULL`); that is checked separately via the payload's `value_date`.
const AGENDA_PROPERTY_KEYS: [&str; 5] =
    ["template", "due", "scheduled", "due_date", "scheduled_date"];

/// #2037: property keys that drive `projected_agenda_cache` — the recurrence
/// keys (`cache/projected_agenda.rs` joins `key = 'repeat'` and reads
/// `repeat-until`/`repeat-count`/`repeat-seq`), the `due`/`scheduled` date
/// columns a repeating block projects from (reserved `due_date`/`scheduled_date`
/// → `blocks.due_date`/`scheduled_date`, read by `WHERE b.due_date IS NOT NULL
/// OR b.scheduled_date IS NOT NULL`), the reserved `todo_state` (the
/// `todo_state != 'DONE'` filter drops a repeating block from the projection
/// when it is completed), and the `template` carve-out.
const PROJECTED_AGENDA_PROPERTY_KEYS: [&str; 10] = [
    "repeat",
    "repeat-until",
    "repeat-count",
    "repeat-seq",
    "template",
    "due",
    "scheduled",
    "due_date",
    "scheduled_date",
    "todo_state",
];

/// #2037: minimal payload view for `set_property` / `delete_property` dispatch
/// narrowing. `delete_property` has no value fields, so `value_date` defaults to
/// `None` there.
#[derive(serde::Deserialize)]
struct PropertyOpHint {
    key: String,
    #[serde(default)]
    value_date: Option<String>,
}

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

    /// Dispatch the background fan-out for a `delete_block` / `restore_block`
    /// / `purge_block` op, threading the block's `block_type` so
    /// [`invalidations_for_op`] can narrow the rebuild set for a CONTENT
    /// block (#2037 pt2 — skip the page-row `RebuildPagesCache`).
    ///
    /// `block_type` is the block's type as read at the lifecycle site
    /// ("content" / "page" / "tag"). For "content" the fan-out drops the
    /// page-row `RebuildPagesCache` rebuild; for any other value the full set is kept
    /// (see [`lifecycle_rebuild_tasks`]). Shares the per-op-type dispatch
    /// table with the plain/edit variants — the FTS-optimize threshold is
    /// gated on `edit_block` so it never fires for these ops.
    pub fn dispatch_lifecycle_background(
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
    /// Production dispatch now reads
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
    /// Inbound sync import (#4).
    ///
    /// The loro-sync receiver (`sync_protocol::loro_sync::apply_remote`)
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
    /// mutation triggers ([`INBOUND_SYNC_CACHE_REBUILD_TASKS`], the lifecycle
    /// set minus the tag-inheritance rebuild — see below) plus targeted FTS
    /// reindexing.
    ///
    /// ## #2265 — no `RebuildTagInheritanceCache` in this fan-out
    ///
    /// `RebuildTagInheritanceCache` (a full-vault DELETE + recursive-CTE
    /// recompute under the `BEGIN IMMEDIATE` writer lock) is deliberately
    /// EXCLUDED ([`INBOUND_SYNC_CACHE_REBUILD_TASKS`]): `apply_remote` →
    /// `import_and_project` already refreshed `block_tag_inherited`
    /// synchronously before this fan-out runs, scoped to exactly the
    /// subtrees whose tag edges or tree position changed (`TagScope`,
    /// #2036) and falling back to the global `rebuild_all` itself when the
    /// import diff could not be resolved incrementally. Re-enqueueing the
    /// global rebuild here (deltas arrive at typing cadence) would defeat
    /// that scoping on every inbound message. Local delete / restore /
    /// purge lifecycle paths keep it via [`FULL_CACHE_REBUILD_TASKS`].
    ///
    /// ## #2264 — complete-no-op short-circuit
    ///
    /// A redelivered / echoed payload that changed nothing (`changed_blocks`
    /// AND `purged_blocks` both empty) projected nothing to SQL, so every
    /// cache is already consistent — return without enqueueing anything.
    /// A purge-only import (`changed_blocks` empty, `purged_blocks` not)
    /// MUST still fan out: Pass D removed rows from the base tables, and the
    /// aggregate caches (`tags_cache.usage_count`, `pages_cache` counts,
    /// page links, …) only converge through these rebuilds.
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
        purged_blocks: &[crate::ulid::BlockId],
    ) -> Result<(), AppError> {
        // #2264: nothing changed, nothing purged → nothing to rebuild.
        if changed_blocks.is_empty() && purged_blocks.is_empty() {
            return Ok(());
        }
        // #2291: instead of fanning out the 8 global full-vault rebuilds on
        // EVERY inbound drain (~8 O(vault) scans per import), ARM a trailing
        // debounce. The driver loop fires the identical
        // `INBOUND_SYNC_CACHE_REBUILD_TASKS` set exactly once after a burst
        // settles (bounded by max-wait). Each of those 8 tasks is
        // argument-less and reads current SQL state, so one fire covers
        // every coalesced import. The FTS path below is UNCHANGED — it is
        // already changed-set-driven (O(changed), not O(vault)).
        self.arm_inbound_rebuild_debounce();
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

    /// #2291: arm the inbound-sync cache-rebuild trailing debounce instead
    /// of fanning out the 8 global rebuilds inline.
    ///
    /// Records the request time (extending the trailing quiet-window) and,
    /// on the FIRST arm of an otherwise-idle burst, the burst start
    /// (anchoring the max-wait cap), then wakes the debounce loop. The loop
    /// fires [`INBOUND_SYNC_CACHE_REBUILD_TASKS`] exactly once after the
    /// burst settles (or `INBOUND_REBUILD_MAX_WAIT` elapses). The lock is
    /// held only for the three field writes — never across an `.await`.
    fn arm_inbound_rebuild_debounce(&self) {
        let now = Instant::now();
        {
            let mut st = self
                .inbound_rebuild_debounce
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            st.last_request = Some(now);
            st.seq = st.seq.wrapping_add(1);
            if !st.armed {
                st.armed = true;
                st.first_request = Some(now);
            }
        }
        // `notify_one` stores a permit if the loop is not currently parked
        // in `notified()`, so a wake is never lost against a racing loop
        // iteration.
        self.inbound_rebuild_debounce.notify.notify_one();
    }

    /// #2291: enqueue the 8 global inbound-sync cache rebuilds — the exact
    /// same set/order and `try_enqueue_background` path the pre-debounce
    /// inline fan-out used. Called once per settled burst by
    /// [`Self::inbound_rebuild_debounce_loop`].
    ///
    /// Runs from a spawned loop with no caller to propagate to, so an
    /// enqueue error (only reachable as a `Channel` closed at shutdown) is
    /// warned rather than returned; every task is argument-less and
    /// idempotent, so a missed fire self-heals on the next inbound sync or
    /// local edit.
    fn fire_inbound_rebuild_fanout(&self) {
        for task in INBOUND_SYNC_CACHE_REBUILD_TASKS {
            if let Err(e) = self.try_enqueue_background(task.clone()) {
                tracing::warn!(
                    error = %e,
                    "failed to enqueue inbound-sync cache rebuild (debounce fire)"
                );
            }
        }
    }

    /// #2291: trailing-debounce driver for the inbound-sync cache-rebuild
    /// fan-out. Spawned once from [`Self::build`]; runs until
    /// [`Self::shutdown_flag`] is set.
    ///
    /// Each iteration snapshots the armed instants under the state
    /// `std::sync::Mutex` (dropped BEFORE any `.await`), then either:
    ///   - parks on `notify` when idle (nothing armed);
    ///   - fires the 8 global rebuilds and disarms when the deadline has
    ///     passed; or
    ///   - sleeps until the deadline, racing a fresh arm (`notify`) so a
    ///     newer request recomputes the deadline on the next iteration.
    ///
    /// `fire_at = min(last_request + DEBOUNCE, first_request + MAX_WAIT)`:
    /// the trailing quiet-period, hard-capped by the max-wait measured from
    /// the burst start so a sustained sub-`DEBOUNCE` stream can never starve
    /// the fan-out.
    ///
    /// Time is [`tokio::time::Instant`] throughout (not `std::time`) so the
    /// whole debounce honours `tokio::time::pause()` / `advance()` under
    /// test; in production its `now()` is the same monotonic clock.
    ///
    /// Shutdown tradeoff: a rebuild still pending in the debounce window
    /// (≤ `DEBOUNCE + MAX_WAIT` ≈ 2.3s) when the process dies is DROPPED, not
    /// persisted. Production never calls `shutdown()` — it exits abruptly
    /// (see lib.rs's "abrupt exit is correct" philosophy + the Loro snapshot
    /// persist on `RunEvent::Exit`) — so this is really "process death in the
    /// window". The gap is pre-existing (tasks already in the bg channel are
    /// equally lost on abrupt exit); the debounce only WIDENS it from
    /// queue-drain-ms to ≤2.3s. It re-converges on the next inbound sync
    /// carrying a NON-EMPTY changeset, or the next local edit touching the
    /// cache. CAVEAT: an empty echo re-sync hits the #2264 short-circuit in
    /// `enqueue_inbound_sync_rebuilds` and does NOT re-arm, so a read-only
    /// device that only ever receives empty echoes would stay stale until a
    /// non-empty delta arrives. Accepted for a sub-2s deferred, idempotent
    /// full rebuild rather than paying retry-queue persistence.
    pub(super) async fn inbound_rebuild_debounce_loop(mat: Materializer) {
        let debounce = Arc::clone(&mat.inbound_rebuild_debounce);
        loop {
            if mat.shutdown_flag.load(Ordering::Acquire) {
                break;
            }
            // Snapshot the armed instants under the lock, then DROP it
            // before any `.await` (never hold the state Mutex across await).
            let snapshot = {
                let st = debounce
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if st.armed {
                    Some((
                        st.first_request
                            .expect("armed debounce always has a first_request"),
                        st.last_request
                            .expect("armed debounce always has a last_request"),
                        st.seq,
                    ))
                } else {
                    None
                }
            };
            let Some((first, last, snap_seq)) = snapshot else {
                // Idle: park until an arm wakes us.
                debounce.notify.notified().await;
                continue;
            };
            let fire_at = std::cmp::min(
                last + INBOUND_REBUILD_DEBOUNCE,
                first + INBOUND_REBUILD_MAX_WAIT,
            );
            if Instant::now() >= fire_at {
                mat.fire_inbound_rebuild_fanout();
                #[cfg(test)]
                debounce.fanout_fires.fetch_add(1, Ordering::Relaxed);
                // Disarm — but only if no newer arm landed between our
                // snapshot and now. Compare the monotonic `seq` (exact, and
                // robust to two arms sharing a timestamp — see `DebounceState`)
                // rather than the `last_request` `Instant`. If it advanced, a
                // request arrived after the snapshot: re-anchor a fresh window
                // at that newer request (so max-wait is measured from it, not
                // the just-fired burst) and loop so it still fires.
                let mut st = debounce
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if st.seq == snap_seq {
                    st.armed = false;
                    st.first_request = None;
                    st.last_request = None;
                } else {
                    st.first_request = st.last_request;
                }
            } else {
                // Wait out the remaining window; wake early on a fresh arm
                // so the next iteration recomputes `fire_at`.
                tokio::select! {
                    () = tokio::time::sleep_until(fire_at) => {}
                    () = debounce.notify.notified() => {}
                }
            }
        }
    }

    /// #2291 test-only: synchronously fire any pending inbound-sync rebuild
    /// fan-out and drain the background queue, so debounce-agnostic cache
    /// tests (which enqueue an inbound rebuild then assert the resulting
    /// global cache state) stay deterministic without waiting out the
    /// real-time trailing window. Disarms under the lock first, then fires
    /// the identical 8-task set; a redundant later loop-fire is harmless
    /// (idempotent + batch-deduped).
    #[cfg(test)]
    pub(super) async fn flush_inbound_rebuild_debounce(&self) {
        {
            let mut st = self
                .inbound_rebuild_debounce
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            st.armed = false;
            st.first_request = None;
            st.last_request = None;
        }
        self.fire_inbound_rebuild_fanout();
        // Surface a drain failure here (not as a confusing downstream
        // cache-count assertion) — this is a test-only helper.
        self.flush_background()
            .await
            .expect("flush_background in flush_inbound_rebuild_debounce");
    }

    /// Enqueue a foreground `ApplyOp` and the matching background fan-out
    /// for `record`, ensuring the bg tasks land **after** ApplyOp has
    /// drained.
    ///
    /// The fg and bg queues have independent consumers, so naively
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
    /// The per-op-type → required-task matrix lives in
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
/// Lifted out of the former imperative match in
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
            if hint.block_id.is_empty() {
                // Defensive fallback: no block_id in payload → full rebuild.
                tasks.push(MaterializeTask::RebuildPageIds);
            } else {
                let block_id: Arc<str> = Arc::from(hint.block_id.as_str());
                tasks.push(MaterializeTask::UpdateFtsBlock {
                    block_id: Arc::clone(&block_id),
                });
                // A freshly created block can already contain
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
            }
            // #2200 (Tier-2, same safe class as #2186): the whole-vault
            // `RebuildTagInheritanceCache` recompute is dropped from this arm.
            // Block creation already populates the new block's inherited tags
            // SYNCHRONOUSLY, in-transaction, via
            // `tag_inheritance::inherit_parent_tags` (called from both the
            // loro-apply and sql-only create handlers). A brand-new block has
            // no children, so nothing else needs re-inheriting and the
            // vault-wide rebuild was pure O(vault) waste.
            // #2037: a freshly created block carries no properties (those arrive
            // via later SetProperty ops), so it cannot yet have a `repeat`
            // property and therefore cannot be a row in `projected_agenda_cache`
            // (`cache/projected_agenda.rs` joins `key = 'repeat'`). The
            // SetProperty('repeat', …) that later makes it repeating enqueues the
            // projected rebuild itself, so enqueuing it here was pure O(vault)
            // waste on every block creation.
        }
        OpType::EditBlock => {
            // Use the cached `OpRecord::block_id` sidecar
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
                // Reindex inline tag refs regardless of
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
                    // #2658: `DESIRED_AGENDA_SQL`'s tag source projects agenda
                    // dates straight from tag CONTENT (`SUBSTR(t.content, 6)` for
                    // `date/YYYY-MM-DD` tags). Renaming a date-tag therefore
                    // changes which agenda rows should exist, so the tag-block
                    // edit must invalidate `agenda_cache`. Enqueued
                    // UNCONDITIONALLY (not narrowed to date-shaped from/to text):
                    // this arm reads only the cached `block_id` sidecar and never
                    // parses the edit's from/to content, tag renames are rare, and
                    // over-invalidation is a safe full rebuild while
                    // under-invalidation is the bug. Matches the unconditional
                    // `RebuildAgendaCache` in the no-hint fallback and the
                    // AddTag/RemoveTag arms.
                    tasks.push(MaterializeTask::RebuildAgendaCache);
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
            // Use the cached sidecar instead of re-parsing
            // `record.payload`.  Same rationale as the `edit_block`
            // arm above.
            //
            // #2037 pt2: narrow the rebuild fan-out for a CONTENT block —
            // its lifecycle cannot change a `block_type = 'page'` row, so
            // `lifecycle_rebuild_tasks` drops the page-row `RebuildPagesCache`
            // when the dispatch site proves `block_type_hint == Some("content")`.
            // `RebuildTagsCache` is KEPT (its `usage_count` aggregates
            // content-block tag refs — #2172). `Some("page")`/`Some("tag")`/
            // `None` keep the full set.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(lifecycle_rebuild_tasks(block_type_hint).iter().cloned());
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::RemoveFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
        }
        OpType::RestoreBlock => {
            // Cached sidecar — no JSON re-parse.
            // #2037 pt2: same content-block narrowing as `DeleteBlock`.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(lifecycle_rebuild_tasks(block_type_hint).iter().cloned());
            if !block_id.is_empty() {
                tasks.push(MaterializeTask::UpdateFtsBlock {
                    block_id: Arc::from(block_id),
                });
            }
        }
        OpType::PurgeBlock => {
            // Cached sidecar — no JSON re-parse.
            // #2037 pt2: same content-block narrowing as `DeleteBlock`.
            let block_id = record.block_id.as_deref().unwrap_or_default();
            tasks.extend(lifecycle_rebuild_tasks(block_type_hint).iter().cloned());
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
            // #2186: deliberately NO RebuildProjectedAgendaCache here. The
            // projected-agenda rebuild query (cache/projected_agenda.rs) reads
            // only block core columns + `block_properties` (repeat*/template)
            // and references no tag table, so a tag edge mutation
            // (`block_tags`) can never change the projected agenda. Enqueueing
            // it would be wasted work.
            tasks.push(MaterializeTask::RebuildTagInheritanceCache);
            // #1715: deliberately NO Update/RemoveFtsBlock here. A block's FTS
            // row indexes only the inline `#[ULID]` TAG_REF tokens present in its
            // content (see fts/strip.rs), which are added/removed by EditBlock and
            // reindexed on that op. AddTag/RemoveTag mutate a structural
            // `block_tags` edge, not the block's content, so the FTS row is
            // unchanged — enqueueing an FTS task would be wasted work.
        }
        OpType::SetProperty | OpType::DeleteProperty => {
            // Narrow invalidation by design: only the agenda caches depend on
            // property values. Property values live in
            // `block_properties.value_text` / `value_ref` and are never scanned
            // for link tokens, FTS text, or tag refs — that graph derives solely
            // from `blocks.content` — so no link/FTS/tag-ref rebuild is enqueued.
            //
            // #2037: narrow FURTHER by the property key/value so an ordinary
            // property edit (status, colour, text, ref…) enqueues neither agenda
            // rebuild. `agenda_cache` depends on date-VALUED properties + the
            // `template`/`due`/`scheduled` keys; `projected_agenda_cache` depends
            // on the recurrence keys + date columns + `template`. A
            // `delete_property` payload carries no value, so its date-ness is
            // unknown — keep its agenda rebuild (a deleted key may have held a
            // date) and narrow only its projected rebuild by key. A corrupt
            // payload falls back to both rebuilds.
            let is_set = matches!(op_type, OpType::SetProperty);
            match serde_json::from_str::<PropertyOpHint>(&record.payload) {
                Ok(hint) => {
                    let key = hint.key.as_str();
                    let has_date_value = hint.value_date.is_some();
                    let agenda_relevant = if is_set {
                        has_date_value || AGENDA_PROPERTY_KEYS.contains(&key)
                    } else {
                        // delete_property: value unknown ⇒ conservative.
                        true
                    };
                    let projected_relevant =
                        has_date_value || PROJECTED_AGENDA_PROPERTY_KEYS.contains(&key);
                    if agenda_relevant {
                        tasks.push(MaterializeTask::RebuildAgendaCache);
                    }
                    if projected_relevant {
                        tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        op_type = %record.op_type,
                        device_id = %record.device_id,
                        seq = record.seq,
                        error = %e,
                        "set/delete_property payload unparseable — enqueueing full agenda rebuilds"
                    );
                    tasks.push(MaterializeTask::RebuildAgendaCache);
                    tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
                }
            }
        }
        OpType::MoveBlock => {
            tasks.push(MaterializeTask::RebuildTagInheritanceCache);
            // #2200 (Tier-2, same safe class as #2186): the whole-vault
            // `RebuildPageIds` recompute is dropped from this arm. A move
            // already re-derives `page_id` AND `space_id` for the moved root
            // and its entire active subtree SYNCHRONOUSLY, in-transaction,
            // via `commands::block_cleanup::rederive_page_and_space_ids`
            // (called from `commands/blocks/move_ops.rs`, `history.rs`, and
            // the undo path). No block outside the moved subtree can change
            // `page_id` as a result of a move, so the vault-wide rebuild was
            // pure O(vault) waste. `RebuildPagesCache` is KEPT and still runs
            // after the in-tx rederive, observing the already-corrected
            // membership.
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
            // #2657: a move changes the block's `page_id`, and every arm of
            // `DESIRED_AGENDA_SQL` EXCLUDES blocks whose owning page carries a
            // `template` property. Moving a dated block INTO a template page
            // must drop its agenda rows, and moving one OUT must (re)add them —
            // so `agenda_cache` goes stale on a template-boundary move unless it
            // is rebuilt here. Enqueue it unconditionally, mirroring the sibling
            // `RebuildProjectedAgendaCache` push below (a move is exactly the
            // event that can flip the owning page's template status; a
            // correct-but-broader full rebuild is safer than a narrow
            // "did template status change?" check).
            tasks.push(MaterializeTask::RebuildAgendaCache);
            // #2196: a reparent can flip the moved subtree's owning page
            // between template and non-template. `projected_agenda_cache`
            // deliberately EXCLUDES repeating blocks whose `page_id` owns a
            // `template` property (`cache/projected_agenda.rs`, the
            // `NOT EXISTS(… key='template' …)` guard). Moving a repeating
            // block INTO a template page must drop its projections from the
            // cache, and moving one OUT must (re)add them — otherwise the
            // cache diverges from truth and only the read-path's mirror
            // `NOT EXISTS(template)` subquery keeps the visible result
            // correct. Enqueue the rebuild unconditionally on a structural
            // move (mirroring the sibling agenda arms): a move is exactly the
            // event that can change the owning page's template status, and a
            // correct-but-slightly-broader rebuild is safer than a narrow
            // "did template status change?" check.
            tasks.push(MaterializeTask::RebuildProjectedAgendaCache);
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
    //! pinning tests for the per-op-type cache invalidation
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
            ],
        );
        // #2200 sentinel: the whole-vault tag-inheritance rebuild is dropped —
        // `inherit_parent_tags` runs in-tx for the new (childless) block.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildTagInheritanceCache),
            "create_block must not enqueue the vault-wide RebuildTagInheritanceCache (#2200)",
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
                // #2658: a tag-block edit can rename a `date/YYYY-MM-DD` tag,
                // which `DESIRED_AGENDA_SQL` projects agenda dates from — so
                // `agenda_cache` must be rebuilt.
                "RebuildAgendaCache",
                "ReindexFtsReferences(E1)",
                "UpdateFtsBlock(E1)",
            ],
        );
    }

    /// #2658 focused sentinel: an `edit_block` with the `tag` hint MUST
    /// enqueue `RebuildAgendaCache` (a date-tag rename changes which agenda
    /// rows exist). Kept separate from the exact-order pin above so the
    /// intent survives future reordering of the tag sub-arm.
    #[test]
    fn invalidations_for_op_edit_block_tag_hint_rebuilds_agenda_cache_2658() {
        let r = make_record("edit_block", r#"{"block_id":"E1"}"#, Some("E1"));
        let tasks = invalidations_for_op(&r, Some("tag")).unwrap();
        assert!(
            contains_kind(&tasks, &MaterializeTask::RebuildAgendaCache),
            "edit_block(tag) must enqueue RebuildAgendaCache; got {:?}",
            labels(&tasks),
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

    // ── #2037 pt2: content-block lifecycle narrowing ────────────────

    fn content_rebuild_labels() -> Vec<String> {
        CONTENT_LIFECYCLE_REBUILD_TASKS
            .iter()
            .map(task_label)
            .collect()
    }

    /// #2037 pt2: a CONTENT-block delete drops the page-row
    /// `RebuildPagesCache` rebuild but RETAINS `RebuildTagsCache` (its
    /// `usage_count` counts content-block tag refs — #2172 review fix) and
    /// `RebuildTagInheritanceCache` (the inheritance CTE filters
    /// `deleted_at IS NULL`, so a content soft-delete DOES change descendant
    /// inheritance) and every other lifecycle rebuild. The exact set is
    /// pinned so a future edit cannot silently re-add or drop a task.
    #[test]
    fn invalidations_for_op_delete_content_block_skips_pages_cache() {
        let r = make_record("delete_block", r#"{"block_id":"D1"}"#, Some("D1"));
        let tasks = invalidations_for_op(&r, Some("content")).unwrap();
        let mut want = content_rebuild_labels();
        want.push("RemoveFtsBlock(D1)".into());
        assert_eq!(
            labels(&tasks),
            want,
            "content delete must emit the narrowed set + RemoveFtsBlock",
        );
        // Regression sentinel: the page-row O(pages) rebuild must NOT appear.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildPagesCache),
            "content delete must NOT enqueue RebuildPagesCache; got {:?}",
            labels(&tasks),
        );
        // ...but RebuildTagsCache MUST be retained — `usage_count` aggregates
        // content-block tag refs, so a content delete changes it (#2172).
        assert!(
            contains_kind(&tasks, &MaterializeTask::RebuildTagsCache),
            "content delete MUST retain RebuildTagsCache (usage_count); got {:?}",
            labels(&tasks),
        );
        // ...and the tag-inheritance rebuild MUST be retained.
        assert!(
            contains_kind(&tasks, &MaterializeTask::RebuildTagInheritanceCache),
            "content delete MUST retain RebuildTagInheritanceCache; got {:?}",
            labels(&tasks),
        );
    }

    /// #2037 pt2: restore + purge of a content block share the same
    /// narrowing (only the trailing FTS task differs — restore re-adds,
    /// delete/purge remove).
    #[test]
    fn invalidations_for_op_restore_content_block_skips_pages_cache() {
        let r = make_record("restore_block", r#"{"block_id":"R1"}"#, Some("R1"));
        let tasks = invalidations_for_op(&r, Some("content")).unwrap();
        let mut want = content_rebuild_labels();
        want.push("UpdateFtsBlock(R1)".into());
        assert_eq!(labels(&tasks), want);
        assert!(!contains_kind(&tasks, &MaterializeTask::RebuildPagesCache));
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildTagsCache));
        assert!(contains_kind(
            &tasks,
            &MaterializeTask::RebuildTagInheritanceCache
        ));
    }

    #[test]
    fn invalidations_for_op_purge_content_block_skips_pages_cache() {
        let r = make_record("purge_block", r#"{"block_id":"P1"}"#, Some("P1"));
        let tasks = invalidations_for_op(&r, Some("content")).unwrap();
        let mut want = content_rebuild_labels();
        want.push("RemoveFtsBlock(P1)".into());
        assert_eq!(labels(&tasks), want);
        assert!(!contains_kind(&tasks, &MaterializeTask::RebuildPagesCache));
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildTagsCache));
        assert!(contains_kind(
            &tasks,
            &MaterializeTask::RebuildTagInheritanceCache
        ));
    }

    /// #2037 pt2 correctness guard: a PAGE-block delete keeps the FULL set
    /// (its lifecycle DOES change `pages_cache`). Pins that the narrowing
    /// does not trigger for page blocks.
    #[test]
    fn invalidations_for_op_delete_page_block_keeps_full_cache_rebuild() {
        let r = make_record("delete_block", r#"{"block_id":"PG1"}"#, Some("PG1"));
        let tasks = invalidations_for_op(&r, Some("page")).unwrap();
        let mut want = full_rebuild_labels();
        want.push("RemoveFtsBlock(PG1)".into());
        assert_eq!(labels(&tasks), want, "page delete must keep the full set");
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildPagesCache));
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildTagsCache));
    }

    /// #2037 pt2 correctness guard: a TAG-block delete keeps the FULL set
    /// (its lifecycle DOES change `tags_cache`). The narrowing is gated on
    /// exactly `Some("content")`, so a tag hint falls through to the full
    /// default.
    #[test]
    fn invalidations_for_op_delete_tag_block_keeps_full_cache_rebuild() {
        let r = make_record("delete_block", r#"{"block_id":"TG1"}"#, Some("TG1"));
        let tasks = invalidations_for_op(&r, Some("tag")).unwrap();
        let mut want = full_rebuild_labels();
        want.push("RemoveFtsBlock(TG1)".into());
        assert_eq!(labels(&tasks), want, "tag delete must keep the full set");
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildTagsCache));
        assert!(contains_kind(&tasks, &MaterializeTask::RebuildPagesCache));
    }

    /// #2037 pt2: an absent hint (`None`) — the correctness-preserving
    /// default — keeps the full set for delete/restore/purge, matching the
    /// pre-#2037-pt2 behaviour. Pins that the narrowing never triggers
    /// without a positive `"content"` proof.
    #[test]
    fn invalidations_for_op_delete_unknown_hint_keeps_full_cache_rebuild() {
        let r = make_record("delete_block", r#"{"block_id":"U1"}"#, Some("U1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        let mut want = full_rebuild_labels();
        want.push("RemoveFtsBlock(U1)".into());
        assert_eq!(labels(&tasks), want);
        // Also a genuinely-unknown string hint stays full (defensive).
        let tasks_unknown = invalidations_for_op(&r, Some("widget")).unwrap();
        assert_eq!(labels(&tasks_unknown), want);
    }

    /// #2037 pt2 / #2172: lock the narrowed set's exact membership — it is
    /// the full set MINUS exactly `RebuildPagesCache` (the page-row rebuild),
    /// nothing else added or removed. `RebuildTagsCache` is RETAINED because
    /// its `usage_count` aggregates content-block tag refs (#2172 review).
    #[test]
    fn content_lifecycle_set_is_full_minus_pages_cache() {
        let full: Vec<String> = full_rebuild_labels();
        let narrowed: Vec<String> = content_rebuild_labels();
        let expected: Vec<String> = full
            .iter()
            .filter(|l| l.as_str() != "RebuildPagesCache")
            .cloned()
            .collect();
        assert_eq!(
            narrowed, expected,
            "CONTENT_LIFECYCLE_REBUILD_TASKS must be FULL minus only the \
             page-row RebuildPagesCache rebuild, preserving order",
        );
        assert!(
            narrowed.iter().any(|l| l == "RebuildTagsCache"),
            "RebuildTagsCache MUST be retained (usage_count aggregates content refs)",
        );
    }

    /// #2265 — the inbound-sync fan-out is FULL minus only
    /// `RebuildTagInheritanceCache` (already refreshed synchronously — and
    /// scoped — by `import_and_project`'s `TagScope` handling), preserving
    /// order. `RebuildPageIds` in particular MUST stay: it is how a moved
    /// subtree's descendants converge on their new `page_id` after an
    /// inbound structural move.
    #[test]
    fn inbound_sync_set_is_full_minus_tag_inheritance() {
        let full: Vec<String> = full_rebuild_labels();
        let narrowed: Vec<String> = INBOUND_SYNC_CACHE_REBUILD_TASKS
            .iter()
            .map(task_label)
            .collect();
        let expected: Vec<String> = full
            .iter()
            .filter(|l| l.as_str() != "RebuildTagInheritanceCache")
            .cloned()
            .collect();
        assert_eq!(
            narrowed, expected,
            "INBOUND_SYNC_CACHE_REBUILD_TASKS must be FULL minus only the \
             tag-inheritance rebuild, preserving order",
        );
        assert!(
            narrowed.iter().any(|l| l == "RebuildPageIds"),
            "RebuildPageIds MUST be retained (inbound move → descendants' page_id)",
        );
    }

    /// #417 / #2042 — the full-table `RebuildPagesCacheCounts` recompute is
    /// enqueued per-op ONLY by the cohort lifecycle ops (delete / restore /
    /// purge). #2042 moved their page-wide count recompute off the foreground
    /// tx onto the background queue, so those ops now enqueue it (for every
    /// block-type hint). The bounded single-block ops (create / edit / move)
    /// still maintain their counts SYNCHRONOUSLY in-tx and must NOT enqueue the
    /// O(pages) full-table pass — that is the #417 invariant this still pins.
    #[test]
    fn rebuild_pages_cache_counts_enqueued_only_for_cohort_lifecycle_ops() {
        let probe = MaterializeTask::RebuildPagesCacheCounts;

        // Single-block ops keep synchronous in-tx counts — NO full-table pass.
        let no_counts: &[(&str, &str, Option<&str>)] = &[
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
            ("move_block", r#"{"block_id":"X9"}"#, None),
        ];
        for (op_type, payload, hint) in no_counts {
            let r = make_record(op_type, payload, Some("XID"));
            let tasks = invalidations_for_op(&r, *hint).unwrap();
            assert!(
                !contains_kind(&tasks, &probe),
                "op `{op_type}` (hint {hint:?}) keeps synchronous per-op counts and must \
                 NOT enqueue the full-table RebuildPagesCacheCounts (#417); got {:?}",
                labels(&tasks),
            );
        }

        // #2042: cohort lifecycle ops defer the page-wide count recompute to the
        // background queue, so they DO enqueue it — for every block-type hint
        // (a content-block delete still changes its owning page's counts).
        let with_counts: &[(&str, Option<&str>)] = &[
            ("delete_block", None),
            ("delete_block", Some("content")),
            ("restore_block", None),
            ("restore_block", Some("content")),
            ("purge_block", None),
            ("purge_block", Some("content")),
        ];
        for (op_type, hint) in with_counts {
            let r = make_record(op_type, r#"{"block_id":"X6"}"#, Some("X6"));
            let tasks = invalidations_for_op(&r, *hint).unwrap();
            assert!(
                contains_kind(&tasks, &probe),
                "#2042: op `{op_type}` (hint {hint:?}) must enqueue the background \
                 RebuildPagesCacheCounts (deferred count recompute); got {:?}",
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
        // #2186 regression sentinel: a tag edge can never change the
        // projected agenda, so no projected rebuild may be enqueued.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildProjectedAgendaCache),
            "add_tag must not enqueue RebuildProjectedAgendaCache; got {:?}",
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
                "RebuildTagInheritanceCache",
            ],
        );
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildTagsCache),
            "remove_tag must not enqueue the full O(vault) RebuildTagsCache; got {:?}",
            labels(&tasks),
        );
        // #2186 regression sentinel: a tag edge can never change the
        // projected agenda, so no projected rebuild may be enqueued.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildProjectedAgendaCache),
            "remove_tag must not enqueue RebuildProjectedAgendaCache; got {:?}",
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

    /// #2037: an ordinary (non-date, non-agenda-key) `set_property` enqueues
    /// NEITHER agenda rebuild — the property cannot feed either agenda cache.
    #[test]
    fn invalidations_for_op_set_property_plain_key_skips_both_agenda_caches() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"status","value_text":"done"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(
            tasks.is_empty(),
            "a plain property set must enqueue no cache rebuilds, got {:?}",
            labels(&tasks),
        );
    }

    /// #2037: a `repeat` set drives ONLY the projected (repeating) agenda cache,
    /// not the flat agenda cache (which keys off date values, not `repeat`).
    #[test]
    fn invalidations_for_op_set_property_repeat_key_only_projected() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"repeat","value_text":"FREQ=DAILY"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(labels(&tasks), vec!["RebuildProjectedAgendaCache"]);
    }

    /// #2037: a date-VALUED property of any key drives BOTH agenda caches.
    #[test]
    fn invalidations_for_op_set_property_date_value_enqueues_both() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"reminder","value_date":"2026-01-01"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
        );
    }

    /// #2037: `delete_property` of a plain key keeps the agenda rebuild (the
    /// deleted value's date-ness is unknown) but skips the projected one (only
    /// recurrence/date-column keys feed it).
    #[test]
    fn invalidations_for_op_delete_property_plain_key_keeps_agenda_only() {
        let r = make_record(
            "delete_property",
            r#"{"block_id":"BLK1","key":"status"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(labels(&tasks), vec!["RebuildAgendaCache"]);
    }

    /// #2037: a corrupt property payload falls back to BOTH agenda rebuilds
    /// rather than silently skipping a needed one.
    #[test]
    fn invalidations_for_op_set_property_corrupt_payload_falls_back() {
        let r = make_record("set_property", r#"{"block_id":"BLK1"}"#, Some("BLK1"));
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
        );
    }

    /// #2037 regression (agaric-reviewer): the RESERVED column-backed key
    /// `due_date` (→ `blocks.due_date`, read by both agenda caches) must rebuild
    /// BOTH even when CLEARED (value_date=None), since its date-ness can't be
    /// inferred from the payload — it lives in a column, not `value_date`.
    #[test]
    fn invalidations_for_op_set_property_due_date_cleared_rebuilds_both() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"due_date","value_text":null,"value_date":null}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
            "clearing the reserved due_date column must refresh both agenda caches",
        );
    }

    /// #2037 regression: same for the reserved `scheduled_date` column key.
    #[test]
    fn invalidations_for_op_set_property_scheduled_date_cleared_rebuilds_both() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"scheduled_date","value_date":null}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(
            labels(&tasks),
            vec!["RebuildAgendaCache", "RebuildProjectedAgendaCache"],
        );
    }

    /// #2037 regression: `todo_state` (→ `blocks.todo_state`) feeds ONLY the
    /// projected cache's `todo_state != 'DONE'` filter — marking a repeating
    /// block DONE must drop it from `projected_agenda_cache`. It does NOT feed
    /// the flat agenda cache.
    #[test]
    fn invalidations_for_op_set_property_todo_state_rebuilds_projected_only() {
        let r = make_record(
            "set_property",
            r#"{"block_id":"BLK1","key":"todo_state","value_text":"DONE"}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert_eq!(labels(&tasks), vec!["RebuildProjectedAgendaCache"]);
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
        // #2200: a move re-derives `page_id`/`space_id` for the moved subtree
        // in-tx (`rederive_page_and_space_ids`), so the whole-vault
        // `RebuildPageIds` is dropped. The page-cache rebuild is KEPT and
        // observes the already-corrected membership. #627: the page-link
        // roll-up cache is keyed by source `page_id`, so a cross-page move
        // must rebuild it too or link attribution goes stale on both pages.
        assert_eq!(
            labels(&tasks),
            vec![
                "RebuildTagInheritanceCache",
                "RebuildPagesCache",
                "RebuildPageLinkCache",
                // #2657: a move changes `page_id`; `DESIRED_AGENDA_SQL` excludes
                // template-page blocks, so a move across the template boundary
                // must rebuild the (non-projected) agenda cache too.
                "RebuildAgendaCache",
                // #2196: a move can flip the owning page's template status,
                // so the projected-agenda cache must be rebuilt to stay
                // authoritative (it excludes template-page repeating blocks).
                "RebuildProjectedAgendaCache",
            ],
        );
        // #2200 sentinel: the whole-vault page-id rebuild is dropped — the
        // in-tx rederive already corrects the moved subtree's page_id/space_id.
        assert!(
            !contains_kind(&tasks, &MaterializeTask::RebuildPageIds),
            "move_block must not enqueue the vault-wide RebuildPageIds (#2200)",
        );
    }

    /// #2657 focused sentinel: `move_block` MUST enqueue `RebuildAgendaCache`
    /// — a cross-page move can move a dated block into or out of a `template`
    /// page, which every arm of `DESIRED_AGENDA_SQL` carves out.
    #[test]
    fn invalidations_for_op_move_block_rebuilds_agenda_cache_2657() {
        let r = make_record(
            "move_block",
            r#"{"block_id":"BLK1","new_position":0}"#,
            Some("BLK1"),
        );
        let tasks = invalidations_for_op(&r, None).unwrap();
        assert!(
            contains_kind(&tasks, &MaterializeTask::RebuildAgendaCache),
            "move_block must enqueue RebuildAgendaCache; got {:?}",
            labels(&tasks),
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
