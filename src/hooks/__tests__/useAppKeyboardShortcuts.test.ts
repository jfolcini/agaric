/**
 * Unit tests for useAppKeyboardShortcuts.
 *
 * Validates the hook in isolation: the 5 keydown listeners are installed,
 * dispatch to the right callback for each shortcut, gate correctly
 * (journal-view, mobile, typing-in-field), respect modifiers, and tear
 * down on unmount. Integration coverage (rebinding via Settings,
 * journal-mode date math) lives in `App.test.tsx`; we don't duplicate
 * those scenarios here — instead we pin the contract that the hook
 * delegates to the same `matchesShortcutBinding` matcher that App.test
 * already exercises.
 */

import { fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useJournalStore } from '../../stores/journal'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { useInPageFindStore } from '../../stores/useInPageFindStore'
import { useAppKeyboardShortcuts } from '../useAppKeyboardShortcuts'

vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Partial mock of tauri lib — only `createPageInSpace` is exercised here.
// Other lib/tauri exports are not used by the hook so we don't bother
// `importActual`.
vi.mock('../../lib/tauri', () => ({
  createPageInSpace: vi.fn(async () => 'NEW_PAGE_ID_00000000000000'),
}))

const t = (key: string): string => key

beforeEach(() => {
  vi.clearAllMocks()

  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })

  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [
      { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
      { id: 'SPACE_WORK', name: 'Work', accent_color: null },
      { id: 'SPACE_HOME', name: 'Home', accent_color: null },
    ],
    isReady: true,
  })

  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date('2025-01-15T00:00:00Z'),
  })
})

afterEach(() => {
  // Restore to keep state isolated between describe blocks.
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Each shortcut fires its callback / store action.
// ---------------------------------------------------------------------------

describe('useAppKeyboardShortcuts — global shortcuts (window listener)', () => {
  it('Ctrl+F (findInPage,) opens the in-page find toolbar', () => {
    // Reset the find store explicitly so prior test runs don't leak state.
    useInPageFindStore.setState({ open: false, query: '', lastQuery: '' })
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    // The rebind reclaims Ctrl+F for the in-page find toolbar;
    // the global search view now lives under Ctrl+Shift+F.
    expect(useInPageFindStore.getState().open).toBe(true)
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('Ctrl+Shift+F (focusSearch) sets navigation view to "search"', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })

    expect(useNavigationStore.getState().currentView).toBe('search')
  })

  it('Ctrl+. (runLastCommand) runs the most recent palette command directly (Phase 8)', async () => {
    // Seed a previously-run command under the active space.
    localStorage.setItem(
      'recent_commands:SPACE_PERSONAL',
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: '.', ctrlKey: true })

    // The command ran without opening the palette dialog.
    expect(useNavigationStore.getState().currentView).toBe('settings')
    const { useCommandPaletteStore } = await import('../../stores/useCommandPaletteStore')
    expect(useCommandPaletteStore.getState().open).toBe(false)
    // The id stays at position 0 (consecutive Cmd+. keeps running it).
    const recents = JSON.parse(localStorage.getItem('recent_commands:SPACE_PERSONAL') ?? '[]')
    expect(recents[0]?.id).toBe('go-settings')
  })

  it('Ctrl+. with no recent commands opens the palette in commands mode (Phase 8)', async () => {
    localStorage.removeItem('recent_commands:SPACE_PERSONAL')
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: '.', ctrlKey: true })

    const { useCommandPaletteStore } = await import('../../stores/useCommandPaletteStore')
    expect(useCommandPaletteStore.getState().open).toBe(true)
    expect(useCommandPaletteStore.getState().mode).toBe('commands')
  })

  it('Ctrl+. skips when typing in an input (Phase 8)', async () => {
    localStorage.setItem(
      'recent_commands:SPACE_PERSONAL',
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const navBefore = useNavigationStore.getState().currentView
      fireEvent.keyDown(input, { key: '.', ctrlKey: true })
      // Field-typing gate fires — view does not change.
      expect(useNavigationStore.getState().currentView).toBe(navBefore)
    } finally {
      input.remove()
    }
  })

  it('Ctrl+N (createNewPage) routes through createPageInSpace and navigates', async () => {
    const { createPageInSpace } = await import('../../lib/tauri')
    const mockedCreate = vi.mocked(createPageInSpace)

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    // The handler dispatches asynchronously; wait one microtask cycle.
    await Promise.resolve()
    await Promise.resolve()

    expect(mockedCreate).toHaveBeenCalledWith({
      content: 'Untitled',
      spaceId: 'SPACE_PERSONAL',
    })
  })
})

// ---------------------------------------------------------------------------
// 1b. Collision routing — context decides which handler owns a chord (#1172).
// ---------------------------------------------------------------------------

describe('useAppKeyboardShortcuts — Ctrl+K collision (palette vs editor link)', () => {
  // `tryPaletteOpen` opens the command palette OUTSIDE the editor, but yields
  // to TipTap's own Cmd+K link command when focus is inside a ProseMirror /
  // contenteditable surface (consume WITHOUT preventDefault). Both branches:

  it('OUTSIDE the editor → opens the command palette', async () => {
    const { useCommandPaletteStore } = await import('../../stores/useCommandPaletteStore')
    useCommandPaletteStore.setState({ open: false })
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    // Dispatch from a plain (non-editor) element so `isFocusInsideEditor`
    // runs `target.closest(...)` and finds no ProseMirror ancestor — the
    // bubbling event still reaches the window-level listener.
    const div = document.createElement('div')
    document.body.appendChild(div)
    try {
      div.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
      )
      expect(useCommandPaletteStore.getState().open).toBe(true)
    } finally {
      div.remove()
    }
  })

  it('INSIDE the editor → does NOT open the palette (editor owns the link command)', async () => {
    const { useCommandPaletteStore } = await import('../../stores/useCommandPaletteStore')
    useCommandPaletteStore.setState({ open: false })
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    // A contenteditable ProseMirror surface as the event target.
    const pm = document.createElement('div')
    pm.className = 'ProseMirror'
    pm.setAttribute('contenteditable', 'true')
    document.body.appendChild(pm)
    try {
      const e = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      pm.dispatchEvent(e)
      // Palette stays closed AND the event is NOT prevented — so the editor's
      // own Cmd+K link keymap can still act on it.
      expect(useCommandPaletteStore.getState().open).toBe(false)
      expect(e.defaultPrevented).toBe(false)
    } finally {
      pm.remove()
    }
  })
})

describe('useAppKeyboardShortcuts — Ctrl+. collision (runLastCommand vs collapseExpand)', () => {
  // `tryRunLastCommand` owns Ctrl+. OUTSIDE a field; when typing in a field
  // (i.e. inside the block editor, where the BlockTree document listener owns
  // `collapseExpand`) it consumes the event WITHOUT preventDefault so the
  // editor chord still fires. The outside-field branch (runs the command) is
  // covered above; here we pin the in-field yield contract.
  it('inside a field → does NOT preventDefault (yields Ctrl+. to collapseExpand)', () => {
    localStorage.setItem(
      'recent_commands:SPACE_PERSONAL',
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const navBefore = useNavigationStore.getState().currentView
      const e = new KeyboardEvent('keydown', {
        key: '.',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      input.dispatchEvent(e)
      // No command ran (view unchanged) and the chord passes through to the
      // editor's collapse/expand handler.
      expect(useNavigationStore.getState().currentView).toBe(navBefore)
      expect(e.defaultPrevented).toBe(false)
    } finally {
      input.remove()
    }
  })
})

describe('useAppKeyboardShortcuts — journal nav (document listener)', () => {
  it('Alt+ArrowRight advances the journal date in daily mode', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

    const { currentDate } = useJournalStore.getState()
    // Daily mode → +1 day.
    expect(currentDate.toISOString().slice(0, 10)).toBe('2025-01-16')
  })

  it('Alt+ArrowLeft moves the journal date back in daily mode', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

    const { currentDate } = useJournalStore.getState()
    expect(currentDate.toISOString().slice(0, 10)).toBe('2025-01-14')
  })

  it('Alt+T jumps to today', () => {
    // Pin the date so the assertion is deterministic.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-30T12:00:00Z'))

    try {
      renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

      fireEvent.keyDown(document, { key: 't', altKey: true })

      const { currentDate } = useJournalStore.getState()
      expect(currentDate.toISOString().slice(0, 10)).toBe('2025-06-30')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT fire when currentView !== "journal"', () => {
    useNavigationStore.setState({ currentView: 'pages' })
    const initial = useJournalStore.getState().currentDate

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

    expect(useJournalStore.getState().currentDate).toBe(initial)
  })
})

describe('useAppKeyboardShortcuts — space digit hotkeys', () => {
  it('Ctrl+2 switches to the second alphabetical space', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: '2', ctrlKey: true })

    // The seeded availableSpaces order in beforeEach is the order set
    // by the test (NOT alphabetical) — the production app sorts on the
    // backend; here we just assert the hook indexes into the array
    // verbatim, which is what the original effect did.
    expect(useSpaceStore.getState().currentSpaceId).toBe('SPACE_WORK')
  })

  it('out-of-range Ctrl+9 with three spaces is a silent no-op', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: '9', ctrlKey: true })

    // Still on the original space, no toast, no error.
    expect(useSpaceStore.getState().currentSpaceId).toBe('SPACE_PERSONAL')
  })

  // #1172 — only Ctrl+2 was exercised before; parametrize all nine digit
  // hotkeys against a full nine-space roster so every `switchSpace{n}` →
  // `availableSpaces[n-1]` index is pinned (the verbatim-array contract).
  describe('switchSpace1..9 — each digit indexes into availableSpaces', () => {
    /** Nine spaces; index 0 is the current one so 2..9 are distinct switches. */
    function seedNineSpaces(): void {
      const availableSpaces = Array.from({ length: 9 }, (_, i) => ({
        id: `SPACE_${i + 1}`,
        name: `Space ${i + 1}`,
        accent_color: null,
      }))
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_1',
        availableSpaces,
        isReady: true,
      })
    }

    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9] as const)(
      'Ctrl+%i switches to availableSpaces[%i - 1]',
      (n) => {
        seedNineSpaces()
        const setCurrentSpace = vi.fn()
        useSpaceStore.setState({ setCurrentSpace })
        renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

        fireEvent.keyDown(window, { key: String(n), ctrlKey: true })

        if (n === 1) {
          // Ctrl+1 targets the already-active space → no re-fetch.
          expect(setCurrentSpace).not.toHaveBeenCalled()
        } else {
          expect(setCurrentSpace).toHaveBeenCalledTimes(1)
          expect(setCurrentSpace).toHaveBeenCalledWith(`SPACE_${n}`)
        }
      },
    )

    it('Ctrl+9 with only five spaces is an out-of-range silent no-op', () => {
      const availableSpaces = Array.from({ length: 5 }, (_, i) => ({
        id: `SPACE_${i + 1}`,
        name: `Space ${i + 1}`,
        accent_color: null,
      }))
      const setCurrentSpace = vi.fn()
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_1',
        availableSpaces,
        isReady: true,
        setCurrentSpace,
      })
      renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

      fireEvent.keyDown(window, { key: '9', ctrlKey: true })

      expect(setCurrentSpace).not.toHaveBeenCalled()
    })

    it('digit hotkey is suppressed while typing in a field (so it never steals heading/editor keys)', () => {
      seedNineSpaces()
      const setCurrentSpace = vi.fn()
      useSpaceStore.setState({ setCurrentSpace })
      renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

      const input = document.createElement('input')
      document.body.appendChild(input)
      try {
        fireEvent.keyDown(input, { key: '3', ctrlKey: true })
        expect(setCurrentSpace).not.toHaveBeenCalled()
      } finally {
        input.remove()
      }
    })
  })

  it('Ctrl+1 on the already-active space is a no-op (avoids re-fetch)', () => {
    const setCurrentSpace = vi.fn()
    useSpaceStore.setState({ setCurrentSpace })

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: '1', ctrlKey: true })

    expect(setCurrentSpace).not.toHaveBeenCalled()
  })
})

describe('useAppKeyboardShortcuts — close-overlays', () => {
  it('Escape dispatches CLOSE_ALL_OVERLAYS_EVENT on window', async () => {
    const { CLOSE_ALL_OVERLAYS_EVENT } = await import('../../lib/overlay-events')
    const listener = vi.fn()
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, listener)

    try {
      renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, listener)
    }
  })
})

describe('useAppKeyboardShortcuts — tab shortcuts', () => {
  // Phase 3 the lookup runs through the per-space selector, but
  // `switchTab` writes through the flat `tabs`/`activeTabIndex` fields
  // (those mirror the active space slice). Seed both so the hook can
  // both find and rotate the tab list.
  function seedTwoTabs(): void {
    const tabs = [
      { id: 't0', pageStack: [{ pageId: 'P_A', title: 'A' }], label: 'A' },
      { id: 't1', pageStack: [{ pageId: 'P_B', title: 'B' }], label: 'B' },
    ]
    useTabsStore.setState({
      tabs,
      activeTabIndex: 0,
      tabsBySpace: { SPACE_PERSONAL: tabs },
      activeTabIndexBySpace: { SPACE_PERSONAL: 0 },
    })
  }

  it('Ctrl+Tab cycles to the next tab when there is more than one tab', () => {
    seedTwoTabs()

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })

    expect(useTabsStore.getState().activeTabIndex).toBe(1)
  })

  it('does NOT fire on mobile (TabBar is hidden)', () => {
    seedTwoTabs()

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: true }))

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })

    expect(useTabsStore.getState().activeTabIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Cleanup on unmount.
// ---------------------------------------------------------------------------

describe('useAppKeyboardShortcuts — cleanup', () => {
  it('removes every keydown listener on unmount', () => {
    const { unmount } = renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    unmount()

    // After unmount, dispatching any of the matching keys MUST be a no-op
    // for every category. We verify with the global Ctrl+F shortcut and
    // the document-level journal nav, which together prove both window
    // and document listeners were torn down.
    useNavigationStore.setState({ currentView: 'journal' })
    const initialView = useNavigationStore.getState().currentView
    const initialDate = useJournalStore.getState().currentDate

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

    expect(useNavigationStore.getState().currentView).toBe(initialView)
    expect(useJournalStore.getState().currentDate).toBe(initialDate)
  })
})

// ---------------------------------------------------------------------------
// 3. Modifier-respecting shortcuts.
// ---------------------------------------------------------------------------

describe('useAppKeyboardShortcuts — modifier discipline', () => {
  it('plain "f" does NOT switch to search view (only Ctrl+F does)', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'f' })

    // Original currentView is 'journal' from beforeEach.
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('auto-repeat events are ignored', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, repeat: true })

    expect(useNavigationStore.getState().currentView).toBe('journal')
  })
})

// ---------------------------------------------------------------------------
// 4. Typing-in-field gating.
// ---------------------------------------------------------------------------

describe('useAppKeyboardShortcuts — typing-in-field gating', () => {
  it('journal nav skips when target is INPUT', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const initial = useJournalStore.getState().currentDate
      fireEvent.keyDown(input, { key: 'ArrowRight', altKey: true })
      expect(useJournalStore.getState().currentDate).toBe(initial)
    } finally {
      input.remove()
    }
  })
})
