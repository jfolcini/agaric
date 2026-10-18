/**
 * Tests for the Tooltip components.
 *
 * Validates:
 *  - displayName is set on all exports
 *  - TooltipContent forwards ref (via open tooltip)
 *  - Render output and a11y compliance
 *  - A tooltip on a Select trigger is closed while that Select is open
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// The real Radix Select, not the global test-setup mock: its `aria-expanded`
// and its Escape layer are what this file exercises.
vi.unmock('@/components/ui/select')

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// jsdom lacks the pointer-capture APIs Radix Select calls on open.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
})

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

  // Tooltips are transient labels, not mini-popovers: inverted surface in light
  // themes, the lifted popover in dark ones; the arrow must take the same fill
  // or it reads as a stray wedge.
  it('renders an inverted surface with a matching arrow, popover in dark', () => {
    const { baseElement } = render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    const content = q(baseElement, '[data-slot="tooltip-content"]')
    expect(content.classList.contains('bg-foreground')).toBe(true)
    expect(content.classList.contains('text-background')).toBe(true)
    expect(content.classList.contains('border-transparent')).toBe(true)
    expect(content.classList.contains('bg-popover')).toBe(false)
    expect(content.classList.contains('dark:bg-popover')).toBe(true)
    expect(content.classList.contains('dark:text-popover-foreground')).toBe(true)

    const arrow = q(content as HTMLElement, 'svg')
    expect(arrow.classList.contains('bg-foreground')).toBe(true)
    expect(arrow.classList.contains('fill-foreground')).toBe(true)
    expect(arrow.classList.contains('bg-popover')).toBe(false)
    expect(arrow.classList.contains('fill-popover')).toBe(false)
    expect(arrow.classList.contains('dark:fill-popover')).toBe(true)
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

// ---------------------------------------------------------------------------
// Press-and-hold fallback (#1735) — Radix hover tooltips never open on a
// coarse-pointer tap, so icon-only controls can opt into `openOnLongPress` to
// surface their label to sighted touch users on a press-and-hold.
// ---------------------------------------------------------------------------

describe('Tooltip openOnLongPress (#1735)', () => {
  it('opens on a press-and-hold when openOnLongPress is set', async () => {
    vi.useFakeTimers()
    try {
      render(
        <TooltipProvider delayDuration={0}>
          <Tooltip openOnLongPress>
            <TooltipTrigger asChild>
              <button type="button" data-testid="lp" aria-label="Search" />
            </TooltipTrigger>
            <TooltipContent>Search</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      )
      expect(screen.queryAllByRole('tooltip')).toHaveLength(0)
      fireEvent.pointerDown(screen.getByTestId('lp'), { clientX: 5, clientY: 5 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      const tooltips = screen.getAllByRole('tooltip')
      expect(tooltips.length).toBeGreaterThan(0)
      expect(tooltips[0]).toHaveTextContent('Search')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT open on a press-and-hold without the opt-in (other call sites unaffected)', async () => {
    vi.useFakeTimers()
    try {
      render(
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" data-testid="plain" aria-label="Plain" />
            </TooltipTrigger>
            <TooltipContent>Plain</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      )
      fireEvent.pointerDown(screen.getByTestId('plain'), { clientX: 5, clientY: 5 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(screen.queryAllByRole('tooltip')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// A tooltip on a Select trigger (#5908). Opening over the open listbox makes it
// the topmost Radix layer: Escape closes the tooltip instead of the listbox, and
// the tooltip covers the options. The space switcher wraps its trigger in a
// `<span>`; the Pages sort control makes the Select trigger the tooltip trigger.
// ---------------------------------------------------------------------------

function SelectWithTooltip({
  spanWrapped,
  onTooltipOpenChange,
}: {
  spanWrapped: boolean
  onTooltipOpenChange?: (open: boolean) => void
}) {
  const trigger = (
    <SelectTrigger aria-label="Sort order">
      <SelectValue />
    </SelectTrigger>
  )
  return (
    <main>
      <TooltipProvider delayDuration={0}>
        <Select defaultValue="a">
          <Tooltip {...(onTooltipOpenChange ? { onOpenChange: onTooltipOpenChange } : {})}>
            <TooltipTrigger asChild>
              {spanWrapped ? <span>{trigger}</span> : trigger}
            </TooltipTrigger>
            <TooltipContent>Sort is remembered</TooltipContent>
          </Tooltip>
          <SelectContent>
            <SelectItem value="a">Alphabetical</SelectItem>
            <SelectItem value="b">Created</SelectItem>
          </SelectContent>
        </Select>
      </TooltipProvider>
    </main>
  )
}

/** The tooltip, whether or not the open Select has aria-hidden it. */
const tooltipContent = () => document.querySelector('[data-slot="tooltip-content"]')

describe('Tooltip on a Select trigger (#5908)', () => {
  it.each([
    ['wrapped in a span', true],
    ['as the trigger itself', false],
  ])(
    'does not open while the listbox is open, so Escape closes the listbox (%s)',
    async (_shape, spanWrapped) => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      const { baseElement } = render(
        <SelectWithTooltip spanWrapped={spanWrapped} onTooltipOpenChange={onOpenChange} />,
      )
      const trigger = screen.getByRole('combobox', { name: 'Sort order' })

      await user.click(trigger)
      expect(await screen.findByRole('listbox')).toBeInTheDocument()
      onOpenChange.mockClear()

      // Focus coming back to the trigger is what opens it while the menu is up.
      // Not even for a frame: a closing tooltip stays the topmost layer while
      // it animates out.
      fireEvent.focusIn(trigger)
      expect(onOpenChange).not.toHaveBeenCalledWith(true)
      expect(tooltipContent()).toBeNull()

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

      // With the listbox closed the same focus does open it.
      fireEvent.focusIn(trigger)
      expect(tooltipContent()).not.toBeNull()

      const results = await axe(baseElement, { rules: { region: { enabled: false } } })
      expect(results).toHaveNoViolations()
    },
  )

  // The space switcher's shape: the Select trigger prevents the pointerdown
  // before it reaches the span, so Radix skips the tooltip trigger's own close.
  it('closes when the Select opens in the same moment it did, so Escape closes the listbox', async () => {
    const user = userEvent.setup()
    render(<SelectWithTooltip spanWrapped />)
    const trigger = screen.getByRole('combobox', { name: 'Sort order' })

    // Opened and pressed in one task: Radix's own pointerdown-outside
    // dismissal is not attached yet, and the Select prevents the trigger's.
    fireEvent.focusIn(trigger)
    expect(tooltipContent()).not.toBeNull()
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await waitFor(() => expect(tooltipContent()).toBeNull())

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })
})

// A collapse chevron sets aria-expanded but opens no popup: its tooltip still
// shows while the block is expanded.
describe('Tooltip on a disclosure button', () => {
  it('opens while the button is expanded', () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-expanded="true" aria-label="Collapse">
              v
            </button>
          </TooltipTrigger>
          <TooltipContent>Collapse</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    fireEvent.focusIn(screen.getByRole('button', { name: 'Collapse' }))
    expect(tooltipContent()).not.toBeNull()
  })
})
