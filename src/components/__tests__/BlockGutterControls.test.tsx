import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LucideIcon } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Clock: (props: { className?: string }) => (
    <svg data-testid="clock-icon" className={props.className} />
  ),
  GripVertical: (props: { className?: string }) => (
    <svg data-testid="grip-vertical-icon" className={props.className} />
  ),
  Trash2: (props: { className?: string }) => (
    <svg data-testid="trash-icon" className={props.className} />
  ),
}))

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
