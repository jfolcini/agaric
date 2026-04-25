/**
 * Tests for the global `error` / `unhandledrejection` handlers wired in
 * `src/main.tsx`. The bootstrap registers two `window` listeners that bridge
 * to `logger.error('global', ...)` so that even pre-mount failures are
 * captured in the persistent log.
 *
 * Strategy: spy on `window.addEventListener` while `main.tsx` evaluates,
 * extract the registered listener functions, and invoke them directly with
 * synthetic event objects. This avoids relying on jsdom's `ErrorEvent` /
 * `PromiseRejectionEvent` constructors and keeps the captured handlers
 * isolated from the rest of the test environment.
 *
 * Heavy dependencies imported at the top of `main.tsx` (`react-dom/client`,
 * `App`, `ErrorBoundary`, `PrimaryFocusProvider`, `tauri-mock`) are mocked
 * so the bootstrap can run in jsdom without mounting React or hitting IPC.
 * `logger` is mocked so the assertions can target the bridge call exactly.
 */

import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

vi.mock('../lib/logger', () => ({
  logger: loggerMock,
  setLogLevel: vi.fn(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })),
  default: { createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })) },
}))

vi.mock('../App.tsx', () => ({ App: () => null }))

vi.mock('../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('../hooks/usePrimaryFocus', () => ({
  PrimaryFocusProvider: ({ children }: { children: ReactNode }) => children,
  usePrimaryFocus: () => ({ register: vi.fn(), focus: vi.fn() }),
}))

vi.mock('../lib/tauri-mock', () => ({ setupMock: vi.fn() }))

let capturedErrorHandler: ((event: Event) => void) | undefined
let capturedRejectionHandler: ((event: Event) => void) | undefined

beforeAll(async () => {
  // Provide a root element so main()'s async bootstrap doesn't throw before
  // the listeners have a chance to be observed.
  document.body.innerHTML = '<div id="root"></div>'
  // Pretend we're inside the Tauri webview so the dynamic import of
  // `./lib/tauri-mock` is skipped (module is still mocked above as a guard).
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  }

  const addSpy = vi.spyOn(window, 'addEventListener')

  // Importing the module synchronously registers both window listeners at
  // the top level (before main() runs).
  await import('../main')

  for (const call of addSpy.mock.calls) {
    const [type, handler] = call
    if (type === 'error' && typeof handler === 'function') {
      capturedErrorHandler = handler as (event: Event) => void
    } else if (type === 'unhandledrejection' && typeof handler === 'function') {
      capturedRejectionHandler = handler as (event: Event) => void
    }
  }
  addSpy.mockRestore()
})

beforeEach(() => {
  loggerMock.error.mockClear()
})

describe('main.tsx — global error handler wiring', () => {
  it('registers an error event listener on window', () => {
    expect(capturedErrorHandler).toBeInstanceOf(Function)
  })

  it('registers an unhandledrejection event listener on window', () => {
    expect(capturedRejectionHandler).toBeInstanceOf(Function)
  })
})

describe('main.tsx — error handler', () => {
  it('bridges to logger.error("global", message, {filename, lineno, colno, stack})', () => {
    const event = {
      message: 'boom',
      filename: 'src/oops.ts',
      lineno: 42,
      colno: 7,
      error: { stack: 'Error: boom\n  at oops (src/oops.ts:42:7)' },
    } as unknown as Event

    capturedErrorHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    expect(loggerMock.error).toHaveBeenCalledWith('global', 'boom', {
      filename: 'src/oops.ts',
      lineno: 42,
      colno: 7,
      stack: 'Error: boom\n  at oops (src/oops.ts:42:7)',
    })
  })

  it('falls back to "Uncaught error" when message is empty', () => {
    const event = {
      message: '',
      filename: '',
      lineno: 0,
      colno: 0,
      error: undefined,
    } as unknown as Event

    capturedErrorHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith('global', 'Uncaught error', {
      filename: '',
      lineno: 0,
      colno: 0,
      stack: '',
    })
  })

  it('coerces missing filename/lineno/colno to defaults', () => {
    const event = { message: 'partial' } as unknown as Event

    capturedErrorHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith('global', 'partial', {
      filename: '',
      lineno: 0,
      colno: 0,
      stack: '',
    })
  })

  it('coerces a missing error.stack to the empty string', () => {
    const cause = new Error('no stack source')
    // Force `cause.stack` undefined to exercise the `?? ''` fallback.
    delete (cause as { stack?: string }).stack
    const event = {
      message: 'no stack',
      filename: 'a.js',
      lineno: 1,
      colno: 1,
      error: cause,
    } as unknown as Event

    capturedErrorHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith(
      'global',
      'no stack',
      expect.objectContaining({ stack: '' }),
    )
  })
})

describe('main.tsx — unhandledrejection handler', () => {
  it('uses the rejection reason message + stack when reason is an Error', () => {
    const reason = new Error('async boom')
    reason.stack = 'Error: async boom\n  at fetch (src/x.ts:1:1)'
    const event = { reason } as unknown as Event

    capturedRejectionHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    expect(loggerMock.error).toHaveBeenCalledWith('global', 'async boom', {
      stack: 'Error: async boom\n  at fetch (src/x.ts:1:1)',
    })
  })

  it('stringifies non-Error reasons and emits an empty stack', () => {
    const event = { reason: 'plain string rejection' } as unknown as Event

    capturedRejectionHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith('global', 'plain string rejection', {
      stack: '',
    })
  })

  it('falls back to "Unhandled rejection" when reason is null/undefined', () => {
    const event = { reason: undefined } as unknown as Event

    capturedRejectionHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith('global', 'Unhandled rejection', {
      stack: '',
    })
  })

  it('coerces a missing Error.stack to the empty string', () => {
    const reason = new Error('msg only')
    // Some environments / minified errors omit the stack — exercise the `?? ''` fallback.
    delete (reason as { stack?: string }).stack
    const event = { reason } as unknown as Event

    capturedRejectionHandler?.(event)

    expect(loggerMock.error).toHaveBeenCalledWith('global', 'msg only', { stack: '' })
  })
})
