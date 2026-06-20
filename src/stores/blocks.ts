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

/** Direction for keyboard range extension (#922). */
export type ExtendDirection = 'up' | 'down'

interface BlockStore {
  /** ID of the currently focused/editing block, or null. */
  focusedBlockId: string | null
  /** IDs of currently selected blocks (multi-select). */
  selectedBlockIds: string[]
  /**
   * Fixed end of a keyboard range selection (#922). Shift+Arrow grows/shrinks
   * the selection between this anchor and a moving "focus" end. Null when no
   * keyboard range is in progress (mouse selection, select-all, or cleared).
   */
  selectionAnchorId: string | null
  /**
   * Moving end of a keyboard range selection (#922) — the block the last
   * Shift+Arrow landed on. Pressing the opposite direction walks this back
   * toward (and past) the anchor, shrinking then re-growing the range.
   */
  selectionFocusId: string | null

  /** Set which block is focused (clears selection). */
  setFocused: (blockId: string | null) => void

  /** Toggle a block in/out of the selection (Ctrl+Click). */
  toggleSelected: (blockId: string) => void
  /**
   * Select the contiguous range anchor→block (Shift+Click), REPLACING the prior
   * selection (#1729 — anchor/focus model, can shrink as well as grow). The
   * anchor is the persisted `selectionAnchorId` if still visible, else the last
   * selected block. Requires the visible block IDs from the per-page store.
   */
  rangeSelect: (blockId: string, visibleIds: string[]) => void
  /**
   * Extend the block selection by one visible block in `direction` (#922 —
   * Shift+ArrowUp / Shift+ArrowDown in block-select mode). Maintains a fixed
   * `selectionAnchorId` and a moving `selectionFocusId` so the opposite
   * direction shrinks the range back, matching standard range-select
   * semantics (and the Shift+Click anchor model). `visibleIds` is the
   * tree's rendered order (collapsed/zoomed visibility already applied).
   *
   * Seeds the anchor from the current selection on first use: a single
   * selected block becomes both anchor and focus. No-ops when there is
   * nothing to extend from (empty selection) or no further block in that
   * direction (selection clamped at the list edge).
   */
  extendSelection: (direction: ExtendDirection, visibleIds: string[]) => void
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
  selectionAnchorId: null,
  selectionFocusId: null,

  setFocused: (blockId: string | null) => {
    set({
      focusedBlockId: blockId,
      selectedBlockIds: [],
      selectionAnchorId: null,
      selectionFocusId: null,
    })
  },

  toggleSelected: (blockId) => {
    set((state) => {
      const ids = state.selectedBlockIds
      const idx = ids.indexOf(blockId)
      // Toggling is a discrete mouse/keyboard action — reset the keyboard
      // range so the next Shift+Arrow re-seeds its anchor from the result.
      if (idx >= 0) {
        return {
          selectedBlockIds: ids.filter((id) => id !== blockId),
          selectionAnchorId: null,
          selectionFocusId: null,
        }
      }
      return {
        selectedBlockIds: [...ids, blockId],
        selectionAnchorId: null,
        selectionFocusId: null,
      }
    })
  },

  rangeSelect: (blockId, visibleIds) => {
    set((state) => {
      const { selectedBlockIds, selectionAnchorId } = state
      // #1729 — adopt the SAME anchor/focus replace model the keyboard path
      // (`extendSelection`) and the list surfaces (`useListMultiSelect`) use,
      // so mouse range-select can SHRINK as well as grow. Previously this
      // unioned the new range into the prior selection (add-only): a second
      // Shift+Click nearer the anchor could never deselect rows, diverging from
      // both Shift+Arrow in the same tree and Shift+Click in Trash/History.
      if (selectedBlockIds.length === 0) {
        // No selection yet: the click seeds a single-block selection AND the
        // anchor, so a follow-up Shift+Click/Shift+Arrow ranges from here.
        return {
          selectedBlockIds: [blockId],
          selectionAnchorId: blockId,
          selectionFocusId: blockId,
        }
      }
      // Anchor = the in-progress range anchor if still visible, else the last
      // selected block (matches `extendSelection`'s seeding). The range is
      // anchor→clicked and REPLACES the prior selection (not unioned).
      const anchorId =
        selectionAnchorId && visibleIds.includes(selectionAnchorId)
          ? selectionAnchorId
          : (selectedBlockIds.at(-1) as string)
      const anchorIdx = visibleIds.indexOf(anchorId)
      const targetIdx = visibleIds.indexOf(blockId)
      if (anchorIdx < 0 || targetIdx < 0) {
        return {
          selectedBlockIds: [blockId],
          selectionAnchorId: blockId,
          selectionFocusId: blockId,
        }
      }
      const start = Math.min(anchorIdx, targetIdx)
      const end = Math.max(anchorIdx, targetIdx)
      const rangeIds = visibleIds.slice(start, end + 1)
      // Persist anchor + focus so a subsequent Shift+Arrow continues from the
      // clicked end without re-seeding.
      return {
        selectedBlockIds: rangeIds,
        selectionAnchorId: anchorId,
        selectionFocusId: blockId,
      }
    })
  },

  extendSelection: (direction, visibleIds) => {
    set((state) => {
      const { selectedBlockIds, selectionAnchorId, selectionFocusId } = state
      // Nothing to extend from: keyboard range-select needs a starting block
      // (a single selected block in block-select mode). Leave state untouched.
      if (selectedBlockIds.length === 0) return state

      // Seed the anchor/focus on first use. The anchor is the fixed end; we
      // prefer an in-progress keyboard range, else fall back to the current
      // selection's last block (matches the Shift+Click "last selected"
      // anchor model). Both must still be visible to drive the range.
      const anchorId =
        selectionAnchorId && visibleIds.includes(selectionAnchorId)
          ? selectionAnchorId
          : (selectedBlockIds.at(-1) as string)
      const focusId =
        selectionFocusId && visibleIds.includes(selectionFocusId) ? selectionFocusId : anchorId

      const anchorIdx = visibleIds.indexOf(anchorId)
      const focusIdx = visibleIds.indexOf(focusId)
      if (anchorIdx < 0 || focusIdx < 0) return state

      // Move the focus end by one visible block. Clamp at the list edges
      // (no wrap) — at the top/bottom the chord is a no-op.
      const nextFocusIdx = direction === 'down' ? focusIdx + 1 : focusIdx - 1
      if (nextFocusIdx < 0 || nextFocusIdx >= visibleIds.length) return state

      const start = Math.min(anchorIdx, nextFocusIdx)
      const end = Math.max(anchorIdx, nextFocusIdx)
      const rangeIds = visibleIds.slice(start, end + 1)
      return {
        selectedBlockIds: rangeIds,
        selectionAnchorId: anchorId,
        selectionFocusId: visibleIds[nextFocusIdx] as string,
      }
    })
  },

  selectAll: (visibleIds) => {
    set({ selectedBlockIds: visibleIds, selectionAnchorId: null, selectionFocusId: null })
  },

  clearSelected: () => {
    set({ selectedBlockIds: [], selectionAnchorId: null, selectionFocusId: null })
  },

  setSelected: (ids) => {
    set({ selectedBlockIds: ids, selectionAnchorId: null, selectionFocusId: null })
  },
}))
