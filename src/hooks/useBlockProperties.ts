/**
 * useBlockProperties — hook for block property state and task cycling.
 *
 * Manages:
 * - getTodoState callback (reads from block store)
 * - handleToggleTodo callback (cycles through TODO/DOING/DONE/CANCELLED/none)
 * - handleTogglePriority callback (cycles through 1/2/3/none)
 *
 * Uses thin commands (set_todo_state / set_priority) instead of the generic
 * set_property / delete_property, and reads state from the block store
 * instead of a separate properties cache.
 */

import { useCallback, useRef } from 'react'

import { announce } from '@/lib/announcer'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getPriorityCycle } from '@/lib/priority-levels'
import {
  getProperty,
  setPriority as setPriorityCmd,
  setTodoState as setTodoStateCmd,
} from '@/lib/tauri'
import { usePageBlockStoreApi } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

/**
 * Locked task state cycle: none -> TODO -> DOING -> DONE -> CANCELLED -> none.
 *
 * This cycle is intentionally fixed — users cannot add or remove states.
 * DONE sits immediately after DOING because finishing is the overwhelmingly
 * common terminal state; CANCELLED lives at the end of the cycle as the
 * "abandoned" escape hatch. reverses an earlier ordering that put
 * CANCELLED before DONE.
 */
const TASK_CYCLE: readonly (string | null)[] = [null, 'TODO', 'DOING', 'DONE', 'CANCELLED']

/** Display labels for screen reader announcements. */
const STATE_LABELS: Record<string, string> = {
  TODO: 'To do',
  DOING: 'In progress',
  CANCELLED: 'Cancelled',
  DONE: 'Done',
}

export interface UseBlockPropertiesReturn {
  getTodoState: (blockId: string) => string | null
  handleToggleTodo: (blockId: string) => Promise<void>
  handleTogglePriority: (blockId: string) => Promise<void>
}

/**
 * #2922 — per-block toggle serialization queue. Mirrors the `enqueueMove`
 * queue in `src/stores/page-blocks.ts` (#774): a rapid Space,Space on a TODO
 * gutter used to fire two independent, concurrent Tauri calls (TODO→DOING,
 * DOING→DONE) with no guaranteed completion order — the second write could
 * land before the first, and a failed first call's optimistic-revert could
 * snap the UI back after the second call had already landed a newer state in
 * the DB.
 *
 * `enqueue(blockId, run)` chains each block's toggles into a single promise
 * per block id, so a queued second press's `run` starts only after the first
 * press's `run` (IPC + optimistic update/revert) has fully settled. Because
 * `run` captures its `current`/`nextState` snapshot from the store at the
 * time it actually executes (not when it was enqueued), the second press
 * always cycles from the state the first press settled to.
 *
 * Keyed by block id — toggles on DIFFERENT blocks stay concurrent. The chain
 * swallows a predecessor rejection (each toggle owns its own try/catch and
 * never throws) before running the next link, so one failed toggle does not
 * strand the queue. Todo and priority toggles use separate queue instances
 * (call `useToggleQueue()` once per property) since they mutate independent
 * fields and don't need to serialize against each other.
 */
function useToggleQueue() {
  const queueRef = useRef<Map<string, Promise<unknown>>>(undefined)
  queueRef.current ??= new Map()

  return useCallback(<T>(blockId: string, run: () => Promise<T>): Promise<T> => {
    const queue = queueRef.current as Map<string, Promise<unknown>>
    const prev = queue.get(blockId)
    const next: Promise<T> = prev ? prev.then(run, run) : run()
    queue.set(blockId, next)
    void next.finally(() => {
      if (queue.get(blockId) === next) queue.delete(blockId)
    })
    return next
  }, [])
}

/**
 * F-37: warn when completing a task that has unresolved `blocked_by`
 * dependencies. Mirrors the slash-command path in `useBlockSlashCommands.ts`
 * so the gutter-cycle path stays in sync. Failures are logged, not surfaced —
 * the dependency check is advisory.
 */
function warnIfBlocked(blockId: string): void {
  // Single-key PK lookup; the hook only needs the
  // `blocked_by` row, not the full vocabulary the FE used to ship.
  getProperty(blockId, 'blocked_by')
    .then((row) => {
      const hasBlockedBy = row != null && row.value_ref != null
      if (hasBlockedBy)
        notify.warning(i18n.t('dependency.dependencyWarning'), { id: 'dependency-warning' })
    })
    .catch((err) => {
      logger.warn('useBlockProperties', 'F-37 dependency check failed', undefined, err)
    })
}

export function useBlockProperties(): UseBlockPropertiesReturn {
  const pageStore = usePageBlockStoreApi()
  const enqueueTodoToggle = useToggleQueue()
  const enqueuePriorityToggle = useToggleQueue()

  /** Get the current todo state for a block from the block store. */
  const getTodoState = useCallback(
    (blockId: string): string | null =>
      pageStore.getState().blocksById.get(blockId)?.todo_state ?? null,
    [pageStore],
  )

  /** Cycle through task states: none -> TODO -> DOING -> DONE -> CANCELLED -> none. */
  const handleToggleTodo = useCallback(
    (blockId: string) =>
      enqueueTodoToggle(blockId, async () => {
        const current = pageStore.getState().blocksById.get(blockId)?.todo_state ?? null
        const currentIdx = TASK_CYCLE.indexOf(current)
        const nextIdx = (currentIdx + 1) % TASK_CYCLE.length
        const nextState = TASK_CYCLE[nextIdx] ?? null

        // Optimistic update (before IPC) to prevent race on rapid toggles
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: nextState } : b)),
        }))

        try {
          await setTodoStateCmd(blockId, nextState)
          const { rootParentId } = pageStore.getState()
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        } catch {
          // #2922 — only revert if nothing newer has superseded this call's
          // write. `enqueueTodoToggle` already prevents another queued
          // toggle on this block from starting while this IPC is in flight,
          // but an external write (sync echo, undo, concurrent editor) can
          // still land on the block during the await — don't clobber it by
          // reverting to a now-stale `current`.
          const live = pageStore.getState().blocksById.get(blockId)?.todo_state ?? null
          if (live === nextState) {
            pageStore.setState((s) => ({
              blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: current } : b)),
            }))
          }
          notify.error(i18n.t('blockTree.setTaskStateFailed'))
          return
        }

        // F-37: warn when completing a task that has unresolved dependencies
        if (nextState === 'DONE') warnIfBlocked(blockId)

        announce(
          i18n.t('announce.taskState', {
            state: nextState ? (STATE_LABELS[nextState] ?? nextState) : 'none',
          }),
        )
      }),
    [pageStore, enqueueTodoToggle],
  )

  /**
   * Cycle through priority levels. The cycle is
   * `[null, ...getPriorityLevels()]` — user-configurable via the
   * `priority` property definition's options. Called at click
   * time so the cycle always reflects the current level set.
   */
  const handleTogglePriority = useCallback(
    (blockId: string) =>
      enqueuePriorityToggle(blockId, async () => {
        const cycle = getPriorityCycle()
        const current = pageStore.getState().blocksById.get(blockId)?.priority ?? null
        const currentIdx = cycle.indexOf(current)
        const nextIdx = (currentIdx + 1) % cycle.length
        const nextState = cycle[nextIdx] ?? null

        // Optimistic update (before IPC) to prevent race on rapid toggles
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority: nextState } : b)),
        }))

        try {
          await setPriorityCmd(blockId, nextState)
          const { rootParentId } = pageStore.getState()
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        } catch {
          // #2922 — see the matching guard in handleToggleTodo: only revert
          // if nothing newer has superseded this call's write.
          const live = pageStore.getState().blocksById.get(blockId)?.priority ?? null
          if (live === nextState) {
            pageStore.setState((s) => ({
              blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority: current } : b)),
            }))
          }
          notify.error(i18n.t('blockTree.setPriorityFailed'))
          return
        }

        const PRIORITY_LABELS: Record<string, string> = { '1': 'High', '2': 'Medium', '3': 'Low' }
        announce(
          i18n.t('announce.prioritySet', {
            level: nextState ? (PRIORITY_LABELS[nextState] ?? nextState) : 'none',
          }),
        )
      }),
    [pageStore, enqueuePriorityToggle],
  )

  return {
    getTodoState,
    handleToggleTodo,
    handleTogglePriority,
  }
}
