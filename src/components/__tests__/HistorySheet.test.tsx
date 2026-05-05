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

  // PEND-28 M12: the override `w-3/4 sm:w-80` locked the sheet to 320 px on
  // sm+ and produced a 270 px-wide drawer on a 360 px phone (75 %). Dropping
  // the override falls back to the Sheet primitive's baseline (`w-3/4`
  // mobile, `sm:max-w-sm` = 384 px on sm+), which gives more room for the
  // history list.
  it('SheetContent uses the Sheet primitive baseline width (no w-80 override)', () => {
    render(<HistorySheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)
    // SheetContent renders with role="dialog"
    const dialog = screen.getByRole('dialog')
    // Baseline mobile width comes from the Sheet primitive (w-3/4)…
    expect(dialog).toHaveClass('w-3/4')
    // …and the sm+ cap is `sm:max-w-sm` (384 px) — not the old `sm:w-80` override.
    expect(dialog).toHaveClass('sm:max-w-sm')
    expect(dialog.className).not.toContain('sm:w-80')
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
