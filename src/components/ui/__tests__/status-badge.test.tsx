/**
 * Tests for the StatusBadge component.
 *
 * Validates:
 *  - Each state variant renders with correct class names
 *  - Default variant is applied when no state prop is provided
 *  - Children are rendered correctly
 *  - Custom className is merged
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { StatusBadge } from '../status-badge'

describe('StatusBadge', () => {
  it('renders children text', () => {
    render(<StatusBadge state="TODO">TODO</StatusBadge>)
    expect(screen.getByText('TODO')).toBeInTheDocument()
  })

  it('applies DONE variant classes', () => {
    render(<StatusBadge state="DONE">DONE</StatusBadge>)
    const el = screen.getByText('DONE')
    expect(el.className).toContain('bg-status-done')
    expect(el.className).toContain('text-status-done-foreground')
  })

  it('applies DOING variant classes', () => {
    render(<StatusBadge state="DOING">DOING</StatusBadge>)
    const el = screen.getByText('DOING')
    expect(el.className).toContain('bg-status-active')
    expect(el.className).toContain('text-status-active-foreground')
  })

  it('applies TODO variant classes', () => {
    render(<StatusBadge state="TODO">TODO</StatusBadge>)
    const el = screen.getByText('TODO')
    expect(el.className).toContain('bg-status-pending')
    expect(el.className).toContain('text-status-pending-foreground')
  })

  it('applies default variant classes', () => {
    render(<StatusBadge state="default">LATER</StatusBadge>)
    const el = screen.getByText('LATER')
    expect(el.className).toContain('bg-status-pending')
    expect(el.className).toContain('text-status-pending-foreground')
  })

  it('applies overdue variant classes', () => {
    render(<StatusBadge state="overdue">TODO</StatusBadge>)
    const el = screen.getByText('TODO')
    expect(el.className).toContain('bg-yellow-100')
    expect(el.className).toContain('text-yellow-800')
  })

  it('uses default variant when state is not provided', () => {
    render(<StatusBadge>UNKNOWN</StatusBadge>)
    const el = screen.getByText('UNKNOWN')
    expect(el.className).toContain('bg-status-pending')
  })

  it('applies base classes to all variants', () => {
    render(<StatusBadge state="DONE">DONE</StatusBadge>)
    const el = screen.getByText('DONE')
    expect(el.className).toContain('rounded')
    expect(el.className).toContain('text-xs')
    expect(el.className).toContain('font-bold')
    expect(el.className).toContain('leading-none')
  })

  it('merges custom className', () => {
    render(
      <StatusBadge state="TODO" className="extra-class">
        TODO
      </StatusBadge>,
    )
    const el = screen.getByText('TODO')
    expect(el.className).toContain('extra-class')
  })

  it('renders as a span element', () => {
    render(<StatusBadge state="TODO">TODO</StatusBadge>)
    const el = screen.getByText('TODO')
    expect(el.tagName).toBe('SPAN')
  })

  it('a11y: no violations with DONE variant', async () => {
    const { container } = render(<StatusBadge state="DONE">DONE</StatusBadge>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations with overdue variant', async () => {
    const { container } = render(<StatusBadge state="overdue">TODO</StatusBadge>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
