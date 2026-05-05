/**
 * Tests for SpaceTopStripe (PEND-11).
 *
 * Validates:
 *  - Renders a fixed-position 3px stripe when a space is active.
 *  - `data-space-id` matches the active space's id.
 *  - `style.backgroundColor` references the active `accent_color` token.
 *  - Falls back to `var(--accent-current)` when `accent_color` is null/empty.
 *  - Returns null when `currentSpaceId` is null OR when the id does not
 *    resolve to a known space (defensive against stale persisted ids).
 *  - Carries `aria-hidden="true"` (the stripe is decorative).
 *  - Has `pointer-events-none` so it never steals clicks.
 *  - a11y compliance via axe audit.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { SpaceRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { SpaceTopStripe } from '../SpaceTopStripe'

const PERSONAL: SpaceRow = {
  id: 'SPACE_PERSONAL',
  name: 'Personal',
  accent_color: 'accent-emerald',
}
const WORK: SpaceRow = { id: 'SPACE_WORK', name: 'Work', accent_color: 'accent-blue' }

beforeEach(() => {
  useSpaceStore.setState({
    currentSpaceId: PERSONAL.id,
    availableSpaces: [PERSONAL, WORK],
    isReady: true,
  })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SpaceTopStripe', () => {
  it('renders the stripe div when a space is active', () => {
    render(<SpaceTopStripe />)
    expect(screen.getByTestId('space-top-stripe')).toBeInTheDocument()
  })

  it('returns null when no space is active', () => {
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })
    render(<SpaceTopStripe />)
    expect(screen.queryByTestId('space-top-stripe')).toBeNull()
  })

  it('returns null when the active id does not resolve to a known space', () => {
    useSpaceStore.setState({
      currentSpaceId: 'BOGUS_ID',
      availableSpaces: [PERSONAL, WORK],
      isReady: true,
    })
    render(<SpaceTopStripe />)
    expect(screen.queryByTestId('space-top-stripe')).toBeNull()
  })

  it('exposes the active space id via data-space-id', () => {
    render(<SpaceTopStripe />)
    expect(screen.getByTestId('space-top-stripe')).toHaveAttribute('data-space-id', PERSONAL.id)
  })

  it("applies the active space's accent token to backgroundColor", () => {
    render(<SpaceTopStripe />)
    const stripe = screen.getByTestId('space-top-stripe')
    expect(stripe.getAttribute('style')).toContain('var(--accent-emerald')
  })

  it('falls back to --accent-current when accent_color is null', () => {
    const noAccent: SpaceRow = { id: 'SPACE_NA', name: 'NoAccent', accent_color: null }
    useSpaceStore.setState({
      currentSpaceId: noAccent.id,
      availableSpaces: [noAccent],
      isReady: true,
    })
    render(<SpaceTopStripe />)
    const stripe = screen.getByTestId('space-top-stripe')
    expect(stripe.getAttribute('style')).toContain('var(--accent-current)')
  })

  it('updates backgroundColor when the active space changes', () => {
    const { rerender } = render(<SpaceTopStripe />)
    expect(screen.getByTestId('space-top-stripe').getAttribute('style')).toContain(
      'var(--accent-emerald',
    )

    useSpaceStore.setState({ currentSpaceId: WORK.id })
    rerender(<SpaceTopStripe />)

    expect(screen.getByTestId('space-top-stripe').getAttribute('style')).toContain(
      'var(--accent-blue',
    )
  })

  it('is decorative — aria-hidden="true"', () => {
    render(<SpaceTopStripe />)
    expect(screen.getByTestId('space-top-stripe')).toHaveAttribute('aria-hidden', 'true')
  })

  it('uses pointer-events-none so it never steals clicks', () => {
    render(<SpaceTopStripe />)
    // Tailwind utility lands as a literal class name — assert presence
    // rather than computed style (jsdom does not run Tailwind).
    expect(screen.getByTestId('space-top-stripe').className).toContain('pointer-events-none')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SpaceTopStripe />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
