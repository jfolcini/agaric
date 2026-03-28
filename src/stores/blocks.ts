/**
 * Block store — Zustand state for the block tree (ADR-01).
 *
 * Manages the in-memory block list, focused block, and CRUD operations.
 * All mutations go through Tauri commands and update local state on success.
 */

import { create } from 'zustand'
import type { BlockRow, PageResponse } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, listBlocks } from '../lib/tauri'

interface BlockStore {
  /** Ordered list of blocks for the current view. */
  blocks: BlockRow[]
  /** ID of the currently focused/editing block, or null. */
  focusedBlockId: string | null
  /** Loading state. */
  loading: boolean

  /** Load blocks from the backend. */
  load: (parentId?: string) => Promise<void>
  /** Set which block is focused. */
  setFocused: (blockId: string | null) => void

  /** Create a new block below the given block. Returns the new block ID. */
  createBelow: (afterBlockId: string, content?: string) => Promise<string | null>
  /** Edit a block's content. */
  edit: (blockId: string, content: string) => Promise<void>
  /** Delete a block. */
  remove: (blockId: string) => Promise<void>

  /**
   * Auto-split: given a block ID and markdown with newlines, split into
   * multiple blocks. First line edits the original, subsequent lines
   * create new blocks below.
   */
  splitBlock: (blockId: string, markdown: string) => Promise<void>
}

export const useBlockStore = create<BlockStore>((set, get) => ({
  blocks: [],
  focusedBlockId: null,
  loading: false,

  load: async (parentId?: string) => {
    set({ loading: true })
    try {
      const response: PageResponse<BlockRow> = await listBlocks({ parentId })
      set({ blocks: response.items, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setFocused: (blockId: string | null) => {
    set({ focusedBlockId: blockId })
  },

  createBelow: async (afterBlockId: string, content = '') => {
    const { blocks } = get()
    const idx = blocks.findIndex((b) => b.id === afterBlockId)
    const afterBlock = blocks[idx]
    if (!afterBlock) return null

    try {
      const result = await createBlock({
        blockType: 'text',
        content,
        parentId: afterBlock.parent_id ?? undefined,
        position: (afterBlock.position ?? 0) + 1,
      })

      // Insert the new block into the local array
      const newBlock: BlockRow = {
        id: result.id,
        block_type: result.block_type,
        content: result.content,
        parent_id: result.parent_id,
        position: result.position,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
      }
      const newBlocks = [...blocks]
      newBlocks.splice(idx + 1, 0, newBlock)
      set({ blocks: newBlocks })
      return result.id
    } catch {
      return null
    }
  },

  edit: async (blockId: string, content: string) => {
    try {
      await editBlock(blockId, content)
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? { ...b, content } : b)),
      }))
    } catch {
      // Silently fail — content is already in the editor
    }
  },

  remove: async (blockId: string) => {
    try {
      await deleteBlock(blockId)
      set((state) => ({
        blocks: state.blocks.filter((b) => b.id !== blockId),
        focusedBlockId: state.focusedBlockId === blockId ? null : state.focusedBlockId,
      }))
    } catch {
      // Silently fail
    }
  },

  splitBlock: async (blockId: string, markdown: string) => {
    const lines = markdown.split('\n')
    if (lines.length <= 1) return

    // First line: edit the original block
    const [first, ...rest] = lines
    await get().edit(blockId, first)

    // Subsequent lines: create new blocks below, in order
    let lastId = blockId
    for (const line of rest) {
      const newId = await get().createBelow(lastId, line)
      if (newId) lastId = newId
    }
  },
}))
