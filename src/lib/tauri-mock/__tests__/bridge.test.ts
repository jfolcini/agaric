/**
 * #6529 — the bridge client: what it sends for an `invoke`, a `listen` and an
 * `emitMockEvent`, how a reply and a pushed event come back, and that
 * `setupMock` installs it only when a bridge is named.
 *
 * The socket is a fake; the event side is the real `@tauri-apps/api/event`.
 */

import { listen } from '@tauri-apps/api/event'
import { clearMocks } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setupBridge } from '../bridge'
import { setupMock } from '../index'

const URL = 'ws://127.0.0.1:1'

class FakeSocket {
  static last: FakeSocket | undefined
  readonly url: string
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  receive(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }
}

function socket(): FakeSocket {
  const last = FakeSocket.last
  if (last === undefined) throw new Error('no socket was opened')
  return last
}

/**
 * What `@tauri-apps/api/core`'s `invoke` does. The suite replaces that module
 * with a strict stub, so the tests call the seam the client installs.
 */
function invoke(cmd: string, args?: unknown): Promise<unknown> {
  return (
    window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
    }
  ).__TAURI_INTERNALS__.invoke(cmd, args)
}

/** Let the client's `await opened` continuations run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

interface BridgeWindow {
  __AGARIC_BRIDGE__?: string
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
  __injectMockError?: unknown
}

beforeEach(() => {
  FakeSocket.last = undefined
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  clearMocks()
  vi.unstubAllGlobals()
  delete (window as unknown as BridgeWindow).__AGARIC_BRIDGE__
  delete (window as unknown as BridgeWindow).__emitMockEvent
})

describe('setupBridge', () => {
  it('sends an app command to the bridge and resolves with its reply', async () => {
    setupBridge(URL)
    const answer = invoke('get_block', { blockId: 'B1' })
    await settle()
    expect(socket().sent, 'nothing leaves before the socket opens').toEqual([])

    socket().fire('open')
    await settle()
    expect(socket().sent).toEqual([
      { id: 1, op: 'invoke', cmd: 'get_block', args: { blockId: 'B1' } },
    ])

    socket().receive({ id: 1, ok: { id: 'B1', content: 'hello' } })
    await expect(answer).resolves.toEqual({ id: 'B1', content: 'hello' })
  })

  it('rejects with the backend error as Tauri would, untouched', async () => {
    setupBridge(URL)
    socket().fire('open')
    const answer = invoke('get_block', { blockId: 'NOPE' })
    await settle()

    socket().receive({ id: 1, err: { kind: 'not_found', message: 'no such block' } })
    await expect(answer).rejects.toEqual({ kind: 'not_found', message: 'no such block' })
  })

  it('keeps requests in the order they were made, each with its own reply', async () => {
    setupBridge(URL)
    const first = invoke('list_spaces')
    const second = invoke('get_status')
    socket().fire('open')
    await settle()
    expect(socket().sent.map((frame) => [frame['id'], frame['cmd'], frame['args']])).toEqual([
      [1, 'list_spaces', {}],
      [2, 'get_status', {}],
    ])

    // Answered out of order: each promise takes the reply with its id.
    socket().receive({ id: 2, ok: 'status' })
    socket().receive({ id: 1, ok: 'spaces' })
    await expect(first).resolves.toBe('spaces')
    await expect(second).resolves.toBe('status')
  })

  it('answers a plugin command in the browser, without the bridge', async () => {
    setupBridge(URL)
    socket().fire('open')
    await expect(invoke('plugin:window|set_title', { value: 'x' })).resolves.toBeNull()
    await settle()
    expect(socket().sent).toEqual([])
  })

  it('subscribes the bridge to a listened event and delivers what it pushes', async () => {
    setupBridge(URL)
    socket().fire('open')
    const handler = vi.fn()
    await listen('block:properties-changed', handler)
    await settle()
    expect(socket().sent).toEqual([{ id: 1, op: 'listen', event: 'block:properties-changed' }])

    socket().receive({
      event: 'block:properties-changed',
      payload: { block_id: 'B1', changed_keys: ['todo_state'] },
    })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(handler).toHaveBeenCalledWith({
      event: 'block:properties-changed',
      payload: { block_id: 'B1', changed_keys: ['todo_state'] },
    })
  })

  it('emits a spec-fired event in the backend, not in the page', async () => {
    setupBridge(URL)
    socket().fire('open')
    const handler = vi.fn()
    await listen('sync:complete', handler)
    await settle()

    const emitted = (window as unknown as BridgeWindow).__emitMockEvent?.('sync:complete', {
      ops_received: 3,
    })
    await settle()
    expect(socket().sent.at(-1)).toEqual({
      id: 2,
      op: 'emit',
      event: 'sync:complete',
      payload: { ops_received: 3 },
    })
    expect(handler, 'the page hears it only when the backend pushes it back').not.toHaveBeenCalled()

    socket().receive({ id: 2, ok: null })
    await expect(emitted).resolves.toBeUndefined()
  })

  it('rejects what is still waiting when the connection closes', async () => {
    setupBridge(URL)
    socket().fire('open')
    const answer = invoke('list_spaces')
    await settle()

    socket().fire('close')
    await expect(answer).rejects.toThrow('bridge: connection closed')
  })

  it('rejects a command when the bridge cannot be reached', async () => {
    setupBridge(URL)
    const answer = invoke('list_spaces')
    socket().fire('error')
    await expect(answer).rejects.toThrow(`bridge: cannot reach ${URL}`)
  })
})

describe('setupMock', () => {
  it('installs the bridge client, and none of the mock, when a bridge is named', async () => {
    ;(window as unknown as BridgeWindow).__AGARIC_BRIDGE__ = URL
    setupMock()

    expect(socket().url).toBe(URL)
    socket().fire('open')
    const answer = invoke('list_spaces')
    await settle()
    expect(socket().sent).toEqual([{ id: 1, op: 'invoke', cmd: 'list_spaces', args: {} }])
    socket().receive({ id: 1, ok: [] })
    await expect(answer).resolves.toEqual([])
  })

  it('opens no socket when no bridge is named', async () => {
    setupMock()

    expect(FakeSocket.last).toBeUndefined()
    // The mock answers: its seed has a space.
    await expect(invoke('list_spaces')).resolves.not.toEqual([])
  })
})
