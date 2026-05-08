import { Channel } from '@tauri-apps/api/core'
import { commands } from './bindings'
import { logger } from './logger'

export type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CompareOp,
  ConflictResolveAction,
  ConflictResolveBatchResult,
  DateRange,
  DeleteResponse,
  DiffSpan,
  DiffTag,
  Draft,
  FlushAllDraftsResult,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  SortDir,
  SpaceId,
  SpaceRow,
  SpaceScope,
  StatusInfo,
  SyncProgressUpdate,
  TagCacheRow,
  TagResponse,
} from './bindings'

import type {
  BacklinkFilter,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  ConflictResolveAction,
  ConflictResolveBatchResult,
  DateRange,
  DeleteResponse,
  DiffSpan,
  Draft,
  FlushAllDraftsResult,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  SpaceRow,
  SpaceScope,
  StatusInfo,
  SyncProgressUpdate,
  TagCacheRow,
  TagResponse,
} from './bindings'

/**
 * PEND-18 Phase 3 — translate the JS-side `spaceId: string | null` shape
 * into the new tagged-enum [`SpaceScope`] the IPC boundary now expects.
 *
 * `null` / `undefined` → `{ kind: 'global' }` (cross-space view, the
 * pre-FEAT-3 behaviour for callsites that haven't promoted to per-space
 * scoping yet). A non-empty ULID → `{ kind: 'active', space_id }`.
 *
 * The wrapper signatures in this file keep accepting the legacy
 * `spaceId: string | null` for backward-compatibility with the rest of
 * the frontend; the SpaceScope object is constructed here so the
 * translation lives in one place.
 */
function toSpaceScope(spaceId: string | null | undefined): SpaceScope {
  return spaceId == null ? { kind: 'global' } : { kind: 'active', space_id: spaceId }
}

export interface ProjectedAgendaEntry {
  block: BlockRow
  projected_date: string
  source: string // 'due_date' | 'scheduled_date'
}

// ---------------------------------------------------------------------------
// Command wrappers — type-safe Tauri invoke layer
// ---------------------------------------------------------------------------

/**
 * Unwrap a `commands.*` result, throwing on error to preserve the
 * reject-based semantics of the legacy `invoke()` wrappers. Internal
 * helper for the staged migration to `bindings.ts`.
 */
function unwrap<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: unknown }): T {
  if (result.status === 'ok') return result.data
  throw result.error
}

/** Create a new block. Returns the created block with its generated ID.
 *
 * BUG-1 / H-3a — when `blockType === 'page'`, `spaceId` is REQUIRED.
 * The backend rejects page-typed creates without a space ULID with
 * `AppError::Validation`. For page creation, prefer the explicit
 * `createPageInSpace` helper below — it makes the invariant readable
 * at the callsite and routes through the dedicated `create_page_in_space`
 * IPC. The optional `spaceId` here exists so callers stuck on
 * `createBlock` can still satisfy the invariant if needed (and so the
 * specta-bound IPC parameter list matches the Rust signature).
 *
 * Other block types (`content`, `tag`) ignore `spaceId`.
 */
export async function createBlock(params: {
  blockType: string
  content: string
  parentId?: string | undefined
  position?: number | undefined
  spaceId?: string | undefined
}): Promise<BlockRow> {
  return unwrap(
    await commands.createBlock(
      params.blockType,
      params.content,
      params.parentId ?? null,
      params.position ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Edit a block's text content. */
export async function editBlock(blockId: string, toText: string): Promise<BlockRow> {
  return unwrap(await commands.editBlock(blockId, toText))
}

/** Soft-delete a block (cascade to descendants). */
export async function deleteBlock(blockId: string): Promise<DeleteResponse> {
  return unwrap(await commands.deleteBlock(blockId))
}

/**
 * PEND-35 Tier 2.1 — batch soft-delete a list of blocks (cascade to
 * descendants for each root) inside a single backend IMMEDIATE
 * transaction. Returns the number of blocks soft-deleted (roots +
 * descendants combined).
 *
 * Replaces the per-row `deleteBlock` IPC loop in
 * `useBlockMultiSelect.handleBatchDelete`. Multi-select gestures used
 * to fire one IPC per selected block (50 IPCs for a 50-row delete);
 * the new path is one IPC, one writer-lock window, one op_log
 * append-scope. The backend's recursive CTE seeds from every root
 * simultaneously so descendant ids that are also in the input set
 * are coalesced — the FE no longer needs the MAINT-173 ancestor
 * pre-walk.
 *
 * Already-deleted / missing ids are silently dropped on the backend
 * (best-effort across the surviving subset). Validation failures
 * (empty list, oversize list >1000, non-empty space block) reject
 * the whole call and surface as `AppError::Validation` /
 * `AppError::InvalidOperation` toast text.
 */
export async function deleteBlocksByIds(blockIds: string[]): Promise<number> {
  return unwrap(await commands.deleteBlocksByIds(blockIds))
}

/** Restore a soft-deleted block using its `deleted_at` timestamp as ref. */
export async function restoreBlock(
  blockId: string,
  deletedAtRef: string,
): Promise<RestoreResponse> {
  return unwrap(await commands.restoreBlock(blockId, deletedAtRef))
}

/** Permanently purge a block and its descendants. Irreversible. */
export async function purgeBlock(blockId: string): Promise<PurgeResponse> {
  return unwrap(await commands.purgeBlock(blockId))
}

export interface BulkTrashResponse {
  affected_count: number
}

/** Restore all soft-deleted blocks. Returns count of restored blocks. */
export async function restoreAllDeleted(): Promise<BulkTrashResponse> {
  return unwrap(await commands.restoreAllDeleted())
}

/** Permanently purge all soft-deleted blocks. Irreversible. */
export async function purgeAllDeleted(): Promise<BulkTrashResponse> {
  return unwrap(await commands.purgeAllDeleted())
}

/**
 * PEND-35 Tier 2.2 — restore a list of soft-deleted blocks in a single IPC.
 *
 * Mirrors `restoreBlock` but accepts an array of ids; the backend runs one
 * IMMEDIATE transaction with one op_log scope instead of N. Each id is
 * treated as a cascade root (matches the TrashView's
 * `listBlocks({showDeleted:true})` source). Non-deleted / missing ids are
 * silently skipped (no error). Returns the number of blocks (roots +
 * descendants) whose `deleted_at` was actually cleared.
 */
export async function restoreBlocksByIds(blockIds: string[]): Promise<number> {
  const resp = unwrap(await commands.restoreBlocksByIds(blockIds))
  return resp.affected_count
}

/**
 * PEND-35 Tier 2.2 — permanently purge a list of soft-deleted blocks in a
 * single IPC.
 *
 * Mirrors `purgeBlock` but accepts an array of ids; the backend runs one
 * IMMEDIATE transaction with the ~13-table cleanup chain executed once
 * instead of N times. Non-deleted / missing ids are silently skipped (no
 * error). Returns the number of `blocks` rows physically removed.
 */
export async function purgeBlocksByIds(blockIds: string[]): Promise<number> {
  const resp = unwrap(await commands.purgeBlocksByIds(blockIds))
  return resp.affected_count
}

/**
 * Batch-count cascade-deleted descendants per trash root.
 *
 * Given a list of trash-root IDs (as returned by `listBlocks({ showDeleted: true })`),
 * returns a map of `root_id -> descendant_count`. Descendants are blocks sharing
 * the root's `deleted_at` timestamp, excluding the root itself and conflict copies.
 * Roots with zero descendants are omitted — treat missing keys as `0`.
 */
export async function trashDescendantCounts(rootIds: string[]): Promise<Record<string, number>> {
  return unwrap(await commands.trashDescendantCounts(rootIds))
}

/**
 * Batch-fetch the first child of each parent block in a single IPC call.
 *
 * PEND-35 Tier 2.8 — collapses the TemplatesView preview-fetch N+1
 * (`listBlocks({ parentId, limit: 1 })` per template) into a single
 * window-function-backed query on the backend. The returned record
 * maps `parentId -> firstChildBlockRow`, ordered by `(position, id)`
 * ASC inside the CTE so the value is the canonical first sibling.
 *
 * Parents with no active children are omitted from the record. Soft-deleted
 * and conflict-copy children are filtered out inside the CTE so the
 * returned row is always a live, surfaceable block.
 */
export async function firstChildForBlocks(blockIds: string[]): Promise<Record<string, BlockRow>> {
  return unwrap(await commands.firstChildForBlocks(blockIds))
}

/**
 * PEND-35 Tier 2.3 — batch-fetch full BlockRows by id.
 *
 * Sibling of `batchResolve` returning the full 13-column `BlockRow`
 * (not just the lightweight `id / title / block_type / deleted`
 * projection). Consumers that need `todo_state`, `priority`, `due_date`,
 * `scheduled_date`, `content`, `parent_id`, `position`, etc. — e.g.
 * ConflictTypeRenderer — collapse a per-row `getBlock` IPC fan-out into
 * a single query.
 *
 * Soft-deleted and conflict-copy rows are INCLUDED (unlike `batchResolve`
 * which filters `is_conflict = 0`). The primary caller is `ConflictList`
 * which surfaces conflict rows themselves and their possibly-deleted
 * parents — filtering would defeat the use-case.
 *
 * IDs that don't exist are silently omitted from the response — callers
 * must map by `id` and treat missing keys as "unknown / lost". Returned
 * rows are NOT guaranteed to be in input order. Empty input rejects with
 * `AppError::Validation` (mirrors `batchResolve`).
 */
export async function getBlocks(ids: string[]): Promise<BlockRow[]> {
  return unwrap(await commands.getBlocks(ids))
}

/**
 * PEND-35 Tier 2.3 — batch-fetch the first-op `device_id` per block.
 *
 * For each input `block_id`, returns the `device_id` of the **first**
 * op_log row touching that block (lowest `seq`). Block IDs with no
 * op_log rows (e.g. conflict copies created by sync replay rather than
 * a local `create_block`) are simply omitted — callers treat missing
 * keys as "unknown origin".
 *
 * Replaces `Promise.all(blocks.map(b => getBlockHistory({blockId, limit:1})))`
 * in `ConflictList` (the "From: <device>" badge fan-out) with one
 * round-trip. Single SQL using the `idx_op_log_block_id` index from
 * migration 0030.
 *
 * Empty input returns an empty record (not an error). Above 1000 ids
 * rejects with `AppError::Validation`.
 */
export async function firstOpDeviceForBlocks(blockIds: string[]): Promise<Record<string, string>> {
  return unwrap(await commands.firstOpDeviceForBlocks(blockIds))
}

/**
 * PEND-35 Tier 2.3 — atomically resolve a batch of conflicts in a single
 * IPC.
 *
 * Each action is `{ blockId, parentId, action: 'keep' | 'discard', content?:
 * string }`. `keep` writes the conflict's content to the parent and
 * soft-deletes the conflict copy; `discard` soft-deletes the conflict
 * copy without touching the parent. Replaces the FE per-row
 * `editBlock` + `deleteBlock` IPC loop in
 * `ConflictList::handleBatchConfirm` (50 conflicts = 100 IPCs) with one
 * round-trip and one writer-lock window.
 *
 * Atomicity contract: all-or-nothing. Any error inside the batch rolls
 * back the entire transaction (no half-resolved conflicts). On success
 * `resolved == actions.length`; `failed` is reserved (always 0 today)
 * for a future per-action savepoint variant.
 *
 * Validation failures (empty list, oversize > 1000, unknown action,
 * `keep` without content) reject the whole call with
 * `AppError::Validation`.
 */
export async function resolveConflictsBatch(
  actions: ConflictResolveAction[],
): Promise<ConflictResolveBatchResult> {
  return unwrap(await commands.resolveConflictsBatch(actions))
}

/** List blocks with optional filters and cursor-based pagination.
 *
 * The public TypeScript shape keeps the agenda knobs (`agendaDate`,
 * `agendaDateRange`, `agendaSource`) as three top-level fields for
 * backward compatibility. On the IPC boundary they are bundled into the
 * Rust `AgendaQuery` struct so the Tauri command stays under the
 * `tauri-specta` 10-arg limit after FEAT-3 Phase 2 added `spaceId`.
 *
 * `spaceId` (FEAT-3 Phase 4) — required. The backend filters results to
 * blocks whose owning page carries `space = <spaceId>`. Callers must
 * resolve the active `currentSpaceId` (from `useSpaceStore`) before
 * invoking; pre-bootstrap callers should pass `''` (empty string), which
 * the backend treats as a no-match (returns an empty page) rather than
 * crashing on a runtime null deref.
 */
export async function listBlocks(params: {
  parentId?: string | undefined
  blockType?: string | undefined
  tagId?: string | undefined
  showDeleted?: boolean | undefined
  agendaDate?: string | undefined
  agendaDateRange?: DateRange | undefined
  agendaSource?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId: string
}): Promise<PageResponse<BlockRow>> {
  const hasAgenda =
    params.agendaDate != null || params.agendaDateRange != null || params.agendaSource != null
  const agenda = hasAgenda
    ? {
        date: params.agendaDate ?? null,
        dateRange: params.agendaDateRange ?? null,
        source: params.agendaSource ?? null,
      }
    : null
  return unwrap(
    await commands.listBlocks(
      params.parentId ?? null,
      params.blockType ?? null,
      params.tagId ?? null,
      params.showDeleted ?? null,
      agenda,
      params.cursor ?? null,
      params.limit ?? null,
      params.spaceId,
    ),
  )
}

/**
 * Look up a single journal page by its date string in the given space.
 *
 * BUG-48 — replaces the frontend pattern of paginating `listBlocks({ blockType:
 * 'page', limit: 100 })` and probing the resulting Map. Backed by the partial
 * index `idx_blocks_journal_date` (migration 0047) so the lookup is O(index)
 * regardless of total block count. Returns `null` when no journal page exists
 * for `date` in `spaceId`.
 */
export async function getJournalPageByDate(params: {
  date: string
  spaceId: string
}): Promise<BlockRow | null> {
  return unwrap(await commands.getJournalPageByDate(params.date, params.spaceId))
}

/**
 * List the date-formatted journal pages in the given space whose date falls
 * inclusively in `[startDate, endDate]`.
 *
 * BUG-48 — replaces the cursor-paginated `listBlocks({ blockType: 'page',
 * limit: 100 })` loop in `useCalendarPageDates` with a range-scoped
 * indexed lookup. Callers pass the visible date range (typically the
 * 6-week calendar grid for monthly views, or the visible week / day for
 * smaller views) so the response is bounded by what the UI actually
 * renders rather than every journal page ever created in the space.
 */
export async function listJournalPagesInRange(params: {
  startDate: string
  endDate: string
  spaceId: string
}): Promise<BlockRow[]> {
  return unwrap(
    await commands.listJournalPagesInRange(params.startDate, params.endDate, params.spaceId),
  )
}

/** List undated tasks (tasks with todo_state but no due/scheduled date).
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts results to undated
 * tasks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped, matching the pre-FEAT-3
 * behaviour for cross-space callers.
 */
export async function listUndatedTasks(params?: {
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUndatedTasks(
      params?.cursor ?? null,
      params?.limit ?? null,
      toSpaceScope(params?.spaceId),
    ),
  )
}

/**
 * List projected future occurrences of repeating tasks for a date range.
 *
 * Cursor-paginated (M-25). Pass `cursor: response.next_cursor` to fetch
 * the next page; `has_more = false` indicates the final page.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts projections to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listProjectedAgenda(opts: {
  startDate: string
  endDate: string
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<ProjectedAgendaEntry>> {
  return unwrap(
    await commands.listProjectedAgenda(
      opts.startDate,
      opts.endDate,
      opts.cursor ?? null,
      opts.limit ?? null,
      toSpaceScope(opts.spaceId),
    ),
  )
}

/** Fetch a single block by ID. */
export async function getBlock(blockId: string): Promise<BlockRow> {
  return unwrap(await commands.getBlock(blockId))
}

/** Resolved metadata for a block — lightweight alternative to full BlockRow. */
export interface ResolvedBlock {
  id: string
  title: string | null
  block_type: string
  deleted: boolean
}

/** Batch-resolve block metadata for multiple IDs in a single call.
 *
 * `spaceId` (FEAT-3p7) — when set, restricts resolution to blocks
 * whose owning page carries `space = <spaceId>`. Foreign-space targets
 * simply do not appear in the response, which is what makes the chip
 * fall into the "unknown id" branch and render via the broken-link
 * UX (locked-in policy: no live links between spaces, ever).
 *
 * The wrapper keeps `spaceId` optional at the TypeScript boundary so
 * legacy cross-space callers (TrashView breadcrumbs, SearchPanel
 * results, agenda panels, dependency chips) compile unchanged; in the
 * generated `bindings.ts` `space_id` is required, so leaving it
 * `undefined` passes JSON `null` to the backend, which rejects at
 * runtime. The intent is to migrate every call site to pass the
 * active `currentSpaceId` (or an explicit override for genuinely
 * cross-space surfaces like the trash) before the backend tightens
 * `Option<String>` → `String`. Mirrors the optional `spaceId` shape
 * used by `listBlocks` / `searchBlocks`.
 */
export async function batchResolve(
  ids: string[],
  spaceId?: string | undefined,
): Promise<ResolvedBlock[]> {
  return unwrap(await commands.batchResolve(ids, toSpaceScope(spaceId)))
}

/** Move a block to a new parent and/or position. */
export async function moveBlock(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): Promise<MoveResponse> {
  return unwrap(await commands.moveBlock(blockId, newParentId, newPosition))
}

/** Associate a tag with a block. */
export async function addTag(blockId: string, tagId: string): Promise<TagResponse> {
  return unwrap(await commands.addTag(blockId, tagId))
}

/** Remove a tag association from a block. */
export async function removeTag(blockId: string, tagId: string): Promise<TagResponse> {
  return unwrap(await commands.removeTag(blockId, tagId))
}

/** List blocks that link to the given block (backlinks), paginated.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the backlinks to
 * source blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function getBacklinks(params: {
  blockId: string
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.getBacklinks(
      params.blockId,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** List op-log history for a block, paginated (newest first).
 *
 * PEND-35 Tier 1.3 — `opTypeFilter` is pushed into SQL so cursor pages
 * arrive pre-filtered. Mirrors `listPageHistory`. When `undefined`, all
 * op types for the block are returned. */
export async function getBlockHistory(params: {
  blockId: string
  opTypeFilter?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return unwrap(
    await commands.getBlockHistory(
      params.blockId,
      params.opTypeFilter ?? null,
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

/** List conflict blocks, paginated.
 *
 * PEND-35 Tier 1.4 — `conflictType` and `idMin` push two formerly
 * FE-side filters (the ConflictList type dropdown and the "last 7 days"
 * date filter) into SQL so cursor pagination, `total_count`, and "Load
 * more" reflect the post-filter row set.
 *
 * `idMin` is a ULID lower bound (date min — ULIDs are time-ordered).
 */
export async function getConflicts(params?: {
  cursor?: string | undefined
  limit?: number | undefined
  conflictType?: string | undefined
  idMin?: string | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.getConflicts(
      params?.cursor ?? null,
      params?.limit ?? null,
      params?.conflictType ?? null,
      params?.idMin ?? null,
    ),
  )
}

/** Full-text search across all blocks, paginated by relevance.
 *
 * `spaceId` (FEAT-3 Phase 4) — required. Restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. Callers must resolve
 * the active `currentSpaceId` (from `useSpaceStore`) before invoking;
 * pre-bootstrap callers should pass `''` (empty string), which the
 * backend treats as a no-match (returns an empty page) rather than
 * crashing on a runtime null deref.
 */
export async function searchBlocks(params: {
  query: string
  parentId?: string | undefined
  tagIds?: string[] | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId: string
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.searchBlocks(
      params.query,
      params.cursor ?? null,
      params.limit ?? null,
      params.parentId ?? null,
      params.tagIds ?? null,
      params.spaceId,
    ),
  )
}

/** Get materializer queue status and metrics. */
export async function getStatus(): Promise<StatusInfo> {
  return unwrap(await commands.getStatus())
}

/** Query blocks by boolean tag expression (AND/OR mode), paginated.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 *
 * `blockType` (PEND-35 Tier 3.4) — when set, restricts matches to
 * blocks whose `block_type` equals the supplied value (e.g. `'page'`).
 * Pushes GraphView's JS-side `pagesResp.items.filter(p => p.block_type
 * === 'page')` predicate into SQL.
 */
export async function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
  blockType?: string | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByTags(
      params.tagIds,
      params.prefixes,
      params.mode,
      params.includeInherited ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      params.blockType ?? null,
    ),
  )
}

/** List tags whose name starts with the given prefix (autocomplete). */
export async function listTagsByPrefix(params: {
  prefix: string
  limit?: number | undefined
}): Promise<TagCacheRow[]> {
  return unwrap(await commands.listTagsByPrefix(params.prefix, params.limit ?? null))
}

export async function listTagsForBlock(blockId: string): Promise<string[]> {
  return unwrap(await commands.listTagsForBlock(blockId))
}

// ---------------------------------------------------------------------------
// Property commands
// ---------------------------------------------------------------------------

export interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
  /** PEND-14: native boolean property storage; SQLite represents it as 0/1/null. */
  value_bool: number | null
}

/** Set (upsert) a property on a block. Exactly one value field must be non-null. */
export async function setProperty(params: {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
  valueBool?: boolean | null | undefined
}): Promise<BlockRow> {
  return unwrap(
    await commands.setProperty(params.blockId, params.key, {
      value_text: params.valueText ?? null,
      value_num: params.valueNum ?? null,
      value_date: params.valueDate ?? null,
      value_ref: params.valueRef ?? null,
      value_bool: params.valueBool ?? null,
    }),
  )
}

/** Delete a property from a block by key. */
export async function deleteProperty(blockId: string, key: string): Promise<void> {
  unwrap(await commands.deleteProperty(blockId, key))
}

/** Get all properties for a block. */
export async function getProperties(blockId: string): Promise<PropertyRow[]> {
  return unwrap(await commands.getProperties(blockId))
}

/** Get a single property row by `(block_id, key)` primary key
 * (PEND-35 Tier 2.4c).
 *
 * Returns the row, or `null` when no property exists for `key` on the
 * given block. Replaces the pattern of calling `getProperties(blockId)`
 * (which ships every row across the IPC boundary) just to read one
 * well-known key — `loadJournalTemplateForSpace`, the `StaticBlock`
 * `image_width` read, and the three `blocked_by` dependency probes
 * (gutter cycle, slash command, checkbox syntax) all migrated to this
 * dedicated PK lookup.
 */
export async function getProperty(blockId: string, key: string): Promise<PropertyRow | null> {
  return unwrap(await commands.getProperty(blockId, key))
}

/** Batch-fetch properties for multiple blocks in a single IPC call. */
export async function getBatchProperties(
  blockIds: string[],
): Promise<Record<string, PropertyRow[]>> {
  return unwrap(await commands.getBatchProperties(blockIds))
}

// ---------------------------------------------------------------------------
// Batch count commands (#604)
// ---------------------------------------------------------------------------

/** Batch-count agenda items per date. Returns a map of date -> count.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatch(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countAgendaBatch(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count agenda items per (date, source). Returns nested map: date -> source -> count.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatchBySource(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, Record<string, number>>> {
  return unwrap(await commands.countAgendaBatchBySource(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count backlinks per target page. Returns a map of pageId -> count.
 *
 * `spaceId` (PEND-35 Tier 1.6) — when set, restricts the counted source
 * blocks to those whose owning page carries `space = <spaceId>`.
 * `null` / `undefined` keeps the cross-space (legacy) behaviour. The
 * scope is forwarded as a [`SpaceScope`] via `toSpaceScope`. Without
 * this filter a page in space A could surface a non-zero badge count
 * whose source blocks live in space B — backlinks the user can't see.
 */
export async function countBacklinksBatch(params: {
  pageIds: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countBacklinksBatch(params.pageIds, toSpaceScope(params.spaceId)))
}

/** Count active (non-deleted) conflict-copy blocks.
 *
 * PEND-35 Tier 2.11 — replaces the previous `getConflicts({limit:100})`
 * + `.items.length` pattern used by `useConflictCount` for the
 * conflicts-tab badge. The old shape materialised up to 100 full
 * `BlockRow`s every 30 s for one integer and silently capped the badge
 * at 100; this command runs a single `SELECT COUNT(*)` so the badge
 * reflects the true count regardless of magnitude.
 *
 * `spaceId` — when set, restricts the count to conflicts whose owning
 * page carries `space = <spaceId>`. `null` / `undefined` returns the
 * cross-space count. Mirrors the [`countBacklinksBatch`] scoping shape.
 */
export async function countConflicts(spaceId?: string | null | undefined): Promise<number> {
  return unwrap(await commands.countConflicts(toSpaceScope(spaceId)))
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Set or clear the todo state on a block. Pass null to clear. */
export async function setTodoState(blockId: string, state: string | null): Promise<BlockRow> {
  return unwrap(await commands.setTodoState(blockId, state))
}

/**
 * PEND-35 Tier 2.1 — batch set/clear todo state across a list of blocks
 * inside a single backend IMMEDIATE transaction. Returns the number of
 * blocks whose `todo_state` actually changed.
 *
 * Replaces the per-row `setTodoState` IPC loop in
 * `useBlockMultiSelect.handleBatchSetTodo`. Multi-select "mark done"
 * used to fire one IPC per selected block (50 IPCs for a 50-row
 * gesture); the new path is one IPC, one writer-lock window, one
 * op_log append-scope.
 *
 * Missing / soft-deleted ids are silently skipped on the backend
 * (best-effort across the surviving subset). The single-row
 * `setTodoState` path stays in place for the per-block call sites
 * (BlockContextMenu, slash commands) — its recurrence + timestamp
 * transitions (`created_at` / `completed_at` auto-population, repeat
 * sibling creation) are intentionally NOT applied by the batch path
 * because propagating them per item under one IMMEDIATE lock would
 * defeat the latency win.
 */
export async function setTodoStateBatch(blockIds: string[], state: string | null): Promise<number> {
  return unwrap(await commands.setTodoStateBatch(blockIds, state))
}

/** Set or clear the priority level on a block. Pass null to clear. */
export async function setPriority(blockId: string, level: string | null): Promise<BlockRow> {
  return unwrap(await commands.setPriority(blockId, level))
}

/** Set or clear the due date on a block. Pass null to clear. */
export async function setDueDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setDueDate(blockId, date))
}

/** Set or clear the scheduled date on a block. Pass null to clear. */
export async function setScheduledDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setScheduledDate(blockId, date))
}

/** List global operation history (page-scoped), paginated (newest first).
 *
 * FEAT-3 Phase 8 — `spaceId` narrows the global (`pageId === '__all__'`)
 * query to ops whose `payload.block_id` belongs to the requested space.
 * Pass `undefined` to disable the space filter (cross-space "All spaces"
 * mode). Ignored in per-page mode — a real ULID `pageId` is already
 * space-bound. */
export async function listPageHistory(params: {
  pageId: string
  opTypeFilter?: string | undefined
  spaceId?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return unwrap(
    await commands.listPageHistory(
      params.pageId,
      params.opTypeFilter ?? null,
      toSpaceScope(params.spaceId),
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

/** List all page-to-page links for graph visualization.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the link set to
 * source pages whose `space = <spaceId>`. `null` / `undefined` leaves
 * the graph cross-space (legacy behaviour).
 *
 * `tagIds` (PEND-35 Tier 4.5) — when non-empty, restricts edges to
 * those whose **target page** carries at least one of the listed
 * tags (via `block_tags`, `block_tag_inherited`, or
 * `block_tag_refs` — same UX-250 union semantics as `queryByTags`).
 * Pushes the GraphView tag-filter predicate into SQL so the renderer
 * no longer fetches every space-wide edge then drops the off-tag
 * subgraph in JS. `null` / `undefined` / empty leaves the edge set
 * unfiltered.
 *
 * Backward-compat note: callers that still pass a bare `spaceId`
 * string keep working — the legacy positional shape is detected and
 * normalised to `{ spaceId, tagIds: null }` below.
 */
export async function listPageLinks(
  arg?:
    | string
    | null
    | undefined
    | {
        spaceId?: string | null | undefined
        tagIds?: string[] | null | undefined
      },
): Promise<Array<{ source_id: string; target_id: string; ref_count: number }>> {
  const params = typeof arg === 'object' && arg !== null ? arg : { spaceId: arg ?? null }
  const tagIds = params.tagIds && params.tagIds.length > 0 ? params.tagIds : null
  return unwrap(await commands.listPageLinks(toSpaceScope(params.spaceId), tagIds))
}

/** Revert a batch of operations (by device_id + seq pairs). */
export async function revertOps(params: {
  ops: Array<{ device_id: string; seq: number }>
}): Promise<unknown> {
  return unwrap(await commands.revertOps(params.ops))
}

/** Restore a page to its state at a specific operation (point-in-time restore). */
export async function restorePageToOp(params: {
  pageId: string
  targetDeviceId: string
  targetSeq: number
}): Promise<{
  ops_reverted: number
  non_reversible_skipped: number
  results: unknown[]
}> {
  return unwrap(
    await commands.restorePageToOp(params.pageId, params.targetDeviceId, params.targetSeq),
  )
}

/** Query blocks by property key and optional value, with cursor pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 */
export async function listUnfinishedTasks(params: {
  beforeDate: string
  todoStates: string[]
  cursor?: string
  limit?: number
  spaceId?: string | null
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUnfinishedTasks(
      params.beforeDate,
      params.todoStates,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query blocks by property key/value with cursor pagination.
 *
 * `excludeParentId` / `contentNonEmpty` (PEND-35 Tier 1.5) push the
 * DonePanel's two post-filters down into SQL so cursor pagination,
 * `total_count`, and "Load more" reflect the visible set instead of
 * the unfiltered raw page. `undefined` / `false` preserves the legacy
 * unfiltered behaviour.
 *
 * `blockType` / `valueTextIn` / `valueDateRange` (PEND-35 Tier 3.4)
 * push three more filters into SQL:
 *  - `blockType` — equality on `b.block_type` (e.g. restrict templates
 *    to `'page'`).
 *  - `valueTextIn` — set-membership on `value_text`. Mutually
 *    exclusive with `valueText`; passing both is rejected by the
 *    backend.
 *  - `valueDateRange` — half-open `[from, to)` date range on
 *    `value_date` (or the matching reserved column for
 *    `due_date` / `scheduled_date`).
 *
 * On the IPC boundary the five push-down knobs are bundled into the
 * Rust `ExtraQueryFilters` struct so the Tauri command stays under the
 * `tauri-specta` 10-arg limit. The flat public API is preserved here.
 */
export async function queryByProperty(params: {
  key: string
  valueText?: string | undefined
  valueDate?: string | undefined
  operator?: string | undefined // 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
  excludeParentId?: string | undefined
  contentNonEmpty?: boolean | undefined
  blockType?: string | undefined
  valueTextIn?: string[] | undefined
  valueDateRange?: [string, string] | undefined
}): Promise<PageResponse<BlockRow>> {
  const hasExtra =
    params.excludeParentId !== undefined ||
    params.contentNonEmpty !== undefined ||
    params.blockType !== undefined ||
    params.valueTextIn !== undefined ||
    params.valueDateRange !== undefined
  const extraFilters = hasExtra
    ? {
        excludeParentId: params.excludeParentId ?? null,
        contentNonEmpty: params.contentNonEmpty ?? null,
        blockType: params.blockType ?? null,
        valueTextIn: params.valueTextIn ?? null,
        valueDateRange: params.valueDateRange ?? null,
      }
    : null
  return unwrap(
    await commands.queryByProperty(
      params.key,
      params.valueText ?? null,
      params.valueDate ?? null,
      params.operator ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      extraFilters,
    ),
  )
}

// ---------------------------------------------------------------------------
// Undo / Redo commands
// ---------------------------------------------------------------------------

export interface OpRef {
  device_id: string
  seq: number
}

export interface UndoResult {
  reversed_op: OpRef
  reversed_op_type: string
  new_op_ref: OpRef
  new_op_type: string
  is_redo: boolean
}

/** Undo the Nth most-recent undoable op on a page. */
export async function undoPageOp(params: {
  pageId: string
  undoDepth: number
}): Promise<UndoResult> {
  return unwrap(await commands.undoPageOp(params.pageId, params.undoDepth))
}

/** Redo a previously undone op by reversing it again. */
export async function redoPageOp(params: {
  undoDeviceId: string
  undoSeq: number
}): Promise<UndoResult> {
  return unwrap(await commands.redoPageOp(params.undoDeviceId, params.undoSeq))
}

// ---------------------------------------------------------------------------
// Word-level diff for history display
// ---------------------------------------------------------------------------

/** Compute a word-level diff for an edit_block history entry. Returns null for non-edit ops. */
export async function computeEditDiff(params: {
  deviceId: string
  seq: number
}): Promise<DiffSpan[] | null> {
  return unwrap(await commands.computeEditDiff(params.deviceId, params.seq))
}

/**
 * Compute a word-level diff between a block's historical content (as of
 * `historicalSeq`) and its current live content. Powers the "Compared to
 * current" mode in the per-block history panel (PEND-17 Part B).
 *
 * Direction is `historical → current`, so `Insert` spans = text added
 * since the historical version (would be REMOVED on restore) and
 * `Delete` spans = text removed since the historical version (would be
 * RESTORED). Returns an empty array (or all-Equal spans) when the two
 * snapshots are byte-identical.
 *
 * Throws on a soft-deleted / purged block — the in-panel preview is
 * meaningless for trashed blocks.
 */
export async function computeBlockVsCurrentDiff(params: {
  blockId: string
  historicalSeq: number
}): Promise<DiffSpan[]> {
  return unwrap(await commands.computeBlockVsCurrentDiff(params.blockId, params.historicalSeq))
}

// ---------------------------------------------------------------------------
// Filtered backlink query commands
// ---------------------------------------------------------------------------

/** Query backlinks with composable filters, sort, and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function queryBacklinksFiltered(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<BacklinkQueryResponse> {
  return unwrap(
    await commands.queryBacklinksFiltered(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query backlinks grouped by source page, with filters and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listBacklinksGrouped(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listBacklinksGrouped(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query unlinked references grouped by source page, with filters, sort, and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the candidate set
 * to blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listUnlinkedReferences(params: {
  pageId: string
  filters?: BacklinkFilter[] | null | undefined
  sort?: BacklinkSort | null | undefined
  cursor?: string | null | undefined
  limit?: number | null | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listUnlinkedReferences(
      params.pageId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** List all distinct property keys currently in use. */
export async function listPropertyKeys(): Promise<string[]> {
  return unwrap(await commands.listPropertyKeys())
}

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

/** Create a new property definition. */
export async function createPropertyDef(params: {
  key: string
  valueType: string
  options?: string | null | undefined
}): Promise<PropertyDefinition> {
  return unwrap(
    await commands.createPropertyDef(params.key, params.valueType, params.options ?? null),
  )
}

/** Fetch a single property definition by key (PEND-35 Tier 2.6).
 *
 * Returns the row, or `null` when no definition exists for `key`.
 * Replaces the pattern of calling `listPropertyDefs()` (which paginates
 * the entire vocabulary) just to read one well-known key — boot
 * recovery's `priority` lookup and the per-block property-editor popover
 * each used to ship the full def list to the renderer for a one-row
 * read.
 */
export async function getPropertyDef(key: string): Promise<PropertyDefinition | null> {
  return unwrap(await commands.getPropertyDef(key))
}

/** List all property definitions, paginated (M-85).
 *
 * Returns the canonical [`PageResponse`] envelope (`items`,
 * `next_cursor`, `has_more`). Single-page consumers (the typical case
 * for property-defs picker UIs — the seeded vocabulary fits well under
 * a single page) destructure `.items` and ignore the cursor. Callers
 * that genuinely walk every page must thread `next_cursor` back via
 * `cursor` until `has_more === false`.
 *
 * Pre-M-85: `listPropertyDefs(): Promise<PropertyDefinition[]>`.
 */
export async function listPropertyDefs(opts?: {
  cursor?: string | null | undefined
  limit?: number | null | undefined
}): Promise<PageResponse<PropertyDefinition>> {
  return unwrap(await commands.listPropertyDefs(opts?.cursor ?? null, opts?.limit ?? null))
}

/** Update the options JSON for a select-type property definition. */
export async function updatePropertyDefOptions(
  key: string,
  options: string,
): Promise<PropertyDefinition> {
  return unwrap(await commands.updatePropertyDefOptions(key, options))
}

/** Delete a property definition by key. */
export async function deletePropertyDef(key: string): Promise<void> {
  unwrap(await commands.deletePropertyDef(key))
}

// ---------------------------------------------------------------------------
// Sync / Peer-ref commands
// ---------------------------------------------------------------------------
// NOTE: Only peer_refs CRUD exists on the backend so far. Full sync protocol
// commands (startPairing, startSync, etc.) will be added when the backend
// implements them.

/** Peer reference row returned by `list_peer_refs` / `get_peer_ref`.
 *  Fields match the Rust `PeerRef` struct (see src-tauri/src/peer_refs.rs). */
export interface PeerRefRow {
  peer_id: string
  last_hash: string | null
  last_sent_hash: string | null
  synced_at: string | null
  reset_count: number
  last_reset_at: string | null
  cert_hash: string | null
  device_name: string | null
  last_address: string | null
}

/** List all known peer references. */
export async function listPeerRefs(): Promise<PeerRefRow[]> {
  return unwrap(await commands.listPeerRefs())
}

/** Fetch a single peer reference by ID, or null if not found. */
export async function getPeerRef(peerId: string): Promise<PeerRefRow | null> {
  return unwrap(await commands.getPeerRef(peerId))
}

/** Delete a peer reference by ID. */
export async function deletePeerRef(peerId: string): Promise<void> {
  unwrap(await commands.deletePeerRef(peerId))
}

/** Update the display name for a paired peer. Pass null to clear. */
export async function updatePeerName(peerId: string, deviceName: string | null): Promise<void> {
  unwrap(await commands.updatePeerName(peerId, deviceName))
}

/** Manually set a peer's network address (host:port) for direct connection. */
export async function setPeerAddress(peerId: string, address: string): Promise<void> {
  unwrap(await commands.setPeerAddress(peerId, address))
}

/** Get the local device ID. */
export async function getDeviceId(): Promise<string> {
  return unwrap(await commands.getDeviceId())
}

// ---------------------------------------------------------------------------
// Sync protocol commands
// ---------------------------------------------------------------------------

export interface DeviceHead {
  device_id: string
  seq: number
  hash: string
}

export interface SyncSessionInfo {
  state: string
  local_device_id: string
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

/** Start the pairing flow — returns a passphrase and QR SVG.
 *
 * M-34: the QR carries only the passphrase. mDNS owns discovery and
 * address resolution end-to-end, so there is no `host`/`port` field on
 * the returned payload.
 */
export async function startPairing(): Promise<{
  passphrase: string
  qr_svg: string
}> {
  return unwrap(await commands.startPairing())
}

/** Confirm a pairing with the given passphrase and remote device ID. */
export async function confirmPairing(passphrase: string, remoteDeviceId: string): Promise<void> {
  unwrap(await commands.confirmPairing(passphrase, remoteDeviceId))
}

/** Cancel an in-progress pairing. */
export async function cancelPairing(): Promise<void> {
  unwrap(await commands.cancelPairing())
}

/** Start a sync session with a known peer. */
export async function startSync(
  peerId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<SyncSessionInfo> {
  const channel = new Channel<SyncProgressUpdate>()
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.startSync(peerId, channel))
}

/** Cancel an in-progress sync session. */
export async function cancelSync(): Promise<void> {
  unwrap(await commands.cancelSync())
}

// ---------------------------------------------------------------------------
// Page alias commands (#598)
// ---------------------------------------------------------------------------

/** Set the complete list of aliases for a page (replaces existing). */
export async function setPageAliases(pageId: string, aliases: string[]): Promise<string[]> {
  return unwrap(await commands.setPageAliases(pageId, aliases))
}

/** Get all aliases for a page. */
export async function getPageAliases(pageId: string): Promise<string[]> {
  return unwrap(await commands.getPageAliases(pageId))
}

/**
 * Resolve a page by one of its aliases. Returns page ID + title, or null.
 *
 * `spaceId` (PEND-35 Tier 1.2) — when set, restricts the match to
 * aliases pointing at pages whose `space` property equals `spaceId`.
 * Mirrors the param-object shape used by `listPageAliasesByPrefix`
 * directly below. Pass `null` / `undefined` to leave the resolve
 * unscoped (cross-space) for callers (e.g. agent / MCP tools) that
 * span every space.
 */
export async function resolvePageByAlias(params: {
  alias: string
  spaceId?: string | null | undefined
}): Promise<[string, string | null] | null> {
  return unwrap(await commands.resolvePageByAlias(params.alias, toSpaceScope(params.spaceId)))
}

/**
 * List page aliases whose alias starts with the given prefix, ordered
 * shortest-alias first, then alphabetical. Bounded server-side at 50.
 *
 * Used by the [[ picker for progressive alias filtering (PEND-34). The
 * exact-match `resolvePageByAlias` is still used by SearchPanel /
 * PageBrowser (out of scope here — see PEND-34 follow-ups).
 *
 * `spaceId` (PEND-34 Q3) — when set, restricts matches to aliases
 * pointing at pages whose `space` property equals `spaceId`. Pass
 * `null`/`undefined` to leave the result set unscoped (cross-space).
 */
export async function listPageAliasesByPrefix(params: {
  prefix: string
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<Array<[string, string, string | null]>> {
  return unwrap(
    await commands.listPageAliasesByPrefix(
      params.prefix,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

// ---------------------------------------------------------------------------
// Markdown export (#519)
// ---------------------------------------------------------------------------

/** Export a page as Markdown with human-readable tag/page references. */
export async function exportPageMarkdown(pageId: string): Promise<string> {
  return unwrap(await commands.exportPageMarkdown(pageId))
}

// ---------------------------------------------------------------------------
// Attachment commands (F-7)
// ---------------------------------------------------------------------------

export interface AttachmentRow {
  id: string
  block_id: string
  filename: string
  mime_type: string
  size_bytes: number
  fs_path: string
  created_at: string
}

/** List all attachments for a block. */
export async function listAttachments(blockId: string): Promise<AttachmentRow[]> {
  return unwrap(await commands.listAttachments(blockId))
}

/**
 * Batch-fetch full attachment lists for many blocks in one IPC.
 *
 * Returns a record mapping block_id → AttachmentRow[]. Block IDs absent
 * from the record have either 0 attachments or are not in the database;
 * callers should default missing keys to `[]`. Counts are derivable as
 * `result[id].length` — PEND-35 Tier 2.7a folded the separate count
 * batch (`get_batch_attachment_counts`) into this one.
 *
 * MAINT-131 — replaces N per-block `listAttachments` IPCs for both the
 * SortableBlock paperclip badge and the StaticBlock inline-image render
 * path with a single batched query mounted at the BlockTree level.
 */
export async function getBatchAttachments(
  blockIds: string[],
): Promise<Record<string, AttachmentRow[]>> {
  return unwrap(await commands.listAttachmentsBatch(blockIds))
}

/** Add an attachment to a block. */
export async function addAttachment(params: {
  blockId: string
  filename: string
  mimeType: string
  sizeBytes: number
  fsPath: string
}): Promise<AttachmentRow> {
  return unwrap(
    await commands.addAttachment(
      params.blockId,
      params.filename,
      params.mimeType,
      params.sizeBytes,
      params.fsPath,
    ),
  )
}

/** Delete an attachment by ID. */
export async function deleteAttachment(attachmentId: string): Promise<void> {
  unwrap(await commands.deleteAttachment(attachmentId))
}

// ---------------------------------------------------------------------------
// Markdown import (#660)
// ---------------------------------------------------------------------------

export interface ImportResult {
  page_title: string
  blocks_created: number
  properties_set: number
  warnings: string[]
}

/**
 * Import a Logseq/Markdown file. Creates a page from the filename and
 * blocks from content.
 *
 * `spaceId` (PEND-35 Tier 1.1) — required. The created page is stamped
 * with `space = ?spaceId` inside the same backend transaction as the
 * `CreateBlock` op, so an imported page can never exist without its
 * space property. Callers must pass the active space's ULID; the
 * import button must stay disabled while the space store is not
 * bootstrapped (no active space) so this never receives an empty
 * string.
 */
export async function importMarkdown(
  content: string,
  filename: string | undefined,
  spaceId: string,
): Promise<ImportResult> {
  return unwrap(await commands.importMarkdown(content, filename ?? null, spaceId))
}

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------

/** Save (upsert) a draft for a block. Called every ~2s during active typing. */
export async function saveDraft(blockId: string, content: string): Promise<void> {
  unwrap(await commands.saveDraft(blockId, content))
}

/** Flush a draft: write an edit_block op and delete the draft row. Called on blur/unmount. */
export async function flushDraft(blockId: string): Promise<void> {
  unwrap(await commands.flushDraft(blockId))
}

/**
 * Flush every pending draft in a single `BEGIN IMMEDIATE` tx (PEND-35
 * Tier 2.12). Used by `useAppBootRecovery` to consolidate boot recovery
 * into one IPC instead of N fire-and-forget per-draft round-trips. The
 * backend semantics are all-or-nothing: a single draft failure rolls
 * back the whole batch — see `flush_all_drafts_inner`'s doc comment.
 */
export async function flushAllDrafts(): Promise<FlushAllDraftsResult> {
  return unwrap(await commands.flushAllDrafts())
}

/** Delete a draft for a block (e.g. after a successful normal save). */
export async function deleteDraft(blockId: string): Promise<void> {
  unwrap(await commands.deleteDraft(blockId))
}

/** List all drafts, ordered by updated_at ascending. */
export async function listDrafts(): Promise<Draft[]> {
  return unwrap(await commands.listDrafts())
}

// ---------------------------------------------------------------------------
// Frontend logging (F-19)
// ---------------------------------------------------------------------------

/** Log a frontend message to the backend's daily-rolling log file. Fire-and-forget. */
export async function logFrontend(
  level: string,
  module: string,
  message: string,
  stack?: string | null,
  context?: string | null,
  data?: string | null,
): Promise<void> {
  unwrap(
    await commands.logFrontend(
      level,
      module,
      message,
      stack ?? null,
      context ?? null,
      data ?? null,
    ),
  )
}

/** Return the path to the logs directory. */
export async function getLogDir(): Promise<string> {
  return unwrap(await commands.getLogDir())
}

// ---------------------------------------------------------------------------
// Op Log Compaction (F-20)
// ---------------------------------------------------------------------------

export interface CompactionStatus {
  total_ops: number
  oldest_op_date: string | null
  eligible_ops: number
  retention_days: number
}

export interface CompactionResult {
  snapshot_id: string | null
  ops_deleted: number
}

/** Get current op log compaction status and stats. */
export async function getCompactionStatus(): Promise<CompactionStatus> {
  return unwrap(await commands.getCompactionStatus())
}

/** Compact the op log by removing ops older than retentionDays. */
export async function compactOpLog(retentionDays: number): Promise<CompactionResult> {
  return unwrap(await commands.compactOpLogCmd(retentionDays))
}

// ---------------------------------------------------------------------------
// Link metadata (UX-165)
// ---------------------------------------------------------------------------

export interface LinkMetadata {
  url: string
  title: string | null
  favicon_url: string | null
  description: string | null
  fetched_at: string
  auth_required: boolean
}

/** Fetch and cache link metadata (triggers HTTP fetch if not cached). */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  return unwrap(await commands.fetchLinkMetadata(url))
}

/** Get cached link metadata (no network fetch). */
export async function getLinkMetadata(url: string): Promise<LinkMetadata | null> {
  return unwrap(await commands.getLinkMetadata(url))
}

// ---------------------------------------------------------------------------
// Bug report (FEAT-5)
// ---------------------------------------------------------------------------

export interface BugReport {
  app_version: string
  os: string
  arch: string
  device_id: string
  recent_errors: string[]
}

export interface LogFileEntry {
  name: string
  contents: string
}

/**
 * Gather app version, OS/arch, device ID and a tail of recent error/warn
 * lines from today's log for pre-filling a bug report.
 */
export async function collectBugReportMetadata(): Promise<BugReport> {
  return unwrap(await commands.collectBugReportMetadata())
}

/**
 * Enumerate rolled log files within the last 7 days. When `redact=true`,
 * home paths are replaced with `~`, the device ID is blanked, and long
 * lines are truncated.
 */
export async function readLogsForReport(redact: boolean): Promise<LogFileEntry[]> {
  return unwrap(await commands.readLogsForReport(redact))
}

// ---------------------------------------------------------------------------
// Spaces (FEAT-3 Phase 1)
// ---------------------------------------------------------------------------

/**
 * List every space (id + display name) alphabetical by name. Used by the
 * sidebar `SpaceSwitcher` + the Zustand `useSpaceStore`.
 */
export async function listSpaces(): Promise<SpaceRow[]> {
  return unwrap(await commands.listSpaces())
}

/**
 * Create a new page block and atomically assign it to `spaceId`.
 *
 * FEAT-3 Phase 2 — the backend wraps both the `CreateBlock` op and the
 * `SetProperty(space = <spaceId>)` op in a single transaction so a page
 * never exists without its space property. Callers that create
 * top-level pages (PageBrowser "New page", App "New page" actions, the
 * link-picker "Create new page" affordance) must route through this
 * command rather than `createBlock({ blockType: 'page' })` — the latter
 * leaves the new page unscoped and violates the "nothing outside of
 * spaces" invariant.
 *
 * Returns the new page's ULID.
 */
export async function createPageInSpace(params: {
  parentId?: string | null | undefined
  content: string
  spaceId: string
}): Promise<string> {
  return unwrap(
    await commands.createPageInSpace(params.parentId ?? null, params.content, params.spaceId),
  )
}

/**
 * Create a new space (a top-level page block flagged
 * `is_space = 'true'`).
 *
 * FEAT-3 Phase 6 — the backend wraps the `CreateBlock` op, the
 * `SetProperty(is_space = "true")` op, and the optional
 * `SetProperty(accent_color = …)` op in a single transaction so a
 * partial failure never leaves a half-created space (a page block
 * without its `is_space` flag) in the op log.
 *
 * `accentColor` accepts the palette tokens consumed by FEAT-3p10
 * (e.g. `accent-violet`, `accent-blue`, …). Pass `null` / `undefined`
 * to skip the accent-color property entirely.
 *
 * Returns the new space's ULID.
 */
export async function createSpace(params: {
  name: string
  accentColor?: string | null | undefined
}): Promise<string> {
  return unwrap(await commands.createSpace(params.name, params.accentColor ?? null))
}

// ---------------------------------------------------------------------------
// Quick capture (FEAT-12)
// ---------------------------------------------------------------------------

/**
 * FEAT-12: a coarse mobile-detect used to gate the global-shortcut JS API.
 *
 * `tauri-plugin-global-shortcut` is desktop-only — its native dependency
 * (`global-hotkey` crate) compiles only on Linux/macOS/Windows, and the
 * Rust-side registration in `src-tauri/src/lib.rs` is gated behind
 * `#[cfg(desktop)]`. The matching JS API import would resolve at module
 * load time on every platform; calling the underlying `invoke('plugin:…')`
 * on Android / iOS would throw at runtime. Guard at the wrapper boundary
 * so callers (Settings UI, App.tsx startup hook) get a no-op promise on
 * mobile instead of an unhandled rejection.
 *
 * The detection mirrors `useIsMobile` (matchMedia / innerWidth) but is
 * SSR-safe and does not depend on React state.
 */
function isMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  return /Android|iPhone|iPad|iPod/i.test(ua)
}

/**
 * FEAT-12 + FEAT-3p5: drop a single content block onto today's journal
 * page in the active space.
 *
 * Resolves today's journal page in `spaceId` on the backend (creating it
 * if missing) and appends a content block as a child. Used by the
 * global-shortcut quick-capture flow (`QuickCaptureDialog` →
 * `quickCaptureBlock`). The space scoping is required: every journal
 * page belongs to a space, so two devices in different spaces capture
 * into their own daily notes without colliding.
 */
export async function quickCaptureBlock(content: string, spaceId: string): Promise<BlockRow> {
  return unwrap(await commands.quickCaptureBlock(content, spaceId))
}

/**
 * FEAT-12: register a global hotkey via `@tauri-apps/plugin-global-shortcut`.
 *
 * `accelerator` is the chord string (`'CommandOrControl+Alt+N'`) that the
 * plugin recognises. `callback` fires once per press (we filter on
 * `state === 'Pressed'` so users don't get double-fires on key release).
 *
 * **Desktop-only** — on mobile this resolves immediately without
 * registering anything. The plugin's underlying `global-hotkey` crate
 * does not compile for Android / iOS targets, and registration is
 * `#[cfg(desktop)]`-gated in `src-tauri/src/lib.rs`. Throws on the
 * desktop side if the chord conflicts with another app's binding —
 * callers should surface that as a user-visible toast.
 */
export async function registerGlobalShortcut(
  accelerator: string,
  callback: () => void,
): Promise<void> {
  if (isMobilePlatform()) return
  const { register } = await import('@tauri-apps/plugin-global-shortcut')
  await register(accelerator, (event) => {
    // The plugin emits both `Pressed` and `Released` — fire the user
    // callback once per logical activation only.
    if (event.state === 'Pressed') callback()
  })
}

/**
 * FEAT-12: unregister a previously-registered global hotkey.
 *
 * Desktop-only; a no-op on mobile (matches `registerGlobalShortcut`).
 * Safe to call when the chord was never registered — the underlying
 * plugin throws in that case, which we let propagate so callers can
 * decide whether to log or swallow.
 */
export async function unregisterGlobalShortcut(accelerator: string): Promise<void> {
  if (isMobilePlatform()) return
  const { unregister } = await import('@tauri-apps/plugin-global-shortcut')
  await unregister(accelerator)
}

/**
 * FEAT-12: probe whether `accelerator` is currently registered by *this*
 * application. Returns `false` for both "not registered by us" and
 * "registered by another app" cases — the plugin can't distinguish OS-
 * level conflicts from a clean unbound state.
 *
 * Desktop-only; resolves to `false` on mobile.
 */
export async function isGlobalShortcutRegistered(accelerator: string): Promise<boolean> {
  if (isMobilePlatform()) return false
  const { isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
  return isRegistered(accelerator)
}

// ---------------------------------------------------------------------------
// Autostart (FEAT-13) — launch-on-login support
// ---------------------------------------------------------------------------
//
// Thin wrappers around `@tauri-apps/plugin-autostart`'s three exports
// (`enable`, `disable`, `isEnabled`).  Desktop-only — the Rust side
// gates registration with `#[cfg(desktop)]` (see lib.rs FEAT-13 block),
// so on Android / iOS the underlying IPC will reject with "command not
// found".  Each wrapper uses a dynamic `import(...)` (matching the
// `clipboard.ts` / `relaunch-app.ts` pattern) so a plain-browser dev
// session without `__TAURI_INTERNALS__` can still resolve the module
// and surface a clean error to the caller's catch block (no module-load
// crash at app boot).
//
// Errors are propagated to the caller — the Settings UI uses the
// rejection both to (a) hide the toggle row when the plugin / IPC is
// unavailable and (b) surface a `toast.error` when a user-initiated
// enable / disable round-trip fails.

/**
 * Return whether Agaric is currently registered to launch on login.
 *
 * Rejects when the plugin is unavailable (mobile build, browser dev
 * fallback, IPC denied).  Callers that need a tri-state (enabled /
 * disabled / unavailable) view should treat the rejection as the third
 * state — see `SettingsView`'s general-tab autostart row.
 */
export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart')
  return isEnabled()
}

/**
 * Register Agaric to launch when the user signs into their computer.
 *
 * Rejects when the plugin is unavailable; the `SettingsView` toggle
 * surfaces the failure via `toast.error(t('settings.autostart.toggleFailed'))`
 * and reverts the optimistic UI update.
 */
export async function enableAutostart(): Promise<void> {
  try {
    const { enable } = await import('@tauri-apps/plugin-autostart')
    await enable()
  } catch (err) {
    logger.warn('autostart', 'enable() failed or plugin unavailable', undefined, err)
    throw err
  }
}

/**
 * Unregister Agaric from launching at login.
 *
 * Same error semantics as `enableAutostart` — the rejection is the
 * caller's signal to revert its optimistic UI update and surface
 * `t('settings.autostart.toggleFailed')`.
 */
export async function disableAutostart(): Promise<void> {
  try {
    const { disable } = await import('@tauri-apps/plugin-autostart')
    await disable()
  } catch (err) {
    logger.warn('autostart', 'disable() failed or plugin unavailable', undefined, err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Deep-link plugin wrappers (FEAT-10)
// ---------------------------------------------------------------------------
//
// `@tauri-apps/plugin-deep-link` exposes `getCurrent()` which returns the
// URL(s) the OS used to launch the app (Linux / Windows / Android), or
// `null` when the app was started normally.  Used by `useDeepLinkRouter`
// on mount to backfill any deep-link the listener missed before
// registration completed (Linux / Windows deliver the URL as a CLI arg
// before the React tree mounts).  Dynamic-import keeps a plain-browser
// dev session without `__TAURI_INTERNALS__` resolving cleanly.

/**
 * Return the URL(s) the OS used to open Agaric, or `null` if the app
 * was launched normally (no deep link).  Resolves to `null` when the
 * plugin is unavailable so callers can treat "no current URL" and
 * "plugin missing" the same way (the listener still fires on
 * subsequent activations).
 */
export async function getCurrentDeepLink(): Promise<string[] | null> {
  try {
    const { getCurrent } = await import('@tauri-apps/plugin-deep-link')
    return await getCurrent()
  } catch (err) {
    logger.warn('deeplink', 'getCurrent() failed or plugin unavailable', undefined, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Window title (FEAT-3p10) — visual-identity surface
// ---------------------------------------------------------------------------
//
// Wrapper around `@tauri-apps/api/window`'s
// `getCurrentWindow().setTitle(title)`. Used by the App-level effect
// that runs on every space change to re-stamp the OS window title as
// `"<SpaceName> · Agaric"` so the user gets a glance-able cue from the
// taskbar, the OS notification centre, and the macOS window menu.
//
// No-op fallback for non-Tauri runtimes (vitest jsdom, storybook,
// plain-browser dev sessions) so callers don't need to gate every
// `setWindowTitle(...)` call on `__TAURI_INTERNALS__` themselves. The
// dynamic import + try/catch matches the `getCurrentDeepLink` /
// `enableAutostart` pattern.

/**
 * Set the OS window title to `title`. No-op when the Tauri window
 * plugin is unavailable (jsdom, storybook, browser dev fallback).
 *
 * Failures are logged at warn level via the shared logger and
 * swallowed — a stale window title is not user-fatal and the next
 * space switch will retry.
 */
export async function setWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch (err) {
    logger.warn('window', 'setTitle() failed or window plugin unavailable', { title }, err)
  }
}
