import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LucideIcon } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'

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
  return original
}

import { BlockGutterControls, GutterButton } from '../BlockGutterControls'
import { TooltipProvider } from '../ui/tooltip'

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

  it('calls onDelete with blockId on pointerDown', () => {
    const onDelete = vi.fn()
    renderWithTooltip(<BlockGutterControls blockId="B99" onDelete={onDelete} />)

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    fireEvent.pointerDown(deleteBtn)

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledWith('B99')
  })

  it('calls onDelete with blockId on click (keyboard fallback)', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    renderWithTooltip(<BlockGutterControls blockId="B_KB" onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: /delete block/i }))
    expect(onDelete).toHaveBeenCalledWith('B_KB')
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
  it('drag handle has pointer-events-none when invisible (opacity-0)', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" />)

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('opacity-0')
    expect(dragHandle.className).toContain('pointer-events-none')
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

  it('all three gutter buttons carry the touch-target utility class (UX-245)', () => {
    // Regression for UX-245: the .touch-target utility now sets both min-height
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

/* ── Touch (pointer: coarse) — UX-281 overflow Sheet ─────────────── */

describe('BlockGutterControls (touch / pointer:coarse)', () => {
  let originalMatchMedia: PropertyDescriptor | undefined

  beforeEach(() => {
    originalMatchMedia = setMatchMedia(true)
  })

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
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

  it('overflow button has the localized aria-label and dialog hint', () => {
    renderWithTooltip(<BlockGutterControls blockId="B1" onDelete={vi.fn()} />)

    const overflow = screen.getByTestId('more-actions')
    expect(overflow).toHaveAttribute('aria-label', t('block.moreActionsLabel'))
    expect(overflow).toHaveAttribute('aria-haspopup', 'dialog')
    expect(overflow).toHaveAttribute('aria-expanded', 'false')
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
