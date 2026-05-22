/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 *
 * Top-level orchestrator: owns data loading, filter state, and dialog
 * open state, then composes `PageBrowserHeader` + `PageBrowserRowRenderer`
 * inside a virtualized list. Sort preference + grouping live in
 * `usePageBrowserSort` / `usePageBrowserGrouping` (MAINT-128).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { matchesSearchFolded } from '@/lib/fold-for-search'
// E18 — standalone `t` for a toast fired inside the (identity-stable)
// `queryFn`; aliased so it doesn't shadow the component's `useTranslation`
// `t`, and used so the toast string doesn't pull `t` into the queryFn deps.
import { t as i18nT } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { DENSITY_ROW_HEIGHT, usePageBrowserDensity } from '../hooks/usePageBrowserDensity'
import { usePageBrowserGrouping } from '../hooks/usePageBrowserGrouping'
import {
  isFrontendOnlySort,
  pageSortWireFor,
  usePageBrowserSort,
} from '../hooks/usePageBrowserSort'
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { useStarredPages } from '../hooks/useStarredPages'
import { isAppError, type TypedAppError } from '../lib/app-error'
import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '../lib/tauri'
import {
  createPageInSpace,
  listBlocks,
  listPagesWithMetadata,
  resolvePageByAlias,
} from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import {
  PageBrowserFilterRow,
  type PageFilterWithKey,
  pageFilterSummary,
} from './PageBrowser/PageBrowserFilterRow'
import { PageBrowserHeader } from './PageBrowser/PageBrowserHeader'
import { PageBrowserRowRenderer } from './PageBrowser/PageBrowserRowRenderer'
import { ViewHeader } from './ViewHeader'

const HEADER_ROW_HEIGHT = 36

/// Bottom-of-list proximity in CSS pixels at which the auto-load
/// pixel-trigger fires. Picked to give ~5-7 rows of headroom at the
/// 44px regular-density row so the next page lands before the user
/// hits the LoadMoreButton fallback. PEND-56 Phase 3 left this as a
/// regular-density assumption: compact (32 px) gets one extra row of
/// headroom, expanded (68 px) gets one fewer — both well inside the
/// LoadMoreButton fallback envelope.
const INFINITE_SCROLL_BOTTOM_THRESHOLD_PX = 300

/**
 * PEND-56 — localStorage key gating the new `listPagesWithMetadata` +
 * `<DensityRow>` code path. Stored as the bare string `'true'` /
 * `'false'` (not JSON) so it can be flipped by hand from devtools.
 *
 * **Rollout (PEND-56 follow-up):** the new path is now the **default**.
 * A missing key — or any value other than `'false'` — reads as ON. The
 * key is now an *opt-out*: set it to `'false'` to fall back to the
 * legacy `listBlocks` + `PageRow` path (the rollback target until that
 * path is removed in a later cleanup). Private-mode `localStorage`
 * throws are treated as "on" so the default experience is consistent.
 */
const DENSITY_V1_FLAG_KEY = 'pageBrowser.densityV1'

function usePageBrowserDensityV1Flag(): boolean {
  // No reactive subscription: the flag is read once at mount, never
  // toggled from the UI.
  const [flagOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DENSITY_V1_FLAG_KEY) !== 'false'
    } catch {
      return true
    }
  })
  return flagOn
}

/**
 * PEND-56 Phase 3 — wrap a paginating IPC call so that a v2 cursor
 * rejection (`AppError::Validation` with the `RequiresRefresh:` prefix)
 * automatically retries once with no cursor. The cursor format bumped
 * from v1 → v2 alongside the new sort modes, so a session that started
 * before the new build emitted a stale cursor will round-trip safely
 * on the next page load. If the cursorless retry also fails, the
 * original error propagates and `usePaginatedQuery`'s `onError` toast
 * fires (existing behaviour).
 */
async function withCursorRecovery<T>(
  call: (cursor?: string) => Promise<T>,
  cursor: string | undefined,
): Promise<T> {
  try {
    return await call(cursor)
  } catch (err) {
    if (
      cursor != null &&
      isAppError(err) &&
      err.kind === 'validation' &&
      err.message.startsWith('RequiresRefresh:')
    ) {
      return call(undefined)
    }
    throw err
  }
}

/**
 * E18 — the backend can reject a malformed / disallowed compound filter
 * with `AppError::Validation("InvalidFilter: …")` (mirroring the existing
 * `RequiresRefresh:` / `InvalidDateFilter:` prefixes). Without explicit
 * recognition this falls through to the generic
 * `t('pageBrowser.loadFailed')` toast, which misleads the user into
 * thinking the list itself failed to load rather than that a filter chip
 * is invalid. Detect the prefix here.
 */
const INVALID_FILTER_PREFIX = 'InvalidFilter:'
function isInvalidFilterError(err: unknown): err is TypedAppError {
  return (
    isAppError(err) && err.kind === 'validation' && err.message.startsWith(INVALID_FILTER_PREFIX)
  )
}

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — honour the current space. When the `SpaceStore`
  // has not yet hydrated (`isReady === false`) we render a
  // `LoadingSkeleton` instead of firing `listBlocks` so the first render
  // never leaks cross-space pages. Once ready, `currentSpaceId` is
  // threaded to `listBlocks` so the backend filters results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  // PEND-56 Phase 3 — density preference is loaded regardless of the
  // density-v1 IPC flag so the user's stored choice persists across the
  // flag flip. With the flag off the value is still threaded to
  // `<PageBrowserHeader>` (so the selector works) and to
  // `estimateSize` (so a future toggle re-measures correctly).
  const { density, setDensity } = usePageBrowserDensity()
  const flagOn = usePageBrowserDensityV1Flag()
  // The two queryFn branches share a `useCallback` identity-stability
  // contract — `usePaginatedQuery` refetches whenever the function
  // identity changes, so we want one stable function per
  // (space, sort, flag) tuple. `sortOption` is read below; declare a
  // local alias before the queryFn so the dep list stays tight.
  const { sortOption, setSortOption, sortPages } = usePageBrowserSort()

  // PEND-58 Phase 3 — compound filters. Chips live here as local state
  // alongside `filterText` (the name-substring input). Each chip carries
  // a monotonic `_addId` so structurally-identical chips keep distinct
  // React keys; the id is stripped before the primitive crosses the IPC.
  // Filters only apply on the metadata IPC path (`flagOn`); the legacy
  // `listBlocks` path has no server-side filter support.
  const [filters, setFilters] = useState<PageFilterWithKey[]>([])
  const filterAddIdRef = useRef(0)
  const handleAddFilter = useCallback((f: FilterPrimitive) => {
    setFilters((prev) => {
      // PEND-58d D22 — dedupe identical chips. Compare the incoming
      // primitive against the existing set with the React-key-only
      // `_addId` stripped (a structural compare via stable JSON). A
      // structurally-identical chip is a no-op: re-applying it would
      // ship a duplicate `FilterPrimitive` to the IPC (an AND of a
      // condition with itself — pure noise) and add a redundant pill.
      const incoming = JSON.stringify(f)
      const isDuplicate = prev.some(({ _addId, ...rest }) => JSON.stringify(rest) === incoming)
      if (isDuplicate) return prev
      return [...prev, { ...f, _addId: ++filterAddIdRef.current }]
    })
  }, [])
  const handleRemoveFilter = useCallback((index: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== index))
  }, [])
  // PEND-58d D12 — clear every active chip in one shot. Wired to the
  // chip row's `onClearAll` prop (the FilterRow renders the control;
  // this provides the behaviour). No-op when already empty.
  const handleClearAllFilters = useCallback(() => {
    setFilters((prev) => (prev.length === 0 ? prev : []))
  }, [])
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
  // (and re-renders the chips) when tags finish loading — biome flags it as
  // an "extra" dep because the callback body never names it directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion drives re-resolution of the mutable cache
  const tagResolver = useCallback(
    (id: string): string => {
      const title = resolveTitle(id)
      return title.startsWith('[[') ? id : title
    },
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

  const queryFn = useCallback(
    (cursor?: string) => {
      // FEAT-3 Phase 4 — both IPCs require a `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: the empty
      // string forces a no-match SQL filter (returning an empty page)
      // instead of a runtime null deref. The `enabled: spaceIsReady`
      // gate below normally prevents this branch from firing.
      const spaceId = currentSpaceId ?? ''
      if (flagOn) {
        // PEND-56 Phase 3 — metadata-rich payload + server-derived
        // sort. The wire sort enum is a 4-member subset of the
        // frontend's 7 (`pageSortWireFor` does the mapping); the
        // frontend-only sorts (`alphabetical`, `recent`, `created`,
        // `default`) all map to wire `default` and re-sort client-side
        // via `sortPages`.
        return withCursorRecovery(
          (c) =>
            listPagesWithMetadata({
              sort: pageSortWireFor(sortOption),
              spaceId,
              ...(wireFilters.length > 0 && { filters: wireFilters }),
              ...(c != null && { cursor: c }),
              limit: PAGINATION_LIMIT,
            }),
          cursor,
        ).catch((err: unknown) => {
          // E18 — a malformed/disallowed compound filter rejects with
          // `InvalidFilter:`. Surface a specific toast (the offending
          // filter, not the list, is the problem) and re-throw a
          // cancellation-shaped error so `usePaginatedQuery` swallows it
          // silently instead of also firing the generic `loadFailed`
          // toast (double-toast). The `error` state stays clean — the
          // specific toast already told the user what's wrong.
          if (isInvalidFilterError(err)) {
            notify.error(i18nT('pageBrowser.filter.invalidFilter'))
            const suppressed: TypedAppError = { kind: 'cancelled', message: err.message }
            throw suppressed
          }
          throw err
        })
      }
      return listBlocks({
        blockType: 'page',
        ...(cursor != null && { cursor }),
        limit: PAGINATION_LIMIT,
        spaceId,
      })
    },
    // `wireFilters` is `useMemo`'d on `[filters]`, so its identity only
    // changes on a real chip add/remove — safe to depend on directly.
    [currentSpaceId, flagOn, sortOption, wireFilters],
  )
  // `pages` is typed as the union — the grouping pipeline reads only
  // the shared `BlockRow` fields, so callers can treat the unified
  // shape as `BlockRow`. The metadata fields (when present) flow
  // through unchanged and `<DensityRow>` reads them via the same
  // typed cast in `PageBrowserRowRenderer`.
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setPages,
    totalCount,
  } = usePaginatedQuery<BlockRow | PageWithMetadataRow>(queryFn, {
    onError: t('pageBrowser.loadFailed'),
    enabled: spaceIsReady,
  })

  // PEND-58d D6 + D20 — locally-retained total for the count chip.
  //
  // D6 (FE half): the backend now computes `total_count` only on the
  // first page (`req.after.is_none()`) and returns `null` on cursor
  // pages. `usePaginatedQuery` is last-write-wins, so a cursor page would
  // blank the hook's `totalCount`. We retain the first-page value here
  // and only overwrite it when the hook reports a fresh number, so the
  // chip keeps showing the total across load-more.
  //
  // D20: the chip must also drop by one on an optimistic delete (the
  // delete path mutates `pages` directly, never re-running the COUNT), so
  // this is local mutable state rather than a pure mirror of the hook.
  const [displayTotalCount, setDisplayTotalCount] = useState<number | undefined>(undefined)
  // Adopt the hook's total only when it is a real number. A cursor page
  // returning `null` (D6) leaves `totalCount` `undefined`; ignoring that
  // keeps the retained first-page value on screen.
  useEffect(() => {
    if (typeof totalCount === 'number') setDisplayTotalCount(totalCount)
  }, [totalCount])
  // Reset the retained total when the query basis changes (space / sort /
  // chip set) so a stale count never lingers against a fresh result set
  // before the new first page resolves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query-basis tuple drives the reset; `wireFiltersKey` is the chip-set trigger
  useEffect(() => {
    setDisplayTotalCount(undefined)
  }, [currentSpaceId, sortOption, wireFiltersKey])

  // `usePageDelete` predates the metadata-rich union type; its
  // updater is typed against `BlockRow[]`. The two row shapes share
  // every field the deletion path reads (`id`), so we narrow at the
  // boundary with a typed cast instead of widening `usePageDelete`.
  //
  // PEND-58d D20 — the delete path mutates `pages` directly (optimistic
  // filter-out on a successful `delete_block`) and never re-runs the
  // backend COUNT, so the count chip would over-report by one. We
  // intercept the delete-only setter here: when the hook's updater
  // produces a strictly shorter array (the success path filters one row
  // out), decrement the retained total by the same delta. We only ever
  // *decrease* here — the create path has its own setter / count handling
  // — so a no-op or growth leaves the total untouched. Tying the
  // decrement to the actual array shrink (rather than the confirm click)
  // means a failed delete, which leaves `pages` unchanged, also leaves
  // the count unchanged.
  //
  // E15 — a render-synced snapshot of `pages` so `setPagesForDelete` can
  // compute the array delta WITHOUT reading `prev` from inside a
  // `setPages` updater. Keeping the delta math (and the dependent
  // `setDisplayTotalCount`) outside the updater makes the path idempotent
  // under React StrictMode's double-invoke.
  const setPagesSnapshotRef = useRef(pages)
  setPagesSnapshotRef.current = pages
  const setPagesForDelete = useCallback(
    (updater: (prev: BlockRow[]) => BlockRow[]) => {
      // E15 — the count decrement must NOT live inside the `setPages`
      // updater: React StrictMode (dev) double-invokes a `useState`
      // updater to surface impurity, and a nested `setDisplayTotalCount`
      // is a side effect, so it would fire — and decrement — twice.
      // Compute the delta against the *current* pages snapshot, apply the
      // page mutation idempotently, then fire the count decrement exactly
      // once outside the updater.
      const prevRows = setPagesSnapshotRef.current as BlockRow[]
      const next = updater(prevRows)
      setPages(next as (BlockRow | PageWithMetadataRow)[])
      if (next.length < prevRows.length) {
        const removed = prevRows.length - next.length
        setDisplayTotalCount((cur) => (typeof cur === 'number' ? Math.max(0, cur - removed) : cur))
      }
    },
    [setPages],
  )
  const { deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete } =
    usePageDelete(setPagesForDelete)

  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
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
  const { starredIds, isStarred, toggle: toggleStar } = useStarredPages()
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  // P1-F1 — polite live-region copy for compound-filter changes. The
  // prefix (e.g. "Filter added: Orphan.") is set synchronously when a
  // chip is added/removed; the result count ("23 results.") is appended
  // once the refetch settles, producing "Filter added: Orphan. 23
  // results." for screen-reader users.
  const [filterAnnouncement, setFilterAnnouncement] = useState('')
  const filterAnnouncePrefixRef = useRef('')
  const filterAnnouncePendingRef = useRef(false)
  const prevFiltersRef = useRef<PageFilterWithKey[]>([])
  const [aliasMatchId, setAliasMatchId] = useState<string | null>(null)
  // Stable id base for section header `aria-labelledby` wiring. Two
  // headers (`starred` and `other`) share the same prefix.
  const sectionLabelId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newPageInputRef = useRef<HTMLInputElement>(null)
  // Register the "new page" input as the primary-focus target for this view
  // so switching to Pages via sidebar lands the cursor in the create form
  // instead of the generic #main-content container (UX-220).
  useRegisterPrimaryFocus(newPageInputRef)
  // Tracks the handleCreateUnder focus setTimeout so we can cancel it on
  // unmount and avoid focusing a stale DOM node (#MAINT-14).
  const pendingFocusRef = useRef<number | null>(null)
  // PEND-29 B-2: monotonic request id for alias resolution. When the user
  // types fast, the older `resolvePageByAlias` promise can resolve after the
  // newer one and overwrite `aliasMatchId` with stale data; the request-id
  // pattern (mirrors `useQueryExecution` post-PEND-22) discards results from
  // any but the most recent in-flight request.
  const aliasReqIdRef = useRef(0)

  // Clear any pending focus timer on unmount.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (pages.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(
        t('pageBrowser.loadedMorePages', { count: pages.length - prevLengthRef.current }),
      )
    } else if (pages.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = pages.length
  }, [pages.length, t])

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

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    // FEAT-3 Phase 2 — a page must belong to a space. On the rare
    // first-boot path where `SpaceStore` has not yet hydrated we
    // refuse to create and surface a toast rather than silently
    // creating an unscoped page. The `isReady` gate above normally
    // prevents this branch from firing.
    const activeSpaceId = useSpaceStore.getState().currentSpaceId
    if (activeSpaceId == null) {
      notify.error(t('pageBrowser.spaceNotReady'))
      return
    }
    setIsCreating(true)
    try {
      const newId = await createPageInSpace({ content: name, spaceId: activeSpaceId })
      setNewPageName('')
      // PEND-58d D10 — the optimistic prepend assumes the new page belongs
      // at the top of the *current* result set. That only holds when no
      // compound-filter chips are active: with chips the server decides
      // membership (the new page may or may not match), and the prepended
      // row also lacks the metadata the density rows read. When chips are
      // active we refetch from page 1 instead, so the new page surfaces
      // only if it actually matches — and with full metadata. The fast
      // optimistic path is kept for the unfiltered case (the common one).
      if (wireFilters.length > 0) {
        reload()
      } else {
        const newPage: BlockRow = {
          id: newId,
          block_type: 'page',
          content: name,
          parent_id: null,
          position: null,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: newId,
        }
        setPages((prev) => [newPage, ...prev])
        // Keep the count chip in step with the optimistic prepend (mirror
        // of the D20 delete decrement). The chip-active branch above
        // refetches, which re-runs the backend COUNT, so no manual bump
        // is needed there.
        setDisplayTotalCount((cur) => (typeof cur === 'number' ? cur + 1 : cur))
      }
      onPageSelect?.(newId, name)
    } catch (error) {
      notify.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t, onPageSelect, wireFilters, reload])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    if (pendingFocusRef.current !== null) {
      window.clearTimeout(pendingFocusRef.current)
    }
    pendingFocusRef.current = window.setTimeout(() => {
      pendingFocusRef.current = null
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 0)
  }, [])

  /**
   * Pages narrowed by the search input + alias resolver.
   * Sort/grouping is applied below — both `Starred` and `Pages`
   * sections consume the same filtered pool.
   */
  const filteredPagesUnsorted = useMemo(() => {
    const trimmed = filterText.trim()
    if (!trimmed) return pages
    // UX-247 — Unicode-aware case- / diacritic-insensitive match so
    // Turkish (`İstanbul` ↔ `istanbul`), German (`Straße` ↔
    // `strasse`), and accented (`café` ↔ `cafe`) titles fold together
    // the way users expect from interactive filters.
    return pages.filter(
      (p) => matchesSearchFolded(p.content ?? '', trimmed) || p.id === aliasMatchId,
    )
  }, [pages, filterText, aliasMatchId])

  // Whether ANY page in the unfiltered set is namespaced. Used only
  // to decide whether to take the single-page-vault shortcut. Pulled
  // out so the grouping memo below doesn't read `pages` directly
  // (keeps its dependency surface tight and lets biome's
  // useExhaustiveDependencies trace stay clean).
  const hasAnyNamespacedPage = useMemo(
    () => pages.some((p) => (p.content ?? '').includes('/')),
    [pages],
  )
  const isSinglePageVault = pages.length <= 1 && !hasAnyNamespacedPage

  // The grouping pipeline reads only the shared `id` / `content`
  // fields, which both `BlockRow` (flag-off) and `PageWithMetadataRow`
  // (flag-on) carry. The metadata extras (`lastModifiedAt`,
  // `inboundLinkCount`, etc.) are preserved on the row object and
  // re-read at the leaf via a typed cast in `PageBrowserRowRenderer`.
  // Cast to `BlockRow[]` at the grouping boundary so the existing
  // `usePageBrowserGrouping` / `sortPages` signatures stay unchanged.
  const filteredPagesUnsortedAsBlockRows = filteredPagesUnsorted as unknown as BlockRow[]
  const {
    filteredPages,
    groupedRows,
    pageIndexToRowIndex,
    hasStarred,
    hasPages,
    matchedPageCount,
  } = usePageBrowserGrouping({
    filteredPagesUnsorted: filteredPagesUnsortedAsBlockRows,
    sortPages,
    sortOption,
    starredIds,
    isSinglePageVault,
  })

  const virtualItemCount = groupedRows.length

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredPages.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const page = filteredPages[idx]
      if (page) onPageSelect?.(page.id, page.content ?? undefined)
    },
  })

  // Reset focusedIndex when filter / sort / density changes.
  // Density changes the row height, which moves what's visible at any
  // given scroll offset — keeping `focusedIndex` stable across the
  // toggle would land the focus ring on a row that's no longer where
  // the user is looking.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterText, sortOption, density, and the compound-filter set intentionally trigger reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [filterText, sortOption, density, wireFiltersKey, setFocusedIndex])

  // P1-F1 — announce compound-filter add/remove to screen readers. Diff
  // the current chip set against the previous one (chips carry a unique
  // `_addId`, so add vs remove and the affected label are unambiguous),
  // emit the polite prefix immediately, and arm a flag so the result
  // count gets appended once the refetch settles (effect below). Keyed on
  // `wireFiltersKey` so it only fires on a real chip add/remove.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the compound-filter set drives this; `filters`/`t` are read but `wireFiltersKey` is the change trigger
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

  // P1-F1 — append the settled result count to the pending filter
  // announcement once the refetch finishes (loading falls back to
  // false). We require a true→false transition rather than a bare
  // `!loading` so we don't compose against a stale count in the brief
  // window before the refetch flips `loading` on. Composes
  // "Filter added: Orphan. 23 results."
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
  }, [loading, matchedPageCount, t])

  // PEND-30 L-5: wrap `estimateSize` in `useCallback` so its identity is
  // stable across re-renders that don't change `groupedRows` or
  // density. TanStack Virtual treats option-identity changes as a
  // re-measure trigger — that's exactly what we want on a density
  // flip, since the row height per page changes wholesale.
  const estimateSize = useCallback(
    (index: number) => {
      const row = groupedRows[index]
      if (row?.kind === 'header') return HEADER_ROW_HEIGHT
      // PEND-56 Phase 3 — page-row height now driven by density.
      // `tree-page` rows share the per-density leaf height (the
      // virtualizer's `measureElement` ref handler corrects to the
      // actual height when descendants expand the wrapper). The
      // `regular` value (44 px) matches the pre-PEND-56 fixed height,
      // so flag-off behaviour stays byte-identical.
      return DENSITY_ROW_HEIGHT[density]
    },
    [groupedRows, density],
  )

  const virtualizer = useVirtualizer({
    count: virtualItemCount,
    getScrollElement: () => listRef.current,
    // Header rows (~36px) sentinel-interspersed between page rows
    // (~44px) and tree-page rows (~44px for the root; descendants
    // render inside the same DOM wrapper).
    estimateSize,
    overscan: 5,
  })

  // PageBrowser pagination UX (2026-05-14) — sessionStorage-backed
  // scroll restoration. The user clicks a page → editor → Back, and
  // PageBrowser remounts; without this they land at row 0 even when
  // they were halfway down a 300-page list. The save side debounces
  // via a ref-tracked timeout (no `requestIdleCallback` because not
  // every test/browser has it and the cost is the same single
  // setTimeout); the restore side fires once per mount AFTER the
  // first batch hydrates so the virtualizer has a non-zero total
  // size to scroll inside of.
  //
  // Key is per-space so switching spaces and back restores each
  // space's last position independently. Filter / sort changes
  // clear the saved offset because the saved position is meaningless
  // against a re-ordered or re-filtered set.
  const scrollStorageKey =
    currentSpaceId != null ? `pageBrowser:scrollOffset:${currentSpaceId}` : null
  const restoredRef = useRef(false)
  const scrollSaveTimerRef = useRef<number | null>(null)

  // Reset the restore-once latch when the storage key changes (space
  // switch). Each space gets its own first-batch restoration; without
  // this, switching to space B and back to space A would skip
  // restoration for A because `restoredRef.current` was set during
  // A's first mount in this session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm only on key change
  useEffect(() => {
    restoredRef.current = false
  }, [scrollStorageKey])

  // Restore once per (mount, space) tuple, after items hydrate.
  useEffect(() => {
    if (restoredRef.current) return
    if (scrollStorageKey == null) return
    if (pages.length === 0) return
    const totalSize = virtualizer.getTotalSize()
    if (totalSize <= 0) return
    const raw = sessionStorage.getItem(scrollStorageKey)
    if (raw == null) {
      restoredRef.current = true
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      restoredRef.current = true
      return
    }
    // Bound to [0, totalSize] in case the list shrank between
    // sessions (pages deleted in another tab, etc.).
    const bounded = Math.min(parsed, totalSize)
    virtualizer.scrollToOffset(bounded, { align: 'start' })
    restoredRef.current = true
  }, [pages.length, virtualizer, scrollStorageKey])

  // Save scroll offset on scroll (debounced ~150ms).
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    if (scrollStorageKey == null) return
    function handleScroll() {
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
      }
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null
        // Read at flush time, not at scroll time, so the saved
        // value reflects the user's final resting offset rather
        // than every intermediate frame.
        if (el == null || scrollStorageKey == null) return
        sessionStorage.setItem(scrollStorageKey, String(el.scrollTop))
      }, 150)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
        scrollSaveTimerRef.current = null
      }
    }
  }, [scrollStorageKey])

  // Clear saved offset when filter / sort / density / space changes —
  // the saved offset is keyed only by space, so a filter / sort /
  // density change against the same space would otherwise restore a
  // meaningless position the next time the user revisits this view.
  // Density is included because the per-row pixel height changed
  // wholesale (32 / 44 / 68 px), so the saved scrollTop no longer
  // points at the same row index. Allow restoration again on next
  // mount by leaving `restoredRef` intact within this mount but
  // dropping the stored value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollStorageKey already covers space changes; filterText, sortOption, density, and the compound-filter set are the explicit triggers
  useEffect(() => {
    if (scrollStorageKey == null) return
    // Skip the very first run (mount) — that's when we want to
    // restore, not clear. `restoredRef.current === false` means we
    // haven't tried yet; the restore effect will handle it. After
    // restoration completes, any subsequent change clears.
    if (!restoredRef.current) return
    sessionStorage.removeItem(scrollStorageKey)
  }, [filterText, sortOption, density, wireFiltersKey])

  // PageBrowser pagination UX (2026-05-14) — auto-load near the
  // bottom. The index-based trigger (last *visible* virtual item
  // within ~5 rows of the end) works in flat view. In tree view a
  // single `tree-page` row can wrap hundreds of expanded descendant
  // nodes, so `lastVisibleIndex` may stay pinned at a low index as
  // the user scrolls through that one tree's descendants — the
  // pixel-based trigger below catches that case. Both triggers
  // short-circuit on `!hasMore || loading` so concurrent firings
  // collapse to one `loadMore()` call (which `usePaginatedQuery`
  // additionally guards on `nextCursor && !loading`). The
  // `<LoadMoreButton>` stays rendered as the a11y / no-JS /
  // reduced-motion fallback.
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.at(-1)?.index
  useEffect(() => {
    if (!hasMore || loading) return
    if (lastVisibleIndex == null) return
    if (lastVisibleIndex >= virtualItemCount - 5) {
      loadMore()
    }
  }, [lastVisibleIndex, hasMore, loading, loadMore, virtualItemCount])

  // Pixel-based bottom-proximity trigger — fires when the viewport's
  // bottom edge is within `INFINITE_SCROLL_BOTTOM_THRESHOLD_PX` of
  // the scroll container's full height. Complements the index-based
  // trigger above for tree view (one expanded tree-page row may
  // exceed the viewport vertically; the index-based check never
  // advances past that row even as the user scrolls inside it).
  const hasMoreRef = useRef(hasMore)
  const loadingRef = useRef(loading)
  const loadMoreRef = useRef(loadMore)
  hasMoreRef.current = hasMore
  loadingRef.current = loading
  loadMoreRef.current = loadMore
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    function handleScroll() {
      if (!hasMoreRef.current || loadingRef.current) return
      if (el == null) return
      const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (remaining <= INFINITE_SCROLL_BOTTOM_THRESHOLD_PX) {
        loadMoreRef.current()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
    // Empty deps + refs above: listener attaches once per mount, and
    // the refs always carry the latest hasMore/loading/loadMore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Document-level keydown: skip if user is typing in input/select/textarea
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown])

  // Scroll focused item into view. `focusedIndex` indexes into the
  // page-only `filteredPages` array; sentinel headers shift the row
  // index in the virtualizer, so map through `pageIndexToRowIndex`.
  //
  // This must fire ONLY when the user moves focus (arrow keys), never when
  // `pageIndexToRowIndex`'s identity changes as more pages stream in — else
  // every load-more re-runs `scrollToIndex(focusedIndex)` and yanks the
  // viewport back to the focused row (index 0 by default), defeating infinite
  // scroll. The mapping is read from a ref so data growth doesn't re-trigger.
  const pageIndexToRowIndexRef = useRef(pageIndexToRowIndex)
  pageIndexToRowIndexRef.current = pageIndexToRowIndex
  useEffect(() => {
    if (focusedIndex < 0) return
    const rowIndex = pageIndexToRowIndexRef.current[focusedIndex] ?? focusedIndex
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [focusedIndex, virtualizer])

  // UX-331 — wire `aria-activedescendant` so screen readers can track
  // arrow-key focus moves. The id pattern mirrors the row renderer:
  // flat rows expose `page-row-${page.id}`; namespace-tree wrappers
  // expose `page-row-${node.fullPath}` (see `PageBrowserRowRenderer`).
  //
  // PEND-58d D23b (a11y) — `aria-activedescendant` MUST reference an
  // element that is actually in the DOM. The list is virtualized, so a
  // focused row whose virtual index falls outside the current render
  // window has no rendered element, and pointing the attribute at its id
  // would dangle (ARIA violation; screen readers announce nothing or
  // error). Guard by confirming the focused row's virtual index is within
  // the rendered window (`virtualItems`) before emitting the id;
  // otherwise skip it. The `scrollToIndex` effect above keeps the focused
  // row in view on arrow-key moves, so under normal navigation the id is
  // present — this guard only suppresses the brief window before the
  // virtualizer re-renders around a programmatic jump.
  const renderedRowIndices = useMemo(
    () => new Set(virtualItems.map((vi) => vi.index)),
    [virtualItems],
  )
  const activeDescendantId = useMemo<string | undefined>(() => {
    if (focusedIndex < 0) return undefined
    const rowIdx = pageIndexToRowIndex[focusedIndex]
    if (rowIdx == null) return undefined
    // Skip when the focused row isn't in the current virtual window —
    // its element isn't rendered, so the id would dangle.
    if (!renderedRowIndices.has(rowIdx)) return undefined
    const row = groupedRows[rowIdx]
    if (!row) return undefined
    if (row.kind === 'page') return `page-row-${row.page.id}`
    if (row.kind === 'tree-page') return `page-row-${row.node.fullPath}`
    return undefined
  }, [focusedIndex, pageIndexToRowIndex, groupedRows, renderedRowIndices])

  // P0-B — a chip-only narrowing (empty text box, ≥1 active filter) that
  // returns zero rows must render the "no matches" state, not the
  // "No pages yet / Create your first page" empty-space state. Derive
  // `isFiltering` from the compound `filters` as well as the text input.
  // PEND-58d D11 — the count chip needs to tell the two narrowing axes
  // apart (free-text narrows the loaded set; chips narrow server-side), so
  // expose both booleans separately rather than the combined `isFiltering`.
  const hasTextQuery = filterText.trim().length > 0
  const hasChipFilters = filters.length > 0
  const isFiltering = hasTextQuery || hasChipFilters
  // The list viewport shows the "No matching pages" status (instead of
  // the virtualized rows) whenever an active filter resolves to zero
  // rows. Drives both the body branch and the grid-role suppression.
  const showNoMatch = isFiltering && filteredPages.length === 0

  // PEND-58d D3 — the frontend-only sorts (`alphabetical`, `recent`,
  // `created`) reorder only the loaded ≤50 rows client-side; their
  // visible order is globally accurate only once every page is loaded.
  // When more pages remain (`hasMore`), surface a cue in the header so
  // the user knows the order covers loaded pages only. `default` and the
  // three server-side sorts are globally accurate, so they never trigger.
  const frontendSortAtScale = isFrontendOnlySort(sortOption) && hasMore

  // E13 — keep the free-text count chip basis-consistent. The text box
  // narrows only the LOADED set client-side, so its numerator
  // (`matchedPageCount`) is loaded-basis. Pairing it with the server
  // filtered total (`displayTotalCount`) would skew "X of Y matching"
  // (a loaded numerator over a server denominator). When a text query is
  // active, drive the denominator from the loaded distinct page count so
  // both ends share the loaded basis — "23 of 50 matching" reads as "23
  // of the 50 loaded pages match". With no text query the chip keeps the
  // server total (forms (a) unfiltered and (c) chips-only in the header).
  // Guard on the server total still being a number so the chip stays
  // hidden when the backend never reported a total (unchanged behaviour).
  const headerTotalCount =
    hasTextQuery && typeof displayTotalCount === 'number' ? pages.length : displayTotalCount

  return (
    <div className="page-browser space-y-4">
      <ViewHeader>
        <PageBrowserHeader
          formRef={formRef}
          newPageInputRef={newPageInputRef}
          newPageName={newPageName}
          onNewPageNameChange={setNewPageName}
          isCreating={isCreating}
          onSubmit={handleCreatePage}
          showSearchAndSort={pages.length > 0}
          filterText={filterText}
          onFilterTextChange={setFilterText}
          sortOption={sortOption}
          onSortChange={setSortOption}
          density={density}
          onDensityChange={setDensity}
          // E13 — basis-consistent denominator: server total normally,
          // loaded distinct count when a text query is active (the text
          // box only narrows loaded pages, so a server total there skews).
          totalCount={headerTotalCount}
          // E7 — the count-chip numerator is the DISTINCT matched-page
          // count, not the grouped-row count (`filteredPages` under-counts
          // namespaced subtrees and double-counts starred+namespaced pages).
          filteredCount={matchedPageCount}
          hasTextQuery={hasTextQuery}
          hasChipFilters={hasChipFilters}
          frontendSortAtScale={frontendSortAtScale}
        />
      </ViewHeader>

      {/* PEND-58 Phase 3 — compound-filter chip-row. Only on the
          metadata IPC path; the legacy `listBlocks` path has no
          server-side filter support. Rendered when there are pages to
          groom OR filters are already active — the latter keeps the
          chips reachable when a filter narrows the result set to zero,
          so the user can always remove the filter that emptied the view. */}
      {flagOn && (pages.length > 0 || filters.length > 0) && (
        <PageBrowserFilterRow
          filters={filters}
          onAddFilter={handleAddFilter}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearAllFilters}
          // PEND-58e E5 — resolve `tag:` chips to tag names (the chip
          // previously showed the raw ULID because no resolver was passed).
          tagResolver={tagResolver}
        />
      )}

      {(!spaceIsReady || (loading && pages.length === 0)) && (
        <LoadingSkeleton count={3} height="h-10" loading className="page-browser-loading" />
      )}

      {/* P0-B — the empty-space "No pages yet / Create your first page"
          state is only correct when the view is genuinely unfiltered. When
          a chip (or text) narrows the server result to zero, `isFiltering`
          is true and we yield to the `noMatches` branch inside the
          ScrollArea instead, so a user with a full graph isn't told it's
          empty and offered an irrelevant create-first action. */}
      {spaceIsReady && !loading && pages.length === 0 && !isFiltering && (
        <EmptyState
          icon={FileText}
          message={t('pageBrowser.noPages')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={handleCreatePage}
              disabled={isCreating}
            >
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.createFirst')}
            </Button>
          }
        />
      )}

      <ScrollArea
        viewportRef={listRef}
        className="page-browser-list"
        // The height cap must live on the viewport (the actual scroller), not
        // the Root: a `max-height`-only Root has computed `height: auto`, so
        // the viewport's `h-full` can't resolve and grows to full content —
        // defeating virtualization and cascading load-more through every page.
        // Capping the viewport keeps shrink-to-content for short lists while
        // capping + scrolling (and virtualizing) for long ones.
        viewportClassName="max-h-[calc(100dvh-200px)]"
        viewportProps={{
          // MAINT-162 — ARIA grid pattern for the page list. The
          // viewport mixes flat-page rows, section headers, and
          // namespace-tree rows under one container; `role="grid"`
          // permits this heterogeneous mix where `role="listbox"`
          // would have required every child to be `role="option"`.
          //
          // P0-B / a11y — in the no-match state the only child is the
          // `EmptyState` status `<section>`, which is not a valid grid
          // child (`aria-required-children`). Drop the grid role (and its
          // grid-only ARIA attrs) in that state so the container is a
          // plain region holding the "No matching pages" message.
          ...(showNoMatch
            ? {}
            : {
                role: 'grid',
                'aria-label': hasStarred
                  ? t('pageBrowser.pageListGrouped')
                  : t('pageBrowser.pageList'),
                // UX-331 — bind `aria-activedescendant` to the focused
                // row's stable id so screen readers track arrow-key
                // focus moves without the inner buttons receiving DOM
                // focus.
                ...(activeDescendantId ? { 'aria-activedescendant': activeDescendantId } : {}),
              }),
          tabIndex: 0,
          // Section presence flags exposed for tests / styling hooks.
          // FEAT-14 — the unified model means either or both can be
          // present independently; consumers that want section-aware
          // chrome key off these data attributes.
          'data-has-starred': hasStarred ? 'true' : 'false',
          'data-has-pages': hasPages ? 'true' : 'false',
        }}
      >
        {showNoMatch ? (
          <EmptyState icon={Search} message={t('pageBrowser.noMatches')} />
        ) : (
          <>
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => {
                const row = groupedRows[virtualRow.index]
                if (!row) return null
                return (
                  <PageBrowserRowRenderer
                    key={virtualRow.key}
                    virtualRow={virtualRow}
                    row={row}
                    measureElement={virtualizer.measureElement}
                    focusedIndex={focusedIndex}
                    hasStarred={hasStarred}
                    sectionLabelId={sectionLabelId}
                    filterText={filterText}
                    isFiltering={isFiltering}
                    aliasMatchId={aliasMatchId}
                    deletingId={deletingId}
                    isStarred={isStarred}
                    toggleStar={toggleStar}
                    onPageSelect={onPageSelect}
                    onCreateUnder={handleCreateUnder}
                    onDeleteRequest={setDeleteTarget}
                    flagOn={flagOn}
                    density={density}
                  />
                )
              })}
            </div>
            {/* Inside the ScrollArea so the button sits at the bottom of
                the scrollable list (sibling of the virtual rows, not
                positioned past the inner viewport's lower edge). Fixes
                the case where the inner ScrollArea's `max-h` consumed
                the outer viewport and a button rendered below it was
                effectively off-screen.

                PEND-58d D9 (a11y) — the button is a direct child of the
                `role="grid"` viewport, which `aria-required-children`
                forbids (a grid's children must be rows). Wrap it in a
                `role="row"` > `role="gridcell"` footer so it's a valid
                grid descendant. Rendered only when `hasMore` so the grid
                never carries an empty trailing row once everything is
                loaded (`LoadMoreButton` itself also returns null then). */}
            {hasMore && (
              // biome-ignore lint/a11y/useSemanticElements: ARIA grid row — no semantic HTML equivalent for the load-more footer in this list grid
              // biome-ignore lint/a11y/useFocusableInteractive: row focus is delegated to the inner load-more button
              <div role="row" className="page-browser-load-more-row">
                {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to the inner load-more button */}
                <div role="gridcell">
                  <LoadMoreButton
                    hasMore={hasMore}
                    loading={loading}
                    onLoadMore={loadMore}
                    className="page-browser-load-more mt-2"
                    label={t('pageBrowser.loadMore')}
                    loadingLabel={t('pageBrowser.loading')}
                    loadedCount={pages.length}
                    totalCount={displayTotalCount}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </ScrollArea>

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* P1-F1 — polite announcement of compound-filter add/remove plus the
          settled result count, so screen-reader users hear the central
          chip interaction (which silently refetches the list). */}
      <output className="sr-only" aria-live="polite" data-testid="filter-announcement">
        {filterAnnouncement}
      </output>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('pageBrowser.deletePage')}
        description={t('pageBrowser.deleteDescription', { name: deleteTarget?.name })}
        cancelLabel={t('pageBrowser.cancel')}
        actionLabel={t('pageBrowser.delete')}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
