/**
 * Tests for the SectionTitle component.
 *
 * Validates:
 *  - Renders label and count
 * Applies semantic color tokens (prop is now a typed enum)
 *  - Defaults to `text-foreground` when `color` is omitted
 *  - Forwards ref to the h4 element
 *  - Merges custom className
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SectionTitle } from '../section-title'

describe('SectionTitle', () => {
  it('renders label text', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    expect(screen.getByText('Overdue')).toBeInTheDocument()
  })

  it('renders count in parentheses', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    expect(screen.getByText('(3)')).toBeInTheDocument()
  })

  it('renders as an h4 element', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading).toBeInTheDocument()
  })

  it('maps color="overdue" to the destructive semantic token', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-destructive')
  })

  it('maps color="done" to text-status-done-foreground', () => {
    render(<SectionTitle color="done" label="Done" count={1} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-status-done-foreground')
  })

  it('maps color="active" to text-status-active-foreground', () => {
    render(<SectionTitle color="active" label="Active" count={1} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-status-active-foreground')
  })

  it('maps color="pending" to text-status-pending-foreground', () => {
    render(<SectionTitle color="pending" label="Pending" count={1} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-status-pending-foreground')
  })

  it('defaults to text-foreground when color is omitted', () => {
    render(<SectionTitle label="Default" count={0} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-foreground')
  })

  it('merges custom className', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} className="my-custom" />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('my-custom')
  })

  it('applies base layout classes', () => {
    render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-xs')
    expect(heading.className).toContain('font-semibold')
    expect(heading.className).toContain('flex')
    expect(heading.className).toContain('items-center')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLHeadingElement>()
    render(<SectionTitle ref={ref} color="overdue" label="Overdue" count={3} />)
    expect(ref.current).toBeInstanceOf(HTMLHeadingElement)
  })

  it('forwards data-testid, extra aria-*, id, and handlers onto the h4', () => {
    const handleClick = vi.fn()
    render(
      <SectionTitle
        color="overdue"
        label="Overdue"
        count={3}
        data-testid="overdue-heading"
        id="sec-overdue"
        aria-describedby="hint"
        onClick={handleClick}
      />,
    )
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading).toHaveAttribute('data-testid', 'overdue-heading')
    expect(heading).toHaveAttribute('id', 'sec-overdue')
    expect(heading).toHaveAttribute('aria-describedby', 'hint')

    heading.click()
    expect(handleClick).toHaveBeenCalledTimes(1)

    // Managed defaults still hold alongside forwarded props.
    expect(heading).toHaveAttribute('data-slot', 'section-title')
    expect(heading.className).toContain('text-destructive')
  })

  it('a11y: no violations', async () => {
    const { container } = render(<SectionTitle color="overdue" label="Overdue" count={3} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
