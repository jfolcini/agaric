/**
 * Undo store — Zustand state for session-scoped, per-page undo/redo.
 *
 * Tracks undo depth and redo stack per page. Undo/redo operations delegate
 * to Tauri backend commands that compute and append reverse ops.
 * New user actions clear the redo stack (standard undo semantics).
 */

import { create } from 'zustand'
import type { OpRef, UndoResult } from '../lib/tauri'
import { redoPageOp, undoPageOp } from '../lib/tauri'

export type { OpRef, UndoResult }

interface PageUndoState {
  /** Ops that have been undone, available for redo (most recent undo first). */
  redoStack: OpRef[]
  /** How many ops we've undone from the page's history. */
  undoDepth: number
}

interface UndoStore {
  /** Per-page undo state, keyed by page ID. */
  pages: Map<string, PageUndoState>

  /**
   * Undo the last undoable op on the given page.
   * Calls backend `undo_page_op` which finds the Nth most recent op
   * (where N = undoDepth + 1), computes its reverse, and appends it.
   * Returns the UndoResult or null if nothing to undo.
   */
  undo: (pageId: string) => Promise<UndoResult | null>

  /**
   * Redo the last undone op on the given page.
   * Calls backend `redo_page_op` with the undo op's ref.
   * Returns the UndoResult or null if nothing to redo.
   */
  redo: (pageId: string) => Promise<UndoResult | null>

  /** Whether undo is available for a page (always true — backend decides). */
  canUndo: (pageId: string) => boolean

  /** Whether redo is available for a page. */
  canRedo: (pageId: string) => boolean

  /**
   * Called after any user mutation on a page.
   * Clears the redo stack (standard: new action invalidates redo history).
   * Resets undoDepth to 0.
   */
  onNewAction: (pageId: string) => void

  /** Clear undo state for a page (called on navigation away). */
  clearPage: (pageId: string) => void
}

/**
 * Get existing page state or create a default.
 * NOTE: The returned object is NOT automatically stored in the Map.
 * Caller must use set() to persist any changes.
 */
function getOrCreatePage(pages: Map<string, PageUndoState>, pageId: string): PageUndoState {
  const existing = pages.get(pageId)
  if (existing) return existing
  return { redoStack: [], undoDepth: 0 }
}

export const useUndoStore = create<UndoStore>((set, get) => ({
  pages: new Map(),

  undo: async (pageId: string) => {
    // Optimistically increment undoDepth BEFORE the async call
    const currentDepth = (() => {
      const { pages } = get()
      const pageState = getOrCreatePage(pages, pageId)
      const depth = pageState.undoDepth

      // Optimistic update: increment immediately
      const newPages = new Map(get().pages)
      newPages.set(pageId, {
        ...pageState,
        undoDepth: depth + 1,
      })
      set({ pages: newPages })

      return depth
    })()

    try {
      const result = await undoPageOp({
        pageId,
        undoDepth: currentDepth,
      })

      // On success: add to redo stack
      set((state) => {
        const newPages = new Map(state.pages)
        const current = newPages.get(pageId) ?? { redoStack: [], undoDepth: currentDepth + 1 }
        newPages.set(pageId, {
          ...current,
          redoStack: [result.reversed_op, ...current.redoStack],
        })
        return { pages: newPages }
      })

      return result
    } catch {
      // On error: roll back the optimistic increment
      set((state) => {
        const newPages = new Map(state.pages)
        const current = newPages.get(pageId)
        if (current && current.undoDepth > 0) {
          newPages.set(pageId, {
            ...current,
            undoDepth: current.undoDepth - 1,
          })
        }
        return { pages: newPages }
      })
      return null
    }
  },

  redo: async (pageId: string) => {
    // Optimistically update state BEFORE the async call
    const opRef = (() => {
      const { pages } = get()
      const pageState = getOrCreatePage(pages, pageId)

      if (pageState.redoStack.length === 0) return null

      const [first, ...remainingStack] = pageState.redoStack

      // Optimistic update: pop from redo stack and decrement undoDepth
      const newPages = new Map(get().pages)
      newPages.set(pageId, {
        redoStack: remainingStack,
        undoDepth: pageState.undoDepth - 1,
      })
      set({ pages: newPages })

      return first
    })()

    if (opRef === null) return null

    try {
      const result = await redoPageOp({
        undoDeviceId: opRef.device_id,
        undoSeq: opRef.seq,
      })

      // On success: state already updated optimistically
      return result
    } catch {
      // On error: roll back the optimistic update
      set((state) => {
        const newPages = new Map(state.pages)
        const current = newPages.get(pageId)
        if (current) {
          newPages.set(pageId, {
            redoStack: [opRef, ...current.redoStack],
            undoDepth: current.undoDepth + 1,
          })
        }
        return { pages: newPages }
      })
      return null
    }
  },

  canUndo: (_pageId: string) => {
    // We don't know the total op count; the backend will return error if none.
    return true
  },

  canRedo: (pageId: string) => {
    const { pages } = get()
    const pageState = pages.get(pageId)
    return pageState != null && pageState.redoStack.length > 0
  },

  onNewAction: (pageId: string) => {
    set((state) => {
      const newPages = new Map(state.pages)
      newPages.set(pageId, { redoStack: [], undoDepth: 0 })
      return { pages: newPages }
    })
  },

  clearPage: (pageId: string) => {
    set((state) => {
      const newPages = new Map(state.pages)
      newPages.delete(pageId)
      return { pages: newPages }
    })
  },
}))
