/**
 * usePageBrowserSort — owns the `sort-by` preference for `PageBrowser`
 * (localStorage-backed via `useLocalStoragePreference`) and exposes the
 * `sortPages` callback used by both the `Starred` and `Pages` sections so
 * they stay in lock-step under any sort option.
 *
 * #2602 Part A — the three server-derived sorts (`recently-modified`,
 * `most-linked`, `most-content`) round-trip via the IPC's `sort` parameter
 * and arrive already keyset-ordered by the SQL `ORDER BY`; for those,
 * `sortPages` renders the rows in received order (the SQL ORDER BY is the
 * single ordering authority — no redundant client re-sort). Only the
 * frontend-only sorts, which cannot be expressed as the server ORDER BY —
 * `alphabetical` (SQLite `COLLATE NOCASE` diverges from V8 `localeCompare`
 * on non-ASCII titles), `recent` (per-device visit history), `created`
 * (ULID DESC) — apply a client comparator over the loaded page.
 *
 * Extended from 3 to 7 sort modes. The new 4 modes
 * (`recently-modified`, `most-linked`, `most-content`, `default`) read
 * the metadata columns added by the `listPagesWithMetadata` IPC; the
 * row shape extends `BlockRow` with optional metadata fields so
 * existing call sites (flag-off path using `listBlocks`) keep working
 * unchanged — those rows return `undefined` for the metadata and fall
 * back to the alphabetical tiebreaker.
 */

import { useCallback } from 'react'

import { getRecentPagesForSpace } from '@/stores/recent-pages'

import { PREFERENCES, type SortOption, usePreference } from '../lib/preferences'
import type { BlockRow, PageWithMetadataRow } from '../lib/tauri'

/**
 * Sort options. 3 legacy + 4 new.
 *
 *   - `alphabetical` — title ASC, case-insensitive.
 *   - `recent` — frontend-only; per-device visit history via `getRecentPages()`.
 *   - `created` — ULID DESC (treats the ULID's timestamp prefix as creation order).
 *   - `recently-modified` — `last_modified_at` DESC (server-derived).
 *   - `most-linked` — `inbound_link_count` DESC (server-derived).
 *   - `most-content` — `child_block_count` DESC (server-derived).
 *   - `default` — backend-default id ASC. Power-user / debugging mode.
 *
 * Only the 4 server-derived modes round-trip via the IPC's `sort`
 * parameter; `recent` and `created` reuse the `default` SQL ordering
 * and re-sort the loaded page client-side.
 *
 * The type is defined in the preferences registry (it annotates
 * `PREFERENCES.sort`) and re-exported here so this hook's public API is
 * unchanged. Owning it there keeps the import graph acyclic — the
 * import-cycle guard counts `import type` edges too.
 */
export type { SortOption }

/**
 * The IPC's `PageSort` enum subset. Only the 3 server-derived sorts
 * round-trip with non-default wire values; the 4 frontend-only sorts
 * (`alphabetical`, `recent`, `created`, `default`) all map to
 * `'default'` on the wire.
 *
 * Round 2 maintainability HIGH — `alphabetical` USED to ride the wire
 * on the (incorrect) claim that SQL ORDER BY matched the JS comparator.
 * They diverge on non-ASCII titles: SQLite `COLLATE NOCASE` folds only
 * ASCII A-Z (byte-wise compare of `lower()`-folded bytes), while V8's
 * `localeCompare` puts `Ä` next to `A`. The two collations disagree on
 * every non-ASCII title (German, Spanish, Nordic, emoji-prefixed), so
 * cursor pagination boundaries would drift from display order. Paying
 * one JS sort over the bounded page-of-50 is cheaper than letting two
 * collations disagree on row order.
 */
export type PageSortWire = 'recently-modified' | 'most-linked' | 'most-content' | 'default'

export function pageSortWireFor(sort: SortOption): PageSortWire {
  switch (sort) {
    case 'alphabetical':
    case 'recent':
    case 'created':
    case 'default': {
      return 'default'
    }
    case 'recently-modified': {
      return 'recently-modified'
    }
    case 'most-linked': {
      return 'most-linked'
    }
    case 'most-content': {
      return 'most-content'
    }
  }
}

/**
 * True when `sort` is a frontend-only reorder that maps to the
 * `'default'` wire value (server returns id-ASC) and is re-sorted
 * client-side over only the loaded ≤50 rows — i.e. `alphabetical`,
 * `recent`, `created`. For these the visible order is globally
 * accurate only once every page is loaded; `default` is the raw
 * server id-ASC order and is therefore globally accurate, so it
 * returns `false`. The three server-side sorts return `false`.
 *
 * Used by `PageBrowser` to surface a "sorted within
 * loaded pages" cue while more pages remain to load.
 */
export function isFrontendOnlySort(sort: SortOption): boolean {
  return pageSortWireFor(sort) === 'default' && sort !== 'default'
}

export interface UsePageBrowserSortReturn {
  sortOption: SortOption
  setSortOption: (value: SortOption) => void
  /** Apply the active comparator to `input`, returning a new array. */
  sortPages: (input: BlockRow[] | PageWithMetadataRow[]) => BlockRow[]
}

export function usePageBrowserSort(): UsePageBrowserSortReturn {
  const [sortOption, setSortOptionRaw] = usePreference(PREFERENCES.sort)

  const setSortOption = useCallback(
    (value: SortOption) => {
      setSortOptionRaw(value)
    },
    [setSortOptionRaw],
  )

  const sortPages = useCallback(
    (input: BlockRow[] | PageWithMetadataRow[]): BlockRow[] => {
      // Discriminator: do the input rows carry metadata?
      // PageWithMetadataRow uses camelCase; BlockRow uses snake_case.
      // A `lastModifiedAt` key on the first row is the structural test.
      const first = input[0]
      const hasMetadata = first != null && Object.hasOwn(first, 'lastModifiedAt')
      const sorted = [...(input as readonly BlockRow[])]
      const alpha = (a: BlockRow, b: BlockRow) => (a.content ?? '').localeCompare(b.content ?? '')

      if (sortOption === 'alphabetical') {
        sorted.sort(alpha)
      } else if (sortOption === 'created') {
        sorted.sort((a, b) => b.id.localeCompare(a.id))
      } else if (sortOption === 'default') {
        sorted.sort((a, b) => a.id.localeCompare(b.id))
      } else if (sortOption === 'recent') {
        const recentPages = getRecentPagesForSpace()
        const recentMap = new Map(recentPages.map((rp) => [rp.id, rp.visitedAt]))
        sorted.sort((a, b) => {
          const aTime = recentMap.get(a.id)
          const bTime = recentMap.get(b.id)
          if (aTime && bTime) return bTime.localeCompare(aTime)
          if (aTime) return -1
          if (bTime) return 1
          return alpha(a, b)
        })
      } else {
        // #2602 Part A — server-derived sorts: `recently-modified`,
        // `most-linked`, `most-content`. When rows carry server metadata
        // they arrive ALREADY keyset-ordered by the IPC
        // (`ORDER BY (<key>, id ASC)` — see `SortKeyset::apply` in
        // `commands/pages/metadata.rs`), so we render them in received
        // order: the SQL `ORDER BY` is the single ordering authority. The
        // client comparator that re-sorted these was pure redundant work
        // (and a second, drift-prone source of truth).
        //
        // The metadata-less flag-off path (BlockRow via `listBlocks`) can't
        // reproduce the server metadata order, so it keeps the alphabetical
        // fallback rather than leaving rows in raw id order.
        if (!hasMetadata) {
          sorted.sort(alpha)
        }
      }
      return sorted
    },
    [sortOption],
  )

  return { sortOption, setSortOption, sortPages }
}
