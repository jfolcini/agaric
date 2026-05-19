/**
 * CommandPalette — Cmd/Ctrl+K command surface (PEND-61).
 *
 * Successor to PEND-51's `SearchPalette`. Same UX contract for the
 * `'search'` mode (8 page-groups x 2 matches, fuzzy rescoring, [[page]]
 * autocomplete, escalation footer, recent-pages empty state) plus a new
 * `'commands'` mode reachable via the `>` input prefix (matching
 * VSCode's Cmd+P convention).
 *
 * Wire-level upgrade: the two parallel `searchBlocks` calls per
 * keystroke that PEND-51 fired are collapsed into one
 * `searchBlocksPartitioned` round-trip (PEND-61 Phase 1).
 *
 * Built atop the cmdk wrapper at `@/components/ui/command`:
 *
 *  - `<Command shouldFilter={false}>` — the visible item list IS the
 *    answer (debounced FTS + fuzzy rescore already filtered upstream).
 *  - cmdk owns Arrow / Enter keyboard nav + `aria-activedescendant`,
 *    replacing the hand-rolled roving-focus model in PEND-51.
 *  - `<CommandItem value={...}>` carries the unique selection id;
 *    `onSelect` fires on Enter or click. Modifier-key new-tab is
 *    detected via the same listener (cmdk fires the click event
 *    through, preserving `metaKey`/`ctrlKey`).
 *
 * Mobile UX (segment-control mode switch, search-scope toggle) is
 * deferred to PEND-62; this file ships the desktop-first surface.
 */

import {
  ArrowLeftRight,
  Clock,
  FileSearch,
  FileText,
  type LucideIcon,
  Settings as SettingsIcon,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SnippetHighlight } from '@/components/search/SnippetHighlight'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { jaroWinkler } from '@/lib/jaro-winkler'
import { logger } from '@/lib/logger'
import { addRecentPage, getRecentPages, type RecentPage } from '@/lib/recent-pages'
import type { SearchBlockRow } from '@/lib/tauri'
import { paginationLimit, searchBlocks, searchBlocksPartitioned } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { type PaletteMode, useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

/** Debounce window — palette UX is type-ahead; matches PEND-51's 80 ms. */
const PALETTE_DEBOUNCE_MS = 80

/** Cap: page-groups rendered before the "see more" escalation. */
const MAX_PAGE_GROUPS = 8
/** Cap: matches surfaced per group before the "+N more" pill. */
const MAX_MATCHES_PER_GROUP = 2
/** Backend cap for the page partition. */
const PAGE_QUERY_LIMIT = 8
/** Backend cap for the unrestricted blocks partition. */
const BLOCK_QUERY_LIMIT = 40

/**
 * Merged palette group: a page header + ≤ N block hits + a surplus
 * count. Migrated verbatim from PEND-51 so the visual contract stays
 * stable across the rewrite.
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

/** True when the input is in commands mode (leading `>` prefix). */
function isCommandsModeInput(input: string): boolean {
  return input.startsWith('>')
}

/** Extract the commands-mode filter query after the `>` prefix. */
function commandsModeQuery(input: string): string {
  return input.slice(1).trimStart()
}

/**
 * Insert a `[[Page Title]]` link into the previously focused element,
 * if any. For `<input>` / `<textarea>` this uses native setRange APIs;
 * for `contenteditable` elements (the block editor's primary surface)
 * it falls back to `document.execCommand('insertText')` — the same
 * approach used by SlashCommand insertion in `slash-commands.ts` and
 * preserved here so undo/redo stacks stay intact.
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
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  if (target.isContentEditable) {
    try {
      document.execCommand('insertText', false, text)
      return true
    } catch (err) {
      logger.warn('CommandPalette', 'failed to insert page link', { pageTitle }, err)
      return false
    }
  }
  return false
}

/**
 * Public component. Mounts nothing when the store flag is closed; the
 * lazy boundary in `App.tsx` is the rendering gate.
 */
export function CommandPalette(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useCommandPaletteStore((s) => s.open)
  const closeStore = useCommandPaletteStore((s) => s.close)

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
          !parts.isMobile && 'sm:max-w-2xl max-h-[80dvh] flex flex-col p-0',
        )}
        // Stop the dialog from auto-focusing its close button on open;
        // we want focus on the input.
        onOpenAutoFocus={(e: Event) => e.preventDefault()}
        data-testid="command-palette"
        role="dialog"
        aria-label={t('palette.dialogLabel')}
      >
        <Title className="sr-only">{t('palette.dialogTitle')}</Title>
        <PaletteBody onClose={closeStore} />
      </Content>
    </Root>
  )
}

/**
 * Inner body — split out so the dialog shell stays slim and the body
 * can short-circuit when `open=false` without mounting any of the data
 * hooks. cmdk's `<Command>` lives at this level so its lifecycle is
 * fully scoped to the open palette.
 */
function PaletteBody({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const openInNewTab = useTabsStore((s) => s.openInNewTab)

  const query = useCommandPaletteStore((s) => s.query)
  const setQueryStore = useCommandPaletteStore((s) => s.setQuery)
  const mode = useCommandPaletteStore((s) => s.mode)
  const setMode = useCommandPaletteStore((s) => s.setMode)
  const setPendingViewQuery = useCommandPaletteStore((s) => s.setPendingViewQuery)
  const previousFocusedElement = useCommandPaletteStore((s) => s.previousFocusedElement)

  // ── Mode router (one-way, prefix-as-entry-shortcut) ─────────────
  // PEND-61 CR — typing `>` at the start of an empty/whitespace
  // query enters commands mode AND strips the prefix from the
  // input (the chip in `ModeChipRow` is the visible mode indicator).
  // Once in commands mode, the user exits via Escape (close) or the
  // chip (toggle) — not by backspacing the input. This removes the
  // round-trip where the chip click had to fake-type a literal `'> '`
  // into the query.
  useEffect(() => {
    if (mode === 'search' && isCommandsModeInput(query.trimStart())) {
      setMode('commands')
      setQueryStore(commandsModeQuery(query))
    }
  }, [query, mode, setMode, setQueryStore])

  // Auto-focus on mount. cmdk's `<CommandInput>` is a controlled
  // primitive but doesn't auto-focus by default in our shell.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced query mirror — the IPC fires off this. 80ms per the plan.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value)
  }, PALETTE_DEBOUNCE_MS)

  function handleInputChange(value: string) {
    setQueryStore(value)
    debounced.cancel()
    const trimmed = value.trim()
    if (trimmed.length === 0 || isCommandsModeInput(trimmed)) {
      setDebouncedQuery('')
      return
    }
    debounced.schedule(trimmed)
  }

  // Stale-response generation counter — mirrors `usePaginatedQuery` /
  // PEND-51's same guard. Re-bumped on every keystroke; an in-flight
  // response from an earlier keystroke is dropped if its generation
  // doesn't match.
  const generationRef = useRef(0)
  const [pages, setPages] = useState<SearchBlockRow[]>([])
  const [blocks, setBlocks] = useState<SearchBlockRow[]>([])
  // PEND-61 CR — `loading` gates the escalation footer + the
  // no-results empty copy so neither mounts during the brief window
  // between debounce-settle and IPC-resolve. Without this, the
  // escalation footer can register with cmdk before the search
  // results do, and cmdk's `selectFirstItem` snaps highlight onto
  // the footer (stealing Enter from the page header).
  const [loading, setLoading] = useState(false)

  // `[[page]]` autocomplete sub-mode — only active inside `'search'` mode.
  const linkMode = mode === 'search' && isPageLinkMode(query)
  const linkQuery = useMemo(() => (linkMode ? pageLinkQuery(query).trim() : ''), [linkMode, query])
  const effectiveQuery = linkMode ? linkQuery : debouncedQuery

  // ── IPC ──────────────────────────────────────────────────────────
  // Non-linkMode: one `searchBlocksPartitioned` round-trip returns
  // both partitions ({ pages, blocks }) from a single FTS scan
  // (PEND-61 Phase 1, replaces PEND-51's two parallel calls).
  //
  // linkMode: PEND-61 CR — the partitioned IPC's combined fetch cap
  // (`page_limit + block_limit + 1`) can drown the page partition
  // when many higher-ranked content rows out-score the only matching
  // page. `[[page]]` autocomplete needs a page-only guarantee, so we
  // fire a dedicated `searchBlocks({ blockTypeFilter: 'page' })` for
  // that path — matches the PEND-51 design and restores the
  // "page-only, always" invariant.
  useEffect(() => {
    if (mode !== 'search') return
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

    const fetchPromise = linkMode
      ? searchBlocks({
          query: effectiveQuery,
          blockTypeFilter: 'page',
          limit: paginationLimit(PAGE_QUERY_LIMIT),
          spaceId,
        }).then((resp) => ({
          pages: { items: resp.items },
          blocks: { items: [] as SearchBlockRow[] },
        }))
      : searchBlocksPartitioned({
          query: effectiveQuery,
          pageLimit: PAGE_QUERY_LIMIT,
          blockLimit: BLOCK_QUERY_LIMIT,
          spaceId,
        }).then((resp) => ({
          pages: { items: resp.pages.items },
          blocks: { items: resp.blocks.items },
        }))

    fetchPromise
      .then(({ pages: p, blocks: b }) => {
        if (gen !== generationRef.current) return
        setPages(p.items)
        setBlocks(b.items)
        setLoading(false)
      })
      .catch((err) => {
        if (gen !== generationRef.current) return
        logger.warn(
          'CommandPalette',
          'search query failed',
          { query: effectiveQuery, linkMode },
          err,
        )
        setPages([])
        setBlocks([])
        setLoading(false)
      })
  }, [effectiveQuery, linkMode, mode, spaceIsReady, currentSpaceId])

  // Merge → group → blended FTS+fuzzy ranking → cap.
  const groups = useMemo(
    () => mergeAndRankGroups(pages, blocks, effectiveQuery),
    [pages, blocks, effectiveQuery],
  )

  // Recent pages — empty-state list when no query.
  const [recents, setRecents] = useState<RecentPage[]>([])
  useEffect(() => {
    setRecents(getRecentPages())
  }, [])

  function handleNavigateToPage(pageId: string, pageTitle: string, newTab: boolean): void {
    if (linkMode) {
      const ok = insertPageLinkInto(previousFocusedElement, pageTitle)
      if (ok) {
        onClose()
        return
      }
      // PEND-61 CR — cold-open `[[page]]` (no editor focus when
      // Cmd+K fired) used to silently close. Fall through to plain
      // page navigation so the user gets *something* from the
      // selection — matches the docstring promise in
      // `useCommandPaletteStore`.
      logger.info(
        'CommandPalette',
        'no previously-focused target for [[page]] insert; navigating to page',
      )
    }
    addRecentPage(pageId, pageTitle)
    if (newTab) {
      openInNewTab(pageId, pageTitle)
    } else {
      navigateToPage(pageId, pageTitle)
    }
    onClose()
  }

  function handleNavigateToBlock(
    blockId: string,
    pageId: string,
    pageTitle: string,
    newTab: boolean,
  ): void {
    addRecentPage(pageId, pageTitle)
    if (newTab) {
      openInNewTab(pageId, pageTitle)
    } else {
      navigateToPage(pageId, pageTitle, blockId)
    }
    onClose()
  }

  function escalate(q: string): void {
    setPendingViewQuery(q)
    onClose()
    useNavigationStore.getState().setView('search')
  }

  function handleRecentClick(page: RecentPage) {
    addRecentPage(page.id, page.title)
    navigateToPage(page.id, page.title)
    onClose()
  }

  // Cmd/Ctrl-click new-tab on a CommandItem. cmdk's `onSelect` doesn't
  // expose modifier keys, so the wrapper has to capture them. PEND-61
  // CR-2 rewires this from a fragile `mousedown` flag (which leaked
  // when the user dragged off-row before release) to:
  //
  //  - `onClickCapture` on the list: fires in the capture phase before
  //    cmdk's item-level `onClick → onSelect`, so the flag is set
  //    against the FINAL click target's modifiers (not the mousedown
  //    target's). Drag-away cases auto-resolve.
  //  - `onKeyDown` on the list: cmdk routes Enter via the cmdk-root
  //    `keyDown`; this listener fires first and snapshots the flag
  //    before cmdk dispatches `onSelect`.
  //  - `consumeNewTab()` always resets, so a missed `onSelect` (e.g.
  //    the user pressed Enter on a non-cmdk-item) can't poison the
  //    next click.
  const newTabRef = useRef(false)
  function handleListClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    newTabRef.current = e.metaKey || e.ctrlKey
  }
  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') {
      newTabRef.current = e.metaKey || e.ctrlKey
    } else if (e.key === 'Backspace') {
      // PEND-61 CR-2 — Backspace on an empty input in commands mode
      // returns to search mode (mirrors VSCode's Cmd+P ↔ Cmd+Shift+P
      // toggle). The chip stays the visible toggle for everyone else.
      if (mode === 'commands' && query.length === 0) {
        e.preventDefault()
        setMode('search')
      }
    }
  }
  function consumeNewTab(): boolean {
    const v = newTabRef.current
    newTabRef.current = false
    return v
  }

  // Empty / no-result detection for the search-mode placeholder.
  const showRecents = mode === 'search' && query.length === 0 && recents.length > 0
  const showNoLinkMatch = linkMode && groups.length === 0 && linkQuery.length > 0
  const trimmedQuery = query.trim()
  // PEND-61 CR — distinguish "welcome state" (cold open, no query, no
  // recents) from "no results for query" (user typed something, got
  // nothing). PEND-51 lumped both into one blank panel.
  const showWelcomeEmpty = mode === 'search' && query.length === 0 && !showRecents && !linkMode
  const showNoResults =
    mode === 'search' &&
    !linkMode &&
    !loading &&
    trimmedQuery.length > 0 &&
    groups.length === 0 &&
    debouncedQuery.length > 0
  // Escalation footer — search mode only, query non-empty, not link
  // mode. PEND-61 CR — moved INSIDE `<CommandList>` as a `<CommandItem>`
  // so the cmdk keyboard model (Arrow + Enter) can reach it. Gated on
  // `!loading && (groups.length > 0 || showNoResults)` so the footer
  // never mounts ahead of the search results during the debounce →
  // IPC window — without this guard cmdk's `selectFirstItem` picks
  // the escalation row as the initial selection (because it registers
  // before the IPC resolves), stealing Enter from the page-header.
  const showEscalationFooter =
    mode === 'search' &&
    !linkMode &&
    !loading &&
    trimmedQuery.length > 0 &&
    (groups.length > 0 || showNoResults)

  return (
    // shouldFilter={false} — debounced FTS + Rust-side ranking already
    // produced the visible list; cmdk's fuzzy rescore would double-
    // filter and re-order in ways that fight the page-group cap.
    <Command shouldFilter={false} loop className="search-palette flex flex-col">
      <ModeChipRow mode={mode} setMode={setMode} setQueryStore={setQueryStore} t={t} />
      <div className="relative">
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={handleInputChange}
          placeholder={
            mode === 'commands' ? t('palette.commandsPlaceholder') : t('palette.placeholder')
          }
          aria-label={t('palette.inputLabel')}
          data-testid="command-palette-input"
          onKeyDown={handleListKeyDown}
        />
        {/* PEND-61 CR-2 — visible loading affordance during the
            debounce → IPC window. The shimmer is purely decorative
            (`aria-hidden`); SR users get the assistive announcement
            via the sibling `palette-loading-status` `<div>`. Honours
            `motion-reduce` so the animation collapses to a static
            tint when the user has reduced-motion enabled. */}
        {loading && (
          <span
            aria-hidden="true"
            data-testid="palette-loading-shimmer"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden"
          >
            <span className="motion-safe:animate-pulse block h-full w-full bg-accent/70" />
          </span>
        )}
      </div>
      {/* SR-only loading status — announced politely during refetch.
          Outside the input wrapper so screen readers don't read the
          input twice. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="palette-loading-status"
      >
        {loading ? t('palette.searching') : ''}
      </div>
      {linkMode && (
        <div
          className="mx-3 mt-2 rounded-md border border-alert-info-border bg-alert-info px-3 py-1.5 text-xs text-alert-info-foreground"
          // role="status" + aria-live polite so screen readers announce
          // entering / leaving link mode (PEND-61 CR a11y review).
          role="status"
          aria-live="polite"
          data-testid="palette-link-mode-badge"
        >
          {t('palette.linkModeBadge')}
        </div>
      )}
      <CommandList
        className="max-h-[60dvh]"
        onClickCapture={handleListClickCapture}
        onKeyDown={handleListKeyDown}
      >
        {mode === 'commands' ? (
          <CommandsModeBody onEscalate={escalate} onClose={onClose} t={t} />
        ) : (
          <>
            {showRecents && (
              <CommandGroup heading={t('palette.recentTitle')} data-testid="palette-recents-group">
                {recents.map((page) => (
                  <CommandItem
                    key={page.id}
                    value={`recent:${page.id}`}
                    onSelect={() => handleRecentClick(page)}
                    data-testid={`palette-recent-${page.id}`}
                    className="gap-2"
                  >
                    {/* PEND-61 CR-2 — leading clock glyph signals
                        "history" so the recents list reads distinctly
                        from the result groups below. Notion / Linear
                        use the same pattern. */}
                    <Clock
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{page.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showWelcomeEmpty && (
              <CommandEmpty data-testid="palette-welcome-empty">
                {t('palette.welcomeEmpty')}
              </CommandEmpty>
            )}
            {showNoResults && (
              // PEND-61 CR — plain div (not <CommandEmpty>) because
              // CommandEmpty self-hides when any cmdk item is present
              // and the escalation footer below counts as one.
              <div
                className="px-3 py-3 text-sm text-muted-foreground"
                data-testid="palette-no-results"
                role="status"
              >
                {t('palette.noResults', { query: trimmedQuery })}
              </div>
            )}
            {showNoLinkMatch && (
              <div
                className="px-3 py-3 text-sm text-muted-foreground"
                data-testid="palette-no-link-match"
              >
                {t('palette.noPageMatch', { query: linkQuery })}
              </div>
            )}
            {groups.length > 0 && (
              <SearchModeGroups
                groups={groups}
                linkMode={linkMode}
                onNavigatePage={(pageId, pageTitle) =>
                  handleNavigateToPage(pageId, pageTitle, consumeNewTab())
                }
                onNavigateBlock={(blockId, pageId, pageTitle) =>
                  handleNavigateToBlock(blockId, pageId, pageTitle, consumeNewTab())
                }
                onEscalateToMore={() => escalate(query.trim())}
                t={t}
              />
            )}
            {showEscalationFooter && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__escalate__"
                    onSelect={() => escalate(trimmedQuery)}
                    data-testid="palette-escalation-footer"
                    className="text-muted-foreground"
                  >
                    {t('palette.escalateLabel')}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
      {mode === 'search' && !linkMode && <PaletteFooterHint t={t} />}
    </Command>
  )
}

/**
 * Mode-chip row — the visible affordance for switching modes. Renders
 * as a thin header strip above the input.
 *
 * PEND-61 CR — clicking the chip flips the store mode WITHOUT
 * writing to the input. The `>` input prefix remains a one-way entry
 * shortcut (handled by the mode router in `PaletteBody`); the chip is
 * the way back to search.
 */
function ModeChipRow({
  mode,
  setMode,
  setQueryStore,
  t,
}: {
  mode: PaletteMode
  setMode: (m: PaletteMode) => void
  setQueryStore: (q: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  function toggleMode() {
    if (mode === 'commands') {
      setMode('search')
    } else {
      setMode('commands')
    }
    // Clear the input on either direction so the new mode starts fresh
    // (e.g. switching from commands → search doesn't leave a stale
    // partial command name in the search box).
    setQueryStore('')
  }
  const label = mode === 'commands' ? t('palette.modeCommands') : t('palette.modeSearch')
  return (
    <div
      className="flex items-center justify-between border-b px-3 py-1.5 text-xs"
      data-testid="palette-mode-row"
    >
      <button
        type="button"
        onClick={toggleMode}
        className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground hover:bg-muted/60 focus-ring-visible"
        aria-label={t('palette.modeChipLabel', { mode: label })}
        data-testid="palette-mode-chip"
      >
        {/* PEND-61 CR-2 — `ArrowLeftRight` reads as a bidirectional
            toggle. `ChevronRight` previously implied a one-way
            drill-in, which is the wrong affordance signal. */}
        <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
        {label}
      </button>
      {/* PEND-61 CR — drop `aria-hidden` so SR users can discover the
          `>` prefix shortcut. The hint is short and informational, so
          it lives in the visible header rather than a tooltip. */}
      <span className="text-muted-foreground">{t('palette.modeHint')}</span>
    </div>
  )
}

/**
 * Footer hint — surfaces the modifier-key affordances (Enter / ⌘Enter
 * / Esc) as `<kbd>` chips so power users can scan the shortcuts
 * without reading prose. Hidden in link mode and commands mode
 * because the modifier-key vocabulary changes per mode.
 *
 * PEND-61 CR-2 — round-1 shipped this as a flat `text-[10px]` string;
 * `<kbd>`-rendered chord chips match Raycast / Linear and respect
 * the project's 11px typography floor.
 */
function PaletteFooterHint({
  t,
}: {
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <div
      className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="palette-footer-hint"
    >
      <span className="inline-flex items-center gap-1">
        <kbd className="rounded border border-border bg-muted/40 px-1 py-px font-mono text-[10px]">
          ↵
        </kbd>
        {t('palette.footerHintOpen')}
      </span>
      <span className="inline-flex items-center gap-1">
        <kbd className="rounded border border-border bg-muted/40 px-1 py-px font-mono text-[10px]">
          ⌘↵
        </kbd>
        {t('palette.footerHintNewTab')}
      </span>
      <span className="inline-flex items-center gap-1">
        <kbd className="rounded border border-border bg-muted/40 px-1 py-px font-mono text-[10px]">
          esc
        </kbd>
        {t('palette.footerHintClose')}
      </span>
    </div>
  )
}

/**
 * Search-mode body — renders the merged groups produced by
 * `mergeAndRankGroups`. cmdk owns the highlight state via its own
 * `value`-keyed selection; we forward the same `<CommandItem
 * value={...}>` ids and let cmdk wire up `aria-activedescendant`.
 */
function SearchModeGroups({
  groups,
  linkMode,
  onNavigatePage,
  onNavigateBlock,
  onEscalateToMore,
  t,
}: {
  groups: PaletteGroup[]
  linkMode: boolean
  onNavigatePage: (pageId: string, pageTitle: string) => void
  onNavigateBlock: (blockId: string, pageId: string, pageTitle: string) => void
  onEscalateToMore: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <>
      {groups.map((group) => (
        // PEND-61 CR — no `heading` prop. The page-header CommandItem
        // below IS the visible title; cmdk's muted group-heading would
        // double-render the page title in the same group.
        <CommandGroup key={group.pageId} data-testid={`palette-group-${group.pageId}`}>
          <CommandItem
            value={`page:${group.pageId}`}
            onSelect={() => onNavigatePage(group.pageId, group.pageTitle)}
            data-testid={`palette-page-header-${group.pageId}`}
            className="flex items-center gap-2"
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1 truncate">{group.pageTitle}</span>
            {group.hasPageNameMatch && (
              // PEND-61 CR-2 — render the title-match signal as a small
              // uppercase pill so it reads as metadata rather than as
              // an accidental subtitle. Matches Linear's match-source
              // pill convention.
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                data-testid="palette-title-match-tag"
              >
                {t('palette.titleMatchTag')}
              </span>
            )}
          </CommandItem>
          {!linkMode &&
            group.matches.map((block) => (
              <CommandItem
                key={block.id}
                value={`block:${block.id}`}
                onSelect={() => onNavigateBlock(block.id, group.pageId, group.pageTitle)}
                data-testid={`palette-block-${block.id}`}
                className="ml-6"
              >
                {/* Render the FTS5 snippet with `<mark>` boundaries
                    inline. We avoid wrapping `SearchResultBlockRow`
                    (which is a `<li role="option">`) inside the
                    `<CommandItem>` (already an option) — nesting two
                    listbox options would violate ARIA. SnippetHighlight
                    is the pure renderer extracted in PEND-50. */}
                {block.snippet != null && block.snippet.length > 0 ? (
                  <SnippetHighlight snippet={block.snippet} className="truncate" />
                ) : (
                  <span className="truncate">{block.content ?? ''}</span>
                )}
              </CommandItem>
            ))}
          {!linkMode && group.surplus > 0 && (
            <CommandItem
              value={`more:${group.pageId}`}
              onSelect={onEscalateToMore}
              data-testid={`palette-more-pill-${group.pageId}`}
              className="ml-6 text-xs text-muted-foreground"
            >
              {t('palette.moreInThisPage', { count: group.surplus })}
            </CommandItem>
          )}
        </CommandGroup>
      ))}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────
// Commands mode
// ───────────────────────────────────────────────────────────────────

/**
 * Commands-mode body — v1 ships a small static registry of
 * navigation + action commands. Future modes (`nav`, `spaces`,
 * `agents`, `settings`) move into their own files; the registry is
 * intentionally inline here to keep v1 footprint small.
 *
 * cmdk filters via its own `value`-string match because we set
 * `shouldFilter={false}` on the root — so we pass the user's
 * post-`>` query down explicitly and filter the registry here, then
 * render only the surviving commands.
 */
function CommandsModeBody({
  onEscalate,
  onClose,
  t,
}: {
  onEscalate: (q: string) => void
  onClose: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  // PEND-61 CR-2 — the mode router at the parent (`PaletteBody`) has
  // already stripped the leading `>` from the store query when the
  // user typed it as the entry shortcut. Filtering by `query` directly
  // is correct; calling `commandsModeQuery(query)` here would shift
  // off another character (so `>set` filtered as `et`, missing the
  // `go-settings` row).
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.toLowerCase().trim()

  // Static registry. Keyed by `id` for stable React keys + cmdk
  // `value`. `category` drives the visible group heading. `icon`
  // provides a leading Lucide glyph — matches the iconography used
  // across the rest of Agaric (Raycast/Linear convention).
  const commands: ReadonlyArray<{
    id: string
    label: string
    category: 'navigate' | 'action'
    icon: LucideIcon
    run: () => void
  }> = useMemo(
    () => [
      {
        id: 'go-pages',
        label: t('palette.cmdGoPages'),
        category: 'navigate',
        icon: FileText,
        run: () => {
          useNavigationStore.getState().setView('pages')
          onClose()
        },
      },
      {
        id: 'go-tags',
        label: t('palette.cmdGoTags'),
        category: 'navigate',
        icon: TagIcon,
        run: () => {
          useNavigationStore.getState().setView('tags')
          onClose()
        },
      },
      {
        id: 'go-trash',
        label: t('palette.cmdGoTrash'),
        category: 'navigate',
        icon: Trash2,
        run: () => {
          useNavigationStore.getState().setView('trash')
          onClose()
        },
      },
      {
        id: 'go-history',
        label: t('palette.cmdGoHistory'),
        category: 'navigate',
        icon: Clock,
        run: () => {
          useNavigationStore.getState().setView('history')
          onClose()
        },
      },
      {
        id: 'go-settings',
        label: t('palette.cmdGoSettings'),
        category: 'navigate',
        icon: SettingsIcon,
        run: () => {
          useNavigationStore.getState().setView('settings')
          onClose()
        },
      },
      {
        id: 'search-everywhere',
        label: t('palette.cmdSearchEverywhere'),
        category: 'action',
        icon: FileSearch,
        run: () => {
          // Escalate with an empty seed — SearchPanel mounts with its
          // input ready for the user to type, same as Ctrl+Shift+F.
          onEscalate('')
        },
      },
    ],
    [t, onEscalate, onClose],
  )

  const filtered = useMemo(
    () =>
      filter.length === 0
        ? commands
        : commands.filter((c) => c.label.toLowerCase().includes(filter)),
    [commands, filter],
  )

  if (filtered.length === 0) {
    return (
      <CommandEmpty data-testid="palette-commands-empty">{t('palette.commandsEmpty')}</CommandEmpty>
    )
  }

  const navigateItems = filtered.filter((c) => c.category === 'navigate')
  const actionItems = filtered.filter((c) => c.category === 'action')

  return (
    <>
      {navigateItems.length > 0 && (
        <CommandGroup
          heading={t('palette.cmdGroupNavigate')}
          data-testid="palette-commands-navigate"
        >
          {navigateItems.map((c) => (
            <CommandItem
              key={c.id}
              value={`cmd:${c.id}`}
              onSelect={c.run}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {actionItems.length > 0 && (
        <CommandGroup heading={t('palette.cmdGroupAction')} data-testid="palette-commands-action">
          {actionItems.map((c) => (
            <CommandItem
              key={c.id}
              value={`cmd:${c.id}`}
              onSelect={c.run}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────
// Ranking — exported for unit test parity with PEND-51
// ───────────────────────────────────────────────────────────────────

/**
 * Merge the two FTS partitions into capped palette groups.
 *
 * - Each `pages` row seeds a group (page-name match band).
 * - Each `blocks` row appends to the existing group keyed by `page_id`,
 *   or seeds a content-only group when no page row exists for it.
 * - Groups are ordered by **4-band rule** (PEND-51 §"Result grouping"):
 *   exact title → prefix title → contains-in-title → content-only,
 *   tiebroken by the FTS-band + fuzzy blend score.
 * - Group count capped at `MAX_PAGE_GROUPS` (8).
 * - Matches per group capped at `MAX_MATCHES_PER_GROUP` (2); surplus
 *   surfaces as a "+N more" pill row.
 *
 * Migrated verbatim from PEND-51's `mergeAndRankGroups` — same input
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

  const orderedIds = [...order].sort((a, b) => {
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
