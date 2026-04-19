/**
 * Tests for useViewportObserver — IntersectionObserver lifecycle,
 * offscreen tracking, height caching, and per-id unobserve on null
 * ref transitions (BUG-29 regression).
 */

import { act } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewportObserver } from '../useViewportObserver'

// -- IntersectionObserver mock ------------------------------------------------

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

class MockIntersectionObserver {
  callback: IOCallback
  rootMargin: string
  observed: Set<Element> = new Set()

  static instances: MockIntersectionObserver[] = []

  constructor(callback: IOCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.rootMargin = options?.rootMargin ?? '0px'
    MockIntersectionObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.observed.add(el)
  }

  unobserve(el: Element): void {
    this.observed.delete(el)
  }

  disconnect(): void {
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Test helper — fire the callback with synthetic entries. */
  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

// -- Minimal renderHook (no external deps needed) -----------------------------

function renderHook<T>(hookFn: () => T): {
  result: { current: T }
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root

  const result = { current: undefined as unknown as T }

  function TestComponent(): null {
    result.current = hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    result,
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

// -- Setup / teardown ---------------------------------------------------------

beforeEach(() => {
  // Suppress "The current testing environment is not configured to support act(...)"
  // biome-ignore lint/suspicious/noExplicitAny: React test env global
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Test helper — build a DOM element with a data-block-id matching `id`. */
function makeEl(id: string): HTMLElement {
  const el = document.createElement('div')
  el.dataset['blockId'] = id
  return el
}

// -- Tests --------------------------------------------------------------------

describe('useViewportObserver', () => {
  it('creates an IntersectionObserver with default rootMargin', () => {
    const { unmount } = renderHook(() => useViewportObserver())

    expect(MockIntersectionObserver.instances).toHaveLength(1)
    expect(MockIntersectionObserver.instances[0]?.rootMargin).toBe('200px 0px')

    unmount()
  })

  it('accepts a custom rootMargin', () => {
    const { unmount } = renderHook(() => useViewportObserver('100px 0px'))

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    expect(obs.rootMargin).toBe('100px 0px')

    unmount()
  })

  it('disconnects the observer on unmount', () => {
    const { unmount } = renderHook(() => useViewportObserver())

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const spy = vi.spyOn(obs, 'disconnect')

    unmount()

    expect(spy).toHaveBeenCalledOnce()
  })

  it('observes an element via the createObserveRef(id) callback', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('BLOCK_A')
    result.current.createObserveRef('BLOCK_A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    expect(obs.observed.has(el)).toBe(true)

    unmount()
  })

  it('ignores null when no element has been observed for that id', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    // Should not throw
    result.current.createObserveRef('BLOCK_A')(null)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    expect(obs.observed.size).toBe(0)

    unmount()
  })

  it('returns the same ref callback for the same id across renders', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const first = result.current.createObserveRef('BLOCK_A')
    const second = result.current.createObserveRef('BLOCK_A')

    // Memoized — identity equality is what React relies on to avoid
    // observe/unobserve churn on each render.
    expect(second).toBe(first)

    unmount()
  })

  it('returns a distinct ref callback for each id', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const refA = result.current.createObserveRef('BLOCK_A')
    const refB = result.current.createObserveRef('BLOCK_B')

    expect(refA).not.toBe(refB)

    unmount()
  })

  // ── BUG-29 regression: per-id unobserve on null transition ────────────────

  it('unobserves exactly the unmounted element when one of many blocks unmounts', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const observeSpy = vi.spyOn(obs, 'observe')
    const unobserveSpy = vi.spyOn(obs, 'unobserve')

    // Seed three distinct elements via distinct per-id ref callbacks
    const elA = makeEl('A')
    const elB = makeEl('B')
    const elC = makeEl('C')
    const refA = result.current.createObserveRef('A')
    const refB = result.current.createObserveRef('B')
    const refC = result.current.createObserveRef('C')
    refA(elA)
    refB(elB)
    refC(elC)

    expect(observeSpy).toHaveBeenCalledTimes(3)
    expect(observeSpy).toHaveBeenNthCalledWith(1, elA)
    expect(observeSpy).toHaveBeenNthCalledWith(2, elB)
    expect(observeSpy).toHaveBeenNthCalledWith(3, elC)
    expect(unobserveSpy).toHaveBeenCalledTimes(0)

    // Unmount only B
    refB(null)

    expect(unobserveSpy).toHaveBeenCalledTimes(1)
    expect(unobserveSpy).toHaveBeenCalledWith(elB)
    // A and C are still observed
    expect(obs.observed.has(elA)).toBe(true)
    expect(obs.observed.has(elB)).toBe(false)
    expect(obs.observed.has(elC)).toBe(true)

    unmount()
  })

  it('re-observes a fresh element when the same id mounts again after null', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const observeSpy = vi.spyOn(obs, 'observe')
    const unobserveSpy = vi.spyOn(obs, 'unobserve')

    const ref = result.current.createObserveRef('BLOCK_A')
    const first = makeEl('BLOCK_A')
    const second = makeEl('BLOCK_A')

    ref(first)
    ref(null)
    ref(second)

    expect(observeSpy).toHaveBeenCalledTimes(2)
    expect(observeSpy).toHaveBeenNthCalledWith(1, first)
    expect(observeSpy).toHaveBeenNthCalledWith(2, second)
    expect(unobserveSpy).toHaveBeenCalledTimes(1)
    expect(unobserveSpy).toHaveBeenCalledWith(first)

    unmount()
  })

  it('unobserves the stale element when a new element is installed without a null in between', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const unobserveSpy = vi.spyOn(obs, 'unobserve')

    const ref = result.current.createObserveRef('BLOCK_A')
    const first = makeEl('BLOCK_A')
    const second = makeEl('BLOCK_A')

    ref(first)
    // React sometimes swaps DOM nodes without firing the ref with null
    // first (e.g., keyed list reorder). The factory must defensively
    // unobserve the previous element.
    ref(second)

    expect(unobserveSpy).toHaveBeenCalledTimes(1)
    expect(unobserveSpy).toHaveBeenCalledWith(first)
    expect(obs.observed.has(second)).toBe(true)

    unmount()
  })

  it('clears stale offscreen and height state when a block unmounts', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())
    const ref = result.current.createObserveRef('BLOCK_A')
    const el = makeEl('BLOCK_A')
    ref(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // Mark offscreen, cache height
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 77 } as DOMRectReadOnly,
        },
      ])
    })
    expect(result.current.isOffscreen('BLOCK_A')).toBe(true)
    expect(result.current.getHeight('BLOCK_A')).toBe(77)

    // Unmount → stale per-id state must be cleared
    act(() => {
      ref(null)
    })

    expect(result.current.isOffscreen('BLOCK_A')).toBe(false)
    expect(result.current.getHeight('BLOCK_A')).toBeUndefined()

    unmount()
  })

  // ── Offscreen / height tracking ────────────────────────────────────────────

  it('marks a block as offscreen when not intersecting', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('BLOCK_A')
    result.current.createObserveRef('BLOCK_A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 42 } as DOMRectReadOnly,
        },
      ])
    })

    expect(result.current.isOffscreen('BLOCK_A')).toBe(true)

    unmount()
  })

  it('caches height when a block goes offscreen', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('BLOCK_A')
    result.current.createObserveRef('BLOCK_A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 99 } as DOMRectReadOnly,
        },
      ])
    })

    expect(result.current.getHeight('BLOCK_A')).toBe(99)

    unmount()
  })

  it('marks a block as visible when it becomes intersecting again', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('BLOCK_A')
    result.current.createObserveRef('BLOCK_A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // Go offscreen
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 42 } as DOMRectReadOnly,
        },
      ])
    })
    expect(result.current.isOffscreen('BLOCK_A')).toBe(true)

    // Come back
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: true,
          boundingClientRect: { height: 42 } as DOMRectReadOnly,
        },
      ])
    })
    expect(result.current.isOffscreen('BLOCK_A')).toBe(false)

    unmount()
  })

  it('returns undefined height for an unknown block', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    expect(result.current.getHeight('UNKNOWN')).toBeUndefined()

    unmount()
  })

  it('skips entries without a data-block-id attribute', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = document.createElement('div') // no dataset.blockId
    result.current.createObserveRef('BLOCK_A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 42 } as DOMRectReadOnly,
        },
      ])
    })

    // Nothing should be offscreen — observer callback keys on data-block-id
    expect(result.current.isOffscreen('')).toBe(false)
    expect(result.current.isOffscreen('BLOCK_A')).toBe(false)

    unmount()
  })

  it('handles multiple blocks going offscreen independently', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const elA = makeEl('A')
    const elB = makeEl('B')

    result.current.createObserveRef('A')(elA)
    result.current.createObserveRef('B')(elB)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // A goes offscreen, B stays visible
    act(() => {
      obs.trigger([
        {
          target: elA,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
        {
          target: elB,
          isIntersecting: true,
          boundingClientRect: { height: 50 } as DOMRectReadOnly,
        },
      ])
    })

    expect(result.current.isOffscreen('A')).toBe(true)
    expect(result.current.isOffscreen('B')).toBe(false)
    expect(result.current.getHeight('A')).toBe(30)

    unmount()
  })

  it('does not trigger unnecessary state updates when nothing changes', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('A')
    result.current.createObserveRef('A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // Block is already visible (default), trigger intersecting — should be a no-op
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: true,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    expect(result.current.isOffscreen('A')).toBe(false)

    unmount()
  })
})
