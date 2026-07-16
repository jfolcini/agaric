/**
 * Tests for `src/lib/property-change-dispatch.ts` (#2507).
 *
 * The dispatcher is the single, module-level subscriber that replaced the
 * three independent `listen('block:properties-changed')` registrations. This
 * file pins the consolidation contract:
 *
 *  (a) ONE underlying `listen()` registration no matter how many targets
 *      register — the reduced-listener property,
 *  (b) the single handler fans the event payload out to every target,
 *  (c) unregister removes a target from the fan-out,
 *  (d) the Tauri-only gate: no `listen()` outside Tauri,
 *  (e) a payload-less event is forwarded as `undefined`.
 */

import { listen } from '@tauri-apps/api/event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

// The dispatcher only registers its listener inside Tauri. Stamp the marker so
// the lazy-init path hits the mocked `listen()` above.
;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}

import {
  _resetPropertyChangeDispatchForTest,
  ensurePropertyChangeDispatch,
  EVENT_PROPERTY_CHANGED,
  type PropertyChangedPayload,
  registerPropertyChangeTarget,
} from '@/lib/property-change-dispatch'

const mockedListen = vi.mocked(listen)

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  _resetPropertyChangeDispatchForTest()
})

afterEach(() => {
  _resetPropertyChangeDispatchForTest()
})

function fire(payload: PropertyChangedPayload | undefined): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler(payload === undefined ? {} : { payload })
}

describe('property-change-dispatch', () => {
  // ------------------------------------------------------------------
  // (a) One listen() registration regardless of target count
  // ------------------------------------------------------------------
  it('registers exactly ONE underlying listen() no matter how many targets/callers', () => {
    registerPropertyChangeTarget(vi.fn())
    registerPropertyChangeTarget(vi.fn())
    ensurePropertyChangeDispatch()
    ensurePropertyChangeDispatch()
    ensurePropertyChangeDispatch()

    const propertyChangedCalls = mockedListen.mock.calls.filter(
      (c) => c[0] === EVENT_PROPERTY_CHANGED,
    )
    expect(propertyChangedCalls).toHaveLength(1)
  })

  // ------------------------------------------------------------------
  // (b) The one handler fans the payload out to every target
  // ------------------------------------------------------------------
  it('fans a single event out to every registered target with the payload', () => {
    const a = vi.fn()
    const b = vi.fn()
    registerPropertyChangeTarget(a)
    registerPropertyChangeTarget(b)
    ensurePropertyChangeDispatch()

    const payload: PropertyChangedPayload = { block_id: 'BLK01', changed_keys: ['project'] }
    fire(payload)

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(payload)
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith(payload)
  })

  // ------------------------------------------------------------------
  // (c) Unregister removes a target from the fan-out
  // ------------------------------------------------------------------
  it('stops delivering to a target after it unregisters', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unregisterA = registerPropertyChangeTarget(a)
    registerPropertyChangeTarget(b)
    ensurePropertyChangeDispatch()

    unregisterA()
    fire({ block_id: 'BLK01', changed_keys: ['x'] })

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // (d) Tauri-only gate
  // ------------------------------------------------------------------
  it('does not register a listener outside Tauri', () => {
    const win = window as unknown as { __TAURI_INTERNALS__?: object }
    const marker = win.__TAURI_INTERNALS__
    delete win.__TAURI_INTERNALS__
    try {
      ensurePropertyChangeDispatch()
      expect(mockedListen).not.toHaveBeenCalled()
    } finally {
      if (marker !== undefined) win.__TAURI_INTERNALS__ = marker
    }
  })

  // ------------------------------------------------------------------
  // (e) A payload-less event is forwarded as undefined
  // ------------------------------------------------------------------
  it('forwards a payload-less event to targets as undefined', () => {
    const a = vi.fn()
    registerPropertyChangeTarget(a)
    ensurePropertyChangeDispatch()

    fire(undefined)

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(undefined)
  })
})
