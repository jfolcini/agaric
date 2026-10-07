/**
 * Tests for DuePanelFilters component.
 *
 * Validates:
 *  - Renders all source segments (All, Due, Scheduled, Properties) as a
 *    single-select ToggleGroup (role=radio, aria-checked, data-state)
 *  - Shows correct aria-checked state for selected filter
 *  - Calls onSourceFilterChange with correct value
 *  - Renders hide-before-scheduled toggle
 *  - Toggle calls onToggleHideBeforeScheduled
 *  - Toggle aria-pressed reflects state (and shares the ToggleGroup item look)
 *  - a11y audit passes (axe)
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { DuePanelFilters } from '@/components/agenda/DuePanelFilters'

describe('DuePanelFilters', () => {
  const defaultProps = {
    sourceFilter: null as string | null,
    onSourceFilterChange: vi.fn(),
    hideBeforeScheduled: false,
    onToggleHideBeforeScheduled: vi.fn(),
  }

  it('renders all four filter pills', () => {
    render(<DuePanelFilters {...defaultProps} />)

    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Due' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Scheduled' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Properties' })).toBeInTheDocument()
  })

  it('marks "All" as the checked, active segment when sourceFilter is null', () => {
    render(<DuePanelFilters {...defaultProps} sourceFilter={null} />)

    const all = screen.getByRole('radio', { name: 'All' })
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('data-state', 'on')
    for (const name of ['Due', 'Scheduled', 'Properties']) {
      const segment = screen.getByRole('radio', { name })
      expect(segment).toHaveAttribute('aria-checked', 'false')
      expect(segment).toHaveAttribute('data-state', 'off')
    }
  })

  it('marks "Due" as the checked segment when sourceFilter is column:due_date', () => {
    render(<DuePanelFilters {...defaultProps} sourceFilter="column:due_date" />)

    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false')
    const due = screen.getByRole('radio', { name: 'Due' })
    expect(due).toHaveAttribute('aria-checked', 'true')
    expect(due).toHaveAttribute('data-state', 'on')
  })

  it('renders the source segments as one single-select ToggleGroup', () => {
    render(<DuePanelFilters {...defaultProps} />)

    const group = screen.getByRole('radiogroup')
    expect(group).toHaveAttribute('data-slot', 'toggle-group')
    expect(within(group).getAllByRole('radio')).toHaveLength(4)
    // Coarse-pointer segments are 44px wide each; on a 360px phone the four of
    // them overflow the panel unless the group wraps inside its own box.
    expect(group).toHaveClass('max-w-full', 'flex-wrap')
    // Active state is the quiet ToggleGroup fill, never the brand-red fill
    // that read as an error beside the red Overdue section.
    const active = screen.getByRole('radio', { name: 'All' })
    expect(active.className).toContain('data-[state=on]:bg-secondary')
    expect(active.className).not.toContain('bg-primary')
  })

  it('keeps the current filter when the active segment is clicked again', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(
      <DuePanelFilters
        {...defaultProps}
        sourceFilter="column:due_date"
        onSourceFilterChange={onFilterChange}
      />,
    )

    await user.click(screen.getByRole('radio', { name: 'Due' }))
    // Radix reports a deselect as ''; a single-select filter must not forward it.
    expect(onFilterChange).not.toHaveBeenCalled()
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

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(onFilterChange).toHaveBeenCalledWith(null)
  })

  it('calls onSourceFilterChange with column:due_date when "Due" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('radio', { name: 'Due' }))
    expect(onFilterChange).toHaveBeenCalledWith('column:due_date')
  })

  it('calls onSourceFilterChange with column:scheduled_date when "Scheduled" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('radio', { name: 'Scheduled' }))
    expect(onFilterChange).toHaveBeenCalledWith('column:scheduled_date')
  })

  it('calls onSourceFilterChange with property: when "Properties" is clicked', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()

    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.click(screen.getByRole('radio', { name: 'Properties' }))
    expect(onFilterChange).toHaveBeenCalledWith('property:')
  })

  it('renders hide-before-scheduled toggle with correct label when OFF', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={false} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: show all/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders hide-before-scheduled toggle with correct label when ON', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled />)

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
      <DuePanelFilters {...defaultProps} sourceFilter="column:due_date" hideBeforeScheduled />,
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
    expect(screen.getByRole('radio', { name: 'All (4)' })).toBeInTheDocument()
    // "Due" shows its count
    expect(screen.getByRole('radio', { name: 'Due (3)' })).toBeInTheDocument()
    // "Scheduled" shows its count
    expect(screen.getByRole('radio', { name: 'Scheduled (1)' })).toBeInTheDocument()
    // "Properties" has 0 — no count suffix
    expect(screen.getByRole('radio', { name: 'Properties' })).toBeInTheDocument()
  })

  it('does not display counts when sourceCounts is not provided', () => {
    render(<DuePanelFilters {...defaultProps} />)

    // Without sourceCounts, pills show plain labels
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Due' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Scheduled' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Properties' })).toBeInTheDocument()
  })

  // Touch-target sizing — ToggleGroupItem owns the 44px coarse-pointer minimum.
  it('source segments include a 44px min-height on coarse pointer', () => {
    render(<DuePanelFilters {...defaultProps} />)

    for (const name of ['All', 'Due', 'Scheduled', 'Properties']) {
      expect(screen.getByRole('radio', { name }).className).toContain(
        '[@media(pointer:coarse)]:min-h-11',
      )
    }
  })

  // Tooltip explaining the Due axis (the most ambiguous one
  // for users unfamiliar with Agaric's date model: hard deadline vs
  // soft scheduled start).
  it('shows a tooltip explaining the "Due" axis on hover', async () => {
    const user = userEvent.setup()
    render(<DuePanelFilters {...defaultProps} />)

    await user.hover(screen.getByRole('radio', { name: 'Due' }))

    await waitFor(() => {
      expect(
        screen.getByRole('tooltip', { name: 'Hard due date — overdue if past' }),
      ).toBeInTheDocument()
    })
  })

  // The tooltip trigger wraps each segment in a span; focus must still reach the
  // radio, roving focus must still step across the wrappers, and the tooltip
  // must open from keyboard focus alone.
  it('opens the segment tooltip on keyboard focus and arrows between segments without selecting', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(<DuePanelFilters {...defaultProps} onSourceFilterChange={onFilterChange} />)

    await user.tab()
    expect(screen.getByRole('radio', { name: 'All' })).toHaveFocus()
    expect(
      await screen.findByRole('tooltip', {
        name: 'All blocks with any due or scheduled date, or property filter',
      }),
    ).toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Due' })).toHaveFocus()
    expect(
      await screen.findByRole('tooltip', { name: 'Hard due date — overdue if past' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    expect(onFilterChange).not.toHaveBeenCalled()
  })

  it('hide-before-scheduled toggle has aria-label and 44px min-height on coarse pointer', () => {
    render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={false} />)

    const toggle = screen.getByRole('button', { name: /Scheduled: show all/i })
    expect(toggle).toHaveAttribute('aria-label', 'Scheduled: show all')
    expect(toggle.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('hide-before-scheduled toggle shares the ToggleGroup item look and fills when on', () => {
    const { rerender } = render(<DuePanelFilters {...defaultProps} hideBeforeScheduled={false} />)

    const off = screen.getByRole('button', { name: /Scheduled: show all/i })
    expect(off).toHaveAttribute('data-slot', 'toggle-group-item')
    expect(off).toHaveAttribute('data-state', 'off')
    expect(off.className).toContain('data-[state=on]:bg-secondary')
    expect(off.className).not.toContain('bg-primary')

    rerender(<DuePanelFilters {...defaultProps} hideBeforeScheduled />)
    expect(screen.getByRole('button', { name: /Scheduled: hide future/i })).toHaveAttribute(
      'data-state',
      'on',
    )
  })
})
