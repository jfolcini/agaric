/**
 * Tests for the Calendar component.
 *
 * Validates:
 *  - displayName is set
 *  - Renders the calendar with data-slot
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { Calendar } from '@/components/ui/calendar'

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

  // #1563: a day that is BOTH today and selected used to receive `today`'s
  // accent fill and `selected`'s primary fill at equal specificity, so the
  // winner depended on Tailwind's generated source order (non-deterministic).
  // The fix gates today's accent fill behind `[&:not([aria-selected])]:` and
  // expresses "today" via an always-on ring, so the selected/primary fill is
  // the deterministic winner and the today cue never competes for the
  // background.
  //
  // In react-day-picker v10 the `Day` component renders the `<td>` cell and
  // sets `aria-selected` on that SAME `<td>` (not on the inner button). The gate
  // therefore keys off the cell's OWN attribute (`:not([aria-selected])`), NOT a
  // descendant `:has([aria-selected])` — the latter never matches (the attribute
  // is on the cell itself) and would leave `bg-accent` applying on a
  // selected-today cell, reintroducing the collision.
  //
  // #2246: these tests assert the RUNTIME resolution of the gate — the cell's
  // real `aria-selected` state and how the `:not([aria-selected])` selector
  // resolves against it via `td.matches()`. The earlier purely-decorative
  // substring checks (`bg-primary`, `ring-2`, `text-primary-foreground`, …)
  // were dropped: jsdom does not resolve Tailwind variants, so those lines
  // only re-stated the source className; which fill actually PAINTS is a CSS
  // cascade concern for the visual/e2e layer. Two class assertions are KEPT
  // as load-bearing companions of the runtime check, not as paint checks:
  // the gated token must EXIST on the cell (else `td.matches(gate)` proves
  // nothing about the component) and no bare, un-gated `bg-accent` may come
  // from the `today` modifier (the exact #1563 regression).
  describe('today + selected styling is deterministic (#1563)', () => {
    /** The cell (`<td>`) for today's day-of-month in the rendered grid. */
    function todayCell(container: HTMLElement): Element {
      // The `today` modifier is what we are validating, and it always renders
      // the `ring-primary/50` cue — so the today cell is the one carrying that
      // ring. This is a more robust locator than matching the day-of-month
      // number (which can also appear in an adjacent month's overflow row).
      const td = Array.from(container.querySelectorAll('td')).find((cell) =>
        cell.className.includes('ring-primary'),
      )
      if (!td) throw new Error('today cell not found')
      return td
    }

    /**
     * The arbitrary-variant selector that gates the today accent, as a bare CSS
     * selector applicable to the cell itself (Tailwind compiles `[&:not(...)]:`
     * to `.<class>:not(...)`, i.e. the `&` is the element carrying the class).
     */
    const ACCENT_GATE = ':not([aria-selected])'

    it('marks today-and-selected so the accent gate excludes it (aria-selected)', () => {
      const today = new Date()
      const { container } = render(<Calendar mode="single" selected={today} defaultMonth={today} />)
      const td = todayCell(container)

      // The cell itself carries `aria-selected` in react-day-picker v10.
      expect(td.getAttribute('aria-selected')).toBe('true')

      // The gated accent token exists on the cell (companion of the runtime
      // check below — without it the gate resolution proves nothing about
      // this component's classes)...
      expect(td.className).toContain(`[&${ACCENT_GATE}]:bg-accent`)
      // ...and RUNTIME check of the gate: on a selected cell
      // `:not([aria-selected])` must NOT match, so today's gated `bg-accent`
      // is excluded and the selected/primary fill is the deterministic winner.
      expect(td.matches(ACCENT_GATE)).toBe(false)

      // The old ungated `today: 'bg-accent ...'` token must be gone — no bare
      // `bg-accent` outside a gated/variant form (the #1563 regression).
      expect(td.className).not.toMatch(/(?<![\]:])\bbg-accent\b/)
    })

    it('leaves today unselected so the accent gate includes it (aria-selected)', () => {
      const today = new Date()
      const { container } = render(<Calendar mode="single" defaultMonth={today} />)
      const td = todayCell(container)

      // Not selected → cell has no aria-selected attribute.
      expect(td.getAttribute('aria-selected')).toBeNull()

      // Gated accent token exists, and RUNTIME check: `:not([aria-selected])`
      // matches an unselected cell, so today's gated accent fill is active.
      expect(td.className).toContain(`[&${ACCENT_GATE}]:bg-accent`)
      expect(td.matches(ACCENT_GATE)).toBe(true)
    })

    it('has no a11y violations with a selected today', async () => {
      const today = new Date()
      const { container } = render(<Calendar mode="single" selected={today} defaultMonth={today} />)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
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

  // #745 (continued): caption affordance presence and week-number
  // click-through. Consolidated here from the former
  // src/components/__tests__/Calendar.test.tsx (the duplicated caption-click
  // assertions were dropped — the click contract is covered by the block above).
  // #2246: the pure Tailwind class-substring tests from that file ("hover
  // bg-accent styling" and "coarse pointer overrides") were NOT carried over —
  // jsdom applies neither `hover:` nor `[@media(pointer:coarse)]:` variants,
  // so they only re-stated the source className; hover/touch sizing is a
  // runtime concern for the e2e/visual layer.
  describe('caption affordances & week numbers', () => {
    it('renders the month caption as plain text when onMonthClick is not provided', () => {
      render(<Calendar mode="single" defaultMonth={new Date(2026, 2, 1)} />)
      expect(screen.queryByRole('button', { name: /go to monthly view/i })).not.toBeInTheDocument()
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
      const weekBtns = screen.getAllByRole('button', { name: /go to week \d+/i })
      expect(weekBtns.length).toBeGreaterThanOrEqual(4)
    })

    it('fires onWeekNumberClick with the week number and its dates', async () => {
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
      expect(typeof onWeekNumberClick.mock.calls[0]?.[0]).toBe('number')
      expect(Array.isArray(onWeekNumberClick.mock.calls[0]?.[1])).toBe(true)
    })
  })

  // #1793: the `day` accent gate. In react-day-picker v10 the Day component
  // renders the <td> cell and sets `aria-selected` on that SAME <td> — not on
  // the inner DayButton. The old base class keyed the accent off a DESCENDANT
  // match (`:has([aria-selected])`), which can never fire because the attribute
  // lives on the cell itself. Consolidated here from the former
  // src/components/ui/calendar.test.tsx (which sat outside __tests__/).
  describe('day accent gate (#1793)', () => {
    // A fixed, deterministic selected day so the grid always contains a cell
    // carrying `aria-selected`. Mid-month keeps it off any outside-day edge.
    const SELECTED = new Date(2026, 5, 15) // 2026-06-15

    function renderCalendarWithSelectedDay() {
      return render(<Calendar mode="single" selected={SELECTED} defaultMonth={SELECTED} />)
    }

    function getSelectedCell(container: HTMLElement): HTMLTableCellElement {
      const cell = container.querySelector('td[aria-selected]')
      expect(cell).not.toBeNull()
      return cell as HTMLTableCellElement
    }

    it('places aria-selected on the <td> cell itself, not on a descendant', () => {
      const { container } = renderCalendarWithSelectedDay()
      const cell = getSelectedCell(container)

      expect(cell.tagName).toBe('TD')
      expect(cell.matches('[aria-selected]')).toBe(true)
      expect(cell.querySelector('[aria-selected]')).toBeNull()
    })

    it('the own-attribute selector resolves while the old descendant selector does not', () => {
      const { container } = renderCalendarWithSelectedDay()
      const cell = getSelectedCell(container)

      expect(cell.matches('[aria-selected]')).toBe(true)
      expect(container.querySelector('td[aria-selected]')).toBe(cell)

      expect(cell.matches(':has([aria-selected])')).toBe(false)
      expect(container.querySelector('td:has([aria-selected])')).toBeNull()
    })

    it('keys the day base class off the own-attribute predicate', () => {
      const { container } = renderCalendarWithSelectedDay()
      const cell = getSelectedCell(container)

      expect(cell.className).toContain('[&[aria-selected]]:bg-accent')
      expect(cell.className).not.toContain('[&:has([aria-selected])]:bg-accent')
    })

    it('has no a11y violations with a selected day', async () => {
      const { container } = renderCalendarWithSelectedDay()
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })
  })
})
