import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AUTO_DELETE_THRESHOLD,
  INDENT_THRESHOLD,
  OUTDENT_MAX,
  OUTDENT_THRESHOLD,
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
    // #1236: reset the simulated touch hardware so it doesn't leak to later
    // tests (useIsTouch now requires maxTouchPoints > 0 alongside coarse).
    setMaxTouchPoints(0)
  })

  /**
   * #1236: useIsTouch() now requires BOTH a coarse pointer AND
   * `navigator.maxTouchPoints > 0`. Simulating a real touch device therefore
   * needs maxTouchPoints set too (happy-dom defaults to 0 = desktop).
   */
  function setMaxTouchPoints(value: number) {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value,
      writable: true,
      configurable: true,
    })
  }

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
    setMaxTouchPoints(5)
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

  // ── #755: useIsTouch instead of per-render matchMedia ─────────────
  describe('pointer detection via useIsTouch (#755)', () => {
    /**
     * Stateful matchMedia mock that supports `change` listeners, so the
     * test can flip pointer coarseness after mount.
     */
    function mockReactivePointer(initialCoarse: boolean) {
      const listeners = new Set<(e: MediaQueryListEvent) => void>()
      let matches = initialCoarse
      const mql = {
        get matches() {
          return matches
        },
        media: '(pointer: coarse)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((type: string, cb: (e: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.add(cb)
        }),
        removeEventListener: vi.fn((type: string, cb: (e: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.delete(cb)
        }),
        dispatchEvent: vi.fn(),
      }
      window.matchMedia = vi.fn().mockReturnValue(mql)
      // #1236: real touch hardware (a 2-in-1 whose pointer mode toggles) keeps
      // maxTouchPoints > 0; only the matchMedia coarseness flips.
      setMaxTouchPoints(5)
      return {
        setCoarse(next: boolean) {
          matches = next
          for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent)
        },
      }
    }

    it('does not re-evaluate matchMedia on every render', () => {
      mockCoarsePointer()
      const { rerender, unmount } = renderHook(() => useBlockSwipeActions(vi.fn()))

      const callsAfterMount = vi.mocked(window.matchMedia).mock.calls.length

      rerender()
      rerender()
      rerender()

      // useIsTouch subscribes once on mount; re-renders must not hit
      // matchMedia again (the old code evaluated it in the render body
      // per block per render).
      expect(vi.mocked(window.matchMedia).mock.calls.length).toBe(callsAfterMount)

      unmount()
    })

    it('activates when the pointer becomes coarse after mount', () => {
      const media = mockReactivePointer(false)
      const onDelete = vi.fn()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

      // Fine pointer: gesture is ignored.
      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })
      expect(result.current.translateX).toBe(0)

      // Pointer mode flips to coarse (e.g. mouse detached on a 2-in-1).
      act(() => {
        media.setCoarse(true)
      })

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      act(() => {
        result.current.handlers.onTouchMove(touch(150, 100))
      })
      expect(result.current.translateX).toBe(-AUTO_DELETE_THRESHOLD)

      unmount()
    })

    it('deactivates when the pointer becomes fine after mount', () => {
      const media = mockReactivePointer(true)
      const onDelete = vi.fn()
      const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

      act(() => {
        media.setCoarse(false)
      })

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
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

  // ── #927 f4: swipe-to-indent / swipe-to-outdent ───────────────────
  describe('structural gestures (#927 f4)', () => {
    it('exports non-overlapping indent/outdent thresholds below the delete band', () => {
      expect(INDENT_THRESHOLD).toBe(60)
      expect(OUTDENT_THRESHOLD).toBe(60)
      expect(OUTDENT_MAX).toBe(110)
      // The whole outdent band sits clearly below the auto-delete threshold,
      // with a gap (OUTDENT_MAX < AUTO_DELETE_THRESHOLD).
      expect(OUTDENT_MAX).toBeLessThan(AUTO_DELETE_THRESHOLD)
    })

    it('right-swipe past the indent threshold calls onIndent (and not onDelete)', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()
      const onIndent = vi.fn()
      const onOutdent = vi.fn()

      const { result, unmount } = renderHook(() =>
        useBlockSwipeActions(onDelete, { onIndent, onOutdent }),
      )

      act(() => {
        result.current.handlers.onTouchStart(touch(100, 100))
      })
      // Swipe right by 80px (past INDENT_THRESHOLD = 60).
      act(() => {
        result.current.handlers.onTouchMove(touch(180, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(onIndent).toHaveBeenCalledOnce()
      expect(onDelete).not.toHaveBeenCalled()
      expect(onOutdent).not.toHaveBeenCalled()
      expect(result.current.translateX).toBe(0)

      unmount()
    })

    it('does not indent for a right-swipe below the indent threshold', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()
      const onIndent = vi.fn()

      const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete, { onIndent }))

      act(() => {
        result.current.handlers.onTouchStart(touch(100, 100))
      })
      // Swipe right by only 40px (below INDENT_THRESHOLD = 60).
      act(() => {
        result.current.handlers.onTouchMove(touch(140, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(onIndent).not.toHaveBeenCalled()
      expect(result.current.translateX).toBe(0)

      unmount()
    })

    it('short-left-swipe in the outdent band calls onOutdent (and not onDelete)', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()
      const onIndent = vi.fn()
      const onOutdent = vi.fn()

      const { result, unmount } = renderHook(() =>
        useBlockSwipeActions(onDelete, { onIndent, onOutdent }),
      )

      act(() => {
        result.current.handlers.onTouchStart(touch(300, 100))
      })
      // Swipe left by 90px — past OUTDENT_THRESHOLD (60), under OUTDENT_MAX (110).
      act(() => {
        result.current.handlers.onTouchMove(touch(210, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(onOutdent).toHaveBeenCalledOnce()
      expect(onDelete).not.toHaveBeenCalled()
      expect(onIndent).not.toHaveBeenCalled()
      expect(result.current.translateX).toBe(0)
      expect(result.current.isRevealed).toBe(false)

      unmount()
    })

    it('long-left-swipe past the delete threshold still deletes (not outdent)', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()
      const onIndent = vi.fn()
      const onOutdent = vi.fn()

      const { result, unmount } = renderHook(() =>
        useBlockSwipeActions(onDelete, { onIndent, onOutdent }),
      )

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      // Swipe left by 210px (past AUTO_DELETE_THRESHOLD = 200).
      act(() => {
        result.current.handlers.onTouchMove(touch(190, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(onDelete).toHaveBeenCalledOnce()
      expect(onOutdent).not.toHaveBeenCalled()
      expect(onIndent).not.toHaveBeenCalled()

      unmount()
    })

    it('mid-left-swipe between the outdent band and delete reveals the delete button', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()
      const onOutdent = vi.fn()

      const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete, { onOutdent }))

      act(() => {
        result.current.handlers.onTouchStart(touch(400, 100))
      })
      // Swipe left by 150px — above OUTDENT_MAX (110), below AUTO_DELETE (200).
      act(() => {
        result.current.handlers.onTouchMove(touch(250, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      // Neither structural gesture nor delete fires — the delete button is
      // revealed, exactly as the delete-only ladder behaves.
      expect(onOutdent).not.toHaveBeenCalled()
      expect(onDelete).not.toHaveBeenCalled()
      expect(result.current.isRevealed).toBe(true)
      expect(result.current.translateX).toBe(-REVEAL_THRESHOLD)

      unmount()
    })

    it('without structural handlers, a right swipe is still ignored (backward compatible)', () => {
      mockCoarsePointer()
      const onDelete = vi.fn()

      const { result, unmount } = renderHook(() => useBlockSwipeActions(onDelete))

      act(() => {
        result.current.handlers.onTouchStart(touch(100, 100))
      })
      act(() => {
        result.current.handlers.onTouchMove(touch(220, 100))
      })
      act(() => {
        result.current.handlers.onTouchEnd()
      })

      expect(result.current.translateX).toBe(0)
      expect(onDelete).not.toHaveBeenCalled()

      unmount()
    })
  })
})
