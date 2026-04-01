/**
 * Tests for the Button component.
 *
 * Validates:
 *  - Each size variant renders correctly
 *  - Coarse pointer media query classes are present for touch-target sizing
 *  - lg and icon-lg variants do NOT add coarse overrides (already ≥48px)
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
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
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-10')
    expect(btn.className).toContain('[@media(pointer:coarse)]:px-3')
  })

  it('sm size includes coarse pointer height override', () => {
    const btn = renderButton('sm')
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-10')
  })

  it('lg size does NOT include coarse pointer override (already >=48px)', () => {
    const btn = renderButton('lg')
    expect(btn.className).not.toContain('[@media(pointer:coarse)]')
  })

  it('icon size includes coarse pointer size override', () => {
    const btn = renderButton('icon')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-11')
  })

  it('icon-xs size includes coarse pointer size override', () => {
    const btn = renderButton('icon-xs')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-10')
  })

  it('icon-sm size includes coarse pointer size override', () => {
    const btn = renderButton('icon-sm')
    expect(btn.className).toContain('[@media(pointer:coarse)]:size-10')
  })

  it('icon-lg size does NOT include coarse pointer override (already >=48px)', () => {
    const btn = renderButton('icon-lg')
    expect(btn.className).not.toContain('[@media(pointer:coarse)]')
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

  it('has no a11y violations with destructive variant', async () => {
    const { container } = render(<Button variant="destructive">Delete</Button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
