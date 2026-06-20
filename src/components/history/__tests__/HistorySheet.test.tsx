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

import { HistorySheet } from '@/components/history/HistorySheet'

describe('HistorySheet', () => {
  it('renders Sheet with HistoryPanel when open=true and blockId is set', () => {
    render(<HistorySheet blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(screen.getByTestId('history-panel')).toHaveTextContent('History for BLOCK_1')
  })

  it('does not render HistoryPanel content when open=false', () => {
    render(<HistorySheet blockId="BLOCK_1" open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
  })

  it('passes blockId to HistoryPanel', () => {
    render(<HistorySheet blockId="BLOCK_42" open onOpenChange={vi.fn()} />)

    const panel = screen.getByTestId('history-panel')
    expect(panel).toHaveTextContent('History for BLOCK_42')
  })

  it('does not render HistoryPanel when blockId is null', () => {
    render(<HistorySheet blockId={null} open onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
  })

  it('displays "Block History" as the sheet title', () => {
    render(<HistorySheet blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    expect(screen.getByText('Block History')).toBeInTheDocument()
  })

  it('close button calls onOpenChange with false', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<HistorySheet blockId="BLOCK_1" open onOpenChange={onOpenChange} />)

    const closeBtn = screen.getByRole('button', { name: /close/i })
    await user.click(closeBtn)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // block-history-sheet-fix-2026-05-14: the Sheet was widened from
  // `sm:max-w-sm` (≈384 px) to `sm:max-w-lg` (≈512 px) so dense history
  // rows (timestamp + op-icon + author + multi-line preview + diff toggle
  // + restore button) don't single-word-wrap and the filter bar stays
  // one row. Per-call override; other Sheet consumers keep the default.
  it('SheetContent carries `sm:max-w-lg` width override (~512 px)', () => {
    render(<HistorySheet blockId="BLOCK_1" open onOpenChange={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    // Baseline mobile width comes from the Sheet primitive (w-3/4) — the
    // override only kicks in at the `sm:` breakpoint.
    expect(dialog).toHaveClass('w-3/4')
    expect(dialog).toHaveClass('sm:max-w-lg')
    // The previous default (`sm:max-w-sm`) is still present on the base
    // class string (tailwind-merge collapses to the per-call override at
    // runtime), but the new `lg` override must be there.
    expect(dialog.className).not.toContain('sm:w-80')
  })

  // block-history-sheet-fix-2026-05-14: body wrapper is now `<SheetBody>`
  // (a ScrollArea with `flex-1 min-h-0 -mx-6 / viewportClassName="px-6"`)
  // instead of the ad-hoc `<div className="mt-4 space-y-3 px-4 pb-4">`.
  // The new pattern aligns left edges with the SheetHeader and keeps the
  // LoadMoreButton at the bottom of the panel reachable on short windows.
  it('wraps HistoryPanel in a SheetBody (ScrollArea with `flex-1 min-h-0`)', () => {
    render(<HistorySheet blockId="BLOCK_1" open onOpenChange={vi.fn()} />)
    const panel = screen.getByTestId('history-panel')
    // SheetBody now stamps `data-slot="sheet-body"` on the ScrollArea root
    // (#1028/#1029) — that overrides the primitive's default `scroll-area`
    // slot, so query the body slot to reach the scroll container.
    const scrollRoot = panel.closest('[data-slot="sheet-body"]')
    expect(scrollRoot).not.toBeNull()
    expect(scrollRoot).toHaveClass('flex-1', 'min-h-0', '-mx-6')
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(<HistorySheet blockId="BLOCK_1" open onOpenChange={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
