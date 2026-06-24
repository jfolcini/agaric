/**
 * useTrashBreadcrumbs — original-location breadcrumb resolution for
 * TrashView rows.
 *
 * Resolves every distinct `page_id` (the owning page of a trashed block)
 * to a ResolvedBlock (or `null` when that page was itself purged) and
 * exposes a `getPageLabel` helper that returns the user-visible
 * breadcrumb string. Resolving `page_id` rather than `parent_id` means a
 * deeply-nested trashed block reports the page it lived in, not its
 * immediate parent block. Extracted from TrashView.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '../lib/logger'
import type { BlockRow, ResolvedBlock } from '../lib/tauri'
import { batchResolve } from '../lib/tauri'

export function useTrashBreadcrumbs(blocks: BlockRow[]): (block: BlockRow) => string | null {
  const { t } = useTranslation()
  const [pageMap, setPageMap] = useState<Map<string, ResolvedBlock | null>>(new Map())

  const pageIds = useMemo(() => {
    const ids = new Set<string>()
    for (const block of blocks) {
      if (block.page_id) ids.add(block.page_id)
    }
    return Array.from(ids)
  }, [blocks])

  useEffect(() => {
    if (pageIds.length === 0) return
    let cancelled = false
    batchResolve(pageIds)
      .then((resolved) => {
        if (cancelled) return
        const map = new Map<string, ResolvedBlock | null>()
        for (const r of resolved) {
          map.set(r.id, r)
        }
        // Mark missing IDs as null (the owning page was deleted and purged).
        for (const id of pageIds) {
          if (!map.has(id)) map.set(id, null)
        }
        setPageMap(map)
      })
      .catch((err) => {
        logger.warn('TrashView', 'breadcrumb resolution failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [pageIds])

  return useCallback(
    (block: BlockRow): string | null => {
      if (!block.page_id) return null
      const resolved = pageMap.get(block.page_id)
      if (resolved === undefined) return null // not yet loaded
      if (resolved === null || resolved.deleted) return t('trash.deletedPage')
      return resolved.title ?? t('trash.deletedPage')
    },
    [pageMap, t],
  )
}
