# PEND-35 — Tauri command audit: where the frontend is doing work the database/backend should do

> **Status (session 693):** ALL 27 ITEMS SHIPPED. Tier 1 (6/6) + Tier 2 (12/12) + Tier 3 (4/4) + Tier 4 (5/5). Audit closed. This file may be deleted in a future session-log cleanup once any followups are confirmed clean.

## Origin

Full audit run 2026-05-08 over all 97 `#[tauri::command]` handlers in
`src-tauri/src/commands/` and their FE callsites under `src/`. Triggered by
the user noting that an earlier bug had the FE fetching ALL pages just to
find one — exactly the shape this audit looked for: FE filtering /
sorting / `find()`-ing over arrays that SQL could narrow, FE looping
single-row commands when batch endpoints exist or could exist, missing
indexes, and SQL that bypasses indexes via `json_extract`.

**Round 1 — Discovery**: 6 parallel subagents covering disjoint command
groups (no overlap):

1. Agenda / Tasks / Journal — `list_projected_agenda`,
   `count_agenda_batch{,_by_source}`, `list_undated_tasks`,
   `list_unfinished_tasks`, `get_journal_page_by_date`,
   `list_journal_page_dates`
2. Pages / Spaces / Aliases / Page-history — `pages.rs`, `spaces.rs`,
   `history.rs` page ops
3. Blocks CRUD + batch + per-block field setters — `blocks/`, plus the
   `set_todo_state`/`set_priority`/`set_due_date`/`set_scheduled_date`
   setters
4. Tags + Properties — `tags.rs`, `properties.rs`, property defs
5. Queries / Backlinks / History / Diff — `queries.rs`, backlink
   filtering/grouping, `get_block_history`, `compute_*_diff`,
   `get_conflicts`
6. Drafts / Attachments / Link metadata — `drafts.rs`,
   `attachments.rs`, `link_metadata.rs`

**Round 2 — Validation**: 3 parallel subagents that re-read every cited
`file:line` against the actual source. Verdict format: TRUE / PARTIALLY
TRUE / FALSE / CAN'T VERIFY. Tally:

- **Correctness/security claims**: 7 / 7 TRUE
- **Index / SQL pushdown claims**: 12 / 12 TRUE
- **N+1 / batch-loop claims**: 13 / 15 TRUE + 2 PARTIALLY TRUE (loops
  are real but the cited "all"-variant siblings can't accept id-lists,
  so the recommendation type sharpens from "USE existing" to "CREATE
  batch-by-ids variant" — the symptom is unchanged)

No claims rejected as hallucinations. The two PARTIALLY TRUE verdicts
are bookkeeping refinements, not invalidations.

**Out of scope (confirmed clean by audit)**: Agenda/Tasks/Journal
commands (recently fixed under PEND-31 + commit `ef53eefc` +
migrations 0025/0047); backlink read commands (`get_backlinks`,
`query_backlinks_filtered`, `list_backlinks_grouped`,
`list_unlinked_references` — all push filter/sort/scope into SQL); FTS
search (`fts/search.rs`); drafts CRUD; attachment delete; link
metadata (PK lookup on URL).

## TL;DR

Across the full command surface, **27 actionable findings** survived
validation; **Tier 1 (6 items) shipped in session 687** and **Tier 3
(4 items) shipped in session 688**, leaving 17 open. Grouped by tier:

| Tier | Count | Theme |
| --- | --- | --- |
| ~~**1 — Correctness / security**~~ | ~~6~~ ✅ | ~~Cross-space data leaks, missing space property on import, paging silently broken under FE-side filters~~ — **shipped session 687** |
| ~~**2 — Hot-path performance (N+1, FE intersection)**~~ | ~~12~~ ✅ | All 12 items shipped across sessions 689 (2.5/2.6/2.11/2.12), 690 (2.7/2.8/2.9/2.10a), 691 (2.1/2.2), 692 (2.3/2.4), 693 (2.10b). The final 2.10b adds `filtered_blocks_query` — a single SQL-side AND-intersection via EXISTS subqueries, replacing the JS intersection that silently capped results past the top-200 of any sub-query. |
| ~~**3 — Indexes & SQL anti-patterns**~~ | ~~4~~ ✅ | ~~`json_extract` bypassing native column, missing partial index, BINARY index can't satisfy NOCASE LIKE, missing block_type pushdown~~ — **shipped session 688** |
| **4 — Minor / low-confidence** | 5 | Single-row reloads, template-loop creates, growing-window history fetches |

Estimated cost is per-item, not bundled.

---

## ~~Tier 1 — Correctness / security~~ — shipped session 687

All six items landed in one batch (one PR-equivalent commit):

- **1.1** `import_markdown` now requires `space_id: String`, validates it, and appends `SetProperty("space", value_ref=…)` inside the same transaction. FE plumbs `currentSpaceId`; Settings → Data Import button is disabled with a visible+screen-reader-announced hint when no space is bootstrapped.
- **1.2** `resolve_page_by_alias` takes `SpaceScope`. SearchPanel + PageBrowser pass `currentSpaceId`. (BlockRow widening deferred — opportunistic follow-up.)
- **1.3** `get_block_history` / `list_block_history` accept `op_type_filter: Option<String>`. HistoryPanel's FE post-filter dropped.
- **1.4** `get_conflicts` / `list_conflicts` accept `conflict_type: Option<String>` and `id_min: Option<String>` (ULID lower bound = date filter). ConflictList's type / 7-day FE filters now SQL-side; device-name filter stays FE-side.
- **1.5** `query_by_property` accepts `exclude_parent_id: Option<String>` and `content_non_empty: bool`. DonePanel's `filterDoneBlocks` post-filter retired. Whitespace handling uses `TRIM(content, x'20090a0d')` to match the JS `String.prototype.trim()` set the FE used.
- **1.6** `count_backlinks_batch` accepts `SpaceScope`. `useBatchCounts` passes `currentSpaceId`.

---

## Tier 2 — Hot-path performance (N+1 and batch loops)

### ~~2.1 Multi-select task ops loop one IPC + one IMMEDIATE tx per block~~ — shipped session 691

`set_todo_state_batch(block_ids, state)` and `delete_blocks_by_ids(block_ids)` added. Single `BEGIN IMMEDIATE` tx + single op_log scope per batch. The `delete_blocks_by_ids` recursive CTE is seeded from ALL roots via `json_each(?)` with `is_conflict = 0` filter + `depth < 100` bound (inv #9). The MAINT-173 ancestor-pre-walk in `useBlockMultiSelect.ts` is gone — backend coalesces ancestors and descendants in one walk. IPC delta: 50-block delete went from 50 IPCs → 1 IPC.

### ~~2.2 TrashView batch restore/purge loops~~ — shipped session 691

`restore_blocks_by_ids(ids)` and `purge_blocks_by_ids(ids)` added. Single `BEGIN IMMEDIATE` tx covers all. The ~13-table purge cleanup chain runs ONCE per batch via `WHERE id IN (SELECT id FROM descendants)` (16 queries total — verified by review). Single-row `restore_block` / `purge_block` and the "all" variants stay registered for non-batch callers. IPC delta: 50-block purge went from 50 IPCs → 1 IPC.

### ~~2.3 ConflictList: 2N IPCs + N+1 + N+1 in three separate places~~ — shipped session 692

Three new Tauri commands added: `get_blocks(ids) -> Vec<BlockRow>` (full-row batch including deleted/conflict rows for ConflictTypeRenderer), `first_op_device_for_blocks(block_ids) -> HashMap<String, String>` (uses native `op_log.block_id` + MIN(seq) correlated subquery), `resolve_conflicts_batch(actions)` (one BEGIN IMMEDIATE tx, all-or-nothing rollback, mirrors the per-action semantics of `edit_block_inner` for keep / `delete_block_inner` for discard). ConflictList.tsx's three N+1 patterns each collapsed to ONE batch IPC. IPC delta: 50 conflicts went from ~150 IPCs → 3 IPCs.

### ~~2.4 Property fan-out per visible row~~ — shipped session 692

- **2.4a:** New `BatchPropertiesProvider` (modeled on `BatchAttachmentsProvider`) hoisted in `AgendaResults` over `allBlockIds`. `DependencyIndicator` reads via `useBatchProperties()?.get(blockId)` with fallback to per-block `getProperties()` when no provider. The provider has an `invalidationKey` prop tying into `useBlockPropertyEvents`'s monotonic counter + active space id — so stale data is cleared without extra parent-side cache-clear effects.
- **2.4b:** `SpaceManageDialog` calls `getBatchProperties(allSpaceIds)` once instead of `Promise.all(spaces.map(getProperties))`.
- **2.4c:** New `get_property(block_id, key)` PK SELECT command. Five callsites migrated from full-vocabulary fetch + JS `find()` to the dedicated single-key IPC: `template-utils.ts:loadJournalTemplateForSpace` (`journal_template`), `StaticBlock.tsx` image-resize (`image_width`), `useBlockProperties.ts:warnIfBlocked`, `useBlockSlashCommands.ts:warnIfBlocked`, `useCheckboxSyntax.ts` DONE-path (all 3 read `blocked_by`).

IPC delta: 50 agenda rows went from 50 IPCs → 1 IPC; N spaces × `journal_template` from N IPCs → 1 IPC; the 5 single-key callsites each dropped from a full vocabulary fetch to a 1-row PK SELECT.

### ~~2.5 `searchPropertyKeys` bypasses the existing cache~~ — shipped session 689

The cache logic was extracted from `usePropertyKeysCache` into a non-React module-level helper at `src/lib/property-keys-cache.ts`; the hook is now a thin React adapter. `searchPropertyKeys` calls `getPropertyKeys()` once across multiple keystrokes (load-bearing test pins this).

### ~~2.6 `list_property_defs` consumers fetch the whole vocabulary to read one key~~ — shipped session 689

`get_property_def(key) -> Option<PropertyDefinition>` (single PK SELECT) added. `useAppBootRecovery` (priority lookup) and `usePropertyDefForEdit` migrated. The full-vocabulary `list_property_defs` stays for legitimate consumers (PropertyDefinitionsList, PagePropertyTable, BlockPropertyDrawer, QueryBuilderModal).

### ~~2.7 Attachments: redundant batch + per-block re-fetch when batch is in scope~~ — shipped session 690

The `get_batch_attachment_counts` Tauri command + its `BatchAttachmentCountsProvider` were deleted entirely; counts derive O(1) from the list batch via a new `getCount(blockId)` method on `BatchAttachmentsValue`. `useBlockAttachments` short-circuits to the provider when present (NO `list_attachments` IPC fires under a mounted batch provider — regression test pins this).

### ~~2.8 Template loading: client-side block_type filter + per-template preview fetch~~ — shipped session 690

`template-utils.ts` passes `blockType: 'page'` through `queryByProperty` (Tier 3.4 enabled this); JS-side filter dropped. New `first_child_for_blocks(block_ids) -> HashMap<String, BlockRow>` command (window-function CTE, `(position ASC, id ASC)` ordering, excludes deleted/conflict) collapses the per-template `listBlocks({limit:1})` N+1 to one IPC.

### ~~2.9 GraphView post-filters tag results client-side~~ — shipped session 690

`queryByTags(...)` now passes `blockType: 'page'`. The `pagesResp.items.filter(p => p.block_type === 'page')` post-filter is gone.

### Tier 2.10 Agenda/Query AND-intersection done in JS with silent row-cap

| What | Detail |
| --- | --- |
| ~~2.10a~~ ✅ session 690 | ~~Per-value / per-day fan-out.~~ `agenda-filters.queryStatus`/`queryPriority` collapsed to `valueTextIn` (single IPC); `queryPropertyDateDimension` collapsed to half-open `valueDateRange` (1 IPC instead of N for "Last 7 days" / "Last 30 days" etc.). |
| 2.10b | **JS AND-intersection with silent cap.** `useQueryExecution.fetchFilteredQuery` AND-intersects sub-results in JS with `FILTERED_QUERY_MAX_ROWS=50` and `FILTERED_SUBQUERY_LIMIT=200` — any AND-set member outside the top-200 of any sub-query is silently dropped. `src/hooks/useQueryExecution.ts:13-16, 111-174`. |
| **Recommendation (b)** | **CREATE** `filtered_blocks_query(property_filters, tag_filters, scope, page) -> PageResponse<BlockRow>` that builds the AND in SQL via `EXISTS` subqueries. The existing `BacklinkFilter::And` resolver in `src-tauri/src/backlink/filters.rs` is a working template. |
| **Validator verdict** | N13, N14 TRUE, I5 TRUE |

### ~~2.11 `getConflicts({limit:100})` polled every 30s for a badge count~~ — shipped session 689

`count_conflicts(scope) -> i64` added; uses the `idx_blocks_conflict` partial index from Tier 3.2 (EXPLAIN test pins the planner choice). `useItemCount` now accepts both `Promise<{items}>` (legacy trash badge) and `Promise<number>` (count IPC) shapes; counts >100 regression test added.

### ~~2.12 Boot recovery loops `flush_draft` per orphan~~ — shipped session 689

`flush_all_drafts() -> {flushed: i64}` added: single `BEGIN IMMEDIATE` tx covers every draft with all-or-nothing rollback (deliberate change from per-draft semantics; documented in the doc comment). The per-block `flush_draft` command is preserved for blur/window-focus-loss callers.

---

## ~~Tier 3 — Indexes & SQL anti-patterns~~ — shipped session 688

All four items landed in one batch:

- **3.1** Four `json_extract(ol.payload, '$.block_id')` sites (in `pagination/history.rs` and `commands/history.rs`) rewritten to read the native `ol.block_id` column added by migration 0030. Migration 0048 retires the now-redundant expression index `idx_op_log_payload_block_id` from migration 0003.
- **3.2** Migration 0049 adds partial index `idx_blocks_conflict ON blocks(id) WHERE is_conflict = 1 AND deleted_at IS NULL` to support the `list_conflicts` query path. EXPLAIN-QUERY-PLAN test pins the planner choice.
- **3.3** Migration 0050 adds `idx_tags_cache_name_nocase ON tags_cache(name COLLATE NOCASE)` so the high-volume case-insensitive LIKE-prefix query in every tag picker is index-served.
- **3.4** `query_by_property` and `query_by_tags`/`eval_tag_query` accept `block_type: Option<String>`. `query_by_property` additionally accepts `value_text_in: Vec<String>` (JSON-each binding) and `value_date_range: Option<(String, String)>` (half-open `[from, to)`). The `query_by_property` Tauri command bundles the new + Tier 1.5 filters into an `ExtraQueryFilters` struct (mirror of `AgendaQuery` precedent) to stay under specta's 10-arg ceiling — flat FE wrapper API preserved.

These signature expansions enable Tier 2.8 / 2.9 / 2.10 callsite cleanups without further backend changes.

---

## ~~Tier 4 — Minor / low-confidence~~ — all shipped

- ~~**4.1**~~ session 693: `page-blocks.ts moveUp/moveDown` splice locally using `move_block` response (cross-parent move keeps full-reload fallback for safety).
- ~~**4.2**~~ session 693: `PageEditor` empty-page first-block uses new `pageStore.appendBlock(row)` setter instead of full page reload.
- ~~**4.3**~~ session 693: New `create_blocks_batch(specs: Vec<CreateBlockSpec>) -> Vec<BlockRow>` command. `template-utils.ts` collapses N IPCs → 1 (single-level template) or D IPCs (D = subtree depth) for nested templates.
- ~~**4.4**~~ session 693: New `find_undo_group(pageId, depth, window_ms) -> i32` command. Recursive CTE walks newest-first through op_log, returns count of consecutive same-device ops within `window_ms`. Replaces the growing-window `listPageHistory` re-fetch in `undo store`.
- ~~**4.5**~~ session 690: `list_page_links_inner` accepts `tag_ids: Option<&[String]>` with `EXISTS UNION ALL block_tags / block_tag_inherited / block_tag_refs`.

---

## Cross-cutting observations

- **The `space` invariant is leaky in two more places** beyond what
  PEND-15 enforced: `import_markdown` (1.1) and `resolve_page_by_alias`
  (1.2). Both should be folded into a small "FEAT-3 holes" follow-up.
- **The op_log denormalization (migration 0030) is half-adopted.** Four
  query sites still use `json_extract` (3.1). Closing those lets us
  retire `idx_op_log_payload_block_id` (migration 0003) — net index
  reduction.
- **There is a pattern of "list everything then `find` one row"** across
  `list_property_defs`, `get_properties` for single-key reads, and
  template lookups. A general `get_property_def(key)` /
  `get_property(block_id, key)` family would unblock 4-5 callsites at
  once.
- **Three FE-side filters silently break cursor pagination** (HistoryPanel
  op_type, ConflictList type/device/date, DonePanel exclude+empty) —
  same architectural anti-pattern, same fix shape (push the predicate
  into the cursor query).
- **Multi-select operations have no batch endpoints at all.** Every
  multi-select user action (mark-done, delete, restore-from-trash,
  purge, conflict-resolve) is currently N round-trips. A small family
  of `*_by_ids(Vec<String>)` commands closes the gap.

## Cost / Impact / Risk per tier

| Tier | Aggregate cost | Impact | Risk |
| --- | --- | --- | --- |
| **Tier 1 (6 items)** | **M (12-20h)** — most are signature changes + threading `SpaceScope` / `op_type_filter` / `exclude_parent_id` through one or two hops. The two cross-space leaks (1.1, 1.2) need careful migration thinking for already-imported orphan pages. | **High.** Three are silent paging bugs users will misattribute to "the app loses my data." Two are space-isolation correctness. | **Low-medium.** Adding parameters with `Option<...>` defaults preserves callers; migration story for 1.1's existing orphans is the only judgment call. |
| **Tier 2 (12 items)** | **L (40-60h)** — most are "create a batch endpoint mirroring an existing single-row one" plus FE refactor. ConflictList alone is ~10h (3 endpoints). Multi-select batch family ~12h. | **High** for hot paths (multi-select, conflict resolution, agenda intersection — each user-visibly slow today). **Medium** for the rest. | **Low.** All are additive; existing single-row commands can stay during rollout. |
| **Tier 3 (4 items)** | **S (4-8h)** — three are 1-line index additions or SQL string substitutions. 3.4 (block_type pushdown) is bigger because of three call-site updates. | **Medium-high.** 3.1 affects every history view; 3.3 affects every tag-picker keystroke. | **Very low.** Indexes are additive; SQL substitutions are mechanical. |
| **Tier 4 (5 items)** | **S-M (3-10h)** — defer. | **Low** per-item; collectively a few seconds of UX polish. | **Very low.** |

## Recommended sequencing

1. **Tier 1 first**, batched as one PR if `SpaceScope` plumbing
   alignment makes sense (1.2 + 1.6 share a pattern; 1.3 + 1.4 + 1.5
   are the same paging-broken-by-FE-filter shape).
2. **Tier 3 next** — small, mechanical, unblocks Tier 2 perf wins.
3. **Tier 2 in user-impact order**: 2.1 (multi-select) → 2.3 (conflicts)
   → 2.10 (query AND-intersection) → 2.4/2.6/2.7 (fan-out cleanups) →
   the rest.
4. **Tier 4 opportunistically** — fold into adjacent work, no
   dedicated session.

## How this audit was run (auditable)

- All 97 commands enumerated via `grep -B0 -A2 "^#\[tauri::command\]" src-tauri/src/commands/`.
- Six discovery agents (one per command group) read each Rust definition
  end-to-end, grepped FE callsites in `src/`, read ~30 lines of context
  around each, and checked relevant migrations. Output: ~35 raw findings.
- Three validation agents independently re-read every cited `file:line`
  and emitted TRUE / PARTIALLY TRUE / FALSE / CAN'T VERIFY verdicts.
  Tally: 32/34 TRUE, 2/34 PARTIALLY TRUE, 0 FALSE.
- The two PARTIALLY TRUE verdicts only sharpen recommendation type
  ("CREATE batch-by-ids variant") rather than invalidating the
  underlying loop-symptom.
