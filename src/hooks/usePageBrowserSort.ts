/**
 * usePageBrowserSort — owns the `sort-by` preference for `PageBrowser`
 * (localStorage-backed via `useLocalStoragePreference`) and exposes the
 * `sortPages` callback that produces a comparator-applied copy of an
 * input page list. The comparator is shared by both the `Starred` and
 * `Pages` sections so they stay in lock-step under any sort option.
 *
 * PEND-56 — extended from 3 to 7 sort modes. The new 4 modes
 * (`recently-modified`, `most-linked`, `most-content`, `default`) read
 * the metadata columns added by the `listPagesWithMetadata` IPC; the
 * row shape extends `BlockRow` with optional metadata fields so
 * existing call sites (flag-off path using `listBlocks`) keep working
 * unchanged — those rows return `undefined` for the metadata and fall
 * back to the alphabetical tiebreaker.
 */

import { useCallback } from 'react'
import { getRecentPages } from '@/lib/recent-pages'
import type { BlockRow, PageWithMetadataRow } from '../lib/tauri'
import { useLocalStoragePreference } from './useLocalStoragePreference'

/**
 * PEND-56 sort options. 3 legacy + 4 new.
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
 */
export type SortOption =
  | 'alphabetical'
  | 'recent'
  | 'created'
  | 'recently-modified'
  | 'most-linked'
  | 'most-content'
  | 'default'

const SORT_STORAGE_KEY = 'page-browser-sort'
const DEFAULT_SORT: SortOption = 'alphabetical'

const ALL_SORTS: ReadonlyArray<SortOption> = [
  'alphabetical',
  'recent',
  'created',
  'recently-modified',
  'most-linked',
  'most-content',
  'default',
]

/**
 * Legacy storage format is the bare option string (e.g. `alphabetical`),
 * not JSON-encoded. Match that by parsing/serialising the bare value
 * with an allowlist guard so anything outside the known options falls
 * back to the default. Unknown future values throw → consumer's catch
 * surfaces the default via `useLocalStoragePreference`'s reset path.
 */
function parseSort(raw: string): SortOption {
  if ((ALL_SORTS as readonly string[]).includes(raw)) return raw as SortOption
  throw new Error(`invalid sort option: ${raw}`)
}

function serializeSort(value: SortOption): string {
  return value
}

/**
 * The IPC's `PageSort` enum (Rust side). Only the 4 server-derived
 * sorts round-trip; the 3 frontend-only sorts (`recent`, `created`,
 * `alphabetical`) all map to `'default'` on the wire because they're
 * re-sorted in JS over the server result set.
 *
 * `null` is the explicit "use the backend default" signal for the
 * wrapper, distinct from any string value.
 */
export type PageSortWire =
  | 'alphabetical'
  | 'recently-modified'
  | 'most-linked'
  | 'most-content'
  | 'default'

export function pageSortWireFor(sort: SortOption): PageSortWire {
  switch (sort) {
    case 'alphabetical':
    case 'recent':
    case 'created':
    case 'default':
      // `alphabetical` becomes a wire value because the SQL ORDER BY
      // exactly matches the JS comparator — no double-sort cost. The
      // other two frontend-only sorts pass through as `'default'` so
      // the server returns ULID order and JS re-sorts.
      return sort === 'alphabetical' ? 'alphabetical' : 'default'
    case 'recently-modified':
      return 'recently-modified'
    case 'most-linked':
      return 'most-linked'
    case 'most-content':
      return 'most-content'
  }
}

export interface UsePageBrowserSortReturn {
  sortOption: SortOption
  setSortOption: (value: SortOption) => void
  /** Apply the active comparator to `input`, returning a new array. */
  sortPages: (input: BlockRow[] | PageWithMetadataRow[]) => BlockRow[]
}

export function usePageBrowserSort(): UsePageBrowserSortReturn {
  const [sortOption, setSortOptionRaw] = useLocalStoragePreference<SortOption>(
    SORT_STORAGE_KEY,
    DEFAULT_SORT,
    {
      parse: parseSort,
      serialize: serializeSort,
      source: 'usePageBrowserSort',
    },
  )

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

      const lookupMeta = (r: BlockRow): PageWithMetadataRow | null =>
        hasMetadata ? (r as unknown as PageWithMetadataRow) : null

      if (sortOption === 'alphabetical') {
        sorted.sort(alpha)
      } else if (sortOption === 'created') {
        sorted.sort((a, b) => b.id.localeCompare(a.id))
      } else if (sortOption === 'default') {
        sorted.sort((a, b) => a.id.localeCompare(b.id))
      } else if (sortOption === 'recent') {
        const recentPages = getRecentPages()
        const recentMap = new Map(recentPages.map((rp) => [rp.id, rp.visitedAt]))
        sorted.sort((a, b) => {
          const aTime = recentMap.get(a.id)
          const bTime = recentMap.get(b.id)
          if (aTime && bTime) return bTime.localeCompare(aTime)
          if (aTime) return -1
          if (bTime) return 1
          return alpha(a, b)
        })
      } else if (sortOption === 'recently-modified') {
        // Falls back to alphabetical when rows don't carry metadata
        // (the flag-off path uses BlockRow which has no `lastModifiedAt`).
        sorted.sort((a, b) => {
          const am = lookupMeta(a)?.lastModifiedAt ?? ''
          const bm = lookupMeta(b)?.lastModifiedAt ?? ''
          if (am === bm) return alpha(a, b)
          return bm.localeCompare(am)
        })
      } else if (sortOption === 'most-linked') {
        sorted.sort((a, b) => {
          const ac = lookupMeta(a)?.inboundLinkCount ?? 0
          const bc = lookupMeta(b)?.inboundLinkCount ?? 0
          if (ac === bc) return alpha(a, b)
          return bc - ac
        })
      } else if (sortOption === 'most-content') {
        sorted.sort((a, b) => {
          const ac = lookupMeta(a)?.childBlockCount ?? 0
          const bc = lookupMeta(b)?.childBlockCount ?? 0
          if (ac === bc) return alpha(a, b)
          return bc - ac
        })
      }
      return sorted
    },
    [sortOption],
  )

  return { sortOption, setSortOption, sortPages }
}
