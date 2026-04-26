/**
 * Tests for the Breadcrumb primitive (UX-257).
 *
 * Covers:
 *  - Returns null when there are no items and no home button
 *  - Renders all items + Home + chevron separators in the right order
 *  - Final item is rendered as a non-clickable span with `aria-current="location"`
 *  - Intermediate items invoke their onSelect handler
 *  - Per-crumb truncation: intermediate `max-w-[160px]`, active `max-w-[320px]`
 *  - UX-215 keyboard navigation — ArrowLeft / ArrowRight / Home / End on the
 *    `role="toolbar"` container (now lives in the primitive, not BlockZoomBar)
 *  - Overflow popover triggers when items > 5 (and not at exactly 5)
 *  - Overflow popover lists the collapsed middle crumbs and invokes their handlers
 *  - axe(container) audit passes
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Breadcrumb,
  type BreadcrumbCrumb,
  BreadcrumbHome,
  BreadcrumbItem,
  BreadcrumbSeparator,
} from '../breadcrumb'

describe('Breadcrumb', () => {
  const baseItems: BreadcrumbCrumb[] = [
    { id: 'A', label: 'Alpha', onSelect: vi.fn() },
    { id: 'B', label: 'Beta', onSelect: vi.fn() },
    { id: 'C', label: 'Gamma' },
  ]

  it('returns null when items is empty and no home is provided', () => {
    const { container } = render(<Breadcrumb items={[]} ariaLabel="Trail" />)
    expect(container.innerHTML).toBe('')
  })

  it('still renders when items is empty but a home button is provided', () => {
    render(
      <Breadcrumb items={[]} ariaLabel="Trail" home={{ onClick: vi.fn(), ariaLabel: 'Home' }} />,
    )
    expect(screen.getByRole('navigation', { name: 'Trail' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument()
  })

  it('renders nav with aria-label and toolbar with aria-orientation', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="My trail" />)
    const nav = screen.getByRole('navigation', { name: 'My trail' })
    expect(nav).toBeInTheDocument()
    const toolbar = screen.getByRole('toolbar', { name: 'My trail' })
    expect(toolbar).toBeInTheDocument()
    expect(toolbar).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('renders all crumb labels', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('renders chevron separators between visible crumbs', () => {
    const { container } = render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    const seps = container.querySelectorAll('[data-slot="breadcrumb-separator"]')
    // 3 items, no home → 2 separators between them
    expect(seps.length).toBe(2)
  })

  it('inserts a separator after the home button when home is provided', () => {
    const { container } = render(
      <Breadcrumb
        items={baseItems}
        ariaLabel="Trail"
        home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
      />,
    )
    const seps = container.querySelectorAll('[data-slot="breadcrumb-separator"]')
    // home + 3 items → 3 separators
    expect(seps.length).toBe(3)
  })

  it('uses ChevronRight (not slash) for separators', () => {
    const { container } = render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    // Negative assertion — the previous slash-based design must be gone.
    expect(container.textContent).not.toContain('/')
  })

  it('renders the final crumb as a non-clickable span with aria-current="location"', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    const last = screen.getByText('Gamma')
    expect(last.tagName).toBe('SPAN')
    expect(last).toHaveAttribute('aria-current', 'location')
  })

  it('does not mark intermediate crumbs with aria-current', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    const first = screen.getByText('Alpha').closest('button')
    expect(first).not.toBeNull()
    expect(first).not.toHaveAttribute('aria-current')
  })

  it('applies font-medium to the active crumb', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    const last = screen.getByText('Gamma')
    expect(last.className).toContain('font-medium')
  })

  it('does not apply font-medium to intermediate crumbs', () => {
    render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
    const first = screen.getByText('Alpha').closest('button') as HTMLButtonElement
    expect(first.className).not.toContain('font-medium')
  })

  it('invokes onSelect when an intermediate crumb is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const items: BreadcrumbCrumb[] = [
      { id: 'A', label: 'Alpha', onSelect },
      { id: 'B', label: 'Beta' },
    ]
    render(<Breadcrumb items={items} ariaLabel="Trail" />)
    await user.click(screen.getByText('Alpha'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the active crumb is clicked (it is a span)', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const items: BreadcrumbCrumb[] = [
      { id: 'A', label: 'Alpha' },
      { id: 'B', label: 'Beta', onSelect },
    ]
    render(<Breadcrumb items={items} ariaLabel="Trail" />)
    // Beta is the last/active span — clicking it must not fire onSelect.
    await user.click(screen.getByText('Beta'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('forwards extra dataAttributes onto the rendered crumb element', () => {
    const items: BreadcrumbCrumb[] = [
      {
        id: 'A',
        label: 'Alpha',
        onSelect: vi.fn(),
        dataAttributes: { 'data-zoom-crumb': 'A' },
      },
      { id: 'B', label: 'Beta', dataAttributes: { 'data-zoom-crumb': 'B' } },
    ]
    const { container } = render(<Breadcrumb items={items} ariaLabel="Trail" />)
    expect(container.querySelectorAll('[data-zoom-crumb]').length).toBe(2)
  })

  describe('truncation', () => {
    it('applies max-w-[160px] truncate to intermediate crumbs', () => {
      const items: BreadcrumbCrumb[] = [
        {
          id: 'A',
          label: 'A really really really long ancestor crumb that overflows',
          onSelect: vi.fn(),
        },
        { id: 'B', label: 'final' },
      ]
      render(<Breadcrumb items={items} ariaLabel="Trail" />)
      const intermediate = screen.getByText(/long ancestor crumb/i).closest('button')
      expect(intermediate).not.toBeNull()
      expect(intermediate?.className).toContain('truncate')
      expect(intermediate?.className).toContain('max-w-[160px]')
    })

    it('applies max-w-[320px] truncate to the active final crumb', () => {
      const items: BreadcrumbCrumb[] = [
        { id: 'A', label: 'first', onSelect: vi.fn() },
        {
          id: 'B',
          label: 'A really really really long anchor crumb that the user is on',
        },
      ]
      render(<Breadcrumb items={items} ariaLabel="Trail" />)
      const active = screen.getByText(/long anchor crumb/i)
      expect(active.className).toContain('truncate')
      expect(active.className).toContain('max-w-[320px]')
    })
  })

  describe('overflow', () => {
    function makeTrail(n: number): BreadcrumbCrumb[] {
      return Array.from({ length: n }, (_, i) => ({
        id: `id-${i}`,
        label: `Crumb${i}`,
        ...(i === n - 1 ? {} : { onSelect: vi.fn() }),
      }))
    }

    it('does not show the overflow trigger at exactly 5 crumbs', () => {
      render(<Breadcrumb items={makeTrail(5)} ariaLabel="Trail" />)
      expect(
        screen.queryByRole('button', { name: /show hidden breadcrumbs/i }),
      ).not.toBeInTheDocument()
    })

    it('renders the overflow trigger when items > 5', () => {
      render(<Breadcrumb items={makeTrail(6)} ariaLabel="Trail" />)
      expect(screen.getByRole('button', { name: /show hidden breadcrumbs/i })).toBeInTheDocument()
    })

    it('keeps the head crumb + last 2 visible when overflowing', () => {
      render(<Breadcrumb items={makeTrail(7)} ariaLabel="Trail" />)
      // Visible: Crumb0, Crumb5, Crumb6
      expect(screen.getByText('Crumb0')).toBeInTheDocument()
      expect(screen.getByText('Crumb5')).toBeInTheDocument()
      expect(screen.getByText('Crumb6')).toBeInTheDocument()
      // Hidden inside the popover (not yet open):
      expect(screen.queryByText('Crumb1')).not.toBeInTheDocument()
      expect(screen.queryByText('Crumb2')).not.toBeInTheDocument()
      expect(screen.queryByText('Crumb3')).not.toBeInTheDocument()
      expect(screen.queryByText('Crumb4')).not.toBeInTheDocument()
    })

    it('opens the popover and reveals the collapsed crumbs on click', async () => {
      const user = userEvent.setup()
      render(<Breadcrumb items={makeTrail(7)} ariaLabel="Trail" />)
      const trigger = screen.getByRole('button', { name: /show hidden breadcrumbs/i })
      await user.click(trigger)
      expect(await screen.findByText('Crumb1')).toBeInTheDocument()
      expect(screen.getByText('Crumb2')).toBeInTheDocument()
      expect(screen.getByText('Crumb3')).toBeInTheDocument()
      expect(screen.getByText('Crumb4')).toBeInTheDocument()
    })

    it('forwards onSelect when a hidden crumb is selected from the popover', async () => {
      const user = userEvent.setup()
      const middleSelect = vi.fn()
      const items: BreadcrumbCrumb[] = [
        { id: 'A', label: 'A', onSelect: vi.fn() },
        { id: 'B', label: 'B', onSelect: vi.fn() },
        { id: 'C', label: 'C', onSelect: middleSelect },
        { id: 'D', label: 'D', onSelect: vi.fn() },
        { id: 'E', label: 'E', onSelect: vi.fn() },
        { id: 'F', label: 'F' },
      ]
      render(<Breadcrumb items={items} ariaLabel="Trail" />)
      await user.click(screen.getByRole('button', { name: /show hidden breadcrumbs/i }))
      const hiddenC = await screen.findByText('C')
      await user.click(hiddenC)
      expect(middleSelect).toHaveBeenCalledTimes(1)
    })
  })

  describe('UX-215 keyboard navigation', () => {
    it('ArrowRight moves focus to the next button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      // Order: home, Alpha, Beta. Gamma is the active span (not a button).
      ;(buttons[0] as HTMLButtonElement).focus()
      expect(document.activeElement).toBe(buttons[0])
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[1])
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[2])
    })

    it('ArrowLeft moves focus to the previous button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[2] as HTMLButtonElement).focus()
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[1])
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('ArrowLeft clamps at the first button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[0] as HTMLButtonElement).focus()
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('ArrowRight clamps at the last button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      const lastIdx = buttons.length - 1
      ;(buttons[lastIdx] as HTMLButtonElement).focus()
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(buttons[lastIdx])
    })

    it('Home jumps focus to the first button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[2] as HTMLButtonElement).focus()
      await user.keyboard('{Home}')
      expect(document.activeElement).toBe(buttons[0])
    })

    it('End jumps focus to the last button', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[0] as HTMLButtonElement).focus()
      await user.keyboard('{End}')
      expect(document.activeElement).toBe(buttons[buttons.length - 1])
    })

    it('does not capture unrelated keys', async () => {
      const user = userEvent.setup()
      render(
        <Breadcrumb
          items={baseItems}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const buttons = screen.getAllByRole('button')
      ;(buttons[0] as HTMLButtonElement).focus()
      const before = document.activeElement
      await user.keyboard('x')
      expect(document.activeElement).toBe(before)
    })
  })

  describe('a11y', () => {
    it('passes axe with a basic trail', async () => {
      const { container } = render(<Breadcrumb items={baseItems} ariaLabel="Trail" />)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('passes axe with home + overflow', async () => {
      const items = Array.from({ length: 8 }, (_, i) => ({
        id: `id-${i}`,
        label: `Crumb${i}`,
        ...(i === 7 ? {} : { onSelect: vi.fn() }),
      }))
      const { container } = render(
        <Breadcrumb
          items={items}
          ariaLabel="Trail"
          home={{ onClick: vi.fn(), ariaLabel: 'Home' }}
        />,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// ── Lower-level pieces (compositional tests) ────────────────────────────

describe('BreadcrumbSeparator', () => {
  it('renders an svg with data-slot="breadcrumb-separator"', () => {
    const { container } = render(<BreadcrumbSeparator />)
    const sep = container.querySelector('[data-slot="breadcrumb-separator"]')
    expect(sep).not.toBeNull()
    expect(sep?.tagName.toLowerCase()).toBe('svg')
    expect(sep).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('BreadcrumbHome', () => {
  it('forwards aria-label and click handler', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<BreadcrumbHome onClick={onClick} ariaLabel="Go home" />)
    const btn = screen.getByRole('button', { name: 'Go home' })
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('BreadcrumbItem', () => {
  it('renders as a button when not active', () => {
    const onSelect = vi.fn()
    render(<BreadcrumbItem label="Item" isActive={false} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: 'Item' })).toBeInTheDocument()
  })

  it('renders as a span with aria-current when active', () => {
    render(<BreadcrumbItem label="Active" isActive={true} />)
    const node = screen.getByText('Active')
    expect(node.tagName).toBe('SPAN')
    expect(node).toHaveAttribute('aria-current', 'location')
  })
})
