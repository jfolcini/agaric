/**
 * Pages-view saved views (#2003 piece 1): the `{ sort, filters }` tuple a view
 * captures, whether the live tuple matches one, and the tag chips a space can
 * use. The views themselves are pages (`src/lib/saved-views.ts`, #6544).
 */

import { unwrap } from '@/lib/app-error'
import type { FilterPrimitive } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import type { SortOption } from '@/lib/preferences'
import { requireActiveScope } from '@/lib/space-scope'

/** The `{ sort, filters }` tuple a saved view captures / restores. */
export interface PagesViewTuple {
  sort: SortOption
  filters: FilterPrimitive[]
}

/** A Pages-view saved view: its page's id, its name, and the tuple it restores. */
export interface SavedPagesView extends PagesViewTuple {
  id: string
  name: string
}

/** Structural equality for two filter arrays — order-sensitive, `_addId`-stripped by the caller. */
function filtersEqual(a: FilterPrimitive[], b: FilterPrimitive[]): boolean {
  if (a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Structural equality between a saved view and a live `{ sort, filters }` tuple. */
export function viewMatchesTuple(view: SavedPagesView, tuple: PagesViewTuple): boolean {
  return view.sort === tuple.sort && filtersEqual(view.filters, tuple.filters)
}

/**
 * Find the saved view (if any) whose captured tuple structurally matches
 * `tuple`. Returns `null` when no saved view matches — this is the "no
 * active saved view" state, not an error.
 */
export function findMatchingSavedPagesView(
  views: SavedPagesView[],
  tuple: PagesViewTuple,
): SavedPagesView | null {
  return views.find((v) => viewMatchesTuple(v, tuple)) ?? null
}

/**
 * #5294 — a tag chip holds a tag id, which matches nothing in another space.
 * Applying a view drops those, and so does copying the old device-wide views
 * into each space (#6544).
 */
export async function dropOtherSpacesTagChips(
  filters: FilterPrimitive[],
  spaceId: string | null,
): Promise<FilterPrimitive[]> {
  const hasTagChip = filters.some((f) => f.type === 'Tag' || f.type === 'TagOrRef')
  if (spaceId == null || !hasTagChip) return filters
  try {
    const tags = unwrap(await commands.listAllTagsInSpace(requireActiveScope(spaceId)))
    const spaceTagIds = new Set(tags.map((tag) => tag.tag_id))
    return filters.filter(
      (f) => (f.type !== 'Tag' && f.type !== 'TagOrRef') || spaceTagIds.has(f.tag),
    )
  } catch (err) {
    logger.warn('saved-pages-views', 'Could not check a saved view’s tags', { spaceId }, err)
    return filters
  }
}
