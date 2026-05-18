/**
 * SearchPalette — Cmd/Ctrl+K quick-navigation palette (PEND-51).
 *
 * The second search surface, coexisting with `SearchPanel` (find-in-
 * files). Two surfaces, two jobs: this palette is **navigation-first**
 * (8 page-groups × 2 matches, no filters, no toggles, no pagination),
 * `SearchPanel` is **systematic-first** (every PEND-50/54/55 affordance).
 *
 * Pragmatic departures from the plan (documented; behaviour matches the
 * plan's locked-in design):
 *
 *  - The plan describes a single new Tauri command,
 *    `search_blocks_partitioned`, returning `{ pages, blocks }` in one
 *    round-trip. PEND-51 ships **two parallel `searchBlocks` calls**
 *    instead, per the explicit task-card instruction. The backend cost
 *    is acceptable (the cap=8 page-only query is cheap, the cap=40
 *    blocks query is the same SQL pre-PEND-51 frontends fire today)
 *    and the FE merge logic is identical.
 *  - Fuzzy rescorer is hand-rolled Jaro-Winkler (`@/lib/jaro-winkler`)
 *    — the plan called for `match-sorter` (already in package.json) or
 *    a hand-rolled scorer; the task-card narrowed to JW/Levenshtein
 *    "in under 50 LOC". JW ships in 40 LOC and gives the prefix-boost
 *    behaviour the palette UX wants.
 *
 * The `[[page]]` autocomplete mode is **scoped to the palette only**
 * per the plan — PEND-54's deferred caret popover is intentionally not
 * touched (decision in the task card).
 *
 * Accessibility:
 *
 *  - The dialog primitive (`Dialog` / `Sheet` via `useDialogOrSheet`)
 *    ships `role="dialog"` + focus trap + Escape-to-close out of the
 *    box.
 *  - The input owns the active descendant via `aria-activedescendant`,
 *    and the result rows are `role="option"` inside a `role="listbox"`
 *    matching the PEND-50 a11y model. Arrow keys move the roving focus
 *    through the **flattened** visible result list; Enter activates
 *    the focused row.
 *
 * No `dangerouslySetInnerHTML` anywhere — `SearchResultBlockRow`
 * (reused from PEND-50) parses the FTS snippet markers into React
 * nodes.
 */

import { Search } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchResultBlockRow } from '@/components/search/SearchResultBlockRow'
import { CardButton } from '@/components/ui/card-button'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { jaroWinkler } from '@/lib/jaro-winkler'
import { logger } from '@/lib/logger'
import { addRecentPage, getRecentPages, type RecentPage } from '@/lib/recent-pages'
import type { SearchBlockRow } from '@/lib/tauri'
import { paginationLimit, searchBlocks } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useSearchPaletteStore } from '@/stores/useSearchPaletteStore'

/** Debounce window — palette UX is type-ahead; plan locks ~80 ms. */
const PALETTE_DEBOUNCE_MS = 80

/** Cap: page-groups rendered before "see more" escalation. */
const MAX_PAGE_GROUPS = 8
/** Cap: matches surfaced per group before the "+N more" pill. */
const MAX_MATCHES_PER_GROUP = 2
/** Backend cap for the page-only query (matches the plan's `pageLimit`). */
const PAGE_QUERY_LIMIT = 8
/** Backend cap for the unrestricted blocks query (matches `blockLimit`). */
const BLOCK_QUERY_LIMIT = 40

/**
 * Merged palette group: a page header + ≤ N block hits + a surplus
 * count. Distinct from PEND-50's `SearchResultGroup` because the
 * palette flattens differently (it caps both group count and per-group
 * row count for navigation UX).
 */
interface PaletteGroup {
  pageId: string
  pageTitle: string
  /** True when the page itself (`block_type = 'page'`) matched. */
  hasPageNameMatch: boolean
  /** Block hits already capped to `MAX_MATCHES_PER_GROUP`. */
  matches: SearchBlockRow[]
  /** Number of matches dropped by the per-group cap. */
  surplus: number
  /** Blended FTS+fuzzy score used for the 4-band ordering. */
  score: number
}

/** True when the input is in `[[page]]` autocomplete mode. */
function isPageLinkMode(input: string): boolean {
  return input.startsWith('[[') && input.length > 2
}

/** Extract the page-title query inside `[[…` — never returns the leading `[[`. */
function pageLinkQuery(input: string): string {
  // Strip the trailing `]]` if the user typed it (Notion's UX); else
  // just the leading `[[`.
  const stripped = input.replace(/\]\]\s*$/, '')
  return stripped.slice(2)
}

/**
 * Insert a `[[Page Title]]` link into the previously focused element,
 * if any. For `<input>` / `<textarea>` this uses native setRange APIs;
 * for `contenteditable` elements (the block editor's primary surface)
 * it falls back to `document.execCommand('insertText')` — the same
 * approach used by SlashCommand insertion in `slash-commands.ts`.
 *
 * No-op when the target is missing or detached.
 */
function insertPageLinkInto(target: HTMLElement | null, pageTitle: string): boolean {
  if (target == null || !document.body.contains(target)) return false
  const text = `[[${pageTitle}]]`
  target.focus()

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    const before = target.value.slice(0, start)
    const after = target.value.slice(end)
    target.value = `${before}${text}${after}`
    const caret = start + text.length
    target.setSelectionRange(caret, caret)
    // Fire a synthetic input event so React-controlled inputs see the
    // change (React swallows direct .value writes otherwise).
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  if (target.isContentEditable) {
    // `document.execCommand('insertText')` is the canonical way to
    // insert into `contenteditable` while preserving the editor's
    // undo/redo history stack — Range/Selection manipulation does
    // not. Matches the slash-command insertion path. Although
    // formally deprecated, every modern browser still supports it
    // and there is no spec'd replacement that hits the same history
    // stack semantics.
    try {
      document.execCommand('insertText', false, text)
      return true
    } catch (err) {
      logger.warn('SearchPalette', 'failed to insert page link', { pageTitle }, err)
      return false
    }
  }
  return false
}

/**
 * Public component. Mounts nothing when the store flag is closed; the
 * lazy boundary in `App.tsx` is the rendering gate.
 */
export function SearchPalette(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useSearchPaletteStore((s) => s.open)
  const closeStore = useSearchPaletteStore((s) => s.close)
  const setQueryStore = useSearchPaletteStore((s) => s.setQuery)
  const queryStore = useSearchPaletteStore((s) => s.query)
  const setPendingViewQuery = useSearchPaletteStore((s) => s.setPendingViewQuery)
  const previousFocusedElement = useSearchPaletteStore((s) => s.previousFocusedElement)

  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Title } = parts

  if (!open) return null

  return (
    <Root open={open} onOpenChange={(o: boolean) => (o ? null : closeStore())}>
      <Content
        className={cn(
          // Wider than the default `sm:max-w-lg` so 8 page-groups fit
          // comfortably without horizontal scrolling. Heights cap at
          // `80dvh` so the dialog never grows past the viewport.
          !parts.isMobile && 'sm:max-w-2xl max-h-[80dvh] flex flex-col',
        )}
        // Stop the dialog from auto-focusing its close button on open;
        // we want focus on the input.
        onOpenAutoFocus={(e: Event) => e.preventDefault()}
        data-testid="search-palette"
        role="dialog"
        aria-label={t('palette.dialogLabel')}
      >
        <Title className="sr-only">{t('palette.dialogTitle')}</Title>
        <PaletteBody
          onClose={closeStore}
          onEscalate={(q: string) => {
            setPendingViewQuery(q)
            closeStore()
            useNavigationStore.getState().setView('search')
          }}
          query={queryStore}
          setQuery={setQueryStore}
          previousFocusedElement={previousFocusedElement}
        />
      </Content>
    </Root>
  )
}

/**
 * Inner body of the palette — split out so the dialog/sheet shell can
 * stay slim and the body can short-circuit when `open=false` without
 * mounting any of the data hooks.
 */
function PaletteBody({
  onClose,
  onEscalate,
  query,
  setQuery,
  previousFocusedElement,
}: {
  onClose: () => void
  onEscalate: (query: string) => void
  query: string
  setQuery: (q: string) => void
  previousFocusedElement: HTMLElement | null
}): React.ReactElement {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const openInNewTab = useTabsStore((s) => s.openInNewTab)

  // Auto-focus on mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced query mirror — the IPC fires off this. 80ms per the plan.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value)
  }, PALETTE_DEBOUNCE_MS)

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)
    debounced.cancel()
    if (value.trim().length === 0) {
      setDebouncedQuery('')
      return
    }
    debounced.schedule(value.trim())
  }

  // Stale-response generation counter (plan §"Stale-response guard").
  // Mirrors `hooks/usePaginatedQuery.ts` requestIdRef.
  const generationRef = useRef(0)
  const [pages, setPages] = useState<SearchBlockRow[]>([])
  const [blocks, setBlocks] = useState<SearchBlockRow[]>([])
  const [, setLoading] = useState(false)

  // `[[page]]` autocomplete mode — only the pages query fires.
  const linkMode = isPageLinkMode(query)
  const linkQuery = useMemo(() => (linkMode ? pageLinkQuery(query).trim() : ''), [linkMode, query])
  const effectiveQuery = linkMode ? linkQuery : debouncedQuery

  // Fire the two parallel queries on every effective query change.
  useEffect(() => {
    if (!spaceIsReady) return
    if (effectiveQuery.length === 0) {
      setPages([])
      setBlocks([])
      return
    }
    generationRef.current += 1
    const gen = generationRef.current
    setLoading(true)

    const spaceId = currentSpaceId ?? ''
    // Two parallel capped queries — the task explicitly specifies this
    // shape. The plan's `search_blocks_partitioned` single-roundtrip
    // optimisation is documented but deferred (see header).
    const pagesPromise = searchBlocks({
      query: effectiveQuery,
      blockTypeFilter: 'page',
      limit: paginationLimit(PAGE_QUERY_LIMIT),
      spaceId,
    })
    const blocksPromise = linkMode
      ? // `[[page]]` mode skips the blocks query (plan §"`[[page]]`
        // autocomplete trigger" — "skip the blocks query").
        Promise.resolve({ items: [], next_cursor: null, has_more: false, total_count: null })
      : searchBlocks({
          query: effectiveQuery,
          limit: paginationLimit(BLOCK_QUERY_LIMIT),
          spaceId,
        })

    Promise.all([pagesPromise, blocksPromise])
      .then(([pagesResp, blocksResp]) => {
        if (gen !== generationRef.current) {
          // Stale response — newer keystroke superseded this one. Drop.
          return
        }
        setPages(pagesResp.items)
        setBlocks(blocksResp.items)
        setLoading(false)
      })
      .catch((err) => {
        if (gen !== generationRef.current) return
        logger.warn('SearchPalette', 'parallel query failed', { query: effectiveQuery }, err)
        setPages([])
        setBlocks([])
        setLoading(false)
      })
  }, [effectiveQuery, linkMode, spaceIsReady, currentSpaceId])

  // Merge → group → blended FTS+fuzzy ranking → cap.
  const groups = useMemo(
    () => mergeAndRankGroups(pages, blocks, effectiveQuery),
    [pages, blocks, effectiveQuery],
  )

  // Visible flattened rows: in normal mode the page-header is row #N
  // and its matches are rows #N+1..N+k; in `[[page]]` mode only page
  // headers are surfaced.
  const flatRows = useMemo(() => flattenForKeyboardNav(groups, linkMode), [groups, linkMode])

  // Recent pages — empty-state list when no query.
  const [recents, setRecents] = useState<RecentPage[]>([])
  useEffect(() => {
    setRecents(getRecentPages())
  }, [])

  // Roving focus state.
  const [focusedIndex, setFocusedIndex] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger, not a body-read dep — we intentionally reset on every keystroke so the user always lands on the first row.
  useEffect(() => {
    // Reset on query change so the user always lands on the first row.
    setFocusedIndex(0)
  }, [query])

  function handleNavigateToRow(row: PaletteFlatRow, newTab: boolean): void {
    if (linkMode) {
      // `[[page]]` mode — Enter inserts the page link into the
      // previously focused block and closes the palette. Only the
      // page-header rows carry a page title in link mode; the surplus
      // pill never appears in link mode (block matches are not
      // surfaced).
      const title = row.kind === 'page-header' ? row.pageTitle : (row.pageTitle ?? 'Untitled')
      const ok = insertPageLinkInto(previousFocusedElement, title)
      if (!ok) {
        logger.warn('SearchPalette', 'no previously-focused target for [[page]] insert')
      }
      onClose()
      return
    }
    if (row.kind === 'page-header') {
      addRecentPage(row.pageId, row.pageTitle)
      if (newTab) {
        openInNewTab(row.pageId, row.pageTitle)
      } else {
        navigateToPage(row.pageId, row.pageTitle)
      }
      onClose()
      return
    }
    if (row.kind === 'more-pill') {
      // Surplus pill — escalate to the find-in-files view with the
      // current query pre-filled so the user lands on the deeper
      // result set for this page.
      onEscalate(query.trim())
      return
    }
    // Block hit row.
    if (row.pageId != null) {
      const title = row.pageTitle ?? 'Untitled'
      addRecentPage(row.pageId, title)
      if (newTab) {
        openInNewTab(row.pageId, title)
      } else {
        navigateToPage(row.pageId, title, row.blockId)
      }
      onClose()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((i) => Math.min(i + 1, flatRows.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      const row = flatRows[focusedIndex]
      if (row != null) {
        e.preventDefault()
        handleNavigateToRow(row, e.metaKey || e.ctrlKey)
      }
      return
    }
  }

  function handleRecentClick(page: RecentPage) {
    addRecentPage(page.id, page.title)
    navigateToPage(page.id, page.title)
    onClose()
  }

  const showRecents = query.length === 0 && recents.length > 0
  const showResults = flatRows.length > 0
  const showNoLinkMatch = linkMode && flatRows.length === 0 && linkQuery.length > 0

  return (
    <div className="search-palette flex flex-col gap-3">
      <div className="relative flex items-center">
        <Search className="absolute left-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.inputLabel')}
          aria-controls="palette-results"
          aria-activedescendant={showResults ? `palette-row-${focusedIndex}` : undefined}
          className="w-full rounded-md border border-input bg-background py-2 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          data-testid="search-palette-input"
        />
      </div>
      {linkMode && (
        <div
          className="rounded-md border border-alert-info-border bg-alert-info px-3 py-1.5 text-xs text-alert-info-foreground"
          data-testid="palette-link-mode-badge"
        >
          {t('palette.linkModeBadge')}
        </div>
      )}
      <div
        // Scrollable result region. `max-h-[60dvh]` plus the dialog's
        // overall `max-h-[80dvh]` cap keeps headers + footer visible.
        className="max-h-[60dvh] overflow-y-auto -mx-1 px-1"
        id="palette-results"
        role="listbox"
        aria-label={t('palette.resultsLabel')}
      >
        {showRecents && (
          <div className="recent-pages mt-1">
            <h3 className="text-xs font-medium text-muted-foreground px-2 py-1">
              {t('palette.recentTitle')}
            </h3>
            <ul className="list-none p-0 m-0 space-y-1">
              {recents.map((page) => (
                <li key={page.id}>
                  <CardButton className="text-sm" onClick={() => handleRecentClick(page)}>
                    {page.title}
                  </CardButton>
                </li>
              ))}
            </ul>
          </div>
        )}
        {showResults && (
          <PaletteGroupList
            groups={groups}
            flatRows={flatRows}
            focusedIndex={focusedIndex}
            onRowClick={(row, newTab) => handleNavigateToRow(row, newTab)}
            t={t}
            linkMode={linkMode}
          />
        )}
        {showNoLinkMatch && (
          <div
            className="px-3 py-3 text-sm text-muted-foreground"
            data-testid="palette-no-link-match"
          >
            {t('palette.noPageMatch', { query: linkQuery })}
          </div>
        )}
      </div>
      {!linkMode && query.trim().length > 0 && (
        <button
          type="button"
          className="self-stretch rounded-md border border-input bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
          onClick={() => onEscalate(query.trim())}
          data-testid="palette-escalation-footer"
        >
          {t('palette.escalateLabel')}
        </button>
      )}
    </div>
  )
}

/** Row-level data drives both rendering and keyboard navigation. */
type PaletteFlatRow =
  | {
      kind: 'page-header'
      pageId: string
      pageTitle: string
      groupIndex: number
    }
  | {
      kind: 'block-hit'
      blockId: string
      pageId: string | null
      pageTitle: string | null
      title: string | null
      row: SearchBlockRow
      groupIndex: number
    }
  | {
      kind: 'more-pill'
      pageId: string
      pageTitle: string
      surplus: number
      groupIndex: number
    }

function flattenForKeyboardNav(groups: PaletteGroup[], linkMode: boolean): PaletteFlatRow[] {
  const out: PaletteFlatRow[] = []
  groups.forEach((g, idx) => {
    out.push({
      kind: 'page-header',
      pageId: g.pageId,
      pageTitle: g.pageTitle,
      groupIndex: idx,
    })
    if (linkMode) return
    for (const block of g.matches) {
      out.push({
        kind: 'block-hit',
        blockId: block.id,
        pageId: block.page_id,
        pageTitle: g.pageTitle,
        title: block.content,
        row: block,
        groupIndex: idx,
      })
    }
    if (g.surplus > 0) {
      out.push({
        kind: 'more-pill',
        pageId: g.pageId,
        pageTitle: g.pageTitle,
        surplus: g.surplus,
        groupIndex: idx,
      })
    }
  })
  return out
}

/**
 * Renders the merged groups. Each row is `role="option"` and its
 * `id` is `palette-row-<index>` so the input's
 * `aria-activedescendant` can target it.
 */
function PaletteGroupList({
  groups,
  flatRows,
  focusedIndex,
  onRowClick,
  t,
  linkMode,
}: {
  groups: PaletteGroup[]
  flatRows: PaletteFlatRow[]
  focusedIndex: number
  onRowClick: (row: PaletteFlatRow, newTab: boolean) => void
  t: ReturnType<typeof useTranslation>['t']
  linkMode: boolean
}): React.ReactElement {
  // Quick lookup: row → flat index. Used for `id` and focused-row
  // detection during rendering.
  const indexByRow = useMemo(() => {
    const m = new Map<PaletteFlatRow, number>()
    for (let i = 0; i < flatRows.length; i++) {
      const r = flatRows[i]
      if (r != null) m.set(r, i)
    }
    return m
  }, [flatRows])

  return (
    <ul className="list-none p-0 m-0 space-y-1" data-testid="palette-group-list">
      {groups.map((group, groupIdx) => {
        const headerRow = flatRows.find(
          (r) => r.kind === 'page-header' && r.groupIndex === groupIdx,
        )
        const headerIndex = headerRow != null ? indexByRow.get(headerRow) : undefined
        return (
          <li
            key={group.pageId}
            className="palette-group"
            data-testid={`palette-group-${group.pageId}`}
          >
            <button
              type="button"
              id={headerIndex != null ? `palette-row-${headerIndex}` : undefined}
              onClick={(e) => {
                if (headerRow) onRowClick(headerRow, e.metaKey || e.ctrlKey)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-left hover:bg-accent/50',
                headerIndex === focusedIndex && 'bg-accent',
              )}
              role="option"
              aria-selected={headerIndex === focusedIndex}
              data-testid={`palette-page-header-${group.pageId}`}
            >
              <span className="text-base" aria-hidden="true">
                📄
              </span>
              <span className="flex-1 truncate">{group.pageTitle}</span>
              {group.hasPageNameMatch && (
                <span className="text-xs text-muted-foreground">{t('palette.titleMatchTag')}</span>
              )}
            </button>
            {!linkMode && group.matches.length > 0 && (
              <ul
                className="ml-7 mt-1 space-y-1 list-none p-0"
                aria-label={t('palette.groupMatchesLabel', { pageTitle: group.pageTitle })}
              >
                {group.matches.map((block) => {
                  const row = flatRows.find((r) => r.kind === 'block-hit' && r.blockId === block.id)
                  const idx = row != null ? indexByRow.get(row) : undefined
                  return (
                    <SearchResultBlockRow
                      key={block.id}
                      row={block}
                      // `id` is required on `SearchResultBlockRow` —
                      // fall back to the block id so the row is still
                      // queryable, even if it's not the
                      // `aria-activedescendant` target this render.
                      id={idx != null ? `palette-row-${idx}` : `palette-row-block-${block.id}`}
                      isFocused={idx === focusedIndex}
                      onClick={() => {
                        if (row) onRowClick(row, false)
                      }}
                    />
                  )
                })}
                {group.surplus > 0 && (
                  <PaletteSurplusPill
                    group={group}
                    flatRows={flatRows}
                    indexByRow={indexByRow}
                    focusedIndex={focusedIndex}
                    onRowClick={onRowClick}
                    t={t}
                  />
                )}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function PaletteSurplusPill({
  group,
  flatRows,
  indexByRow,
  focusedIndex,
  onRowClick,
  t,
}: {
  group: PaletteGroup
  flatRows: PaletteFlatRow[]
  indexByRow: Map<PaletteFlatRow, number>
  focusedIndex: number
  onRowClick: (row: PaletteFlatRow, newTab: boolean) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const pillRow = flatRows.find((r) => r.kind === 'more-pill' && r.pageId === group.pageId)
  const idx = pillRow != null ? indexByRow.get(pillRow) : undefined
  return (
    <li
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: per the PEND-50 a11y model used across SearchResultBlockRow — `<li role="option">` is the canonical listbox option pattern.
      role="option"
      id={idx != null ? `palette-row-${idx}` : undefined}
      aria-selected={idx === focusedIndex}
      tabIndex={-1}
      onClick={(e) => {
        if (pillRow) onRowClick(pillRow, e.metaKey || e.ctrlKey)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (pillRow) onRowClick(pillRow, e.metaKey || e.ctrlKey)
        }
      }}
      className={cn(
        'list-none flex items-center gap-2 rounded-md px-3 py-1 text-xs text-muted-foreground cursor-pointer hover:bg-accent/30',
        idx === focusedIndex && 'bg-accent',
      )}
      data-testid={`palette-more-pill-${group.pageId}`}
    >
      {t('palette.moreInThisPage', { count: group.surplus })}
    </li>
  )
}

/**
 * Merge the two parallel query result sets into capped palette groups.
 *
 * - Each `pages` row seeds a group (page-name match band).
 * - Each `blocks` row appends to the existing group keyed by `page_id`,
 *   or seeds a content-only group when no page row exists for it.
 * - Groups are ordered by **4-band rule** (plan §"Result grouping"):
 *   exact title → prefix title → contains-in-title → content-only,
 *   tiebroken by the FTS-band + fuzzy blend score.
 * - Group count capped at `MAX_PAGE_GROUPS` (8).
 * - Matches per group capped at `MAX_MATCHES_PER_GROUP` (2); surplus
 *   surfaces as a "+N more" pill row.
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
      // Prefer the page-row title (more reliable) when both are
      // present — the blocks query may not carry a page title.
      group.pageTitle = title
    }
    return group
  }

  // Seed from page-row results — these are the strongest matches and
  // anchor the group titles.
  for (const row of pages) {
    const title = row.content ?? 'Untitled'
    ensureGroup(row.id, title, true)
  }
  // Append block-row results — content matches within each page.
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

  // Score each group via the 4-band ordering + JW fuzzy blend.
  for (const id of order) {
    const g = groups.get(id)
    if (g == null) continue
    g.score = scoreGroup(g, lower)
  }

  // Sort by descending score, then by insertion order for stability.
  const orderedIds = [...order].sort((a, b) => {
    const ga = groups.get(a)
    const gb = groups.get(b)
    if (ga == null || gb == null) return 0
    if (ga.score !== gb.score) return gb.score - ga.score
    return order.indexOf(a) - order.indexOf(b)
  })

  // Cap to the top-N page-groups.
  const out: PaletteGroup[] = []
  for (let i = 0; i < orderedIds.length && i < MAX_PAGE_GROUPS; i++) {
    const id = orderedIds[i]
    if (id == null) continue
    const g = groups.get(id)
    if (g != null) out.push(g)
  }
  return out
}

/**
 * 4-band ordering rule encoded as a base score, with a `+ 0.3 * JW`
 * additive rescore on top. The base score's bands are spaced wide
 * enough (1.0 per band) that the fuzzy boost only reorders within a
 * band — it never promotes a content-only hit above an exact-title
 * one.
 *
 * Bands:
 *  - Exact title match: base 4
 *  - Prefix title match: base 3
 *  - Contains-in-title: base 2
 *  - Content-only: base 1
 *
 * Plus a `0.3 * JW(title, query)` fuzzy add — `match-sorter`'s rank
 * groups would be 1:1 with this (per the plan) but we hand-roll for
 * the under-50-LOC constraint.
 */
function scoreGroup(group: PaletteGroup, lowerQuery: string): number {
  if (lowerQuery.length === 0) return 0
  const title = group.pageTitle.toLowerCase()
  let band: number
  if (title === lowerQuery) band = 4
  else if (title.startsWith(lowerQuery)) band = 3
  else if (title.includes(lowerQuery)) band = 2
  else band = 1
  // 0.7 weight on band-aware base, 0.3 weight on fuzzy similarity —
  // mirrors the plan's blend. The band itself encodes the FTS "rank"
  // half (positionally), and JW supplies the typo-tolerance rescore.
  return 0.7 * band + 0.3 * jaroWinkler(group.pageTitle, lowerQuery)
}
