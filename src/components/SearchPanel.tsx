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
 * `focusSearchmatchesShortcutBinding` branch — sub-fix 6).
 *
 * D-3 — state-heavy logic decomposed into siblings under
 * `./SearchPanel/`:
 *  - `searchFilterReducer.ts` collapses the four applied-filter
 *    `useState`s into a single typed reducer.
 *  - `usePopoverEntity.ts` factors the page- and tag-popover state
 *    machines (4 useStates each) behind one parameterised hook.
 *  - `useAliasResolution.ts` owns the `[[alias]]` resolution effect.
 *
 * Phase 3b — JSX presentation lifted into siblings under
 * `./SearchPanel/`:
 *  - `SearchHeader.tsx` owns the input form + activity indicators.
 *  - `SearchFilters.tsx` owns the filter chip bar + popovers.
 *  - `SearchStatusRegion.tsx` owns the aria-live status announcer.
 *  - The result listbox now lives in `./search/SearchResultGroups.tsx`
 * (Phase 4.M4 removed the stub `SearchResultList.tsx`).
 */

import { FilterX, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { ResultCard } from '@/components/common/ResultCard'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { CardButton } from '@/components/ui/card-button'
import type { FilterToken } from '@/lib/search-query'
import { addFilter, parse, removeFilterAt, serialize } from '@/lib/search-query'

import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { recordPathHistory } from '../lib/path-history'
import { useSpaceStore } from '../stores/space'
import { useCommandPaletteStore } from '../stores/useCommandPaletteStore'
import { SearchHelpDialog } from './help/SearchHelpDialog'
import { FilterChipRow } from './search/FilterChipRow'
import { FilterHelperPopover } from './search/FilterHelperPopover'
import { SearchHistoryDropdown } from './search/SearchHistoryDropdown'
import { SearchResultGroups } from './search/SearchResultGroups'
import { SearchToggleRow, type SearchToggleState } from './search/SearchToggleRow'
import {
  SearchAutocomplete,
  type SearchAutocompleteHandle,
  type SearchAutocompleteState,
} from './SearchPanel/SearchAutocomplete'
import { SearchHeader } from './SearchPanel/SearchHeader'
import { SearchStatusRegion } from './SearchPanel/SearchStatusRegion'
import { useAliasResolution } from './SearchPanel/useAliasResolution'
import { useFilterSyntaxIntroToast } from './SearchPanel/useFilterSyntaxIntroToast'
import { useSearchHistoryControls } from './SearchPanel/useSearchHistoryControls'
import { useSearchResults } from './SearchPanel/useSearchResults'

/** localStorage key for the toggle state (component-local but
 * persisted across reloads so power users don't re-click on every
 * session). Per plan: persists in localStorage. */
const SEARCH_TOGGLE_STORAGE_KEY = 'agaric:searchToggles:v1'

const DEFAULT_SEARCH_TOGGLES: SearchToggleState = {
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
}

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

/**
 * Whether the history dropdown is on screen: input focused + (empty input OR
 * an active recall) AND (there are entries to recall OR recording is off).
 * Extracted as a pure helper so the boolean chain doesn't add decision points
 * to the `SearchPanel` body's cyclomatic complexity.
 */
function computeHistoryDropdownVisible(args: {
  inputFocused: boolean
  queryLength: number
  historyActiveIndex: number
  historyEntryCount: number
  historyEnabled: boolean
}): boolean {
  const { inputFocused, queryLength, historyActiveIndex, historyEntryCount, historyEnabled } = args
  return (
    inputFocused &&
    (queryLength === 0 || historyActiveIndex >= 0) &&
    (historyEntryCount > 0 || !historyEnabled)
  )
}

/**
 * Build the `aria-controls` / `aria-activedescendant` pair for the input's
 * combobox attrs. Autocomplete wins over history (the two are mutually
 * exclusive on screen). Extracted as a pure helper so the component's
 * `inputComboboxAttrs` memo stays under the cyclomatic-complexity ceiling.
 */
function comboboxControlAttrs(args: {
  expanded: boolean
  autocompleteAriaIds: SearchAutocompleteState['ariaIds']
  historyListboxVisible: boolean
  historyListboxId: string
  historyActiveIndex: number
}): Record<string, string> {
  const {
    expanded,
    autocompleteAriaIds,
    historyListboxVisible,
    historyListboxId,
    historyActiveIndex,
  } = args
  if (expanded && autocompleteAriaIds != null) {
    return {
      'aria-controls': autocompleteAriaIds.listboxId,
      ...(autocompleteAriaIds.activeDescendantId != null
        ? { 'aria-activedescendant': autocompleteAriaIds.activeDescendantId }
        : {}),
    }
  }
  if (historyListboxVisible) {
    return {
      'aria-controls': historyListboxId,
      ...(historyActiveIndex >= 0
        ? { 'aria-activedescendant': `${historyListboxId}-opt-${historyActiveIndex}` }
        : {}),
    }
  }
  return {}
}

export function SearchPanel(): React.ReactElement {
  const { t } = useTranslation()

  // Phase 2 — scope search to the current space. Render a skeleton
  // until the SpaceStore has hydrated so the first `searchBlocks` call never
  // leaks cross-space results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searched, setSearched] = useState(false)
  // Toggle state, persisted via localStorage so re-opening the app
  // preserves the user's preference.
  const [toggles, setToggles] = useLocalStoragePreference<SearchToggleState>(
    SEARCH_TOGGLE_STORAGE_KEY,
    DEFAULT_SEARCH_TOGGLES,
  )
  // History dropdown visibility (shown when the input is focused
  // AND empty).
  const [inputFocused, setInputFocused] = useState(false)
  // Search help dialog open state (the `?` toolbar button).
  const [helpOpen, setHelpOpen] = useState(false)
  // / the caret-anchored autocomplete machine lives in
  // <SearchAutocomplete>; SearchPanel keeps only the open/aria summary it
  // reports (for the input's combobox attrs) and the shared pending-caret ref.
  const [autocomplete, setAutocomplete] = useState<SearchAutocompleteState>({
    open: false,
    ariaIds: null,
  })
  const autocompleteRef = useRef<SearchAutocompleteHandle>(null)
  const pendingCaretRef = useRef<number | null>(null)
  // Used by every "external" `setQuery` call (history recall, palette handoff,
  // filter-chip adds, autocomplete pick). Stores the target caret in
  // `pendingCaretRef` so <SearchAutocomplete>'s `[query]` effect can sync
  // `input.selectionStart` after React commits the new value (the input is
  // controlled, so otherwise the caret stays at its previous position and the
  // autocomplete detector fires against a stale offset).
  const setQueryAndCaret = useCallback((value: string, caret?: number): void => {
    pendingCaretRef.current = caret ?? value.length
    setQuery(value)
  }, [])
  // `cleared` is true iff the user emptied the input AFTER a search
  // had been performed (surfaces a `t('search.statusCleared')` announcement).
  const [cleared, setCleared] = useState(false)
  const [typing, setTyping] = useState(false)

  // The query string is the canonical filter state. The AST is
  // derived state recomputed on every keystroke. The debounced query is also
  // parsed so the IPC sees the filters that match the rendered chips.
  const ast = useMemo(() => parse(query), [query])
  const debouncedAst = useMemo(() => parse(debouncedQuery), [debouncedQuery])

  const debounced = useDebouncedCallback((value: string) => {
    setTyping(false)
    setDebouncedQuery(value)
    setSearched(true)
  }, 300)

  // FE-A18 — the results pipeline (AST→IPC projection, pagination,
  // breadcrumbs, grouping + collapse, roving keyboard nav, navigation) lives
  // in `useSearchResults`.
  const {
    results,
    searchLoading,
    hasMore,
    loadMore,
    error,
    capped,
    setItems,
    regexError,
    groups,
    visibleRows,
    focusedIndex,
    handleListKeyDown,
    expandedGroups,
    handleToggleGroup,
    handleResultClick,
    loadingResultId,
    recentPages,
    handleRecentClick,
  } = useSearchResults({ debouncedAst, debouncedQuery, currentSpaceId, spaceIsReady, toggles })

  // D-3 / alias resolution runs against the free-text
  // portion so a query like `[[Alpha]] tag:#x` resolves the alias correctly.
  const { aliasMatch, aliasQuery } = useAliasResolution(
    debouncedAst.freeText,
    results,
    currentSpaceId,
  )

  // FE-A18 — the search-history surface (per-space store wiring, recall
  // cycling, recall/clear/remove/toggle handlers, listbox id) lives in
  // `useSearchHistoryControls`.
  const {
    historyEntries,
    historyEnabled,
    pushHistory,
    cycling,
    historyListboxId,
    handlePickHistory,
    handleClearHistory,
    handleRemoveHistory,
    handleToggleHistoryEnabled,
  } = useSearchHistoryControls({
    currentSpaceId,
    query,
    setQueryAndCaret,
    setDebouncedQuery,
    setSearched,
    setTyping,
    debounced,
  })

  // Consume the palette's transient `pendingViewQuery` handoff slot
  // exactly once on mount, then seed both `query` + `debouncedQuery` to fire
  // the IPC. Read via `getState()` so no subscription is created and the
  // effect's empty-dep array stays honest.
  useEffect(() => {
    const pending = useCommandPaletteStore.getState().pendingViewQuery
    if (pending != null) {
      // Accept empty-string escalation seeds (the commands-mode
      // "Search everywhere" entry writes `''` to land the user on this panel
      // with a clean input). The previous `length > 0` gate left the slot
      // dirty across the session.
      if (pending.length > 0) {
        setQueryAndCaret(pending)
        setDebouncedQuery(pending)
        setSearched(true)
      }
      useCommandPaletteStore.getState().setPendingViewQuery(null)
    }
  }, [setQueryAndCaret])

  // / one-time migration toast pointing users at the help
  // dialog so they discover the inline filter syntax.
  useFilterSyntaxIntroToast()

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)
    // Caret tracking lives in <SearchAutocomplete>; feed it the
    // authoritative caret eagerly so the anchor stays in lockstep.
    autocompleteRef.current?.syncCaret(e.target.selectionStart ?? value.length)

    debounced.cancel()

    if (!value.trim()) {
      // Keep `cleared` set so the aria-live region announces
      // `t('search.statusCleared')`.
      setCleared((prev) => prev || searched)
      setDebouncedQuery('')
      setItems([])
      setSearched(false)
      setTyping(false)
      // Alias state clears automatically: `useAliasResolution` re-runs when
      // `debouncedQuery` becomes '' and resets the match.
      return
    }

    setCleared(false)
    setTyping(true)
    debounced.schedule(value)
  }

  // Auto-focus search input on mount.
  // Phase 3.U4 — useLayoutEffect to focus before paint, matching
  // CommandPalette + InPageFind (avoids the one-frame unfocused flash).
  const searchInputRef = useRef<HTMLInputElement>(null)
  useRegisterPrimaryFocus(searchInputRef)
  useLayoutEffect(() => {
    searchInputRef.current?.focus()
  }, [])

  // Combobox a11y for the input. History and autocomplete are
  // mutually exclusive (history wants an empty query, autocomplete wants caret
  // content), so they share the input's combobox attrs.
  const expanded = autocomplete.open && autocomplete.ariaIds != null
  // FE-A13 — ONE source of truth for whether the history dropdown is on
  // screen. The dropdown is shown while the input is focused + empty AND there
  // Is either history to recall OR recording is OFF (keeps the Enable
  // toggle + "history is off" footer reachable even with zero entries).
  //
  // CR-A11Y (#151) — ALSO keep it open while a recall is active
  // (`cycling.activeIndex >= 0`). ArrowUp/Down fills the input with the
  // recalled entry, so `query.length` is no longer 0; without this clause the
  // dropdown — and with it the listbox's `aria-activedescendant` and the
  // input's roving combobox attrs — would unmount the instant a row became
  // active, making the roving selection (and the keyboard per-row delete it
  // gates) impossible to announce to AT. Keeping it open through recall is
  // also what lets the user SEE which row Delete/Backspace will remove.
  const historyDropdownVisible = computeHistoryDropdownVisible({
    inputFocused,
    queryLength: query.length,
    historyActiveIndex: cycling.activeIndex,
    historyEntryCount: historyEntries.length,
    historyEnabled,
  })
  // FE-A13 / the `role="listbox"` element (and its `historyListboxId`)
  // only renders when there are entries, so the combobox's `aria-expanded` /
  // `aria-controls` must track the LISTBOX, not the dropdown shell.
  const historyListboxVisible = historyDropdownVisible && historyEntries.length > 0
  const inputComboboxAttrs = useMemo(
    () => ({
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': expanded || historyListboxVisible,
      ...comboboxControlAttrs({
        expanded,
        autocompleteAriaIds: autocomplete.ariaIds,
        historyListboxVisible,
        historyListboxId,
        historyActiveIndex: cycling.activeIndex,
      }),
    }),
    [expanded, autocomplete.ariaIds, historyListboxVisible, historyListboxId, cycling.activeIndex],
  )

  // Stable so the child's state-report effect doesn't re-fire on identity.
  const handleAutocompleteStateChange = useCallback((state: SearchAutocompleteState) => {
    setAutocomplete(state)
  }, [])

  // Apply a chosen completion. The child computed nextValue +
  // nextCaret from its own caret/anchor; SearchPanel owns query + debounce.
  const handleAutocompleteApply = useCallback(
    (nextValue: string, nextCaret: number) => {
      setQueryAndCaret(nextValue, nextCaret)
      debounced.cancel()
      setCleared(false)
      setTyping(true)
      debounced.schedule(nextValue)
    },
    [debounced, setQueryAndCaret],
  )

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    debounced.cancel()
    setTyping(false)
    const trimmed = query.trim()
    if (trimmed) {
      setDebouncedQuery(trimmed)
      setSearched(true)
      // Push on submit, not on every keystroke. Per-space
      // partitioning is owned by the store.
      pushHistory(currentSpaceId, trimmed)
      // Phase 2 — record each path glob (include + exclude) in the
      // per-space MRU so the next caret-anchored `path:` autocomplete surfaces
      // them.
      for (const filter of ast.filters) {
        if (filter.kind === 'pathInclude' || filter.kind === 'pathExclude') {
          recordPathHistory(currentSpaceId, filter.value)
        }
      }
    }
  }

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // `?` on an empty input opens the search help dialog. Reading the
      // live value avoids taking `query` as a dependency.
      if (e.key === '?' && e.currentTarget.value.length === 0) {
        e.preventDefault()
        setHelpOpen(true)
        return
      }
      // Autocomplete keys win over history recall when the popover is open.
      // <SearchAutocomplete> owns that state; it returns true if it consumed
      // the key.
      if (autocompleteRef.current?.handleKeyDown(e)) return
      // Escape cancels an in-progress history recall and restores the
      // empty input (commit semantics differ between the two suggestion
      // sources, so the keys do too).
      if (e.key === 'Escape' && cycling.activeIndex >= 0) {
        e.preventDefault()
        cycling.reset()
        setQueryAndCaret('')
        return
      }
      // CR-A11Y (#151) — keyboard-reachable per-row history delete. While a
      // history row is active (roved to via Up/Down, surfaced through the
      // listbox's `aria-activedescendant`), Delete/Backspace removes THAT
      // row. Focus stays on the input the whole time (combobox-with-listbox
      // pattern), so the per-row delete button — which is `aria-hidden` and
      // mouse-only by design (a focusable control inside `role="option"`
      // trips axe's nested-interactive rule) — is now reachable for AT
      // users instead of only the bulk "Clear history" action.
      //
      // Gate on the dropdown being on-screen with entries: the active recall
      // value has just been written into the input (so the row text equals
      // the live `query`), but the recall replaces the input value, so the
      // input is no longer empty — re-using `historyDropdownVisible` (which
      // requires `query.length === 0`) would be wrong here. Resolve the row
      // text directly from `historyEntries[cycling.activeIndex]`.
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        cycling.activeIndex >= 0 &&
        historyEntries.length > 0
      ) {
        const entry = historyEntries[cycling.activeIndex]
        if (entry != null) {
          e.preventDefault()
          // Reset the recall machine and clear the input first: the removed
          // entry's text currently fills the input, and the indices shift
          // once it's gone. Returning to typing mode + empty input re-shows
          // the (now shorter) MRU list so the user can keep deleting.
          cycling.reset()
          setQueryAndCaret('')
          handleRemoveHistory(entry)
          return
        }
      }
      cycling.handleKeyDown(e)
    },
    [cycling, setQueryAndCaret, historyEntries, handleRemoveHistory],
  )

  // / FE-A12 — chip / helper handlers. Each appends a filter token to
  // the AST and re-serialises the canonical query string; they read the `ast`
  // memo (already `parse(query)`, recomputed on every `query` change and
  // current inside the same render's event handlers).
  function patchQuery(next: (currentAst: typeof ast) => typeof ast) {
    const nextValue = serialize(next(ast))
    setQueryAndCaret(nextValue)
  }
  function handleRemoveFilter(index: number) {
    patchQuery((a) => removeFilterAt(a, index))
  }
  function handleClearAllFilters() {
    // Keep the LIVE free text (not the debounced/last-committed AST) so
    // just-typed-but-not-yet-debounced words aren't dropped.
    setQueryAndCaret(ast.freeText)
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
  // The structural builder forms hand back a fully built
  // token (state / priority / due / scheduled / prop and not- variants);
  // route it through the same append-and-reserialise path.
  function handleAddFilter(token: FilterToken) {
    patchQuery((a) => addFilter(a, token))
  }

  // Phase 2 — render a skeleton while the SpaceStore hydrates so we
  // never fire a `searchBlocks` call with an unresolved `spaceId`.
  if (!spaceIsReady) {
    return (
      <div className="search-panel space-y-4" aria-busy="true">
        <LoadingSkeleton count={3} height="h-10" className="search-panel-loading" />
      </div>
    )
  }

  return (
    <div className="search-panel space-y-4">
      {/*  Phase 3b — input form lifted into `SearchHeader`. */}
      {/* append toggle row + history dropdown + regex error slot. */}
      <SearchHeader
        inputRef={searchInputRef}
        query={query}
        onInputChange={handleInputChange}
        onSubmit={handleSubmit}
        searchLoading={searchLoading}
        typing={typing}
        onInputKeyDown={handleInputKeyDown}
        onInputFocus={() => setInputFocused(true)}
        // Phase 3.U5 — synchronous blur. The history dropdown's rows
        // preventDefault on mousedown, which keeps the input focused through
        // the click; no defer needed.
        onInputBlur={() => setInputFocused(false)}
        invalid={!!regexError}
        inlineError={regexError}
        comboboxAttrs={inputComboboxAttrs}
        onHelpClick={() => setHelpOpen(true)}
        regexMode={toggles.isRegex}
        toggleRow={<SearchToggleRow toggles={toggles} onChange={setToggles} />}
        historyDropdown={
          <SearchHistoryDropdown
            entries={historyEntries}
            // FE-A13 — the dropdown shell shares the `historyDropdownVisible`
            // base with the input's aria attrs; the combobox's `aria-expanded`
            // / `aria-controls` additionally require entries
            // (`historyListboxVisible`) so they only reference a listbox that
            // actually renders.
            // The shell also shows when recording is OFF (even with no
            // entries) so the Enable toggle + "history is off" notice remain
            // reachable from the dropdown footer.
            visible={historyDropdownVisible}
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
      {/*  / caret-anchored value autocomplete. Owns its own
          caret state so caret moves don't re-render this panel; the popover
          portals to body via Radix (placement is positional). */}
      <SearchAutocomplete
        ref={autocompleteRef}
        inputRef={searchInputRef}
        query={query}
        spaceId={currentSpaceId}
        focused={inputFocused}
        pendingCaretRef={pendingCaretRef}
        onApply={handleAutocompleteApply}
        onStateChange={handleAutocompleteStateChange}
      />

      {/* CJK limitation notice sits directly below the input so CJK
          users see it before scanning results. */}
      {hasCJK(query) && (
        <div
          className="rounded-lg border border-alert-info-border bg-alert-info p-3 text-sm text-alert-info-foreground"
          data-testid="cjk-notice"
        >
          <span className="font-medium">{t('search.cjkNoteLabel')}</span>{' '}
          {t('search.cjkLimitationNote')}
        </div>
      )}

      {/* chip row projected from the parsed AST. */}
      <FilterChipRow
        filters={ast.filters}
        onRemove={handleRemoveFilter}
        onClearAll={handleClearAllFilters}
        trailing={
          <FilterHelperPopover
            onAddTag={handleAddTag}
            onAddPathInclude={handleAddPathInclude}
            onAddPathExclude={handleAddPathExclude}
            onAddFilter={handleAddFilter}
          />
        }
      />

      {/* info, not warning: search still runs at 1–2 chars, so this
          is an FYI rather than a problem. */}
      {query.trim().length > 0 && query.trim().length < 3 && (
        <div className="rounded-lg border border-alert-info-border bg-alert-info p-3 text-sm text-alert-info-foreground">
          {t('search.minCharsHint')}
        </div>
      )}

      {query === '' && recentPages.length > 0 && (
        <div className="recent-pages">
          {/* label the list via its heading so screen readers announce
              it as a named "Recent" group distinct from the results listbox. */}
          <h3
            id="search-recent-heading"
            className="text-sm font-medium text-muted-foreground px-3 py-2"
          >
            {t('search.recentTitle')}
          </h3>
          <ul aria-labelledby="search-recent-heading" className="space-y-1 list-none m-0 p-0">
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

      {/*  Phase 3b — status region lifted into `SearchStatusRegion`. */}
      <SearchStatusRegion
        searched={searched}
        searchLoading={searchLoading}
        error={error}
        // Let the status region suppress the generic "Search failed"
        // announcement when the failure is an invalid regex (the header alert
        // already announces the specific message).
        regexError={regexError}
        cleared={cleared}
        resultCount={results.length}
      />

      {searched && !searchLoading && results.length === 0 && !error && !aliasMatch && (
        <EmptyState
          icon={Search}
          message={t('search.noResultsHeadline')}
          description={t('search.noResultsFound')}
          // #1103 — when filter chips over-constrain to zero, offer a one-click
          // recovery instead of forcing a scroll back up to the chip row. No
          // active filters → no action (behavior identical to before).
          {...(ast.filters.length > 0
            ? {
                action: (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 mx-auto flex items-center gap-1"
                    onClick={handleClearAllFilters}
                    data-testid="search-no-results-clear-filters"
                  >
                    <FilterX className="h-4 w-4" />
                    {t('search.clearFilters')}
                  </Button>
                ),
              }
            : {})}
        />
      )}

      {/* a generic (non-regex) failure previously left the panel blank.
          Regex errors already render inline in the header (`regexError`);
          everything else gets a visible error state. */}
      {searched && !searchLoading && error && !regexError && (
        <div
          role="alert"
          data-testid="search-error-state"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p className="font-medium">{t('search.errorTitle')}</p>
          <p className="text-destructive/90">{t('search.errorBody')}</p>
        </div>
      )}

      {/* the 5000-item ceiling was hit silently; tell the user. */}
      {capped && (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level notice card (border/padding/rounded); <output> is inline-level and would break the boxed layout
          role="status"
          data-testid="search-capped-notice"
          className="rounded-lg border border-alert-warning-border bg-alert-warning p-3 text-sm text-alert-warning-foreground"
        >
          {t('search.cappedNotice')}
        </div>
      )}

      {aliasMatch && (
        // Expose the alias-match card as a labelled region so it is
        // announced distinctly from the results listbox (it sits outside the
        // roving-listbox model by design).
        <section data-testid="alias-match" aria-label={t('search.aliasMatchRegion')}>
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
        </section>
      )}

      {/*  Phase 1 — page-grouped result tree. The summary count sits
          above the first group (rendered inside `SearchResultGroups`).
          Per-group listboxes preserve the existing `useListKeyboardNavigation`
          roving model. */}
      <SearchResultGroups
        groups={groups}
        flatRows={visibleRows}
        focusedIndex={focusedIndex}
        expandedGroups={expandedGroups}
        onToggleGroup={handleToggleGroup}
        onResultClick={handleResultClick}
        // Phase 1 — passing a no-op tells `CollapsibleGroupList` to
        // render the page title via `<PageLink>` (its own click navigates
        // through `useTabsStore.navigateToPage`). The callback signature is
        // preserved for future hooks; today it defers to `PageLink`'s built-in
        // handler so click + Enter parity is free.
        onPageTitleClick={() => {
          /* navigation handled by `PageLink` */
        }}
        loadingResultId={loadingResultId}
        onKeyDown={handleListKeyDown}
      />

      <LoadMoreButton
        hasMore={hasMore}
        loading={searchLoading}
        onLoadMore={loadMore}
        className="search-load-more"
      />

      <SearchHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  )
}
