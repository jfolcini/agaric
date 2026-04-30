/**
 * useTrashBreadcrumbs — original-location breadcrumb resolution for
 * TrashView rows.
 *
 * Resolves every distinct `parent_id` to a ResolvedBlock (or `null`
 * when the parent itself was purged) and exposes a `getParentLabel`
 * helper that returns the user-visible breadcrumb string. Extracted
 * from TrashView.tsx for MAINT-128.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '../lib/logger'
import type { BlockRow, ResolvedBlock } from '../lib/tauri'
import { batchResolve } from '../lib/tauri'

export function useTrashBreadcrumbs(blocks: BlockRow[]): (block: BlockRow) => string | null {
  const { t } = useTranslation()
  const [parentMap, setParentMap] = useState<Map<string, ResolvedBlock | null>>(new Map())

  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const block of blocks) {
      if (block.parent_id) ids.add(block.parent_id)
    }
    return Array.from(ids)
  }, [blocks])

  useEffect(() => {
    if (parentIds.length === 0) return
    let cancelled = false
    batchResolve(parentIds)
      .then((resolved) => {
        if (cancelled) return
        const map = new Map<string, ResolvedBlock | null>()
        for (const r of resolved) {
          map.set(r.id, r)
        }
        // Mark missing IDs as null (parent page was deleted and purged).
        for (const id of parentIds) {
          if (!map.has(id)) map.set(id, null)
        }
        setParentMap(map)
      })
      .catch((err) => {
        logger.warn('TrashView', 'breadcrumb resolution failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [parentIds])

  return useCallback(
    (block: BlockRow): string | null => {
      if (!block.parent_id) return null
      const resolved = parentMap.get(block.parent_id)
      if (resolved === undefined) return null // not yet loaded
      if (resolved === null || resolved.deleted) return t('trash.deletedPage')
      return resolved.title ?? t('trash.deletedPage')
    },
    [parentMap, t],
  )
}
