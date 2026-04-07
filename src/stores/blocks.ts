/**
 * Block focus & selection store — global Zustand singleton.
 *
 * After R-18 split: per-page data (blocks, loading, mutations) lives in
 * PageBlockStore (per-instance via context in page-blocks.ts).
 * This store holds only the cross-page focus/selection state:
 * - Which block is focused (only one at a time across all pages)
 * - Which blocks are selected (multi-select)
 *
 * Selection actions that need block lists (selectAll, rangeSelect)
 * take visibleIds as a parameter since blocks live in per-page stores.
 */

import { create } from 'zustand'
import type { FlatBlock } from '../lib/tree-utils'

export type { FlatBlock }

interface BlockStore {
  /** ID of the currently focused/editing block, or null. */
  focusedBlockId: string | null
  /** IDs of currently selected blocks (multi-select). */
  selectedBlockIds: string[]

  /** Set which block is focused (clears selection). */
  setFocused: (blockId: string | null) => void

  /** Toggle a block in/out of the selection (Ctrl+Click). */
  toggleSelected: (blockId: string) => void
  /**
   * Extend selection from the last selected to the given block (Shift+Click).
   * Requires the visible block IDs from the per-page store.
   */
  rangeSelect: (blockId: string, visibleIds: string[]) => void
  /**
   * Select all blocks (Ctrl+A when not editing).
   * Requires the visible block IDs from the per-page store.
   */
  selectAll: (visibleIds: string[]) => void
  /** Clear the selection. */
  clearSelected: () => void
  /** Replace the selection with the given IDs. */
  setSelected: (ids: string[]) => void
}

export const useBlockStore = create<BlockStore>((set) => ({
  focusedBlockId: null,
  selectedBlockIds: [],

  setFocused: (blockId: string | null) => {
    set({ focusedBlockId: blockId, selectedBlockIds: [] })
  },

  toggleSelected: (blockId) => {
    set((state) => {
      const ids = state.selectedBlockIds
      const idx = ids.indexOf(blockId)
      if (idx >= 0) {
        return { selectedBlockIds: ids.filter((id) => id !== blockId) }
      }
      return { selectedBlockIds: [...ids, blockId] }
    })
  },

  rangeSelect: (blockId, visibleIds) => {
    set((state) => {
      const { selectedBlockIds } = state
      if (selectedBlockIds.length === 0) {
        return { selectedBlockIds: [blockId] }
      }
      const lastSelected = selectedBlockIds[selectedBlockIds.length - 1] as string
      const lastIdx = visibleIds.indexOf(lastSelected)
      const targetIdx = visibleIds.indexOf(blockId)
      if (lastIdx < 0 || targetIdx < 0) {
        return { selectedBlockIds: [blockId] }
      }
      const start = Math.min(lastIdx, targetIdx)
      const end = Math.max(lastIdx, targetIdx)
      const rangeIds = visibleIds.slice(start, end + 1)
      const merged = [...new Set([...selectedBlockIds, ...rangeIds])]
      return { selectedBlockIds: merged }
    })
  },

  selectAll: (visibleIds) => {
    set({ selectedBlockIds: visibleIds })
  },

  clearSelected: () => {
    set({ selectedBlockIds: [] })
  },

  setSelected: (ids) => {
    set({ selectedBlockIds: ids })
  },
}))
