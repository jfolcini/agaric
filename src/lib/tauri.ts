import { commands } from './bindings'
import { logger } from './logger'

export type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CompareOp,
  DateRange,
  DeleteResponse,
  DiffSpan,
  DiffTag,
  Draft,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  SortDir,
  SpaceRow,
  StatusInfo,
  TagCacheRow,
  TagResponse,
} from './bindings'

import type {
  BacklinkFilter,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  DateRange,
  DeleteResponse,
  DiffSpan,
  Draft,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  SpaceRow,
  StatusInfo,
  TagCacheRow,
  TagResponse,
} from './bindings'

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
      params.spaceId ?? null,
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
      params?.spaceId ?? null,
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
      opts.spaceId ?? null,
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
  return unwrap(await commands.batchResolve(ids, spaceId ?? null))
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
      params.spaceId ?? null,
    ),
  )
}

/** List op-log history for a block, paginated (newest first). */
export async function getBlockHistory(params: {
  blockId: string
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return unwrap(
    await commands.getBlockHistory(params.blockId, params.cursor ?? null, params.limit ?? null),
  )
}

/** List conflict blocks, paginated. */
export async function getConflicts(params?: {
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(await commands.getConflicts(params?.cursor ?? null, params?.limit ?? null))
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
 */
export async function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByTags(
      params.tagIds,
      params.prefixes,
      params.mode,
      params.includeInherited ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      params.spaceId ?? null,
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
}

/** Set (upsert) a property on a block. Exactly one value field must be non-null. */
export async function setProperty(params: {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
}): Promise<BlockRow> {
  return unwrap(
    await commands.setProperty(
      params.blockId,
      params.key,
      params.valueText ?? null,
      params.valueNum ?? null,
      params.valueDate ?? null,
      params.valueRef ?? null,
    ),
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
  return unwrap(await commands.countAgendaBatch(params.dates, params.spaceId ?? null))
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
  return unwrap(await commands.countAgendaBatchBySource(params.dates, params.spaceId ?? null))
}

/** Batch-count backlinks per target page. Returns a map of pageId -> count. */
export async function countBacklinksBatch(params: {
  pageIds: string[]
}): Promise<Record<string, number>> {
  return unwrap(await commands.countBacklinksBatch(params.pageIds))
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Set or clear the todo state on a block. Pass null to clear. */
export async function setTodoState(blockId: string, state: string | null): Promise<BlockRow> {
  return unwrap(await commands.setTodoState(blockId, state))
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
      params.spaceId ?? null,
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
 */
export async function listPageLinks(
  spaceId?: string | null | undefined,
): Promise<Array<{ source_id: string; target_id: string; ref_count: number }>> {
  return unwrap(await commands.listPageLinks(spaceId ?? null))
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
}): Promise<{ ops_reverted: number; non_reversible_skipped: number; results: unknown[] }> {
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
export async function queryByProperty(params: {
  key: string
  valueText?: string | undefined
  valueDate?: string | undefined
  operator?: string | undefined // 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
  cursor?: string | undefined
  limit?: number | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByProperty(
      params.key,
      params.valueText ?? null,
      params.valueDate ?? null,
      params.operator ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      params.spaceId ?? null,
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
      params.spaceId ?? null,
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
      params.spaceId ?? null,
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
      params.spaceId ?? null,
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
export async function startSync(peerId: string): Promise<SyncSessionInfo> {
  return unwrap(await commands.startSync(peerId))
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

/** Resolve a page by one of its aliases. Returns page ID + title, or null. */
export async function resolvePageByAlias(alias: string): Promise<[string, string | null] | null> {
  return unwrap(await commands.resolvePageByAlias(alias))
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
 * Batch-fetch attachment counts for many blocks in one IPC.
 *
 * Returns a record mapping block_id → count. Block IDs absent from the
 * record have either 0 attachments or are not in the database; callers
 * should default missing keys to 0.
 *
 * MAINT-131 — replaces N per-block `listAttachments` IPCs for badge
 * counts in `SortableBlock` with a single batched query.
 */
export async function getBatchAttachmentCounts(
  blockIds: string[],
): Promise<Record<string, number>> {
  return unwrap(await commands.getBatchAttachmentCounts(blockIds))
}

/**
 * Batch-fetch full attachment lists for many blocks in one IPC.
 *
 * Returns a record mapping block_id → AttachmentRow[]. Block IDs absent
 * from the record have either 0 attachments or are not in the database;
 * callers should default missing keys to `[]`.
 *
 * MAINT-131 StaticBlock half — replaces N per-block `listAttachments`
 * IPCs for inline-image-render decisions in `StaticBlock` with a single
 * batched query mounted at the BlockTree level.
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

/** Import a Logseq/Markdown file. Creates a page from the filename and blocks from content. */
export async function importMarkdown(
  content: string,
  filename?: string | undefined,
): Promise<ImportResult> {
  return unwrap(await commands.importMarkdown(content, filename ?? null))
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
