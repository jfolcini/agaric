/**
 * Tests for the Button component.
 *
 * Validates:
 *  - Each size variant renders correctly
 *  - Coarse pointer media query classes are present for touch-target sizing
 *    on EVERY size variant — lg/icon-lg are h-10/size-10 (40px), below the
 *    44px AGENTS.md touch-target mandate, so they bump to 44px too (#759)
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Button } from '../button'

/** Helper: render a Button with a given size and return the DOM element. */
function renderButton(
  size: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg',
  label = 'Click',
) {
  render(<Button size={size}>{label}</Button>)
  return screen.getByRole('button', { name: label })
}

describe('Button', () => {
  // -- Size variant rendering -------------------------------------------------

  it('renders default size variant', () => {
    const btn = renderButton('default')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-9')
  })

  it('renders xs size variant', () => {
    const btn = renderButton('xs')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-6')
  })

  it('renders sm size variant', () => {
    const btn = renderButton('sm')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-8')
  })

  it('renders lg size variant', () => {
    const btn = renderButton('lg')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-10')
  })

  it('renders icon size variant', () => {
    const btn = renderButton('icon')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-9')
  })

  it('renders icon-xs size variant', () => {
    const btn = renderButton('icon-xs')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-6')
  })

  it('renders icon-sm size variant', () => {
    const btn = renderButton('icon-sm')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-8')
  })

  it('renders icon-lg size variant', () => {
    const btn = renderButton('icon-lg')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-10')
  })

  // -- Coarse pointer media query overrides -----------------------------------

  it('default size includes coarse pointer height override', () => {
    const btn = renderButton('default')
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  it('xs size includes coarse pointer height and padding overrides', () => {
    const btn = renderButton('xs')
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
    expect(btn.className).toContain('[@media(pointer:coarse)]:px-3')
  })

  it('sm size includes coarse pointer height override', () => {
    const btn = renderButton('sm')
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  // #759: lg is h-10 (40px) — below the 44px touch-target mandate, so it
  // gets the same coarse-pointer bump as every other sub-44px size.
  it('lg size includes coarse pointer height override (h-10 is only 40px)', () => {
    const btn = renderButton('lg')
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  it('icon size includes coarse pointer size override', () => {
    const btn = renderButton('icon')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-11')
  })

  it('icon-xs size includes coarse pointer size override', () => {
    const btn = renderButton('icon-xs')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-11')
  })

  it('icon-sm size includes coarse pointer size override', () => {
    const btn = renderButton('icon-sm')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-11')
  })

  // #759: icon-lg is size-10 (40px) — below the 44px touch-target mandate.
  it('icon-lg size includes coarse pointer size override (size-10 is only 40px)', () => {
    const btn = renderButton('icon-lg')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-11')
  })

  // -- active-press scale (#1012) ---------------------------------------------

  // #1012: the press-compress scale lives once in the cva base as
  // `active:scale-95` (matching the 26 app-wide scale-95 usages); icon
  // variants no longer re-declare it.
  it('applies active:scale-95 from the base on every size', () => {
    for (const size of ['default', 'sm', 'icon', 'icon-sm', 'icon-lg'] as const) {
      render(<Button size={size}>{`press-${size}`}</Button>)
      const btn = screen.getByRole('button', { name: `press-${size}` })
      expect(btn.className).toContain('active:scale-95')
      expect(btn.className).not.toContain('active:scale-[0.98]')
    }
  })

  // -- children (#1030) -------------------------------------------------------

  it('renders text children', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('renders element/fragment children', () => {
    render(
      <Button>
        <span aria-hidden="true">+</span>
        <span>Add item</span>
      </Button>,
    )
    // The aria-hidden icon span is excluded from the accessible name.
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument()
  })

  it('accepts children typed as React.ReactNode (type-level)', () => {
    // `children` is explicit in the prop type, so any ReactNode is accepted.
    const node: React.ReactNode = <span>typed</span>
    render(<Button>{node}</Button>)
    expect(screen.getByRole('button', { name: 'typed' })).toBeInTheDocument()
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations with default variant', async () => {
    const { container } = render(<Button>Accessible Button</Button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with icon size variant', async () => {
    const { container } = render(
      <Button size="icon" aria-label="Icon action">
        <span aria-hidden="true">X</span>
      </Button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #1680: destructive surface uses the semantic --destructive-foreground
  // token (per-theme) rather than a hardcoded text-white literal.
  it('destructive variant uses the destructive-foreground token, not text-white', () => {
    render(<Button variant="destructive">Delete</Button>)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toContain('text-destructive-foreground')
    expect(btn.className).not.toContain('text-white')
  })

  it('has no a11y violations with destructive variant', async () => {
    const { container } = render(<Button variant="destructive">Delete</Button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
