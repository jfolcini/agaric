/**
 * Tests for the AlertListItem component.
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
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { AlertListItem } from '../alert-list-item'

describe('AlertListItem', () => {
  it('renders children', () => {
    render(
      <ul>
        <AlertListItem>Item content</AlertListItem>
      </ul>,
    )
    expect(screen.getByText('Item content')).toBeInTheDocument()
  })

  it('renders as an li element', () => {
    render(
      <ul>
        <AlertListItem>Item</AlertListItem>
      </ul>,
    )
    expect(screen.getByText('Item').closest('li')).toBeTruthy()
  })

  it('applies destructive variant classes', () => {
    render(
      <ul>
        <AlertListItem variant="destructive" data-testid="item">
          Content
        </AlertListItem>
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
        <AlertListItem variant="pending" data-testid="item">
          Content
        </AlertListItem>
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
        <AlertListItem data-testid="item">Content</AlertListItem>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('border-destructive/20')
  })

  it('applies base classes to all variants', () => {
    render(
      <ul>
        <AlertListItem data-testid="item">Content</AlertListItem>
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
        <AlertListItem className="extra" data-testid="item">
          Content
        </AlertListItem>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el.className).toContain('extra')
  })

  it('forwards HTML attributes', () => {
    render(
      <ul>
        <AlertListItem tabIndex={0} data-testid="item">
          Content
        </AlertListItem>
      </ul>,
    )
    const el = screen.getByTestId('item')
    expect(el).toHaveAttribute('tabindex', '0')
  })

  it('a11y: no violations with destructive variant', async () => {
    const { container } = render(
      <ul>
        <AlertListItem variant="destructive">Alert item</AlertListItem>
      </ul>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations with pending variant', async () => {
    const { container } = render(
      <ul>
        <AlertListItem variant="pending">Pending item</AlertListItem>
      </ul>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
