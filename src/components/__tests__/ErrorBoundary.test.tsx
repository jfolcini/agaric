import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  AlertCircle: (props: { className?: string }) => (
    <svg data-testid="alert-circle-icon" className={props.className} />
  ),
}))

import { ErrorBoundary } from '../ErrorBoundary'

function ThrowingChild(): React.ReactElement {
  throw new Error('test render error')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('calls window.location.reload on Reload click', async () => {
    const user = userEvent.setup()
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

    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('logs error to console', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )

    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'test render error' }),
      expect.objectContaining({ componentStack: expect.any(String) }),
    )
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
