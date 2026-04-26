/**
 * Tests for SpaceAccentBadge (FEAT-3p10).
 *
 * Validates:
 *  - Renders the first letter of the space name, uppercased.
 *  - `aria-label` carries the space name + click affordance.
 *  - Default click handler cycles to the next space alphabetically.
 *  - Custom `onClick` override fires instead of cycling.
 *  - Accent color CSS variable is applied via inline style.
 *  - Empty / blank space name renders a `?` placeholder.
 *  - a11y compliance via axe audit.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { SpaceRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { SpaceAccentBadge } from '../SpaceAccentBadge'

const PERSONAL: SpaceRow = {
  id: 'SPACE_PERSONAL',
  name: 'Personal',
  accent_color: 'accent-emerald',
}
const WORK: SpaceRow = { id: 'SPACE_WORK', name: 'Work', accent_color: 'accent-blue' }
const SIDE: SpaceRow = { id: 'SPACE_SIDE', name: 'Side', accent_color: 'accent-violet' }

beforeEach(() => {
  useSpaceStore.setState({
    currentSpaceId: PERSONAL.id,
    availableSpaces: [PERSONAL, WORK],
    isReady: true,
  })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SpaceAccentBadge', () => {
  it('renders the first letter of the space name uppercased', () => {
    render(<SpaceAccentBadge space={PERSONAL} />)
    const badge = screen.getByTestId('space-accent-badge')
    expect(badge).toHaveTextContent('P')
  })

  it("uses the space's accent color as the background CSS variable", () => {
    render(<SpaceAccentBadge space={WORK} />)
    const badge = screen.getByTestId('space-accent-badge')
    // The component sets the inline `background-color` to the
    // `var(--accent-blue, …)` CSS expression. jsdom preserves the
    // raw inline style string, so we assert against it.
    expect(badge.getAttribute('style')).toContain('var(--accent-blue')
  })

  it('falls back to the brand accent when the space has no accent_color', () => {
    const noAccent: SpaceRow = { id: 'SPACE_NA', name: 'NoAccent', accent_color: null }
    render(<SpaceAccentBadge space={noAccent} />)
    const badge = screen.getByTestId('space-accent-badge')
    expect(badge.getAttribute('style')).toContain('var(--accent-current)')
  })

  it('aria-label carries the space name + click affordance', () => {
    render(<SpaceAccentBadge space={PERSONAL} />)
    const badge = screen.getByTestId('space-accent-badge')
    expect(badge).toHaveAttribute('aria-label', expect.stringContaining('Personal'))
  })

  it('title attribute shows the bare space name (tooltip)', () => {
    render(<SpaceAccentBadge space={WORK} />)
    const badge = screen.getByTestId('space-accent-badge')
    expect(badge).toHaveAttribute('title', 'Work')
  })

  it('renders a `?` placeholder for an empty / whitespace name', () => {
    const blank: SpaceRow = { id: 'SPACE_BLANK', name: '   ', accent_color: 'accent-rose' }
    render(<SpaceAccentBadge space={blank} />)
    const badge = screen.getByTestId('space-accent-badge')
    expect(badge).toHaveTextContent('?')
  })

  it('default click handler cycles to the next space alphabetically', async () => {
    const user = userEvent.setup()
    // Personal is current; available = [Personal, Work, Side]. The
    // store serves these alphabetical, so the next-after-Personal in
    // the alphabetical list is Side. (Pretend the store hands them
    // in the order it has them; we just need to assert "next" wraps
    // the array index — see SpaceAccentBadge.cycleToNextSpace.)
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL, SIDE, WORK],
      isReady: true,
    })

    render(<SpaceAccentBadge space={PERSONAL} />)
    await user.click(screen.getByTestId('space-accent-badge'))

    // Personal is index 0 → next is index 1 (Side).
    expect(useSpaceStore.getState().currentSpaceId).toBe(SIDE.id)
  })

  it('cycle wraps around from the last space back to the first', async () => {
    const user = userEvent.setup()
    useSpaceStore.setState({
      currentSpaceId: WORK.id,
      availableSpaces: [PERSONAL, SIDE, WORK],
      isReady: true,
    })

    render(<SpaceAccentBadge space={WORK} />)
    await user.click(screen.getByTestId('space-accent-badge'))

    // Work is index 2 → wraps to index 0 (Personal).
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
  })

  it('does nothing when there is only one space', async () => {
    const user = userEvent.setup()
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL],
      isReady: true,
    })

    render(<SpaceAccentBadge space={PERSONAL} />)
    await user.click(screen.getByTestId('space-accent-badge'))

    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
  })

  it('custom onClick override fires instead of cycling', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(<SpaceAccentBadge space={PERSONAL} onClick={handler} />)

    await user.click(screen.getByTestId('space-accent-badge'))

    expect(handler).toHaveBeenCalledTimes(1)
    // Store untouched — the override short-circuited the default cycler.
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SpaceAccentBadge space={PERSONAL} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
