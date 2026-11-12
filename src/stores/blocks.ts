/**
 * Block focus and selection: the global, cross-page half of block state. Only
 * one block is focused across all pages; per-page data lives in the page block
 * stores (`page-blocks.ts`), so selection actions take the visible ids.
 */

import { create } from 'zustand'

import { announce } from '@/lib/announcer'
import { t } from '@/lib/i18n'
import type { FlatBlock } from '@/lib/tree-utils'
import type { MountedIds, SelectAllScopeIds } from '@/lib/zoom-scope'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

/** @public Kept on this facade although callers import `FlatBlock` from `tree-utils`. */
export type { FlatBlock }

/** Direction for keyboard range extension (#922). */
export type ExtendDirection = 'up' | 'down'

interface BlockStore {
  /** ID of the currently focused/editing block, or null. */
  focusedBlockId: string | null
  /** IDs of currently selected blocks (multi-select). */
  selectedBlockIds: string[]
  /**
   * Fixed end of a keyboard range selection (#922); Shift+Arrow moves the
   * other end. Null when no keyboard range is in progress.
   */
  selectionAnchorId: string | null
  /**
   * Keyboard focus in block-select mode (#5734), separate from the selection as
   * in a WAI-ARIA multi-select listbox: the block Ctrl+Arrow moves to, Ctrl+Click
   * or Ctrl+Space toggles, and the moving end of a Shift+Arrow range (#922). Read
   * it through {@link selectCursorBlockId}, which falls back to the last selected
   * block while this is null.
   */
  selectionFocusId: string | null

  /** Set which block is focused (clears selection). */
  setFocused: (blockId: string | null) => void

  /** Toggle a block in/out of the selection (Ctrl+Click). */
  toggleSelected: (blockId: string) => void
  /**
   * Select the range from the anchor to `blockId` (Shift+Click), replacing the
   * selection so it can shrink as well as grow (#1729). The anchor is
   * `selectionAnchorId` if still visible, else the cursor. `visibleIds` is
   * brand-gated (`MountedIds`) on the primitive itself, because an ungated
   * list injected here is what batch delete and batch TODO then act on (#3642).
   */
  rangeSelect: (blockId: string, visibleIds: MountedIds) => void
  /**
   * Extend the selection by one visible block (Shift+Arrow in block-select
   * mode, #922): a fixed anchor and a moving focus end, so the opposite
   * direction shrinks the range. Seeds the anchor from the cursor; a no-op with
   * no cursor or at the list edge. Brand-gated as `rangeSelect` is.
   */
  extendSelection: (direction: ExtendDirection, visibleIds: MountedIds) => void
  /**
   * Move the cursor one visible block without changing the selection
   * (Ctrl+Arrow, #5734); clamped at the edges, a no-op while the cursor is not
   * visible. Brand-gated, since Ctrl+Space selects what it lands on.
   */
  moveCursor: (direction: ExtendDirection, visibleIds: MountedIds) => void
  /**
   * Select all (Ctrl+A when not editing). Gated on `SelectAllScopeIds`, not
   * `MountedIds`: at the page root it takes collapse-hidden rows and rows past
   * the mount cap too, so the two must not substitute for each other (#3642).
   */
  selectAll: (visibleIds: SelectAllScopeIds) => void
  /** Clear the selection. */
  clearSelected: () => void
  /** Replace the selection with the given IDs. */
  setSelected: (ids: string[]) => void
}

/**
 * The block-select cursor (#5734): `selectionFocusId`, else the last selected
 * block, the block Shift+Arrow and Ctrl+Space acted on before the cursor
 * existed. Null with nothing selected or toggled.
 */
export function selectCursorBlockId(
  state: Pick<BlockStore, 'selectedBlockIds' | 'selectionFocusId'>,
): string | null {
  return state.selectionFocusId ?? state.selectedBlockIds.at(-1) ?? null
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
      // The cursor stays on the toggled block, selected or not (#5734), so a
      // second Ctrl+Space undoes the first; the next Shift+Arrow anchors on it.
      // Block-select and edit mode are exclusive (#2465), so this clears focus
      // even for a direct store call.
      return {
        selectedBlockIds: ids.includes(blockId)
          ? ids.filter((id) => id !== blockId)
          : [...ids, blockId],
        selectionAnchorId: null,
        selectionFocusId: blockId,
        focusedBlockId: null,
      }
    })
  },

  rangeSelect: (blockId, visibleIds) => {
    set((state) => {
      const { selectedBlockIds, selectionAnchorId } = state
      // Replace, not union, so a second Shift+Click nearer the anchor shrinks
      // the range as Shift+Arrow does (#1729). Every branch exits edit mode.
      if (selectedBlockIds.length === 0) {
        // The click seeds the selection and the anchor.
        return {
          selectedBlockIds: [blockId],
          selectionAnchorId: blockId,
          selectionFocusId: blockId,
          focusedBlockId: null,
        }
      }
      // Anchor: the range's anchor if still visible, else the cursor.
      const anchorId =
        selectionAnchorId && visibleIds.includes(selectionAnchorId)
          ? selectionAnchorId
          : (selectCursorBlockId(state) as string)
      const anchorIdx = visibleIds.indexOf(anchorId)
      const targetIdx = visibleIds.indexOf(blockId)
      if (anchorIdx < 0 || targetIdx < 0) {
        return {
          selectedBlockIds: [blockId],
          selectionAnchorId: blockId,
          selectionFocusId: blockId,
          focusedBlockId: null,
        }
      }
      const start = Math.min(anchorIdx, targetIdx)
      const end = Math.max(anchorIdx, targetIdx)
      const rangeIds = visibleIds.slice(start, end + 1)
      // Keep anchor and focus so a following Shift+Arrow continues from here.
      return {
        selectedBlockIds: rangeIds,
        selectionAnchorId: anchorId,
        selectionFocusId: blockId,
        focusedBlockId: null,
      }
    })
  },

  extendSelection: (direction, visibleIds) => {
    set((state) => {
      const { selectionAnchorId, selectionFocusId } = state
      // Nothing to extend from: keyboard range-select starts at the cursor.
      const cursorId = selectCursorBlockId(state)
      if (cursorId === null) return state

      // The anchor is the range in progress if visible, else the cursor.
      const anchorId =
        selectionAnchorId && visibleIds.includes(selectionAnchorId) ? selectionAnchorId : cursorId
      const focusId =
        selectionFocusId && visibleIds.includes(selectionFocusId) ? selectionFocusId : anchorId

      const anchorIdx = visibleIds.indexOf(anchorId)
      const focusIdx = visibleIds.indexOf(focusId)
      if (anchorIdx < 0 || focusIdx < 0) return state

      // No wrap: at either edge the chord is a no-op.
      const nextFocusIdx = direction === 'down' ? focusIdx + 1 : focusIdx - 1
      if (nextFocusIdx < 0 || nextFocusIdx >= visibleIds.length) return state

      const start = Math.min(anchorIdx, nextFocusIdx)
      const end = Math.max(anchorIdx, nextFocusIdx)
      const rangeIds = visibleIds.slice(start, end + 1)
      // Exits edit mode too (#2465).
      return {
        selectedBlockIds: rangeIds,
        selectionAnchorId: anchorId,
        selectionFocusId: visibleIds[nextFocusIdx] as string,
        focusedBlockId: null,
      }
    })
  },

  moveCursor: (direction, visibleIds) => {
    set((state) => {
      const cursorId = selectCursorBlockId(state)
      const idx = cursorId === null ? -1 : visibleIds.indexOf(cursorId)
      const next = idx < 0 ? undefined : visibleIds[direction === 'down' ? idx + 1 : idx - 1]
      return next === undefined ? state : { selectionFocusId: next }
    })
  },

  // Populating the selection exits edit mode (#2465).
  selectAll: (visibleIds) => {
    set((state) => {
      // The cursor stays where it is, else lands on the first block (#5734): left
      // to fall back to the last selected block it would be the page's last, and
      // its row takes DOM focus, scrolling the page there.
      const cursorId = selectCursorBlockId(state)
      return {
        // Copied, not aliased: `visibleIds` is a memoized render projection and
        // `selectedBlockIds` is mutable state.
        selectedBlockIds: [...visibleIds],
        selectionAnchorId: null,
        selectionFocusId:
          cursorId !== null && visibleIds.includes(cursorId) ? cursorId : (visibleIds[0] ?? null),
        // Guard like `setSelected`: `selectAll([])` (empty page) selects
        // nothing and must not disturb an unrelated in-progress edit.
        focusedBlockId: visibleIds.length > 0 ? null : state.focusedBlockId,
      }
    })
  },

  clearSelected: () => {
    set({ selectedBlockIds: [], selectionAnchorId: null, selectionFocusId: null })
  },

  setSelected: (ids) => {
    set((state) => ({
      selectedBlockIds: ids,
      selectionAnchorId: null,
      selectionFocusId: null,
      // An empty selection must not disturb an unrelated edit.
      focusedBlockId: ids.length > 0 ? null : state.focusedBlockId,
    }))
  },
}))

// ── Selection is page-scoped; navigation is not ─────────────────────────────
//
// `selectedBlockIds` is a global array while blocks render per-page, and
// nothing in the navigation path cleared it: ids selected on page A survived
// a navigation to page B, the batch toolbar showed a stale "N selected" with
// zero visible rows, further selections accumulated across pages, and a batch
// delete silently soft-deleted the invisible page-A blocks (undo bookkeeping
// registers only under the CURRENT page, so Ctrl+Z could not restore them).
//
// Clear the selection whenever the active page context — the current view, the
// top of the active tab's page stack, the journal day and mode, or the space —
// changes. Module-level cross-store subscriptions mirror the established
// `createPerSpaceSlice.attach` pattern.

/** Key identifying "which blocks the user is looking at" for selection scope. */
function activePageContextKey(): string {
  const view = useNavigationStore.getState().currentView
  const topPageId = selectPageStack(useTabsStore.getState()).at(-1)?.pageId ?? ''
  const { mode, currentDate } = useJournalStore.getState()
  const journalDay = view === 'journal' ? `${mode}\0${currentDate.toDateString()}` : ''
  const spaceId = useSpaceStore.getState().currentSpaceId
  return `${view}\0${topPageId}\0${journalDay}\0${spaceId}`
}

let lastPageContextKey = activePageContextKey()

function clearSelectionOnPageContextChange(): void {
  const key = activePageContextKey()
  if (key === lastPageContextKey) return
  lastPageContextKey = key
  const { selectedBlockIds, selectionAnchorId, selectionFocusId, clearSelected } =
    useBlockStore.getState()
  if (selectedBlockIds.length > 0 || selectionAnchorId !== null || selectionFocusId !== null) {
    clearSelected()
  }
}

useNavigationStore.subscribe(clearSelectionOnPageContextChange)
useTabsStore.subscribe(clearSelectionOnPageContextChange)
useJournalStore.subscribe(clearSelectionOnPageContextChange)
useSpaceStore.subscribe(clearSelectionOnPageContextChange)

// A screen reader hears each change of the selection count, the first selection
// and the clear included: the batch toolbar that shows the count mounts and
// unmounts with the selection, so a live region inside it would miss both.
useBlockStore.subscribe((state, previous) => {
  const count = state.selectedBlockIds.length
  if (count === previous.selectedBlockIds.length) return
  announce(count > 0 ? t('announce.blocksSelected', { count }) : t('announce.selectionCleared'))
})
