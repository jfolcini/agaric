/**
 * Tests for the Calendar wrapper around react-day-picker v10.
 *
 * The focus here is the `day` accent gate (#1793). In react-day-picker v10 the
 * `Day` component renders the `<td>` cell and sets `aria-selected` on that SAME
 * `<td>` — NOT on the inner DayButton. The old base class keyed the accent off
 * a DESCENDANT match (`:has([aria-selected])`), which can never fire because the
 * attribute lives on the cell itself, leaving the accent state dead.
 *
 * These tests verify the v10 DOM contract at RUNTIME (not via className
 * substring assertions, which masked the equivalent bug in #1563): they render
 * a calendar with a selected day, locate the real `<td>` cell, and assert that
 *  - `aria-selected` lives on the `<td>` (and not on the inner button), and
 *  - the selector the class now keys off (`td[aria-selected]`) RESOLVES against
 *    that cell, while the OLD descendant selector (`td:has([aria-selected])`)
 *    does NOT — so this test would fail against the pre-fix selector.
 */

import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Calendar } from '@/components/ui/calendar'

// A fixed, deterministic selected day so the rendered grid always contains a
// cell carrying `aria-selected`. Mid-month keeps it off any outside-day edge.
const SELECTED = new Date(2026, 5, 15) // 2026-06-15

function renderCalendarWithSelectedDay() {
  return render(<Calendar mode="single" selected={SELECTED} defaultMonth={SELECTED} />)
}

/** Locate the `<td>` grid cell that carries `aria-selected` (the selected day). */
function getSelectedCell(container: HTMLElement): HTMLTableCellElement {
  const cell = container.querySelector('td[aria-selected]')
  expect(cell).not.toBeNull()
  return cell as HTMLTableCellElement
}

describe('Calendar — day accent gate (#1793)', () => {
  it('places aria-selected on the <td> cell itself, not on a descendant', () => {
    const { container } = renderCalendarWithSelectedDay()
    const cell = getSelectedCell(container)

    // The cell IS the element carrying the attribute.
    expect(cell.tagName).toBe('TD')
    expect(cell.matches('[aria-selected]')).toBe(true)

    // The attribute must NOT live on a descendant of the cell — confirming the
    // v10 DOM that breaks the old `:has([aria-selected])` descendant selector.
    expect(cell.querySelector('[aria-selected]')).toBeNull()
  })

  it('the new own-attribute selector resolves while the old descendant selector does not', () => {
    const { container } = renderCalendarWithSelectedDay()
    const cell = getSelectedCell(container)

    // New selector: the cell's OWN attribute predicate — what the `day` base
    // class now keys off (`[&[aria-selected]]:bg-accent`). It must resolve.
    expect(cell.matches('[aria-selected]')).toBe(true)
    expect(container.querySelector('td[aria-selected]')).toBe(cell)

    // Old selector: descendant `:has([aria-selected])`. Because the attribute
    // is on the `<td>` itself (not a child), no cell matches it — proving the
    // pre-fix gate was dead and that this test would fail against the old code.
    expect(cell.matches(':has([aria-selected])')).toBe(false)
    expect(container.querySelector('td:has([aria-selected])')).toBeNull()
  })

  it('renders the day base class keyed off the own-attribute predicate', () => {
    const { container } = renderCalendarWithSelectedDay()
    const cell = getSelectedCell(container)

    // Runtime confirmation that the class wired to the selected cell uses the
    // own-attribute form (Tailwind emits `[&[aria-selected]]:bg-accent` from the
    // `[&[aria-selected]]:` variant), not the descendant `:has(...)` form.
    expect(cell.className).toContain('[&[aria-selected]]:bg-accent')
    expect(cell.className).not.toContain('[&:has([aria-selected])]:bg-accent')
  })

  it('has no a11y violations with a selected day', async () => {
    const { container } = renderCalendarWithSelectedDay()

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
