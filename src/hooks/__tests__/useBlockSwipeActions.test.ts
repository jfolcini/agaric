import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_DELETE_THRESHOLD,
  REVEAL_THRESHOLD,
  useBlockSwipeActions,
  VERTICAL_CANCEL_THRESHOLD,
} from '../useBlockSwipeActions'

/** Helper to build a minimal React.TouchEvent from coordinates. */
function touch(clientX: number, clientY: number) {
  return {
    touches: [{ clientX, clientY }],
  } as unknown as React.TouchEvent
}

describe('useBlockSwipeActions', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  /** Simulate a coarse-pointer device (touch screen). */
  function mockCoarsePointer() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }

  /** Simulate a fine-pointer device (mouse / desktop). */
  function mockFinePointer() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }

  it('exports correct threshold constants', () => {
    expect(REVEAL_THRESHOLD).toBe(80)
    expect(AUTO_DELETE_THRESHOLD).toBe(200)
    expect(VERTICAL_CANCEL_THRESHOLD).toBe(10)
  })

  it('returns zero translateX initially', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)

    unmount()
  })

  it('returns expected shape with handlers and reset', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    expect(typeof result.current.handlers.onTouchStart).toBe('function')
    expect(typeof result.current.handlers.onTouchMove).toBe('function')
    expect(typeof result.current.handlers.onTouchEnd).toBe('function')
    expect(typeof result.current.reset).toBe('function')
    // UX-304: progressive cue flag is exposed alongside translateX/isRevealed.
    expect(result.current.thresholdCrossed).toBe(false)

    unmount()
  })

  it('reveals delete button after >80px left swipe', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(300, 100))
    })

    // Swipe left by 100px (past REVEAL_THRESHOLD but under AUTO_DELETE_THRESHOLD)
    act(() => {
      result.current.handlers.onTouchMove(touch(200, 100))
    })

    act(() => {
      result.current.handlers.onTouchEnd()
    })

    expect(result.current.translateX).toBe(-REVEAL_THRESHOLD)
    expect(result.current.isRevealed).toBe(true)
    expect(onDelete).not.toHaveBeenCalled()

    unmount()
  })

  it('calls onDelete after >200px left swipe', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(400, 100))
    })

    // Swipe left by 210px (past AUTO_DELETE_THRESHOLD)
    act(() => {
      result.current.handlers.onTouchMove(touch(190, 100))
    })

    act(() => {
      result.current.handlers.onTouchEnd()
    })

    expect(onDelete).toHaveBeenCalledOnce()
    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)

    unmount()
  })

  it('snaps back when swipe is less than reveal threshold', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(200, 100))
    })

    // Swipe left by 50px (below REVEAL_THRESHOLD but enough to trigger swiping)
    act(() => {
      result.current.handlers.onTouchMove(touch(150, 100))
    })

    act(() => {
      result.current.handlers.onTouchEnd()
    })

    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)
    expect(onDelete).not.toHaveBeenCalled()

    unmount()
  })

  it('cancels swipe when vertical scroll exceeds 10px', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(300, 100))
    })

    // Move vertically more than VERTICAL_CANCEL_THRESHOLD before swiping starts
    act(() => {
      result.current.handlers.onTouchMove(touch(200, 115))
    })

    act(() => {
      result.current.handlers.onTouchEnd()
    })

    // Should not have entered swiping state, so translateX stays at 0
    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)
    expect(onDelete).not.toHaveBeenCalled()

    unmount()
  })

  it('reset() restores state to initial', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    // First, reveal the delete button
    act(() => {
      result.current.handlers.onTouchStart(touch(300, 100))
    })
    act(() => {
      result.current.handlers.onTouchMove(touch(200, 100))
    })
    act(() => {
      result.current.handlers.onTouchEnd()
    })

    expect(result.current.isRevealed).toBe(true)

    // Now reset
    act(() => {
      result.current.reset()
    })

    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)

    unmount()
  })

  it('is not active on fine-pointer (non-touch) devices', () => {
    mockFinePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(300, 100))
    })
    act(() => {
      result.current.handlers.onTouchMove(touch(50, 100))
    })
    act(() => {
      result.current.handlers.onTouchEnd()
    })

    // Nothing should change — hook is inactive
    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)
    expect(onDelete).not.toHaveBeenCalled()

    unmount()
  })

  it('clamps translateX to -200 during move', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(400, 100))
    })

    // Swipe way past the max
    act(() => {
      result.current.handlers.onTouchMove(touch(50, 100))
    })

    // During drag, translateX should be clamped to -AUTO_DELETE_THRESHOLD
    expect(result.current.translateX).toBe(-AUTO_DELETE_THRESHOLD)

    unmount()
  })

  it('ignores right swipe (positive dx)', () => {
    mockCoarsePointer()
    const onDelete = vi.fn()

    const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

    act(() => {
      result.current.handlers.onTouchStart(touch(100, 100))
    })

    // Swipe right
    act(() => {
      result.current.handlers.onTouchMove(touch(300, 100))
    })

    act(() => {
      result.current.handlers.onTouchEnd()
    })

    expect(result.current.translateX).toBe(0)
    expect(result.current.isRevealed).toBe(false)

    unmount()
  })

  // ── UX-304: progressive threshold-crossed cue ─────────────────────
  describe('thresholdCrossed (UX-304)', () => {
    it('stays false while swipe is between reveal and auto-delete thresholds', () => {
      mockCoarsePointer()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      // 150 px left swipe — past REVEAL_THRESHOLD, well under AUTO_DELETE_THRESHOLD.
      act(() => {
        result.current.handlers.onTouchMove(touch(250, 100))
      })

      expect(result.current.thresholdCrossed).toBe(false)

      unmount()
    })

    it('flips to true mid-drag once the auto-delete threshold is crossed', () => {
      mockCoarsePointer()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      // 250 px left swipe — past AUTO_DELETE_THRESHOLD (200).
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })

      expect(result.current.thresholdCrossed).toBe(true)

      unmount()
    })

    it('flips back to false if the user drags partway back below the threshold', () => {
      mockCoarsePointer()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      // First cross the threshold.
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })
      expect(result.current.thresholdCrossed).toBe(true)

      // Then drag back to a 150 px swipe — still revealed but no longer crossed.
      act(() => {
        result.current.handlers.onTouchMove(touch(250, 100))
      })

      expect(result.current.thresholdCrossed).toBe(false)

      unmount()
    })

    it('resets to false on touchEnd', () => {
      mockCoarsePointer()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })
      expect(result.current.thresholdCrossed).toBe(true)

      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(result.current.thresholdCrossed).toBe(false)

      unmount()
    })

    it('reset() clears thresholdCrossed alongside translateX/isRevealed', () => {
      mockCoarsePointer()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })
      // Threshold-crossed but no touchEnd yet — simulate manual reset.
      expect(result.current.thresholdCrossed).toBe(true)

      act(() => {
        result.current.reset()
      })

      expect(result.current.thresholdCrossed).toBe(false)
      expect(result.current.translateX).toBe(0)
      expect(result.current.isRevealed).toBe(false)

      unmount()
    })
  })
})
