/**
 * Tests for the Popover components.
 *
 * Validates:
 *  - displayName is set on all exports
 *  - PopoverContent forwards ref
 *  - Render output and a11y compliance
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

describe('Popover displayNames', () => {
  it('Popover has displayName', () => {
    expect(Popover.displayName).toBe('Popover')
  })

  it('PopoverTrigger has displayName', () => {
    expect(PopoverTrigger.displayName).toBe('PopoverTrigger')
  })

  it('PopoverAnchor has displayName', () => {
    expect(PopoverAnchor.displayName).toBe('PopoverAnchor')
  })

  it('PopoverContent has displayName', () => {
    expect(PopoverContent.displayName).toBe('PopoverContent')
  })
})

describe('PopoverContent', () => {
  it('forwards ref to the content element', async () => {
    const ref = React.createRef<HTMLDivElement>()

    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent ref={ref}>Popover body</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Popover body')
    expect(content).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('popover-content')
  })

  it('renders with data-slot="popover-content"', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content here</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Content here')
    expect(content.closest('[data-slot="popover-content"]')).toBeInTheDocument()
  })

  // #4313 — the cap is Radix's collision-aware available height, with the old
  // `100dvh` expression demoted to a fallback for when that var is unset — in
  // practice, jsdom/happy-dom, where nothing ever lays the popper out enough
  // to run the `size()` middleware's `apply`. It's not `avoidCollisions={false}`:
  // that only gates `shift`/`flip` in `@radix-ui/react-popper`, not `size()`.
  // It cannot be `100dvh` alone: on Android the soft keyboard does not shrink
  // the layout viewport, so a `dvh` cap let popovers extend under the
  // keyboard and past the top of the screen. The Radix var, by contrast, IS
  // keyboard-aware on its own — floating-ui measures the collision boundary
  // with `window.visualViewport` — which is why the popover does not (and must
  // not) also add the keyboard height as bottom `collisionPadding`; that would
  // subtract it twice. The geometry itself is covered end-to-end in
  // `e2e/formatting-toolbar-mobile.spec.ts`.
  it('caps height to the collision-aware available height, falling back to the dynamic viewport', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content</PopoverContent>
      </Popover>,
    )
    const content = await screen.findByText('Content')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root).not.toBeNull()
    expect(root?.className).toContain(
      'max-h-[var(--radix-popover-content-available-height,calc(100dvh-4rem))]',
    )
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(
      <Popover defaultOpen>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent aria-label="Popover content">Accessible popover content</PopoverContent>
      </Popover>,
    )
    const results = await axe(baseElement)
    expect(results).toHaveNoViolations()
  })
})
