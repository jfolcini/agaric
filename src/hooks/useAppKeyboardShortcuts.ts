/**
 * useAppKeyboardShortcuts — single hook owning all 5 App-level keyboard
 * shortcut effects.
 *
 * MAINT-124 step 1 — extracted from App.tsx as part of the 4-extraction
 * collapse plan (others: useAppDialogs, ViewDispatcher, AppShell).
 *
 * Categories (one keydown listener per category, behaviour preserved
 * verbatim from the original effects in App.tsx):
 *
 * - **journal** — `prevDayWeekMonth`, `nextDayWeekMonth`, `goToToday`.
 *   Listens at `document` (everything else listens at `window`); only
 *   fires while `currentView === 'journal'`.
 * - **global** — `gotoConflicts`, `focusSearch`, `createNewPage`.
 *   Routed through `matchesShortcutBinding` so Settings rebinding (BUG-18)
 *   works for every entry.
 * - **space** — `switchSpace1` … `switchSpace9` digit hotkeys.
 *   Out-of-range indices are deliberate silent no-ops.
 * - **close-overlays** — the rebindable `closeOverlays` shortcut
 *   (Escape by default). Dispatches `CLOSE_ALL_OVERLAYS_EVENT` on `window`
 *   so any non-Radix overlay can listen and close itself.
 * - **tab** — `openInNewTab`, `closeActiveTab`, `previousTab`, `nextTab`.
 *   Mobile-gated because the TabBar is hidden on touch devices.
 *
 * **Why 5 separate effects rather than one consolidated listener.**
 * The journal handler is registered on `document`, the other four on
 * `window`. Merging would change the propagation/capture semantics for
 * tests (and for any DOM that stops propagation between `document` and
 * `window`). Each category also has its own dependency list (`t` only,
 * `[t, isMobile]`, or `[]`) — keeping them split lets React skip
 * re-registration when only one input changed. Behaviour is therefore
 * identical to the pre-extraction code; this hook only relocates
 * ownership of the listeners.
 */

import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { announce } from '../lib/announcer'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { logger } from '../lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../lib/overlay-events'
import { createPageInSpace } from '../lib/tauri'
import { type JournalMode, useJournalStore } from '../stores/journal'
import { useNavigationStore } from '../stores/navigation'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '../stores/tabs'

// ---------------------------------------------------------------------------
// Helpers and dispatch tables (moved verbatim from App.tsx so the hook owns
// every piece of keyboard-shortcut behaviour).
// ---------------------------------------------------------------------------

/** Returns true when the event target is an editable input/textarea/contentEditable. */
function isTypingInField(target: HTMLElement | null): boolean {
  if (!target) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  // Check both the IDL property (reflects inherited contenteditable) and
  // the attribute directly so jsdom-based tests that construct a bare
  // `<div contenteditable="true">` without a full document inheritance
  // chain still behave like the real browser. Matches the `?` global
  // listener in `KeyboardShortcuts.tsx`.
  if (target.isContentEditable) return true
  return target.getAttribute?.('contenteditable') === 'true'
}

/** Per-mode date shifters used by journal nav shortcuts. */
const JOURNAL_SHIFT_PREV: Record<JournalMode, (d: Date) => Date> = {
  daily: (d) => subDays(d, 1),
  weekly: (d) => subWeeks(d, 1),
  monthly: (d) => subMonths(d, 1),
  agenda: (d) => subMonths(d, 1),
}
const JOURNAL_SHIFT_NEXT: Record<JournalMode, (d: Date) => Date> = {
  daily: (d) => addDays(d, 1),
  weekly: (d) => addWeeks(d, 1),
  monthly: (d) => addMonths(d, 1),
  agenda: (d) => addMonths(d, 1),
}

interface JournalShortcut {
  /** Shortcut id routed through `matchesShortcutBinding`. */
  readonly binding: string
  /** Returns the next date for the current mode. */
  readonly nextDate: (current: Date, mode: JournalMode) => Date
  /** i18n key for the screen-reader announcement. */
  readonly announceKey: string
}

/**
 * Journal-view keyboard shortcuts. Same pattern as `KEY_RULES` in
 * `editor/use-block-keyboard.ts`: first match wins, keeps the dispatch
 * handler well under the cognitive-complexity budget.
 */
const JOURNAL_SHORTCUTS: ReadonlyArray<JournalShortcut> = [
  {
    binding: 'prevDayWeekMonth',
    nextDate: (d, mode) => JOURNAL_SHIFT_PREV[mode](d),
    announceKey: 'announce.navigatedToPrevious',
  },
  {
    binding: 'nextDayWeekMonth',
    nextDate: (d, mode) => JOURNAL_SHIFT_NEXT[mode](d),
    announceKey: 'announce.navigatedToNext',
  },
  {
    binding: 'goToToday',
    nextDate: () => new Date(),
    announceKey: 'announce.jumpedToToday',
  },
]

interface TabShortcut {
  /** Shortcut id routed through `matchesShortcutBinding`. */
  readonly binding: string
  /** Runs the action against the current tabs store snapshot. */
  readonly run: (state: ReturnType<typeof useTabsStore.getState>) => void
}

/**
 * Tab-management keyboard shortcuts. `previousTab` (Ctrl+Shift+Tab) is listed
 * before `nextTab` (Ctrl+Tab) because the Shift+Tab binding is strictly more
 * specific — without the ordering the nextTab matcher would fire first and
 * Shift+Tab would be misrouted once the user rebound one of them.
 *
 * FEAT-3 Phase 3 — every action reads tabs through the per-space selectors
 * (passing the current `currentSpaceId`) so cycling/closing only sees the
 * tabs that belong to the active space.
 */
const TAB_SHORTCUTS: ReadonlyArray<TabShortcut> = [
  {
    binding: 'openInNewTab',
    run: (state) => {
      const spaceId = useSpaceStore.getState().currentSpaceId
      const tabs = selectTabsForSpace(state, spaceId)
      const idx = selectActiveTabIndexForSpace(state, spaceId)
      const activeTab = tabs[idx]
      const top = activeTab?.pageStack[activeTab.pageStack.length - 1]
      if (top) {
        state.openInNewTab(top.pageId, top.title)
      }
    },
  },
  {
    binding: 'closeActiveTab',
    run: (state) => {
      const spaceId = useSpaceStore.getState().currentSpaceId
      state.closeTab(selectActiveTabIndexForSpace(state, spaceId))
    },
  },
  {
    binding: 'previousTab',
    run: (state) => {
      const spaceId = useSpaceStore.getState().currentSpaceId
      const tabs = selectTabsForSpace(state, spaceId)
      const idx = selectActiveTabIndexForSpace(state, spaceId)
      if (tabs.length <= 1) return
      const prev = idx === 0 ? tabs.length - 1 : idx - 1
      state.switchTab(prev)
    },
  },
  {
    binding: 'nextTab',
    run: (state) => {
      const spaceId = useSpaceStore.getState().currentSpaceId
      const tabs = selectTabsForSpace(state, spaceId)
      const idx = selectActiveTabIndexForSpace(state, spaceId)
      if (tabs.length <= 1) return
      const next = (idx + 1) % tabs.length
      state.switchTab(next)
    },
  },
]

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAppKeyboardShortcutsParams {
  /** i18next translator. Single-key calls only inside this hook. */
  readonly t: (key: string) => string
  /** Suppresses the tab-management shortcuts on touch devices (hidden TabBar). */
  readonly isMobile: boolean
}

export function useAppKeyboardShortcuts({ t, isMobile }: UseAppKeyboardShortcutsParams): void {
  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ────────────────
  // Uses keyboard-config matchers so users can rebind these (BUG-18).
  // Dispatches through JOURNAL_SHORTCUTS so the handler stays well under
  // the cognitive-complexity budget (MAINT-53).
  useEffect(() => {
    function handleJournalNav(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding Alt+Arrow doesn't spam
      // setCurrentDate / SR announcements.
      if (e.repeat) return
      if (useNavigationStore.getState().currentView !== 'journal') return
      if (isTypingInField(e.target as HTMLElement | null)) return

      const shortcut = JOURNAL_SHORTCUTS.find((s) => matchesShortcutBinding(e, s.binding))
      if (!shortcut) return

      e.preventDefault()
      const { mode, currentDate, setCurrentDate } = useJournalStore.getState()
      setCurrentDate(shortcut.nextDate(currentDate, mode))
      announce(t(shortcut.announceKey))
    }
    document.addEventListener('keydown', handleJournalNav)
    return () => document.removeEventListener('keydown', handleJournalNav)
  }, [t])

  // ── Global shortcuts (focusSearch, createNewPage, gotoConflicts) ──
  // All go through matchesShortcutBinding so rebinding in Settings takes
  // effect (BUG-18).
  useEffect(() => {
    function handleGlobalShortcuts(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding the shortcut doesn't
      // re-fire view changes / new-page creation on every keypress.
      if (e.repeat) return
      const target = e.target as HTMLElement | null
      const typingInField =
        target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      // Alt+C → jump to Conflicts view (UX-216). Only fire when not typing.
      if (matchesShortcutBinding(e, 'gotoConflicts')) {
        if (typingInField) return
        e.preventDefault()
        useNavigationStore.getState().setView('conflicts')
        announce(t('announce.conflictsOpened'))
        return
      }

      if (matchesShortcutBinding(e, 'focusSearch')) {
        e.preventDefault()
        useNavigationStore.getState().setView('search')
        announce(t('announce.searchOpened'))
        return
      }
      if (matchesShortcutBinding(e, 'createNewPage')) {
        e.preventDefault()
        // FEAT-3 Phase 2 — every page must belong to a space. Route
        // through the atomic `createPageInSpace` Tauri command. The
        // `isReady`/`currentSpaceId` check is defensive: the shortcut
        // only fires after boot has resolved `refreshAvailableSpaces()`.
        const { currentSpaceId, isReady } = useSpaceStore.getState()
        if (!isReady || currentSpaceId == null) {
          logger.warn('App', 'createNewPage shortcut fired before space hydrated')
          toast.error(t('space.notReady'))
          return
        }
        createPageInSpace({ content: 'Untitled', spaceId: currentSpaceId })
          .then((newId) => {
            useResolveStore.getState().set(newId, 'Untitled', false)
            useTabsStore.getState().navigateToPage(newId, 'Untitled')
            announce(t('announce.newPageCreated'))
          })
          .catch((err: unknown) => {
            logger.error('App', 'Failed to create page via shortcut', undefined, err)
            toast.error(t('error.createPageFailed'))
          })
      }
    }
    window.addEventListener('keydown', handleGlobalShortcuts)
    return () => window.removeEventListener('keydown', handleGlobalShortcuts)
  }, [t])

  // ── FEAT-3p11: digit hotkeys for instant space switching ──────────
  // `Ctrl+1` … `Ctrl+9` (`Cmd+1` … `Cmd+9` on macOS — `matchesShortcutBinding`
  // already accepts `metaKey` in place of `ctrlKey`) jump directly to the
  // Nth entry of `availableSpaces`, which the backend serves alphabetical
  // by name. Out-of-range digits are silent no-ops, matching every other
  // "digit-per-tab" shortcut users already know from Chrome / Slack /
  // iTerm. The handler short-circuits when typing in an INPUT, TEXTAREA,
  // or `[contenteditable]` so it never steals keystrokes from the editor
  // (which is also where the documentation-only `heading1`-`heading6`
  // entries live — they share `Ctrl + 1`-`Ctrl + 6` glyphs but aren't
  // wired to a global handler, so there is no real collision).
  useEffect(() => {
    function handleSpaceShortcuts(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding the chord doesn't
      // re-fire the space-switch on every frame.
      if (e.repeat) return
      if (isTypingInField(e.target as HTMLElement | null)) return
      for (let n = 1; n <= 9; n++) {
        if (!matchesShortcutBinding(e, `switchSpace${n}`)) continue
        e.preventDefault()
        // FEAT-3 Phase 1 — `availableSpaces` is server-truth alphabetical
        // by name. Out-of-range index is a deliberate silent no-op
        // (`Ctrl+5` with three spaces does nothing, no toast, no error).
        const { availableSpaces, currentSpaceId, setCurrentSpace } = useSpaceStore.getState()
        const target = availableSpaces[n - 1]
        if (target == null) return
        if (target.id === currentSpaceId) return
        setCurrentSpace(target.id)
        return
      }
    }
    window.addEventListener('keydown', handleSpaceShortcuts)
    return () => window.removeEventListener('keydown', handleSpaceShortcuts)
  }, [])

  // ── Global "close all overlays" shortcut (Escape by default) ────────
  // UX-228: dispatch a plain DOM CustomEvent on `window` so any top-level
  // overlay (KeyboardShortcuts sheet, WelcomeModal, future non-Radix
  // popovers) can listen and close itself. The shortcut is rebindable
  // through Settings — we route via `matchesShortcutBinding` rather than
  // hardcoding `e.key === 'Escape'`. Deliberately skipped when focus is
  // inside the block editor or an input/textarea so the key keeps its
  // native semantics there (blur, cancel suggestion, etc.).
  useEffect(() => {
    function handleCloseOverlays(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding Escape doesn't dispatch
      // the custom event / SR announcement on every keypress.
      if (e.repeat) return
      if (!matchesShortcutBinding(e, 'closeOverlays')) return
      if (isTypingInField(e.target as HTMLElement | null)) return
      e.preventDefault()
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))
      announce(t('announce.overlaysClosed'))
    }
    window.addEventListener('keydown', handleCloseOverlays)
    return () => window.removeEventListener('keydown', handleCloseOverlays)
  }, [t])

  // ── Tab shortcuts (openInNewTab, closeActiveTab, nextTab, previousTab) ──
  // Routed through matchesShortcutBinding so users can rebind (BUG-18).
  // Dispatches through TAB_SHORTCUTS so the handler stays well under the
  // cognitive-complexity budget (MAINT-54).
  //
  // FEAT-7: the TabBar is now shell-wide on desktop, so these shortcuts fire
  // from any view (not just page-editor). We still short-circuit on mobile
  // because the TabBar itself is hidden there and the shortcuts have no
  // meaningful UI affordance.
  useEffect(() => {
    function handleTabShortcuts(e: KeyboardEvent) {
      // MAINT-105: ignore auto-repeat so holding the tab-cycle shortcut
      // doesn't spin through every tab on each frame.
      if (e.repeat) return
      if (isMobile) return
      const state = useTabsStore.getState()

      const shortcut = TAB_SHORTCUTS.find((s) => matchesShortcutBinding(e, s.binding))
      if (!shortcut) return

      e.preventDefault()

      // FEAT-7 follow-up: Ctrl+T in a fresh tab (empty pageStack) would
      // silently do nothing. Surface a toast so the user gets feedback
      // instead of a silent failure. The other tab shortcuts (close,
      // next, previous) are well-defined regardless of stack state.
      // FEAT-3 Phase 3 — read the active tab through the per-space
      // selector so the toast fires when the active SPACE has no
      // open page, not just the legacy flat list.
      if (shortcut.binding === 'openInNewTab') {
        const spaceId = useSpaceStore.getState().currentSpaceId
        const tabs = selectTabsForSpace(state, spaceId)
        const idx = selectActiveTabIndexForSpace(state, spaceId)
        const activeTab = tabs[idx]
        const top = activeTab?.pageStack[activeTab.pageStack.length - 1]
        if (!top) {
          toast.error(t('tabs.openInNewTabEmpty'))
          return
        }
      }

      shortcut.run(state)
    }
    window.addEventListener('keydown', handleTabShortcuts)
    return () => window.removeEventListener('keydown', handleTabShortcuts)
  }, [isMobile, t])
}
