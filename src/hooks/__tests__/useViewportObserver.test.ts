/**
 * Tests for useViewportObserver — IntersectionObserver lifecycle,
 * offscreen tracking, height caching, and per-id unobserve on null
 * Ref transitions (regression).
 */

import { act } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewportObserver } from '../useViewportObserver'
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

  // ── #755: first-commit observe gap ─────────────────────────────────────────

  it('observes elements whose refs attach during the first commit, before the observer exists (#755)', () => {
    // Ref callbacks fire during commit; the IntersectionObserver is only
    // created in the passive effect that runs *after* commit. Elements
    // mounted in the hook's first commit must be caught up when the
    // observer is created.
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root

    function TestComponent(): ReturnType<typeof createElement> {
      const viewport = useViewportObserver()
      return createElement('div', {
        ref: viewport.createObserveRef('FIRST_COMMIT'),
        'data-block-id': 'FIRST_COMMIT',
      })
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(TestComponent))
    })

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const el = container.querySelector('[data-block-id="FIRST_COMMIT"]') as Element
    expect(el).not.toBeNull()
    expect(obs.observed.has(el)).toBe(true)

    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('re-observes tracked elements when a rootMargin change rebuilds the observer (#755)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root

    function TestComponent({ margin }: { margin: string }): ReturnType<typeof createElement> {
      const viewport = useViewportObserver(margin)
      return createElement('div', {
        ref: viewport.createObserveRef('REBUILD'),
        'data-block-id': 'REBUILD',
      })
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(TestComponent, { margin: '200px 0px' }))
    })
    act(() => {
      root.render(createElement(TestComponent, { margin: '50px 0px' }))
    })

    // Old observer disconnected, new one created with the element carried over.
    expect(MockIntersectionObserver.instances).toHaveLength(2)
    const fresh = MockIntersectionObserver.instances[1] as MockIntersectionObserver
    const el = container.querySelector('[data-block-id="REBUILD"]') as Element
    expect(fresh.rootMargin).toBe('50px 0px')
    expect(fresh.observed.has(el)).toBe(true)

    act(() => {
      root.unmount()
    })
    container.remove()
  })

  // ── regression: per-id unobserve on null transition ────────────────

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

  // ── #838: callback memo map must not leak ──────────────────────────────────

  it('keeps stable ref-callback identity for a still-present id across re-renders (#838)', () => {
    // The leak fix must not regress the stable-identity contract: an id that
    // stays mounted across renders must get the *same* callback identity so
    // React never churns observe/unobserve.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const first = result.current.createObserveRef('STABLE')
    const el = makeEl('STABLE')
    first(el)

    // Re-request across (simulated) renders while the id is still present.
    const second = result.current.createObserveRef('STABLE')
    const third = result.current.createObserveRef('STABLE')

    expect(second).toBe(first)
    expect(third).toBe(first)

    unmount()
  })

  it('prunes the callback memo entry when an id disappears (no unbounded growth) (#838)', async () => {
    // Reaching into the internals would couple the test to the field name;
    // instead we prove the prune behaviourally: after a block unmounts (its
    // ref fires null), re-requesting the ref for that id yields a *fresh*
    // callback — which can only happen if the prior entry was dropped. An id
    // that never disappeared would keep returning the memoized callback.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const before = result.current.createObserveRef('GONE')
    const el = makeEl('GONE')
    before(el)

    // Sanity: still memoized while present.
    expect(result.current.createObserveRef('GONE')).toBe(before)

    // Block leaves the tree.
    before(null)

    // The prune is deferred to a microtask (so a transient null can cancel it);
    // flush it. 'GONE' never re-attaches, so the entry is dropped.
    await Promise.resolve()

    // Entry was pruned → a re-request builds a new callback identity.
    const after = result.current.createObserveRef('GONE')
    expect(after).not.toBe(before)

    unmount()
  })

  it('keeps stable identity across a StrictMode-style detach/reattach of a present id (#838)', () => {
    // React 19 StrictMode (and keyed-list / suspense reconciliation) can fire the
    // ref as el → null → el for a node that is STILL PRESENT. The transient null
    // here is NOT an unmount. If the prune deletes the memoized callback on this
    // transient null, the very next createObserveRef(id) hands React a NEW
    // function identity → React re-runs el→null→el → infinite observe/unobserve
    // churn and a broken stable-identity contract.
    const { result, unmount } = renderHook(() => useViewportObserver())
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const observeSpy = vi.spyOn(obs, 'observe')

    const cb = result.current.createObserveRef('PRESENT')
    const el1 = makeEl('PRESENT')
    const el2 = makeEl('PRESENT')

    // StrictMode mount cycle for a present node: attach, detach, re-attach.
    cb(el1)
    cb(null)
    cb(el2)

    // The id is still present (el2 attached). Re-requesting its ref across a
    // subsequent render MUST return the SAME callback identity — otherwise the
    // ref churns. This is the stable-identity contract the leak fix must keep.
    const again = result.current.createObserveRef('PRESENT')
    expect(again).toBe(cb)

    // And el2 must remain observed (no orphaned observe/unobserve churn).
    expect(obs.observed.has(el2)).toBe(true)
    expect(observeSpy).toHaveBeenCalledWith(el2)

    unmount()
  })

  it('does not grow the callback map across many page-switch cycles (#838)', async () => {
    // Simulate a long session: each "page" mounts a fresh set of block ids,
    // then every block unmounts (ref(null)) before the next page mounts. If
    // the memo map leaked, identities of *new, distinct* ids would be the
    // only thing accumulating; we assert the per-page churn fully releases by
    // checking that a re-mounted id from an earlier page is treated as new.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const idsForPage = (page: number): string[] => [`P${page}_A`, `P${page}_B`, `P${page}_C`]

    let firstPageRef!: (el: HTMLElement | null) => void
    for (let page = 0; page < 50; page++) {
      const refs = idsForPage(page).map((id) => {
        const ref = result.current.createObserveRef(id)
        ref(makeEl(id))
        if (page === 0 && id === 'P0_A') firstPageRef = ref
        return ref
      })
      // Unmount the whole page before the next one mounts.
      for (const ref of refs) ref(null)
    }

    // Flush the deferred microtask prunes queued by every ref(null) above.
    await Promise.resolve()

    // P0_A was pruned long ago; requesting it now must yield a fresh callback,
    // proving stale entries did not survive (the map did not grow unbounded).
    const reRequested = result.current.createObserveRef('P0_A')
    expect(reRequested).not.toBe(firstPageRef)

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

  // ── #1067: viewport object identity stability ─────────────────────────────

  it('keeps a STABLE viewport object identity across offscreen flips (#1067)', () => {
    // The whole point of the fix: off-screen membership lives in a ref +
    // per-id subscription, NOT React state, so the memoized `viewport` object
    // returned to the parent never changes identity. A churning identity here
    // is what previously invalidated ALL N React.memo'd wrappers per scroll
    // tick.
    const renders: ViewportObserver[] = []
    const { result, unmount } = renderHook(() => {
      const v = useViewportObserver()
      renders.push(v)
      return v
    })

    const elA = makeEl('A')
    const elB = makeEl('B')
    result.current.createObserveRef('A')(elA)
    result.current.createObserveRef('B')(elB)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver
    const initial = result.current

    // Flip A offscreen.
    act(() => {
      obs.trigger([
        {
          target: elA,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })
    // Flip B offscreen, then A back onscreen — several membership changes.
    act(() => {
      obs.trigger([
        {
          target: elB,
          isIntersecting: false,
          boundingClientRect: { height: 40 } as DOMRectReadOnly,
        },
        {
          target: elA,
          isIntersecting: true,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    // Membership state is still correct…
    expect(result.current.isOffscreen('A')).toBe(false)
    expect(result.current.isOffscreen('B')).toBe(true)
    // …but the viewport object identity never changed across all those flips.
    expect(result.current).toBe(initial)
    // And the hook never re-rendered from the membership changes (ref-backed,
    // not React state). Only the initial render(s) recorded an identity.
    expect(renders.every((v) => v === initial)).toBe(true)

    unmount()
  })

  it('notifies ONLY the flipped block id subscriber, not others (#1067)', () => {
    // Each wrapper subscribes per id (useSyncExternalStore). A flip of block A
    // must notify A's subscriber and leave B's untouched — that is what makes
    // only A's row re-render.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const elA = makeEl('A')
    const elB = makeEl('B')
    result.current.createObserveRef('A')(elA)
    result.current.createObserveRef('B')(elB)

    const notifiedA = vi.fn()
    const notifiedB = vi.fn()
    const unsubA = result.current.subscribe('A', notifiedA)
    const unsubB = result.current.subscribe('B', notifiedB)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // Only A flips offscreen.
    act(() => {
      obs.trigger([
        {
          target: elA,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    expect(notifiedA).toHaveBeenCalledTimes(1)
    expect(notifiedB).not.toHaveBeenCalled()

    // A no-op (A already offscreen) must not re-notify.
    act(() => {
      obs.trigger([
        {
          target: elA,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })
    expect(notifiedA).toHaveBeenCalledTimes(1)

    unsubA()
    unsubB()
    unmount()
  })

  it('the subscribe source reflects the latest isOffscreen snapshot (#1067)', () => {
    // The subscribe/isOffscreen pair is a useSyncExternalStore source: when the
    // subscriber fires, the snapshot must already read the new value.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('A')
    result.current.createObserveRef('A')(el)

    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    let snapshotAtNotify: boolean | undefined
    const unsub = result.current.subscribe('A', () => {
      snapshotAtNotify = result.current.isOffscreen('A')
    })

    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    expect(snapshotAtNotify).toBe(true)

    unsub()
    unmount()
  })

  it('stops notifying after unsubscribe (#1067)', () => {
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('A')
    result.current.createObserveRef('A')(el)
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    const cb = vi.fn()
    const unsub = result.current.subscribe('A', cb)
    unsub()

    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    expect(cb).not.toHaveBeenCalled()

    unmount()
  })

  it('notifies a still-mounted subscriber when its block unmounts (clears offscreen) (#1067)', () => {
    // When a block leaves the tree its membership is cleared; a subscriber that
    // is still attached for that id must be notified so its snapshot updates.
    const { result, unmount } = renderHook(() => useViewportObserver())

    const el = makeEl('A')
    const ref = result.current.createObserveRef('A')
    ref(el)
    const obs = MockIntersectionObserver.instances[0] as MockIntersectionObserver

    // Go offscreen.
    act(() => {
      obs.trigger([
        {
          target: el,
          isIntersecting: false,
          boundingClientRect: { height: 30 } as DOMRectReadOnly,
        },
      ])
    })

    const cb = vi.fn()
    const unsub = result.current.subscribe('A', cb)

    // Block unmounts → membership cleared → subscriber notified.
    act(() => {
      ref(null)
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(result.current.isOffscreen('A')).toBe(false)

    unsub()
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
