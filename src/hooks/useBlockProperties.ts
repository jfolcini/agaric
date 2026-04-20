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

import { useCallback } from 'react'
import { toast } from 'sonner'
import { announce } from '../lib/announcer'
import { i18n } from '../lib/i18n'
import { getPriorityCycle } from '../lib/priority-levels'
import { setPriority as setPriorityCmd, setTodoState as setTodoStateCmd } from '../lib/tauri'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

/**
 * Locked task state cycle (UX-202): none -> TODO -> DOING -> DONE -> CANCELLED -> none.
 *
 * This cycle is intentionally fixed — users cannot add or remove states.
 * DONE sits immediately after DOING because finishing is the overwhelmingly
 * common terminal state; CANCELLED lives at the end of the cycle as the
 * "abandoned" escape hatch. UX-234 reverses an earlier ordering that put
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

export function useBlockProperties(): UseBlockPropertiesReturn {
  const pageStore = usePageBlockStoreApi()

  /** Get the current todo state for a block from the block store. */
  const getTodoState = useCallback(
    (blockId: string): string | null => {
      return pageStore.getState().blocks.find((b) => b.id === blockId)?.todo_state ?? null
    },
    [pageStore],
  )

  /** Cycle through task states: none -> TODO -> DOING -> DONE -> CANCELLED -> none. */
  const handleToggleTodo = useCallback(
    async (blockId: string) => {
      const current = pageStore.getState().blocks.find((b) => b.id === blockId)?.todo_state ?? null
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
        // Revert optimistic update on failure
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: current } : b)),
        }))
        toast.error(i18n.t('blockTree.setTaskStateFailed'))
        return
      }

      announce(
        i18n.t('announce.taskState', {
          state: nextState ? (STATE_LABELS[nextState] ?? nextState) : 'none',
        }),
      )
    },
    [pageStore],
  )

  /**
   * Cycle through priority levels. The cycle is
   * `[null, ...getPriorityLevels()]` — user-configurable via the
   * `priority` property definition's options (UX-201b). Called at click
   * time so the cycle always reflects the current level set.
   */
  const handleTogglePriority = useCallback(
    async (blockId: string) => {
      const cycle = getPriorityCycle()
      const current = pageStore.getState().blocks.find((b) => b.id === blockId)?.priority ?? null
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
        // Revert optimistic update on failure
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority: current } : b)),
        }))
        toast.error(i18n.t('blockTree.setPriorityFailed'))
        return
      }

      const PRIORITY_LABELS: Record<string, string> = { '1': 'High', '2': 'Medium', '3': 'Low' }
      announce(
        i18n.t('announce.prioritySet', {
          level: nextState ? (PRIORITY_LABELS[nextState] ?? nextState) : 'none',
        }),
      )
    },
    [pageStore],
  )

  return {
    getTodoState,
    handleToggleTodo,
    handleTogglePriority,
  }
}
