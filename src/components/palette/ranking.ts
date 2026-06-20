/**
 * Palette result ranking — merge the two FTS partitions into capped,
 * 4-band-ordered palette groups. Extracted from CommandPalette.tsx
 * (#751); migrated verbatim so the visual contract stays
 * stable across the rewrite. Re-exported from CommandPalette.tsx for
 * the existing test import path.
 */

import { jaroWinkler } from '@/lib/jaro-winkler'
import type { SearchBlockRow } from '@/lib/tauri'

import { MAX_MATCHES_PER_GROUP, MAX_PAGE_GROUPS } from './constants'
import type { PaletteGroup } from './types'

/**
 * Merge the two FTS partitions into capped palette groups.
 *
 * - Each `pages` row seeds a group (page-name match band).
 * - Each `blocks` row appends to the existing group keyed by `page_id`,
 *   or seeds a content-only group when no page row exists for it.
 * Groups are ordered by **4-band rule** (grouping"):
 *   exact title → prefix title → contains-in-title → content-only,
 *   tiebroken by the FTS-band + fuzzy blend score.
 * - Group count capped at `MAX_PAGE_GROUPS` (8).
 * - Matches per group capped at `MAX_MATCHES_PER_GROUP` (2); surplus
 *   surfaces as a "+N more" pill row.
 *
 * Migrated verbatim `mergeAndRankGroups` — same input
 * shape, same output shape, same scoring. Tests carry over unchanged.
 */
export function mergeAndRankGroups(
  pages: ReadonlyArray<SearchBlockRow>,
  blocks: ReadonlyArray<SearchBlockRow>,
  query: string,
): PaletteGroup[] {
  const groups = new Map<string, PaletteGroup>()
  const order: string[] = []
  const lower = query.toLowerCase()

  function ensureGroup(pageId: string, title: string, fromPageRow: boolean): PaletteGroup {
    let group = groups.get(pageId)
    if (group == null) {
      group = {
        pageId,
        pageTitle: title,
        hasPageNameMatch: fromPageRow,
        matches: [],
        surplus: 0,
        score: 0,
      }
      groups.set(pageId, group)
      order.push(pageId)
    } else if (fromPageRow) {
      group.hasPageNameMatch = true
      group.pageTitle = title
    }
    return group
  }

  for (const row of pages) {
    const title = row.content ?? 'Untitled'
    ensureGroup(row.id, title, true)
  }
  for (const row of blocks) {
    if (row.block_type === 'page') {
      const title = row.content ?? 'Untitled'
      ensureGroup(row.id, title, true)
      continue
    }
    const pageId = row.page_id
    if (pageId == null) continue
    const group = ensureGroup(pageId, 'Untitled', false)
    if (group.matches.length < MAX_MATCHES_PER_GROUP) {
      group.matches.push(row)
    } else {
      group.surplus += 1
    }
  }

  for (const id of order) {
    const g = groups.get(id)
    if (g == null) continue
    g.score = scoreGroup(g, lower)
  }

  const orderedIds = [...order].toSorted((a, b) => {
    const ga = groups.get(a)
    const gb = groups.get(b)
    if (ga == null || gb == null) return 0
    if (ga.score !== gb.score) return gb.score - ga.score
    return order.indexOf(a) - order.indexOf(b)
  })

  const out: PaletteGroup[] = []
  for (let i = 0; i < orderedIds.length && i < MAX_PAGE_GROUPS; i++) {
    const id = orderedIds[i]
    if (id == null) continue
    const g = groups.get(id)
    if (g != null) out.push(g)
  }
  return out
}

function scoreGroup(group: PaletteGroup, lowerQuery: string): number {
  if (lowerQuery.length === 0) return 0
  const title = group.pageTitle.toLowerCase()
  let band: number
  if (title === lowerQuery) band = 4
  else if (title.startsWith(lowerQuery)) band = 3
  else if (title.includes(lowerQuery)) band = 2
  else band = 1
  return 0.7 * band + 0.3 * jaroWinkler(group.pageTitle, lowerQuery)
}
