/**
 * Test doubles for driving `useViewportObserver`: an `IntersectionObserver`
 * whose callbacks fire on demand, and an animation-frame queue that runs one
 * frame at a time, so a test can watch hydration spread across frames (#5330)
 * instead of racing the real scheduler.
 *
 * Install both in `beforeEach` with `vi.stubGlobal` and clear them with
 * `vi.unstubAllGlobals()` in `afterEach`.
 */

import { vi } from 'vitest'

import type { ViewportObserver } from '@/hooks/useViewportObserver'

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

export class MockIntersectionObserver {
  callback: IOCallback
  rootMargin: string
  root: Element | Document | null
  observed = new Set<Element>()

  static instances: MockIntersectionObserver[] = []

  constructor(callback: IOCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.rootMargin = options?.rootMargin ?? '0px'
    this.root = options?.root ?? null
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

  /** Fire the callback with synthetic entries. */
  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }

  /** Report every observed element with `data-block-id` as intersecting or not. */
  reportAll(isIntersecting: boolean, height = 40): void {
    this.trigger(
      [...this.observed].map((target) => ({
        target,
        isIntersecting,
        boundingClientRect: { height } as DOMRectReadOnly,
      })),
    )
  }
}

/**
 * Replaces `requestAnimationFrame` / `cancelAnimationFrame` with a queue the
 * test drains one frame at a time. Callbacks queued while a frame runs land in
 * the NEXT frame, as in a browser.
 */
export function stubAnimationFrames(): { runFrame: () => void; pending: () => number } {
  let queue = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    queue.set(handle, cb)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    queue.delete(handle)
  })
  return {
    runFrame() {
      const frame = queue
      queue = new Map()
      for (const cb of frame.values()) cb(performance.now())
    },
    pending: () => queue.size,
  }
}

/**
 * A `ViewportObserver` whose answers never change: every row on screen, no
 * measured height, and no-op subscriptions. A test overrides the answers it
 * is about.
 */
export function staticViewport(overrides: Partial<ViewportObserver> = {}): ViewportObserver {
  return {
    isOffscreen: () => false,
    createObserveRef: () => vi.fn(),
    getHeight: () => undefined,
    subscribe: () => () => {},
    subscribeWindow: () => () => {},
    getWindowVersion: () => 0,
    ...overrides,
  }
}
