/**
 * Tests for Calendar component — month caption click, week number click, styling.
 *
 * Validates:
 *  - Month caption renders as clickable button when onMonthClick provided
 *  - Month caption button has hover-friendly styling (bg-accent)
 *  - Week numbers render as clickable buttons when onWeekNumberClick provided
 *  - Callbacks fire with correct arguments
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { Calendar } from '../ui/calendar'

describe('Calendar', () => {
  it('renders month caption as clickable button when onMonthClick provided', () => {
    render(<Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} onMonthClick={vi.fn()} />)

    const btn = screen.getByRole('button', { name: /go to monthly view/i })
    expect(btn).toBeInTheDocument()
    expect(btn.tagName).toBe('BUTTON')
  })

  it('month caption button has hover bg-accent styling', () => {
    render(<Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} onMonthClick={vi.fn()} />)

    const btn = screen.getByRole('button', { name: /go to monthly view/i })
    expect(btn.className).toMatch(/hover:bg-accent/)
    expect(btn.className).toMatch(/rounded-md/)
  })

  it('month caption is plain text when onMonthClick is not provided', () => {
    render(<Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} />)

    // No "Go to monthly view" button should exist
    expect(screen.queryByRole('button', { name: /go to monthly view/i })).not.toBeInTheDocument()
  })

  it('month caption button calls onMonthClick when clicked', async () => {
    const user = userEvent.setup()
    const onMonthClick = vi.fn()

    render(
      <Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} onMonthClick={onMonthClick} />,
    )

    const btn = screen.getByRole('button', { name: /go to monthly view/i })
    await user.click(btn)

    expect(onMonthClick).toHaveBeenCalledTimes(1)
  })

  it('renders week numbers as clickable buttons when onWeekNumberClick provided', () => {
    render(
      <Calendar
        mode="single"
        defaultMonth={new Date(2026, 2, 1)}
        showWeekNumber
        weekStartsOn={1}
        onWeekNumberClick={vi.fn()}
      />,
    )

    // Week number buttons should have aria-label "Go to week ..."
    const weekBtns = screen.getAllByRole('button', { name: /go to week \d+/i })
    expect(weekBtns.length).toBeGreaterThanOrEqual(4)
  })

  it('week number button calls onWeekNumberClick when clicked', async () => {
    const user = userEvent.setup()
    const onWeekNumberClick = vi.fn()

    render(
      <Calendar
        mode="single"
        defaultMonth={new Date(2026, 2, 1)}
        showWeekNumber
        weekStartsOn={1}
        onWeekNumberClick={onWeekNumberClick}
      />,
    )

    const weekBtns = screen.getAllByRole('button', { name: /go to week \d+/i })
    await user.click(weekBtns[0] as HTMLElement)

    expect(onWeekNumberClick).toHaveBeenCalledTimes(1)
    // First arg is the week number (a number), second is array of dates
    expect(typeof onWeekNumberClick.mock.calls[0]?.[0]).toBe('number')
    expect(Array.isArray(onWeekNumberClick.mock.calls[0]?.[1])).toBe(true)
  })

  it('includes coarse pointer overrides for touch-friendly sizing', () => {
    const { container } = render(<Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} />)

    // Day cells should have coarse pointer height/width overrides
    const dayCells = container.querySelectorAll('td')
    expect(dayCells.length).toBeGreaterThan(0)
    const dayCellClass = dayCells[0]?.className
    expect(dayCellClass).toContain('[@media(pointer:coarse)]:h-11')
    expect(dayCellClass).toContain('[@media(pointer:coarse)]:w-11')

    // Day buttons should have coarse pointer size override
    const dayButtons = container.querySelectorAll('td button')
    expect(dayButtons.length).toBeGreaterThan(0)
    expect(dayButtons[0]?.className).toContain('[@media(pointer:coarse)]:size-11')

    // Nav buttons should have coarse pointer size override
    const navButtons = Array.from(container.querySelectorAll('button')).filter(
      (btn) => btn.querySelector('svg') && btn.className.includes('size-7'),
    )
    expect(navButtons.length).toBeGreaterThanOrEqual(2)
    for (const btn of navButtons) {
      expect(btn.className).toContain('[@media(pointer:coarse)]:size-10')
    }

    // Weekday headers should have coarse pointer width override
    const weekdayHeaders = container.querySelectorAll('th')
    expect(weekdayHeaders.length).toBeGreaterThan(0)
    expect(weekdayHeaders[0]?.className).toContain('[@media(pointer:coarse)]:w-11')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <Calendar
        mode="single"
        defaultMonth={new Date(2026, 2, 1)}
        showWeekNumber
        weekStartsOn={1}
        onWeekNumberClick={vi.fn()}
        onMonthClick={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
