/**
 * useBlockProperties — hook for block property state and task cycling.
 *
 * Manages:
 * - blockProperties state map
 * - getTodoState callback
 * - handleToggleTodo callback (cycles through TODO/DOING/DONE/none)
 *
 * NOTE: The batch property fetch effect is intentionally kept in BlockTree
 * (not in this hook) to preserve the original effect ordering:
 * load() must fire before property fetch.
 */

import { useCallback, useState } from 'react'
import type { PropertyRow } from '../lib/tauri'
import { deleteProperty, setProperty } from '../lib/tauri'

/** Task state cycle: none -> TODO -> DOING -> DONE -> none. */
const TASK_CYCLE: readonly (string | null)[] = [null, 'TODO', 'DOING', 'DONE']

/** Priority cycle: none -> A -> B -> C -> none. */
const PRIORITY_CYCLE: readonly (string | null)[] = [null, 'A', 'B', 'C']

export interface UseBlockPropertiesReturn {
  getTodoState: (blockId: string) => string | null
  handleToggleTodo: (blockId: string) => Promise<void>
  handleTogglePriority: (blockId: string) => Promise<void>
  blockProperties: Map<string, PropertyRow[]>
  setBlockProperties: React.Dispatch<React.SetStateAction<Map<string, PropertyRow[]>>>
}

export function useBlockProperties(): UseBlockPropertiesReturn {
  const [blockProperties, setBlockProperties] = useState<Map<string, PropertyRow[]>>(new Map())

  /** Get the current todo state for a block from the properties cache. */
  const getTodoState = useCallback(
    (blockId: string): string | null => {
      const props = blockProperties.get(blockId)
      const todoProp = props?.find((p) => p.key === 'todo')
      return todoProp?.value_text ?? null
    },
    [blockProperties],
  )

  /** Cycle through task states: none -> TODO -> DOING -> DONE -> none. */
  const handleToggleTodo = useCallback(
    async (blockId: string) => {
      const current = getTodoState(blockId)
      const currentIdx = TASK_CYCLE.indexOf(current)
      const nextIdx = (currentIdx + 1) % TASK_CYCLE.length
      const nextState = TASK_CYCLE[nextIdx]

      if (nextState === null) {
        await deleteProperty(blockId, 'todo')
      } else {
        await setProperty({ blockId, key: 'todo', valueText: nextState })
      }

      // Update local cache
      setBlockProperties((prev) => {
        const next = new Map(prev)
        if (nextState === null) {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'todo')
          if (props.length === 0) next.delete(blockId)
          else next.set(blockId, props)
        } else {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'todo')
          props.push({
            key: 'todo',
            value_text: nextState,
            value_num: null,
            value_date: null,
            value_ref: null,
          })
          next.set(blockId, props)
        }
        return next
      })
    },
    [getTodoState],
  )

  /** Cycle through priority levels: none -> A -> B -> C -> none. */
  const handleTogglePriority = useCallback(
    async (blockId: string) => {
      const props = blockProperties.get(blockId)
      const current = props?.find((p) => p.key === 'priority')?.value_text ?? null
      const currentIdx = PRIORITY_CYCLE.indexOf(current)
      const nextIdx = (currentIdx + 1) % PRIORITY_CYCLE.length
      const nextState = PRIORITY_CYCLE[nextIdx]

      if (nextState === null) {
        await deleteProperty(blockId, 'priority')
      } else {
        await setProperty({ blockId, key: 'priority', valueText: nextState })
      }

      // Update local cache
      setBlockProperties((prev) => {
        const next = new Map(prev)
        if (nextState === null) {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'priority')
          if (props.length === 0) next.delete(blockId)
          else next.set(blockId, props)
        } else {
          const props = (next.get(blockId) ?? []).filter((p) => p.key !== 'priority')
          props.push({
            key: 'priority',
            value_text: nextState,
            value_num: null,
            value_date: null,
            value_ref: null,
          })
          next.set(blockId, props)
        }
        return next
      })
    },
    [blockProperties],
  )

  return {
    getTodoState,
    handleToggleTodo,
    handleTogglePriority,
    blockProperties,
    setBlockProperties,
  }
}
