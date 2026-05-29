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
    case 'default':
      return 'default'
    case 'recently-modified':
      return 'recently-modified'
    case 'most-linked':
      return 'most-linked'
    case 'most-content':
      return 'most-content'
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
 * Used by `PageBrowser` (PEND-58d D3) to surface a "sorted within
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
      // PEND-58e E14: the server keysets every sort by `(key, id ASC)`
      // (see `SortKeyset::apply` in `commands/pages.rs`). When rows carry
      // metadata (the server-derived path), break key ties by `id ASC` too
      // so equal-key groups don't reshuffle as pages stream in. The
      // metadata-less flag-off path (BlockRow) keeps the alphabetical
      // fallback, since it can't reproduce the server order anyway.
      const tiebreak = (a: BlockRow, b: BlockRow) =>
        hasMetadata ? a.id.localeCompare(b.id) : alpha(a, b)

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
          if (am === bm) return tiebreak(a, b)
          return bm.localeCompare(am)
        })
      } else if (sortOption === 'most-linked') {
        sorted.sort((a, b) => {
          const ac = lookupMeta(a)?.inboundLinkCount ?? 0
          const bc = lookupMeta(b)?.inboundLinkCount ?? 0
          if (ac === bc) return tiebreak(a, b)
          return bc - ac
        })
      } else if (sortOption === 'most-content') {
        sorted.sort((a, b) => {
          const ac = lookupMeta(a)?.childBlockCount ?? 0
          const bc = lookupMeta(b)?.childBlockCount ?? 0
          if (ac === bc) return tiebreak(a, b)
          return bc - ac
        })
      }
      return sorted
    },
    [sortOption],
  )

  return { sortOption, setSortOption, sortPages }
}
