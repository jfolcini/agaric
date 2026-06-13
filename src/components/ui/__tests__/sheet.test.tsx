/**
 * Tests for the Sheet component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer)
 *  - soft-keyboard avoidance for bottom sheets via visualViewport (#760)
 */

import { act, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
    // the ScrollArea root (which carries data-slot="sheet-body") to
    // assert the height contract.
    const scrollRoot = child.closest('[data-slot="sheet-body"]')
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
    expect(ref.current?.getAttribute('data-slot')).toBe('sheet-body')
  })

  // #1028 / #1029 — SheetBody extends ComponentProps<'div'> so a11y / test
  // attributes reach the scroll container (the body owns the scrollable region).
  it('forwards aria-* / data-* onto the scroll container', () => {
    render(
      <Sheet open>
        <SheetContent>
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

// ---------------------------------------------------------------------------
// Soft-keyboard avoidance (#760) — bottom sheets track window.visualViewport
// ---------------------------------------------------------------------------

/**
 * Minimal visualViewport stand-in. Extends EventTarget so the component's
 * `addEventListener('resize' | 'scroll', …)` wiring is exercised for real
 * (and so floating-ui's overflow-ancestor walk stays happy — see the
 * test-setup.ts note on polluted visualViewport mocks). The global
 * test-setup `afterEach` deletes `window.visualViewport` after every test.
 */
class FakeVisualViewport extends EventTarget {
  height: number
  offsetTop = 0
  width = 1024
  /** Pinch-zoom factor — 1 = unzoomed. The IME never changes this; pinch zoom always does. */
  scale = 1

  constructor(height: number) {
    super()
    this.height = height
  }
}

function installVisualViewport(height: number): FakeVisualViewport {
  const vv = new FakeVisualViewport(height)
  Object.defineProperty(window, 'visualViewport', {
    value: vv,
    writable: true,
    configurable: true,
  })
  return vv
}

function renderBottomSheet(): HTMLElement {
  render(
    <Sheet open>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Bottom Sheet</SheetTitle>
        </SheetHeader>
        <input aria-label="sheet input" />
      </SheetContent>
    </Sheet>,
  )
  return screen.getByRole('dialog')
}

describe('SheetContent soft-keyboard avoidance (#760)', () => {
  const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

  beforeEach(() => {
    // Deterministic layout-viewport height: keyboard overlap is computed
    // as innerHeight - (visualViewport.height + offsetTop).
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    if (originalInnerHeight) {
      Object.defineProperty(window, 'innerHeight', originalInnerHeight)
    }
  })

  it('lifts a bottom sheet above a keyboard that is already up on mount', () => {
    installVisualViewport(468) // 768 - 468 = 300px IME overlap
    const dialog = renderBottomSheet()
    expect(dialog.style.bottom).toBe('300px')
    expect(dialog.style.maxHeight).toBe('calc(100% - 300px)')
  })

  it('tracks visualViewport resize: keyboard up → lifted, keyboard down → class anchoring restored', () => {
    const vv = installVisualViewport(768) // no keyboard yet
    const dialog = renderBottomSheet()
    expect(dialog).toHaveClass('bottom-0')
    expect(dialog.style.bottom).toBe('')

    act(() => {
      vv.height = 448 // IME opens: 320px overlap
      vv.dispatchEvent(new Event('resize'))
    })
    expect(dialog.style.bottom).toBe('320px')
    expect(dialog.style.maxHeight).toBe('calc(100% - 320px)')

    act(() => {
      vv.height = 768 // IME closes
      vv.dispatchEvent(new Event('resize'))
    })
    expect(dialog.style.bottom).toBe('')
    expect(dialog.style.maxHeight).toBe('')
    expect(dialog).toHaveClass('bottom-0')
  })

  it('accounts for visualViewport.offsetTop (browser UI pinned at the top)', () => {
    const vv = installVisualViewport(768)
    const dialog = renderBottomSheet()
    act(() => {
      vv.height = 468
      vv.offsetTop = 100 // 768 - (468 + 100) = 200px overlap
      vv.dispatchEvent(new Event('scroll'))
    })
    expect(dialog.style.bottom).toBe('200px')
  })

  it('does not move non-bottom sheets even with the keyboard up', () => {
    installVisualViewport(468)
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Right Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.style.bottom).toBe('')
    expect(dialog.style.maxHeight).toBe('')
  })

  it('is inert when visualViewport is unavailable (jsdom default / older WebViews)', () => {
    // No installVisualViewport call — window.visualViewport is undefined.
    const dialog = renderBottomSheet()
    expect(dialog.style.bottom).toBe('')
    expect(dialog).toHaveClass('bottom-0')
  })

  it('does NOT treat pinch zoom as a keyboard (visualViewport.scale > 1)', () => {
    // Desktop trackpad / touchscreen pinch zoom shrinks vv.height exactly
    // like the IME does (height ≈ innerHeight / scale) but lifting the
    // sheet would be bogus — the keyboard is not up.
    const vv = installVisualViewport(384) // 768 / 2 — looks like a 384px "keyboard"
    vv.scale = 2
    const dialog = renderBottomSheet()
    expect(dialog.style.bottom).toBe('')
    expect(dialog.style.maxHeight).toBe('')
    expect(dialog).toHaveClass('bottom-0')

    act(() => {
      vv.scale = 1
      vv.height = 468 // zoom reset, then a real IME: 300px overlap
      vv.dispatchEvent(new Event('resize'))
    })
    expect(dialog.style.bottom).toBe('300px')
  })

  it('removes its visualViewport listeners on unmount (no leak across open/close cycles)', () => {
    const vv = installVisualViewport(768)
    const added: string[] = []
    const removed: string[] = []
    const originalAdd = vv.addEventListener.bind(vv)
    const originalRemove = vv.removeEventListener.bind(vv)
    vv.addEventListener = (type: string, ...rest: [EventListenerOrEventListenerObject | null]) => {
      added.push(type)
      originalAdd(type, ...rest)
    }
    vv.removeEventListener = (
      type: string,
      ...rest: [EventListenerOrEventListenerObject | null]
    ) => {
      removed.push(type)
      originalRemove(type, ...rest)
    }

    const { unmount } = render(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Bottom Sheet</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )
    expect(added.sort()).toEqual(['resize', 'scroll'])
    unmount()
    expect(removed.sort()).toEqual(['resize', 'scroll'])
  })
})
