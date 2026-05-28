/**
 * useTagResolution — resolve search tag *names* to tag *ids* for the IPC.
 *
 * PEND-58f FE-9 — extracted from the SearchPanel god-component to shrink
 * the orchestrator. Best-effort: an unknown name produces no id (the SQL
 * path then matches nothing for that tag, which is correct).
 *
 * FE-5 — the cache keys on the lowercased name only and is therefore
 * space-scoped: the same name can map to a different tag_id (or none) in
 * another space, so it is dropped on a space switch.
 */
import { useEffect, useMemo, useState } from 'react'

import { logger } from '../../lib/logger'
import { listTagsByPrefix, paginationLimit } from '../../lib/tauri'

export function useTagResolution(
  tagNames: ReadonlyArray<string>,
  currentSpaceId: string | null,
): string[] {
  const [tagNameMap, setTagNameMap] = useState<Map<string, string>>(new Map())

  const tagIds = useMemo(() => {
    const out: string[] = []
    for (const name of tagNames) {
      const id = tagNameMap.get(name.toLowerCase())
      if (id) out.push(id)
    }
    return out
  }, [tagNames, tagNameMap])

  // Resolve unknown tag names via the prefix lookup.
  useEffect(() => {
    const names = tagNames.filter((n) => !tagNameMap.has(n.toLowerCase()))
    if (names.length === 0) return
    let cancelled = false
    Promise.all(
      names.map((name) =>
        listTagsByPrefix({ prefix: name, limit: paginationLimit(20) }).catch(() => []),
      ),
    )
      .then((batches) => {
        if (cancelled) return
        setTagNameMap((prev) => {
          const next = new Map(prev)
          for (let i = 0; i < names.length; i++) {
            const name = names[i]
            const batch = batches[i]
            if (!name || !batch) continue
            const lower = name.toLowerCase()
            const exact = batch.find((t) => t.name.toLowerCase() === lower)
            if (exact) next.set(lower, exact.tag_id)
          }
          return next
        })
      })
      .catch((err) => logger.warn('SearchPanel', 'tag resolution failed', undefined, err))
    return () => {
      cancelled = true
    }
  }, [tagNames, tagNameMap])

  // FE-5 — drop the space-scoped cache on space switch.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional fire-on-change — the body doesn't read currentSpaceId, it invalidates the cache when the space switches.
  useEffect(() => {
    setTagNameMap(new Map())
  }, [currentSpaceId])

  return tagIds
}
