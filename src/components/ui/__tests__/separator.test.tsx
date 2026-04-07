/**
 * Tests for the Separator component.
 *
 * Validates:
 *  - Renders with correct orientation
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Separator } from '../separator'

/** Helper: querySelector that throws on null. */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

describe('Separator', () => {
  it('renders with data-slot="separator"', () => {
    const { container } = render(<Separator />)
    const el = q(container, '[data-slot="separator"]')
    expect(el).toBeInTheDocument()
  })

  it('renders horizontal orientation by default', () => {
    const { container } = render(<Separator />)
    const el = q(container, '[data-slot="separator"]')
    expect(el).toHaveAttribute('data-orientation', 'horizontal')
  })

  it('renders vertical orientation', () => {
    const { container } = render(<Separator orientation="vertical" />)
    const el = q(container, '[data-slot="separator"]')
    expect(el).toHaveAttribute('data-orientation', 'vertical')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<Separator ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <div>
        <p>Above</p>
        <Separator />
        <p>Below</p>
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
