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

// Command wrappers
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

export async function editBlock(blockId: string, toText: string): Promise<BlockResponse> {
  return invoke('edit_block', { blockId, toText })
}

export async function deleteBlock(blockId: string): Promise<DeleteResponse> {
  return invoke('delete_block', { blockId })
}

export async function restoreBlock(
  blockId: string,
  deletedAtRef: string,
): Promise<RestoreResponse> {
  return invoke('restore_block', { blockId, deletedAtRef })
}

export async function purgeBlock(blockId: string): Promise<PurgeResponse> {
  return invoke('purge_block', { blockId })
}

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

export async function getBlock(blockId: string): Promise<BlockRow> {
  return invoke('get_block', { blockId })
}

export async function moveBlock(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): Promise<MoveResponse> {
  return invoke('move_block', { blockId, newParentId, newPosition })
}

export async function addTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('add_tag', { blockId, tagId })
}

export async function removeTag(blockId: string, tagId: string): Promise<TagResponse> {
  return invoke('remove_tag', { blockId, tagId })
}

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

export async function getConflicts(params?: {
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('get_conflicts', {
    cursor: params?.cursor ?? null,
    limit: params?.limit ?? null,
  })
}

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

export async function getStatus(): Promise<StatusInfo> {
  return invoke('get_status')
}
