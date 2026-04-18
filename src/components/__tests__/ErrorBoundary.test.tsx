import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  AlertCircle: (props: { className?: string }) => (
    <svg data-testid="alert-circle-icon" className={props.className} />
  ),
  RefreshCw: (props: { className?: string }) => (
    <svg data-testid="refresh-cw-icon" className={props.className} />
  ),
}))

const relaunchMock = vi.fn()
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: () => relaunchMock(),
}))

import { ErrorBoundary } from '../ErrorBoundary'

function ThrowingChild(): React.ReactElement {
  throw new Error('test render error')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
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
  })

  it('logs error via logger', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    // ErrorBoundary now uses logger.error which calls console.error with a formatted string
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('test render error'))
  })

  it('axe accessibility audit on fallback', async () => {
    const { container } = render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
