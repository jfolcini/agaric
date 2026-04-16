/**
 * Tests for the Sheet component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer)
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Sheet,
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
