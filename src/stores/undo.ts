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

import { notify } from '@/lib/notify'

import { t } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { OpRef, UndoResult } from '../lib/tauri'
import { redoPageOp, undoPageGroup } from '../lib/tauri'

export type { OpRef, UndoResult }

export const MAX_REDO_STACK = 100

/**
 * Time window (ms) within which consecutive same-device ops are grouped for
 * batch undo.
 *
 * Bumped from 200 ms → 500 ms. The original 200 ms window was
 * sized for the in-memory recurrence-op burst (8-10 ops fired
 * back-to-back). Under realistic load — slow disks, larger transactions,
 * mobile/Android backends — those bursts can stretch past 200 ms and the
 * grouping silently breaks, leaving the user with one Ctrl+Z per op
 * instead of one Ctrl+Z per logical action. 500 ms is still well under
 * any plausible "two intentional user actions" gap and gives the burst
 * room to land as a single group.
 */
export const UNDO_GROUP_WINDOW_MS = 500

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
  /**
   * Redo targets, most recent undo first. Each entry is an undo's
   * `new_op_ref` — the appended REVERSE op (`is_undo = 1`) that
   * `redo_page_op` reverses to re-apply the original action. NOT the original
   * forward op's ref: `redo_page_op` refuses to reverse a forward op (#659).
   */
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
   * #2190 — issues ONE `undoPageGroup` IPC that reverts the entire consecutive
   * same-device, within-`UNDO_GROUP_WINDOW_MS` group in a single IMMEDIATE
   * transaction, then reconciles local undo/redo state from the batch response.
   * Returns the first (newest) UndoResult or null.
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

  /**
   * #731 — re-anchor undo state after a sync applied remote ops to a page.
   *
   * `performSingleUndo` addresses the backend op-log POSITIONALLY
   * (`undoPageOp({ pageId, undoDepth })`), and the backend selects the
   * Nth-most-recent op across ALL devices with no device filter. Only a
   * LOCAL `onNewAction` resets `undoDepth`; remote ops landing between two
   * Ctrl+Z presses shift that indexing, so the next undo would reverse a
   * DIFFERENT op than the user intends (and stale `redoStack` OpRefs may
   * target ops the remote write superseded). When `useSyncEvents` reloads a
   * page's blocks after `sync:complete` (ops_received > 0), it must also drop
   * that page's positional undo anchor here. Reset to the pristine baseline
   * (depth 0, empty redo stack + group sizes) — identical to `onNewAction`,
   * but only for pages whose op-log actually changed. No-op for pages with no
   * recorded undo state.
   */
  reanchorAfterRemoteOps: (pageId: string) => void
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

/**
 * Return a new `pages` Map with the entry for `pageId` replaced by the
 * result of `updater(current)`. If the updater returns `undefined`, the
 * entry is deleted. Pure — no closure over `set` / `get`.
 */
function setPageState(
  pages: Map<string, PageUndoState>,
  pageId: string,
  updater: (current: PageUndoState | undefined) => PageUndoState | undefined,
): Map<string, PageUndoState> {
  const newPages = new Map(pages)
  const next = updater(newPages.get(pageId))
  if (next === undefined) {
    newPages.delete(pageId)
  } else {
    newPages.set(pageId, next)
  }
  return newPages
}

export const useUndoStore = create<UndoStore>((set, get) => {
  /** Guard: page IDs with undo currently in progress. */
  const undoInProgress = new Set<string>()
  /** Guard: page IDs with redo currently in progress. */
  const redoInProgress = new Set<string>()

  // ---------------------------------------------------------------------------
  // Single-op helpers (extracted from the original undo/redo actions)
  // ---------------------------------------------------------------------------

  /**
   * Perform a single redo operation (one op at a time).
   * Handles optimistic updates and rollback on error.
   */
  async function performSingleRedo(pageId: string): Promise<UndoResult | null> {
    const opRef = (() => {
      const state = get()
      const pageState = getOrCreatePage(state.pages, pageId)

      if (pageState.redoStack.length === 0) return null

      const [first, ...remainingStack] = pageState.redoStack

      // Optimistic update: pop from redo stack and decrement undoDepth. Read
      // from the functional updater's `current` for consistency with the
      // success/rollback paths (derive from live state, not the snapshot).
      set((s) => ({
        pages: setPageState(s.pages, pageId, (current) => {
          const base = current ?? pageState
          return {
            ...base,
            redoStack: remainingStack,
            undoDepth: base.undoDepth - 1,
          }
        }),
      }))

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
      set((state) => ({
        pages: setPageState(state.pages, pageId, (current) =>
          current
            ? {
                ...current,
                redoStack: [opRef, ...current.redoStack],
                undoDepth: current.undoDepth + 1,
              }
            : current,
        ),
      }))
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Store actions
  // ---------------------------------------------------------------------------

  return {
    pages: new Map(),

    undo: async (pageId: string) => {
      if (undoInProgress.has(pageId)) {
        logger.warn('UndoStore', 'undo already in progress, skipping', { pageId })
        return null
      }
      undoInProgress.add(pageId)
      try {
        // Capture the current undo anchor — the newest-first offset the group
        // seed sits at (0 = most recent undoable op).
        const initialDepth = getOrCreatePage(get().pages, pageId).undoDepth

        // #2190 — ONE IPC reverts the entire consecutive same-device,
        // within-window undo group in a single IMMEDIATE transaction. This
        // replaces the prior `findUndoGroup` + N × `undoPageOp` loop (one IPC /
        // one page-subtree CTE walk / one writer-lock acquisition per op — 20
        // IPCs when holding Ctrl+Z over a 20-op recurrence group) with a single
        // command. The backend resolves the subtree + the group's op refs once
        // and returns one `UndoResult` per reverted op, newest-first.
        //
        // Optimistically ensure a page entry exists BEFORE the await so a
        // `clearPage` landing mid-flight is detectable on the success path
        // below (`current` becomes undefined) — mirrors the pre-#2190
        // optimistic marker and the #753 "don't re-seed after an explicit
        // clear" fix.
        set((s) => ({
          pages: setPageState(
            s.pages,
            pageId,
            (current) => current ?? { redoStack: [], undoDepth: 0, redoGroupSizes: [] },
          ),
        }))

        let results: UndoResult[]
        try {
          results = await undoPageGroup({
            pageId,
            depth: initialDepth,
            windowMs: UNDO_GROUP_WINDOW_MS,
          })
        } catch (err) {
          logger.error('UndoStore', 'undo_page_group failed', { pageId }, err)
          notify.warning(t('undo.batchUnavailable'))
          return null
        }

        // Empty group — the seed op doesn't exist (nothing left to undo).
        if (results.length === 0) return null

        // Reconcile state from the batch response exactly as the sequential
        // loop did, one `set` instead of N:
        //   * advance the undo anchor by the number of reverted ops so the next
        //     Ctrl+Z seeds at the next-older group,
        //   * push each op's `new_op_ref` — the appended REVERSE op (flagged
        //     `is_undo = 1`) — onto the redo stack in response order. Redo
        //     means "reverse the undo op", and `redo_page_op` REJECTS a
        //     forward-op ref (#659), so the stack must carry the reverse ops'
        //     refs, NOT `reversed_op` (the original forward op). Newest-first
        //     ops are pushed first, so the OLDEST op's reverse ends up at the
        //     front — the order `performSingleRedo` pops for a correct
        //     oldest-first redo replay,
        //   * record the group size for redo.
        //
        // If `clearPage` cleared the entry mid-flight, `current` is undefined
        // and we drop the result rather than re-seeding (#753).
        //
        // #1561 — clamp the recorded group size to what the redo stack can back
        // (`redoStack.length - sum(existing redoGroupSizes)`) in case
        // `reanchorAfterRemoteOps` / `onNewAction` reset the entry mid-flight,
        // preserving the invariant `sum(redoGroupSizes) <= redoStack.length`.
        set((state) => ({
          pages: setPageState(state.pages, pageId, (current) => {
            if (!current) return current
            let redoStack = current.redoStack
            for (const result of results) {
              redoStack = [result.new_op_ref, ...redoStack].slice(0, MAX_REDO_STACK)
            }
            const undoDepth = current.undoDepth + results.length
            const alreadyGrouped = current.redoGroupSizes.reduce((sum, n) => sum + n, 0)
            const backing = redoStack.length - alreadyGrouped
            const recordedSize = Math.min(results.length, Math.max(backing, 0))
            const redoGroupSizes =
              recordedSize > 0 ? [...current.redoGroupSizes, recordedSize] : current.redoGroupSizes
            return { ...current, redoStack, undoDepth, redoGroupSizes }
          }),
        }))

        // Non-empty (guarded above); `?? null` satisfies
        // noUncheckedIndexedAccess.
        return results[0] ?? null
      } finally {
        undoInProgress.delete(pageId)
      }
    },

    redo: async (pageId: string) => {
      if (redoInProgress.has(pageId)) return null
      redoInProgress.add(pageId)
      try {
        const pageState = getOrCreatePage(get().pages, pageId)
        if (pageState.redoStack.length === 0) return null

        // Determine group size from the most recent batch undo
        const groupSize =
          pageState.redoGroupSizes.length > 0 ? (pageState.redoGroupSizes.at(-1) as number) : 1

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
          set((state) => ({
            pages: setPageState(state.pages, pageId, (current) =>
              current && current.redoGroupSizes.length > 0
                ? { ...current, redoGroupSizes: current.redoGroupSizes.slice(0, -1) }
                : current,
            ),
          }))
        }

        return firstResult
      } finally {
        redoInProgress.delete(pageId)
      }
    },

    canRedo: (pageId: string) => {
      const { pages } = get()
      const pageState = pages.get(pageId)
      return pageState != null && pageState.redoStack.length > 0
    },

    onNewAction: (pageId: string) => {
      set((state) => ({
        pages: setPageState(state.pages, pageId, () => ({
          redoStack: [],
          undoDepth: 0,
          redoGroupSizes: [],
        })),
      }))
    },

    clearPage: (pageId: string) => {
      set((state) => ({
        pages: setPageState(state.pages, pageId, () => undefined),
      }))
    },

    reanchorAfterRemoteOps: (pageId: string) => {
      set((state) => ({
        // Only re-anchor pages that already carry undo state — a page the
        // user never touched has no stale positional anchor to fix, and
        // creating a pristine entry for it would needlessly grow the Map.
        pages: setPageState(state.pages, pageId, (current) =>
          current ? { redoStack: [], undoDepth: 0, redoGroupSizes: [] } : current,
        ),
      }))
    },
  }
})
