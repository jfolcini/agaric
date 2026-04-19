/**
 * Tests for the Tooltip components.
 *
 * Validates:
 *  - displayName is set on all exports
 *  - TooltipContent forwards ref (via open tooltip)
 *  - Render output and a11y compliance
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

/** Helper: querySelector that throws on null. */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

describe('Tooltip displayNames', () => {
  it('TooltipProvider has displayName', () => {
    expect(TooltipProvider.displayName).toBe('TooltipProvider')
  })

  it('Tooltip has displayName', () => {
    expect(Tooltip.displayName).toBe('Tooltip')
  })

  it('TooltipTrigger has displayName', () => {
    expect(TooltipTrigger.displayName).toBe('TooltipTrigger')
  })

  it('TooltipContent has displayName', () => {
    expect(TooltipContent.displayName).toBe('TooltipContent')
  })
})

describe('TooltipContent', () => {
  it('forwards ref to the content element', () => {
    const ref = React.createRef<HTMLDivElement>()

    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent ref={ref}>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    // Radix renders tooltip text in both the visible content and a hidden a11y span.
    // Use the ref directly to verify ref forwarding works (ref is a prop in React 19).
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('tooltip-content')
  })

  it('renders with data-slot="tooltip-content"', () => {
    const { baseElement } = render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    const content = q(baseElement, '[data-slot="tooltip-content"]')
    expect(content).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(
      <main>
        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger asChild>
              <button type="button">Hover me</button>
            </TooltipTrigger>
            <TooltipContent>Helpful tooltip</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </main>,
    )
    // Tooltip portals render outside landmarks by design; exclude the region rule
    const results = await axe(baseElement, {
      rules: { region: { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })
})
