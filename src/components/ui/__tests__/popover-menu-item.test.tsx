/**
 * Tests for the PopoverMenuItem component.
 *
 * Validates:
 *  - Renders children
 *  - Applies active styling when active=true
 *  - Applies disabled styling when disabled=true
 *  - Calls onClick handler
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PopoverMenuItem } from '../popover-menu-item'

describe('PopoverMenuItem', () => {
  it('renders children', () => {
    render(<PopoverMenuItem>Status</PopoverMenuItem>)
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument()
  })

  it('applies active styling when active=true', () => {
    render(<PopoverMenuItem active>Active item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Active item' })
    expect(btn.className).toContain('bg-accent')
    expect(btn.className).toContain('font-medium')
  })

  it('applies disabled styling when disabled=true', () => {
    render(<PopoverMenuItem disabled>Disabled item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Disabled item' })
    expect(btn).toBeDisabled()
    expect(btn.className).toContain('opacity-50')
    expect(btn.className).toContain('cursor-not-allowed')
  })

  it('calls onClick handler', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    render(<PopoverMenuItem onClick={handleClick}>Click me</PopoverMenuItem>)
    await user.click(screen.getByRole('button', { name: 'Click me' }))
    expect(handleClick).toHaveBeenCalledOnce()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PopoverMenuItem>Accessible item</PopoverMenuItem>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes coarse pointer touch-target class', () => {
    render(<PopoverMenuItem>Touch item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Touch item' })
    expect(btn.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('includes focus-visible ring classes', () => {
    render(<PopoverMenuItem>Focus item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Focus item' })
    expect(btn.className).toContain('focus-ring-visible')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLButtonElement>()
    render(<PopoverMenuItem ref={ref}>Item</PopoverMenuItem>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  // asChild polymorphism (Radix Slot): menu items should be renderable
  // as `<a>` so popover menus can host navigation links without the
  // per-call-site composition workaround.
  it('renders as <a> when asChild is true with an anchor child', () => {
    render(
      <PopoverMenuItem asChild className="menu-link">
        <a href="/page/abc">Open page</a>
      </PopoverMenuItem>,
    )
    const link = screen.getByRole('link', { name: 'Open page' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/page/abc')
    expect(link).toHaveAttribute('data-slot', 'popover-menu-item')
    // Base + caller classes are merged onto the anchor.
    expect(link.className).toContain('hover:bg-accent')
    expect(link.className).toContain('menu-link')
    // `type="button"` must NOT leak onto the anchor (invalid HTML).
    expect(link).not.toHaveAttribute('type')
  })

  // -- disabled under asChild (#1031) -----------------------------------------

  it('honors disabled on the native button: aria-disabled-equivalent + non-clickable', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    render(
      <PopoverMenuItem disabled onClick={handleClick}>
        Disabled item
      </PopoverMenuItem>,
    )
    const btn = screen.getByRole('button', { name: 'Disabled item' })
    expect(btn).toBeDisabled()
    await user.click(btn)
    expect(handleClick).not.toHaveBeenCalled()
  })

  it('combining `asChild` with `disabled` is a compile error (type guard)', () => {
    const bad = (
      // @ts-expect-error — `disabled` is `never` when `asChild` is true, because
      // the visual-only CVA styling cannot make the child link non-interactive.
      <PopoverMenuItem asChild disabled>
        <a href="/x">Nope</a>
      </PopoverMenuItem>
    )
    expect(bad).toBeTruthy()
  })

  it('warns in dev when disabled is forced through asChild (runtime backstop)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      render(
        // Spread erases the static type guard; the runtime warning backstops it.
        <PopoverMenuItem {...({ asChild: true, disabled: true } as Record<string, unknown>)}>
          <a href="/x">Link</a>
        </PopoverMenuItem>,
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no effect with `asChild`'))
    } finally {
      warn.mockRestore()
    }
  })
})
