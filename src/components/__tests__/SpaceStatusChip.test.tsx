/**
 * Tests for SpaceStatusChip (FEAT-3p10).
 *
 * Validates:
 *  - Renders the active space's name from the store.
 *  - Auto-hides when no space is active.
 *  - Accent color is applied to the left border + dot.
 *  - `aria-label` carries the active-space name + click affordance.
 *  - Default click handler focuses the SpaceSwitcher trigger.
 *  - Custom `onClick` override fires instead of focusing.
 *  - a11y compliance via axe audit.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { SpaceRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { SpaceStatusChip } from '../SpaceStatusChip'

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

describe('SpaceStatusChip', () => {
  it('renders the active space name read from the store', () => {
    render(<SpaceStatusChip />)
    const chip = screen.getByTestId('space-status-chip')
    expect(chip).toHaveTextContent('Personal')
  })

  it('returns null (auto-hides) when no space is active', () => {
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    render(<SpaceStatusChip />)
    expect(screen.queryByTestId('space-status-chip')).toBeNull()
  })

  it('returns null when the active id does not resolve to a known space', () => {
    useSpaceStore.setState({
      currentSpaceId: 'BOGUS_ID',
      availableSpaces: [PERSONAL, WORK],
      isReady: true,
    })
    render(<SpaceStatusChip />)
    expect(screen.queryByTestId('space-status-chip')).toBeNull()
  })

  it('updates rendered name when the active space changes', () => {
    const { rerender } = render(<SpaceStatusChip />)
    expect(screen.getByTestId('space-status-chip')).toHaveTextContent('Personal')

    useSpaceStore.setState({ currentSpaceId: WORK.id })
    rerender(<SpaceStatusChip />)

    expect(screen.getByTestId('space-status-chip')).toHaveTextContent('Work')
  })

  it("applies the active space's accent color to the left border", () => {
    render(<SpaceStatusChip />)
    const chip = screen.getByTestId('space-status-chip')
    expect(chip.getAttribute('style')).toContain('var(--accent-emerald')
  })

  it('aria-label carries the active space name', () => {
    render(<SpaceStatusChip />)
    const chip = screen.getByTestId('space-status-chip')
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('Personal'))
  })

  it('default click handler focuses the SpaceSwitcher trigger', async () => {
    const user = userEvent.setup()
    // Mount a stand-in SpaceSwitcher trigger so the chip's
    // `querySelector('[role=combobox][aria-label=Switch space]')`
    // finds something to focus. We use an `aria-label="Switch space"`
    // button so the matcher fires without needing the full Radix
    // Select tree.
    document.body.insertAdjacentHTML(
      'beforeend',
      `<button role="combobox" aria-label="Switch space" data-testid="switcher-stub" />`,
    )
    try {
      render(<SpaceStatusChip />)
      const chip = screen.getByTestId('space-status-chip')
      await user.click(chip)
      const stub = document.querySelector<HTMLButtonElement>('[data-testid="switcher-stub"]')
      expect(stub).not.toBeNull()
      // jsdom preserves activeElement after `.focus()`.
      expect(document.activeElement).toBe(stub)
    } finally {
      document.querySelector('[data-testid="switcher-stub"]')?.remove()
    }
  })

  it('custom onClick override fires instead of focusing the switcher', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(<SpaceStatusChip onClick={handler} />)
    await user.click(screen.getByTestId('space-status-chip'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SpaceStatusChip />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
