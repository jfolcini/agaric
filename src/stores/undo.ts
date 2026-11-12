/**
 * Undo store — session-scoped, per-page undo/redo.
 *
 * Undo is ref-addressed (#2468): mutating commands return the `OpRef`s they
 * appended, the call site passes them to `onNewAction`, and Ctrl+Z reverts
 * those exact refs through `undoOp` / `undoOps`, so ops landing between
 * capture and undo (sync, a debounced flush, another pane) cannot shift the
 * target. Entries without refs, and history from before the page was tracked,
 * fall back to the positional `undoPageGroup(pageId, depth, windowMs)`.
 *
 * Actions within `UNDO_GROUP_WINDOW_MS` coalesce into one entry that one
 * Ctrl+Z reverts atomically; a ref-less action in the burst degrades the entry
 * to the positional fallback, which the backend groups by the same window.
 * A new action clears the redo stack.
 */

import { create } from 'zustand'

import { announce } from '@/lib/announcer'
import { isNonReversible, isNotFound, isValidation, takenNameReason, unwrap } from '@/lib/app-error'
import type { OpRef, UndoResult } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { parsePayloadObject } from '@/lib/history-utils'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PAGINATION_MAX, paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

export type { OpRef, UndoResult }

export const MAX_REDO_STACK = 100

/**
 * Entries past the cap fall off the bottom; undo then continues positionally
 * (`undoDepth` counts across both paths), so the cap bounds memory, not reach.
 */
export const MAX_UNDO_STACK = 100

/**
 * Cap on the refs one coalesced entry may accumulate (#3323). Same-key
 * coalescing is time-unbounded, and the whole entry reverts in one `undoOps`
 * call, which the backend rejects above `MAX_REVERT_OPS`
 * (`src-tauri/src/commands/history.rs`), wedging Ctrl+Z on that page. Past
 * the cap `onNewAction` pushes a fresh entry, so each Ctrl+Z reverts one chunk.
 */
export const MAX_COALESCED_UNDO_REFS = 200

/**
 * Window (ms) within which consecutive ops group into one undo: wide enough
 * for a recurrence burst on a slow device, narrow enough not to merge two
 * intentional actions. Drives capture-time coalescing in `onNewAction` and
 * the backend's grouping for the positional fallback.
 */
export const UNDO_GROUP_WINDOW_MS = 500

/** Whether two ISO-8601 timestamps are within `UNDO_GROUP_WINDOW_MS` of each other. */
export function isWithinUndoGroup(ts1: string, ts2: string): boolean {
  const d1 = new Date(ts1).getTime()
  const d2 = new Date(ts2).getTime()
  if (Number.isNaN(d1) || Number.isNaN(d2)) return false
  return Math.abs(d1 - d2) <= UNDO_GROUP_WINDOW_MS
}

/** One undoable action group on a page's undo stack. */
export interface UndoStackEntry {
  /**
   * Refs in append order (oldest first); `undo()` submits them newest first.
   * `null` marks a positional-fallback entry.
   */
  refs: OpRef[] | null
  /** Epoch ms of the last action coalesced in; the capture window slides from here. */
  at: number
  /**
   * Consecutive actions with the same defined key coalesce regardless of
   * elapsed time, so a block's debounced typing commits and its blur commit
   * undo as one (`edit:<blockId>`). `undefined` never matches.
   */
  coalesceKey?: string | undefined
}

interface PageUndoState {
  /** Undo targets, newest first. `redo()` pushes each redone group back on. */
  undoStack: UndoStackEntry[]
  /**
   * Each entry is an undo's `new_op_ref` (the reverse op), which
   * `redo_page_op` reverses; it refuses the original forward op (#659).
   */
  redoStack: OpRef[]
  /**
   * Ops undone so far: the positional fallback's anchor. Ref-addressed undos
   * advance it too, so interleaved paths stay coherent; they never read it.
   */
  undoDepth: number
  /** Ops per batch undo, so redo replays the whole group. */
  redoGroupSizes: number[]
}

interface UndoStore {
  /** Per-page undo state, keyed by page ID. */
  pages: Map<string, PageUndoState>

  /**
   * Undo the top entry: by ref (`undoOp`, or one atomic `undoOps` for a
   * coalesced entry), else positionally. Returns the newest `UndoResult` or null.
   */
  undo: (pageId: string) => Promise<UndoResult | null>

  /**
   * Redo the last undone group; its new refs return to the undo stack as one
   * entry. Returns the first `UndoResult` or null.
   */
  redo: (pageId: string) => Promise<UndoResult | null>

  /** Whether redo is available for a page. */
  canRedo: (pageId: string) => boolean

  /**
   * Record a user mutation on a page: push or coalesce an undo entry and clear
   * redo. `opRefs` are the refs the IPC reported; omit them for a command that
   * reports none (positional-fallback entry). An empty array is an idempotent
   * no-op and is ignored. `coalesceKey` groups same-key actions regardless of
   * time; `merge: false` never joins the top entry, so a paste's toast Undo
   * does not take the typing flushed just before it.
   */
  onNewAction: (
    pageId: string,
    opRefs?: OpRef[],
    coalesceKey?: string,
    opts?: { merge?: boolean },
  ) => void

  /** Clear undo state for a page (called on navigation away). */
  clearPage: (pageId: string) => void

  /**
   * Reset a page's undo state after sync applied remote ops to it (#731):
   * remote ops shift the positional fallback, and stale redo refs may target
   * superseded ops. Captured refs would stay valid, but reverting a change the
   * user has since seen overwritten is surprising, so this resets fully. No-op
   * for a page with no undo state.
   */
  reanchorAfterRemoteOps: (pageId: string) => void

  /**
   * Toast Undo for a swipe or batch delete (#2901). Undoes the block's newest
   * `delete_block` op by its `(device_id, seq)` ref, not the top of the stack:
   * tapping the toast blurs a dirty editor, whose flush lands an `edit_block`
   * above the delete. For a batch, `blockId` is the selection roots, undone in
   * one atomic `undoOps`; a batch larger than one history page can report
   * failure (Trash still has it).
   *
   * The scan cannot see `is_undo` (`HistoryEntry` lacks it), so an undo op
   * newer than the swipe's delete would be picked and refused; the swipe path
   * cannot produce that order, as the block was alive when swiped.
   *
   * `reloadPage` is a callback because importing `page-blocks` here would
   * close an import cycle (`page-blocks` imports this store).
   */
  undoDeleteOf: (
    pageId: string,
    blockId: string | readonly string[],
    reloadPage: () => void | Promise<void>,
  ) => Promise<void>
}

/** Pristine per-page baseline. */
function emptyPageState(): PageUndoState {
  return { undoStack: [], redoStack: [], undoDepth: 0, redoGroupSizes: [] }
}

/** Existing page state or a default; the default is not stored, so persist through `set()`. */
function getOrCreatePage(pages: Map<string, PageUndoState>, pageId: string): PageUndoState {
  const existing = pages.get(pageId)
  if (existing) return existing
  return emptyPageState()
}

/** Copy of `pages` with `pageId`'s entry replaced by `updater(current)`; `undefined` deletes it. */
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
 * Fold a batch undo response into redo bookkeeping. Pushes each reverse op's
 * `new_op_ref` (never `reversed_op`: `redo_page_op` rejects forward ops, #659),
 * so the oldest op's reverse ends up on top, the order redo replays. Advances
 * `undoDepth` and records the group size, clamped to what the redo stack backs
 * so `sum(redoGroupSizes) <= redoStack.length` survives a mid-flight reset (#1561).
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
 * Remove `entry` by identity. If a concurrent reset replaced the stack while
 * the IPC was in flight, the entry is gone and the reset's state wins.
 */
function withoutEntry(undoStack: UndoStackEntry[], entry: UndoStackEntry): UndoStackEntry[] {
  const idx = undoStack.indexOf(entry)
  if (idx < 0) return undoStack
  return [...undoStack.slice(0, idx), ...undoStack.slice(idx + 1)]
}

/**
 * Whether a revert or replay failure repeats identically on retry, so the
 * caller drops the entry instead of wedging Ctrl+Z on it (#3353): `validation`
 * (oversized batch, duplicate or already-reversed ref, not an undo op,
 * replicated op), `not_found` (op compacted away), `non_reversible`.
 *
 * A taken page or tag name (`DuplicatePageTitle`, #6051) keeps its entry: its
 * toast names the holder, and the same Ctrl+Z works once that is renamed.
 * Some `non_reversible` moves are only temporarily impossible (prior parent in
 * trash, now a descendant, in another space), but the error carries no
 * sub-kind to tell them apart, and keeping them all restores the wedge. A
 * transient error (`pool_busy`, `database`, a dropped IPC) keeps its entry.
 */
function isPermanentRevertFailure(err: unknown): boolean {
  return (
    (isValidation(err) && err.code !== 'DuplicatePageTitle') ||
    isNotFound(err) ||
    isNonReversible(err)
  )
}

/**
 * How far back `undoDeleteOf` scans for its delete op. Only ops landing in
 * the toast's lifetime can sit above it, so a small window suffices; it bounds
 * the search, not the target, which is found by ref.
 */
const SWIPE_UNDO_HISTORY_SCAN = 50

/** Best-effort `block_id` from an op-log payload JSON string. */
function historyEntryBlockId(payload: string): string | null {
  const blockId = parsePayloadObject(payload)?.['block_id']
  return typeof blockId === 'string' ? blockId : null
}

/** `reason`: a taken-name refusal's own words (#6051), shown in place of the generic copy. */
function notifySwipeUndoFailed(reason: string | null = null): void {
  notify.error(reason ?? t('undo.undoFailedMessage'))
  announce(t('announce.undoFailed'))
}

export const useUndoStore = create<UndoStore>((set, get) => {
  /** Guard: page IDs with undo currently in progress. */
  const undoInProgress = new Set<string>()
  /**
   * The entry each page's in-flight `undo()` is reverting. `undo()` removes it
   * by identity, so `onNewAction` must not coalesce into it: the merged
   * replacement would keep the already-reversed refs, and every later Ctrl+Z
   * would fail on them (#2912).
   */
  const undoInProgressEntry = new Map<string, UndoStackEntry>()
  /** Guard: page IDs with redo currently in progress. */
  const redoInProgress = new Set<string>()

  /**
   * Redo one op, popping it optimistically. `retained` (ref back on
   * `redoStack`) and `dropped` (discarded) differ because the caller shrinks
   * the group's residual size only for a drop.
   */
  type RedoAttempt =
    | { status: 'ok'; result: UndoResult }
    /** Nothing left on `redoStack` — the loop should stop, nothing to account. */
    | { status: 'empty' }
    /** Transient failure: the ref is back on `redoStack`, retryable. */
    | { status: 'retained' }
    /** Non-retryable failure: the ref was discarded to avoid wedging redo. */
    | { status: 'dropped' }

  async function performSingleRedo(pageId: string): Promise<RedoAttempt> {
    const opRef = (() => {
      const state = get()
      const pageState = getOrCreatePage(state.pages, pageId)

      if (pageState.redoStack.length === 0) return null

      const [first, ...remainingStack] = pageState.redoStack

      // Derive from the updater's live `current`, as the rollback path does.
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

    if (opRef === null) return { status: 'empty' }

    try {
      const result = unwrap(await commands.redoPageOp(opRef.device_id, opRef.seq))

      return { status: 'ok', result }
    } catch (err) {
      logger.error('UndoStore', 'redo operation failed', { pageId }, err)
      // A redo can revive a taken name too (#6051); that refusal says why.
      const reason = takenNameReason(err)
      if (reason !== null) notify.warning(reason)
      // A permanent rejection drops the ref, or every later Ctrl+Shift+Z
      // reissues the same doomed IPC (#3546). A taken name is kept: the same
      // redo succeeds once the name is free.
      const retain = !isPermanentRevertFailure(err)
      // The redo did not happen, so `undoDepth` is restored either way; only
      // the ref's place on `redoStack` differs.
      set((state) => ({
        pages: setPageState(state.pages, pageId, (current) =>
          current
            ? {
                ...current,
                redoStack: retain ? [opRef, ...current.redoStack] : current.redoStack,
                undoDepth: current.undoDepth + 1,
              }
            : current,
        ),
      }))
      return retain ? { status: 'retained' } : { status: 'dropped' }
    }
  }

  /**
   * Revert a captured-ref entry: one `undoOp`, or one atomic `undoOps` for a
   * coalesced set. On failure redo and depth are untouched (the backend
   * reverted nothing); a transient failure leaves the entry for a retry, a
   * permanent one drops it (`isPermanentRevertFailure`).
   */
  async function undoByRefs(pageId: string, entry: UndoStackEntry): Promise<UndoResult | null> {
    const refs = entry.refs as OpRef[]
    // Newest first, the backend's revert order.
    const newestFirst = refs.toReversed()

    let results: UndoResult[]
    try {
      if (newestFirst.length === 1) {
        results = [unwrap(await commands.undoOp(newestFirst[0] as OpRef))]
      } else {
        results = unwrap(await commands.undoOps(newestFirst))
      }
    } catch (err) {
      logger.error('UndoStore', 'undo_op failed', { pageId, refCount: newestFirst.length }, err)
      // An undo reviving a taken name says which name (#6051).
      notify.warning(takenNameReason(err) ?? t('undo.batchUnavailable'))
      // A permanent failure would wedge Ctrl+Z on this entry; drop it.
      if (isPermanentRevertFailure(err)) {
        set((state) => ({
          pages: setPageState(state.pages, pageId, (current) =>
            current ? { ...current, undoStack: withoutEntry(current.undoStack, entry) } : current,
          ),
        }))
      }
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

    // Pop the entry by identity and fold the response into redo state. A
    // `clearPage` mid-flight leaves `current` undefined: drop the result
    // rather than re-seed (#753).
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
   * Positional fallback. `entry` is the ref-less entry being reverted, or null
   * for an empty stack.
   */
  async function undoPositional(
    pageId: string,
    entry: UndoStackEntry | null,
    initialDepth: number,
  ): Promise<UndoResult | null> {
    // One IPC reverts the whole same-device, within-window group atomically and
    // returns one result per op, newest first.
    let results: UndoResult[]
    try {
      results = unwrap(await commands.undoPageGroup(pageId, initialDepth, UNDO_GROUP_WINDOW_MS))
    } catch (err) {
      logger.error('UndoStore', 'undo_page_group failed', { pageId }, err)
      notify.warning(takenNameReason(err) ?? t('undo.batchUnavailable'))
      return null
    }

    // Empty group — the seed op doesn't exist (nothing left to undo).
    if (results.length === 0) return null

    // Same reconcile as `undoByRefs`.
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

  async function undoDeleteOfImpl(
    pageId: string,
    blockId: string | readonly string[],
    reloadPage: () => void | Promise<void>,
  ): Promise<void> {
    const blockIds = typeof blockId === 'string' ? [blockId] : blockId
    try {
      // With no active space known, the catch below refuses the undo.
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId == null) throw new Error('No active space; cannot undo')
      const history = unwrap(
        await commands.listPageHistory(
          pageId,
          null,
          requireActiveScope(spaceId),
          null,
          // A batch appends one row per selected block, the roots' among them
          // in no set order, so it scans the widest page.
          paginationLimit(typeof blockId === 'string' ? SWIPE_UNDO_HISTORY_SCAN : PAGINATION_MAX),
        ),
      )
      // Newest first, each block's own local `delete_block` row. A peer's
      // delete arrives as a replicated audit row that `undo_op` rejects
      // (#4328); the local row beneath it is the swipe's.
      const unfound = new Set(blockIds)
      const refs: OpRef[] = []
      for (const entry of history.items) {
        if (entry.op_type !== 'delete_block' || entry.is_replicated) continue
        const id = historyEntryBlockId(entry.payload)
        if (id !== null && unfound.delete(id)) {
          refs.push({ device_id: entry.device_id, seq: entry.seq })
        }
      }
      if (unfound.size > 0) {
        logger.warn('UndoStore', 'swipe-delete undo: delete op not found in page history', {
          pageId,
          blockId,
        })
        notifySwipeUndoFailed()
        return
      }

      if (refs.length === 1) {
        unwrap(await commands.undoOp(refs[0] as OpRef))
      } else {
        unwrap(await commands.undoOps(refs))
      }

      // This undo bypasses the stack, so stale depth and redo anchors could
      // target the ops it shifted; treat it as a new action.
      get().onNewAction(pageId)
      notify(t('undo.op.deleteBlock', { defaultValue: t('undo.undoneMessage') }), {
        duration: 1500,
      })
      announce(t('announce.undone'))
      await reloadPage()
    } catch (err) {
      logger.error('UndoStore', 'swipe-delete undo failed', { pageId, blockId }, err)
      notifySwipeUndoFailed(takenNameReason(err))
    }
  }

  return {
    pages: new Map(),

    undo: async (pageId: string) => {
      if (undoInProgress.has(pageId)) {
        logger.warn('UndoStore', 'undo already in progress, skipping', { pageId })
        return null
      }
      undoInProgress.add(pageId)
      try {
        const pageState = getOrCreatePage(get().pages, pageId)
        const top = pageState.undoStack[0] ?? null
        const initialDepth = pageState.undoDepth

        // Mark the entry so a concurrent `onNewAction` will not coalesce into it.
        if (top) undoInProgressEntry.set(pageId, top)

        // Ensure the entry exists before the await, so a `clearPage` landing
        // mid-flight shows as `current` undefined on the success path (#753).
        set((s) => ({
          pages: setPageState(s.pages, pageId, (current) => current ?? emptyPageState()),
        }))

        if (top && top.refs !== null && top.refs.length > 0) {
          return await undoByRefs(pageId, top)
        }
        return await undoPositional(pageId, top, initialDepth)
      } finally {
        undoInProgress.delete(pageId)
        undoInProgressEntry.delete(pageId)
      }
    },

    redo: async (pageId: string) => {
      if (redoInProgress.has(pageId)) return null
      redoInProgress.add(pageId)
      try {
        const pageState = getOrCreatePage(get().pages, pageId)
        if (pageState.redoStack.length === 0) return null

        const groupSize =
          pageState.redoGroupSizes.length > 0 ? (pageState.redoGroupSizes.at(-1) as number) : 1

        let firstResult: UndoResult | null = null
        let redoneCount = 0
        // Each redo appends a new op whose ref is the next undo target; the
        // group's refs re-enter the undo stack as one entry, oldest first.
        const newUndoRefs: OpRef[] = []

        // Refs dropped as permanent left `redoStack` unreplayed, so they come
        // off the group's residual size too (#3546).
        let droppedCount = 0

        for (let i = 0; i < groupSize; i++) {
          const attempt = await performSingleRedo(pageId)
          if (attempt.status !== 'ok') {
            if (attempt.status === 'dropped') droppedCount++
            break
          }
          if (i === 0) firstResult = attempt.result
          newUndoRefs.push(attempt.result.new_op_ref)
          redoneCount++
        }

        // A dropped ref changes the accounting even when NOTHING redid
        // successfully (groupSize 1, first attempt permanently rejected):
        // the stale group-size entry has to go, or it outlives its refs.
        if (redoneCount > 0 || droppedCount > 0) {
          const residual = groupSize - redoneCount - droppedCount
          set((state) => ({
            pages: setPageState(state.pages, pageId, (current) => {
              if (!current) return current
              // A partial redo keeps a residual entry for the ops still
              // pending, preserving `sum(redoGroupSizes) <= redoStack.length`.
              let redoGroupSizes = current.redoGroupSizes
              if (redoGroupSizes.length > 0) {
                const trimmed = redoGroupSizes.slice(0, -1)
                redoGroupSizes = residual > 0 ? [...trimmed, residual] : trimmed
              }
              // A redo that replayed nothing pushes no entry: `{ refs: [] }`
              // is neither ref-addressable nor a positional target.
              const undoStack =
                newUndoRefs.length > 0
                  ? [{ refs: newUndoRefs, at: Date.now() }, ...current.undoStack].slice(
                      0,
                      MAX_UNDO_STACK,
                    )
                  : current.undoStack
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

    onNewAction: (pageId, opRefs, coalesceKey, { merge = true } = {}) => {
      // `op_refs: []` is an idempotent no-op: nothing to undo, redo stays valid.
      if (opRefs !== undefined && opRefs.length === 0) return

      const now = Date.now()
      set((state) => ({
        pages: setPageState(state.pages, pageId, (current) => {
          const base = current ?? emptyPageState()
          const top = base.undoStack[0]
          // Never coalesce into the entry an in-flight `undo()` is reverting
          // (see `undoInProgressEntry`); push a fresh entry above it instead.
          const topIsInFlightUndo = top !== undefined && undoInProgressEntry.get(pageId) === top
          const sameKeyGroup =
            !topIsInFlightUndo &&
            top !== undefined &&
            coalesceKey !== undefined &&
            top.coalesceKey === coalesceKey
          const withinWindow =
            !topIsInFlightUndo &&
            top !== undefined &&
            now - top.at <= UNDO_GROUP_WINDOW_MS &&
            now >= top.at
          // Only a ref-carrying merge grows; a ref-less one degrades to positional.
          const withinCoalesceCap =
            top === undefined ||
            top.refs === null ||
            opRefs === undefined ||
            top.refs.length + opRefs.length <= MAX_COALESCED_UNDO_REFS
          let undoStack: UndoStackEntry[]
          if (merge && top !== undefined && (sameKeyGroup || withinWindow) && withinCoalesceCap) {
            // The merged entry stays ref-addressed only if both sides carry
            // refs; otherwise the positional fallback reverts the burst, which
            // the backend groups over the same window.
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
        // A page the user never touched has no stale anchor; do not create one.
        pages: setPageState(state.pages, pageId, (current) =>
          current ? emptyPageState() : current,
        ),
      }))
    },

    undoDeleteOf: (
      pageId: string,
      blockId: string | readonly string[],
      reloadPage: () => void | Promise<void>,
    ) => undoDeleteOfImpl(pageId, blockId, reloadPage),
  }
})

/** The page's latest undo entry, compared by identity. */
export function latestUndoEntry(pageId: string): UndoStackEntry | undefined {
  return useUndoStore.getState().pages.get(pageId)?.undoStack[0]
}
