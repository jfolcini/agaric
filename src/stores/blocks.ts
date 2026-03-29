/**
 * Block store — Zustand state for the block tree (ADR-01).
 *
 * Manages the in-memory block list, focused block, and CRUD operations.
 * All mutations go through Tauri commands and update local state on success.
 */

import { create } from 'zustand'
import type { BlockRow, PageResponse } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, listBlocks, moveBlock } from '../lib/tauri'

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

  /** Reorder: move block to a new index within its sibling list. */
  reorder: (blockId: string, newIndex: number) => Promise<void>

  /** Indent: make block a child of its previous sibling. */
  indent: (blockId: string) => Promise<void>
  /** Dedent: move block up one level to grandparent. */
  dedent: (blockId: string) => Promise<void>
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

  reorder: async (blockId: string, newIndex: number) => {
    const { blocks } = get()
    const oldIndex = blocks.findIndex((b) => b.id === blockId)
    if (oldIndex < 0 || oldIndex === newIndex) return

    const block = blocks[oldIndex]
    const parentId = block.parent_id

    // Calculate new position based on where the block will end up after
    // arrayMove semantics (splice-remove at oldIndex, splice-insert at newIndex).
    //
    // Forward move (newIndex > oldIndex): block ends up AFTER blocks[newIndex]
    //   in the original array, because removing it from before shifts everything left.
    // Backward move (newIndex < oldIndex): block ends up BEFORE blocks[newIndex].
    let newPosition: number
    if (newIndex > oldIndex) {
      // Forward move: block lands after blocks[newIndex]
      if (newIndex >= blocks.length - 1) {
        // After the last block
        newPosition = (blocks[blocks.length - 1].position ?? 0) + 1
      } else {
        // Between blocks[newIndex] and blocks[newIndex + 1]
        const beforePos = blocks[newIndex].position ?? 0
        const afterPos = blocks[newIndex + 1].position ?? 0
        newPosition = Math.floor((beforePos + afterPos) / 2)
        // If floor lands on beforePos (consecutive integers), nudge up
        if (newPosition <= beforePos) {
          newPosition = beforePos + 1
        }
      }
    } else {
      // Backward move: block lands before blocks[newIndex]
      if (newIndex === 0) {
        // Before the first block
        newPosition = (blocks[0].position ?? 0) - 1
      } else {
        // Between blocks[newIndex - 1] and blocks[newIndex]
        const beforePos = blocks[newIndex - 1].position ?? 0
        const afterPos = blocks[newIndex].position ?? 0
        newPosition = Math.floor((beforePos + afterPos) / 2)
        // If floor lands on beforePos (consecutive integers), nudge up
        if (newPosition <= beforePos) {
          newPosition = beforePos + 1
        }
      }
    }

    try {
      await moveBlock(blockId, parentId, newPosition)
      // Reorder the local array using arrayMove semantics:
      // splice-remove at oldIndex, splice-insert at newIndex.
      const newBlocks = [...blocks]
      const [moved] = newBlocks.splice(oldIndex, 1)
      newBlocks.splice(newIndex, 0, {
        ...moved,
        position: newPosition,
      })
      set({ blocks: newBlocks })
    } catch {
      // Silently fail
    }
  },

  indent: async (blockId: string) => {
    const { blocks } = get()
    const idx = blocks.findIndex((b) => b.id === blockId)
    if (idx <= 0) return // First block or not found — can't indent

    const block = blocks[idx]
    const prevSibling = blocks[idx - 1]

    // Only indent if previous block is a sibling (same parent)
    if (block.parent_id !== prevSibling.parent_id) return

    // Move block to be a child of previous sibling, position 0
    try {
      await moveBlock(blockId, prevSibling.id, 0)
      set((state) => ({
        blocks: state.blocks.map((b) =>
          b.id === blockId ? { ...b, parent_id: prevSibling.id, position: 0 } : b,
        ),
      }))
    } catch {
      // Silently fail
    }
  },

  dedent: async (blockId: string) => {
    const { blocks } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block?.parent_id) return // Already at root — can't dedent

    // Find the parent block to get grandparent info
    const parent = blocks.find((b) => b.id === block.parent_id)
    if (!parent) return

    // Move to grandparent, position after the parent
    const newParentId = parent.parent_id
    const newPosition = (parent.position ?? 0) + 1
    try {
      await moveBlock(blockId, newParentId, newPosition)
      set((state) => ({
        blocks: state.blocks.map((b) =>
          b.id === blockId ? { ...b, parent_id: newParentId, position: newPosition } : b,
        ),
      }))
    } catch {
      // Silently fail
    }
  },
}))
