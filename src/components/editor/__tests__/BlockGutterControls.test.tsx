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
// dependencies (e.g. Sheet's close button → XIcon) still resolve, while
// pinning the icons we assert on to predictable test ids.
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>()
  return {
    ...actual,
    Clock: (props: { className?: string }) => (
      <svg data-testid="clock-icon" className={props.className} />
    ),
    GripVertical: (props: { className?: string }) => (
      <svg data-testid="grip-vertical-icon" className={props.className} />
    ),
    MoreVertical: (props: { className?: string }) => (
      <svg data-testid="more-vertical-icon" className={props.className} />
    ),
    Trash2: (props: { className?: string }) => (
      <svg data-testid="trash-icon" className={props.className} />
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

  it('does not render history button when onShowHistory is not provided', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    expect(screen.queryByRole('button', { name: /block history/i })).not.toBeInTheDocument()
  })

  it('renders history button when onShowHistory is provided', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onShowHistory={vi.fn()} />)

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn).toBeInTheDocument()
    expect(screen.getByTestId('clock-icon')).toBeInTheDocument()
  })

  it('calls onShowHistory with blockId when history button is clicked', async () => {
    const user = userEvent.setup()
    const onShowHistory = vi.fn()

    renderWithTooltip(<BlockGutterControls blockId="B42" onShowHistory={onShowHistory} />)

    await user.click(screen.getByRole('button', { name: /block history/i }))
    expect(onShowHistory).toHaveBeenCalledOnce()
    expect(onShowHistory).toHaveBeenCalledWith('B42')
  })

  // #1498: the history button lives outside the contenteditable. With the
  // block's editor focused, an un-prevented mousedown would blur it first
  // (flush → re-mount) and swallow the click. preventDefault on mousedown keeps
  // the editor focused so the click fires. (Delete already prevents this via its
  // own onPointerDown; the drag handle / select checkbox intentionally keep
  // their pointerdown behaviour for drag / selection.)
  it('history button prevents default on mousedown and still fires onShowHistory', async () => {
    const user = userEvent.setup()
    const onShowHistory = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B7" onShowHistory={onShowHistory} />)

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    const prevented = vi.spyOn(ev, 'preventDefault')
    historyBtn.dispatchEvent(ev)
    expect(prevented).toHaveBeenCalled()

    await user.click(historyBtn)
    expect(onShowHistory).toHaveBeenCalledWith('B7')
  })

  it('does not render delete button when onDelete is not provided', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    expect(screen.queryByRole('button', { name: /delete block/i })).not.toBeInTheDocument()
  })

  it('renders delete button when onDelete is provided', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn).toBeInTheDocument()
    expect(screen.getByTestId('trash-icon')).toBeInTheDocument()
  })

  // #1532: the action is bound to `onClick` ONLY (mirroring the history
  // button). pointerDown must NOT fire onDelete — it exists purely for
  // focus-retention (preventDefault) and to stop the press bubbling into block
  // selection (stopPropagation). Binding the action there too made one mouse
  // interaction (pointerdown → synthetic click) call onDelete twice.
  it('does not call onDelete on pointerDown alone (action is click-bound)', () => {
    const onDelete = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B99" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    fireEvent.pointerDown(deleteBtn)

    expect(onDelete).not.toHaveBeenCalled()
  })

  // #1532 (revert-sensitive): a single mouse interaction is a pointerdown
  // followed by a synthetic click. `preventDefault` on pointerdown does NOT
  // suppress that click, so binding onDelete to BOTH handlers fired it twice.
  // Assert exactly ONE onDelete call across the whole sequence.
  it('fires onDelete exactly once for a pointerdown+click mouse interaction (#1532)', () => {
    const onDelete = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B99" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    // Reproduce a real mouse press: pointerdown then the click the browser
    // synthesizes on release. preventDefault on pointerdown does not cancel it.
    fireEvent.pointerDown(deleteBtn)
    fireEvent.click(deleteBtn)

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('B99')
  })

  it('calls onDelete with blockId on click (keyboard fallback)', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    renderWithTooltip(<BlockGutterControls blockId="B_KB" onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: /delete block/i }))
    expect(onDelete).toHaveBeenCalledWith('B_KB')
  })

  // #1532: keyboard activation (Enter / Space) must still trigger delete.
  // Native buttons dispatch a `click` on Enter/Space, and the action lives on
  // onClick, so focusing the button and pressing each key fires onDelete once.
  it('triggers onDelete via keyboard Enter and Space (action stays on click)', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    renderWithTooltip(<BlockGutterControls blockId="B_ENTER" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    deleteBtn.focus()
    await user.keyboard('{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenLastCalledWith('B_ENTER')

    await user.keyboard(' ')
    expect(onDelete).toHaveBeenCalledTimes(2)
    expect(onDelete).toHaveBeenLastCalledWith('B_ENTER')
  })

  // #1532: pointerdown still keeps editor focus (preventDefault) so the
  // following click isn't swallowed — same contract the history button relies
  // on. Mirror the history button's focus-retention assertion for delete.
  it('delete button prevents default on pointerDown to retain editor focus (#1532)', () => {
    const onDelete = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B_FOCUS" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const prevented = vi.spyOn(ev, 'preventDefault')
    deleteBtn.dispatchEvent(ev)

    expect(prevented).toHaveBeenCalled()
    // ... and the action did NOT fire on pointerdown.
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('stopPropagation on delete pointerDown prevents parent activation', () => {
    const onDelete = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const stopSpy = vi.spyOn(event, 'stopPropagation')
    deleteBtn.dispatchEvent(event)

    expect(stopSpy).toHaveBeenCalled()
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

  it('renders all three buttons when all callbacks are provided', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /block history/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete block/i })).toBeInTheDocument()
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

  it('shows delete tooltip on hover', async () => {
    const user = userEvent.setup()

    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    await user.hover(screen.getByRole('button', { name: /delete block/i }))

    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: t('block.delete') })).toBeInTheDocument()
    })
  })

  it('shows history tooltip on hover', async () => {
    const user = userEvent.setup()

    renderWithTooltip(<BlockGutterControls blockId="B1" onShowHistory={vi.fn()} />)

    await user.hover(screen.getByRole('button', { name: /block history/i }))

    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: t('block.history') })).toBeInTheDocument()
    })
  })
})

describe('BlockGutterControls gutter button classes', () => {
  // #370: the desktop drag handle follows the same per-block hover contract as
  // every other gutter control — hidden at rest (opacity-0 / pointer-events-none
  // from GUTTER_BUTTON_BASE) and revealed only on group-hover / focus-within /
  // .block-active. The earlier #217-B2 opacity-30 at-rest tweak painted a grip
  // on every row at all times, defeating per-row hover scope; reverted here.
  it('drag handle is hidden at rest and revealed on row hover (per-block contract)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('opacity-0')
    expect(dragHandle.className).toContain('pointer-events-none')
    expect(dragHandle.className).not.toContain('opacity-30')
    expect(dragHandle.className).toContain('group-hover:opacity-100')
    expect(dragHandle.className).toContain('group-hover:pointer-events-auto')
  })

  it('delete button has pointer-events-none when invisible (opacity-0)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('opacity-0')
    expect(deleteBtn.className).toContain('pointer-events-none')
    expect(deleteBtn.className).toContain('group-hover:pointer-events-auto')
  })

  it('history button has pointer-events-none when invisible (opacity-0)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onShowHistory={vi.fn()} />)

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn.className).toContain('opacity-0')
    expect(historyBtn.className).toContain('pointer-events-none')
    expect(historyBtn.className).toContain('group-hover:pointer-events-auto')
  })

  it('all three gutter buttons carry the touch-target utility class', () => {
    // Regression for the.touch-target utility now sets both min-height
    // and min-width to 44px under (pointer: coarse) so the 20-px-wide gutter
    // buttons meet WCAG 2.5.8 on touch devices. jsdom cannot evaluate the
    // @media query, so we assert structural presence of the utility class
    // on each button instead of its computed width.
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    const historyBtn = screen.getByRole('button', { name: /block history/i })
    const deleteBtn = screen.getByRole('button', { name: /delete block/i })

    expect(dragHandle.className).toContain('touch-target')
    expect(historyBtn.className).toContain('touch-target')
    expect(deleteBtn.className).toContain('touch-target')
  })

  // #995: the gutter is the last consumer migrated off the legacy `focus-ring`
  // (2px ring + offset) onto the canonical `focus-ring-visible` (3px inset).
  it('all three gutter buttons carry focus-ring-visible (not the legacy focus-ring)', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    const historyBtn = screen.getByRole('button', { name: /block history/i })
    const deleteBtn = screen.getByRole('button', { name: /delete block/i })

    for (const btn of [dragHandle, historyBtn, deleteBtn]) {
      expect(btn.className).toContain('focus-ring-visible')
      // No bare legacy token (guard against a regression to `focus-ring`).
      expect(btn.className.split(/\s+/)).not.toContain('focus-ring')
    }
  })

  // #997: the neutral / destructive hover palettes are centralized constants;
  // assert each button carries the expected colour set (neutral keeps both
  // bg+text, destructive keeps the destructive bg+text).
  it('applies the centralized neutral/destructive hover palettes', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    const deleteBtn = screen.getByRole('button', { name: /delete block/i })

    // History = neutral palette.
    expect(historyBtn.className).toContain('hover:bg-accent')
    expect(historyBtn.className).toContain('hover:text-foreground')
    // Delete = destructive palette (and keeps the delete-handle modifier).
    expect(deleteBtn.className).toContain('delete-handle')
    expect(deleteBtn.className).toContain('hover:bg-destructive/10')
    expect(deleteBtn.className).toContain('hover:text-destructive')
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
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    const historyBtn = screen.getByRole('button', { name: /block history/i })
    const deleteBtn = screen.getByRole('button', { name: /delete block/i })

    for (const btn of [dragHandle, historyBtn, deleteBtn]) {
      expect(btn.className.split(/\s+/)).toContain('rounded-sm')
      // Must NOT be bumped to the padded-row radius (#998 explicit decision).
      expect(btn.className.split(/\s+/)).not.toContain('rounded-md')
    }
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

  // User feedback 2026-06-12: with NO active selection the checkbox must NOT
  // clutter a casual hover — it's fully out of the way (no hover-reveal).
  it('keeps the checkbox out of the way on casual hover when no selection is active', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    const checkbox = screen.getByTestId('block-select-checkbox')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).toHaveAttribute('type', 'checkbox')
    expect(checkbox).toHaveAttribute('aria-label', t('block.selectBlock'))
    expect(checkbox.className).toContain('opacity-0')
    expect(checkbox.className).toContain('pointer-events-none')
    // NOT hover-revealed while idle.
    expect(checkbox.className).not.toContain('group-hover:opacity-100')
  })

  // Once a multi-selection IS active, other rows hover-reveal their checkbox so
  // the selection can be extended.
  it('hover-reveals the checkbox on other rows once a selection is active', () => {
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} />)
    const checkbox = screen.getByTestId('block-select-checkbox')
    expect(checkbox.className).toContain('opacity-0')
    expect(checkbox.className).toContain('group-hover:opacity-100')
    expect(checkbox.className).not.toContain('pointer-events-none')
  })

  it('toggles selection via onSelect(blockId, "toggle") when changed', () => {
    const onSelect = vi.fn()
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
    const { container } = renderWithTooltip(
      <BlockGutterControls blockId="B1" onSelect={vi.fn()} onDelete={vi.fn()} />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('BlockGutterControls accessibility', () => {
  it('passes axe audit with all buttons rendered', async () => {
    const { container } = renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('passes axe audit with only drag handle rendered', async () => {
    const { container } = renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

/* ── Touch (pointer: coarse) — overflow Sheet ─────────────── */

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

  it('renders only drag handle and overflow button (not inline history/delete)', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.getByTestId('more-actions')).toBeInTheDocument()
    // Inline history/delete are NOT rendered on touch — they live in the Sheet.
    expect(screen.queryByTestId('clock-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('trash-icon')).not.toBeInTheDocument()
    expect(screen.getByTestId('more-vertical-icon')).toBeInTheDocument()
  })

  it('overflow button exposes the dialog hint via aria attributes', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const overflow = screen.getByTestId('more-actions')
    // The aria-label is now enumerated based on available actions
    // See the dedicated tests below for that contract.
    expect(overflow).toHaveAttribute('aria-haspopup', 'dialog')
    expect(overflow).toHaveAttribute('aria-expanded', 'false')
  })

  // ── touch drag handle long-press hint ─────────────────────
  it('drag handle aria-label surfaces the long-press hint on touch', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle).toHaveAttribute('aria-label', t('block.reorderTouchHint'))
  })

  // ── #918: the touch grip must be a real, hittable, drag-activating target ──
  it('touch drag grip is hittable at rest with touch-action:none and a comfortable hit area (#918)', () => {
    const dragListeners = { onPointerDown: vi.fn() }
    renderWithTooltip(
      <BlockGutterControls
        blockId="B1"
        onDelete={vi.fn()}
        onShowHistory={vi.fn()}
        dragAttributes={{ 'data-dnd-activator': 'grip' } as never}
        dragListeners={dragListeners}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    // Visible & interactive at rest — NOT the hover-hidden desktop contract.
    expect(dragHandle.className).not.toContain('opacity-0')
    expect(dragHandle.className).not.toContain('pointer-events-none')
    // ≥44×44 hit area (WCAG 2.5.5) + touch-action:none so the gesture starts a
    // drag instead of a scroll.
    expect(dragHandle.className).toContain('touch-target')
    expect(dragHandle.className).toContain('touch-none')
    // The grip is the dnd-kit activator: it carries the attributes + listeners.
    expect(dragHandle).toHaveAttribute('data-dnd-activator', 'grip')
    fireEvent.pointerDown(dragHandle)
    expect(dragListeners.onPointerDown).toHaveBeenCalledTimes(1)
  })

  // ── #996: coarse-pointer icon legibility ──────────────────────────
  // A 16px glyph in the WCAG 44px box reads as floaty; bump the touch grip and
  // overflow icons to 20px on coarse pointers (desktop p-0.5/16px unchanged).
  it('touch grip and overflow icons scale to 20px on coarse pointers (#996)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const grip = screen.getByTestId('grip-vertical-icon')
    const overflow = screen.getByTestId('more-vertical-icon')

    for (const icon of [grip, overflow]) {
      expect(icon.getAttribute('class')).toContain('[@media(pointer:coarse)]:h-5')
      expect(icon.getAttribute('class')).toContain('[@media(pointer:coarse)]:w-5')
    }
  })

  // #996: neither touch element paints a visible button background at rest —
  // bg only appears on hover/active so the region reads as ambient chrome.
  it('touch grip and overflow have no resting background (#996)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const grip = screen.getByTestId('drag-handle')
    const overflow = screen.getByTestId('more-actions')

    // Grip: only active:bg-accent (no unconditional bg-* utility).
    expect(grip.className).toContain('active:bg-accent')
    expect(grip.className.split(/\s+/).some((c) => c.startsWith('bg-'))).toBe(false)
    // Overflow: only hover:bg-accent (no unconditional bg-* utility).
    expect(overflow.className).toContain('hover:bg-accent')
    expect(overflow.className.split(/\s+/).some((c) => c.startsWith('bg-'))).toBe(false)
  })

  // ── more-actions aria-label enumerates available actions ──
  it('more-actions aria-label enumerates History and Delete when both are provided', () => {
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const overflow = screen.getByTestId('more-actions')
    const expected = t('block.moreActionsEnumerated', {
      actions: `${t('block.history')}, ${t('block.delete')}`,
    })
    expect(overflow).toHaveAttribute('aria-label', expected)
  })

  it('more-actions aria-label enumerates only Delete when onShowHistory is undefined', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const overflow = screen.getByTestId('more-actions')
    const expected = t('block.moreActionsEnumerated', { actions: t('block.delete') })
    expect(overflow).toHaveAttribute('aria-label', expected)
  })

  it('does not render the overflow button when no secondary actions are wired', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.queryByTestId('more-actions')).not.toBeInTheDocument()
  })

  it('tapping overflow opens the Sheet with labelled History and Delete rows', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    await user.click(screen.getByTestId('more-actions'))

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    expect(screen.getByText(t('block.actionsSheetTitle'))).toBeInTheDocument()
    // Sheet rows expose the same labels as desktop tooltips.
    expect(screen.getByTestId('more-actions-history')).toHaveTextContent(t('block.history'))
    expect(screen.getByTestId('more-actions-delete')).toHaveTextContent(t('block.delete'))
  })

  it('History row in the Sheet calls onShowHistory(blockId)', async () => {
    const user = userEvent.setup()
    const onShowHistory = vi.fn()
    renderWithTooltip(
      <BlockGutterControls blockId="B_HX" onShowHistory={onShowHistory} onDelete={vi.fn()} />,
    )

    await user.click(screen.getByTestId('more-actions'))
    await user.click(await screen.findByTestId('more-actions-history'))

    expect(onShowHistory).toHaveBeenCalledTimes(1)
    expect(onShowHistory).toHaveBeenCalledWith('B_HX')
  })

  it('Delete row in the Sheet calls onDelete(blockId)', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderWithTooltip(
      <BlockGutterControls blockId="B_DEL" onDelete={onDelete} onShowHistory={vi.fn()} />,
    )

    await user.click(screen.getByTestId('more-actions'))
    await user.click(await screen.findByTestId('more-actions-delete'))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('B_DEL')
  })

  it('only renders the History row when onDelete is undefined', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<BlockGutterControls blockId="B1" onShowHistory={vi.fn()} />)

    await user.click(screen.getByTestId('more-actions'))

    await waitFor(() => {
      expect(screen.getByTestId('more-actions-history')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('more-actions-delete')).not.toBeInTheDocument()
  })

  it('only renders the Delete row when onShowHistory is undefined', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    await user.click(screen.getByTestId('more-actions'))

    await waitFor(() => {
      expect(screen.getByTestId('more-actions-delete')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('more-actions-history')).not.toBeInTheDocument()
  })

  it('passes axe audit in touch mode (closed Sheet)', async () => {
    const { container } = renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('passes axe audit in touch mode (open Sheet)', async () => {
    const user = userEvent.setup()
    const { baseElement } = renderWithTooltip(
      <BlockGutterControls blockId="B1" onDelete={vi.fn()} onShowHistory={vi.fn()} />,
    )

    await user.click(screen.getByTestId('more-actions'))
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Use baseElement so axe sees the portalled Sheet content.
    const results = await axe(baseElement)
    expect(results).toHaveNoViolations()
  })
})

/* ── Fix 6: multiselect mode shows ONLY the select checkbox ──────────── */

describe('BlockGutterControls multiselect mode (Fix 6)', () => {
  afterEach(() => {
    useBlockStore.setState({ selectedBlockIds: [] })
  })

  it('desktop: suppresses history/delete, keeps the select checkbox + drag handle (#914)', () => {
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    renderWithTooltip(
      <BlockGutterControls
        blockId="B1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onShowHistory={vi.fn()}
      />,
    )
    // The select checkbox AND the drag handle survive (the handle is kept so a
    // multi-selection can still be dragged to move — #914); history/delete are
    // suppressed to keep selection mode uncluttered.
    expect(screen.getByTestId('block-select-checkbox')).toBeInTheDocument()
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete block/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /block history/i })).not.toBeInTheDocument()
  })

  it('touch: suppresses the touch grip + overflow trigger, keeps the checkbox', () => {
    const original = setMatchMedia(true)
    useBlockStore.setState({ selectedBlockIds: ['OTHER'] })
    try {
      renderWithTooltip(
        <BlockGutterControls
          blockId="B1"
          onSelect={vi.fn()}
          onDelete={vi.fn()}
          onShowHistory={vi.fn()}
        />,
      )
      expect(screen.getByTestId('block-select-checkbox')).toBeInTheDocument()
      expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
      expect(screen.queryByTestId('more-actions')).not.toBeInTheDocument()
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original)
      resetMaxTouchPoints()
    }
  })

  it('renders the full gutter (drag handle present) when no selection is active', () => {
    useBlockStore.setState({ selectedBlockIds: [] })
    renderWithTooltip(<BlockGutterControls blockId="B1" onSelect={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete block/i })).toBeInTheDocument()
  })
})
