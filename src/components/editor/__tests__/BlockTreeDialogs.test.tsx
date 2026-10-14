/**
 * BlockTreeDialogs (#5441) — each dialog is lazy and mounts only while open, so
 * a BlockTree on screen does not fetch the dialog chunks. The stubs render
 * whenever mounted, which is what the gate controls.
 */
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BlockTreeDialogs } from '@/components/editor/BlockTreeDialogs'

vi.mock('@/components/dialogs/QueryBuilderModal', () => ({
  QueryBuilderModal: () => <div data-testid="query-builder-stub" />,
}))
vi.mock('@/components/EmojiPicker/EmojiPickerDialog', () => ({
  EmojiPickerDialog: () => <div data-testid="emoji-picker-stub" />,
}))
vi.mock('@/components/editor/BlockHistorySheet', () => ({
  BlockHistorySheet: ({ blockId }: { blockId: string }) => (
    <div data-testid="history-sheet-stub">{blockId}</div>
  ),
}))
vi.mock('@/components/editor/BlockPropertyDrawerSheet', () => ({
  BlockPropertyDrawerSheet: ({ blockId }: { blockId: string }) => (
    <div data-testid="property-drawer-stub">{blockId}</div>
  ),
}))

const STUBS = [
  'query-builder-stub',
  'emoji-picker-stub',
  'history-sheet-stub',
  'property-drawer-stub',
]

function renderDialogs(open: {
  queryBuilderOpen?: boolean
  emojiPickerOpen?: boolean
  historyBlockId?: string | null
  propertyDrawerBlockId?: string | null
}) {
  return render(
    <BlockTreeDialogs
      queryBuilderOpen={open.queryBuilderOpen ?? false}
      setQueryBuilderOpen={vi.fn()}
      handleQuerySave={vi.fn()}
      emojiPickerOpen={open.emojiPickerOpen ?? false}
      setEmojiPickerOpen={vi.fn()}
      handleEmojiSelect={vi.fn()}
      historyBlockId={open.historyBlockId ?? null}
      setHistoryBlockId={vi.fn()}
      propertyDrawerBlockId={open.propertyDrawerBlockId ?? null}
      setPropertyDrawerBlockId={vi.fn()}
    />,
  )
}

describe('BlockTreeDialogs', () => {
  it('mounts no dialog while all are closed', async () => {
    renderDialogs({})
    // Settle the lazy imports, so a dialog mounted while closed has rendered.
    await act(() =>
      Promise.all([
        import('@/components/dialogs/QueryBuilderModal'),
        import('@/components/EmojiPicker/EmojiPickerDialog'),
        import('@/components/editor/BlockHistorySheet'),
        import('@/components/editor/BlockPropertyDrawerSheet'),
      ]),
    )
    for (const id of STUBS) expect(screen.queryByTestId(id)).not.toBeInTheDocument()
  })

  it('mounts each dialog once it is open', async () => {
    renderDialogs({
      queryBuilderOpen: true,
      emojiPickerOpen: true,
      historyBlockId: 'BLOCK_H',
      propertyDrawerBlockId: 'BLOCK_P',
    })
    expect(await screen.findByTestId('query-builder-stub')).toBeInTheDocument()
    expect(await screen.findByTestId('emoji-picker-stub')).toBeInTheDocument()
    expect(await screen.findByTestId('history-sheet-stub')).toHaveTextContent('BLOCK_H')
    expect(await screen.findByTestId('property-drawer-stub')).toHaveTextContent('BLOCK_P')
  })

  it('has no a11y violations', async () => {
    const { container } = renderDialogs({ historyBlockId: 'BLOCK_H' })
    await screen.findByTestId('history-sheet-stub')
    expect(await axe(container)).toHaveNoViolations()
  })
})
