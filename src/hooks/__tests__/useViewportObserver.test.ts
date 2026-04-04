/**
 * Tests for useViewportObserver — IntersectionObserver lifecycle,
 * offscreen tracking, and height caching.
 */

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

// React 18.3 exports act; import dynamically to avoid TS issues with older type defs
// biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
let act: (cb: () => void) => void = undefined as any

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

beforeEach(async () => {
  // Suppress "The current testing environment is not configured to support act(...)"
  // biome-ignore lint/suspicious/noExplicitAny: React test env global
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  // Dynamically import act to work across React 18.3+
  const React = await import('react')
  // biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
  act = (React as any).act
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('observes elements via the observeRef callback', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = document.createElement('div')
    el.dataset.blockId = 'BLOCK_A'
    result.current.observeRef(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    expect(obs.observed.has(el)).toBe(true)

    unmount()
  })

  it('ignores null passed to observeRef', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    // Should not throw
    result.current.observeRef(null)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    expect(obs.observed.size).toBe(0)

    unmount()
  })

  it('marks a block as offscreen when not intersecting', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = document.createElement('div')
    el.dataset.blockId = 'BLOCK_A'
    result.current.observeRef(el)

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

    const el = document.createElement('div')
    el.dataset.blockId = 'BLOCK_A'
    result.current.observeRef(el)

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

    const el = document.createElement('div')
    el.dataset.blockId = 'BLOCK_A'
    result.current.observeRef(el)

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
    result.current.observeRef(el)

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

    // Nothing should be offscreen
    expect(result.current.isOffscreen('')).toBe(false)

    unmount()
  })

  it('handles multiple blocks going offscreen independently', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const elA = document.createElement('div')
    elA.dataset.blockId = 'A'
    const elB = document.createElement('div')
    elB.dataset.blockId = 'B'

    result.current.observeRef(elA)
    result.current.observeRef(elB)

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

    const el = document.createElement('div')
    el.dataset.blockId = 'A'
    result.current.observeRef(el)

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
