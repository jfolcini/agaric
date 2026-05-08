# PEND-35 — Tauri command audit: where the frontend is doing work the database/backend should do

> **Status (session 687):** Tier 1 (6 items) shipped — all six correctness/security findings landed in one batch. Tier 2 (12 items), Tier 3 (4 items), Tier 4 (5 items) remain. Pick & schedule per tier — items are independently approvable.

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
validation; **Tier 1 (6 items) shipped in session 687**, leaving 21
open. Grouped by tier:

| Tier | Count | Theme |
| --- | --- | --- |
| ~~**1 — Correctness / security**~~ | ~~6~~ ✅ | ~~Cross-space data leaks, missing space property on import, paging silently broken under FE-side filters~~ — **shipped session 687** |
| **2 — Hot-path performance (N+1, FE intersection)** | 12 | Multi-select loops, conflict resolution loops, FE-side AND-intersection with silent row caps, fan-out per visible row |
| **3 — Indexes & SQL anti-patterns** | 4 | `json_extract` bypassing native column, missing partial index, BINARY index can't satisfy NOCASE LIKE, missing block_type pushdown |
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

### 2.1 Multi-select task ops loop one IPC + one IMMEDIATE tx per block

| What | Detail |
| --- | --- |
| **Backend** | `set_todo_state` `src-tauri/src/commands/properties.rs:212`; `delete_block` `src-tauri/src/commands/blocks/crud.rs:573` |
| **FE** | `src/hooks/useBlockMultiSelect.ts:46-60` (`handleBatchSetTodo`), `:88-141` (`handleBatchDelete`) |
| **Symptom** | Each click of "mark done" / "delete selected" with N selected runs N round-trips, each taking the writer lock and appending one op_log entry. The FE pre-walks `parentOf` (lines 99-110) to drop descendants of selected ancestors — intentional anti-race per MAINT-173 comment, but unnecessary if backend coalesces. |
| **Recommendation** | **CREATE** `set_todo_state_batch(block_ids, state)` and `delete_blocks(block_ids)` — single IMMEDIATE tx, single op_log scope, recursive `descendants_cte` seeded by all roots in one CTE. The MAINT-173 ancestor-pre-walk becomes unnecessary once backend handles ancestor coalescing. |
| **Validator verdict** | N6 TRUE, N7 PARTIALLY TRUE (loop is real; cited "all" sibling can't accept id-list, so the recommendation type is CREATE not USE) |

### 2.2 TrashView batch restore/purge loops

| What | Detail |
| --- | --- |
| **Backend** | `restore_block` `crud.rs:1978`, `purge_block` `crud.rs:2000` |
| **FE** | `src/components/TrashView.tsx:165-188` (`handleBatchRestore`), `:217-249` (`handleBatchPurge`) |
| **Symptom** | 50-row selection = 50 IMMEDIATE txs; each `purge_block` runs the full ~13-table cleanup chain. The "all" variants (`restore_all_deleted_inner`/`purge_all_deleted_inner`) exist but can't accept id-lists. |
| **Recommendation** | **CREATE** `restore_blocks_by_ids(ids)` and `purge_blocks_by_ids(ids)` mirroring the all-variant chain but with `WHERE id IN (SELECT value FROM json_each(?))`. Validator I11 confirmed the substitution is mechanical except for purge's root-selection step (`crud.rs:1256-1269`). |
| **Validator verdict** | N8 PARTIALLY TRUE, I11 TRUE |

### 2.3 ConflictList: 2N IPCs + N+1 + N+1 in three separate places

| What | Detail |
| --- | --- |
| **Symptoms** | Three N+1s in one component: |
| 2.3a | **Parents fetched per conflict** — `Promise.allSettled(uniqueIds.map(getBlock))` at `src/components/ConflictList.tsx:129-140`. `batch_resolve` only returns id/title/type/deleted, insufficient for `ConflictTypeRenderer` which reads `todo_state`, `priority`, `due_date`, `scheduled_date`, `content`, `parent_id`, `position` (`src/components/ConflictTypeRenderer.tsx:44-72,129-148`). |
| 2.3b | **Device id fetched per conflict** — `Promise.all(blocks.map(b => getBlockHistory({blockId: b.id, limit: 1})))` at `src/components/ConflictList.tsx:184-201` to read first op's `device_id` only. |
| 2.3c | **Batch confirm = 2N IPCs** — `for (...)` loop calling `editBlock(parent_id, content)` then `deleteBlock(conflict_id)` per row at `src/components/ConflictList.tsx:378-429`. UX-264 progress bar comment exists *because* of latency. |
| **Recommendation** | **CREATE** three commands: |
| | • `get_blocks(ids: Vec<String>) -> Vec<BlockRow>` — full-row batch using same `json_each(?)` pattern as `batch_resolve`. |
| | • `first_op_device_for_blocks(block_ids) -> HashMap<String, String>` — single SQL using `idx_op_log_block_id` (migration 0030). Or extend `BlockRow` returned by `get_conflicts` to include `origin_device_id` and drop the second IPC entirely. |
| | • `resolve_conflicts_batch(actions: Vec<{block_id, parent_id, action: keep \| discard, content?}>)` — one tx covering all keeps and discards. |
| **Validator verdict** | N9, N10, N11 all TRUE |

### 2.4 Property fan-out per visible row

| What | Detail |
| --- | --- |
| 2.4a | **`DependencyIndicator` fires `getProperties` per agenda row.** `src/components/DependencyIndicator.tsx:49`, rendered per-row in `src/components/AgendaResults.tsx:291`. `propertiesCacheRef` only dedupes re-renders, not the per-block fan-out on initial mount. |
| 2.4b | **`SpaceManageDialog` loops `getProperties(spaceId)` over every space** to read one key (`journal_template`). `src/components/SpaceManageDialog.tsx:710-756`. |
| 2.4c | **`loadJournalTemplateForSpace` and other `find(p => p.key === '...')` callsites** read one well-known key per block. `src/lib/template-utils.ts:168-172`, `src/components/StaticBlock.tsx:129-146`, `src/hooks/useBlockProperties.ts:60`, `src/hooks/useBlockSlashCommands.ts:162`, `src/hooks/useCheckboxSyntax.ts:46`. |
| **Recommendations** | (a) **USE** `get_batch_properties` hoisted in `AgendaResults` parent, or **CREATE** narrower `get_properties_by_keys(block_ids, keys)` that also resolves `value_ref` titles to drop the second `batchResolve`. <br> (b) **USE** `get_batch_properties(allSpaceIds)` — single IPC. <br> (c) **CREATE** `get_property(block_id, key) -> Option<PropertyRow>` (single PK lookup on `block_properties`). |
| **Validator verdict** | N3, N4 TRUE |

### 2.5 `searchPropertyKeys` bypasses the existing cache

| What | Detail |
| --- | --- |
| **FE** | `src/lib/slash-commands.ts:488-497` calls `listPropertyKeys()` (full `SELECT DISTINCT key FROM block_properties`) on every keystroke; `src/hooks/usePropertyKeysCache.ts:36-118` has module-level cache + in-flight dedupe + `EVENT_PROPERTY_CHANGED` invalidation but is unused here. |
| **Recommendation** | **USE** the existing cache from `usePropertyKeysCache`. Extract it into a non-React module-level helper if needed. No backend change. |
| **Validator verdict** | N5 TRUE |

### 2.6 `list_property_defs` consumers fetch the whole vocabulary to read one key

| What | Detail |
| --- | --- |
| **FE** | `src/hooks/useAppBootRecovery.ts:62-83` (looks up `priority`); `src/hooks/usePropertyDefForEdit.ts:45-67` (single key). |
| **Backend** | No `get_property_def` exists. Two private single-key SELECTs already inside `properties.rs` (`:627`, `:719`) prove the shape. |
| **Recommendation** | **CREATE** `get_property_def(key) -> Option<PropertyDefinition>` — one PK SELECT. |
| **Validator verdict** | I7 TRUE |

### 2.7 Attachments: redundant batch + per-block re-fetch when batch is in scope

| What | Detail |
| --- | --- |
| 2.7a | **Two batch IPCs over the same block-set.** `BatchAttachmentsProvider` and `BatchAttachmentCountsProvider` both mount over `allBlockIds` in `src/components/BlockTree.tsx:702-703`. The list batch already returns `AttachmentRow[]` per block — counts are derivable as `result[id].length`. Sites: `src/hooks/useBatchAttachmentCounts.tsx:49`, `src/hooks/useBatchAttachments.tsx:69`, `src-tauri/src/commands/attachments.rs:484`. |
| 2.7b | **`useBlockAttachments(blockId)` always fires `listAttachments(blockId)`** even when an active `BatchAttachmentsProvider` already holds the rows. `src/hooks/useBlockAttachments.ts:32-49`. |
| **Recommendations** | (a) **USE** the list batch as the single source; drop the count provider/command (or inline counts into `BatchAttachmentsValue`). <br> (b) **UPDATE** `useBlockAttachments` to seed from `useBatchAttachments()?.get(blockId)` and only fall back to `listAttachments` when the provider is absent. |
| **Validator verdict** | N1, N2 TRUE |

### 2.8 Template loading: client-side block_type filter + per-template preview fetch

| What | Detail |
| --- | --- |
| **FE** | `src/lib/template-utils.ts:11-19` (filters `b.block_type === 'page'` JS-side after `queryByProperty`); `:57-78` (loops `listBlocks({parentId, limit:1})` per template); `src/components/TemplatesView.tsx:52-67`. |
| **Recommendation** | **UPDATE** `query_by_property` to accept optional `block_type` (see 3.4). **CREATE** `first_child_for_blocks(block_ids) -> HashMap<String, BlockRow>` for the preview path so the N+1 collapses to one IPC. |
| **Validator verdict** | N12 TRUE, I4 TRUE |

### 2.9 GraphView post-filters tag results client-side

| What | Detail |
| --- | --- |
| **FE** | `src/components/GraphView.helpers.ts:138-141` calls `queryByTags(tagIds, mode:'or', limit:5000)` then `pagesResp.items.filter(p => p.block_type === 'page')`. Up to 5000 non-page rows shipped and discarded per render. |
| **Recommendation** | **UPDATE** `query_by_tags` to accept optional `block_type` filter (see 3.4). |
| **Validator verdict** | I6 TRUE |

### 2.10 Agenda/Query AND-intersection done in JS with silent row-cap

| What | Detail |
| --- | --- |
| 2.10a | **Per-value / per-day fan-out.** `agenda-filters.queryStatus`/`queryPriority` fire one `queryByProperty` per status value; `queryPropertyDateDimension` fires one per day in range. `src/lib/agenda-filters.ts:110-141`, `:237-279`. |
| 2.10b | **JS AND-intersection with silent cap.** `useQueryExecution.fetchFilteredQuery` AND-intersects sub-results in JS with `FILTERED_QUERY_MAX_ROWS=50` and `FILTERED_SUBQUERY_LIMIT=200` — any AND-set member outside the top-200 of any sub-query is silently dropped. `src/hooks/useQueryExecution.ts:13-16, 111-174`. |
| **Recommendations** | (a) **UPDATE** `query_by_property` to accept `value_text_in: Vec<String>` and `value_date_range: Option<(String, String)>` (collapses the per-value/per-day fan-outs). <br> (b) **CREATE** `filtered_blocks_query(property_filters, tag_filters, scope, page) -> PageResponse<BlockRow>` that builds the AND in SQL via `EXISTS` subqueries. The existing `BacklinkFilter::And` resolver in `src-tauri/src/backlink/filters.rs` is a working template. |
| **Validator verdict** | N13, N14 TRUE, I5 TRUE |

### 2.11 `getConflicts({limit:100})` polled every 30s for a badge count

| What | Detail |
| --- | --- |
| **FE** | `src/components/ViewDispatcher.tsx:81-87`, `src/hooks/useItemCount.ts:18-27` |
| **Symptom** | Backend has no `count_conflicts`. FE materializes up to 100 full `BlockRow`s (with all columns) just to read `data.items.length`; counts >100 are masked. |
| **Recommendation** | **CREATE** `count_conflicts(scope) -> i64`. Pair with the partial index in 3.2. |
| **Validator verdict** | I1 TRUE |

### 2.12 Boot recovery loops `flush_draft` per orphan

| What | Detail |
| --- | --- |
| **FE** | `src/hooks/useAppBootRecovery.ts:29-42` fires fire-and-forget `flushDraft(id)` per draft; each opens its own BEGIN IMMEDIATE in `drafts.rs:35`. Parallel scheduling is moot — IMMEDIATE txs serialize on the writer lock. |
| **Recommendation** | **CREATE** `flush_all_drafts()` that loops `flush_draft_inner`'s body server-side in one IPC. Confidence: lower (impact only at boot with N orphans). |
| **Validator verdict** | N15 TRUE |

---

## Tier 3 — Indexes & SQL anti-patterns

### 3.1 op_log JSON-extract bypasses native indexed column (4 sites)

| What | Detail |
| --- | --- |
| **Sites** | `src-tauri/src/pagination/history.rs:127-150` (global branch), `:161-188` (per-page branch); `src-tauri/src/commands/history.rs:390` (`restore_page_to_op_inner`); `:493` (`undo_page_op_inner`). |
| **Symptom** | All four use `json_extract(ol.payload, '$.block_id') IN (...)` even though migration 0030 added a denormalized `op_log.block_id` column with `idx_op_log_block_id`. The expression index from migration 0003 keeps the predicate indexed, but every row pays a JSON-extract cost on the projection — and the older expression index becomes redundant. |
| **Recommendation** | **UPDATE** the four SQL strings to read `ol.block_id IN (...)`. After migration, retire `idx_op_log_payload_block_id` (migration 0003). |
| **Validator verdict** | C7 TRUE, I9 TRUE |

### 3.2 No partial index for `is_conflict = 1`

| What | Detail |
| --- | --- |
| **Site** | `src-tauri/src/pagination/hierarchy.rs:142-167` runs `WHERE is_conflict = 1 AND deleted_at IS NULL ORDER BY id ASC`. Grep across all migrations confirms zero `is_conflict` indexes. |
| **Recommendation** | **ADD** `CREATE INDEX idx_blocks_conflict ON blocks(id) WHERE is_conflict = 1 AND deleted_at IS NULL` (mirrors `idx_blocks_deleted` in 0001 and `idx_blocks_page_alive` in 0023). |
| **Validator verdict** | I2 TRUE |

### 3.3 `tags_cache.name` can't satisfy case-insensitive LIKE prefix

| What | Detail |
| --- | --- |
| **Site** | `src-tauri/src/tag_query/query.rs:124-135` runs `WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT ?2`. Schema (`migrations/0001_initial.sql:94-99`) only has the implicit BINARY index from the `UNIQUE` constraint. SQLite default LIKE is case-insensitive on ASCII; BINARY index can't be used. Sibling `page_aliases` already does NOCASE in `migrations/0015_page_aliases.sql`. |
| **Symptom** | High-volume site: every keystroke of every tag picker (SearchPanel, TagFilterPanel, TagValuePicker, HasTagFilterForm, useBlockResolve, agenda-filters). Each call full-scans `tags_cache` and re-sorts. |
| **Recommendation** | **ADD** `CREATE INDEX idx_tags_cache_name_nocase ON tags_cache(name COLLATE NOCASE)` and (optionally) declare `tags_cache.name` itself NOCASE in a new migration. |
| **Validator verdict** | I3 TRUE |

### 3.4 `query_by_property` and `query_by_tags` lack `block_type` and multi-value filters

| What | Detail |
| --- | --- |
| **Sites** | `src-tauri/src/pagination/properties.rs:59-181` (no `block_type`, single equality only); `src-tauri/src/commands/tags.rs:259-300` (`query_by_tags_inner`, no `block_type`). |
| **Recommendation** (covers 2.8/2.9/2.10) | **UPDATE** both to accept `block_type: Option<String>`; **UPDATE** `query_by_property` to also accept `value_text_in: Vec<String>` and `value_date_range: Option<(String, String)>`. |
| **Validator verdict** | I4, I5, I6 TRUE |

---

## Tier 4 — Minor / low-confidence (defer or batch)

| # | Site | Recommendation |
| --- | --- | --- |
| 4.1 | `src/stores/page-blocks.ts:545-573` (`moveUp`/`moveDown` after same-parent reorder calls `get().load()` — full re-list) | Use `move_block` response fields to splice locally, mirroring the `reorder` path at `:432-441`. |
| 4.2 | `src/components/PageEditor.tsx:113-121` (empty-page first block reloads page after `createBlock`) | Use the returned `BlockRow` directly via a `pageStore.appendBlock(row)` setter. |
| 4.3 | Template insertion loops `create_block` per descendant / per markdown line (`src/lib/template-utils.ts:130-219`) | **CREATE** `create_blocks_batch(blocks) -> Vec<BlockRow>`. |
| 4.4 | Undo grouping re-fetches `list_page_history` with growing window after every Ctrl+Z (`src/stores/undo.ts:265-303`) | **CREATE** `find_undo_group(pageId, depth, window_ms) -> i32` or grow `undo_page_op` with `auto_group: bool`. |
| 4.5 | `list_page_links` ships every space-edge then GraphView discards by tag (`src/components/GraphView.helpers.ts:131-156`) | **UPDATE** `list_page_links_inner` to accept `tag_ids: Option<Vec<String>>`. |

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
