/**
 * Tests for HistorySheet component.
 *
 * Validates:
 *  - Renders Sheet when open with block history content
 *  - Does not render content when closed
 *  - Passes blockId to HistoryPanel
 *  - SheetTitle shows "Block History"
 *  - Close button works (calls onOpenChange with false)
 *  - Axe a11y audit passes
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../HistoryPanel', () => ({
  HistoryPanel: ({ blockId }: { blockId: string }) => (
    <div data-testid="history-panel">History for {blockId}</div>
  ),
}))

import { HistorySheet } from '../HistorySheet'

describe('HistorySheet', () => {
  it('renders Sheet with HistoryPanel when open=true and blockId is set', () => {
    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(screen.getByTestId('history-panel')).toHaveTextContent('History for BLOCK_1')
  })

  it('does not render HistoryPanel content when open=false', () => {
    render(<HistorySheet blockId="BLOCK_1" open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
  })

  it('passes blockId to HistoryPanel', () => {
    render(<HistorySheet blockId="BLOCK_42" open={true} onOpenChange={vi.fn()} />)

    const panel = screen.getByTestId('history-panel')
    expect(panel).toHaveTextContent('History for BLOCK_42')
  })

  it('does not render HistoryPanel when blockId is null', () => {
    render(<HistorySheet blockId={null} open={true} onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
  })

  it('displays "Block History" as the sheet title', () => {
    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Block History')).toBeInTheDocument()
  })

  it('close button calls onOpenChange with false', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={onOpenChange} />)

    const closeBtn = screen.getByRole('button', { name: /close/i })
    await user.click(closeBtn)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has w-80 width class on SheetContent for desktop', () => {
    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)
    // SheetContent renders with role="dialog"
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('sm:w-80')
  })

  it('has padding wrapper inside ScrollArea', () => {
    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)
    const panel = screen.getByTestId('history-panel')
    const wrapper = panel.closest('.px-4')
    expect(wrapper).toBeInTheDocument()
    expect(wrapper).toHaveClass('mt-4', 'space-y-3', 'pb-4')
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(
      <HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
