/**
 * Tests for ViewHeaderOutlet — the provider + slot + hook that power
 * App-level view headers.
 *
 * Validates:
 *  1. Provider + Slot render and expose the outlet DOM element via context.
 *  2. Slot registers and unregisters with the provider on mount/unmount.
 *  3. Hook returns undefined without a provider (signals inline fallback).
 *  4. Hook returns null mid-mount and the actual element once attached.
 *  5. Hook returns null again when the slot is unmounted while the provider
 *     is still mounted.
 *  6. Slot className merges with the default classes.
 *  7. A11y: empty outlet has no violations.
 *  8. Below `md` the slot inside the scroller serves and the outer one does
 *     not, and a ViewHeader portals into whichever serves (#5927).
 */

import { act, render, renderHook } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ViewHeader } from '@/components/layout/ViewHeader'
import {
  useViewHeaderOutlet,
  ViewHeaderOutletProvider,
  ViewHeaderOutletSlot,
} from '@/components/layout/ViewHeaderOutlet'
import { useIsMobile } from '@/hooks/useIsMobile'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }))

describe('ViewHeaderOutletProvider', () => {
  it('renders its children', () => {
    const { getByText } = render(
      <ViewHeaderOutletProvider>
        <span>child</span>
      </ViewHeaderOutletProvider>,
    )
    expect(getByText('child')).toBeInTheDocument()
  })
})

describe('ViewHeaderOutletSlot', () => {
  it('renders a div with the view-header-outlet test id', () => {
    const { getByTestId } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
      </ViewHeaderOutletProvider>,
    )
    const outlet = getByTestId('view-header-outlet')
    expect(outlet).toBeInTheDocument()
    expect(outlet.tagName).toBe('DIV')
  })

  it('merges custom className onto the outlet host', () => {
    const { getByTestId } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot className="custom-class px-6" />
      </ViewHeaderOutletProvider>,
    )
    const outlet = getByTestId('view-header-outlet')
    expect(outlet.className).toContain('custom-class')
    expect(outlet.className).toContain('px-6')
    // default classes are preserved
    expect(outlet.className).toContain('shrink-0')
    expect(outlet.className).toContain('bg-background')
    expect(outlet.className).toContain('empty:hidden')
  })

  it('renders without a provider (graceful no-op) and stays in the DOM', () => {
    // Used in tests/stories outside the provider; should not throw.
    const { getByTestId } = render(<ViewHeaderOutletSlot />)
    expect(getByTestId('view-header-outlet')).toBeInTheDocument()
  })

  it('has no a11y violations when empty', async () => {
    const { container } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
      </ViewHeaderOutletProvider>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('useViewHeaderOutlet', () => {
  it('returns undefined when called outside a provider', () => {
    const { result } = renderHook(() => useViewHeaderOutlet())
    expect(result.current).toBeUndefined()
  })

  it('resolves to the slot DOM element once both are mounted', () => {
    function Probe({ onResolve }: { onResolve: (el: HTMLElement | null | undefined) => void }) {
      const outlet = useViewHeaderOutlet()
      onResolve(outlet)
      return null
    }
    let captured: HTMLElement | null | undefined
    const { getByTestId } = render(
      <ViewHeaderOutletProvider>
        <ViewHeaderOutletSlot />
        <Probe
          onResolve={(el) => {
            captured = el
          }}
        />
      </ViewHeaderOutletProvider>,
    )
    const outletEl = getByTestId('view-header-outlet')
    expect(captured).toBe(outletEl)
  })

  it('resets to null when the slot unmounts while the provider remains', () => {
    function Probe({ onResolve }: { onResolve: (el: HTMLElement | null | undefined) => void }) {
      const outlet = useViewHeaderOutlet()
      onResolve(outlet)
      return null
    }

    const observations: Array<HTMLElement | null | undefined> = []
    function Harness({ showSlot }: { showSlot: boolean }): React.ReactElement {
      return (
        <ViewHeaderOutletProvider>
          {showSlot && <ViewHeaderOutletSlot />}
          <Probe onResolve={(el) => observations.push(el)} />
        </ViewHeaderOutletProvider>
      )
    }

    const { rerender, queryByTestId } = render(<Harness showSlot />)
    expect(queryByTestId('view-header-outlet')).toBeInTheDocument()
    const resolvedWhileMounted = observations.at(-1)
    expect(resolvedWhileMounted).toBeInstanceOf(HTMLElement)

    act(() => {
      rerender(<Harness showSlot={false} />)
    })
    expect(queryByTestId('view-header-outlet')).not.toBeInTheDocument()
    const afterUnmount = observations.at(-1)
    expect(afterUnmount).toBeNull()
  })
})

describe('ViewHeaderOutletSlot placement', () => {
  afterEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false)
  })

  function renderBothSlots() {
    return render(
      <ViewHeaderOutletProvider>
        <div data-testid="outside">
          <ViewHeaderOutletSlot />
        </div>
        <div data-testid="inside">
          <ViewHeaderOutletSlot insideScroller />
        </div>
        <ViewHeader>
          <span>header content</span>
        </ViewHeader>
      </ViewHeaderOutletProvider>,
    )
  }

  it.each([
    [false, 'outside'],
    [true, 'inside'],
  ])('with isMobile=%s only the %s slot renders and hosts the header', (isMobile, host) => {
    vi.mocked(useIsMobile).mockReturnValue(isMobile)
    const { getByTestId, getAllByTestId, getByText } = renderBothSlots()
    const outlets = getAllByTestId('view-header-outlet')
    expect(outlets).toHaveLength(1)
    expect(getByTestId(host)).toContainElement(outlets[0] as HTMLElement)
    expect(outlets[0]).toContainElement(getByText('header content'))
  })
})
