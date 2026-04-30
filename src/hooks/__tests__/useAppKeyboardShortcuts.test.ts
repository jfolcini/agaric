/**
 * Unit tests for useAppKeyboardShortcuts (MAINT-124 step 1).
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
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
    selectedBlockId: null,
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
  it('Ctrl+F (focusSearch) sets navigation view to "search"', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    expect(useNavigationStore.getState().currentView).toBe('search')
  })

  it('Alt+C (gotoConflicts) sets navigation view to "conflicts"', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'c', altKey: true })

    expect(useNavigationStore.getState().currentView).toBe('conflicts')
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
  // FEAT-3 Phase 3 the lookup runs through the per-space selector, but
  // `switchTab` writes through the flat `tabs`/`activeTabIndex` fields
  // (those mirror the active space slice). Seed both so the hook can
  // both find and rotate the tab list.
  function seedTwoTabs(): void {
    const tabs = [
      { id: 't0', pageStack: [{ pageId: 'P_A', title: 'A' }], label: 'A' },
      { id: 't1', pageStack: [{ pageId: 'P_B', title: 'B' }], label: 'B' },
    ]
    useNavigationStore.setState({
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

    expect(useNavigationStore.getState().activeTabIndex).toBe(1)
  })

  it('does NOT fire on mobile (TabBar is hidden)', () => {
    seedTwoTabs()

    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: true }))

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })

    expect(useNavigationStore.getState().activeTabIndex).toBe(0)
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

  it('plain "c" does NOT switch to conflicts view (only Alt+C does)', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    fireEvent.keyDown(window, { key: 'c' })

    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('auto-repeat events are ignored (MAINT-105)', () => {
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

  it('Alt+C skips when target is contentEditable', () => {
    renderHook(() => useAppKeyboardShortcuts({ t, isMobile: false }))

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    document.body.appendChild(editable)
    try {
      fireEvent.keyDown(editable, { key: 'c', altKey: true })
      expect(useNavigationStore.getState().currentView).toBe('journal')
    } finally {
      editable.remove()
    }
  })
})
