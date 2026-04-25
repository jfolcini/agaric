/**
 * Tests for DuePanelFilters component.
 *
 * Validates:
 *  - Renders all filter pills (All, Due, Scheduled, Properties)
 *  - Shows correct aria-pressed state for selected filter
 *  - Calls onSourceFilterChange with correct value
 *  - Renders hide-before-scheduled toggle
 *  - Toggle calls onToggleHideBeforeScheduled
 *  - Toggle aria-pressed reflects state
 *  - a11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { DuePanelFilters } from '../DuePanelFilters'

describe('DuePanelFilters', () => {
  const defaultProps = {
    sourceFilter: null as string | null,
    onSourceFilterChange: vi.fn(),
    hideBeforeScheduled: false,
    onToggleHideBeforeScheduled: vi.fn(),
  }

  it('renders all four filter pills', () => {
    render(<DuePanelFilters {...defaultProps} />)

    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Due' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scheduled' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
  })

  it('shows "All" as aria-pressed when sourceFilter is null', () => {
    render(<DuePanelFilters {...defaultProps} sourceFilter={null} />)

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Due' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Scheduled' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Properties' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('shows "Due" as aria-pressed when sourceFilter is column:due_date', () => {
    render(<DuePanelFilters {...defaultProps} sourceFilter="column:due_date" />)

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Due' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onSourceFilterChange with null when "All" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(
      <DuePanelFilters
        {...defaultProps}
        sourceFilter="column:due_date"
        onSourceFilterChange={onFilterChange}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(onFilterChange).toHaveBeenCalledWith(null)
  })

  it('calls onSourceFilterChange with column:due_date when "Due" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('button', { name: 'Due' }))
    expect(onFilterChange).toHaveBeenCalledWith('column:due_date')
  })

  it('calls onSourceFilterChange with column:scheduled_date when "Scheduled" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('button', { name: 'Scheduled' }))
    expect(onFilterChange).toHaveBeenCalledWith('column:scheduled_date')
  })

  it('calls onSourceFilterChange with property: when "Properties" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('button', { name: 'Properties' }))
    expect(onFilterChange).toHaveBeenCalledWith('property:')
  })

  it('renders hide-before-scheduled toggle with correct label when OFF', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={false} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: show all/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders hide-before-scheduled toggle with correct label when ON', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={true} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: hide future/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onToggleHideBeforeScheduled when toggle is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(<DuePanelFilters {...defaultProps} onToggleHideBeforeScheduled={onToggle} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: show all/i })
    await user.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('a11y: no violations with default state', async () => {
    const { container } = render(<DuePanelFilters {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations with active filter', async () => {
    const { container } = render(
      <DuePanelFilters
        {...defaultProps}
        sourceFilter="column:due_date"
        hideBeforeScheduled={true}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('displays source counts on filter pills', () => {
    render(
      <DuePanelFilters {...defaultProps} sourceCounts={{ due: 3, scheduled: 1, property: 0 }} />,
    )

    // "All" shows total count (3+1+0 = 4)
    expect(screen.getByRole('button', { name: 'All (4)' })).toBeInTheDocument()
    // "Due" shows its count
    expect(screen.getByRole('button', { name: 'Due (3)' })).toBeInTheDocument()
    // "Scheduled" shows its count
    expect(screen.getByRole('button', { name: 'Scheduled (1)' })).toBeInTheDocument()
    // "Properties" has 0 — no count suffix
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
  })

  it('does not display counts when sourceCounts is not provided', () => {
    render(<DuePanelFilters {...defaultProps} />)

    // Without sourceCounts, pills show plain labels
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Due' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scheduled' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
  })

  // UX-268 — touch-target sizing
  it('source filter pills include 44px min-width and min-height on coarse pointer', () => {
    render(<DuePanelFilters {...defaultProps} />)

    for (const name of ['All', 'Due', 'Scheduled', 'Properties']) {
      const pill = screen.getByRole('button', { name })
      expect(pill.className).toContain('[@media(pointer:coarse)]:min-h-[44px]')
      expect(pill.className).toContain('[@media(pointer:coarse)]:min-w-[44px]')
    }
  })

  it('hide-before-scheduled toggle has aria-label and 44px min-height on coarse pointer', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={false} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: show all/i })
    expect(toggle).toHaveAttribute('aria-label', 'Scheduled: show all')
    expect(toggle.className).toContain('[@media(pointer:coarse)]:min-h-[44px]')
  })
})
