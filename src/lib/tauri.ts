import { invoke } from '@tauri-apps/api/core'

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

/** Create a new block. Returns the created block with its generated ID. */
export function createBlock(params: {
  blockType: string
  content: string
  parentId?: string | undefined
  position?: number | undefined
}): Promise<BlockRow> {
  return invoke('create_block', {
    blockType: params.blockType,
    content: params.content,
    parentId: params.parentId ?? null,
    position: params.position ?? null,
  })
}

/** Edit a block's text content. */
export function editBlock(blockId: string, toText: string): Promise<BlockRow> {
  return invoke('edit_block', { blockId, toText })
}

/** Soft-delete a block (cascade to descendants). */
export function deleteBlock(blockId: string): Promise<DeleteResponse> {
  return invoke('delete_block', { blockId })
}

/** Restore a soft-deleted block using its `deleted_at` timestamp as ref. */
export function restoreBlock(blockId: string, deletedAtRef: string): Promise<RestoreResponse> {
  return invoke('restore_block', { blockId, deletedAtRef })
}

/** Permanently purge a block and its descendants. Irreversible. */
export function purgeBlock(blockId: string): Promise<PurgeResponse> {
  return invoke('purge_block', { blockId })
}

export interface BulkTrashResponse {
  affected_count: number
}

/** Restore all soft-deleted blocks. Returns count of restored blocks. */
export function restoreAllDeleted(): Promise<BulkTrashResponse> {
  return invoke('restore_all_deleted')
}

/** Permanently purge all soft-deleted blocks. Irreversible. */
export function purgeAllDeleted(): Promise<BulkTrashResponse> {
  return invoke('purge_all_deleted')
}

/**
 * Batch-count cascade-deleted descendants per trash root.
 *
 * Given a list of trash-root IDs (as returned by `listBlocks({ showDeleted: true })`),
 * returns a map of `root_id -> descendant_count`. Descendants are blocks sharing
 * the root's `deleted_at` timestamp, excluding the root itself and conflict copies.
 * Roots with zero descendants are omitted — treat missing keys as `0`.
 */
export function trashDescendantCounts(rootIds: string[]): Promise<Record<string, number>> {
  return invoke('trash_descendant_counts', { rootIds })
}

/** List blocks with optional filters and cursor-based pagination. */
export function listBlocks(params?: {
  parentId?: string | undefined
  blockType?: string | undefined
  tagId?: string | undefined
  showDeleted?: boolean | undefined
  agendaDate?: string | undefined
  agendaDateRange?: DateRange | undefined
  agendaSource?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('list_blocks', {
    parentId: params?.parentId ?? null,
    blockType: params?.blockType ?? null,
    tagId: params?.tagId ?? null,
    showDeleted: params?.showDeleted ?? null,
    agendaDate: params?.agendaDate ?? null,
    agendaDateRange: params?.agendaDateRange ?? null,
    agendaSource: params?.agendaSource ?? null,
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** List undated tasks (tasks with todo_state but no due/scheduled date). */
export function listUndatedTasks(params?: {
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('list_undated_tasks', {
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** List projected future occurrences of repeating tasks for a date range. */
export function listProjectedAgenda(opts: {
  startDate: string
  endDate: string
  limit?: number | undefined
}): Promise<ProjectedAgendaEntry[]> {
  return invoke('list_projected_agenda', {
    startDate: opts.startDate,
    endDate: opts.endDate,
    limit: opts.limit ?? null,
  })
}

/** Fetch a single block by ID. */
export function getBlock(blockId: string): Promise<BlockRow> {
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
export function batchResolve(ids: string[]): Promise<ResolvedBlock[]> {
  return invoke('batch_resolve', { ids })
}

/** Move a block to a new parent and/or position. */
export function moveBlock(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): Promise<MoveResponse> {
  return invoke('move_block', { blockId, newParentId, newPosition })
}

/** Associate a tag with a block. */
export function addTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('add_tag', { blockId, tagId })
}

/** Remove a tag association from a block. */
export function removeTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('remove_tag', { blockId, tagId })
}

/** List blocks that link to the given block (backlinks), paginated. */
export function getBacklinks(params: {
  blockId: string
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('get_backlinks', {
    blockId: params.blockId,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List op-log history for a block, paginated (newest first). */
export function getBlockHistory(params: {
  blockId: string
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return invoke('get_block_history', {
    blockId: params.blockId,
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** List conflict blocks, paginated. */
export function getConflicts(params?: {
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('get_conflicts', {
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** Full-text search across all blocks, paginated by relevance. */
export function searchBlocks(params?: {
  query: string
  parentId?: string | undefined
  tagIds?: string[] | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('search_blocks', {
    query: params?.query ?? '',
    parentId: params?.parentId ?? null,
    tagIds: params?.tagIds ?? null,
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

/** Get materializer queue status and metrics. */
export function getStatus(): Promise<StatusInfo> {
  return invoke('get_status')
}

/** Query blocks by boolean tag expression (AND/OR mode), paginated. */
export function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('query_by_tags', {
    tagIds: params.tagIds,
    prefixes: params.prefixes,
    mode: params.mode,
    includeInherited: params.includeInherited ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List tags whose name starts with the given prefix (autocomplete). */
export function listTagsByPrefix(params: {
  prefix: string
  limit?: number | undefined
}): Promise<TagCacheRow[]> {
  return invoke('list_tags_by_prefix', {
    prefix: params.prefix,
    limit: params.limit ?? null,
  })
}

export function listTagsForBlock(blockId: string): Promise<string[]> {
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
export function setProperty(params: {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
}): Promise<BlockRow> {
  return invoke('set_property', {
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
export function getProperties(blockId: string): Promise<PropertyRow[]> {
  return invoke('get_properties', { blockId })
}

/** Batch-fetch properties for multiple blocks in a single IPC call. */
export function getBatchProperties(blockIds: string[]): Promise<Record<string, PropertyRow[]>> {
  return invoke('get_batch_properties', { blockIds })
}

// ---------------------------------------------------------------------------
// Batch count commands (#604)
// ---------------------------------------------------------------------------

/** Batch-count agenda items per date. Returns a map of date -> count. */
export function countAgendaBatch(params: { dates: string[] }): Promise<Record<string, number>> {
  return invoke('count_agenda_batch', { dates: params.dates })
}

/** Batch-count agenda items per (date, source). Returns nested map: date -> source -> count. */
export function countAgendaBatchBySource(params: {
  dates: string[]
}): Promise<Record<string, Record<string, number>>> {
  return invoke('count_agenda_batch_by_source', { dates: params.dates })
}

/** Batch-count backlinks per target page. Returns a map of pageId -> count. */
export function countBacklinksBatch(params: {
  pageIds: string[]
}): Promise<Record<string, number>> {
  return invoke('count_backlinks_batch', { pageIds: params.pageIds })
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Set or clear the todo state on a block. Pass null to clear. */
export function setTodoState(blockId: string, state: string | null): Promise<BlockRow> {
  return invoke('set_todo_state', { blockId, state })
}

/** Set or clear the priority level on a block. Pass null to clear. */
export function setPriority(blockId: string, level: string | null): Promise<BlockRow> {
  return invoke('set_priority', { blockId, level })
}

/** Set or clear the due date on a block. Pass null to clear. */
export function setDueDate(blockId: string, date: string | null): Promise<BlockRow> {
  return invoke('set_due_date', { blockId, date })
}

/** Set or clear the scheduled date on a block. Pass null to clear. */
export function setScheduledDate(blockId: string, date: string | null): Promise<BlockRow> {
  return invoke('set_scheduled_date', { blockId, date })
}

/** List global operation history (page-scoped), paginated (newest first). */
export function listPageHistory(params: {
  pageId: string
  opTypeFilter?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return invoke('list_page_history', {
    pageId: params.pageId,
    opTypeFilter: params.opTypeFilter ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List all page-to-page links for graph visualization. */
export function listPageLinks(): Promise<
  Array<{ source_id: string; target_id: string; ref_count: number }>
> {
  return invoke('list_page_links')
}

/** Revert a batch of operations (by device_id + seq pairs). */
export function revertOps(params: {
  ops: Array<{ device_id: string; seq: number }>
}): Promise<unknown> {
  return invoke('revert_ops', { ops: params.ops })
}

/** Restore a page to its state at a specific operation (point-in-time restore). */
export function restorePageToOp(params: {
  pageId: string
  targetDeviceId: string
  targetSeq: number
}): Promise<{ ops_reverted: number; non_reversible_skipped: number; results: unknown[] }> {
  return invoke('restore_page_to_op', {
    pageId: params.pageId,
    targetDeviceId: params.targetDeviceId,
    targetSeq: params.targetSeq,
  })
}

/** Query blocks by property key and optional value, with cursor pagination. */
export function queryByProperty(params: {
  key: string
  valueText?: string | undefined
  valueDate?: string | undefined
  operator?: string | undefined // 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<PageResponse<BlockRow>> {
  return invoke('query_by_property', {
    key: params.key,
    valueText: params.valueText ?? null,
    valueDate: params.valueDate ?? null,
    operator: params.operator ?? null,
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
  reversed_op_type: string
  new_op_ref: OpRef
  new_op_type: string
  is_redo: boolean
}

/** Undo the Nth most-recent undoable op on a page. */
export function undoPageOp(params: { pageId: string; undoDepth: number }): Promise<UndoResult> {
  return invoke('undo_page_op', {
    pageId: params.pageId,
    undoDepth: params.undoDepth,
  })
}

/** Redo a previously undone op by reversing it again. */
export function redoPageOp(params: { undoDeviceId: string; undoSeq: number }): Promise<UndoResult> {
  return invoke('redo_page_op', {
    undoDeviceId: params.undoDeviceId,
    undoSeq: params.undoSeq,
  })
}

// ---------------------------------------------------------------------------
// Word-level diff for history display
// ---------------------------------------------------------------------------

/** Compute a word-level diff for an edit_block history entry. Returns null for non-edit ops. */
export function computeEditDiff(params: {
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
export function queryBacklinksFiltered(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: number | undefined
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
export function listBacklinksGrouped(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: number | undefined
}): Promise<GroupedBacklinkResponse> {
  return invoke('list_backlinks_grouped', {
    blockId: params.blockId,
    filters: params.filters ?? null,
    sort: params.sort ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** Query unlinked references grouped by source page, with filters, sort, and pagination. */
export function listUnlinkedReferences(params: {
  pageId: string
  filters?: BacklinkFilter[] | null | undefined
  sort?: BacklinkSort | null | undefined
  cursor?: string | null | undefined
  limit?: number | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return invoke('list_unlinked_references', {
    pageId: params.pageId,
    filters: params.filters ?? null,
    sort: params.sort ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  })
}

/** List all distinct property keys currently in use. */
export function listPropertyKeys(): Promise<string[]> {
  return invoke('list_property_keys')
}

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

/** Create a new property definition. */
export function createPropertyDef(params: {
  key: string
  valueType: string
  options?: string | null | undefined
}): Promise<PropertyDefinition> {
  return invoke('create_property_def', {
    key: params.key,
    valueType: params.valueType,
    options: params.options ?? null,
  })
}

/** List all property definitions. */
export function listPropertyDefs(): Promise<PropertyDefinition[]> {
  return invoke('list_property_defs')
}

/** Update the options JSON for a select-type property definition. */
export function updatePropertyDefOptions(
  key: string,
  options: string,
): Promise<PropertyDefinition> {
  return invoke('update_property_def_options', { key, options })
}

/** Delete a property definition by key. */
export function deletePropertyDef(key: string): Promise<void> {
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
  last_address: string | null
}

/** List all known peer references. */
export function listPeerRefs(): Promise<PeerRefRow[]> {
  return invoke('list_peer_refs')
}

/** Fetch a single peer reference by ID, or null if not found. */
export function getPeerRef(peerId: string): Promise<PeerRefRow | null> {
  return invoke('get_peer_ref', { peerId })
}

/** Delete a peer reference by ID. */
export function deletePeerRef(peerId: string): Promise<void> {
  return invoke('delete_peer_ref', { peerId })
}

/** Update the display name for a paired peer. Pass null to clear. */
export function updatePeerName(peerId: string, deviceName: string | null): Promise<void> {
  return invoke('update_peer_name', { peerId, deviceName })
}

/** Manually set a peer's network address (host:port) for direct connection. */
export function setPeerAddress(peerId: string, address: string): Promise<void> {
  return invoke('set_peer_address', { peerId, address })
}

/** Get the local device ID. */
export function getDeviceId(): Promise<string> {
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
export function startPairing(): Promise<{
  passphrase: string
  qr_svg: string
  port: number
}> {
  return invoke('start_pairing')
}

/** Confirm a pairing with the given passphrase and remote device ID. */
export function confirmPairing(passphrase: string, remoteDeviceId: string): Promise<void> {
  return invoke('confirm_pairing', { passphrase, remoteDeviceId })
}

/** Cancel an in-progress pairing. */
export function cancelPairing(): Promise<void> {
  return invoke('cancel_pairing')
}

/** Start a sync session with a known peer. */
export function startSync(peerId: string): Promise<SyncSessionInfo> {
  return invoke('start_sync', { peerId })
}

/** Cancel an in-progress sync session. */
export function cancelSync(): Promise<void> {
  return invoke('cancel_sync')
}

// ---------------------------------------------------------------------------
// Page alias commands (#598)
// ---------------------------------------------------------------------------

/** Set the complete list of aliases for a page (replaces existing). */
export function setPageAliases(pageId: string, aliases: string[]): Promise<string[]> {
  return invoke('set_page_aliases', { pageId, aliases })
}

/** Get all aliases for a page. */
export function getPageAliases(pageId: string): Promise<string[]> {
  return invoke('get_page_aliases', { pageId })
}

/** Resolve a page by one of its aliases. Returns page ID + title, or null. */
export function resolvePageByAlias(alias: string): Promise<[string, string | null] | null> {
  return invoke('resolve_page_by_alias', { alias })
}

// ---------------------------------------------------------------------------
// Markdown export (#519)
// ---------------------------------------------------------------------------

/** Export a page as Markdown with human-readable tag/page references. */
export function exportPageMarkdown(pageId: string): Promise<string> {
  return invoke('export_page_markdown', { pageId })
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
export function listAttachments(blockId: string): Promise<AttachmentRow[]> {
  return invoke('list_attachments', { blockId })
}

/** Add an attachment to a block. */
export function addAttachment(params: {
  blockId: string
  filename: string
  mimeType: string
  sizeBytes: number
  fsPath: string
}): Promise<AttachmentRow> {
  return invoke('add_attachment', {
    blockId: params.blockId,
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    fsPath: params.fsPath,
  })
}

/** Delete an attachment by ID. */
export function deleteAttachment(attachmentId: string): Promise<void> {
  return invoke('delete_attachment', { attachmentId })
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
export function importMarkdown(
  content: string,
  filename?: string | undefined,
): Promise<ImportResult> {
  return invoke('import_markdown', { content, filename: filename ?? null })
}

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------

/** Save (upsert) a draft for a block. Called every ~2s during active typing. */
export async function saveDraft(blockId: string, content: string): Promise<void> {
  await invoke('save_draft', { blockId, content })
}

/** Flush a draft: write an edit_block op and delete the draft row. Called on blur/unmount. */
export async function flushDraft(blockId: string): Promise<void> {
  await invoke('flush_draft', { blockId })
}

/** Delete a draft for a block (e.g. after a successful normal save). */
export async function deleteDraft(blockId: string): Promise<void> {
  await invoke('delete_draft', { blockId })
}

/** List all drafts, ordered by updated_at ascending. */
export function listDrafts(): Promise<Draft[]> {
  return invoke('list_drafts')
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
  await invoke('log_frontend', {
    level,
    module,
    message,
    stack: stack ?? null,
    context: context ?? null,
    data: data ?? null,
  })
}

/** Return the path to the logs directory. */
export function getLogDir(): Promise<string> {
  return invoke('get_log_dir') as Promise<string>
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
export function getCompactionStatus(): Promise<CompactionStatus> {
  return invoke('get_compaction_status')
}

/** Compact the op log by removing ops older than retentionDays. */
export function compactOpLog(retentionDays: number): Promise<CompactionResult> {
  return invoke('compact_op_log_cmd', { retentionDays })
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
export function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  return invoke('fetch_link_metadata', { url })
}

/** Get cached link metadata (no network fetch). */
export function getLinkMetadata(url: string): Promise<LinkMetadata | null> {
  return invoke('get_link_metadata', { url })
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
export function collectBugReportMetadata(): Promise<BugReport> {
  return invoke('collect_bug_report_metadata')
}

/**
 * Enumerate rolled log files within the last 7 days. When `redact=true`,
 * home paths are replaced with `~`, the device ID is blanked, and long
 * lines are truncated.
 */
export function readLogsForReport(redact: boolean): Promise<LogFileEntry[]> {
  return invoke('read_logs_for_report', { redact })
}
