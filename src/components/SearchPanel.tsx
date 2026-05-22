/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination (`t('search.loadMoreButton')`) via usePaginatedQuery
 *  - CJK limitation notice (p3-t6)
 *
 * Opened via Ctrl+F (see `App.tsx` global handler around line 712, the
 * `focusSearch` `matchesShortcutBinding` branch — UX-260 sub-fix 6).
 *
 * PEND-30 D-3 — state-heavy logic decomposed into siblings under
 * `./SearchPanel/`:
 *  - `searchFilterReducer.ts` collapses the four applied-filter
 *    `useState`s into a single typed reducer.
 *  - `usePopoverEntity.ts` factors the page- and tag-popover state
 *    machines (4 useStates each) behind one parameterised hook.
 *  - `useAliasResolution.ts` owns the `[[alias]]` resolution effect.
 *
 * PEND-30 Phase 3b — JSX presentation lifted into siblings under
 * `./SearchPanel/`:
 *  - `SearchHeader.tsx` owns the input form + activity indicators.
 *  - `SearchFilters.tsx` owns the filter chip bar + popovers.
 *  - `SearchStatusRegion.tsx` owns the aria-live status announcer.
 *  - The result listbox now lives in `./search/SearchResultGroups.tsx`
 *    (PEND-73 Phase 4.M4 removed the stub `SearchResultList.tsx`).
 */

import { Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { LoadMoreButton } from '@/components/LoadMoreButton'
import { CardButton } from '@/components/ui/card-button'
import { getCaretRect } from '@/lib/caret-anchor'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { notify } from '@/lib/notify'
import type { FilterToken } from '@/lib/search-query'
import {
  addFilter,
  astToFilterProjection,
  parse,
  removeFilterAt,
  serialize,
} from '@/lib/search-query'
import {
  type AutocompleteAnchor,
  applyAutocompleteReplacement,
  detectAutocompleteAnchor,
} from '@/lib/search-query/autocomplete'
import { useAutocompleteSources } from '../hooks/useAutocompleteSources'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { useSearchHistoryCycling } from '../hooks/useSearchHistoryCycling'
import { logger } from '../lib/logger'
import { recordPathHistory } from '../lib/path-history'
import { addRecentPage, getRecentPages, type RecentPage } from '../lib/recent-pages'
import { reportIpcError } from '../lib/report-ipc-error'
import type { BlockRow, SearchBlockRow } from '../lib/tauri'
import {
  batchResolve,
  getBlock,
  listTagsByPrefix,
  paginationLimit,
  searchBlocks,
} from '../lib/tauri'
import { selectHistoryForSpace, useSearchHistoryStore } from '../stores/search-history'
import { useSpaceStore } from '../stores/space'
import { useTabsStore } from '../stores/tabs'
import { useCommandPaletteStore } from '../stores/useCommandPaletteStore'
import { EmptyState } from './EmptyState'
import { ResultCard } from './ResultCard'
import { SearchHeader } from './SearchPanel/SearchHeader'
import { SearchStatusRegion } from './SearchPanel/SearchStatusRegion'
import { useAliasResolution } from './SearchPanel/useAliasResolution'
import { type AutocompleteAriaIds, AutocompletePopover } from './search/AutocompletePopover'
import { FilterChipRow } from './search/FilterChipRow'
import { FilterHelperPopover } from './search/FilterHelperPopover'
import { SearchHistoryDropdown } from './search/SearchHistoryDropdown'
import { groupResultsByPage, SearchResultGroups } from './search/SearchResultGroups'
import { SearchToggleRow, type SearchToggleState } from './search/SearchToggleRow'

/** localStorage key for the PEND-54 one-time migration toast. */
const FILTER_SYNTAX_INTRO_TOAST_FLAG = 'agaric:searchFilterSyntaxToast:v1'

/**
 * PEND-73 Phase 3.U10 — session-scoped sentinel for the PEND-54 toast.
 * Lives outside React state so a SearchPanel remount within the same
 * page session re-reads the existing `true` without re-toasting. The
 * localStorage write below remains the cross-session persistence
 * mechanism; this module-level flag is purely the in-memory guard
 * against the "localStorage write fails, get fails next mount" loop
 * that historically re-fired the toast on every remount in private-
 * mode browsers.
 */
let filterSyntaxToastShownThisSession = false

/** PEND-55 — localStorage key for the toggle state (component-local but
 * persisted across reloads so power users don't re-click on every
 * session). Per plan: persists in localStorage. */
const SEARCH_TOGGLE_STORAGE_KEY = 'agaric:searchToggles:v1'

const DEFAULT_SEARCH_TOGGLES: SearchToggleState = {
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
}

/**
 * PEND-53 — Filter-param bundle the SearchPanel hands to `searchBlocks`.
 *
 * Split out of the `queryFn` callback so the closure stays under
 * biome's complexity cap. `regexModeFilterParams()` returns the
 * regex-mode no-filter bundle; `astFilterParams(projection, tagIds)`
 * returns the AST-projected bundle for the non-regex path. Both
 * shapes are accepted by `searchBlocks` as `Partial<…>` extension
 * fields (each entry is `T | undefined`).
 */
type SearchFilterParams = {
  tagIds?: string[] | undefined
  includePageGlobs?: string[] | undefined
  excludePageGlobs?: string[] | undefined
  stateFilter?: string[] | undefined
  priorityFilter?: string[] | undefined
  excludedStateFilter?: string[] | undefined
  excludedPriorityFilter?: string[] | undefined
  dueFilter?:
    | { kind: 'named'; name: string }
    | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }
    | null
  scheduledFilter?:
    | { kind: 'named'; name: string }
    | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }
    | null
  propertyFilters?: { key: string; value: string }[] | undefined
  excludedPropertyFilters?: { key: string; value: string }[] | undefined
}

function regexModeFilterParams(): SearchFilterParams {
  return {
    tagIds: undefined,
    includePageGlobs: undefined,
    excludePageGlobs: undefined,
    stateFilter: undefined,
    priorityFilter: undefined,
    excludedStateFilter: undefined,
    excludedPriorityFilter: undefined,
    dueFilter: null,
    scheduledFilter: null,
    propertyFilters: undefined,
    excludedPropertyFilters: undefined,
  }
}

function astFilterParams(
  projection: ReturnType<typeof astToFilterProjection>,
  tagIds: string[],
): SearchFilterParams {
  return {
    tagIds: tagIds.length === 0 ? undefined : tagIds,
    includePageGlobs:
      projection.includePageGlobs.length === 0 ? undefined : projection.includePageGlobs,
    excludePageGlobs:
      projection.excludePageGlobs.length === 0 ? undefined : projection.excludePageGlobs,
    stateFilter: projection.stateFilter.length === 0 ? undefined : projection.stateFilter,
    priorityFilter: projection.priorityFilter.length === 0 ? undefined : projection.priorityFilter,
    excludedStateFilter:
      projection.excludedStateFilter.length === 0 ? undefined : projection.excludedStateFilter,
    excludedPriorityFilter:
      projection.excludedPriorityFilter.length === 0
        ? undefined
        : projection.excludedPriorityFilter,
    dueFilter: projection.dueFilter,
    scheduledFilter: projection.scheduledFilter,
    propertyFilters:
      projection.propertyFilters.length === 0 ? undefined : projection.propertyFilters,
    excludedPropertyFilters:
      projection.excludedPropertyFilters.length === 0
        ? undefined
        : projection.excludedPropertyFilters,
  }
}

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

export function SearchPanel(): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — scope search to the current space. Mirrors the
  // `PageBrowser` pattern: render a `LoadingSkeleton` until the
  // `SpaceStore` has hydrated so the first `searchBlocks` call never
  // leaks cross-space results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searched, setSearched] = useState(false)
  // PEND-55 — toggle state. Persisted via localStorage so re-opening
  // the app preserves the user's preference (the plan calls this an
  // opt-in default; persisting is a UX win and the cost is one
  // serialise per change).
  const [toggles, setToggles] = useLocalStoragePreference<SearchToggleState>(
    SEARCH_TOGGLE_STORAGE_KEY,
    DEFAULT_SEARCH_TOGGLES,
  )
  // PEND-55 — surface invalid-regex errors inline next to the input.
  // Backend returns `AppError::Validation` with the `InvalidRegex:`
  // prefix; the frontend strips the prefix for display.
  const [regexError, setRegexError] = useState<string | null>(null)
  // PEND-55 — history dropdown visibility. Shown when the input is
  // focused AND empty (matches the plan's UX mock).
  const [inputFocused, setInputFocused] = useState(false)
  // PEND-60 Phase 1 — caret-anchored autocomplete state.
  const [caretPos, setCaretPos] = useState(0)
  const [autocompleteSelected, setAutocompleteSelected] = useState<string | null>(null)
  const [autocompleteRect, setAutocompleteRect] = useState<DOMRect | null>(null)
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false)
  const [autocompleteAriaIds, setAutocompleteAriaIds] = useState<AutocompleteAriaIds | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  // Used by every "external" `setQuery` call (history recall, palette
  // handoff, filter-chip adds, autocomplete pick, …). Stores the target
  // caret in `pendingCaretRef` so the `[query]` effect can sync
  // `input.selectionStart` + `caretPos` after React commits the new
  // value. Without this, the input's caret stays at its previous
  // position (the input is controlled), which makes the autocomplete
  // detector fire against a stale offset and can briefly re-open the
  // popover with the wrong anchor.
  const setQueryAndCaret = useCallback((value: string, caret?: number): void => {
    pendingCaretRef.current = caret ?? value.length
    setQuery(value)
  }, [])
  // UX-335 — `cleared` is true iff the user emptied the search input AFTER a
  // search had been performed. Used to surface a `t('search.statusCleared')`
  // announcement in the aria-live status region (separate from pre-search).
  const [cleared, setCleared] = useState(false)
  const [typing, setTyping] = useState(false)
  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [recentPages, setRecentPages] = useState<RecentPage[]>([])
  const navigateToPage = useTabsStore((s) => s.navigateToPage)

  // PEND-54 — the query string is the canonical filter state. The
  // AST is derived state recomputed on every keystroke via `useMemo`.
  const ast = useMemo(() => parse(query), [query])
  // The debounced query is also parsed so the IPC sees the filters
  // that match the rendered chips.
  const debouncedAst = useMemo(() => parse(debouncedQuery), [debouncedQuery])
  const debouncedProjection = useMemo(() => astToFilterProjection(debouncedAst), [debouncedAst])
  // Resolve tag names → tag_ids before firing the IPC. This is a
  // best-effort lookup: unknown names produce no tag_id (the SQL
  // path then matches nothing for that tag, which is correct).
  const [tagNameMap, setTagNameMap] = useState<Map<string, string>>(new Map())
  const tagIds = useMemo(() => {
    const out: string[] = []
    for (const name of debouncedProjection.tagNames) {
      const id = tagNameMap.get(name.toLowerCase())
      if (id) out.push(id)
    }
    return out
  }, [debouncedProjection.tagNames, tagNameMap])

  // Resolve tag names in `ast.filters` to ids via the prefix lookup.
  useEffect(() => {
    const names = debouncedProjection.tagNames.filter((n) => !tagNameMap.has(n.toLowerCase()))
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
  }, [debouncedProjection.tagNames, tagNameMap])

  // Load recent pages from localStorage on mount
  useEffect(() => {
    setRecentPages(getRecentPages())
  }, [])

  // PEND-51 — consume the palette's transient `pendingViewQuery`
  // handoff slot. When the user clicks "Search in all pages with
  // toggles → Ctrl+Shift+F" in the palette, the palette writes the
  // current query into the store and flips the navigation view to
  // `'search'`. This effect reads-and-clears the slot exactly once on
  // mount, then triggers the IPC by seeding both `query` and
  // `debouncedQuery`. We deliberately read via `getState()` so no
  // subscription is created and the effect's empty-dep array stays
  // honest.
  useEffect(() => {
    const pending = useCommandPaletteStore.getState().pendingViewQuery
    if (pending != null) {
      // PEND-61 CR — accept empty-string escalation seeds (the
      // commands-mode "Search everywhere" entry writes `''` to land
      // the user on this panel with a clean input). The previous
      // `length > 0` gate left the slot dirty across the session.
      if (pending.length > 0) {
        setQueryAndCaret(pending)
        setDebouncedQuery(pending)
        setSearched(true)
      }
      useCommandPaletteStore.getState().setPendingViewQuery(null)
    }
  }, [setQueryAndCaret])

  // PEND-54 — one-time migration toast pointing users at the help
  // dialog so they discover the inline filter syntax.
  //
  // PEND-73 Phase 3.U10 — guard against re-firing in browsers where
  // localStorage is unavailable (private mode, embedded webviews with
  // storage disabled). The earlier shape silently caught the write
  // failure but ALSO failed the read, so the toast re-fired on every
  // mount. The in-memory sentinel below is checked first; the
  // localStorage write is best-effort and only matters for cross-
  // session persistence.
  useEffect(() => {
    if (filterSyntaxToastShownThisSession) return
    filterSyntaxToastShownThisSession = true
    try {
      if (localStorage.getItem(FILTER_SYNTAX_INTRO_TOAST_FLAG)) return
      notify(t('search.filterSyntaxIntro'))
      localStorage.setItem(FILTER_SYNTAX_INTRO_TOAST_FLAG, '1')
    } catch {
      // localStorage unavailable; the session-scoped flag above is
      // what actually gates re-fires within this session, and the
      // toast was shown once on the first mount where this branch
      // ran — that's the best we can do without storage.
      notify(t('search.filterSyntaxIntro'))
    }
  }, [t])

  // PEND-55 — in regex mode the user's input is the regex verbatim;
  // skip PEND-54's filter projection so `tag:` / `path:` aren't
  // parsed as syntax. The full debouncedQuery is forwarded.
  //
  // PEND-53 — metadata fields (state / priority / due / scheduled /
  // prop) are also skipped in regex mode. The `searchFilterFromAst`
  // helper centralises the regex-mode short-circuit so the callback
  // body stays under biome's complexity cap.
  const filterParams = useMemo(
    () =>
      toggles.isRegex ? regexModeFilterParams() : astFilterParams(debouncedProjection, tagIds),
    [toggles.isRegex, debouncedProjection, tagIds],
  )
  const queryFn = useCallback(
    (cursor?: string) =>
      // FEAT-3 Phase 4 — `searchBlocks` requires `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: empty string
      // forces a no-match SQL filter (returning empty results) rather
      // than a runtime null deref.
      searchBlocks({
        query: toggles.isRegex ? debouncedQuery : debouncedAst.freeText,
        ...filterParams,
        cursor,
        limit: PAGINATION_LIMIT,
        spaceId: currentSpaceId ?? '',
        caseSensitive: toggles.caseSensitive,
        wholeWord: toggles.wholeWord,
        isRegex: toggles.isRegex,
      }),
    [
      debouncedAst.freeText,
      debouncedQuery,
      filterParams,
      currentSpaceId,
      toggles.caseSensitive,
      toggles.wholeWord,
      toggles.isRegex,
    ],
  )

  const {
    items: results,
    loading: searchLoading,
    hasMore,
    loadMore,
    error,
    setItems,
  } = usePaginatedQuery(queryFn, {
    // PEND-54 — the AST's free-text may be empty when the user has only
    // typed structured filter tokens (`tag:#urgent`). We still want to
    // run the query in that case so filters apply on their own.
    // PEND-55 — in regex mode, the typed query (not the AST) is the
    // pattern; gate on debouncedQuery length so an in-progress regex
    // edit still fires the IPC.
    enabled:
      spaceIsReady &&
      (toggles.isRegex
        ? debouncedQuery.length > 0
        : debouncedAst.freeText.length > 0 || debouncedAst.filters.length > 0),
    onError: t('search.failed'),
  })

  // PEND-55 — parse `AppError::Validation("InvalidRegex: …")` from the
  // IPC error and surface it inline. Otherwise the panel error reads
  // as a generic "Failed to search" which doesn't tell the user how
  // to fix their regex.
  useEffect(() => {
    if (!error) {
      setRegexError(null)
      return
    }
    const msg = typeof error === 'string' ? error : ''
    const prefix = 'InvalidRegex:'
    const idx = msg.indexOf(prefix)
    if (idx >= 0) {
      setRegexError(t('search.invalidRegex', { message: msg.slice(idx + prefix.length).trim() }))
    } else {
      setRegexError(null)
    }
  }, [error, t])

  // Resolve page titles for breadcrumbs when results change
  useEffect(() => {
    const parentIds = [
      ...new Set(results.map((b) => b.page_id).filter((id): id is string => id != null)),
    ]
    if (parentIds.length === 0) return
    batchResolve(parentIds)
      .then((resolved) => {
        if (Array.isArray(resolved)) {
          setPageTitles((prev) => {
            // PEND-73 Phase 4.P2 — stabilise Map identity so the
            // `groupResultsByPage` memo doesn't invalidate on every
            // batchResolve fetch. Walk the resolved array; only
            // allocate a new Map if at least one (id → title) pair
            // changed vs. what we already had. Common case (results
            // refetch with the same parent ids) returns `prev` and
            // the downstream useMemo skips its expensive group/rank.
            let changed = false
            for (const r of resolved) {
              const nextTitle = r.title ?? 'Untitled'
              if (prev.get(r.id) !== nextTitle) {
                changed = true
                break
              }
            }
            if (!changed) return prev
            const next = new Map(prev)
            for (const r of resolved) {
              next.set(r.id, r.title ?? 'Untitled')
            }
            return next
          })
        }
      })
      .catch((err) => {
        logger.warn('SearchPanel', 'breadcrumb resolution failed', undefined, err)
      })
  }, [results])

  // PEND-30 D-3 — alias resolution lifted into its own hook.
  // PEND-54 — alias-match runs against the free-text portion so a
  // query like `[[Alpha]] tag:#x` resolves the alias correctly.
  const { aliasMatch, aliasQuery } = useAliasResolution(
    debouncedAst.freeText,
    results,
    currentSpaceId,
  )

  const debounced = useDebouncedCallback((value: string) => {
    setTyping(false)
    setDebouncedQuery(value)
    setSearched(true)
  }, 300)

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)
    setCaretPos(e.target.selectionStart ?? value.length)

    debounced.cancel()

    if (!value.trim()) {
      // UX-335 — if a search had been performed (or we were already in the
      // cleared state and somehow re-emptied), keep `cleared` set so the
      // aria-live region announces `t('search.statusCleared')`.
      setCleared((prev) => prev || searched)
      setDebouncedQuery('')
      setItems([])
      setSearched(false)
      setTyping(false)
      // Alias state clears automatically: `useAliasResolution` re-runs
      // when `debouncedQuery` becomes '' and resets the match.
      return
    }

    setCleared(false)
    setTyping(true)
    debounced.schedule(value)
  }

  // Auto-focus search input on mount.
  // PEND-73 Phase 3.U4 — useLayoutEffect to focus before paint, matching
  // CommandPalette + InPageFind. Avoids the one-frame unfocused flash on
  // slow mounts (e.g. cold tab activation on low-end devices).
  const searchInputRef = useRef<HTMLInputElement>(null)
  useRegisterPrimaryFocus(searchInputRef)
  useLayoutEffect(() => {
    searchInputRef.current?.focus()
  }, [])

  // PEND-55 — history store + cycling hook
  const historyEntries = useSearchHistoryStore((s) => selectHistoryForSpace(s, currentSpaceId))
  const pushHistory = useSearchHistoryStore((s) => s.push)
  const clearHistory = useSearchHistoryStore((s) => s.clear)
  // UX-11 — per-row delete + record-history toggle.
  const removeHistoryEntry = useSearchHistoryStore((s) => s.removeEntry)
  const historyEnabled = useSearchHistoryStore((s) => s.historyEnabled)
  const setHistoryEnabled = useSearchHistoryStore((s) => s.setHistoryEnabled)
  const cycling = useSearchHistoryCycling(historyEntries, query, setQueryAndCaret)
  // PEND-73 Phase 3.U2 — stable id for the history listbox so the
  // owning input can wire `aria-controls` and `aria-activedescendant`.
  // React.useId() returns a per-instance stable string; safe across
  // SSR + multiple mounts.
  const historyListboxId = useId()

  // PEND-60 Phase 1 — caret-anchored autocomplete.
  // The active anchor is suppressed in regex mode so structured-filter
  // prefixes inside the regex aren't treated as autocompletable tokens.
  const currentAnchor = useMemo<AutocompleteAnchor>(
    () => (toggles.isRegex ? null : detectAutocompleteAnchor(query, caretPos)),
    [toggles.isRegex, query, caretPos],
  )
  const { items: autocompleteItems, loading: autocompleteLoading } = useAutocompleteSources({
    anchor: currentAnchor,
    spaceId: currentSpaceId,
  })
  const autocompleteOpen =
    inputFocused &&
    !autocompleteDismissed &&
    currentAnchor != null &&
    (autocompleteItems.length > 0 || autocompleteLoading)
  // ARIA 1.1 combobox-with-listbox attrs for the search input. The role
  // and supporting attrs are stable; `aria-expanded` flips true only
  // once the popover has reported its live cmdk-generated ids (axe
  // requires `aria-controls` whenever expanded=true on a combobox, and
  // those ids land one effect-tick after `autocompleteOpen` toggles).
  //
  // PEND-73 Phase 3.U2 — when the autocomplete is NOT open and the
  // history dropdown IS (input empty + focused + entries exist), wire
  // the combobox attrs to the history listbox so screen readers can
  // announce the active row as the user arrows through history.
  // Autocomplete + history are mutually exclusive by visibility gate
  // (history wants empty query; autocomplete wants caret content).
  const expanded = autocompleteOpen && autocompleteAriaIds != null
  const historyVisible = inputFocused && query.length === 0 && historyEntries.length > 0
  const inputComboboxAttrs = useMemo(
    () => ({
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': expanded || historyVisible,
      ...(expanded && autocompleteAriaIds != null
        ? {
            'aria-controls': autocompleteAriaIds.listboxId,
            ...(autocompleteAriaIds.activeDescendantId != null
              ? { 'aria-activedescendant': autocompleteAriaIds.activeDescendantId }
              : {}),
          }
        : historyVisible
          ? {
              'aria-controls': historyListboxId,
              ...(cycling.activeIndex >= 0
                ? {
                    'aria-activedescendant': `${historyListboxId}-opt-${cycling.activeIndex}`,
                  }
                : {}),
            }
          : {}),
    }),
    [expanded, autocompleteAriaIds, historyVisible, historyListboxId, cycling.activeIndex],
  )
  // Dismissal is cleared on every keystroke — typing again re-opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger, not a body-read dep — re-arm on every new keystroke.
  useEffect(() => {
    setAutocompleteDismissed(false)
  }, [query])
  // Default the highlight to the first item; preserve a stale selection
  // when it survives the new items list.
  useEffect(() => {
    if (!autocompleteOpen) {
      setAutocompleteSelected(null)
      return
    }
    setAutocompleteSelected((prev) =>
      prev != null && autocompleteItems.some((i) => i.value === prev)
        ? prev
        : (autocompleteItems[0]?.value ?? null),
    )
  }, [autocompleteOpen, autocompleteItems])
  // Recompute caret rect when the anchor changes. The rect anchors the
  // popover to the start of the *value* portion (after the `state:` /
  // `priority:` prefix), so the popover stays put as the user types
  // more characters of the value.
  useEffect(() => {
    if (!autocompleteOpen || currentAnchor == null) {
      setAutocompleteRect(null)
      return
    }
    const input = searchInputRef.current
    if (input == null) return
    setAutocompleteRect(getCaretRect(input, currentAnchor.anchor))
  }, [autocompleteOpen, currentAnchor])
  // Apply pending caret position after a `setQuery` triggered by item
  // selection. React doesn't sync controlled `<input>` selectionStart
  // with the new value automatically.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger — we want this to fire after React has reconciled the new value into the DOM.
  useEffect(() => {
    if (pendingCaretRef.current == null) return
    const input = searchInputRef.current
    if (input == null) return
    const pos = pendingCaretRef.current
    input.setSelectionRange(pos, pos)
    setCaretPos(pos)
    pendingCaretRef.current = null
  }, [query])

  const handleAutocompleteSelect = useCallback(
    (value: string) => {
      if (currentAnchor == null) return
      const { nextValue, nextCaret } = applyAutocompleteReplacement(
        query,
        caretPos,
        currentAnchor,
        value,
      )
      setQueryAndCaret(nextValue, nextCaret)
      setAutocompleteSelected(null)
      setAutocompleteDismissed(true)
      debounced.cancel()
      setCleared(false)
      setTyping(true)
      debounced.schedule(nextValue)
    },
    [currentAnchor, query, caretPos, debounced, setQueryAndCaret],
  )

  // PEND-60 Phase 1 — autocomplete keyboard helpers. Extracted to keep
  // `handleInputKeyDown` under biome's cognitive-complexity cap.
  const moveAutocompleteHighlight = useCallback(
    (direction: 1 | -1) => {
      if (autocompleteItems.length === 0) return
      const idx =
        autocompleteSelected != null
          ? autocompleteItems.findIndex((it) => it.value === autocompleteSelected)
          : -1
      const startIdx = idx === -1 ? (direction > 0 ? -1 : 0) : idx
      const nextIdx = (startIdx + direction + autocompleteItems.length) % autocompleteItems.length
      const next = autocompleteItems[nextIdx]
      if (next) setAutocompleteSelected(next.value)
    },
    [autocompleteItems, autocompleteSelected],
  )
  const dismissAutocomplete = useCallback(() => {
    setAutocompleteDismissed(true)
    setAutocompleteSelected(null)
  }, [])

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    debounced.cancel()
    setTyping(false)
    const trimmed = query.trim()
    if (trimmed) {
      setDebouncedQuery(trimmed)
      setSearched(true)
      // PEND-55 — push on submit, not on every keystroke. Per-space
      // partitioning is owned by the store.
      pushHistory(currentSpaceId, trimmed)
      // PEND-60 Phase 2 — record each path glob (include + exclude) in
      // the per-space MRU so the next caret-anchored `path:` /
      // `not-path:` autocomplete surfaces them.
      for (const filter of ast.filters) {
        if (filter.kind === 'pathInclude' || filter.kind === 'pathExclude') {
          recordPathHistory(currentSpaceId, filter.value)
        }
      }
    }
  }

  const handlePickHistory = useCallback(
    (entry: string) => {
      setQueryAndCaret(entry)
      setDebouncedQuery(entry)
      setSearched(true)
      pushHistory(currentSpaceId, entry)
      debounced.cancel()
      setTyping(false)
    },
    [currentSpaceId, debounced, pushHistory, setQueryAndCaret],
  )

  const handleClearHistory = useCallback(() => {
    clearHistory(currentSpaceId)
  }, [clearHistory, currentSpaceId])

  const handleRemoveHistory = useCallback(
    (entry: string) => {
      removeHistoryEntry(currentSpaceId, entry)
    },
    [currentSpaceId, removeHistoryEntry],
  )

  const handleToggleHistoryEnabled = useCallback(() => {
    setHistoryEnabled(!historyEnabled)
  }, [historyEnabled, setHistoryEnabled])

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Autocomplete keys win over history recall when the popover is open.
      if (autocompleteOpen && autocompleteItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          moveAutocompleteHighlight(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          moveAutocompleteHighlight(-1)
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && autocompleteSelected != null) {
          e.preventDefault()
          handleAutocompleteSelect(autocompleteSelected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissAutocomplete()
          return
        }
      }
      cycling.handleKeyDown(e)
    },
    [
      autocompleteOpen,
      autocompleteItems,
      autocompleteSelected,
      moveAutocompleteHighlight,
      dismissAutocomplete,
      handleAutocompleteSelect,
      cycling,
    ],
  )

  // PEND-60 Phase 1 — caret-position tracker. `onChange` covers typing;
  // these native listeners cover everything else (arrow-key moves,
  // click, focus, selection drag) without threading 4 props through
  // `SearchHeader` → `SearchInput` → `Input`.
  useEffect(() => {
    const input = searchInputRef.current
    if (input == null) return
    const sync = () => setCaretPos(input.selectionStart ?? input.value.length)
    input.addEventListener('select', sync)
    input.addEventListener('keyup', sync)
    input.addEventListener('click', sync)
    input.addEventListener('focus', sync)
    return () => {
      input.removeEventListener('select', sync)
      input.removeEventListener('keyup', sync)
      input.removeEventListener('click', sync)
      input.removeEventListener('focus', sync)
    }
  }, [])

  const handleResultClick = useCallback(
    async (block: BlockRow | SearchBlockRow) => {
      setLoadingResultId(block.id)
      try {
        if (block.block_type === 'page') {
          addRecentPage(block.id, block.content ?? 'Untitled')
          setRecentPages(getRecentPages())
          navigateToPage(block.id, block.content ?? 'Untitled')
          return
        }
        if (block.parent_id) {
          try {
            const parent = await getBlock(block.parent_id)
            addRecentPage(block.parent_id, parent.content ?? 'Untitled')
            setRecentPages(getRecentPages())
            navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
          } catch (err) {
            reportIpcError('SearchPanel', 'search.loadResultsFailed', err, t, {
              blockId: block.id,
              parentId: block.parent_id,
            })
          }
        } else {
          logger.warn('SearchPanel', 'block has no parent page', { blockId: block.id })
          notify.error(t('search.noParentPage'))
        }
      } finally {
        setLoadingResultId(null)
      }
    },
    [navigateToPage, t],
  )

  // PEND-50 Phase 1 — page-group results.
  // The flat result list drives the `focusedIndex` for roving-tabindex /
  // `aria-activedescendant`. Groups are derived from the flat list each
  // render via `groupResultsByPage`; their expand state lives in
  // `expandedGroups` so it persists across re-renders but resets on a
  // new query (see effect below).
  const groups = useMemo(() => groupResultsByPage(results, pageTitles), [results, pageTitles])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const handleToggleGroup = useCallback((pageId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [pageId]: !(prev[pageId] ?? true) }))
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `debouncedQuery` is the trigger, not a body-read dep — we intentionally reset on every new query.
  useEffect(() => {
    // Reset collapse state on each new query so the UX always starts
    // fully expanded.
    setExpandedGroups({})
  }, [debouncedQuery])

  // PEND-50 Phase 1 — flatten visible (i.e. expanded) rows for the
  // keyboard nav hook. Collapsed groups contribute zero rows. Note that
  // we keep `results.length` as the upper bound for `useListKeyboardNavigation`
  // when no groups are collapsed, which is the default state (every
  // `expandedGroups[k]` is `undefined`, treated as expanded).
  const visibleRows = useMemo(() => {
    const out: SearchBlockRow[] = []
    for (const g of groups) {
      const isExpanded = expandedGroups[g.page_id] ?? true
      if (!isExpanded) continue
      for (const block of g.blocks) out.push(block)
    }
    return out
  }, [groups, expandedGroups])

  const { focusedIndex, handleKeyDown: handleListKeyDown } = useListKeyboardNavigation({
    itemCount: visibleRows.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = visibleRows[idx]
      if (block) handleResultClick(block)
    },
  })

  const handleRecentClick = useCallback(
    (page: RecentPage) => {
      addRecentPage(page.id, page.title)
      setRecentPages(getRecentPages())
      navigateToPage(page.id, page.title)
    },
    [navigateToPage],
  )

  // PEND-54 — chip / helper handlers. Each appends a filter token
  // to the AST and re-serialises the canonical query string. The
  // serialised result becomes the new caret-end so autocomplete fires
  // against the right anchor on the next render.
  function patchQuery(next: (currentAst: typeof ast) => typeof ast) {
    const nextValue = serialize(next(parse(query)))
    setQueryAndCaret(nextValue)
  }
  function handleRemoveFilter(index: number) {
    patchQuery((a) => removeFilterAt(a, index))
  }
  function handleClearAllFilters() {
    setQueryAndCaret(debouncedAst.freeText)
  }
  function handleAddTag(name: string) {
    const token: FilterToken = { kind: 'tag', value: name, span: [0, 0] }
    patchQuery((a) => addFilter(a, token))
  }
  function handleAddPathInclude(glob: string) {
    const token: FilterToken = { kind: 'pathInclude', value: glob, span: [0, 0] }
    patchQuery((a) => addFilter(a, token))
  }
  function handleAddPathExclude(glob: string) {
    const token: FilterToken = { kind: 'pathExclude', value: glob, span: [0, 0] }
    patchQuery((a) => addFilter(a, token))
  }

  // FEAT-3 Phase 2 — render a skeleton while the SpaceStore hydrates so
  // we never fire a `searchBlocks` call with an unresolved `spaceId`.
  if (!spaceIsReady) {
    return (
      <div className="search-panel space-y-4" aria-busy="true">
        <LoadingSkeleton count={3} height="h-10" className="search-panel-loading" />
      </div>
    )
  }

  return (
    <div className="search-panel space-y-4">
      {/* PEND-30 Phase 3b — input form lifted into `SearchHeader`. */}
      {/* PEND-55 — append toggle row + history dropdown + regex error slot. */}
      <SearchHeader
        inputRef={searchInputRef}
        query={query}
        onInputChange={handleInputChange}
        onSubmit={handleSubmit}
        searchLoading={searchLoading}
        typing={typing}
        t={t}
        onInputKeyDown={handleInputKeyDown}
        onInputFocus={() => setInputFocused(true)}
        // PEND-73 Phase 3.U5 — synchronous blur. The history dropdown's
        // rows preventDefault on mousedown, which keeps the input
        // focused through the click; no defer needed.
        onInputBlur={() => setInputFocused(false)}
        invalid={!!regexError}
        inlineError={regexError}
        comboboxAttrs={inputComboboxAttrs}
        toggleRow={<SearchToggleRow toggles={toggles} onChange={setToggles} />}
        historyDropdown={
          <SearchHistoryDropdown
            entries={historyEntries}
            // UX-11 — also show when recording is OFF (even with no
            // entries) so the Enable toggle + "history is off" notice
            // remain reachable from the dropdown footer.
            visible={
              inputFocused && query.length === 0 && (historyEntries.length > 0 || !historyEnabled)
            }
            onPick={handlePickHistory}
            onClear={handleClearHistory}
            onRemoveEntry={handleRemoveHistory}
            historyEnabled={historyEnabled}
            onToggleEnabled={handleToggleHistoryEnabled}
            listboxId={historyListboxId}
            activeIndex={cycling.activeIndex}
          />
        }
      />
      {/* PEND-60 Phase 1 — caret-anchored value autocomplete. Portals
          to body via Radix, so its placement in the tree is positional
          only. */}
      <AutocompletePopover
        open={autocompleteOpen}
        anchorRect={autocompleteRect}
        items={autocompleteItems}
        selectedValue={autocompleteSelected}
        onSelectedValueChange={setAutocompleteSelected}
        onSelect={handleAutocompleteSelect}
        label={t('search.autocompleteListLabel')}
        loading={autocompleteLoading}
        loadingLabel={t('search.searching')}
        onAriaIdsChange={setAutocompleteAriaIds}
      />

      {/* UX-269 — CJK limitation notice sits directly below the input so
          CJK users see it before scanning results. */}
      {hasCJK(query) && (
        <div
          className="rounded-lg border border-alert-info-border bg-alert-info p-3 text-sm text-alert-info-foreground"
          data-testid="cjk-notice"
        >
          <span className="font-medium">{t('search.cjkNoteLabel')}</span>{' '}
          {t('search.cjkLimitationNote')}
        </div>
      )}

      {/* PEND-54 — chip row projected from the parsed AST. */}
      <FilterChipRow
        filters={ast.filters}
        onRemove={handleRemoveFilter}
        onClearAll={handleClearAllFilters}
        trailing={
          <FilterHelperPopover
            onAddTag={handleAddTag}
            onAddPathInclude={handleAddPathInclude}
            onAddPathExclude={handleAddPathExclude}
          />
        }
      />

      {query.trim().length > 0 && query.trim().length < 3 && (
        <div className="rounded-lg border border-alert-warning-border bg-alert-warning p-3 text-sm text-alert-warning-foreground">
          {t('search.minCharsHint')}
        </div>
      )}

      {query === '' && recentPages.length > 0 && (
        <div className="recent-pages">
          <h3 className="text-sm font-medium text-muted-foreground px-3 py-2">
            {t('search.recentTitle')}
          </h3>
          <ul className="space-y-1 list-none m-0 p-0">
            {recentPages.map((page) => (
              <li key={page.id}>
                <CardButton className="text-sm" onClick={() => handleRecentClick(page)}>
                  {page.title}
                </CardButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      {searchLoading && results.length === 0 && (
        <LoadingSkeleton count={2} height="h-12" className="search-loading" />
      )}

      {/* PEND-30 Phase 3b — status region lifted into `SearchStatusRegion`. */}
      <SearchStatusRegion
        searched={searched}
        searchLoading={searchLoading}
        error={error}
        cleared={cleared}
        resultCount={results.length}
        t={t}
      />

      {searched && !searchLoading && results.length === 0 && !error && !aliasMatch && (
        <EmptyState icon={Search} message={t('search.noResultsFound')} />
      )}

      {aliasMatch && (
        <div data-testid="alias-match">
          <ResultCard
            block={aliasMatch}
            onClick={() => handleResultClick(aliasMatch)}
            disabled={loadingResultId === aliasMatch.id}
            showSpinner={loadingResultId === aliasMatch.id}
            contentClassName="line-clamp-2"
          >
            <p className="text-xs text-muted-foreground mt-1" data-testid="alias-match-label">
              {t('search.aliasMatch', { alias: aliasQuery })}
            </p>
          </ResultCard>
        </div>
      )}

      {/* PEND-50 Phase 1 — page-grouped result tree. The summary count
          sits above the first group (rendered inside `SearchResultGroups`).
          Per-group listboxes preserve the existing
          `useListKeyboardNavigation` roving model and replace the flat
          listbox formerly owned by `SearchResultList`. */}
      <SearchResultGroups
        groups={groups}
        flatRows={visibleRows}
        focusedIndex={focusedIndex}
        expandedGroups={expandedGroups}
        onToggleGroup={handleToggleGroup}
        onResultClick={handleResultClick}
        // PEND-50 Phase 1 — passing a no-op tells `CollapsibleGroupList`
        // to render the page title via `<PageLink>` (its own click
        // navigates through `useTabsStore.navigateToPage`). The
        // callback signature is preserved for future hooks (e.g.
        // recent-page bookkeeping); today it deliberately defers to
        // `PageLink`'s built-in handler so click + Enter parity is
        // free.
        onPageTitleClick={() => {
          /* navigation handled by `PageLink` */
        }}
        loadingResultId={loadingResultId}
        onKeyDown={handleListKeyDown}
        t={t}
      />

      <LoadMoreButton
        hasMore={hasMore}
        loading={searchLoading}
        onLoadMore={loadMore}
        className="search-load-more"
      />
    </div>
  )
}
