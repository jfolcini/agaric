/**
 * Undo store — Zustand state for session-scoped, per-page undo/redo.
 *
 * Tracks undo depth and redo stack per page. Undo/redo operations delegate
 * to Tauri backend commands that compute and append reverse ops.
 * New user actions clear the redo stack (standard undo semantics).
 *
 * **Batch undo/redo**: consecutive ops within UNDO_GROUP_WINDOW_MS by the same
 * device are automatically grouped. Ctrl+Z undoes the entire group at once;
 * Ctrl+Y redoes it. This makes recurrence-triggered operations (which create
 * 8-10 ops in rapid succession) feel like a single action.
 */

import { create } from 'zustand'
import { logger } from '../lib/logger'
import type { OpRef, UndoResult } from '../lib/tauri'
import { listPageHistory, redoPageOp, undoPageOp } from '../lib/tauri'

export type { OpRef, UndoResult }

export const MAX_REDO_STACK = 100

/** Time window (ms) within which consecutive same-device ops are grouped for batch undo. */
export const UNDO_GROUP_WINDOW_MS = 200

/**
 * Returns true if two ISO-8601 timestamps are within UNDO_GROUP_WINDOW_MS
 * of each other. Used to detect ops created in rapid succession
 * (e.g. recurrence ops triggered by set_todo_state).
 */
export function isWithinUndoGroup(ts1: string, ts2: string): boolean {
  const d1 = new Date(ts1).getTime()
  const d2 = new Date(ts2).getTime()
  if (Number.isNaN(d1) || Number.isNaN(d2)) return false
  return Math.abs(d1 - d2) <= UNDO_GROUP_WINDOW_MS
}

interface PageUndoState {
  /** Ops that have been undone, available for redo (most recent undo first). */
  redoStack: OpRef[]
  /** How many ops we've undone from the page's history. */
  undoDepth: number
  /**
   * Group sizes for batch redo. Each entry records how many single-op undos
   * were performed in one batch. Redo pops the last entry to replay the group.
   */
  redoGroupSizes: number[]
}

interface UndoStore {
  /** Per-page undo state, keyed by page ID. */
  pages: Map<string, PageUndoState>

  /**
   * Undo the last undoable op (or group of ops) on the given page.
   * After reversing the first op, checks history timestamps to
   * automatically undo consecutive ops within UNDO_GROUP_WINDOW_MS
   * by the same device. Returns the first UndoResult or null.
   */
  undo: (pageId: string) => Promise<UndoResult | null>

  /**
   * Redo the last undone op (or group) on the given page.
   * Uses recorded group sizes to replay the correct number of ops.
   * Returns the first UndoResult or null.
   */
  redo: (pageId: string) => Promise<UndoResult | null>

  /** Whether redo is available for a page. */
  canRedo: (pageId: string) => boolean

  /**
   * Called after any user mutation on a page.
   * Clears the redo stack and group sizes (standard: new action invalidates redo history).
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
  return { redoStack: [], undoDepth: 0, redoGroupSizes: [] }
}

export const useUndoStore = create<UndoStore>((set, get) => {
  // ---------------------------------------------------------------------------
  // Single-op helpers (extracted from the original undo/redo actions)
  // ---------------------------------------------------------------------------

  /**
   * Perform a single undo operation (one op at a time).
   * Handles optimistic updates and rollback on error.
   */
  async function performSingleUndo(pageId: string): Promise<UndoResult | null> {
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
        const current = newPages.get(pageId) ?? {
          redoStack: [],
          undoDepth: currentDepth + 1,
          redoGroupSizes: [],
        }
        newPages.set(pageId, {
          ...current,
          redoStack: [result.reversed_op, ...current.redoStack].slice(0, MAX_REDO_STACK),
        })
        return { pages: newPages }
      })

      return result
    } catch (err) {
      logger.error('UndoStore', 'undo operation failed', { pageId }, err)
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
  }

  /**
   * Perform a single redo operation (one op at a time).
   * Handles optimistic updates and rollback on error.
   */
  async function performSingleRedo(pageId: string): Promise<UndoResult | null> {
    const opRef = (() => {
      const { pages } = get()
      const pageState = getOrCreatePage(pages, pageId)

      if (pageState.redoStack.length === 0) return null

      const [first, ...remainingStack] = pageState.redoStack

      // Optimistic update: pop from redo stack and decrement undoDepth
      const newPages = new Map(get().pages)
      newPages.set(pageId, {
        ...pageState,
        redoStack: remainingStack,
        undoDepth: pageState.undoDepth - 1,
      })
      set({ pages: newPages })

      return first as OpRef
    })()

    if (opRef === null) return null

    try {
      const result = await redoPageOp({
        undoDeviceId: opRef.device_id,
        undoSeq: opRef.seq,
      })

      // On success: state already updated optimistically
      return result
    } catch (err) {
      logger.error('UndoStore', 'redo operation failed', { pageId }, err)
      // On error: roll back the optimistic update
      set((state) => {
        const newPages = new Map(state.pages)
        const current = newPages.get(pageId)
        if (current) {
          newPages.set(pageId, {
            ...current,
            redoStack: [opRef, ...current.redoStack],
            undoDepth: current.undoDepth + 1,
          })
        }
        return { pages: newPages }
      })
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Store actions
  // ---------------------------------------------------------------------------

  return {
    pages: new Map(),

    undo: async (pageId: string) => {
      // Capture the initial undo depth before any undo calls
      const initialDepth = getOrCreatePage(get().pages, pageId).undoDepth

      // Perform the first single undo
      const firstResult = await performSingleUndo(pageId)
      if (!firstResult) return null

      // Try to extend the group by checking history timestamps
      let groupSize = 1
      try {
        const history = await listPageHistory({
          pageId,
          limit: Math.max(50, (initialDepth + 20) * 2),
        })

        // Filter to undoable ops (exclude undo/redo reverse ops, matching backend logic)
        const undoableOps = history.items.filter(
          (o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'),
        )

        // The first undo targeted the op at index initialDepth (newest-first order)
        let lastUndoneIndex = initialDepth

        // Keep undoing consecutive ops within the time window by the same device
        while (lastUndoneIndex + 1 < undoableOps.length) {
          const lastOp = undoableOps[lastUndoneIndex] as (typeof undoableOps)[number]
          const nextOp = undoableOps[lastUndoneIndex + 1] as (typeof undoableOps)[number]

          if (!isWithinUndoGroup(lastOp.created_at, nextOp.created_at)) break
          if (lastOp.device_id !== nextOp.device_id) break

          const result = await performSingleUndo(pageId)
          if (!result) break

          groupSize++
          lastUndoneIndex++
        }
      } catch (err) {
        logger.error('UndoStore', 'history fetch failed', { pageId }, err)
        // History fetch failed — graceful fallback, just the single undo
      }

      // Record group size for redo (always, even for single ops)
      set((state) => {
        const newPages = new Map(state.pages)
        const current = newPages.get(pageId)
        if (current) {
          newPages.set(pageId, {
            ...current,
            redoGroupSizes: [...current.redoGroupSizes, groupSize],
          })
        }
        return { pages: newPages }
      })

      return firstResult
    },

    redo: async (pageId: string) => {
      const pageState = getOrCreatePage(get().pages, pageId)
      if (pageState.redoStack.length === 0) return null

      // Determine group size from the most recent batch undo
      const groupSize =
        pageState.redoGroupSizes.length > 0
          ? (pageState.redoGroupSizes[pageState.redoGroupSizes.length - 1] as number)
          : 1

      let firstResult: UndoResult | null = null
      let redoneCount = 0

      for (let i = 0; i < groupSize; i++) {
        const result = await performSingleRedo(pageId)
        if (!result) break
        if (i === 0) firstResult = result
        redoneCount++
      }

      // Pop the group size after at least one successful redo
      if (redoneCount > 0 && pageState.redoGroupSizes.length > 0) {
        set((state) => {
          const newPages = new Map(state.pages)
          const current = newPages.get(pageId)
          if (current && current.redoGroupSizes.length > 0) {
            newPages.set(pageId, {
              ...current,
              redoGroupSizes: current.redoGroupSizes.slice(0, -1),
            })
          }
          return { pages: newPages }
        })
      }

      return firstResult
    },

    canRedo: (pageId: string) => {
      const { pages } = get()
      const pageState = pages.get(pageId)
      return pageState != null && pageState.redoStack.length > 0
    },

    onNewAction: (pageId: string) => {
      set((state) => {
        const newPages = new Map(state.pages)
        newPages.set(pageId, { redoStack: [], undoDepth: 0, redoGroupSizes: [] })
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
  }
})
