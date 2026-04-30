/**
 * useBlockPropertiesBatch — batch-fetches per-block "extra" properties
 * (everything except `todo_state`, `priority`, `due_date`,
 * `scheduled_date`) for the currently-loaded block list.
 *
 * Returns a `{ blockId: { key, value }[] }` map keyed by block id.
 * Built-in fields are filtered out because they already render via the
 * dedicated badges (TodoToggle, PriorityBadge, DueChip, ScheduleChip).
 * Empty values are dropped so the row UI doesn't render empty rows.
 * Extracted from BlockTree.tsx for MAINT-128.
 */

import { useEffect, useState } from 'react'
import { logger } from '../lib/logger'
import { getBatchProperties } from '../lib/tauri'

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
])

export type BlockPropertiesMap = Record<string, Array<{ key: string; value: string }>>

export function useBlockPropertiesBatch(blocks: Array<{ id: string }>): BlockPropertiesMap {
  const [blockProperties, setBlockProperties] = useState<BlockPropertiesMap>({})

  useEffect(() => {
    if (blocks.length === 0) return
    const visibleIds = blocks.map((b) => b.id)
    getBatchProperties(visibleIds)
      .then((result) => {
        const mapped: BlockPropertiesMap = {}
        for (const [blockId, props] of Object.entries(result)) {
          mapped[blockId] = props
            .filter((p) => !BUILTIN_PROPERTY_KEYS.has(p.key))
            .map((p) => ({
              key: p.key,
              value:
                p.value_text ??
                p.value_date ??
                (p.value_num != null ? String(p.value_num) : '') ??
                '',
            }))
            .filter((p) => p.value !== '')
        }
        setBlockProperties(mapped)
      })
      .catch((err: unknown) => {
        logger.warn('BlockTree', 'Failed to load batch properties for blocks', undefined, err)
      })
  }, [blocks])

  return blockProperties
}
