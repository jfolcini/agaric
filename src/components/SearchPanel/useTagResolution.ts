/**
 * useTagResolution — resolve search tag *names* to tag *ids* for the IPC.
 *
 * Extracted from the SearchPanel god-component to shrink
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
 * prevents the resolve effect from re-firing the lookup for the same
 * unknown name on every map identity change. A name-change event that
 * could have created the tag drops them again (#5255).
 *
 * The cache keys on the lowercased name only and is therefore
 * space-scoped: the same name can map to a different tag_id (or none) in
 * another space, so it is dropped on a space switch.
 */
import { useEffect, useMemo, useState } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands, type TagCacheRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { requireActiveScope } from '@/lib/space-scope'

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

  // Resolve unsettled tag names from the active space's own tag list, one
  // listing for all of them. A name is unique per space, not per vault
  // (#5237), so the unscoped prefix lookup could answer another space's id
  // and the space-scoped search then matched nothing. `null` entries count
  // as settled, so an unknown name is not re-fetched on every map identity
  // change — only after a name change drops it (below). With no active space
  // there is no search to resolve for (`useSearchResults` holds the query).
  useEffect(() => {
    if (currentSpaceId == null) return
    const unsettled = [...new Set(tagNames.map((n) => n.toLowerCase()))].filter(
      (lower) => !tagNameMap.has(lower),
    )
    if (unsettled.length === 0) return
    let cancelled = false
    // #717 — record the settled outcome either way: an exact match resolves
    // to its id; no match settles as `null` so the caller can project a
    // matches-nothing filter instead of silently dropping the tag constraint.
    const settle = (tags: readonly TagCacheRow[]) => {
      if (cancelled) return
      setTagNameMap((prev) => {
        const next = new Map(prev)
        for (const lower of unsettled) {
          const exact = tags.find((t) => t.name.toLowerCase() === lower)
          next.set(lower, exact ? exact.tag_id : null)
        }
        return next
      })
    }
    commands
      .listAllTagsInSpace(requireActiveScope(currentSpaceId))
      .then(unwrap)
      .then(settle)
      .catch((err: unknown) => {
        // A failed lookup settles as unresolved: empty results beat
        // unfiltered ones pretending the tag filter applied.
        logger.warn('SearchPanel', 'tag resolution failed', { spaceId: currentSpaceId }, err)
        settle([])
      })
    return () => {
      cancelled = true
    }
  }, [tagNames, tagNameMap, currentSpaceId])

  // Drop the space-scoped cache on space switch. The functional
  // bail-out keeps the Map identity when it is already empty, so the
  // mount-time run of this effect doesn't replace the initial empty map
  // with a fresh one (which would re-trigger the resolve effect above and
  // fire a duplicate lookup + cancellation on every mount).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- drops the space-scoped tag-id cache on space switch; the map accumulates backend lookups, so it cannot be derived during render; see #4407
    setTagNameMap((prev) => (prev.size === 0 ? prev : new Map()))
  }, [currentSpaceId])

  // #5255 — a name settled as unknown can come into existence later: a synced
  // peer or an MCP agent creates the tag (`invalidated`), or a local surface
  // creates or renames one. Drop the `null`s so the resolve effect looks them up
  // again; resolved ids are left alone, so the search is not re-held each sync.
  useEffect(
    () =>
      subscribeToNameChanges((change) => {
        const mayNameUnknownTag =
          change.kind === 'invalidated' || (change.entity === 'tag' && change.kind !== 'removed')
        if (!mayNameUnknownTag) return
        setTagNameMap((prev) => {
          const resolvedOnly = new Map([...prev].filter(([, id]) => id !== null))
          return resolvedOnly.size === prev.size ? prev : resolvedOnly
        })
      }),
    [],
  )

  return resolution
}
