/**
 * useBlockProperties — hook for block property state and task cycling.
 *
 * Manages:
 * - getTodoState callback (reads from block store)
 * - handleToggleTodo callback (cycles through TODO/DOING/DONE/none)
 * - handleTogglePriority callback (cycles through A/B/C/none)
 *
 * Uses thin commands (set_todo_state / set_priority) instead of the generic
 * set_property / delete_property, and reads state from the block store
 * instead of a separate properties cache.
 */

import { useCallback } from 'react'
import { toast } from 'sonner'
import { announce } from '../lib/announcer'
import { setPriority as setPriorityCmd, setTodoState as setTodoStateCmd } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'

/** Task state cycle: none -> TODO -> DOING -> DONE -> none. */
const TASK_CYCLE: readonly (string | null)[] = [null, 'TODO', 'DOING', 'DONE']

/** Display labels for screen reader announcements. */
const STATE_LABELS: Record<string, string> = { TODO: 'To do', DOING: 'In progress', DONE: 'Done' }

/** Priority cycle: none -> A -> B -> C -> none. */
const PRIORITY_CYCLE: readonly (string | null)[] = [null, 'A', 'B', 'C']

export interface UseBlockPropertiesReturn {
  getTodoState: (blockId: string) => string | null
  handleToggleTodo: (blockId: string) => Promise<void>
  handleTogglePriority: (blockId: string) => Promise<void>
}

export function useBlockProperties(): UseBlockPropertiesReturn {
  /** Get the current todo state for a block from the block store. */
  const getTodoState = useCallback((blockId: string): string | null => {
    return useBlockStore.getState().blocks.find((b) => b.id === blockId)?.todo_state ?? null
  }, [])

  /** Cycle through task states: none -> TODO -> DOING -> DONE -> none. */
  const handleToggleTodo = useCallback(async (blockId: string) => {
    const current =
      useBlockStore.getState().blocks.find((b) => b.id === blockId)?.todo_state ?? null
    const currentIdx = TASK_CYCLE.indexOf(current)
    const nextIdx = (currentIdx + 1) % TASK_CYCLE.length
    const nextState = TASK_CYCLE[nextIdx]

    // Optimistic update (before IPC) to prevent race on rapid toggles
    useBlockStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: nextState } : b)),
    }))

    try {
      await setTodoStateCmd(blockId, nextState)
    } catch {
      // Revert optimistic update on failure
      useBlockStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: current } : b)),
      }))
      toast.error('Failed to update task state')
      return
    }

    announce(`Task state: ${nextState ? (STATE_LABELS[nextState] ?? nextState) : 'none'}`)
  }, [])

  /** Cycle through priority levels: none -> A -> B -> C -> none. */
  const handleTogglePriority = useCallback(async (blockId: string) => {
    const current = useBlockStore.getState().blocks.find((b) => b.id === blockId)?.priority ?? null
    const currentIdx = PRIORITY_CYCLE.indexOf(current)
    const nextIdx = (currentIdx + 1) % PRIORITY_CYCLE.length
    const nextState = PRIORITY_CYCLE[nextIdx]

    // Optimistic update (before IPC) to prevent race on rapid toggles
    useBlockStore.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority: nextState } : b)),
    }))

    try {
      await setPriorityCmd(blockId, nextState)
    } catch {
      // Revert optimistic update on failure
      useBlockStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority: current } : b)),
      }))
      toast.error('Failed to update priority')
    }
  }, [])

  return {
    getTodoState,
    handleToggleTodo,
    handleTogglePriority,
  }
}
