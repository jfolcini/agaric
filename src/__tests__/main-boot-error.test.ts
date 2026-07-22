/**
 * Tests for #2924: `main()` in `src/main.tsx` previously had no error catch.
 * A rejection anywhere before `createRoot(...).render(...)` — an
 * observability init failure, a mock-setup import failure, a missing
 * `#root` — aborted the bootstrap silently, leaving a permanent blank
 * window (React never mounts, so the root `ErrorBoundary` never exists to
 * catch anything, and the `unhandledrejection` listener only logs).
 *
 * Two behaviours are covered here, each in its own module instance (fresh
 * `vi.resetModules()` + dynamic `import('@/main')`, since `main.tsx` runs
 * its bootstrap as a side effect of being imported):
 *
 *  1. An `initFrontendObservability()` rejection must NOT prevent render —
 *     it's caught at the call site and logged via `logger.warn`, and
 *     `createRoot(...).render(...)` still runs.
 *  2. Any other pre-mount failure (simulated here via a missing `#root`,
 *     which makes `main()` throw synchronously inside the async function)
 *     must be caught by the `main().catch(...)` wired at the bottom of the
 *     module and rendered as a minimal, dependency-free static fallback
 *     screen with a reload affordance — mirroring `ErrorBoundary`'s wording.
 */

import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const renderMock = vi.fn()
const createRootMock = vi.fn(() => ({ render: renderMock, unmount: vi.fn() }))

function mockCommonDeps() {
  vi.doMock('@/lib/logger', () => ({
    logger: loggerMock,
    setLogLevel: vi.fn(),
  }))

  vi.doMock('react-dom/client', () => ({
    createRoot: createRootMock,
    default: { createRoot: createRootMock },
  }))

  vi.doMock('@/App.tsx', () => ({ App: () => null }))

  vi.doMock('@/components/common/ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: ReactNode }) => children,
  }))

  vi.doMock('@/hooks/usePrimaryFocus', () => ({
    PrimaryFocusProvider: ({ children }: { children: ReactNode }) => children,
    usePrimaryFocus: () => ({ register: vi.fn(), focus: vi.fn() }),
  }))

  vi.doMock('@/lib/tauri-mock', () => ({ setupMock: vi.fn() }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  loggerMock.debug.mockClear()
  loggerMock.info.mockClear()
  loggerMock.warn.mockClear()
  loggerMock.error.mockClear()
  createRootMock.mockClear()
  renderMock.mockClear()
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  }
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('@/lib/observability')
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('main.tsx — observability init failure does not block render', () => {
  it('logs a warning and still mounts the app when initFrontendObservability() rejects', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    mockCommonDeps()
    vi.doMock('@/lib/observability', () => ({
      initFrontendObservability: vi.fn().mockRejectedValue(new Error('chunk load failed')),
    }))

    await import('@/main')

    await vi.waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(1)
    })

    expect(createRootMock).toHaveBeenCalledTimes(1)
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('observability'),
      undefined,
      expect.any(Error),
    )
    // The fatal fallback screen must NOT have been injected — the app
    // rendered normally (via the mocked createRoot/render above).
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('main.tsx — pre-mount failure renders a static fallback screen', () => {
  it('injects a fallback screen with a reload button when #root is missing', async () => {
    // No `#root` in the DOM — `main()` throws synchronously with
    // 'Root element not found' before `createRoot` is ever reached.
    mockCommonDeps()
    vi.doMock('@/lib/observability', () => ({
      initFrontendObservability: vi.fn().mockResolvedValue(undefined),
    }))

    await import('@/main')

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull()
    })

    expect(createRootMock).not.toHaveBeenCalled()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Root element not found')

    const reloadButton = document.querySelector('button')
    expect(reloadButton).not.toBeNull()
    expect(reloadButton?.textContent).toBe('Reload')

    expect(loggerMock.error).toHaveBeenCalledWith(
      'main',
      'Fatal error before the app could render',
      expect.objectContaining({ stack: expect.any(String) }),
    )
  })
})
