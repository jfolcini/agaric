import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isInsideEditableText,
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
  useBlockTouchLongPress,
} from '@/components/block-tree/use-block-touch-long-press'
import { haptic } from '@/lib/haptics'

vi.mock('@/lib/haptics', () => ({ haptic: vi.fn() }))

const mockedHaptic = vi.mocked(haptic)

function setup(isDragging = false) {
  const openContextMenu = vi.fn()
  const isDraggingRef = { current: isDragging }
  const hook = renderHook(() => useBlockTouchLongPress({ openContextMenu, isDraggingRef }))
  return { ...hook, openContextMenu, isDraggingRef }
}

type Hook = ReturnType<typeof setup>

function touchStart(
  hook: Hook,
  points: Array<{ x: number; y: number }>,
  extra: Record<string, unknown> = {},
) {
  act(() => {
    hook.result.current.handleTouchStart({
      touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
      ...extra,
    } as unknown as React.TouchEvent)
  })
}

function touchMove(hook: Hook, points: Array<{ x: number; y: number }>) {
  act(() => {
    hook.result.current.handleTouchMove({
      touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
    } as unknown as React.TouchEvent)
  })
}

/** Dispatch a touchend; returns whether the hook prevented its default. */
function touchEnd(hook: Hook): boolean {
  const preventDefault = vi.fn()
  act(() => {
    hook.result.current.handleTouchEnd({ preventDefault } as unknown as React.TouchEvent)
  })
  return preventDefault.mock.calls.length > 0
}

function hold(ms = LONG_PRESS_DELAY) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useBlockTouchLongPress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports the hold delay and drift threshold the drag sensor shares', () => {
    expect(LONG_PRESS_DELAY).toBe(400)
    expect(LONG_PRESS_MOVE_THRESHOLD).toBe(5)
  })

  it('returns the row handlers', () => {
    const hook = setup()
    expect(Object.keys(hook.result.current).toSorted()).toEqual([
      'handleContextMenu',
      'handleTouchEnd',
      'handleTouchMove',
      'handleTouchStart',
    ])
    hook.unmount()
  })

  // ── Hold, then the finger decides ───────────────────────────────────

  it('does not open the menu at the hold mark; the menu opens on release', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])

    hold()
    expect(hook.openContextMenu).not.toHaveBeenCalled()

    expect(touchEnd(hook)).toBe(true)
    expect(hook.openContextMenu).toHaveBeenCalledOnce()
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 200, undefined)
    hook.unmount()
  })

  // Chromium follows a tap's `touchend` with compat `mousedown` / `click`;
  // after a hold they would move focus off the menu and focus the block under
  // it. Preventing the release's default suppresses them, but only when the
  // menu opens: a plain tap must keep its click (it focuses the block).
  it('prevents the touchend default only when the release opens the menu', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold(LONG_PRESS_DELAY / 2)
    expect(touchEnd(hook)).toBe(false)

    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    touchMove(hook, [{ x: 100, y: 240 }])
    expect(touchEnd(hook)).toBe(false)

    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    expect(touchEnd(hook)).toBe(true)
    expect(hook.openContextMenu).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('ticks the haptic once when the hold is recognised, before any release', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])

    hold(LONG_PRESS_DELAY - 1)
    expect(mockedHaptic).not.toHaveBeenCalled()
    hold(1)
    expect(mockedHaptic).toHaveBeenCalledOnce()
    expect(mockedHaptic).toHaveBeenCalledWith('tick')

    touchEnd(hook)
    expect(mockedHaptic).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('opens the menu on release while a drag is active (the lift IS the drag)', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    hook.isDraggingRef.current = true
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 200, undefined)
    hook.unmount()
  })

  it('opens no menu when the finger moved past the threshold after the hold (a drag)', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    touchMove(hook, [{ x: 100, y: 200 + LONG_PRESS_MOVE_THRESHOLD + 1 }])
    touchEnd(hook)
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('still opens the menu after a post-hold jitter inside the threshold', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    // hypot(3, 2) ≈ 3.6 px — a held finger is never perfectly still.
    touchMove(hook, [{ x: 103, y: 202 }])
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 200, undefined)
    hook.unmount()
  })

  it('opens the menu at the press point, not where the finger lifted', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold()
    touchMove(hook, [{ x: 102, y: 198 }])
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 200, undefined)
    hook.unmount()
  })

  // ── Before the hold ─────────────────────────────────────────────────

  it('does not open the menu if the touch ends before the hold', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hold(LONG_PRESS_DELAY / 2)
    touchEnd(hook)
    hold()
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    expect(mockedHaptic).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('a move past the threshold before the hold cancels both the hold and the menu', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 100 }])
    touchMove(hook, [{ x: 100 + LONG_PRESS_MOVE_THRESHOLD + 1, y: 100 }])
    hold()
    expect(mockedHaptic).not.toHaveBeenCalled()
    touchEnd(hook)
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  // #927 f5: the canonical scroll conflict — a vertical scroll must never be
  // hijacked into a menu.
  it('a vertical scroll before the hold cancels (scroll intent wins)', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    touchMove(hook, [{ x: 100, y: 200 + LONG_PRESS_MOVE_THRESHOLD + 1 }])
    hold()
    touchEnd(hook)
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  // Drift is measured against the touchstart point, so several small moves
  // that individually stay inside the threshold still add up.
  it('cancels once cumulative travel passes the threshold', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    touchMove(hook, [{ x: 100, y: 205 }])
    touchMove(hook, [{ x: 100, y: 212 }])
    hold()
    touchEnd(hook)
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('a pre-hold jitter inside the threshold does not cancel', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 100 }])
    touchMove(hook, [{ x: 103, y: 102 }])
    hold()
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledOnce()
    hook.unmount()
  })

  // The drift measure is dnd-kit's own (either axis past the threshold, not
  // the radius): a diagonal (4, 4) drift the sensor tolerates must not end
  // the press, or the row would lift with no menu on release.
  it('a (4, 4) drift the drag sensor tolerates does not cancel the press', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 100 }])
    touchMove(hook, [{ x: 104, y: 104 }])
    hold()
    expect(mockedHaptic).toHaveBeenCalledOnce()
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 100, undefined)
    hook.unmount()
  })

  // ── Inside the mounted editor the native long-press owns the gesture ──
  // A stationary long-press on its text is word selection (and the touch
  // route to the selection bubble); arming the hold there wiped the selection
  // via removeAllRanges and popped the block menu over the text mid-edit.
  describe('touches inside the mounted editor', () => {
    it('never holds, ticks or opens for a touch inside a .ProseMirror contenteditable', () => {
      const hook = setup()
      const editorEl = document.createElement('div')
      editorEl.classList.add('ProseMirror')
      editorEl.setAttribute('contenteditable', 'true')
      const word = document.createElement('span')
      editorEl.append(word)
      document.body.append(editorEl)
      const removeAllRanges = vi.fn()
      const getSelectionSpy = vi
        .spyOn(window, 'getSelection')
        .mockReturnValue({ removeAllRanges } as unknown as Selection)

      touchStart(hook, [{ x: 100, y: 200 }], { target: word })
      hold()
      touchEnd(hook)

      expect(mockedHaptic).not.toHaveBeenCalled()
      expect(removeAllRanges).not.toHaveBeenCalled()
      expect(hook.openContextMenu).not.toHaveBeenCalled()

      getSelectionSpy.mockRestore()
      editorEl.remove()
      hook.unmount()
    })

    it('still opens the menu for a hold on a static (non-editable) block body', () => {
      const hook = setup()
      const staticBody = document.createElement('div')
      document.body.append(staticBody)
      touchStart(hook, [{ x: 10, y: 20 }], { target: staticBody })
      hold()
      touchEnd(hook)
      expect(hook.openContextMenu).toHaveBeenCalledWith(10, 20, undefined)
      staticBody.remove()
      hook.unmount()
    })

    it('isInsideEditableText is the shared gate for the drag activator', () => {
      const editorEl = document.createElement('div')
      editorEl.setAttribute('contenteditable', 'true')
      const inner = document.createElement('span')
      editorEl.append(inner)
      const outside = document.createElement('div')
      expect(isInsideEditableText(inner)).toBe(true)
      expect(isInsideEditableText(editorEl)).toBe(true)
      expect(isInsideEditableText(outside)).toBe(false)
      expect(isInsideEditableText(null)).toBe(false)
    })
  })

  // ── Multi-touch: two fingers are a scroll or a pinch, never a hold ──
  describe('multi-touch', () => {
    it('does not open the menu when a second finger lands during the press', () => {
      const hook = setup()
      touchStart(hook, [{ x: 100, y: 100 }])
      touchStart(hook, [
        { x: 100, y: 100 },
        { x: 140, y: 100 },
      ])
      hold(LONG_PRESS_DELAY * 2)
      touchEnd(hook)
      expect(mockedHaptic).not.toHaveBeenCalled()
      expect(hook.openContextMenu).not.toHaveBeenCalled()
      hook.unmount()
    })

    it('a second touchstart cancels the first press’s timer instead of orphaning it', () => {
      const hook = setup()
      touchStart(hook, [{ x: 100, y: 100 }])
      touchStart(hook, [
        { x: 100, y: 100 },
        { x: 140, y: 100 },
      ])
      touchMove(hook, [
        { x: 100, y: 130 },
        { x: 140, y: 130 },
      ])
      hold()
      touchEnd(hook)
      expect(hook.openContextMenu).not.toHaveBeenCalled()
      hook.unmount()
    })
  })

  it('ignores a touchstart with no touches and a move with no prior start', () => {
    const hook = setup()
    touchStart(hook, [])
    touchMove(hook, [{ x: 200, y: 200 }])
    hold()
    touchEnd(hook)
    expect(hook.openContextMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('a hold recognised before unmount opens nothing afterwards', () => {
    const hook = setup()
    touchStart(hook, [{ x: 100, y: 200 }])
    hook.unmount()
    hold()
    expect(mockedHaptic).not.toHaveBeenCalled()
  })

  // ── Links: the menu carries the pressed link's url ──────────────────

  it('passes the pressed .external-link href to the menu on release', () => {
    const hook = setup()
    const link = document.createElement('a')
    link.classList.add('external-link')
    link.setAttribute('href', 'https://example.com')
    const span = document.createElement('span')
    link.append(span)
    document.body.append(link)

    touchStart(hook, [{ x: 30, y: 40 }], { target: span })
    hold()
    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledWith(30, 40, 'https://example.com')

    link.remove()
    hook.unmount()
  })

  // ── Native contextmenu (right-click, Android long-press) ────────────

  it('handleContextMenu prevents default and opens the menu at the pointer', () => {
    const hook = setup()
    const div = document.createElement('div')
    document.body.append(div)
    const preventDefault = vi.fn()
    act(() => {
      hook.result.current.handleContextMenu({
        preventDefault,
        clientX: 300,
        clientY: 400,
        target: div,
      } as unknown as React.MouseEvent)
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(hook.openContextMenu).toHaveBeenCalledWith(300, 400, undefined)
    div.remove()
    hook.unmount()
  })

  it('handleContextMenu reads data-href when href is absent', () => {
    const hook = setup()
    const span = document.createElement('span')
    span.classList.add('external-link')
    span.setAttribute('data-href', 'https://fallback.com')
    document.body.append(span)
    act(() => {
      hook.result.current.handleContextMenu({
        preventDefault: vi.fn(),
        clientX: 50,
        clientY: 60,
        target: span,
      } as unknown as React.MouseEvent)
    })
    expect(hook.openContextMenu).toHaveBeenCalledWith(50, 60, 'https://fallback.com')
    span.remove()
    hook.unmount()
  })

  // Android WebView fires a NATIVE `contextmenu` ~500 ms into a hold, by which
  // time the drag has activated (400 ms); it must not also pop the menu.
  it('handleContextMenu suppresses the browser menu but opens nothing while a drag is active', () => {
    const hook = setup(true)
    const div = document.createElement('div')
    document.body.append(div)
    const preventDefault = vi.fn()
    act(() => {
      hook.result.current.handleContextMenu({
        preventDefault,
        clientX: 300,
        clientY: 400,
        target: div,
      } as unknown as React.MouseEvent)
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(hook.openContextMenu).not.toHaveBeenCalled()

    hook.isDraggingRef.current = false
    act(() => {
      hook.result.current.handleContextMenu({
        preventDefault: vi.fn(),
        clientX: 10,
        clientY: 20,
        target: div,
      } as unknown as React.MouseEvent)
    })
    expect(hook.openContextMenu).toHaveBeenCalledWith(10, 20, undefined)
    div.remove()
    hook.unmount()
  })

  // Android's native `contextmenu` fires at its own long-press timeout, which
  // can land before OR after the 400 ms hold; either way the finger is still
  // down, so the release must stay the one thing that opens the menu.
  it('handleContextMenu opens nothing while a touch press is pending; the release opens it once', () => {
    const hook = setup()
    const div = document.createElement('div')
    document.body.append(div)
    const contextMenuAt = (ms: number) => {
      hold(ms)
      const preventDefault = vi.fn()
      act(() => {
        hook.result.current.handleContextMenu({
          preventDefault,
          clientX: 300,
          clientY: 400,
          target: div,
        } as unknown as React.MouseEvent)
      })
      expect(preventDefault).toHaveBeenCalledOnce()
    }

    touchStart(hook, [{ x: 100, y: 200 }], { target: div })
    contextMenuAt(LONG_PRESS_DELAY - 10)
    contextMenuAt(10)
    expect(hook.openContextMenu).not.toHaveBeenCalled()

    touchEnd(hook)
    expect(hook.openContextMenu).toHaveBeenCalledOnce()
    expect(hook.openContextMenu).toHaveBeenCalledWith(100, 200, undefined)

    // The press is over: a later right-click opens as usual.
    contextMenuAt(0)
    expect(hook.openContextMenu).toHaveBeenCalledTimes(2)
    expect(hook.openContextMenu).toHaveBeenLastCalledWith(300, 400, undefined)
    div.remove()
    hook.unmount()
  })
})
