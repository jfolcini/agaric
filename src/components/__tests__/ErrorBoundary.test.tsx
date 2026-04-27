import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { _resetRateLimits } from '../../lib/logger'

vi.mock('lucide-react', () => ({
  AlertCircle: (props: { className?: string }) => (
    <svg data-testid="alert-circle-icon" className={props.className} />
  ),
  RefreshCw: (props: { className?: string }) => (
    <svg data-testid="refresh-cw-icon" className={props.className} />
  ),
  Bug: (props: { className?: string }) => (
    <svg data-testid="bug-icon" className={props.className} />
  ),
}))

const relaunchMock = vi.fn()
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: () => relaunchMock(),
}))

// Mock BugReportDialog to a lightweight marker so we can assert on open state
// and prefilled props without dragging in the full IPC surface.
vi.mock('../BugReportDialog', () => ({
  BugReportDialog: ({
    open,
    initialTitle,
    initialDescription,
  }: {
    open: boolean
    initialTitle?: string
    initialDescription?: string
  }) =>
    open ? (
      <div data-testid="bug-report-dialog">
        <span data-testid="bug-dialog-title">{initialTitle ?? ''}</span>
        <span data-testid="bug-dialog-description">{initialDescription ?? ''}</span>
      </div>
    ) : null,
}))

import { ErrorBoundary } from '../ErrorBoundary'

function ThrowingChild(): React.ReactElement {
  throw new Error('test render error')
}

function ThrowingChildWithStack(): React.ReactElement {
  const err = new Error('crash with stack')
  err.stack = 'Error: crash with stack\n    at mock (file.ts:10:20)'
  throw err
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Reset the logger's rate-limit map so each test sees a fresh budget —
  // the boundary always logs the same module:message key, and after 5
  // tests the logger's `console.error` call would be suppressed, breaking
  // the deterministic count assertions below.
  _resetRateLimits()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  relaunchMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>App content</div>
      </ErrorBoundary>,
    )

    expect(screen.getByText('App content')).toBeInTheDocument()
  })

  it('renders fallback UI when child throws during render', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('test render error')).toBeInTheDocument()
    expect(screen.getByTestId('alert-circle-icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reload/i })).toBeInTheDocument()

    // React 19 logs the caught error once; the boundary's logger.error call
    // adds a second formatted log.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('calls Tauri relaunch on Reload click', async () => {
    const user = userEvent.setup()
    relaunchMock.mockResolvedValueOnce(undefined)

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    await user.click(screen.getByRole('button', { name: /Reload/i }))

    expect(relaunchMock).toHaveBeenCalledTimes(1)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('falls back to window.location.reload when plugin rejects', async () => {
    const user = userEvent.setup()
    relaunchMock.mockRejectedValueOnce(new Error('plugin unavailable'))
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    await user.click(screen.getByRole('button', { name: /Reload/i }))

    // Wait a microtask for the promise chain to flush
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(relaunchMock).toHaveBeenCalledTimes(1)
    expect(reloadMock).toHaveBeenCalledTimes(1)

    // The deliberate render-time throw triggers React 19's caught-error log
    // plus the boundary's logger.error. The plugin rejection is silently
    // caught — `relaunch().catch(() => window.location.reload())` — so it
    // does not add a console.error.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('logs error via logger', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    // ErrorBoundary uses logger.error which calls console.error with a
    // formatted string. React 19 also logs the caught error itself, so we
    // expect exactly two calls.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('axe accessibility audit on fallback', async () => {
    const { container } = render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('renders a "Report this crash" button alongside Reload', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('button', { name: /Reload/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Report this crash/i })).toBeInTheDocument()
    // Dialog is not open by default.
    expect(screen.queryByTestId('bug-report-dialog')).not.toBeInTheDocument()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('opens BugReportDialog prefilled with the caught error message and stack', async () => {
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <ThrowingChildWithStack />
      </ErrorBoundary>,
    )

    await user.click(screen.getByRole('button', { name: /Report this crash/i }))

    expect(screen.getByTestId('bug-report-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('bug-dialog-title')).toHaveTextContent('crash with stack')
    expect(screen.getByTestId('bug-dialog-description')).toHaveTextContent(
      'at mock (file.ts:10:20)',
    )

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('crash with stack'))
  })
})
