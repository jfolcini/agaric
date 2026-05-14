/**
 * Tests for the AlertListRow component (renamed from AlertListItem
 * to break the badge-naming collision; UX item 4 / Maintain 2c).
 *
 * Validates:
 *  - Each variant renders with correct class names
 *  - Default variant is destructive
 *  - Children are rendered correctly
 *  - Custom className is merged
 *  - HTML attributes are forwarded
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { AlertListRow } from '../alert-list-row'

describe('AlertListRow', () => {
  it('renders children', () => {
    render(
      <ul>
        <AlertListRow>Item content</AlertListRow>
      </ul>,
    )
    expect(screen.getByText('Item content')).toBeInTheDocument()
  })

  it('renders as an li element', () => {
    render(
      <ul>
        <AlertListRow>Item</AlertListRow>
      </ul>,
    )
    expect(screen.getByText('Item').closest('li')).toBeTruthy()
  })

  it('applies destructive variant classes', () => {
    render(
      <ul>
        <AlertListRow variant="destructive" data-testid="item">
          Content
        </AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('border-destructive/20')
    expect(el.className).toContain('bg-destructive/5')
    expect(el.className).toContain('hover:bg-destructive/10')
  })

  it('applies pending variant classes', () => {
    render(
      <ul>
        <AlertListRow variant="pending" data-testid="item">
          Content
        </AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('border-status-pending/30')
    expect(el.className).toContain('bg-status-pending/30')
    expect(el.className).toContain('hover:bg-status-pending/50')
  })

  it('uses destructive variant as default', () => {
    render(
      <ul>
        <AlertListRow data-testid="item">Content</AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('border-destructive/20')
  })

  it('applies base classes to all variants', () => {
    render(
      <ul>
        <AlertListRow data-testid="item">Content</AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('flex')
    expect(el.className).toContain('items-center')
    expect(el.className).toContain('gap-2')
    expect(el.className).toContain('rounded-md')
    expect(el.className).toContain('border')
    expect(el.className).toContain('cursor-pointer')
  })

  it('merges custom className', () => {
    render(
      <ul>
        <AlertListRow className="extra" data-testid="item">
          Content
        </AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('extra')
  })

  it('forwards HTML attributes', () => {
    render(
      <ul>
        <AlertListRow tabIndex={0} data-testid="item">
          Content
        </AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el).toHaveAttribute('tabindex', '0')
  })

  it('a11y: no violations with destructive variant', async () => {
    const { container } = render(
      <ul>
        <AlertListRow variant="destructive">Alert item</AlertListRow>
      </ul>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations with pending variant', async () => {
    const { container } = render(
      <ul>
        <AlertListRow variant="pending">Pending item</AlertListRow>
      </ul>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes coarse pointer touch-target class', () => {
    render(
      <ul>
        <AlertListRow data-testid="item">Touch item</AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('includes focus-visible ring classes', () => {
    render(
      <ul>
        <AlertListRow data-testid="item">Focus item</AlertListRow>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('focus-ring-visible')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLLIElement>()
    render(
      <ul>
        <AlertListRow ref={ref}>Item</AlertListRow>
      </ul>,
    )
    expect(ref.current).toBeInstanceOf(HTMLLIElement)
  })

  // asChild polymorphism (Radix Slot): consumers can render the alert
  // chrome as an `<a>` for navigable alerts while preserving the merged
  // variant + caller className.
  it('renders as <a> when asChild is true with an anchor child', () => {
    render(
      <ul>
        <AlertListRow asChild className="extra" data-testid="item">
          <a href="/conflict/abc">View conflict</a>
        </AlertListRow>
      </ul>,
    )
    const link = screen.getByTestId('item')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/conflict/abc')
    expect(link).toHaveAttribute('data-slot', 'alert-list-row')
    expect(link.className).toContain('border-destructive/20')
    expect(link.className).toContain('extra')
  })
})
