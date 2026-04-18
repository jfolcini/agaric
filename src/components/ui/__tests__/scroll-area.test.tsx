/**
 * Tests for the ScrollArea and ScrollBar components.
 *
 * Validates:
 *  - Render output and data-slot attributes
 *  - Ref forwarding for ScrollArea
 *  - displayName for both components
 *  - a11y compliance via axe audit
 *
 * Note: ScrollBar (Radix ScrollAreaScrollbar) only renders in the DOM when
 * content actually overflows, which doesn't happen in jsdom (no layout engine).
 * ScrollBar ref/render tests are therefore limited to displayName checks.
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { ScrollArea, ScrollBar } from '../scroll-area'

/** Helper: querySelector that throws on null. */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

describe('ScrollArea', () => {
  it('has displayName', () => {
    expect(ScrollArea.displayName).toBe('ScrollArea')
  })

  it('renders with data-slot="scroll-area"', () => {
    const { container } = render(
      <ScrollArea>
        <p>Content</p>
      </ScrollArea>,
    )
    const el = q(container, '[data-slot="scroll-area"]')
    expect(el).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(
      <ScrollArea className="h-72">
        <p>Content</p>
      </ScrollArea>,
    )
    const el = q(container, '[data-slot="scroll-area"]')
    expect(el.className).toContain('h-72')
    expect(el.className).toContain('relative')
    expect(el.className).toContain('overflow-hidden')
  })

  it('renders children inside the viewport', () => {
    const { container } = render(
      <ScrollArea>
        <p>Hello world</p>
      </ScrollArea>,
    )
    const viewport = q(container, '[data-slot="scroll-area-viewport"]')
    expect(viewport.textContent).toContain('Hello world')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <ScrollArea ref={ref}>
        <p>Content</p>
      </ScrollArea>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('scroll-area')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <ScrollArea className="h-48">
        <p>Scrollable content</p>
      </ScrollArea>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── UX-226: viewportRef, viewportClassName, viewportProps, orientation ──

  it('forwards viewportRef to the scroll viewport element', () => {
    const viewportRef = React.createRef<HTMLDivElement>()
    render(
      <ScrollArea viewportRef={viewportRef}>
        <p>Content</p>
      </ScrollArea>,
    )
    expect(viewportRef.current).toBeInstanceOf(HTMLDivElement)
    expect(viewportRef.current?.getAttribute('data-slot')).toBe('scroll-area-viewport')
  })

  it('accepts a callback viewportRef (fires when viewport mounts)', () => {
    let captured: HTMLDivElement | null = null
    render(
      <ScrollArea
        viewportRef={(el) => {
          captured = el
        }}
      >
        <p>Content</p>
      </ScrollArea>,
    )
    expect(captured).toBeInstanceOf(HTMLDivElement)
    expect((captured as unknown as HTMLElement).getAttribute('data-slot')).toBe(
      'scroll-area-viewport',
    )
  })

  it('applies viewportClassName on top of the default viewport classes', () => {
    const { container } = render(
      <ScrollArea viewportClassName="p-4 custom-viewport">
        <p>Content</p>
      </ScrollArea>,
    )
    const viewport = q(container, '[data-slot="scroll-area-viewport"]')
    expect(viewport.className).toContain('p-4')
    expect(viewport.className).toContain('custom-viewport')
    // Default classes are still present
    expect(viewport.className).toContain('size-full')
  })

  it('spreads viewportProps onto the viewport (role, tabIndex, aria-label)', () => {
    const { container } = render(
      <ScrollArea
        viewportProps={{
          role: 'listbox',
          tabIndex: 0,
          'aria-label': 'Items',
        }}
      >
        <p>Content</p>
      </ScrollArea>,
    )
    const viewport = q(container, '[data-slot="scroll-area-viewport"]')
    expect(viewport.getAttribute('role')).toBe('listbox')
    expect(viewport.getAttribute('tabindex')).toBe('0')
    expect(viewport.getAttribute('aria-label')).toBe('Items')
  })

  it('renders a vertical scrollbar by default (orientation omitted)', () => {
    // Radix only renders the scrollbar div when there's overflow or type="always".
    // We use type="always" to force emission so the orientation is inspectable.
    const { container } = render(
      <ScrollArea type="always">
        <p>Content</p>
      </ScrollArea>,
    )
    const bars = container.querySelectorAll('[data-slot="scroll-area-scrollbar"]')
    const orientations = Array.from(bars).map((b) => b.getAttribute('data-orientation'))
    expect(orientations).toContain('vertical')
    expect(orientations).not.toContain('horizontal')
  })

  it('renders a horizontal scrollbar when orientation="horizontal"', () => {
    const { container } = render(
      <ScrollArea type="always" orientation="horizontal">
        <p>Content</p>
      </ScrollArea>,
    )
    const bars = container.querySelectorAll('[data-slot="scroll-area-scrollbar"]')
    const orientations = Array.from(bars).map((b) => b.getAttribute('data-orientation'))
    expect(orientations).toContain('horizontal')
    expect(orientations).not.toContain('vertical')
  })

  it('renders both scrollbars when orientation="both"', () => {
    const { container } = render(
      <ScrollArea type="always" orientation="both">
        <p>Content</p>
      </ScrollArea>,
    )
    const bars = container.querySelectorAll('[data-slot="scroll-area-scrollbar"]')
    const orientations = Array.from(bars).map((b) => b.getAttribute('data-orientation'))
    expect(orientations).toContain('vertical')
    expect(orientations).toContain('horizontal')
  })

  it('spreads remaining props onto the root (data-* attributes)', () => {
    const { container } = render(
      <ScrollArea data-testid="custom-scroll" data-foo="bar">
        <p>Content</p>
      </ScrollArea>,
    )
    const root = q(container, '[data-slot="scroll-area"]')
    expect(root.getAttribute('data-testid')).toBe('custom-scroll')
    expect(root.getAttribute('data-foo')).toBe('bar')
  })

  it('has no a11y violations with orientation="horizontal"', async () => {
    const { container } = render(
      <ScrollArea orientation="horizontal" className="w-48">
        <p>Wide horizontal content</p>
      </ScrollArea>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('ScrollBar', () => {
  it('has displayName', () => {
    expect(ScrollBar.displayName).toBe('ScrollBar')
  })
})
