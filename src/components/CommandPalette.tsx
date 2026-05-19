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

import { ArrowLeftRight, Clock, FileText, Hash, HelpCircle, Pin, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type PaletteAction, PaletteActionMenu } from '@/components/palette/PaletteActionMenu'
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
import { getCurrentShortcuts, getShortcutKeys } from '@/lib/keyboard-config/storage'
import { logger } from '@/lib/logger'
import { PALETTE_COMMANDS, type PaletteCommandSpec } from '@/lib/palette-commands'
import { addRecentCommand, getRecentCommands } from '@/lib/recent-commands'
import {
  addRecentPage,
  getRecentPages,
  type RecentPage,
  togglePinRecentPage,
} from '@/lib/recent-pages'
import { renderKeys } from '@/lib/render-keyboard-shortcut'
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

/** PEND-67 Phase 3 — `#` prefix enters tags mode (block_type=tag search). */
function isTagsModeInput(input: string): boolean {
  return input.startsWith('#')
}

/** Extract the tags-mode filter query after the `#` prefix. */
function tagsModeQuery(input: string): string {
  return input.slice(1).trimStart()
}

/** PEND-67 Phase 3 — `?` prefix enters help mode (shortcut catalog). */
function isHelpModeInput(input: string): boolean {
  return input.startsWith('?')
}

/** Extract the help-mode filter query after the `?` prefix. */
function helpModeQuery(input: string): string {
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

  // PEND-67 Phase 5 — Radix attaches its Escape handler at `document`
  // with `capture: true`, so it fires BEFORE the action menu's React
  // bubble-phase keydown handler. When the action menu is open we
  // intercept Escape via Radix's `onEscapeKeyDown` prop and let the
  // menu handle Escape itself. The ref is the bridge — PaletteBody
  // sets it whenever its `actionMenu` state changes.
  const actionMenuOpenRef = useRef(false)

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
        // PEND-67 Phase 5 — preventDefault when the action menu owns
        // Escape; the menu's own keydown handler will close itself,
        // leaving the palette open.
        onEscapeKeyDown={(e: KeyboardEvent) => {
          if (actionMenuOpenRef.current) e.preventDefault()
        }}
        data-testid="command-palette"
        role="dialog"
        aria-label={t('palette.dialogLabel')}
      >
        <Title className="sr-only">{t('palette.dialogTitle')}</Title>
        <PaletteBody onClose={closeStore} actionMenuOpenRef={actionMenuOpenRef} />
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
function PaletteBody({
  onClose,
  actionMenuOpenRef,
}: {
  onClose: () => void
  actionMenuOpenRef: React.RefObject<boolean>
}): React.ReactElement {
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
  const enterModeWithQuery = useCommandPaletteStore((s) => s.enterModeWithQuery)
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
  //
  // PEND-67 Phase 6 — `enterModeWithQuery` (vs setMode + setQuery)
  // clears the search slot's `queryByMode` entry as part of the
  // transition. Without that, a chip-toggle back to search would
  // restore the original `>set` text and re-fire this router → loop.
  //
  // PEND-67 Phase 3 — `#` enters tags mode (block_type=tag search)
  // and `?` enters help mode (keyboard-shortcut catalog). Same
  // prefix-strip-and-restore semantics as `>`. Picker-trigger chars
  // (`/`, `@`, `[[`, `((`, `::`) remain owned by the editor and
  // never enter palette modes — they're scoped to the editor, not
  // the palette input.
  useEffect(() => {
    if (mode !== 'search') return
    const trimmed = query.trimStart()
    if (isCommandsModeInput(trimmed)) {
      enterModeWithQuery('commands', commandsModeQuery(query))
    } else if (isTagsModeInput(trimmed)) {
      enterModeWithQuery('tags', tagsModeQuery(query))
    } else if (isHelpModeInput(trimmed)) {
      enterModeWithQuery('help', helpModeQuery(query))
    }
  }, [query, mode, enterModeWithQuery])

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

  // ── PEND-67 Phase 5 — per-row action menu ────────────────────────
  // Tab on the focused row opens this menu; mouse users can also
  // open it via the `…` button rendered at row-right (Phase 4
  // already exposes a pin button there for recents). The menu
  // closes on Escape, click-outside, or after selecting an action.
  interface ActionMenuState {
    rowType: 'recent' | 'page' | 'block'
    rowId: string
    /** Pinned state captured at open-time; affects the recent-row action label. */
    pinned: boolean
    /** Row bounding rect at open-time — the menu positions itself below this. */
    rect: DOMRect
  }
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null)

  // Mirror open state into the outer ref so the dialog's
  // onEscapeKeyDown can preventDefault when the menu owns Escape.
  useEffect(() => {
    actionMenuOpenRef.current = actionMenu != null
  }, [actionMenu, actionMenuOpenRef])

  // Parse a cmdk row's `data-value` like "recent:PAGE_A" or
  // "page:PAGE_B" into its type + id.
  function parseRowValue(value: string): { type: string; id: string } | null {
    const idx = value.indexOf(':')
    if (idx < 0) return null
    return { type: value.slice(0, idx), id: value.slice(idx + 1) }
  }

  // PEND-67 Phase 5 — extracted out of `handleListKeyDown` so the
  // top-level dispatcher stays under Biome's cognitive-complexity
  // budget (≤ 25). Returns true if the Tab was consumed (caller
  // should `return` early).
  function tryOpenActionMenuOnTab(e: React.KeyboardEvent<HTMLDivElement>): boolean {
    if (e.key !== 'Tab' || e.shiftKey || actionMenu != null) return false
    const active = document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')
    if (active == null) return false
    const parsed = parseRowValue(active.getAttribute('data-value') ?? '')
    if (parsed == null) return false
    if (parsed.type !== 'recent' && parsed.type !== 'page' && parsed.type !== 'block') {
      // No action menu for `more:`, `__escalate__`, `cmd:`, `tag:`,
      // `help:` rows in v1 — their behaviour is already a single
      // action (Enter). Future phases can wire them in.
      return false
    }
    e.preventDefault()
    const isPinned =
      parsed.type === 'recent' && recents.find((p) => p.id === parsed.id)?.pinned === true
    setActionMenu({
      rowType: parsed.type,
      rowId: parsed.id,
      pinned: isPinned,
      rect: active.getBoundingClientRect(),
    })
    return true
  }

  // PEND-67 Phase 7 — extracted alongside `tryOpenActionMenuOnTab` so
  // the dispatcher reads as a flat list of "try X branch" calls.
  function tryNumericPrefixJump(e: React.KeyboardEvent<HTMLDivElement>): boolean {
    if (query.length > 0) return false
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (e.key < '1' || e.key > '9') return false
    const dialog = (e.currentTarget as HTMLElement).closest<HTMLElement>(
      '[data-testid="command-palette"]',
    )
    if (dialog == null) return false
    const items = dialog.querySelectorAll<HTMLElement>('[cmdk-item]')
    const target = items[Number(e.key) - 1]
    if (target == null) return false
    e.preventDefault()
    target.click()
    return true
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') {
      newTabRef.current = e.metaKey || e.ctrlKey
      return
    }
    if (e.key === 'Backspace') {
      // PEND-61 CR-2 — Backspace on an empty input in commands mode
      // returns to search mode (mirrors VSCode's Cmd+P ↔ Cmd+Shift+P
      // toggle). The chip stays the visible toggle for everyone else.
      if (mode === 'commands' && query.length === 0) {
        e.preventDefault()
        setMode('search')
      }
      return
    }
    if (tryOpenActionMenuOnTab(e)) return
    tryNumericPrefixJump(e)
  }
  function consumeNewTab(): boolean {
    const v = newTabRef.current
    newTabRef.current = false
    return v
  }

  // PEND-67 Phase 5 — derive the action set for the currently-open
  // action menu. Each row type gets a small, focused set; Open and
  // Open-in-new-tab carry the same chord hints as the global palette
  // keymap so users see the keyboard alternative right next to the
  // menu equivalent.
  const actionMenuActions = useMemo<readonly PaletteAction[]>(() => {
    if (actionMenu == null) return []
    if (actionMenu.rowType === 'recent') {
      return [
        { id: 'open', label: t('palette.actionOpen'), hint: '↵' },
        { id: 'open-new-tab', label: t('palette.actionOpenNewTab'), hint: '⌘↵' },
        actionMenu.pinned
          ? { id: 'unpin', label: t('palette.actionUnpin') }
          : { id: 'pin', label: t('palette.actionPin') },
      ]
    }
    if (actionMenu.rowType === 'page') {
      return [
        { id: 'open', label: t('palette.actionOpen'), hint: '↵' },
        { id: 'open-new-tab', label: t('palette.actionOpenNewTab'), hint: '⌘↵' },
      ]
    }
    // 'block'
    return [
      { id: 'open', label: t('palette.actionOpenPage'), hint: '↵' },
      { id: 'open-new-tab', label: t('palette.actionOpenNewTab'), hint: '⌘↵' },
    ]
  }, [actionMenu, t])

  function handleActionMenuAction(actionId: string): void {
    if (actionMenu == null) return
    const { rowType, rowId } = actionMenu
    const newTab = actionId === 'open-new-tab'
    setActionMenu(null)
    if (rowType === 'recent') {
      if (actionId === 'pin' || actionId === 'unpin') {
        togglePinRecentPage(rowId)
        setRecents(getRecentPages())
        return
      }
      const page = recents.find((p) => p.id === rowId)
      if (page == null) return
      addRecentPage(page.id, page.title)
      if (newTab) {
        openInNewTab(page.id, page.title)
      } else {
        navigateToPage(page.id, page.title)
      }
      onClose()
      return
    }
    if (rowType === 'page') {
      const group = groups.find((g) => g.pageId === rowId)
      if (group == null) return
      handleNavigateToPage(group.pageId, group.pageTitle, newTab)
      return
    }
    // 'block' — find the block in any group's `matches`.
    for (const g of groups) {
      const block = g.matches.find((b) => b.id === rowId)
      if (block != null) {
        handleNavigateToBlock(block.id, g.pageId, g.pageTitle, newTab)
        return
      }
    }
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
      <ModeChipRow mode={mode} setMode={setMode} t={t} />
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
        ) : mode === 'tags' ? (
          <TagsModeBody onEscalate={escalate} t={t} />
        ) : mode === 'help' ? (
          <HelpModeBody onClose={onClose} t={t} />
        ) : (
          <>
            {showRecents && (
              <CommandGroup heading={t('palette.recentTitle')} data-testid="palette-recents-group">
                {recents.map((page) => {
                  const isPinned = page.pinned === true
                  return (
                    <CommandItem
                      key={page.id}
                      value={`recent:${page.id}`}
                      onSelect={() => handleRecentClick(page)}
                      data-testid={`palette-recent-${page.id}`}
                      data-pinned={isPinned ? 'true' : undefined}
                      className="group gap-2"
                    >
                      {/* PEND-67 Phase 4 — pinned entries swap the
                          history glyph for a filled `Pin`, signalling
                          their sticky-at-top state without a separate
                          group heading. */}
                      {isPinned ? (
                        <Pin
                          className="h-3.5 w-3.5 shrink-0 text-foreground"
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      ) : (
                        <Clock
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="flex-1 truncate">{page.title}</span>
                      {/* PEND-67 Phase 4 — inline pin-toggle button.
                          Mouse-only for v1 (mobile pin lives in the
                          long-press action menu of Phase 5). Stops
                          propagation so the row's onSelect does not
                          also fire and navigate the user away. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePinRecentPage(page.id)
                          setRecents(getRecentPages())
                        }}
                        onPointerDown={(e) => {
                          // Prevent cmdk from interpreting the
                          // pointerdown as a row "click".
                          e.stopPropagation()
                        }}
                        className={cn(
                          'rounded p-0.5 text-muted-foreground hover:bg-muted/60 focus-ring-visible',
                          isPinned
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                        )}
                        aria-label={
                          isPinned
                            ? t('palette.unpinRecent', { title: page.title })
                            : t('palette.pinRecent', { title: page.title })
                        }
                        data-testid={`palette-recent-pin-${page.id}`}
                      >
                        <Pin
                          className="h-3 w-3"
                          fill={isPinned ? 'currentColor' : 'none'}
                          aria-hidden="true"
                        />
                      </button>
                    </CommandItem>
                  )
                })}
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
      {actionMenu != null && (
        <PaletteActionMenu
          anchor={actionMenu.rect}
          actions={actionMenuActions}
          onAction={handleActionMenuAction}
          onClose={() => setActionMenu(null)}
        />
      )}
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
 *
 * PEND-67 Phase 6 — toggling no longer clears the query. The store
 * remembers a query per mode (`queryByMode`); `setMode` restores it
 * so flipping back to the previous mode feels responsive, not
 * destructive (VSCode Cmd+P / Cmd+Shift+P parity).
 *
 * PEND-67 Phase 3 — with 4 modes (search / commands / tags / help)
 * a 4-cycle on the chip would force users to click 3 times to escape
 * any non-search mode. The plan suggested a cycle but Open Question 1
 * acknowledges this is awkward; we choose single-step exit semantics
 * instead. From search the chip enters commands (the original
 * affordance); from any other mode it returns to search. Tags and
 * help are entered via the `#` / `?` prefixes, surfaced in the
 * `modeHint` text on the search-mode chip row.
 */
function ModeChipRow({
  mode,
  setMode,
  t,
}: {
  mode: PaletteMode
  setMode: (m: PaletteMode) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  function toggleMode() {
    if (mode === 'search') {
      setMode('commands')
    } else {
      setMode('search')
    }
  }
  const label =
    mode === 'commands'
      ? t('palette.modeCommands')
      : mode === 'tags'
        ? t('palette.modeTags')
        : mode === 'help'
          ? t('palette.modeHelp')
          : t('palette.modeSearch')
  // Only the search-mode hint surfaces the prefix vocabulary —
  // other modes don't benefit from showing it.
  const hint = mode === 'search' ? t('palette.modeHint') : t('palette.modeBackHint')
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
          prefix shortcuts. The hint is short and informational, so it
          lives in the visible header rather than a tooltip. */}
      <span className="text-muted-foreground">{hint}</span>
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
 * PEND-67 Phase 1 — split a catalog keys string ("Ctrl + Shift + F")
 * into a list of chord chip tokens with platform-typical glyphs.
 *
 * The catalog stores chord names as "Modifier + Modifier + Key"
 * (`src/lib/keyboard-config/catalog.ts`). We map a small allow-list
 * of common modifier names to single-glyph chips so they read as
 * keyboard shortcuts at a glance (Raycast / Linear / VSCode parity).
 * Unknown tokens fall through verbatim (uppercased) so a future
 * catalog addition does not silently render blank.
 */
function formatChordTokens(keys: string): string[] {
  if (keys.length === 0) return []
  const GLYPHS: Record<string, string> = {
    ctrl: '⌃',
    control: '⌃',
    shift: '⇧',
    cmd: '⌘',
    command: '⌘',
    meta: '⌘',
    alt: '⌥',
    option: '⌥',
    enter: '↵',
    return: '↵',
    escape: 'esc',
    esc: 'esc',
    space: '␣',
    tab: '⇥',
    backspace: '⌫',
  }
  return keys
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => GLYPHS[t.toLowerCase()] ?? t.toUpperCase())
}

/**
 * Right-aligned chord chip group rendered inside a `<CommandItem>`.
 * Reads live from `getShortcutKeys` so a rebind takes effect on the
 * next render. Returns null when the binding is empty (e.g. a command
 * without a `shortcutId` or a deleted-then-not-rebound binding) so the
 * row layout stays consistent — no empty `<span>` placeholder.
 */
function ShortcutChips({ shortcutId }: { shortcutId: string }): React.ReactElement | null {
  const keys = getShortcutKeys(shortcutId)
  const tokens = formatChordTokens(keys)
  if (tokens.length === 0) return null
  return (
    <span
      className="ml-auto inline-flex items-center gap-1"
      aria-hidden="true"
      data-testid={`palette-cmd-shortcut-${shortcutId}`}
    >
      {tokens.map((tok) => (
        // Tokens within a chord are unique in practice (Ctrl+Shift+F,
        // not Ctrl+Ctrl+F). Using `tok` as key avoids the index-as-key
        // lint while staying stable across rebind re-renders.
        <kbd
          key={tok}
          className="rounded border border-border bg-muted/40 px-1 py-px font-mono text-[10px]"
        >
          {tok}
        </kbd>
      ))}
    </span>
  )
}

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

  // PEND-67 Phase 8 — registry hoisted to `lib/palette-commands.ts`
  // so the global `runLastCommand` shortcut can execute by id without
  // mounting the palette body. Here we adapt each spec into the
  // shape the rest of the body expects: a flat `label` (resolved via
  // `t()`) + a 0-arg `run` closed over `onClose` / `onEscalate`.
  type RenderedCommand = Omit<PaletteCommandSpec, 'labelKey' | 'run'> & {
    label: string
    run: () => void
  }
  const commands: ReadonlyArray<RenderedCommand> = useMemo(
    () =>
      PALETTE_COMMANDS.map((c) => ({
        ...c,
        label: t(c.labelKey),
        run: () => c.run({ onClose, onEscalate }),
      })),
    [t, onEscalate, onClose],
  )

  const filtered = useMemo(
    () =>
      filter.length === 0
        ? commands
        : commands.filter((c) => c.label.toLowerCase().includes(filter)),
    [commands, filter],
  )

  // PEND-67 Phase 2 — Recent commands strip. Only rendered when the
  // filter is empty (typed input hides it so the registry filter has
  // the floor). Read once on mount; the list is small and the palette
  // re-mounts every open.
  const [recents, setRecents] = useState<ReturnType<typeof getRecentCommands>>([])
  useEffect(() => {
    setRecents(getRecentCommands())
  }, [])

  // Build the visible recent rows by joining ids against the registry.
  // Recents whose command id no longer exists in the registry (stale
  // localStorage from an older build) are silently skipped.
  const recentRows = useMemo(() => {
    if (filter.length > 0) return []
    const byId = new Map(commands.map((c) => [c.id, c]))
    return recents
      .map((r) => byId.get(r.id))
      .filter((c): c is (typeof commands)[number] => c != null)
  }, [recents, commands, filter])

  // Wrap each `run` so the command id is recorded before the handler
  // closes the palette. The store is module-level state, so a re-render
  // inside `setRecents` from a closed palette is harmless.
  const runWithTracking = (c: (typeof commands)[number]) => () => {
    addRecentCommand(c.id)
    c.run()
  }

  if (filtered.length === 0 && recentRows.length === 0) {
    return (
      <CommandEmpty data-testid="palette-commands-empty">{t('palette.commandsEmpty')}</CommandEmpty>
    )
  }

  const navigateItems = filtered.filter((c) => c.category === 'navigate')
  const actionItems = filtered.filter((c) => c.category === 'action')

  return (
    <>
      {recentRows.length > 0 && (
        <CommandGroup
          heading={t('palette.recentCommandsTitle')}
          data-testid="palette-commands-recent"
        >
          {recentRows.map((c) => (
            <CommandItem
              key={`recent-${c.id}`}
              value={`cmd-recent:${c.id}`}
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-recent-${c.id}`}
              className="gap-2"
            >
              <RotateCcw
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {navigateItems.length > 0 && (
        <CommandGroup
          heading={t('palette.cmdGroupNavigate')}
          data-testid="palette-commands-navigate"
        >
          {navigateItems.map((c) => (
            <CommandItem
              key={c.id}
              value={`cmd:${c.id}`}
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
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
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────
// Tags mode (PEND-67 Phase 3 — `#` prefix → block_type=tag search)
// ───────────────────────────────────────────────────────────────────

/** Backend cap for the tags-mode partition. */
const TAGS_QUERY_LIMIT = 40

/**
 * Tags-mode body — debounced `searchBlocks({ blockTypeFilter: 'tag' })`
 * with on-select escalation to the search view seeded by
 * `tag:#<name>` (PEND-54 inline filter syntax). The escalation keeps
 * the palette out of the navigation business and reuses the existing
 * find-in-files surface for tag filtering.
 */
function TagsModeBody({
  onEscalate,
  t,
}: {
  onEscalate: (q: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.trim()

  const [tags, setTags] = useState<SearchBlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const generationRef = useRef(0)
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value)
  }, PALETTE_DEBOUNCE_MS)

  useEffect(() => {
    debounced.cancel()
    debounced.schedule(filter)
  }, [filter, debounced])

  useEffect(() => {
    if (!spaceIsReady) return
    generationRef.current += 1
    const gen = generationRef.current
    setLoading(true)
    searchBlocks({
      query: debouncedQuery,
      blockTypeFilter: 'tag',
      limit: paginationLimit(TAGS_QUERY_LIMIT),
      spaceId: currentSpaceId ?? '',
    })
      .then((resp) => {
        if (gen !== generationRef.current) return
        setTags(resp.items)
        setLoading(false)
      })
      .catch((err) => {
        if (gen !== generationRef.current) return
        logger.warn('CommandPalette', 'tags search failed', { query: debouncedQuery }, err)
        setTags([])
        setLoading(false)
      })
  }, [debouncedQuery, currentSpaceId, spaceIsReady])

  if (!loading && tags.length === 0) {
    return (
      <CommandEmpty data-testid="palette-tags-empty">
        {filter.length === 0 ? t('palette.tagsWelcomeEmpty') : t('palette.tagsNoResults')}
      </CommandEmpty>
    )
  }

  return (
    <CommandGroup heading={t('palette.tagsTitle')} data-testid="palette-tags-group">
      {tags.map((tag) => {
        const name = tag.content ?? ''
        return (
          <CommandItem
            key={tag.id}
            value={`tag:${tag.id}`}
            onSelect={() => onEscalate(`tag:#${name}`)}
            data-testid={`palette-tag-${tag.id}`}
            className="gap-2"
          >
            <Hash className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{name.length > 0 ? name : t('palette.tagsUnnamed')}</span>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

// ───────────────────────────────────────────────────────────────────
// Help mode (PEND-67 Phase 3 — `?` prefix → keyboard shortcut catalog)
// ───────────────────────────────────────────────────────────────────

/**
 * Help-mode body — renders the keyboard shortcut catalog grouped by
 * category. Reads `getCurrentShortcuts()` once on mount (the catalog
 * is static; user overrides are picked up on next palette open since
 * the palette re-mounts every time it opens).
 *
 * Selecting a row closes the palette — there is no "run this
 * shortcut from here" action because some shortcuts only fire in
 * context-bound conditions (e.g. only inside the editor, only with
 * the date picker open).
 */
function HelpModeBody({
  onClose,
  t,
}: {
  onClose: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.toLowerCase().trim()

  const shortcuts = useMemo(() => getCurrentShortcuts(), [])
  const filtered = useMemo(() => {
    if (filter.length === 0) return shortcuts
    return shortcuts.filter(
      (s) =>
        t(s.description).toLowerCase().includes(filter) || s.keys.toLowerCase().includes(filter),
    )
  }, [shortcuts, filter, t])

  // Group by category preserving first-seen order so the visible
  // ordering tracks the catalog's authoring order.
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof filtered>()
    for (const s of filtered) {
      const arr = groups.get(s.category) ?? []
      arr.push(s)
      groups.set(s.category, arr)
    }
    return Array.from(groups.entries())
  }, [filtered])

  if (filtered.length === 0) {
    return <CommandEmpty data-testid="palette-help-empty">{t('palette.helpEmpty')}</CommandEmpty>
  }

  return (
    <>
      {grouped.map(([category, items]) => (
        <CommandGroup
          key={category}
          heading={t(category)}
          data-testid={`palette-help-group-${category}`}
        >
          {items.map((s) => (
            <CommandItem
              key={s.id}
              value={`help:${s.id}`}
              onSelect={onClose}
              data-testid={`palette-help-${s.id}`}
              className="gap-2"
            >
              <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate">{t(s.description)}</span>
              {/* Use the shared `renderKeys` helper because catalog
                  bindings include `/`-alternatives (e.g. `Arrow Up /
                  Left`) and multi-word tokens (`Arrow Up`) that the
                  glyph-mapping `ShortcutChips` does not handle. The
                  styling matches the standalone KeyboardShortcuts
                  dialog so users moving between surfaces see one
                  consistent chord layout. */}
              <span className="ml-auto inline-flex items-center" aria-hidden="true">
                {renderKeys(s.keys)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
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
