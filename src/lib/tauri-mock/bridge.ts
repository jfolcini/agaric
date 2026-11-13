/**
 * #6529 — the real command surface behind the mock's seam.
 *
 * With `window.__AGARIC_BRIDGE__` set to a WebSocket URL, `setupMock` installs
 * this in place of the mock's handlers: every app command goes to a bridge
 * process, which runs it on the real backend (`src-tauri/src/headless/bridge.rs`
 * holds the protocol), and the backend's events come back to the app's
 * `listen()` callbacks.
 *
 * `plugin:*` commands stay in the browser, on the mock's own handlers: they
 * talk to the OS (clipboard, window title, opener), and the bridge's app has
 * no window system.
 *
 * Not carried: a `Channel` argument's messages (an import's progress) and a
 * raw-byte response (`read_attachment`).
 */

import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'

interface Reply {
  id: number
  ok?: unknown
  err?: unknown
}

interface Push {
  event: string
  payload: unknown
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>

/** The window global a Playwright fixture sets to the bridge's URL. */
export function bridgeUrl(): string | undefined {
  const url = (window as unknown as Record<string, unknown>)['__AGARIC_BRIDGE__']
  return typeof url === 'string' ? url : undefined
}

export function setupBridge(url: string): void {
  mockWindows('main')

  const socket = new WebSocket(url)
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`bridge: cannot reach ${url}`)))
  })
  // Logged here once; every request made of a dead bridge still rejects.
  opened.catch((err: unknown) => {
    logger.error('tauri-bridge', 'the bridge is unreachable', { url }, err)
  })
  const waiting = new Map<number, Waiting>()
  let nextId = 1

  // Requests leave in the order they were made: each awaits the same promise.
  const request = async (op: string, fields: Record<string, unknown>): Promise<unknown> => {
    await opened
    const id = nextId++
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, op, ...fields }))
    })
  }

  socket.addEventListener('message', (message: MessageEvent<string>) => {
    const frame = JSON.parse(message.data) as Reply | Push
    if ('event' in frame) {
      emit(frame.event, frame.payload).catch((err: unknown) => {
        logger.warn(
          'tauri-bridge',
          'failed to deliver a backend event',
          { event: frame.event },
          err,
        )
      })
      return
    }
    const asked = waiting.get(frame.id)
    if (asked === undefined) return
    waiting.delete(frame.id)
    // An error is rejected raw, as Tauri rejects: `{ kind, message, code? }`.
    if ('err' in frame) asked.reject(frame.err)
    else asked.resolve(frame.ok)
  })
  socket.addEventListener('close', () => {
    for (const asked of waiting.values()) asked.reject(new Error('bridge: connection closed'))
    waiting.clear()
  })

  mockIPC(
    (cmd, args) =>
      cmd.startsWith('plugin:')
        ? dispatch(cmd, args)
        : request('invoke', { cmd, args: args ?? {} }),
    // The mocks' own event bus holds the app's `listen()` callbacks, as under
    // `setupMock`; a pushed event reaches them through `emit` above.
    { shouldMockEvents: true },
  )

  // That bus answers `plugin:event|listen` itself, so the bridge would never
  // learn which events the app wants. Tell it as each listener registers.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
    .__TAURI_INTERNALS__
  const mocked = internals.invoke
  internals.invoke = (cmd, args, options) => {
    if (cmd === 'plugin:event|listen') {
      const event = (args as { event: string }).event
      request('listen', { event }).catch((err: unknown) => {
        logger.warn('tauri-bridge', 'the bridge did not subscribe to an event', { event }, err)
      })
    }
    return mocked(cmd, args, options)
  }

  // A spec's `emitMockEvent` emits in the backend, so the event takes the
  // path a real one takes back to the page.
  const w = window as unknown as Record<string, unknown>
  w['__emitMockEvent'] = async (event: string, payload?: unknown): Promise<void> => {
    await request('emit', { event, payload: payload ?? null })
  }
}
