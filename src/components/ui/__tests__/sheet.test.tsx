/**
 * Tests for the Sheet component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer)
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from '@/__tests__/helpers/axe'
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../sheet'

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('Sheet displayName', () => {
  it.each([
    ['Sheet', Sheet],
    ['SheetTrigger', SheetTrigger],
    ['SheetClose', SheetClose],
    ['SheetContent', SheetContent],
    ['SheetBody', SheetBody],
    ['SheetHeader', SheetHeader],
    ['SheetFooter', SheetFooter],
    ['SheetTitle', SheetTitle],
    ['SheetDescription', SheetDescription],
  ])('%s has displayName', (name, Component) => {
    expect(Component.displayName).toBe(name)
  })
})

// ---------------------------------------------------------------------------
// ref forwarding — simple HTML sub-components
// ---------------------------------------------------------------------------

describe('Sheet ref forwarding', () => {
  it('SheetHeader forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<SheetHeader ref={ref}>Header</SheetHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sheet-header')
  })

  it('SheetFooter forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<SheetFooter ref={ref}>Footer</SheetFooter>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('sheet-footer')
  })
})

// ---------------------------------------------------------------------------
// a11y
// ---------------------------------------------------------------------------

describe('Sheet a11y', () => {
  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
            <SheetDescription>Test description</SheetDescription>
          </SheetHeader>
          <p>Sheet body</p>
        </SheetContent>
      </Sheet>,
    )
    const results = await axe(baseElement, {
      rules: { region: { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// SheetContent base classes — height/overflow/padding contract
// ---------------------------------------------------------------------------

describe('SheetContent base classes', () => {
  it('SheetContent is `flex flex-col overflow-hidden p-6` so SheetBody can constrain its height', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('flex', 'flex-col', 'overflow-hidden', 'p-6')
  })
})

// ---------------------------------------------------------------------------
// SheetBody — scrollable slot
// ---------------------------------------------------------------------------

describe('SheetBody', () => {
  it('renders children inside a flex-1 min-h-0 ScrollArea so the body owns the scroll', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <p data-testid="body-child">Body content</p>
          </SheetBody>
        </SheetContent>
      </Sheet>,
    )
    const child = screen.getByTestId('body-child')
    // SheetBody renders a ScrollArea wrapping a content div. Walk up to
    // the ScrollArea root (which carries data-slot="scroll-area") to
    // assert the height contract.
    const scrollRoot = child.closest('[data-slot="scroll-area"]')
    expect(scrollRoot).not.toBeNull()
    expect(scrollRoot).toHaveClass('flex-1', 'min-h-0', '-mx-6')
  })

  it('viewport carries `px-6` so the scrollbar can sit in the SheetContent gutter without eating content padding', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <p data-testid="body-child">Body content</p>
          </SheetBody>
        </SheetContent>
      </Sheet>,
    )
    const child = screen.getByTestId('body-child')
    const viewport = child.closest('[data-slot="scroll-area-viewport"]')
    expect(viewport).not.toBeNull()
    expect(viewport).toHaveClass('px-6')
  })

  it('SheetBody forwards ref to the ScrollArea root', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
          <SheetBody ref={ref}>
            <p>Body content</p>
          </SheetBody>
        </SheetContent>
      </Sheet>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('scroll-area')
  })
})
