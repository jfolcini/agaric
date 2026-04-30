/**
 * useTrashDescendantCounts — UX-243 cascade-count fetcher for TrashView.
 *
 * Each trash row is a "root" of a cascade_soft_delete batch. This hook
 * resolves the count of sibling descendants sharing the root's
 * `deleted_at` so the row renderer can show "+N blocks" badges.
 * Extracted from TrashView.tsx for MAINT-128.
 */

import { useEffect, useMemo, useState } from 'react'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import { trashDescendantCounts } from '../lib/tauri'

export function useTrashDescendantCounts(blocks: BlockRow[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const rootIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  useEffect(() => {
    if (rootIds.length === 0) {
      // Reuse the previous reference when already empty — `setCounts({})`
      // would emit a fresh object every effect run and, if the caller ever
      // passes an unstable empty `blocks` array, drive an infinite render
      // loop (the new state shape would re-trigger the consumer's memos).
      setCounts((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    let cancelled = false
    trashDescendantCounts(rootIds)
      .then((next) => {
        if (cancelled) return
        setCounts(next ?? {})
      })
      .catch((err) => {
        logger.warn('TrashView', 'descendant count resolution failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [rootIds])

  return counts
}
