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
  DialogBody,
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
    ['DialogBody', DialogBody],
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
// responsive viewport cap (PEND-28 H1)
// ---------------------------------------------------------------------------

describe('DialogContent viewport cap', () => {
  it('caps height to dynamic viewport with flex-col + overflow-hidden so the body scrolls', () => {
    // pending/dialog-responsiveness-primitive-2026-05-13: DialogContent owns the
    // viewport cap + pinned header/footer; DialogBody owns the scrollable region.
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    const content = baseElement.querySelector('[data-slot="dialog-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(content?.className).toContain('flex')
    expect(content?.className).toContain('flex-col')
    expect(content?.className).toContain('overflow-hidden')
  })

  it('DialogBody renders a ScrollArea-backed slot with the flex-1 min-h-0 scroll pattern', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
          <DialogBody>
            <p>Body</p>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    )
    const body = baseElement.querySelector('[data-slot="dialog-body"]')
    expect(body).not.toBeNull()
    expect(body?.className).toContain('flex-1')
    expect(body?.className).toContain('min-h-0')
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
