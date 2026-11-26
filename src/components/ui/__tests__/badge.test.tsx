/**
 * Tests for the Badge component.
 *
 * Validates:
 *  - Renders with default tone/size
 *  - Legacy `variant` prop still works as an alias for `tone`
 *  - `tone="status"` + statusState produces the right token colours
 *  - `tone="priority"` + priorityLevel delegates to priorityColor()
 *  - `size` variants render the expected utility classes
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Badge } from '@/components/ui/badge'

describe('Badge', () => {
  it('renders with default tone/size/shape', () => {
    render(<Badge>Status</Badge>)
    const badge = screen.getByText('Status')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('data-slot', 'badge')
    expect(badge).toHaveAttribute('data-variant', 'default')
    expect(badge.className).toContain('rounded-sm')
    expect(badge.className).not.toContain('rounded-full')
    expect(badge.className).toContain('text-xs')
  })

  it('aligns digits with tabular-nums on every tone', () => {
    render(
      <>
        <Badge>Default</Badge>
        <Badge tone="priority" priorityLevel="1">
          P1
        </Badge>
      </>,
    )
    expect(screen.getByText('Default')).toHaveClass('tabular-nums')
    expect(screen.getByText('P1')).toHaveClass('tabular-nums')
  })

  it('renders with secondary tone', () => {
    render(<Badge tone="secondary">Tag</Badge>)
    const badge = screen.getByText('Tag')
    expect(badge.className).toContain('bg-secondary')
  })

  // #1680: destructive surface uses the semantic --destructive-foreground
  // token (per-theme) rather than a hardcoded text-white literal.
  it('destructive tone uses the destructive-foreground token, not text-white', () => {
    render(<Badge tone="destructive">Danger</Badge>)
    const badge = screen.getByText('Danger')
    expect(badge.className).toContain('bg-destructive')
    expect(badge.className).toContain('text-destructive-foreground')
    expect(badge.className).not.toContain('text-white')
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
        <Badge tone="status" statusState="DONE">
          DONE
        </Badge>,
      )
      const badge = screen.getByText('DONE')
      expect(badge.className).toContain('bg-status-done')
      expect(badge.className).toContain('text-status-done-foreground')
    })

    it('applies DOING status colours', () => {
      render(
        <Badge tone="status" statusState="DOING">
          DOING
        </Badge>,
      )
      const badge = screen.getByText('DOING')
      expect(badge.className).toContain('bg-status-active')
      expect(badge.className).toContain('text-status-active-foreground')
    })

    it('applies TODO status colours', () => {
      render(
        <Badge tone="status" statusState="TODO">
          TODO
        </Badge>,
      )
      const badge = screen.getByText('TODO')
      expect(badge.className).toContain('bg-status-pending')
      expect(badge.className).toContain('text-status-pending-foreground')
    })

    it('applies overdue status colours', () => {
      render(
        <Badge tone="status" statusState="overdue">
          TODO
        </Badge>,
      )
      const badge = screen.getByText('TODO')
      expect(badge.className).toContain('bg-alert-warning')
      expect(badge.className).toContain('text-alert-warning-foreground')
    })

    it('defaults statusState to "default" when omitted', () => {
      render(<Badge tone="status">LATER</Badge>)
      const badge = screen.getByText('LATER')
      expect(badge.className).toContain('bg-status-pending')
    })
  })

  describe('tone="priority"', () => {
    it('applies urgent colour for priority "1"', () => {
      render(
        <Badge tone="priority" priorityLevel="1" size="sm">
          P1
        </Badge>,
      )
      const badge = screen.getByText('P1')
      expect(badge.className).toContain('bg-priority-urgent')
      expect(badge.className).toContain('text-priority-urgent-foreground')
    })

    it('applies high colour for priority "2"', () => {
      render(
        <Badge tone="priority" priorityLevel="2" size="sm">
          P2
        </Badge>,
      )
      const badge = screen.getByText('P2')
      expect(badge.className).toContain('bg-priority-high')
    })

    it('applies normal colour for priority "3"', () => {
      render(
        <Badge tone="priority" priorityLevel="3" size="sm">
          P3
        </Badge>,
      )
      const badge = screen.getByText('P3')
      expect(badge.className).toContain('bg-priority-normal')
    })

    it('applies the neutral colour for an out-of-range level', () => {
      render(
        <Badge tone="priority" priorityLevel="P0" size="sm">
          PP0
        </Badge>,
      )
      const badge = screen.getByText('PP0')
      expect(badge.className).toContain('bg-muted')
      expect(badge.className).not.toContain('bg-priority-')
    })

    it('a11y: no violations for priority tone', async () => {
      const { container } = render(
        <Badge tone="priority" priorityLevel="1" size="sm">
          P1
        </Badge>,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // #7040 (S7): a chip says what it is by its shape.
  describe('chip vocabulary', () => {
    it('a tag is a tint with no outline', () => {
      render(<Badge tone="tag">work</Badge>)
      const badge = screen.getByText('work')
      expect(badge).toHaveAttribute('data-variant', 'tag')
      expect(badge).toHaveClass('bg-muted', 'text-muted-foreground', 'border-transparent')
    })

    it("a tag takes its own colour from the caller's style", () => {
      render(
        <Badge tone="tag" style={{ backgroundColor: 'rgb(1, 2, 3)' }}>
          work
        </Badge>,
      )
      expect(screen.getByText('work').style.backgroundColor).toBe('rgb(1, 2, 3)')
    })

    it('a property is outlined with no fill', () => {
      render(<Badge tone="property">Effort: 1d</Badge>)
      const badge = screen.getByText('Effort: 1d')
      expect(badge).toHaveClass('border-border', 'text-muted-foreground')
      expect(badge.className).not.toMatch(/\bbg-/)
    })

    it('metadata is plain muted text: no fill, no outline, no padding', () => {
      render(<Badge tone="metadata">page</Badge>)
      const badge = screen.getByText('page')
      expect(badge).toHaveClass('border-transparent', 'px-0', 'py-0', 'text-muted-foreground')
      expect(badge).toHaveClass('font-normal')
      expect(badge.className).not.toMatch(/\bbg-/)
      // The size's padding gives way, whatever the size.
      expect(badge.className).not.toMatch(/\bpx-2\b/)
    })

    it('has no a11y violations in any of the three', async () => {
      const { container } = render(
        <p>
          <Badge tone="tag">work</Badge>
          <Badge tone="property">Effort: 1d</Badge>
          <Badge tone="metadata">page</Badge>
        </p>,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
