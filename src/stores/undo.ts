/**
 * Undo store — Zustand state for session-scoped, per-page undo/redo.
 *
 * #2468 — page-level undo is REF-ADDRESSED: every migrated mutating command
 * (`create_block` / `edit_block` / `delete_block` / `move_block` /
 * `set_property` / `delete_property` / `add_tag` / `remove_tag`) returns the
 * exact `OpRef`(s) it appended to the op log, and the call site forwards them
 * into `onNewAction(pageId, opRefs)`. Ctrl+Z then submits those CAPTURED refs
 * via `undoOp` / `undoOps` instead of a positional depth — ops landing between
 * capture and undo (a sync burst, a debounced flush, another pane) can no
 * longer shift the target (the #2446 race class).
 *
 * The old positional path (`undoPageGroup(pageId, depth, windowMs)`) is kept
 * as the DOCUMENTED FALLBACK, used only where refs are unavailable:
 *   - actions whose commands do not surface refs yet (`move_blocks_batch`,
 *     `create_blocks_batch`, and any un-migrated single command) — their
 *     `onNewAction(pageId)` call pushes a ref-less fallback entry;
 *   - history that predates FE tracking (empty undo stack: ops from before
 *     the page entry existed, e.g. a previous app session).
 * `undoDepth` is demoted to display/fallback state: it still counts undone
 * ops so the positional anchor stays coherent across mixed ref/positional
 * undos, but ref-addressed undo never reads it for targeting.
 *
 * New user actions clear the redo stack (standard undo semantics).
 *
 * **Batch undo/redo**: consecutive actions within UNDO_GROUP_WINDOW_MS
 * coalesce at CAPTURE time into one undo entry whose ref-set accumulates;
 * Ctrl+Z reverts the whole entry through ONE `undoOps` IPC (atomic). This
 * makes recurrence-triggered operations (8-10 ops in rapid succession) feel
 * like a single action. A mixed burst (ref-carrying + ref-less action inside
 * one window) degrades the merged entry to the positional fallback — which
 * groups by the same window on the backend, so one Ctrl+Z still reverts the
 * whole burst (the pre-#2468 behavior for everything).
 */

import { create } from 'zustand'

import { notify } from '@/lib/notify'

import { t } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { OpRef, UndoResult } from '../lib/tauri'
import { redoPageOp, undoOp, undoOps, undoPageGroup } from '../lib/tauri'

export type { OpRef, UndoResult }

export const MAX_REDO_STACK = 100

/**
 * Bound on the ref-addressed undo stack (#2468). Entries older than the cap
 * fall off the bottom; once the stack drains past them, undo continues on the
 * positional fallback (`undoDepth` keeps counting across both paths), so the
 * cap bounds memory without shortening how far back Ctrl+Z can reach.
 */
export const MAX_UNDO_STACK = 100

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
 *
 * #2468 — the same window now also drives CAPTURE-time coalescing in
 * `onNewAction` (consecutive notifications within the window accumulate one
 * entry's ref-set), mirroring the backend's op-timestamp grouping that the
 * positional fallback still uses.
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

/**
 * One undoable action group on a page's undo stack (#2468).
 */
export interface UndoStackEntry {
  /**
   * The op refs this action group appended, in APPEND order (oldest-first;
   * `undo()` submits them newest-first). `null` marks a POSITIONAL-FALLBACK
   * entry — the action's command does not surface refs (batch move/create,
   * un-migrated commands), so undoing it goes through `undoPageGroup`.
   */
  refs: OpRef[] | null
  /**
   * Epoch-ms of the LAST action coalesced into this entry. Capture-time
   * grouping is a sliding window anchored here, mirroring the backend's
   * consecutive-gap grouping in `undo_page_group`.
   */
  at: number
  /**
   * #2600 — optional "session" key. Consecutive actions carrying the SAME
   * defined key coalesce into one entry REGARDLESS of elapsed time (in
   * addition to the timed window), so a block's mid-typing debounced commits +
   * its final blur commit revert as a single Ctrl+Z. Content edits pass
   * `edit:<blockId>`; actions that omit the key keep the pure timed-window
   * behavior (#2468). `undefined` never matches (including another `undefined`).
   */
  coalesceKey?: string | undefined
}

interface PageUndoState {
  /**
   * Undo targets, newest first (index 0 = what the next Ctrl+Z reverts).
   * Seeded by `onNewAction`; drained by `undo()`; re-fed by `redo()` (a
   * redone group's `new_op_ref`s become the new undo targets).
   */
  undoStack: UndoStackEntry[]
  /**
   * Redo targets, most recent undo first. Each entry is an undo's
   * `new_op_ref` — the appended REVERSE op (`is_undo = 1`) that
   * `redo_page_op` reverses to re-apply the original action. NOT the original
   * forward op's ref: `redo_page_op` refuses to reverse a forward op (#659).
   */
  redoStack: OpRef[]
  /**
   * How many ops we've undone from the page's history. #2468 — demoted to
   * display/fallback state: it anchors the POSITIONAL fallback
   * (`undoPageGroup`) for ref-less entries and pre-tracking history, and is
   * still advanced by ref-addressed undos so the two paths stay coherent
   * when interleaved. Ref-addressed targeting never reads it.
   */
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
   * Undo the last undoable action group on the given page.
   *
   * #2468 — if the top undo-stack entry carries captured refs, it is
   * reverted BY REF: one `undoOp` IPC for a single-op entry, ONE atomic
   * `undoOps` IPC for a coalesced multi-op entry. Ref-less entries and an
   * empty stack (history predating FE tracking) fall back to the positional
   * `undoPageGroup` path (#2190 semantics preserved). Reconciles local
   * undo/redo state from the batch response. Returns the first (newest)
   * UndoResult or null.
   */
  undo: (pageId: string) => Promise<UndoResult | null>

  /**
   * Redo the last undone op (or group) on the given page.
   * Uses recorded group sizes to replay the correct number of ops.
   * #2468 — the redone ops' `new_op_ref`s are pushed back onto the undo
   * stack as ONE ref entry, so the next Ctrl+Z re-undoes the group by ref.
   * Returns the first UndoResult or null.
   */
  redo: (pageId: string) => Promise<UndoResult | null>

  /** Whether redo is available for a page. */
  canRedo: (pageId: string) => boolean

  /**
   * Called after any user mutation on a page.
   * Clears the redo stack and group sizes (standard: new action invalidates
   * redo history) and resets the positional anchor (`undoDepth`) to 0.
   *
   * #2468 — `opRefs` carries the op ref(s) the mutation's IPC response
   * reported (`WithOps.op_refs`); the action is pushed onto the page's undo
   * stack as a ref-addressed entry. Omit it for commands that don't surface
   * refs (positional-fallback entry). Consecutive calls within
   * `UNDO_GROUP_WINDOW_MS` coalesce into the top entry (ref-sets accumulate;
   * a ref-less participant degrades the merged entry to the fallback).
   *
   * An EMPTY `opRefs` array means the command was an idempotent no-op
   * (`add_tag` on an already-tagged block, …): nothing was appended, nothing
   * is undoable — the call is ignored entirely (no entry push, and no redo
   * invalidation for an action that changed nothing). Callers should skip
   * the notification themselves in that case; this guard is defense-in-depth.
   *
   * #2600 — `coalesceKey` (optional) groups consecutive actions that share the
   * same defined key into ONE entry regardless of elapsed time (content edits
   * pass `edit:<blockId>`), so a block's debounced mid-typing commits fold into
   * a single undo step. Omit it for the pure timed-window behavior (#2468).
   */
  onNewAction: (pageId: string, opRefs?: OpRef[], coalesceKey?: string) => void

  /** Clear undo state for a page (called on navigation away). */
  clearPage: (pageId: string) => void

  /**
   * #731 — re-anchor undo state after a sync applied remote ops to a page.
   *
   * The POSITIONAL fallback (`undoPageGroup`) selects ops by newest-first
   * offset across ALL devices; remote ops landing between two Ctrl+Z presses
   * shift that indexing, and stale `redoStack` OpRefs may target ops the
   * remote write superseded. When `useSyncEvents` reloads a page's blocks
   * after `sync:complete` (ops_received > 0), it must also drop that page's
   * undo anchors here. Reset to the pristine baseline (empty undo stack,
   * depth 0, empty redo stack + group sizes) — identical to a fresh page,
   * but only for pages whose op-log actually changed. No-op for pages with
   * no recorded undo state.
   *
   * #2468 note — captured LOCAL refs technically stay valid under remote
   * traffic (that's the point of ref addressing), but a remote write may
   * have SUPERSEDED the state a captured op mutated; reverting it after the
   * user has seen the synced content is surprising. We deliberately keep the
   * conservative #731 full reset; relaxing it is future work.
   */
  reanchorAfterRemoteOps: (pageId: string) => void
}

/** Pristine per-page baseline. */
function emptyPageState(): PageUndoState {
  return { undoStack: [], redoStack: [], undoDepth: 0, redoGroupSizes: [] }
}

/**
 * Get existing page state or create a default.
 * NOTE: The returned object is NOT automatically stored in the Map.
 * Caller must use set() to persist any changes.
 */
function getOrCreatePage(pages: Map<string, PageUndoState>, pageId: string): PageUndoState {
  const existing = pages.get(pageId)
  if (existing) return existing
  return emptyPageState()
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

/**
 * Fold a batch undo response into a page's redo bookkeeping — shared by the
 * ref-addressed and positional undo paths.
 *
 * Pushes each op's `new_op_ref` — the appended REVERSE op (flagged
 * `is_undo = 1`) — onto the redo stack in response order. Redo means
 * "reverse the undo op", and `redo_page_op` REJECTS a forward-op ref (#659),
 * so the stack must carry the reverse ops' refs, NOT `reversed_op` (the
 * original forward op). Newest-first ops are pushed first, so the OLDEST
 * op's reverse ends up at the front — the order `performSingleRedo` pops for
 * a correct oldest-first redo replay. Advances `undoDepth` by the number of
 * reverted ops so the next positional fallback seeds at the next-older
 * group, and records the group size for redo.
 *
 * #1561 — clamp the recorded group size to what the redo stack can back
 * (`redoStack.length - sum(existing redoGroupSizes)`) in case
 * `reanchorAfterRemoteOps` / `onNewAction` reset the entry mid-flight,
 * preserving the invariant `sum(redoGroupSizes) <= redoStack.length`.
 */
function applyUndoResults(current: PageUndoState, results: UndoResult[]): PageUndoState {
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
}

/**
 * Remove `entry` from an undo stack by IDENTITY. If a concurrent
 * `onNewAction` / `reanchorAfterRemoteOps` replaced or reset the stack while
 * the undo IPC was in flight, the object is gone and the stack is returned
 * untouched — the reset already established the state the interleaver wanted
 * (mirrors the #1561/#1692 reconcile-onto-live-state discipline).
 */
function withoutEntry(undoStack: UndoStackEntry[], entry: UndoStackEntry): UndoStackEntry[] {
  const idx = undoStack.indexOf(entry)
  if (idx < 0) return undoStack
  return [...undoStack.slice(0, idx), ...undoStack.slice(idx + 1)]
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
  // Undo paths — ref-addressed (#2468) and positional fallback (#2190)
  // ---------------------------------------------------------------------------

  /**
   * #2468 — revert a captured-ref entry: ONE `undoOp` IPC for a single ref,
   * ONE atomic `undoOps` IPC for a coalesced ref-set (submitted newest-first;
   * the backend returns results newest-first either way).
   *
   * On failure (e.g. a Validation rejection: foreign ref, already-reversed op)
   * NO local state is mutated — the entry stays on the stack and redo/depth
   * are untouched, so the stack stays internally consistent. The atomic-abort
   * contract of `undoOps` guarantees the backend reverted nothing either. A
   * permanently-dead ref (something else already reversed it) self-heals on
   * the next `onNewAction` / `reanchorAfterRemoteOps` reset.
   */
  async function undoByRefs(pageId: string, entry: UndoStackEntry): Promise<UndoResult | null> {
    const refs = entry.refs as OpRef[]
    // Captured refs accumulate in APPEND order; submit newest-first to match
    // the backend's revert order (and its newest-first response contract).
    const newestFirst = refs.toReversed()

    let results: UndoResult[]
    try {
      if (newestFirst.length === 1) {
        results = [await undoOp({ opRef: newestFirst[0] as OpRef })]
      } else {
        results = await undoOps({ ops: newestFirst })
      }
    } catch (err) {
      logger.error('UndoStore', 'undo_op failed', { pageId, refCount: newestFirst.length }, err)
      notify.warning(t('undo.batchUnavailable'))
      return null
    }

    // Defensive: an empty response means nothing was reverted; drop the dead
    // entry so Ctrl+Z isn't stuck resubmitting it forever.
    if (results.length === 0) {
      set((state) => ({
        pages: setPageState(state.pages, pageId, (current) =>
          current ? { ...current, undoStack: withoutEntry(current.undoStack, entry) } : current,
        ),
      }))
      return null
    }

    // Reconcile in ONE set: pop the reverted entry (identity-matched — see
    // `withoutEntry` for the mid-flight-reset seam) and fold the batch
    // response into redo bookkeeping. If `clearPage` cleared the page entry
    // mid-flight, `current` is undefined and we drop the result rather than
    // re-seeding (#753/#1677).
    set((state) => ({
      pages: setPageState(state.pages, pageId, (current) => {
        if (!current) return current
        return applyUndoResults(
          { ...current, undoStack: withoutEntry(current.undoStack, entry) },
          results,
        )
      }),
    }))

    return results[0] ?? null
  }

  /**
   * Positional fallback (#2190 path, documented fallback under #2468).
   * `entry` is the ref-less undo-stack entry being reverted, or null when the
   * stack is empty (history predating FE tracking — nothing to pop).
   */
  async function undoPositional(
    pageId: string,
    entry: UndoStackEntry | null,
    initialDepth: number,
  ): Promise<UndoResult | null> {
    // #2190 — ONE IPC reverts the entire consecutive same-device,
    // within-window undo group in a single IMMEDIATE transaction. The backend
    // resolves the subtree + the group's op refs once and returns one
    // `UndoResult` per reverted op, newest-first.
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

    // Reconcile state from the batch response in one `set` (see
    // `applyUndoResults`), popping the fallback entry that was reverted
    // (identity-matched; a mid-flight reset wins — #1561/#1692). A page
    // entry cleared mid-flight drops the result rather than re-seeding
    // (#753/#1677).
    set((state) => ({
      pages: setPageState(state.pages, pageId, (current) => {
        if (!current) return current
        const undoStack = entry ? withoutEntry(current.undoStack, entry) : current.undoStack
        return applyUndoResults({ ...current, undoStack }, results)
      }),
    }))

    // Non-empty (guarded above); `?? null` satisfies noUncheckedIndexedAccess.
    return results[0] ?? null
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
        // Snapshot the undo target: the top stack entry (newest action), plus
        // the positional anchor the fallback seeds at (0 = most recent
        // undoable op) in case the entry is ref-less or the stack is empty.
        const pageState = getOrCreatePage(get().pages, pageId)
        const top = pageState.undoStack[0] ?? null
        const initialDepth = pageState.undoDepth

        // Optimistically ensure a page entry exists BEFORE the await so a
        // `clearPage` landing mid-flight is detectable on the success path
        // (`current` becomes undefined) — mirrors the pre-#2190 optimistic
        // marker and the #753 "don't re-seed after an explicit clear" fix.
        set((s) => ({
          pages: setPageState(s.pages, pageId, (current) => current ?? emptyPageState()),
        }))

        // #2468 — ref-addressed when the captured entry carries refs;
        // positional fallback for ref-less entries (batch commands) and for
        // pre-tracking history (empty stack).
        if (top && top.refs !== null && top.refs.length > 0) {
          return await undoByRefs(pageId, top)
        }
        return await undoPositional(pageId, top, initialDepth)
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
        // #2468 — each redo appends a NEW op that re-applies the original
        // action; its ref is the next undo target (`undo_op` accepts it, and
        // the original forward op would be rejected as already-reversed).
        // Collect the replayed group's refs in replay (oldest-first append)
        // order so they re-enter the undo stack as ONE coalesced entry.
        const newUndoRefs: OpRef[] = []

        for (let i = 0; i < groupSize; i++) {
          const result = await performSingleRedo(pageId)
          if (!result) break
          if (i === 0) firstResult = result
          newUndoRefs.push(result.new_op_ref)
          redoneCount++
        }

        if (redoneCount > 0) {
          const residual = groupSize - redoneCount
          set((state) => ({
            pages: setPageState(state.pages, pageId, (current) => {
              if (!current) return current
              // Reconcile the group-size accounting for what actually redid.
              // A full group (redoneCount === groupSize) pops its entry. On a
              // PARTIAL redo (a mid-group `performSingleRedo` failure rolled
              // the remaining ops back onto the redo stack), keep a smaller
              // residual entry equal to the ops still pending, so a later
              // redo replays exactly those — rather than dropping the whole
              // entry and orphaning `redoStack` refs from their group
              // accounting (which would break the
              // `sum(redoGroupSizes) <= redoStack.length` pairing the undo
              // path relies on).
              let redoGroupSizes = current.redoGroupSizes
              if (redoGroupSizes.length > 0) {
                const trimmed = redoGroupSizes.slice(0, -1)
                redoGroupSizes = residual > 0 ? [...trimmed, residual] : trimmed
              }
              // #2468 — the redone group becomes the next undo target: push
              // its refs as ONE ref-addressed entry so undo→redo→undo cycles
              // stay ref-addressed end-to-end.
              const undoStack = [{ refs: newUndoRefs, at: Date.now() }, ...current.undoStack].slice(
                0,
                MAX_UNDO_STACK,
              )
              return { ...current, redoGroupSizes, undoStack }
            }),
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

    onNewAction: (pageId: string, opRefs?: OpRef[], coalesceKey?: string) => {
      // Idempotent no-op (`op_refs: []` — e.g. add_tag on an already-tagged
      // block): the backend appended nothing, so there is nothing to undo and
      // no reason to invalidate redo history. Ignore entirely (see interface
      // doc — callers should already skip the notification).
      if (opRefs !== undefined && opRefs.length === 0) return

      const now = Date.now()
      set((state) => ({
        pages: setPageState(state.pages, pageId, (current) => {
          const base = current ?? emptyPageState()
          const top = base.undoStack[0]
          // #2600 — a defined `coalesceKey` matching the top entry's key
          // extends its group REGARDLESS of elapsed time (a block's mid-typing
          // debounced commits pause longer than the timed window), in addition
          // to the #2468 timed window for ref bursts. `undefined` never matches.
          const sameKeyGroup =
            top !== undefined && coalesceKey !== undefined && top.coalesceKey === coalesceKey
          const withinWindow =
            top !== undefined && now - top.at <= UNDO_GROUP_WINDOW_MS && now >= top.at
          let undoStack: UndoStackEntry[]
          if (top !== undefined && (sameKeyGroup || withinWindow)) {
            // Capture-time coalescing: this action joins the top entry's group
            // (`at` advances to the newest action; the entry adopts this
            // action's `coalesceKey` so the session identity tracks the latest
            // commit). The merged entry stays ref-addressed only when BOTH
            // sides carry refs; a ref-less participant degrades the whole group
            // to the positional fallback, which the backend groups over the
            // same window — one Ctrl+Z still reverts the burst, positionally.
            const merged: UndoStackEntry =
              top.refs !== null && opRefs !== undefined
                ? { refs: [...top.refs, ...opRefs], at: now, coalesceKey }
                : { refs: null, at: now, coalesceKey }
            undoStack = [merged, ...base.undoStack.slice(1)]
          } else {
            undoStack = [{ refs: opRefs ?? null, at: now, coalesceKey }, ...base.undoStack].slice(
              0,
              MAX_UNDO_STACK,
            )
          }
          return { undoStack, redoStack: [], undoDepth: 0, redoGroupSizes: [] }
        }),
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
        // user never touched has no stale anchor to fix, and creating a
        // pristine entry for it would needlessly grow the Map.
        pages: setPageState(state.pages, pageId, (current) =>
          current ? emptyPageState() : current,
        ),
      }))
    },
  }
})
