/**
 * Tests for ViewHeader — the portal-consumer wrapper that renders view-level
 * headers into the outlet owned by <ViewHeaderOutletProvider /> (UX-198).
 *
 * Validates:
 *  1. Children portal into the outlet element when the provider + slot are mounted.
 *  2. Unmounting ViewHeader removes the portaled content.
 *  3. Rendering ViewHeader outside any provider falls back to inline rendering
 *     (required for isolated view tests that don't set up the outlet).
 *  4. Rendering ViewHeader inside a provider but without a slot returns null
 *     and logs a warn. Matches the "Floating UI lifecycle logging" convention.
 *  5. A11y: portaled + inline header contents have no violations.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { logger } from '../../lib/logger'
import { ViewHeader } from '../ViewHeader'
import { ViewHeaderOutletProvider, ViewHeaderOutletSlot } from '../ViewHeaderOutlet'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ViewHeader', () => {
  it('portals children into the outlet element', () => {
    const { getByTestId } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
        <div data-testid="view-body">
          <ViewHeader>
            <span data-testid="header-child">hello outlet</span>
          </ViewHeader>
          body content
        </div>
      </ViewHeaderOutletProvider>,
    )
    const outlet = getByTestId('view-header-outlet')
    const child = getByTestId('header-child')
    expect(outlet.contains(child)).toBe(true)
    expect(child.textContent).toBe('hello outlet')
    // Inline fallback didn't fire — child is only in the outlet, not inside
    // the view-body wrapper.
    expect(getByTestId('view-body').contains(child)).toBe(false)
    expect(mockedWarn).not.toHaveBeenCalled()
  })

  it('removes portaled content when ViewHeader unmounts', () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <ViewHeaderOutletProvider>
          <ViewHeaderOutletSlot />
          {show && (
            <ViewHeader>
              <span data-testid="header-child">hi</span>
            </ViewHeader>
          )}
        </ViewHeaderOutletProvider>
      )
    }

    const { rerender, queryByTestId } = render(<Harness show={true} />)
    expect(queryByTestId('header-child')).toBeInTheDocument()

    rerender(<Harness show={false} />)
    expect(queryByTestId('header-child')).not.toBeInTheDocument()
  })

  it('falls back to inline rendering when used outside a provider', () => {
    const { getByTestId } = render(
      <div data-testid="root">
        <ViewHeader>
          <span data-testid="header-child">inline render</span>
        </ViewHeader>
      </div>,
    )
    const child = getByTestId('header-child')
    // Lives inside the root div — no portal.
    expect(getByTestId('root').contains(child)).toBe(true)
    // No warning — this path is intentional for tests/isolated renders.
    expect(mockedWarn).not.toHaveBeenCalled()
  })

  it('returns null and logs warn when provider is present but slot is not', async () => {
    const { queryByTestId } = render(
      <ViewHeaderOutletProvider>
        <ViewHeader>
          <span data-testid="header-child">hi</span>
        </ViewHeader>
      </ViewHeaderOutletProvider>,
    )
    expect(queryByTestId('header-child')).not.toBeInTheDocument()
    // Warn is deferred one task so the initial-mount race (ref callback not
    // yet fired) doesn't produce a false positive. Wait for it to fire.
    await waitFor(() => {
      expect(mockedWarn).toHaveBeenCalledTimes(1)
    })
    expect(mockedWarn).toHaveBeenCalledWith(
      'ViewHeader',
      expect.stringContaining('Portal mount attempted before outlet resolved'),
    )
  })

  it('renders multiple ViewHeaders stacking into the same outlet', () => {
    render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
        <ViewHeader>
          <span data-testid="h1">first</span>
        </ViewHeader>
        <ViewHeader>
          <span data-testid="h2">second</span>
        </ViewHeader>
      </ViewHeaderOutletProvider>,
    )
    const outlet = screen.getByTestId('view-header-outlet')
    expect(outlet.contains(screen.getByTestId('h1'))).toBe(true)
    expect(outlet.contains(screen.getByTestId('h2'))).toBe(true)
  })

  it('has no a11y violations when portaled', async () => {
    const { container } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
        <ViewHeader>
          <h2>Portal header</h2>
        </ViewHeader>
      </ViewHeaderOutletProvider>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when rendered inline', async () => {
    const { container } = render(
      <ViewHeader>
        <h2>Inline header</h2>
      </ViewHeader>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
