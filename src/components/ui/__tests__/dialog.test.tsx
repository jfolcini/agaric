/**
 * Tests for the Dialog component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer, Title, Description)
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '../dialog'

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('Dialog displayName', () => {
  it.each([
    ['Dialog', Dialog],
    ['DialogTrigger', DialogTrigger],
    ['DialogPortal', DialogPortal],
    ['DialogClose', DialogClose],
    ['DialogOverlay', DialogOverlay],
    ['DialogContent', DialogContent],
    ['DialogHeader', DialogHeader],
    ['DialogFooter', DialogFooter],
    ['DialogTitle', DialogTitle],
    ['DialogDescription', DialogDescription],
  ])('%s has displayName', (name, Component) => {
    expect(Component.displayName).toBe(name)
  })
})

// ---------------------------------------------------------------------------
// ref forwarding — simple HTML sub-components
// ---------------------------------------------------------------------------

describe('Dialog ref forwarding', () => {
  it('DialogHeader forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<DialogHeader ref={ref}>Header</DialogHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('dialog-header')
  })

  it('DialogFooter forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<DialogFooter ref={ref}>Footer</DialogFooter>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('dialog-footer')
  })
})

// ---------------------------------------------------------------------------
// a11y
// ---------------------------------------------------------------------------

describe('Dialog a11y', () => {
  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
            <DialogDescription>Test description</DialogDescription>
          </DialogHeader>
          <p>Dialog body</p>
        </DialogContent>
      </Dialog>,
    )
    const results = await axe(baseElement, {
      rules: { region: { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })
})
