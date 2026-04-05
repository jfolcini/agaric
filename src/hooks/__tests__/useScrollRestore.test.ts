import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollRestore } from '../useScrollRestore'

/**
 * Create a container element with a writable `scrollTop` property.
 * jsdom doesn't support real scrolling, so we simulate it.
 */
function createScrollContainer(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
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
    const ref = { current: container }

    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
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
    const ref = { current: container }

    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
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
    const ref = { current: container }
    container.scrollTop = 100

    renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    act(() => {
      vi.advanceTimersByTime(16)
    })

    // Should remain at 100, not reset to 0
    expect(container.scrollTop).toBe(100)
  })

  it('saves scroll position independently per view', () => {
    const ref = { current: container }

    const { rerender } = renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
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

  it('attaches a passive scroll listener', () => {
    const ref = { current: container }
    const spy = vi.spyOn(container, 'addEventListener')

    renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })

    spy.mockRestore()
  })

  it('removes scroll listener on cleanup', () => {
    const ref = { current: container }
    const spy = vi.spyOn(container, 'removeEventListener')

    const { unmount } = renderHook(({ viewKey }) => useScrollRestore(ref, viewKey), {
      initialProps: { viewKey: 'journal' },
    })

    unmount()

    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function))

    spy.mockRestore()
  })
})
