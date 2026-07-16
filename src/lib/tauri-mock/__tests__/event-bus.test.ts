/**
 * #2683 — the mock event bus.
 *
 * Before this fix, `setupMock()` called `mockIPC(cb)` with no options, so
 * `plugin:event|listen` / `|unlisten` / `|emit` fell through to `dispatch()`'s
 * stub `PLUGIN_HANDLERS` entries (`handlers.ts`), which return an id / `null`
 * and never retain or invoke a `listen()` callback. No spec could ever
 * receive a backend-emitted Tauri event.
 *
 * `setupMock()` now passes `{ shouldMockEvents: true }`, which activates
 * `@tauri-apps/api/mocks`' own built-in event-plugin handling: `listen()`
 * callbacks are retained in a real Map keyed by event name, and `emit()`
 * delivers to them. This file exercises that wiring end-to-end through the
 * REAL `@tauri-apps/api/event` module (not a hand-mocked `listen()`), plus
 * the `window.__emitMockEvent` test-facing hook `setupMock()` now exposes.
 *
 * Deliberately does NOT mock `@tauri-apps/api/mocks` (unlike
 * `tauri-mock.test.ts`, which replaces `mockIPC` wholesale to capture the
 * raw dispatch handler) — the whole point here is to prove the REAL
 * `mockIPC(..., { shouldMockEvents: true })` event plumbing works.
 */

import { emit, listen } from '@tauri-apps/api/event'
import { clearMocks } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setupMock } from '../index'

interface MockEventWindow {
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

beforeEach(() => {
  setupMock()
})

afterEach(() => {
  clearMocks()
})

describe('mock event bus (#2683)', () => {
  it('delivers an emitted event to a registered listen() callback', async () => {
    const handler = vi.fn()
    const unlisten = await listen('sync:complete', handler)

    await emit('sync:complete', { type: 'complete', ops_received: 3 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      event: 'sync:complete',
      payload: { type: 'complete', ops_received: 3 },
    })

    unlisten()
  })

  it('does not deliver to a listener for a different event name', async () => {
    const handler = vi.fn()
    await listen('sync:complete', handler)

    await emit('sync:error', { type: 'error', message: 'boom' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers to multiple listeners registered for the same event', async () => {
    const first = vi.fn()
    const second = vi.fn()
    await listen('mcp:activity', first)
    await listen('mcp:activity', second)

    await emit('mcp:activity', { toolName: 'append_block' })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops delivering after unlisten()', async () => {
    const handler = vi.fn()
    const unlisten = await listen('sync:complete', handler)
    unlisten()

    await emit('sync:complete', { type: 'complete' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('window.__emitMockEvent delivers to a listen() callback (test-facing hook)', async () => {
    const w = window as unknown as MockEventWindow
    expect(typeof w.__emitMockEvent).toBe('function')

    const handler = vi.fn()
    const unlisten = await listen('deep-link', handler)

    await w.__emitMockEvent?.('deep-link', { urls: ['agaric://page/abc123'] })

    expect(handler).toHaveBeenCalledWith({
      event: 'deep-link',
      payload: { urls: ['agaric://page/abc123'] },
    })

    unlisten()
  })
})
