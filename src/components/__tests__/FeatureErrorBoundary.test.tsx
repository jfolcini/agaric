/**
 * Tests for FeatureErrorBoundary component.
 *
 * Validates:
 *  - Renders children normally when no error
 *  - Shows fallback UI when child throws
 *  - Shows section name in error message
 *  - Retry button resets error state and re-renders children
 *  - Report bug button dispatches `BUG_REPORT_EVENT` with the captured
 *    error message + stack (UX-279)
 *  - a11y compliance on fallback UI
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BUG_REPORT_EVENT, type BugReportEventDetail } from '../../lib/bug-report-events'
import { FeatureErrorBoundary } from '../FeatureErrorBoundary'

/** A helper component that throws on command. */
let shouldThrow = false
let thrownError: Error = new Error('Boom!')
function Bomb() {
  if (shouldThrow) throw thrownError
  return <div data-testid="child">OK</div>
}

beforeEach(() => {
  shouldThrow = false
  thrownError = new Error('Boom!')
  vi.restoreAllMocks()
})

describe('FeatureErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(
      <FeatureErrorBoundary name="TestSection">
        <div data-testid="child-content">Hello</div>
      </FeatureErrorBoundary>,
    )

    expect(screen.getByTestId('child-content')).toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
    // Should NOT show error UI
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows fallback UI when child throws', () => {
    // Suppress console.error from React and the boundary itself
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    shouldThrow = true

    render(
      <FeatureErrorBoundary name="Journal">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    // Should show error alert
    expect(screen.getByRole('alert')).toBeInTheDocument()
    // Should show the error message
    expect(screen.getByText('Boom!')).toBeInTheDocument()
    // Child should NOT be rendered
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()

    // React 19 logs the caught error once; the boundary's logger.error call
    // adds a second formatted log.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Boom!'))
    consoleErrorSpy.mockRestore()
  })

  it('shows section name in error message', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    shouldThrow = true

    render(
      <FeatureErrorBoundary name="Journal">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    expect(screen.getByText('Journal encountered an error')).toBeInTheDocument()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Boom!'))
    consoleErrorSpy.mockRestore()
  })

  it('retry button resets error state and re-renders children', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()

    shouldThrow = true

    render(
      <FeatureErrorBoundary name="Journal">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    // Error fallback is shown
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()

    // Fix the child so it doesn't throw on next render
    shouldThrow = false

    // Click retry
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    // Child should be rendered again
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
    // Error UI should be gone
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // The single throw triggers two console.error calls (React 19 + logger).
    // Retry resets state without re-throwing, so the count stays at 2.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Boom!'))
    consoleErrorSpy.mockRestore()
  })

  describe('Report bug button (UX-279)', () => {
    const listener = vi.fn<(e: Event) => void>()

    beforeEach(() => {
      window.addEventListener(BUG_REPORT_EVENT, listener)
    })

    afterEach(() => {
      window.removeEventListener(BUG_REPORT_EVENT, listener)
      listener.mockReset()
    })

    it('renders the Report bug button alongside Retry when crashed', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      shouldThrow = true

      render(
        <FeatureErrorBoundary name="Journal">
          <Bomb />
        </FeatureErrorBoundary>,
      )

      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Report this crash' })).toBeInTheDocument()

      expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Boom!'))
      consoleErrorSpy.mockRestore()
    })

    it('dispatches BUG_REPORT_EVENT with the error message + stack on click', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const user = userEvent.setup()

      shouldThrow = true
      thrownError = new Error('section kaboom')
      thrownError.stack = 'Error: section kaboom\n    at Bomb (file.tsx:1:1)'

      render(
        <FeatureErrorBoundary name="Journal">
          <Bomb />
        </FeatureErrorBoundary>,
      )

      await user.click(screen.getByRole('button', { name: 'Report this crash' }))

      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0]?.[0] as CustomEvent<BugReportEventDetail>
      expect(event.detail).toEqual({
        message: 'section kaboom',
        stack: 'Error: section kaboom\n    at Bomb (file.tsx:1:1)',
      })

      expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('section kaboom'))
      consoleErrorSpy.mockRestore()
    })

    it('omits stack from the dispatch detail when the error has no stack', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const user = userEvent.setup()

      shouldThrow = true
      thrownError = new Error('stackless')
      // jsdom always populates `stack`, so blank it deliberately to model
      // the no-stack branch in `handleReportBug` (exactOptionalPropertyTypes
      // disallows `= undefined` for string fields, so delete it).
      delete thrownError.stack

      render(
        <FeatureErrorBoundary name="Journal">
          <Bomb />
        </FeatureErrorBoundary>,
      )

      await user.click(screen.getByRole('button', { name: 'Report this crash' }))

      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0]?.[0] as CustomEvent<BugReportEventDetail>
      expect(event.detail).toEqual({ message: 'stackless' })
      expect(event.detail.stack).toBeUndefined()

      expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('stackless'))
      consoleErrorSpy.mockRestore()
    })
  })

  it('renders the data-safety reassurance copy alongside the raw error message (UX-12)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    shouldThrow = true

    render(
      <FeatureErrorBoundary name="Journal">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    // Raw error.message — kept for diagnostics.
    expect(screen.getByText('Boom!')).toBeInTheDocument()
    // UX-12: reassurance copy so users know retry is non-destructive.
    expect(screen.getByText('Your data is safe — Retry reloads this panel.')).toBeInTheDocument()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    consoleErrorSpy.mockRestore()
  })

  it('has no a11y violations in fallback UI', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    shouldThrow = true

    const { container } = render(
      <FeatureErrorBoundary name="PageEditor">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Boom!'))
    consoleErrorSpy.mockRestore()
  })
})
