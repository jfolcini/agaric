/**
 * usePageBrowserFilters — compound-filter chip state + free-text /
 * alias narrowing for the Pages view.
 *
 * Owns:
 *  - The per-space compound-filter store wiring (add / remove / clear
 *    handlers bound to the active space key) and the wire-shaped
 *    primitives (`wireFilters` / `wireFiltersKey`) the data query depends
 *    on.
 *  - The `tag:` chip resolver (resolves a tag id to its human-readable
 *    name via the resolve cache).
 *  - The free-text filter input, seeded from the navigation handoff slot
 *    (PEND-67) and the per-render alias resolution (PEND-29 B-2
 *    stale-fetch guard).
 *  - The add/remove/clear screen-reader announcement *prefix* (P1-F1).
 *    The settled result-count suffix is appended by
 *    `useFilterAnnouncementSettle`, which needs the post-grouping count
 *    and so runs later in `PageBrowser`.
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same timing, same announcement text.
 */

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'

import {
  type PageFilterWithKey,
  pageFilterSummary,
} from '../components/PageBrowser/PageBrowserFilterRow'
import type { FilterPrimitive } from '../lib/tauri'
import { resolvePageByAlias } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { selectPageFiltersForSpace, usePageBrowserFiltersStore } from '../stores/pageBrowserFilters'
import { useResolveStore } from '../stores/resolve'
import { LEGACY_SPACE_KEY } from '../stores/space'

interface UsePageBrowserFiltersResult {
  filters: PageFilterWithKey[]
  handleAddFilter: (f: FilterPrimitive) => void
  handleRemoveFilter: (index: number) => void
  handleClearAllFilters: () => void
  tagResolver: (id: string) => string
  wireFilters: FilterPrimitive[]
  wireFiltersKey: string
  filterText: string
  setFilterText: Dispatch<SetStateAction<string>>
  aliasMatchId: string | null
  filterAnnouncement: string
  setFilterAnnouncement: Dispatch<SetStateAction<string>>
  /** Holds the announcement prefix awaiting its settled result-count suffix. */
  filterAnnouncePrefixRef: React.RefObject<string>
  /** Armed when a prefix awaits its result-count suffix (P1-F1). */
  filterAnnouncePendingRef: React.RefObject<boolean>
}

export function usePageBrowserFilters(currentSpaceId: string | null): UsePageBrowserFiltersResult {
  const { t } = useTranslation()

  // PEND-58 Phase 3 — compound filters. Chips live in a per-space store
  // (`usePageBrowserFiltersStore`) rather than local component state so they
  // survive a navigation round-trip — creating a page opens the editor, which
  // unmounts this view (`ViewDispatcher` is a `switch` over `currentView`) —
  // and stay partitioned by space (chip values reference space-scoped ids, so
  // the active-space slice never leaks onto another space). The dedupe +
  // monotonic `_addId` assignment (which keeps structurally-identical chips on
  // distinct React keys; the id is stripped before the primitive crosses the
  // IPC) moved into the store; these handlers just bind the active space's key.
  const filters = usePageBrowserFiltersStore((s) => selectPageFiltersForSpace(s, currentSpaceId))
  const addFilterForSpace = usePageBrowserFiltersStore((s) => s.addFilter)
  const removeFilterForSpace = usePageBrowserFiltersStore((s) => s.removeFilter)
  const clearFiltersForSpace = usePageBrowserFiltersStore((s) => s.clearFilters)
  const filterSpaceKey = currentSpaceId ?? LEGACY_SPACE_KEY
  const handleAddFilter = useCallback(
    (f: FilterPrimitive) => addFilterForSpace(filterSpaceKey, f),
    [addFilterForSpace, filterSpaceKey],
  )
  const handleRemoveFilter = useCallback(
    (index: number) => removeFilterForSpace(filterSpaceKey, index),
    [removeFilterForSpace, filterSpaceKey],
  )
  // PEND-58d D12 — clear every active chip in one shot. Wired to the
  // chip row's `onClearAll` prop (the FilterRow renders the control;
  // this provides the behaviour). No-op when already empty.
  const handleClearAllFilters = useCallback(
    () => clearFiltersForSpace(filterSpaceKey),
    [clearFiltersForSpace, filterSpaceKey],
  )
  // PEND-58e E5 — resolve a `tag:` chip's tag id to its human-readable
  // name. The tags are preloaded into the global resolve cache on boot
  // (and re-fetched per space), the same source the editor uses to render
  // `#[ULID]` tag refs. Subscribe to `version` so the chip re-renders when
  // the cache fills in. `resolveTitle` returns a `[[xxxx…]]` placeholder
  // for an id it can't resolve; fall back to the raw id in that case so an
  // unknown tag chip renders the id (the prior behaviour) rather than the
  // block-style placeholder.
  const resolveTitle = useResolveStore((s) => s.resolveTitle)
  const resolveVersion = useResolveStore((s) => s.version)
  // `resolveVersion` is load-bearing: `resolveTitle` reads a mutable store
  // cache, so the version bump is the trigger that re-derives the resolver
  // (and re-renders the chips) when tags finish loading — oxlint flags it as
  // an "extra" dep because the callback body never names it directly.
  const tagResolver = useCallback(
    (id: string): string => {
      const title = resolveTitle(id)
      return title.startsWith('[[') ? id : title
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion drives re-resolution of the mutable cache
    [resolveTitle, resolveVersion],
  )
  // Wire-shaped primitives (the `_addId` React key is dropped). A stable
  // JSON serialisation is the queryFn dep so a chip add/remove refetches
  // without making the callback identity churn on unrelated renders.
  const wireFilters = useMemo<FilterPrimitive[]>(
    // The `as FilterPrimitive` cast is sound: `_addId` is a React-key-only
    // field that no `FilterPrimitive` variant declares, and it is stripped
    // here before the cast, so `rest` is structurally a wire primitive.
    () => filters.map(({ _addId, ...rest }) => rest as FilterPrimitive),
    [filters],
  )
  const wireFiltersKey = useMemo(() => JSON.stringify(wireFilters), [wireFilters])

  // PEND-67 Phase 5 follow-up — consume the palette's "Reveal in Pages
  // view" handoff slot on mount. The slot is single-shot: we read it,
  // seed the filter, then clear it so a subsequent natural navigation
  // to Pages does not re-apply the old filter.
  const pendingFilter = useNavigationStore((s) => s.pendingPageBrowserFilter)
  const setPendingPageBrowserFilter = useNavigationStore((s) => s.setPendingPageBrowserFilter)
  const [filterText, setFilterText] = useState(() => pendingFilter ?? '')
  useEffect(() => {
    if (pendingFilter == null) return
    setFilterText(pendingFilter)
    setPendingPageBrowserFilter(null)
  }, [pendingFilter, setPendingPageBrowserFilter])

  // P1-F1 — polite live-region copy for compound-filter changes. The
  // prefix (e.g. "Filter added: Orphan.") is set synchronously when a
  // chip is added/removed; the result count ("23 results.") is appended
  // once the refetch settles, producing "Filter added: Orphan. 23
  // results." for screen-reader users.
  const [filterAnnouncement, setFilterAnnouncement] = useState('')
  const filterAnnouncePrefixRef = useRef('')
  const filterAnnouncePendingRef = useRef(false)
  // Seed with the current (possibly store-persisted) chips so a remount with
  // pre-existing filters doesn't fire a spurious "filter added" announcement.
  const prevFiltersRef = useRef<PageFilterWithKey[]>(filters)
  const [aliasMatchId, setAliasMatchId] = useState<string | null>(null)
  // PEND-29 B-2: monotonic request id for alias resolution. When the user
  // types fast, the older `resolvePageByAlias` promise can resolve after the
  // newer one and overwrite `aliasMatchId` with stale data; the request-id
  // pattern (mirrors `useQueryExecution` post-PEND-22) discards results from
  // any but the most recent in-flight request.
  const aliasReqIdRef = useRef(0)

  // Alias resolution for filter (PEND-29 B-2: stale-fetch guard via
  // request-id ref so an older promise resolving after a newer one cannot
  // overwrite `aliasMatchId` with stale data).
  useEffect(() => {
    if (!filterText.trim()) {
      setAliasMatchId(null)
      return
    }
    const myReqId = ++aliasReqIdRef.current
    const query = filterText.trim()
    // PEND-35 Tier 1.2 — pass `spaceId: currentSpaceId` so an alias
    // pointing at a foreign-space page does not surface here.
    resolvePageByAlias({ alias: query, spaceId: currentSpaceId })
      .then((result) => {
        if (myReqId !== aliasReqIdRef.current) return
        setAliasMatchId(result ? result[0] : null)
      })
      .catch((err) => {
        if (myReqId !== aliasReqIdRef.current) return
        logger.warn('PageBrowser', 'alias resolution failed', { query }, err)
        setAliasMatchId(null)
      })
  }, [filterText, currentSpaceId])

  // P1-F1 — announce compound-filter add/remove to screen readers. Diff
  // the current chip set against the previous one (chips carry a unique
  // `_addId`, so add vs remove and the affected label are unambiguous),
  // emit the polite prefix immediately, and arm a flag so the result
  // count gets appended once the refetch settles (effect below). Keyed on
  // `wireFiltersKey` so it only fires on a real chip add/remove.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the compound-filter set drives this; `filters`/`t` are read but `wireFiltersKey` is the change trigger
  useEffect(() => {
    const prev = prevFiltersRef.current
    prevFiltersRef.current = filters
    // Skip the initial mount (no prior set, no chips) so we don't
    // announce an empty change.
    if (prev.length === 0 && filters.length === 0) return
    let prefix = ''
    if (filters.length > prev.length) {
      const prevIds = new Set(prev.map((f) => f._addId))
      const added = filters.find((f) => !prevIds.has(f._addId))
      if (added) {
        prefix = t('pageBrowser.filter.announceAdded', {
          label: pageFilterSummary(added, t),
        })
      }
    } else if (filters.length === 0 && prev.length > 1) {
      // E16 — clear-all removed every chip in one shot. A single
      // `.find()` (the per-chip remove branch below) would announce only
      // the FIRST removed chip and silently drop the rest, so screen
      // readers would hear "Filter removed: Orphan." after clearing five
      // filters. Announce a dedicated clear-all message instead.
      prefix = t('pageBrowser.filter.announceCleared')
    } else if (filters.length < prev.length) {
      const curIds = new Set(filters.map((f) => f._addId))
      const removed = prev.find((f) => !curIds.has(f._addId))
      if (removed) {
        prefix = t('pageBrowser.filter.announceRemoved', {
          label: pageFilterSummary(removed, t),
        })
      }
    }
    if (prefix === '') return
    filterAnnouncePrefixRef.current = prefix
    filterAnnouncePendingRef.current = true
    setFilterAnnouncement(prefix)
  }, [wireFiltersKey, filters, t])

  return {
    filters,
    handleAddFilter,
    handleRemoveFilter,
    handleClearAllFilters,
    tagResolver,
    wireFilters,
    wireFiltersKey,
    filterText,
    setFilterText,
    aliasMatchId,
    filterAnnouncement,
    setFilterAnnouncement,
    filterAnnouncePrefixRef,
    filterAnnouncePendingRef,
  }
}

interface UseFilterAnnouncementSettleParams {
  loading: boolean
  matchedPageCount: number
  filterAnnouncePrefixRef: React.RefObject<string>
  filterAnnouncePendingRef: React.RefObject<boolean>
  setFilterAnnouncement: Dispatch<SetStateAction<string>>
}

/**
 * P1-F1 — append the settled result count to the pending filter
 * announcement once the refetch finishes (loading falls back to false).
 * Split from `usePageBrowserFilters` because it needs the post-grouping
 * `matchedPageCount`, which is derived after the data query; keeping it a
 * separate hook preserves the original effect ordering in `PageBrowser`.
 */
export function useFilterAnnouncementSettle({
  loading,
  matchedPageCount,
  filterAnnouncePrefixRef,
  filterAnnouncePendingRef,
  setFilterAnnouncement,
}: UseFilterAnnouncementSettleParams): void {
  const { t } = useTranslation()
  // We require a true→false transition rather than a bare `!loading` so we
  // don't compose against a stale count in the brief window before the
  // refetch flips `loading` on. Composes "Filter added: Orphan. 23 results."
  const filterLoadingPrevRef = useRef(loading)
  useEffect(() => {
    const settled = filterLoadingPrevRef.current && !loading
    filterLoadingPrevRef.current = loading
    if (!filterAnnouncePendingRef.current) return
    if (!settled) return
    filterAnnouncePendingRef.current = false
    // E7 — announce the DISTINCT matched-page count, not the grouped-row
    // count (`filteredPages` collapses namespaces and double-counts
    // starred+namespaced pages).
    const count = t('pageBrowser.filter.announceResults', { count: matchedPageCount })
    const prefix = filterAnnouncePrefixRef.current
    setFilterAnnouncement(prefix === '' ? count : `${prefix} ${count}`)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refs + the stable state setter are intentionally read without listing; the settle trigger is the loading/count change
  }, [loading, matchedPageCount, t])
}
