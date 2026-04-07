/**
 * useBlockCollapse — manages collapsed block state and visible-block filtering.
 *
 * Extracted from BlockTree to encapsulate:
 * - Collapsed block IDs state (persisted in localStorage)
 * - Toggle callback with optional pre-collapse hook (e.g. focus rescue)
 * - Visible block computation (filters out descendants of collapsed blocks)
 * - hasChildren lookup set
 */

import { useCallback, useMemo, useState } from 'react'
import type { FlatBlock } from '../lib/tree-utils'

export interface UseBlockCollapseOptions {
  /** Called before a block is collapsed (not expanded). Use to rescue focus, etc. */
  onBeforeCollapse?: (blockId: string) => void
}

export interface UseBlockCollapseReturn {
  collapsedIds: Set<string>
  toggleCollapse: (blockId: string) => void
  /** Blocks visible after collapse filtering. */
  visibleBlocks: FlatBlock[]
  /** Set of block IDs that have children (next block has greater depth). */
  hasChildrenSet: Set<string>
}

export function useBlockCollapse(
  blocks: FlatBlock[],
  options: UseBlockCollapseOptions = {},
): UseBlockCollapseReturn {
  const { onBeforeCollapse } = options

  // ── Collapse state (persisted in localStorage) ────────────────────
  const [collapsedIds, setCollapsedIdsRaw] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('collapsed_ids')
      if (stored) return new Set(JSON.parse(stored) as string[])
    } catch {
      // localStorage unavailable
    }
    return new Set()
  })

  const setCollapsedIds = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setCollapsedIdsRaw((prev) => {
      const next = updater(prev)
      try {
        localStorage.setItem('collapsed_ids', JSON.stringify([...next]))
      } catch {
        // localStorage unavailable
      }
      return next
    })
  }, [])

  // ── Toggle collapse ────────────────────────────────────────────────
  const toggleCollapse = useCallback(
    (blockId: string) => {
      const wasCollapsed = collapsedIds.has(blockId)
      if (!wasCollapsed) {
        onBeforeCollapse?.(blockId)
      }

      setCollapsedIds((prev) => {
        const next = new Set(prev)
        if (next.has(blockId)) next.delete(blockId)
        else next.add(blockId)
        return next
      })
    },
    [collapsedIds, onBeforeCollapse, setCollapsedIds],
  )

  // ── hasChildren set ────────────────────────────────────────────────
  const hasChildrenSet = useMemo(() => {
    const set = new Set<string>()
    for (let i = 0; i < blocks.length - 1; i++) {
      const curr = blocks[i] as (typeof blocks)[number]
      const next = blocks[i + 1] as (typeof blocks)[number]
      if (next.depth > curr.depth) {
        set.add(curr.id)
      }
    }
    return set
  }, [blocks])

  // ── Visible blocks after collapse filtering ────────────────────────
  const visibleBlocks = useMemo(() => {
    if (collapsedIds.size === 0) return blocks
    const result: typeof blocks = []
    const skipUntilDepth: number[] = []

    for (const block of blocks) {
      while (
        skipUntilDepth.length > 0 &&
        block.depth <= (skipUntilDepth[skipUntilDepth.length - 1] as number)
      ) {
        skipUntilDepth.pop()
      }

      if (skipUntilDepth.length > 0) continue

      result.push(block)

      if (collapsedIds.has(block.id)) {
        skipUntilDepth.push(block.depth)
      }
    }
    return result
  }, [blocks, collapsedIds])

  return { collapsedIds, toggleCollapse, visibleBlocks, hasChildrenSet }
}
