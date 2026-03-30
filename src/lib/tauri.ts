import { invoke } from '@tauri-apps/api/core'

export type {
  BlockResponse,
  BlockRow,
  DeleteResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PurgeResponse,
  RestoreResponse,
  StatusInfo,
  TagResponse,
} from './bindings'

import type {
  BlockResponse,
  BlockRow,
  DeleteResponse,
  HistoryEntry,
  MoveResponse,
  PageResponse,
  PurgeResponse,
  RestoreResponse,
  StatusInfo,
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
}): Promise<BlockResponse> {
  return invoke('create_block', {
    blockType: params.blockType,
    content: params.content,
    parentId: params.parentId ?? null,
    position: params.position ?? null,
  })
}

/** Edit a block's text content. */
export async function editBlock(blockId: string, toText: string): Promise<BlockResponse> {
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
}): Promise<Array<{ tag_id: string; name: string; usage_count: number; updated_at: string }>> {
  return invoke('list_tags_by_prefix', {
    prefix: params.prefix,
  })
}

export async function listTagsForBlock(blockId: string): Promise<string[]> {
  return invoke('list_tags_for_block', { blockId })
}
