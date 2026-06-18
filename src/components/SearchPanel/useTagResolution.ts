/**
 * useTagResolution — resolve search tag *names* to tag *ids* for the IPC.
 *
 * PEND-58f FE-9 — extracted from the SearchPanel god-component to shrink
 * the orchestrator.
 *
 * Issue #717 — resolution outcomes are tracked per name so the caller can
 * distinguish three states instead of silently dropping the tag filter:
 *  - `pending` — at least one name's lookup hasn't settled yet; the caller
 *    must HOLD the search (firing now would run it without the tag
 *    constraint and flash unfiltered results).
 *  - resolved — the name maps to a tag id (included in `tagIds`).
 *  - unresolved — the lookup settled and found no exact match (typo'd or
 *    nonexistent tag). Surfaced via `hasUnresolved`; the caller projects a
 *    matches-nothing sentinel so the query returns empty rather than
 *    ignoring the tag chip. A failed lookup IPC also settles as
 *    unresolved — conservative: better an empty result than an unfiltered
 *    one pretending the tag filter applied.
 *
 * Settled-but-unresolved names are cached as `null` entries, which also
 * prevents the resolve effect from re-firing the prefix lookup for the
 * same unknown name on every map identity change.
 *
 * FE-5 — the cache keys on the lowercased name only and is therefore
 * space-scoped: the same name can map to a different tag_id (or none) in
 * another space, so it is dropped on a space switch.
 */
import { useEffect, useMemo, useState } from 'react'

import { logger } from '../../lib/logger'
import { listTagsByPrefix, paginationLimit } from '../../lib/tauri'

export interface TagResolution {
  /** Ids for the names that resolved. One entry per resolved input name. */
  tagIds: string[]
  /** True while at least one name's lookup has not settled yet. */
  pending: boolean
  /** True when at least one name settled without a matching tag. */
  hasUnresolved: boolean
}

export function useTagResolution(
  tagNames: ReadonlyArray<string>,
  currentSpaceId: string | null,
): TagResolution {
  // lowercased name → tag id, or `null` when the lookup settled with no
  // exact match (#717 — "attempted, definitively unresolved").
  const [tagNameMap, setTagNameMap] = useState<Map<string, string | null>>(new Map())

  const resolution = useMemo<TagResolution>(() => {
    const tagIds: string[] = []
    let pending = false
    let hasUnresolved = false
    for (const name of tagNames) {
      const lower = name.toLowerCase()
      if (!tagNameMap.has(lower)) {
        pending = true
        continue
      }
      const id = tagNameMap.get(lower)
      if (id == null) hasUnresolved = true
      else tagIds.push(id)
    }
    return { tagIds, pending, hasUnresolved }
  }, [tagNames, tagNameMap])

  // Resolve unsettled tag names via the prefix lookup. `null` entries
  // count as settled, so unknown names are looked up exactly once per
  // space (not re-fetched on every map identity change).
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
            // #717 — record the settled outcome either way: an exact match
            // resolves to its id; no match (or a failed lookup, which the
            // per-name `.catch` collapses to `[]`) settles as `null` so the
            // caller can project a matches-nothing filter instead of
            // silently dropping the tag constraint.
            next.set(lower, exact ? exact.tag_id : null)
          }
          return next
        })
      })
      .catch((err) => logger.warn('SearchPanel', 'tag resolution failed', undefined, err))
    return () => {
      cancelled = true
    }
    // `currentSpaceId` is deliberately a dep even though the body doesn't
    // read it: a space switch must run this cleanup (`cancelled = true`)
    // synchronously in the SAME passive-effect flush that clears the
    // cache below. Without it the cleanup only runs one commit later
    // (after the cleared map re-triggers this effect), leaving a
    // microtask gap where an in-flight OLD-space lookup can land and
    // write old-space ids / null settles into the new space's cache —
    // entries that count as settled and would never be re-resolved.
  }, [tagNames, tagNameMap, currentSpaceId])

  // FE-5 — drop the space-scoped cache on space switch. The functional
  // bail-out keeps the Map identity when it is already empty, so the
  // mount-time run of this effect doesn't replace the initial empty map
  // with a fresh one (which would re-trigger the resolve effect above and
  // fire a duplicate lookup + cancellation on every mount).
  useEffect(() => {
    setTagNameMap((prev) => (prev.size === 0 ? prev : new Map()))
  }, [currentSpaceId])

  return resolution
}
