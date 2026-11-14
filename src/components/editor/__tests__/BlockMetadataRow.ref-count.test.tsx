/**
 * #6746 — the reference count a referenced block shows in its metadata row,
 * and its activation (the caller zooms the block, where its linked references
 * list).
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  BlockMetadataRow,
  type BlockMetadataRowProps,
} from '@/components/editor/BlockInlineControls'
import { TooltipProvider } from '@/components/ui/tooltip'
import { t } from '@/lib/i18n'

function renderRow(overrides: Partial<BlockMetadataRowProps>) {
  const props: BlockMetadataRowProps = {
    blockId: 'BLOCK_1',
    filteredProperties: [],
    attachmentCount: 0,
    showAttachments: false,
    onToggleAttachments: vi.fn(),
    onEditProp: vi.fn(),
    onEditKey: vi.fn(),
    ...overrides,
  }
  return render(
    <TooltipProvider>
      <BlockMetadataRow {...props} />
    </TooltipProvider>,
  )
}

describe('BlockMetadataRow reference count (#6746)', () => {
  it('shows how many blocks reference the block', () => {
    renderRow({ refCount: 2, onOpenReferences: vi.fn() })
    const chip = screen.getByRole('button', { name: t('refCount.label', { count: 2 }) })
    expect(chip).toHaveTextContent('2')
  })

  it('shows nothing, not even a row, for a block nothing references', () => {
    renderRow({ refCount: 0, onOpenReferences: vi.fn() })
    expect(screen.queryByTestId('ref-count-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('block-metadata-row')).not.toBeInTheDocument()
  })

  it('opens the references of its own block when activated', async () => {
    const user = userEvent.setup()
    const onOpenReferences = vi.fn()
    renderRow({ blockId: 'REFERENCED', refCount: 2, onOpenReferences })
    await user.click(screen.getByTestId('ref-count-chip'))
    expect(onOpenReferences).toHaveBeenCalledExactlyOnceWith('REFERENCED')
  })

  it('opens them from the keyboard too', async () => {
    const user = userEvent.setup()
    const onOpenReferences = vi.fn()
    renderRow({ blockId: 'REFERENCED', refCount: 1, onOpenReferences })
    screen.getByTestId('ref-count-chip').focus()
    await user.keyboard('{Enter}')
    expect(onOpenReferences).toHaveBeenCalledExactlyOnceWith('REFERENCED')
  })

  it('keeps a 44 px target on a coarse pointer', () => {
    renderRow({ refCount: 3, onOpenReferences: vi.fn() })
    expect(screen.getByTestId('ref-count-chip')).toHaveClass('touch-hit-area')
  })

  it('has no a11y violations', async () => {
    const { container } = renderRow({ refCount: 2, onOpenReferences: vi.fn() })
    expect(await axe(container)).toHaveNoViolations()
  })
})
