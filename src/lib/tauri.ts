import { invoke } from '@tauri-apps/api/core'

// Response types matching Rust structs
export interface BlockResponse {
  id: string
  block_type: string
  content: string | null
  parent_id: string | null
  position: number | null
  deleted_at: string | null
}

export interface BlockRow {
  id: string
  block_type: string
  content: string | null
  parent_id: string | null
  position: number | null
  deleted_at: string | null
  archived_at: string | null
  is_conflict: boolean
}

export interface PageResponse<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
}

export interface DeleteResponse {
  block_id: string
  deleted_at: string
  descendants_affected: number
}

export interface RestoreResponse {
  block_id: string
  restored_count: number
}

export interface PurgeResponse {
  block_id: string
  purged_count: number
}

export interface MoveResponse {
  block_id: string
  new_parent_id: string | null
  new_position: number
}

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
  cursor?: string
  limit?: number
}): Promise<PageResponse<BlockRow>> {
  return invoke('list_blocks', {
    parentId: params?.parentId ?? null,
    blockType: params?.blockType ?? null,
    tagId: params?.tagId ?? null,
    showDeleted: params?.showDeleted ?? null,
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
