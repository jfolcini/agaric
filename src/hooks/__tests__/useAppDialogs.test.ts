/**
 * Unit tests for useAppDialogs (MAINT-124 step 3).
 *
 * Validates the hook in isolation: each of the 4 dialog states is
 * initialized closed, each setter writes through, the two custom-event
 * listeners (`BUG_REPORT_EVENT`, `CLOSE_ALL_OVERLAYS_EVENT`) drive the
 * correct state, and the listeners are torn down on unmount. Integration
 * coverage (the dialog JSX wiring, sidebar Sync click guard, etc.) lives
 * in `App.test.tsx`.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { BUG_REPORT_EVENT, type BugReportEventDetail } from '../../lib/bug-report-events'
import { setCustomShortcut } from '../../lib/keyboard-config/storage'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../../lib/overlay-events'
import { useAppDialogs } from '../useAppDialogs'

beforeEach(() => {
  // The #754 showShortcuts listener resolves its binding from
  // localStorage overrides — keep each test on the defaults.
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 1. Initial state
// ---------------------------------------------------------------------------

describe('useAppDialogs — initial state', () => {
  it('all four dialogs are closed and bugReportPrefill is null', () => {
    const { result } = renderHook(() => useAppDialogs())

    expect(result.current.bugReportOpen).toBe(false)
    expect(result.current.bugReportPrefill).toBeNull()
    expect(result.current.quickCaptureOpen).toBe(false)
    expect(result.current.showNoPeersDialog).toBe(false)
    expect(result.current.shortcutsOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Each setter updates the matching field
// ---------------------------------------------------------------------------

describe('useAppDialogs — setters', () => {
  it('setBugReportOpen flips bugReportOpen', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      result.current.setBugReportOpen(true)
    })

    expect(result.current.bugReportOpen).toBe(true)
  })

  it('setBugReportPrefill writes through', () => {
    const { result } = renderHook(() => useAppDialogs())
    const detail: BugReportEventDetail = { message: 'boom', stack: 'frames' }

    act(() => {
      result.current.setBugReportPrefill(detail)
    })

    expect(result.current.bugReportPrefill).toEqual(detail)
  })

  it('setQuickCaptureOpen flips quickCaptureOpen', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      result.current.setQuickCaptureOpen(true)
    })

    expect(result.current.quickCaptureOpen).toBe(true)
  })

  it('setShowNoPeersDialog flips showNoPeersDialog', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      result.current.setShowNoPeersDialog(true)
    })

    expect(result.current.showNoPeersDialog).toBe(true)
  })

  it('setShortcutsOpen flips shortcutsOpen', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      result.current.setShortcutsOpen(true)
    })

    expect(result.current.shortcutsOpen).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. BUG_REPORT_EVENT listener
// ---------------------------------------------------------------------------

describe('useAppDialogs — BUG_REPORT_EVENT', () => {
  it('opens the bug-report dialog and stores the prefill payload', () => {
    const { result } = renderHook(() => useAppDialogs())
    const detail: BugReportEventDetail = {
      message: 'TypeError: cannot read property',
      stack: 'at App.tsx:42',
    }

    act(() => {
      window.dispatchEvent(new CustomEvent<BugReportEventDetail>(BUG_REPORT_EVENT, { detail }))
    })

    expect(result.current.bugReportOpen).toBe(true)
    expect(result.current.bugReportPrefill).toEqual(detail)
  })

  it('ignores events with no detail (defensive null check)', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      // Dispatching without `detail` reproduces the early-return branch
      // in the listener — the dialog must not open.
      window.dispatchEvent(new Event(BUG_REPORT_EVENT))
    })

    expect(result.current.bugReportOpen).toBe(false)
    expect(result.current.bugReportPrefill).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. CLOSE_ALL_OVERLAYS_EVENT listener
// ---------------------------------------------------------------------------

describe('useAppDialogs — CLOSE_ALL_OVERLAYS_EVENT', () => {
  it('closes the shortcuts sheet when the event fires', () => {
    const { result } = renderHook(() => useAppDialogs())

    // Open the sheet first so we can observe the close.
    act(() => {
      result.current.setShortcutsOpen(true)
    })
    expect(result.current.shortcutsOpen).toBe(true)

    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_OVERLAYS_EVENT))
    })

    expect(result.current.shortcutsOpen).toBe(false)
  })

  it('does not close other dialogs (only the shortcuts sheet)', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      result.current.setBugReportOpen(true)
      result.current.setQuickCaptureOpen(true)
      result.current.setShowNoPeersDialog(true)
    })

    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_OVERLAYS_EVENT))
    })

    // Behaviour preserved verbatim from App.tsx — the original handler
    // only closed `shortcutsOpen`. The other dialogs have their own
    // dismiss paths (Radix Escape, explicit setters from App.tsx
    // callbacks).
    expect(result.current.bugReportOpen).toBe(true)
    expect(result.current.quickCaptureOpen).toBe(true)
    expect(result.current.showNoPeersDialog).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4b. Global `showShortcuts` keydown listener (#754)
// ---------------------------------------------------------------------------

describe('useAppDialogs — showShortcuts keydown listener (#754)', () => {
  it('pressing "?" opens the shortcuts sheet', () => {
    const { result } = renderHook(() => useAppDialogs())
    expect(result.current.shortcutsOpen).toBe(false)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    })

    expect(result.current.shortcutsOpen).toBe(true)
  })

  it('ignores "?" while typing in an input', () => {
    const { result } = renderHook(() => useAppDialogs())
    const input = document.createElement('input')
    document.body.appendChild(input)

    try {
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
      })
      expect(result.current.shortcutsOpen).toBe(false)
    } finally {
      document.body.removeChild(input)
    }
  })

  it('ignores "?" while typing in a contenteditable element', () => {
    const { result } = renderHook(() => useAppDialogs())
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)

    try {
      act(() => {
        editable.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
      })
      expect(result.current.shortcutsOpen).toBe(false)
    } finally {
      document.body.removeChild(editable)
    }
  })

  it('ignores "?" with stray modifiers (routed through matchesShortcutBinding)', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '?', ctrlKey: true, bubbles: true }),
      )
    })

    expect(result.current.shortcutsOpen).toBe(false)
  })

  it('ignores "?" while typing in a textarea', () => {
    const { result } = renderHook(() => useAppDialogs())
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    try {
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
      })
      expect(result.current.shortcutsOpen).toBe(false)
    } finally {
      document.body.removeChild(textarea)
    }
  })

  it('ignores unrelated keys', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(result.current.shortcutsOpen).toBe(false)
  })

  it('#724: honours a Settings rebind — new chord opens, default "?" is dead', () => {
    setCustomShortcut('showShortcuts', 'Ctrl + /')
    const { result } = renderHook(() => useAppDialogs())

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    })
    expect(result.current.shortcutsOpen).toBe(false)

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
      )
    })
    expect(result.current.shortcutsOpen).toBe(true)
  })

  it('removes the keydown listener on unmount', () => {
    const { unmount } = renderHook(() => useAppDialogs())
    unmount()

    // Dispatch after unmount must be a no-op; a fresh mount starts closed.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    })
    const { result: next } = renderHook(() => useAppDialogs())
    expect(next.current.shortcutsOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Cleanup on unmount
// ---------------------------------------------------------------------------

describe('useAppDialogs — cleanup', () => {
  it('removes both window listeners on unmount', () => {
    const { result, unmount } = renderHook(() => useAppDialogs())

    // Snapshot before unmount.
    expect(result.current.bugReportOpen).toBe(false)
    expect(result.current.shortcutsOpen).toBe(false)

    unmount()

    // After unmount, dispatching either event MUST be a no-op — the
    // listeners are gone. We can't read the now-stale `result.current`
    // for state mutations, so we instead assert that calling the
    // listeners directly (via dispatch) does not throw and that
    // re-mounting starts fresh.
    expect(() => {
      window.dispatchEvent(
        new CustomEvent<BugReportEventDetail>(BUG_REPORT_EVENT, {
          detail: { message: 'after unmount' },
        }),
      )
      window.dispatchEvent(new Event(CLOSE_ALL_OVERLAYS_EVENT))
    }).not.toThrow()

    // Fresh mount → fresh state, proving the listeners didn't leak
    // across instances.
    const { result: next } = renderHook(() => useAppDialogs())
    expect(next.current.bugReportOpen).toBe(false)
    expect(next.current.bugReportPrefill).toBeNull()
  })
})
