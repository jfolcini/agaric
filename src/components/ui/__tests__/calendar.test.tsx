/**
 * Tests for the Calendar component.
 *
 * Validates:
 *  - displayName is set
 *  - Renders the calendar with data-slot
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { Calendar } from '../calendar'

/** Helper: querySelector that throws on null. */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

describe('Calendar', () => {
  it('has displayName', () => {
    expect(Calendar.displayName).toBe('Calendar')
  })

  it('renders with data-slot="calendar"', () => {
    const { container } = render(<Calendar />)
    const el = q(container, '[data-slot="calendar"]')
    expect(el).toBeInTheDocument()
  })

  it('renders the DayPicker inside', () => {
    const { container } = render(<Calendar />)
    const rdp = container.querySelector('.rdp')
    expect(rdp).toBeInTheDocument()
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<Calendar ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('calendar')
  })

  it('applies custom className to the DayPicker', () => {
    const { container } = render(<Calendar className="my-custom" />)
    const rdp = q(container, '.rdp')
    expect(rdp.className).toContain('my-custom')
    expect(rdp.className).toContain('p-3')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Calendar />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #745: the caption "go to monthly view" click must target the CURRENTLY
  // displayed month, not the month the picker opened on (`defaultMonth`).
  // Previously the CaptionLabel called `onMonthClick(props.defaultMonth)`, so
  // after paging with the chevrons it jumped back to the opening month.
  describe('caption click targets the displayed month (#745)', () => {
    it('fires onMonthClick with defaultMonth before any paging', () => {
      const onMonthClick = vi.fn<(m: Date) => void>()
      // Mid-month date proves we receive the first-of-month, not the raw date.
      render(<Calendar defaultMonth={new Date(2025, 5, 15)} onMonthClick={onMonthClick} />)

      fireEvent.click(screen.getByRole('button', { name: 'Go to monthly view' }))

      expect(onMonthClick).toHaveBeenCalledTimes(1)
      const arg = onMonthClick.mock.calls[0]?.[0] as Date
      expect(arg.getFullYear()).toBe(2025)
      expect(arg.getMonth()).toBe(5) // June (first of the displayed month)
    })

    it('fires onMonthClick with the NEW month after paging forward', () => {
      const onMonthClick = vi.fn<(m: Date) => void>()
      render(<Calendar defaultMonth={new Date(2025, 5, 1)} onMonthClick={onMonthClick} />)

      // Page forward one month (June -> July) via the next-month nav button.
      fireEvent.click(screen.getByRole('button', { name: /next month/i }))
      // Now click the caption — it must target July, not the opening June.
      fireEvent.click(screen.getByRole('button', { name: 'Go to monthly view' }))

      expect(onMonthClick).toHaveBeenCalledTimes(1)
      const arg = onMonthClick.mock.calls[0]?.[0] as Date
      expect(arg.getFullYear()).toBe(2025)
      expect(arg.getMonth()).toBe(6) // July — the currently displayed month
    })

    it('still pages with the chevrons after the month became context-driven', () => {
      const onMonthClick = vi.fn<(m: Date) => void>()
      render(<Calendar defaultMonth={new Date(2025, 5, 1)} onMonthClick={onMonthClick} />)

      // Forward twice, back once => August (month index 7).
      fireEvent.click(screen.getByRole('button', { name: /next month/i }))
      fireEvent.click(screen.getByRole('button', { name: /next month/i }))
      fireEvent.click(screen.getByRole('button', { name: /previous month/i }))
      fireEvent.click(screen.getByRole('button', { name: 'Go to monthly view' }))

      const arg = onMonthClick.mock.calls[0]?.[0] as Date
      expect(arg.getMonth()).toBe(6) // July (June +2 -1)
    })
  })
})
