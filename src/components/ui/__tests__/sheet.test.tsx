/**
 * Tests for the Sheet component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

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
} from '@/components/ui/sheet'

const BOTTOM_CAP = 'max-h-[calc(100dvh-3.5rem-var(--safe-area-top))]'

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

  // #3336 — the bottom-sheet shell is the shape the three fixes produce
  // together: a height-capped container whose SheetBody owns the scroll
  // region and forces the Radix viewport wrapper back to `block`. Drive it
  // with real interaction so the audit runs against a focused, typed-into
  // sheet rather than an inert first paint.
  it('bottom sheet with a SheetBody stays keyboard-operable and axe-clean after interaction', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const { baseElement } = render(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Interactive Sheet</SheetTitle>
            <SheetDescription>Sheet with a scrollable body</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <form onSubmit={onSubmit}>
              <label htmlFor="sheet-note">Note</label>
              <input id="sheet-note" name="note" />
              <button type="submit">Save note</button>
            </form>
          </SheetBody>
        </SheetContent>
      </Sheet>,
    )

    const input = screen.getByLabelText('Note')
    await user.type(input, 'hello')
    expect(input).toHaveValue('hello')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // The shell contract still holds with content and focus inside it.
    expect(screen.getByRole('dialog')).toHaveClass(BOTTOM_CAP)
    expect(input.closest('[data-slot="scroll-area-viewport"]')).toHaveClass('[&>div]:!block')

    const results = await axe(baseElement, { rules: { region: { enabled: false } } })
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// SheetContent base classes — height/overflow/padding contract
// ---------------------------------------------------------------------------

describe('SheetContent base classes', () => {
  it('SheetContent is `flex flex-col overflow-hidden` on the 16/24 px gutter so SheetBody can constrain its height', () => {
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('flex', 'flex-col', 'overflow-hidden', 'p-4', 'sm:p-6')
  })

  it.each([
    ['top', 'max-h-[calc(100dvh-2rem)]'],
    ['bottom', BOTTOM_CAP],
  ] as const)('%s sheets use the exact dynamic viewport height cap', (side, cap) => {
    render(
      <Sheet open>
        <SheetContent side={side} aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>{side} Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    // The cap must live *in the primitive*, so an edge-anchored sheet whose
    // content exceeds the viewport bounds itself instead of pushing its
    // header off-screen under `overflow-hidden`. Exact token, and `dvh` —
    // `vh` measures against the tallest mobile-chrome state (docs/UX.md).
    expect(screen.getByRole('dialog')).toHaveClass(cap)
  })

  it('a caller className still wins over the primitive cap (deliberate overrides)', () => {
    render(
      <Sheet open>
        <SheetContent side="bottom" className="max-h-[90dvh]" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Override Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('max-h-[90dvh]')
    expect(dialog).not.toHaveClass(BOTTOM_CAP)
  })

  it.each(['top', 'right', 'bottom', 'left'] as const)('%s sheets have square corners', (side) => {
    render(
      <Sheet open>
        <SheetContent side={side} aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>{side} Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    expect(screen.getByRole('dialog').className).not.toMatch(/\brounded/)
  })

  // Both side-anchored arms, not just one: they are `h-full` already, so the
  // edge-anchored cap would be dead weight there — and a regression that added
  // it to only one side would otherwise slip through.
  it.each(['left', 'right'] as const)(
    '%s sheets do not inherit the top/bottom dynamic viewport height cap',
    (side) => {
      render(
        <Sheet open>
          <SheetContent side={side} aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>{side} Sheet</SheetTitle>
            </SheetHeader>
          </SheetContent>
        </Sheet>,
      )
      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveClass('h-full')
      expect(dialog).not.toHaveClass('max-h-[calc(100dvh-2rem)]')
      expect(dialog).not.toHaveClass(BOTTOM_CAP)
    },
  )
})

// ---------------------------------------------------------------------------
// SheetBody — scrollable slot
// ---------------------------------------------------------------------------

describe('SheetBody', () => {
  it('renders children inside a flex-1 min-h-0 ScrollArea so the body owns the scroll', () => {
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
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
    // the ScrollArea root (which carries data-slot="sheet-body") to
    // assert the height contract.
    const scrollRoot = child.closest('[data-slot="sheet-body"]')
    expect(scrollRoot).not.toBeNull()
    expect(scrollRoot).toHaveClass('flex-1', 'min-h-0', '-mx-4', 'sm:-mx-6')
  })

  it('viewport carries the shared gutter and Radix width workaround classes', () => {
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
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
    expect(viewport).toHaveClass('px-4', 'sm:px-6', '[&>div]:!block')
  })

  it('SheetBody forwards ref to the ScrollArea root', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
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
    expect(ref.current?.getAttribute('data-slot')).toBe('sheet-body')
  })

  // #1028 / #1029 — SheetBody extends ComponentProps<'div'> so a11y / test
  // attributes reach the scroll container (the body owns the scrollable region).
  it('forwards aria-* / data-* onto the scroll container', () => {
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Test Sheet</SheetTitle>
          </SheetHeader>
          <SheetBody
            aria-label="Body region"
            aria-describedby="body-desc"
            data-testid="sheet-body"
            data-custom="x"
          >
            <p>Body content</p>
          </SheetBody>
        </SheetContent>
      </Sheet>,
    )
    const body = screen.getByTestId('sheet-body')
    expect(body.getAttribute('data-slot')).toBe('sheet-body')
    expect(body.getAttribute('aria-label')).toBe('Body region')
    expect(body.getAttribute('aria-describedby')).toBe('body-desc')
    expect(body.getAttribute('data-custom')).toBe('x')
  })
})
