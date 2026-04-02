import { invoke } from '@tauri-apps/api/core'

export type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CompareOp,
  DeleteResponse,
  DiffSpan,
  DiffTag,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  SortDir,
  StatusInfo,
  TagCacheRow,
  TagResponse,
} from './bindings'

import type {
  BacklinkFilter,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  DeleteResponse,
  DiffSpan,
  GroupedBacklinkResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PropertyDefinition,
  PurgeResponse,
  RestoreResponse,
  StatusInfo,
  TagCacheRow,
  TagResponse,
} from './bindings'

// ---------------------------------------------------------------------------
// Command wrappers — type-safe Tauri invoke layer
// ---------------------------------------------------------------------------

/** Create a new block. Returns the created block with its generated ID. */
export async function createBlock(params: {
  blockType: string
  content: string
  parentId?: string
  position?: number
}): Promise<BlockRow> {
  return invoke('create_block', {
    blockType: params.blockType,
    content: params.content,
    parentId: params.parentId ?? null,
    position: params.position ?? null,
  })
}

/** Edit a block's text content. */
export async function editBlock(blockId: string, toText: string): Promise<BlockRow> {
  return invoke('edit_block', { blockId, toText })
}

/** Soft-delete a block (cascade to descendants). */
export async function deleteBlock(blockId: string): Promise<DeleteResponse> {
  return invoke('delete_block', { blockId })
}

/** Restore a soft-deleted block using its `deleted_at` timestamp as ref. */
export async function restoreBlock(
  blockId: string,
  deletedAtRef: string,
): Promise<RestoreResponse> {
  return invoke('restore_block', { blockId, deletedAtRef })
}

/** Permanently purge a block and its descendants. Irreversible. */
export async function purgeBlock(blockId: string): Promise<PurgeResponse> {
  return invoke('purge_block', { blockId })
}

/** List blocks with optional filters and cursor-based pagination. */
export async function listBlocks(params?: {
  parentId?: string
  blockType?: string
  tagId?: string
  showDeleted?: boolean
  agendaDate?: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('list_blocks', {
    parentId: params?.parentId ?? null,
    blockType: params?.blockType ?? null,
    tagId: params?.tagId ?? null,
    showDeleted: params?.showDeleted ?? null,
    agendaDate: params?.agendaDate ?? null,
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** Fetch a single block by ID. */
export async function getBlock(blockId: string): Promise<BlockRow> {
  return invoke('get_block', { blockId })
}

/** Resolved metadata for a block — lightweight alternative to full BlockRow. */
export interface ResolvedBlock {
  id: string
  title: string | null
  block_type: string
  deleted: boolean
}

/** Batch-resolve block metadata for multiple IDs in a single call. */
export async function batchResolve(ids: string[]): Promise<ResolvedBlock[]> {
  return invoke('batch_resolve', { ids })
}

/** Move a block to a new parent and/or position. */
export async function moveBlock(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): Promise<MoveResponse> {
  return invoke('move_block', { blockId, newParentId, newPosition })
}

/** Associate a tag with a block. */
export async function addTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('add_tag', { blockId, tagId })
}

/** Remove a tag association from a block. */
export async function removeTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('remove_tag', { blockId, tagId })
}

/** List blocks that link to the given block (backlinks), paginated. */
export async function getBacklinks(params: {
  blockId: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('get_backlinks', {
    blockId: params.blockId,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List op-log history for a block, paginated (newest first). */
export async function getBlockHistory(params: {
  blockId: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<HistoryEntry>> {
  return invoke('get_block_history', {
    blockId: params.blockId,
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** List conflict blocks, paginated. */
export async function getConflicts(params?: {
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('get_conflicts', {
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** Full-text search across all blocks, paginated by relevance. */
export async function searchBlocks(params?: {
  query: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('search_blocks', {
    query: params?.query ?? '',
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** Get materializer queue status and metrics. */
export async function getStatus(): Promise<StatusInfo> {
  return invoke('get_status')
}

/** Query blocks by boolean tag expression (AND/OR mode), paginated. */
export async function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('query_by_tags', {
    tagIds: params.tagIds,
    prefixes: params.prefixes,
    mode: params.mode,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List tags whose name starts with the given prefix (autocomplete). */
export async function listTagsByPrefix(params: {
  prefix: string
  limit?: number
}): Promise<TagCacheRow[]> {
  return invoke('list_tags_by_prefix', {
    prefix: params.prefix,
    limit: params.limit ?? null,
  })
}

export async function listTagsForBlock(blockId: string): Promise<string[]> {
  return invoke('list_tags_for_block', { blockId })
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
  valueText?: string | null
  valueNum?: number | null
  valueDate?: string | null
  valueRef?: string | null
}): Promise<void> {
  await invoke('set_property', {
    blockId: params.blockId,
    key: params.key,
    valueText: params.valueText ?? null,
    valueNum: params.valueNum ?? null,
    valueDate: params.valueDate ?? null,
    valueRef: params.valueRef ?? null,
  })
}

/** Delete a property from a block by key. */
export async function deleteProperty(blockId: string, key: string): Promise<void> {
  await invoke('delete_property', { blockId, key })
}

/** Get all properties for a block. */
export async function getProperties(blockId: string): Promise<PropertyRow[]> {
  return invoke('get_properties', { blockId })
}

/** Batch-fetch properties for multiple blocks in a single IPC call. */
export async function getBatchProperties(
  blockIds: string[],
): Promise<Record<string, PropertyRow[]>> {
  return invoke('get_batch_properties', { blockIds })
}

/** List global operation history (page-scoped), paginated (newest first). */
export async function listPageHistory(params: {
  pageId: string
  opTypeFilter?: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<HistoryEntry>> {
  return invoke('list_page_history', {
    pageId: params.pageId,
    opTypeFilter: params.opTypeFilter ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** Revert a batch of operations (by device_id + seq pairs). */
export async function revertOps(params: {
  ops: Array<{ device_id: string; seq: number }>
}): Promise<unknown> {
  return invoke('revert_ops', { ops: params.ops })
}

/** Query blocks by property key and optional value, with cursor pagination. */
export async function queryByProperty(params: {
  key: string
  valueText?: string
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('query_by_property', {
    key: params.key,
    valueText: params.valueText ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
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
  new_op_ref: OpRef
  new_op_type: string
  is_redo: boolean
}

/** Undo the Nth most-recent undoable op on a page. */
export async function undoPageOp(params: {
  pageId: string
  undoDepth: number
}): Promise<UndoResult> {
  return invoke('undo_page_op', {
    pageId: params.pageId,
    undoDepth: params.undoDepth,
  })
}

/** Redo a previously undone op by reversing it again. */
export async function redoPageOp(params: {
  undoDeviceId: string
  undoSeq: number
}): Promise<UndoResult> {
  return invoke('redo_page_op', {
    undoDeviceId: params.undoDeviceId,
    undoSeq: params.undoSeq,
  })
}

// ---------------------------------------------------------------------------
// Word-level diff for history display
// ---------------------------------------------------------------------------

/** Compute a word-level diff for an edit_block history entry. Returns null for non-edit ops. */
export async function computeEditDiff(params: {
  deviceId: string
  seq: number
}): Promise<DiffSpan[] | null> {
  return invoke('compute_edit_diff', {
    deviceId: params.deviceId,
    seq: params.seq,
  })
}

// ---------------------------------------------------------------------------
// Filtered backlink query commands
// ---------------------------------------------------------------------------

/** Query backlinks with composable filters, sort, and pagination. */
export async function queryBacklinksFiltered(params: {
  blockId: string
  filters?: BacklinkFilter[]
  sort?: BacklinkSort
  cursor?: string
  limit?: number
}): Promise<BacklinkQueryResponse> {
  return invoke('query_backlinks_filtered', {
    blockId: params.blockId,
    filters: params.filters ?? null,
    sort: params.sort ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** Query backlinks grouped by source page, with filters and pagination. */
export async function listBacklinksGrouped(params: {
  pageId: string
  filters?: BacklinkFilter[]
  sort?: BacklinkSort
  cursor?: string
  limit?: number
}): Promise<GroupedBacklinkResponse> {
  return invoke('list_backlinks_grouped', {
    blockId: params.pageId,
    filters: params.filters ?? null,
    sort: params.sort ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List all distinct property keys currently in use. */
export async function listPropertyKeys(): Promise<string[]> {
  return invoke('list_property_keys')
}

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

/** Create a new property definition. */
export async function createPropertyDef(params: {
  key: string
  valueType: string
  options?: string | null
}): Promise<PropertyDefinition> {
  return invoke('create_property_def', {
    key: params.key,
    valueType: params.valueType,
    options: params.options ?? null,
  })
}

/** List all property definitions. */
export async function listPropertyDefs(): Promise<PropertyDefinition[]> {
  return invoke('list_property_defs')
}

/** Update the options JSON for a select-type property definition. */
export async function updatePropertyDefOptions(
  key: string,
  options: string,
): Promise<PropertyDefinition> {
  return invoke('update_property_def_options', { key, options })
}

/** Delete a property definition by key. */
export async function deletePropertyDef(key: string): Promise<void> {
  return invoke('delete_property_def', { key })
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
}

/** List all known peer references. */
export async function listPeerRefs(): Promise<PeerRefRow[]> {
  return invoke('list_peer_refs')
}

/** Fetch a single peer reference by ID, or null if not found. */
export async function getPeerRef(peerId: string): Promise<PeerRefRow | null> {
  return invoke('get_peer_ref', { peerId })
}

/** Delete a peer reference by ID. */
export async function deletePeerRef(peerId: string): Promise<void> {
  return invoke('delete_peer_ref', { peerId })
}

/** Update the display name for a paired peer. Pass null to clear. */
export async function updatePeerName(peerId: string, deviceName: string | null): Promise<void> {
  return invoke('update_peer_name', { peerId, deviceName })
}

/** Get the local device ID. */
export async function getDeviceId(): Promise<string> {
  return invoke('get_device_id')
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

/** Start the pairing flow — returns a passphrase, QR SVG, and listener port. */
export async function startPairing(): Promise<{
  passphrase: string
  qr_svg: string
  port: number
}> {
  return invoke('start_pairing')
}

/** Confirm a pairing with the given passphrase and remote device ID. */
export async function confirmPairing(passphrase: string, remoteDeviceId: string): Promise<void> {
  return invoke('confirm_pairing', { passphrase, remoteDeviceId })
}

/** Cancel an in-progress pairing. */
export async function cancelPairing(): Promise<void> {
  return invoke('cancel_pairing')
}

/** Start a sync session with a known peer. */
export async function startSync(peerId: string): Promise<SyncSessionInfo> {
  return invoke('start_sync', { peerId })
}

/** Cancel an in-progress sync session. */
export async function cancelSync(): Promise<void> {
  return invoke('cancel_sync')
}
