import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useScrollRestore } from '@/hooks/useScrollRestore'

/**
 * Create a container element with a writable `scrollTop` property.
 * jsdom doesn't support real scrolling, so we simulate it.
 */
function createScrollContainer(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.append(el)
  let _scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (v: number) => {
      _scrollTop = v
    },
    configurable: true,
  })
  return el
}

/** A container whose scrollTop clamps at `max()`, as a browser's does at the content's end. */
function createClampingContainer(max: () => number): HTMLDivElement {
  const el = document.createElement('div')
  document.body.append(el)
  let _scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (v: number) => {
      _scrollTop = Math.min(v, max())
    },
    configurable: true,
  })
  return el
}

describe('useScrollRestore', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    container = createScrollContainer()
  })

  afterEach(() => {
    vi.useRealTimers()
    container.remove()
  })

  it('restores scroll position when returning to a previous view', () => {
    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    // Simulate scrolling in journal view
    act(() => {
      container.scrollTop = 200
      container.dispatchEvent(new Event('scroll'))
    })

    // Switch to pages
    rerender({ viewKey: 'pages' })

    // Process the restore rAF (pages has no saved position → 0)
    act(() => {
      vi.advanceTimersByTime(16)
    })

    // Scroll in pages view
    act(() => {
      container.scrollTop = 500
      container.dispatchEvent(new Event('scroll'))
    })

    // Switch back to journal
    rerender({ viewKey: 'journal' })

    // Process the restore rAF
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(container.scrollTop).toBe(200)
  })

  it('defaults to scroll position 0 for a new view', () => {
    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    // Scroll in journal
    act(() => {
      container.scrollTop = 300
      container.dispatchEvent(new Event('scroll'))
    })

    // Switch to search (never visited)
    rerender({ viewKey: 'search' })

    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(container.scrollTop).toBe(0)
  })

  it('does not modify scroll position on initial render', () => {
    container.scrollTop = 100

    renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    act(() => {
      vi.advanceTimersByTime(16)
    })

    // Should remain at 100, not reset to 0
    expect(container.scrollTop).toBe(100)
  })

  it('saves scroll position independently per view', () => {
    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    // Scroll journal to 150
    act(() => {
      container.scrollTop = 150
      container.dispatchEvent(new Event('scroll'))
    })

    // Switch to pages, scroll to 400
    rerender({ viewKey: 'pages' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    act(() => {
      container.scrollTop = 400
      container.dispatchEvent(new Event('scroll'))
    })

    // Switch to tags, scroll to 750
    rerender({ viewKey: 'tags' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    act(() => {
      container.scrollTop = 750
      container.dispatchEvent(new Event('scroll'))
    })

    // Return to pages — should restore 400
    rerender({ viewKey: 'pages' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(container.scrollTop).toBe(400)

    // Return to journal — should restore 150
    rerender({ viewKey: 'journal' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(container.scrollTop).toBe(150)
  })

  // #754 — the App shell's scroll viewport only mounts after the boot
  // gate resolves, so the hook's first render sees `null`. Passing the
  // element as state must re-fire the attach effect once it appears —
  // previously (RefObject signature) the first view never got a scroll
  // listener until the first navigation.
  it('attaches once the container mounts after the first render (boot view)', () => {
    const { rerender } = renderHook(
      ({ el, viewKey }: { el: HTMLElement | null; viewKey: string }) =>
        useScrollRestore(el, viewKey),
      { initialProps: { el: null as HTMLElement | null, viewKey: 'journal' } },
    )

    // Boot resolves: the viewport element appears WITHOUT a viewKey change.
    rerender({ el: container, viewKey: 'journal' })

    // Scroll the boot view — the listener must already be attached.
    act(() => {
      container.scrollTop = 250
      container.dispatchEvent(new Event('scroll'))
    })

    // Navigate away and back; the boot view's position is restored.
    rerender({ el: container, viewKey: 'pages' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    rerender({ el: container, viewKey: 'journal' })
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(container.scrollTop).toBe(250)
  })

  it('attaches a passive scroll listener', () => {
    const spy = vi.spyOn(container, 'addEventListener')

    renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })

    spy.mockRestore()
  })

  it('removes scroll listener on cleanup', () => {
    const spy = vi.spyOn(container, 'removeEventListener')

    const { unmount } = renderHook(({ viewKey }) => useScrollRestore(container, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    unmount()

    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function))

    spy.mockRestore()
  })

  it('cancels the pending restore rAF on unmount', () => {
    // Stub RAF/cAF so we can capture the id and assert cancellation.
    const rafMock = vi.fn((_cb: FrameRequestCallback) => 42)
    const cancelMock = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafMock)
    vi.stubGlobal('cancelAnimationFrame', cancelMock)

    try {
      const { rerender, unmount } = renderHook(
        ({ viewKey }) => useScrollRestore(container, viewKey),
        {
          initialProps: { viewKey: 'journal' },
        },
      )

      // Trigger the view-change branch that schedules the rAF.
      rerender({ viewKey: 'pages' })

      expect(rafMock).toHaveBeenCalledTimes(1)

      unmount()

      expect(cancelMock).toHaveBeenCalledWith(42)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('restores a position its view can only hold once the content arrives (#7040)', () => {
    let max = 1000
    const el = createClampingContainer(() => max)
    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(el, viewKey), {
      initialProps: { viewKey: 'page' },
    })
    act(() => {
      el.scrollTop = 600
      el.dispatchEvent(new Event('scroll'))
    })
    rerender({ viewKey: 'pages' })
    act(() => {
      vi.advanceTimersByTime(16)
    })

    // Back on the page, whose blocks are still loading: nothing to scroll yet.
    max = 0
    rerender({ viewKey: 'page' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(el.scrollTop).toBe(0)

    max = 1000
    act(() => {
      vi.advanceTimersByTime(32)
    })
    expect(el.scrollTop).toBe(600)
    el.remove()
  })

  it('stops restoring once the user scrolls by hand', () => {
    let max = 1000
    const el = createClampingContainer(() => max)
    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(el, viewKey), {
      initialProps: { viewKey: 'page' },
    })
    act(() => {
      el.scrollTop = 600
      el.dispatchEvent(new Event('scroll'))
    })
    rerender({ viewKey: 'pages' })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    max = 0
    rerender({ viewKey: 'page' })
    act(() => {
      vi.advanceTimersByTime(16)
      el.dispatchEvent(new Event('wheel'))
    })

    max = 1000
    act(() => {
      vi.advanceTimersByTime(32)
    })
    expect(el.scrollTop).toBe(0)
    el.remove()
  })
})
