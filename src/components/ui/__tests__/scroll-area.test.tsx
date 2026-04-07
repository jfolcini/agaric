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
})

describe('ScrollBar', () => {
  it('has displayName', () => {
    expect(ScrollBar.displayName).toBe('ScrollBar')
  })
})
