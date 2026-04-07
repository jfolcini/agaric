/**
 * Tests for the Calendar component.
 *
 * Validates:
 *  - displayName is set
 *  - Renders the calendar with data-slot
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
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
})
