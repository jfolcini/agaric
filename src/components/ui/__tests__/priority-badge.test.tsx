/**
 * Tests for the PriorityBadge component.
 *
 * Validates:
 *  - Renders P{priority} text for each priority level
 *  - Applies correct color classes via priorityColor
 *  - Merges custom className
 *  - Base layout classes are present
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { PriorityBadge } from '../priority-badge'

describe('PriorityBadge', () => {
  it('renders P1 for priority "1"', () => {
    render(<PriorityBadge priority="1" />)
    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('renders P2 for priority "2"', () => {
    render(<PriorityBadge priority="2" />)
    expect(screen.getByText('P2')).toBeInTheDocument()
  })

  it('renders P3 for priority "3"', () => {
    render(<PriorityBadge priority="3" />)
    expect(screen.getByText('P3')).toBeInTheDocument()
  })

  it('applies urgent color classes for priority "1"', () => {
    render(<PriorityBadge priority="1" />)
    const el = screen.getByText('P1')
    expect(el.className).toContain('bg-priority-urgent')
    expect(el.className).toContain('text-priority-foreground')
  })

  it('applies high color classes for priority "2"', () => {
    render(<PriorityBadge priority="2" />)
    const el = screen.getByText('P2')
    expect(el.className).toContain('bg-priority-high')
    expect(el.className).toContain('text-priority-foreground')
  })

  it('applies normal color classes for priority "3"', () => {
    render(<PriorityBadge priority="3" />)
    const el = screen.getByText('P3')
    expect(el.className).toContain('bg-priority-normal')
    expect(el.className).toContain('text-priority-foreground')
  })

  it('applies base layout classes', () => {
    render(<PriorityBadge priority="1" />)
    const el = screen.getByText('P1')
    expect(el.className).toContain('inline-flex')
    expect(el.className).toContain('rounded')
    expect(el.className).toContain('text-xs')
    expect(el.className).toContain('font-bold')
  })

  it('merges custom className', () => {
    render(<PriorityBadge priority="1" className="my-custom" />)
    const el = screen.getByText('P1')
    expect(el.className).toContain('my-custom')
  })

  it('renders as a span element', () => {
    render(<PriorityBadge priority="1" />)
    const el = screen.getByText('P1')
    expect(el.tagName).toBe('SPAN')
  })

  it('a11y: no violations for priority 1', async () => {
    const { container } = render(<PriorityBadge priority="1" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations for priority 3', async () => {
    const { container } = render(<PriorityBadge priority="3" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLSpanElement>()
    render(<PriorityBadge ref={ref} priority="1" />)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })
})
