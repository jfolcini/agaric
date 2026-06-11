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
 * Mobile UX uses the same body via `<SearchSheet>`, which mounts
 * `<PaletteBody>` (exported below) inside its all-pages segment. The
 * outer Dialog/Sheet wrapper in `CommandPalette` is the desktop Cmd+K
 * surface only; the search-sheet sibling provides its own chrome.
 *
 * #751 — the command registry, prefix routing, ranking, `[[page]]`
 * insertion, action-menu action-set, and the per-mode render bodies
 * are extracted into `components/palette/`. `CommandPalette` /
 * `PaletteBody` remain the stable public entry points (App.tsx and
 * SearchSheet.tsx import them from here) and `mergeAndRankGroups` is
 * re-exported below for the existing test import path.
 */

import { ChevronRight, Clock, Pin } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import {
  type ActionMenuRowType,
  buildActionMenuActions,
} from '@/components/palette/action-menu-actions'
import { CommandsModeBody } from '@/components/palette/CommandsModeBody'
import {
  BLOCK_QUERY_LIMIT,
  PAGE_QUERY_LIMIT,
  PALETTE_DEBOUNCE_MS,
} from '@/components/palette/constants'
import { HelpModeBody } from '@/components/palette/HelpModeBody'
import {
  isCommandsModeInput,
  isPageLinkMode,
  pageLinkQuery,
  routePrefixToMode,
} from '@/components/palette/input-modes'
import { insertPageLinkInto } from '@/components/palette/insert-page-link'
import { ModeChipRow, PaletteFooterHint } from '@/components/palette/ModeChipRow'
import { type PaletteAction, PaletteActionMenu } from '@/components/palette/PaletteActionMenu'
import { mergeAndRankGroups } from '@/components/palette/ranking'
import { SearchModeGroups } from '@/components/palette/SearchModeGroups'
import { TagsModeBody } from '@/components/palette/TagsModeBody'
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
import { useFailedOnce } from '@/hooks/useFailedOnce'
import { useGenerationGuard } from '@/hooks/useGenerationGuard'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isCancellation } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  addRecentPage,
  getRecentPages,
  type RecentPage,
  removeRecentPage,
  togglePinRecentPage,
} from '@/lib/recent-pages'
import type { SearchBlockRow } from '@/lib/tauri'
import { searchBlocksPartitioned } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

// #751 — re-export the ranking helper so the existing test import
// (`import { mergeAndRankGroups } from '../CommandPalette'`) and any
// other consumers keep working after the extraction to `palette/`.
export { mergeAndRankGroups } from '@/components/palette/ranking'

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

  // Radix attaches its Escape handler at `document` with `capture: true`,
  // so it fires BEFORE the action menu's React bubble-phase keydown
  // handler. When the action menu is open we intercept Escape via
  // Radix's `onEscapeKeyDown` prop and let the menu handle Escape
  // itself. The ref is the bridge — PaletteBody sets it whenever its
  // `actionMenu` state changes.
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
        // preventDefault when the action menu owns Escape; the menu's
        // own keydown handler will close itself, leaving the palette
        // open.
        onEscapeKeyDown={(e: KeyboardEvent) => {
          if (actionMenuOpenRef.current) e.preventDefault()
        }}
        data-testid="command-palette"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="dialog" is on Radix's <Content> primitive (a custom component, not a raw element); the native <dialog> tag would bypass Radix's focus-trap/portal/escape handling
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
 * PaletteBody — inner cmdk surface (input + results + escalation
 * footer + action menu). Split out of `CommandPalette` so two
 * surfaces can mount it: the desktop Cmd+K dialog above, and the
 * mobile search sheet's all-pages segment (`SearchSheet.tsx`).
 *
 * `onClose` is the only meaningful contract knob: the dialog wrapper
 * passes `closeStore`; the sheet passes a closure that also tears
 * down the sheet itself (so `escalate()`'s `setPendingViewQuery →
 * onClose → setView('search')` flow disposes the sheet cleanly
 * before the find-in-files view appears).
 */
// oxlint-disable-next-line eslint/complexity -- complexity 26 vs max 25. PaletteBody is the orchestrator across 6 row types (search / commands / tags / help / link / recent), the debounced partitioned-IPC pipeline, and the Phase 5 action-menu state machine. Top-level helpers (routePrefixToMode, buildActionMenuActions, parseRowValue, tryOpenActionMenuOnTab, tryNumericPrefixJump, revealInPagesView) are already extracted; splitting further would mean threading 10+ closures through a custom hook signature for one point over budget. Same trade-off as DaySection.tsx and ConfirmDialog.tsx in this repo.
export function PaletteBody({
  onClose,
  actionMenuOpenRef,
}: {
  onClose: () => void
  actionMenuOpenRef: React.RefObject<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  // Strip the "Ctrl+Shift+F" suffix from the escalation footer when
  // we're rendering on a touch viewport — the keybinding is
  // meaningless there. Same mobile-only signal everything else uses
  // (`useIsMobile`).
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const openInNewTab = useTabsStore((s) => s.openInNewTab)

  // PEND-73 Phase 4.M6 — collapse the 8 individual store selectors into
  // one `useShallow` selector. Matches the SearchSheet.tsx:44 pattern.
  // Each individual selector subscribed the component to ANY store
  // change and re-ran the equality check 8 times per commit; the
  // shallow-compared object lets zustand bail out at the top of the
  // selector when none of the watched fields changed.
  //
  // PEND-73 Phase 3.U8 — `previousSelectionRange` snapshotted at palette
  // open time; restored before the Selection/Range fallback insert on
  // non-TipTap contenteditable targets so `[[page]]` insertion lands at
  // the user's original caret. (The TipTap branch doesn't need it —
  // ProseMirror restores its own selection on `.focus()`.)
  const {
    query,
    setQuery: setQueryStore,
    mode,
    setMode,
    enterModeWithQuery,
    setPendingViewQuery,
    previousFocusedElement,
    previousSelectionRange,
  } = useCommandPaletteStore(
    useShallow((s) => ({
      query: s.query,
      setQuery: s.setQuery,
      mode: s.mode,
      setMode: s.setMode,
      enterModeWithQuery: s.enterModeWithQuery,
      setPendingViewQuery: s.setPendingViewQuery,
      previousFocusedElement: s.previousFocusedElement,
      previousSelectionRange: s.previousSelectionRange,
    })),
  )

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
    const route = routePrefixToMode(query)
    if (route != null) enterModeWithQuery(route.next, route.q)
  }, [query, mode, enterModeWithQuery])

  // PEND-73 Phase 3.U4 — autofocus before paint via useLayoutEffect.
  // useEffect runs after paint, leaving a one-frame flash on slow
  // mounts where the user sees the unfocused input and then watches
  // the caret jump in. Matches the InPageFind.tsx:155 pattern.
  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced query mirror — the IPC fires off this. 80 ms per the
  // plan. Initialised from the store so a seeded query (e.g. the
  // mobile search sheet switching from in-page → all-pages with a
  // populated query) drives the IPC immediately on mount instead of
  // waiting for a keystroke. Trimmed for parity with
  // `handleInputChange` below; `isCommandsModeInput` would skip the
  // IPC altogether.
  const [debouncedQuery, setDebouncedQuery] = useState(() => {
    const initial = useCommandPaletteStore.getState().query.trim()
    if (initial.length === 0 || isCommandsModeInput(initial)) return ''
    return initial
  })
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value)
  }, PALETTE_DEBOUNCE_MS)

  // PEND-72 — distinguish user-initiated query changes (which should
  // respect the 80 ms debounce above) from external writes to the
  // store (e.g. the mobile search sheet's bridge seeding the palette
  // on segment switch). The ref is updated synchronously inside
  // `handleInputChange`, so the sync effect below sees `query ===
  // lastUserQueryRef.current` and short-circuits for the typing
  // path. External writes leave the ref stale → the effect fires
  // `setDebouncedQuery` immediately so the IPC fires for the seed.
  const lastUserQueryRef = useRef(query)

  function handleInputChange(value: string) {
    lastUserQueryRef.current = value
    setQueryStore(value)
    debounced.cancel()
    const trimmed = value.trim()
    if (trimmed.length === 0 || isCommandsModeInput(trimmed)) {
      setDebouncedQuery('')
      return
    }
    debounced.schedule(trimmed)
  }

  // PEND-72 — sync `debouncedQuery` whenever `query` changes from
  // outside the input handler. The equality check vs
  // `lastUserQueryRef.current` skips the user-typing path (which
  // routes through `handleInputChange` and manages its own
  // debounced schedule).
  useEffect(() => {
    if (query === lastUserQueryRef.current) return
    lastUserQueryRef.current = query
    debounced.cancel()
    const trimmed = query.trim()
    setDebouncedQuery(trimmed.length === 0 || isCommandsModeInput(trimmed) ? '' : trimmed)
    // `debounced` is a stable identity (useMemo([]) in useDebouncedCallback),
    // so listing it cannot cause spurious re-runs; `query` remains the trigger.
  }, [query, debounced])

  // PEND-73 Phase 4.M3 — race-discard via the shared `useGenerationGuard`
  // hook. Re-bumped on every keystroke; an in-flight response from an
  // earlier keystroke is dropped if its id doesn't match.
  const searchGen = useGenerationGuard()
  // PEND-73 Phase 3.U1 — surface real IPC failures (non-cancellation)
  // once per session via a toast. Logger still captures every failure.
  const surfaceFailureOnce = useFailedOnce()
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
  // One `searchBlocksPartitioned` round-trip returns both partitions
  // ({ pages, blocks }) from a single FTS scan (PEND-61 Phase 1).
  //
  // PEND-69 F1 — the partitioned IPC now runs two parallel scans
  // server-side (page-only + unrestricted), each with its own
  // `limit + 1` probe. The pages partition is guaranteed to surface
  // matching pages regardless of how many content rows out-rank them,
  // so `[[page]]` autocomplete no longer needs a dedicated
  // `searchBlocks({ blockTypeFilter: 'page' })` round-trip. linkMode
  // simply asks for zero blocks and reads the pages partition.
  useEffect(() => {
    if (mode !== 'search') {
      // #736 hardening — leaving search mode (typing the `>`/`#`/`?`
      // prefix) mid-flight is the same race as clearing the input: no
      // new IPC fires, so without a bump the in-flight response still
      // passes `isCurrent` and silently updates pages/blocks while the
      // commands/tags/help body is shown — then flashes as stale groups
      // when the user toggles back to search (the restored query is
      // empty, so the clear below only runs AFTER the first paint).
      // Palette close needs no equivalent: `CommandPalette` unmounts
      // `PaletteBody` entirely (`if (!open) return null`).
      searchGen.next()
      setLoading(false)
      return
    }
    if (!spaceIsReady) return
    if (effectiveQuery.length === 0) {
      // #736 — also invalidate any in-flight search and drop the loading
      // shimmer. Without the bump, the previous keystroke's
      // `searchBlocksPartitioned` response still passes `isCurrent` below
      // and repopulates pages/blocks UNDER the recents/welcome empty state
      // (groups render regardless of query length). Mirrors the FE-1
      // invalidation in `usePaginatedQuery` for the same clear-mid-flight
      // race.
      searchGen.next()
      setPages([])
      setBlocks([])
      setLoading(false)
      return
    }
    const gen = searchGen.next()
    setLoading(true)

    const spaceId = currentSpaceId ?? ''

    const fetchPromise = searchBlocksPartitioned({
      query: effectiveQuery,
      pageLimit: PAGE_QUERY_LIMIT,
      blockLimit: linkMode ? 0 : BLOCK_QUERY_LIMIT,
      spaceId,
    }).then((resp) => ({
      pages: { items: resp.pages.items },
      blocks: { items: resp.blocks.items },
    }))

    fetchPromise
      .then(({ pages: p, blocks: b }) => {
        if (!searchGen.isCurrent(gen)) return
        setPages(p.items)
        setBlocks(b.items)
        setLoading(false)
      })
      .catch((err) => {
        if (!searchGen.isCurrent(gen)) return
        // PEND-73 Phase 2 — swallow PEND-70 backend cancellations
        // silently. They fire on every superseded keystroke when a fast
        // typist races the read pool, and the stale-generation guard
        // above already discards the (non-existent) result. Toasting on
        // every cancelled IPC would spam the user with what is the
        // expected case, not an error.
        if (isCancellation(err)) return
        logger.warn(
          'CommandPalette',
          'search query failed',
          { query: effectiveQuery, linkMode },
          err,
        )
        // PEND-73 Phase 3.U1 — once-per-session toast for real failures.
        surfaceFailureOnce('palette:search', () => notify.error(t('search.failed')))
        setPages([])
        setBlocks([])
        setLoading(false)
      })
  }, [
    effectiveQuery,
    linkMode,
    mode,
    spaceIsReady,
    currentSpaceId,
    searchGen,
    surfaceFailureOnce,
    t,
  ])

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
      const ok = insertPageLinkInto(previousFocusedElement, pageTitle, previousSelectionRange)
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
    rowType: ActionMenuRowType
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

  // PEND-67 Phase 5 — `buildActionMenuActions` (top-level helper) owns
  // the row-type → action-set mapping. Memoising on `actionMenu` +
  // `t` keeps the rendered menu stable across unrelated re-renders.
  const actionMenuActions = useMemo<readonly PaletteAction[]>(
    () =>
      actionMenu == null ? [] : buildActionMenuActions(actionMenu.rowType, actionMenu.pinned, t),
    [actionMenu, t],
  )

  // PEND-67 Phase 5 — clipboard write with a uniform success/failure
  // toast pair so every "Copy …" action looks the same. Extracted
  // outside the row-type handlers so `notify` is the single source of
  // user-visible state for these actions.
  function copyToClipboard(value: string, successKey: string): void {
    navigator.clipboard
      .writeText(value)
      .then(() => notify.success(t(successKey)))
      .catch(() => notify.error(t('palette.copyFailed')))
  }

  // Centralised "reveal in pages view" so all three row-type handlers
  // route through a single seed-and-flip call. Extracting also drops
  // PaletteBody's cognitive-complexity score below the 25 budget.
  function revealInPagesView(title: string): void {
    useNavigationStore.getState().setPendingPageBrowserFilter(title)
    useNavigationStore.getState().setView('pages')
    onClose()
  }

  // Per-row-type action handlers — keep each small so the dispatcher
  // (`handleActionMenuAction`) stays under Biome's complexity budget.
  function handleRecentRowAction(actionId: string, rowId: string, newTab: boolean): void {
    if (actionId === 'pin' || actionId === 'unpin') {
      togglePinRecentPage(rowId)
      setRecents(getRecentPages())
      return
    }
    if (actionId === 'remove-from-recents') {
      removeRecentPage(rowId)
      setRecents(getRecentPages())
      return
    }
    const page = recents.find((p) => p.id === rowId)
    if (page == null) return
    if (actionId === 'copy-id') {
      copyToClipboard(page.id, 'palette.copyIdSuccess')
      return
    }
    if (actionId === 'reveal-in-pages') {
      revealInPagesView(page.title)
      return
    }
    addRecentPage(page.id, page.title)
    if (newTab) openInNewTab(page.id, page.title)
    else navigateToPage(page.id, page.title)
    onClose()
  }

  function handlePageRowAction(actionId: string, rowId: string, newTab: boolean): void {
    const group = groups.find((g) => g.pageId === rowId)
    if (group == null) return
    if (actionId === 'copy-id') {
      copyToClipboard(group.pageId, 'palette.copyIdSuccess')
      return
    }
    if (actionId === 'reveal-in-pages') {
      revealInPagesView(group.pageTitle)
      return
    }
    handleNavigateToPage(group.pageId, group.pageTitle, newTab)
  }

  function handleBlockRowAction(actionId: string, rowId: string, newTab: boolean): void {
    for (const g of groups) {
      const block = g.matches.find((b) => b.id === rowId)
      if (block == null) continue
      // Roam-style block reference syntax — Agaric's `((BLOCK_ID))`
      // picker-trigger inserts inline references using exactly this
      // shape (per `docs/UX.md` § Keyboard model).
      if (actionId === 'copy-block-link') {
        copyToClipboard(`((${block.id}))`, 'palette.copyLinkSuccess')
        return
      }
      if (actionId === 'reveal-in-pages') {
        revealInPagesView(g.pageTitle)
        return
      }
      handleNavigateToBlock(block.id, g.pageId, g.pageTitle, newTab)
      return
    }
  }

  function handleActionMenuAction(actionId: string): void {
    if (actionMenu == null) return
    const { rowType, rowId } = actionMenu
    const newTab = actionId === 'open-new-tab'
    setActionMenu(null)
    if (rowType === 'recent') {
      handleRecentRowAction(actionId, rowId, newTab)
      return
    }
    if (rowType === 'page') {
      handlePageRowAction(actionId, rowId, newTab)
      return
    }
    handleBlockRowAction(actionId, rowId, newTab)
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
  // PEND-58g UX-A1 — the mobile all-pages sheet ALWAYS surfaces the
  // escalation CTA, independent of query text / results. The full
  // search view is where filters, regex, and history live; gating the
  // CTA on a non-empty query hid it exactly when a cold-open user most
  // needs to discover those features. Mobile-only — desktop keeps the
  // query-gated inline cmdk footer (`showEscalationFooter`).
  const showMobileEscalation = mode === 'search' && !linkMode && isMobile

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
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level sr-only live region; <output> is inline-level and the div is intentionally a block container for the announced status text
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
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level badge card (border/padding/rounded); <output> is inline-level and would break the boxed layout
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
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level no-results row (full-width padded); <output> is inline-level and would break the row layout
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
            {showEscalationFooter && !isMobile && (
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
      {showMobileEscalation && (
        /* PEND-58g UX-A1 — prominent, always-visible escalation CTA
           pinned beneath the CommandList. Styled as a bordered,
           elevated box (not a muted footer row) so the path to the
           full search view — filters, regex, history — is discoverable
           even on a cold open with an empty query. Two lines: an
           emphasized title with a trailing chevron + a muted hint.
           Sibling-after-list placement loses cmdk's Enter-to-select
           binding, but touch users tap. */
        <button
          type="button"
          onClick={() => escalate(trimmedQuery)}
          data-testid="palette-escalation-footer"
          aria-label={t('searchSheet.escalateLabel')}
          className="m-3 flex min-h-11 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left shadow-sm hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-ring-visible"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1 text-sm font-medium text-foreground">
              <span className="truncate">{t('searchSheet.escalateCtaTitle')}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {t('searchSheet.escalateCtaHint')}
            </span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}
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
