/**
 * Tests for FeatureErrorBoundary component.
 *
 * Validates:
 *  - Renders children normally when no error
 *  - Shows fallback UI when child throws
 *  - Shows section name in error message
 *  - Retry button resets error state and re-renders children
 *  - a11y compliance on fallback UI
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { FeatureErrorBoundary } from '../FeatureErrorBoundary'

/** A helper component that throws on command. */
let shouldThrow = false
function Bomb() {
  if (shouldThrow) throw new Error('Boom!')
  return <div data-testid="child">OK</div>
}

beforeEach(() => {
  shouldThrow = false
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
    vi.spyOn(console, 'error').mockImplementation(() => {})

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
  })

  it('shows section name in error message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    shouldThrow = true

    render(
      <FeatureErrorBoundary name="Journal">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    expect(screen.getByText('Journal encountered an error')).toBeInTheDocument()
  })

  it('retry button resets error state and re-renders children', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
  })

  it('has no a11y violations in fallback UI', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    shouldThrow = true

    const { container } = render(
      <FeatureErrorBoundary name="PageEditor">
        <Bomb />
      </FeatureErrorBoundary>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
