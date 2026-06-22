import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LucideIcon } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { t } from '@/lib/i18n'
import { consumePreDragFocus } from '@/lib/pre-drag-focus'
import { useBlockStore } from '@/stores/blocks'

// Mock lucide-react icons. We extend the original module so transitive
// dependencies still resolve, while pinning the icons we assert on to
// predictable test ids.
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>()
  return {
    ...actual,
    GripVertical: (props: { className?: string }) => (
      <svg data-testid="grip-vertical-icon" className={props.className} />
    ),
  }
})

/**
 * Override `window.matchMedia` so `useIsTouch()` resolves deterministically.
 *
 * Returns the original descriptor so tests can restore it on teardown — the
 * shared test-setup mock is not a Vitest spy, so we cannot rely on
 * `vi.restoreAllMocks()` here.
 */
function setMatchMedia(isTouch: boolean) {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isTouch && query.includes('coarse'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  // #1236: useIsTouch() now requires real touch hardware
  // (navigator.maxTouchPoints > 0) in addition to a coarse pointer. Simulate
  // it for the touch case; callers reset it via resetMaxTouchPoints() on
  // teardown so it doesn't leak to desktop-default tests.
  setMaxTouchPoints(isTouch ? 5 : 0)
  return original
}

function setMaxTouchPoints(value: number) {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value,
    writable: true,
    configurable: true,
  })
}

function resetMaxTouchPoints() {
  setMaxTouchPoints(0)
}

import { BlockGutterControls, GutterButton } from '@/components/editor/BlockGutterControls'
import { TooltipProvider } from '@/components/ui/tooltip'

/** Convenience wrapper — Radix tooltips require a <TooltipProvider>. */
function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('GutterButton', () => {
  // We need a mock LucideIcon component for the GutterButton tests
  const MockIcon = ((props: { className?: string }) => (
    <svg data-testid="mock-icon" className={props.className} />
  )) as unknown as LucideIcon

  it('renders a button with the given icon and aria-label', () => {
    renderWithTooltip(
      <GutterButton icon={MockIcon} label="My tooltip" ariaLabel="My action" testId="my-btn" />,
    )

    const btn = screen.getByRole('button', { name: 'My action' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('data-testid', 'my-btn')
    expect(screen.getByTestId('mock-icon')).toBeInTheDocument()
  })

  it('shows tooltip on hover', async () => {
    const user = userEvent.setup()

    renderWithTooltip(<GutterButton icon={MockIcon} label="Helpful tip" ariaLabel="Hover me" />)

    const btn = screen.getByRole('button', { name: 'Hover me' })
    await user.hover(btn)

    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: 'Helpful tip' })).toBeInTheDocument()
    })
  })

  it('forwards extra button props (onClick)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    renderWithTooltip(
      <GutterButton icon={MockIcon} label="Tip" ariaLabel="Click me" onClick={onClick} />,
    )

    await user.click(screen.getByRole('button', { name: 'Click me' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('merges custom className with base classes', () => {
    renderWithTooltip(
      <GutterButton icon={MockIcon} label="Tip" ariaLabel="Styled" className="custom-extra" />,
    )

    const btn = screen.getByRole('button', { name: 'Styled' })
    expect(btn.className).toContain('custom-extra')
    // Base classes should still be present
    expect(btn.className).toContain('opacity-0')
    expect(btn.className).toContain('group-hover:opacity-100')
  })
})

describe('BlockGutterControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the drag handle button', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle).toBeInTheDocument()
    expect(dragHandle).toHaveAttribute('aria-label', t('block.reorder'))
    expect(screen.getByTestId('grip-vertical-icon')).toBeInTheDocument()
  })

  it('spreads dragAttributes and dragListeners onto drag handle', () => {
    renderWithTooltip(
      <BlockGutterControls
        blockId="B1"
        dragAttributes={{ 'aria-describedby': 'dnd-desc' } as unknown as DraggableAttributes}
        dragListeners={{ onPointerDown: vi.fn() } as unknown as DraggableSyntheticListeners}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle).toHaveAttribute('aria-describedby', 'dnd-desc')
  })

  // #966 — pressing the drag handle blurs the editor (tearing focus down)
  // before the drag activates, so the handle must snapshot the pre-drag focus
  // in its own `pointerdown` for restore-on-cancel. It must ALSO still invoke
  // dnd-kit's `onPointerDown` so the drag actually activates.
  it('captures the focused block and still forwards dnd-kit onPointerDown on handle pointerDown', () => {
    consumePreDragFocus() // drain any prior capture
    useBlockStore.setState({ focusedBlockId: 'A' })
    const dndPointerDown = vi.fn()

    renderWithTooltip(
      <BlockGutterControls
        blockId="B1"
        dragListeners={{ onPointerDown: dndPointerDown } as unknown as DraggableSyntheticListeners}
      />,
    )

    fireEvent.pointerDown(screen.getByTestId('drag-handle'))

    // dnd-kit's activator still ran (drag can start) …
    expect(dndPointerDown).toHaveBeenCalledTimes(1)
    // … and the pre-drag focus was snapshotted before the press-blur clears it.
    expect(consumePreDragFocus()).toBe('A')

    useBlockStore.setState({ focusedBlockId: null })
  })
})

describe('BlockGutterControls tooltip visibility', () => {
  it('shows drag handle tooltip on hover', async () => {
    const user = userEvent.setup()

    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    await user.hover(screen.getByTestId('drag-handle'))

    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: t('block.reorderTip') })).toBeInTheDocument()
    })
  })
})

describe('BlockGutterControls gutter button classes', () => {
  // #370: the desktop drag handle follows the same per-block hover contract as
  // every other gutter control — hidden at rest (opacity-0 / pointer-events-none
  // from GUTTER_BUTTON_BASE) and revealed only on group-hover / focus-within /
  // .block-active.
  it('drag handle is hidden at rest and revealed on row hover (per-block contract)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('opacity-0')
    expect(dragHandle.className).toContain('pointer-events-none')
    expect(dragHandle.className).not.toContain('opacity-30')
    expect(dragHandle.className).toContain('group-hover:opacity-100')
    expect(dragHandle.className).toContain('group-hover:pointer-events-auto')
  })

  it('drag handle carries the touch-target utility class', () => {
    // The .touch-target utility sets both min-height and min-width to 44px under
    // (pointer: coarse) so the 20-px-wide gutter button meets WCAG 2.5.8 on
    // touch devices. jsdom cannot evaluate the @media query, so we assert
    // structural presence of the utility class instead of its computed width.
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    expect(screen.getByTestId('drag-handle').className).toContain('touch-target')
  })

  // #995: the gutter is the last consumer migrated off the legacy `focus-ring`
  // (2px ring + offset) onto the canonical `focus-ring-visible` (3px inset).
  it('drag handle carries focus-ring-visible (not the legacy focus-ring)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('focus-ring-visible')
    // No bare legacy token (guard against a regression to `focus-ring`).
    expect(dragHandle.className.split(/\s+/)).not.toContain('focus-ring')
  })

  // #997 decision: the drag handle deliberately stays text-only on hover (no
  // neutral bg plate), so it reads as ambient chrome.
  it('drag handle hovers text-only (no hover:bg-accent plate)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('hover:text-foreground')
    expect(dragHandle.className).not.toContain('hover:bg-accent')
  })

  // #998: the icon-button radius is folded into the shared base token; assert
  // it's present once and not bumped to the padded-row `rounded-md`.
  it('gutter icon buttons inherit rounded-sm from the shared base token', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className.split(/\s+/)).toContain('rounded-sm')
    // Must NOT be bumped to the padded-row radius (#998 explicit decision).
    expect(dragHandle.className.split(/\s+/)).not.toContain('rounded-md')
  })
})

/* ── B1 (#217): multi-select checkbox affordance ────────────────── */

describe('BlockGutterControls multi-select checkbox (B1, #217)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no multi-selection active.
    useBlockStore.setState({ selectedBlockIds: [] })
  })
  afterEach(() => {
    useBlockStore.setState({ selectedBlockIds: [] })
  })

  it('does not render a checkbox when onSelect is not provided', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)
    expect(screen.queryByTestId('block-select-checkbox')).not.toBeInTheDocument()
  })

  // New contract (user feedback 2026-06-20): the checkbox must NEVER reserve
  // gutter space. With NO active selection and not selected, it is omitted from
  // the DOM entirely (the start affordance is Ctrl/Cmd+Click).
  it('does not render the checkbox when no selection is active and not selected', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    expect(screen.queryByTestId('block-select-checkbox')).not.toBeInTheDocument()
  })

  // Once a multi-selection IS active, other rows hover-reveal their checkbox so
  // the selection can be extended.
  it('hover-reveals the checkbox on other rows once a selection is active', () => {
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    const checkbox = screen.getByTestId('block-select-checkbox')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).toHaveAttribute('type', 'checkbox')
    expect(checkbox).toHaveAttribute('aria-label', t('block.selectBlock'))
    expect(checkbox.className).toContain('opacity-0')
    expect(checkbox.className).toContain('group-hover:opacity-100')
    expect(checkbox.className).not.toContain('pointer-events-none')
  })

  it('toggles selection via onSelect(blockId, "toggle") when changed', () => {
    const onSelect = vi.fn()
    // A selection must be active for the checkbox to render at all.
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    renderWithTooltip(<BlockGutterControls blockId="B_SEL" onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('block-select-checkbox'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('B_SEL', 'toggle')
  })

  it('reflects the selected state and forces full visibility when selected', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} isSelected />)
    const checkbox = screen.getByTestId('block-select-checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    // When selected it is always visible (feedback), not opacity-0.
    expect(checkbox.className).toContain('opacity-100')
    expect(checkbox.className).not.toContain('opacity-0')
  })

  it('renders the checkbox on touch only when selected (feedback, not chrome)', () => {
    const original = setMatchMedia(true)
    // An active selection so the unselected-but-revealable branch (which carries
    // the coarse-pointer hide class) is exercised.
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    try {
      const { rerender } = renderWithTooltip(
        <BlockGutterControls blockId="B1" onSelect={vi.fn()} />,
      )
      // Unselected on touch: checkbox is suppressed via the coarse-pointer hide class.
      const unselected = screen.getByTestId('block-select-checkbox')
      expect(unselected.className).toContain('[@media(pointer:coarse)]:hidden')
      // Selected on touch: forced visible (no coarse-hide class branch).
      rerender(
        <TooltipProvider>
          <BlockGutterControls blockId="B1" onSelect={vi.fn()} isSelected />
        </TooltipProvider>,
      )
      const selected = screen.getByTestId('block-select-checkbox')
      expect(selected.className).not.toContain('[@media(pointer:coarse)]:hidden')
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original)
      resetMaxTouchPoints()
    }
  })

  it('passes axe audit with the checkbox rendered', async () => {
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    const { container } = renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('BlockGutterControls accessibility', () => {
  it('passes axe audit with the drag handle rendered', async () => {
    const { container } = renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

/* ── Touch (pointer: coarse) — drag grip ─────────────── */

describe('BlockGutterControls (touch / pointer:coarse)', () => {
  let originalMatchMedia: PropertyDescriptor | undefined

  beforeEach(() => {
    originalMatchMedia = setMatchMedia(true)
  })

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
    resetMaxTouchPoints()
  })

  // #1968: the touch drag activator moved OUT of the gutter onto the leading
  // collapse chevron (or, on leaves, a small bullet) — see
  // `BlockCollapseControl`. On touch the gutter therefore renders NO drag grip;
  // it only ever shows the selection checkbox, and only while a selection is
  // active. (The grip's touch-target / touch-action / long-press-hint behavior
  // is now covered by the BlockCollapseControl tests.)
  it('renders no drag grip on touch (activator moved to the chevron/bullet)', () => {
    renderWithTooltip(
      <BlockGutterControls
        blockId="B1"
        onSelect={vi.fn()}
        dragAttributes={{ 'data-dnd-activator': 'grip' } as never}
        dragListeners={{ onPointerDown: vi.fn() }}
      />,
    )

    expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
  })

  it('passes axe audit in touch mode', async () => {
    const { container } = renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

/* ── Fix 6: multiselect mode shows ONLY the select checkbox ──────────── */

describe('BlockGutterControls multiselect mode (Fix 6)', () => {
  afterEach(() => {
    useBlockStore.setState({ selectedBlockIds: [] })
  })

  it('desktop: keeps the select checkbox + drag handle (#914)', () => {
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    // The select checkbox AND the drag handle survive (the handle is kept so a
    // multi-selection can still be dragged to move — #914). History/Delete now
    // live only in the context menu, so they are never in the gutter.
    expect(screen.getByTestId('block-select-checkbox')).toBeInTheDocument()
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete block/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /block history/i })).not.toBeInTheDocument()
  })

  it('touch: suppresses the touch grip, keeps the checkbox', () => {
    const original = setMatchMedia(true)
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    try {
      renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
      expect(screen.getByTestId('block-select-checkbox')).toBeInTheDocument()
      expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
      expect(screen.queryByTestId('more-actions')).not.toBeInTheDocument()
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original)
      resetMaxTouchPoints()
    }
  })

  it('renders the drag handle when no selection is active', () => {
    useBlockStore.setState({ selectedBlockIds: [] })
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
  })
})
