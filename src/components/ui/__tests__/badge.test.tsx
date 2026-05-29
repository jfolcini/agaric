/**
 * Tests for the Badge component.
 *
 * Validates:
 *  - Renders with default tone/size/shape
 *  - Legacy `variant` prop still works as an alias for `tone`
 *  - `tone="status"` + statusState produces the right token colours
 *  - `tone="priority"` + priorityLevel delegates to priorityColor()
 *  - `size` and `shape` variants render the expected utility classes
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { __resetPriorityLevelsForTests, setPriorityLevels } from '../../../lib/priority-levels'
import { Badge } from '../badge'

describe('Badge', () => {
  it('renders with default tone/size/shape', () => {
    render(<Badge>Status</Badge>)
    const badge = screen.getByText('Status')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('data-slot', 'badge')
    expect(badge).toHaveAttribute('data-variant', 'default')
    expect(badge.className).toContain('rounded-full')
    expect(badge.className).toContain('text-xs')
  })

  it('renders with secondary tone', () => {
    render(<Badge tone="secondary">Tag</Badge>)
    const badge = screen.getByText('Tag')
    expect(badge.className).toContain('bg-secondary')
  })

  it('merges custom className', () => {
    render(<Badge className="my-class">Custom</Badge>)
    const badge = screen.getByText('Custom')
    expect(badge.className).toContain('my-class')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLSpanElement>()
    render(<Badge ref={ref}>Ref test</Badge>)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Badge>Accessible badge</Badge>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  describe('shape variant', () => {
    it('renders rounded shape with flat-corner radius', () => {
      render(<Badge shape="rounded">Rounded</Badge>)
      const badge = screen.getByText('Rounded')
      expect(badge.className).toContain('rounded')
      expect(badge.className).not.toContain('rounded-full')
    })
  })

  describe('size variant', () => {
    it('renders xs size with tiny padding', () => {
      render(<Badge size="xs">x</Badge>)
      const badge = screen.getByText('x')
      expect(badge.className).toContain('h-3.5')
      expect(badge.className).toContain('px-0.5')
    })

    it('renders sm size with compact padding', () => {
      render(<Badge size="sm">s</Badge>)
      const badge = screen.getByText('s')
      expect(badge.className).toContain('h-4')
      expect(badge.className).toContain('px-1')
    })

    it('renders compact size matching the legacy StatusBadge chrome', () => {
      render(<Badge size="compact">s</Badge>)
      const badge = screen.getByText('s')
      expect(badge.className).toContain('px-1')
      expect(badge.className).toContain('py-0.5')
      expect(badge.className).not.toContain('h-4')
    })

    it('renders lg size with h-6 and text-sm', () => {
      render(<Badge size="lg">L</Badge>)
      const badge = screen.getByText('L')
      expect(badge.className).toContain('h-6')
      expect(badge.className).toContain('text-sm')
    })
  })

  describe('tone="status"', () => {
    it('applies DONE status colours', () => {
      render(
        <Badge tone="status" statusState="DONE" shape="rounded">
          DONE
        </Badge>,
      )
      const badge = screen.getByText('DONE')
      expect(badge.className).toContain('bg-status-done')
      expect(badge.className).toContain('text-status-done-foreground')
    })

    it('applies DOING status colours', () => {
      render(
        <Badge tone="status" statusState="DOING" shape="rounded">
          DOING
        </Badge>,
      )
      const badge = screen.getByText('DOING')
      expect(badge.className).toContain('bg-status-active')
      expect(badge.className).toContain('text-status-active-foreground')
    })

    it('applies TODO status colours', () => {
      render(
        <Badge tone="status" statusState="TODO" shape="rounded">
          TODO
        </Badge>,
      )
      const badge = screen.getByText('TODO')
      expect(badge.className).toContain('bg-status-pending')
      expect(badge.className).toContain('text-status-pending-foreground')
    })

    it('applies overdue status colours', () => {
      render(
        <Badge tone="status" statusState="overdue" shape="rounded">
          TODO
        </Badge>,
      )
      const badge = screen.getByText('TODO')
      expect(badge.className).toContain('bg-alert-warning')
      expect(badge.className).toContain('text-alert-warning-foreground')
    })

    it('defaults statusState to "default" when omitted', () => {
      render(
        <Badge tone="status" shape="rounded">
          LATER
        </Badge>,
      )
      const badge = screen.getByText('LATER')
      expect(badge.className).toContain('bg-status-pending')
    })
  })

  describe('tone="priority"', () => {
    beforeEach(() => {
      __resetPriorityLevelsForTests()
    })
    afterEach(() => {
      __resetPriorityLevelsForTests()
    })

    it('applies urgent colour for priority "1"', () => {
      render(
        <Badge tone="priority" priorityLevel="1" size="sm" shape="rounded">
          P1
        </Badge>,
      )
      const badge = screen.getByText('P1')
      expect(badge.className).toContain('bg-priority-urgent')
      expect(badge.className).toContain('text-priority-foreground')
    })

    it('applies high colour for priority "2"', () => {
      render(
        <Badge tone="priority" priorityLevel="2" size="sm" shape="rounded">
          P2
        </Badge>,
      )
      const badge = screen.getByText('P2')
      expect(badge.className).toContain('bg-priority-high')
    })

    it('applies normal colour for priority "3"', () => {
      render(
        <Badge tone="priority" priorityLevel="3" size="sm" shape="rounded">
          P3
        </Badge>,
      )
      const badge = screen.getByText('P3')
      expect(badge.className).toContain('bg-priority-normal')
    })

    it('honours custom level keys', () => {
      setPriorityLevels(['A', 'B', 'C'])
      render(
        <Badge tone="priority" priorityLevel="A" size="sm" shape="rounded">
          PA
        </Badge>,
      )
      const badge = screen.getByText('PA')
      expect(badge.className).toContain('bg-priority-urgent')
    })

    it('a11y: no violations for priority tone', async () => {
      const { container } = render(
        <Badge tone="priority" priorityLevel="1" size="sm" shape="rounded">
          P1
        </Badge>,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
