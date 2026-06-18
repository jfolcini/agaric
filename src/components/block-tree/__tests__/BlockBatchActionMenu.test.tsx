/**
 * Tests for BlockBatchActionMenu — the sticky batch-operations toolbar shown
 * when multiple blocks are selected.
 *
 * Validates:
 *  - Renders nothing when no blocks are selected
 *  - Renders the selected-count and the four TODO-state buttons + Delete +
 *    Clear-selection when a selection exists
 *  - Each TODO-state button calls onBatchSetTodo with the right state
 *    (null / 'TODO' / 'DOING' / 'DONE')
 *  - The Delete button opens the confirm dialog (onSetBatchDeleteConfirm(true))
 *  - The dialog's confirm action calls onBatchDelete; cancel/close calls
 *    onSetBatchDeleteConfirm(false)
 *  - The Clear (X) button calls onClearSelection
 *  - batchInProgress disables the TODO + Delete buttons
 *  - a11y: axe audit passes
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { BlockBatchActionMenu } from '@/components/block-tree/BlockBatchActionMenu'
import { t } from '@/lib/i18n'

interface Overrides {
  selectedBlockIds?: string[]
  batchInProgress?: boolean
  batchDeleteConfirm?: boolean
  onBatchSetTodo?: (state: string | null) => void
  onBatchSetPriority?: (() => void) | undefined
  onBatchDelete?: () => void
  onSetBatchDeleteConfirm?: (open: boolean) => void
  onClearSelection?: () => void
}

function renderToolbar(overrides: Overrides = {}) {
  const props = {
    selectedBlockIds: ['BLOCK_01', 'BLOCK_02'],
    batchInProgress: false,
    batchDeleteConfirm: false,
    onBatchSetTodo: vi.fn(),
    onBatchSetPriority: vi.fn(),
    onBatchDelete: vi.fn(),
    onSetBatchDeleteConfirm: vi.fn(),
    onClearSelection: vi.fn(),
    ...overrides,
  }
  const result = render(<BlockBatchActionMenu {...props} />)
  return { ...result, props }
}

describe('BlockBatchActionMenu', () => {
  // ── Rendering ──────────────────────────────────────────────────────
  it('renders nothing when no blocks are selected', () => {
    const { container } = renderToolbar({ selectedBlockIds: [] })
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('batch-toolbar')).not.toBeInTheDocument()
  })

  it('renders the toolbar with the selected count when blocks are selected', () => {
    renderToolbar({ selectedBlockIds: ['A', 'B', 'C'] })

    const toolbar = screen.getByTestId('batch-toolbar')
    expect(toolbar).toBeInTheDocument()
    // Count and the "selected" label share one span: "3 selected".
    expect(within(toolbar).getByText(`3 ${t('blockContext.selected')}`)).toBeInTheDocument()
  })

  it('renders the four TODO-state buttons, Delete and Clear-selection', () => {
    renderToolbar()

    const toolbar = screen.getByTestId('batch-toolbar')
    expect(
      within(toolbar).getByRole('button', { name: t('blockContext.clear') }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: t('blockContext.todoLabel') }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: t('blockContext.doingLabel') }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: t('blockContext.doneLabel') }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: t('blockContext.delete') }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: t('history.clearSelectionButton') }),
    ).toBeInTheDocument()
  })

  // ── TODO-state actions ─────────────────────────────────────────────
  it('Clear button calls onBatchSetTodo with null', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('blockContext.clear') }))

    expect(props.onBatchSetTodo).toHaveBeenCalledTimes(1)
    expect(props.onBatchSetTodo).toHaveBeenCalledWith(null)
  })

  it('TODO button calls onBatchSetTodo with "TODO"', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('blockContext.todoLabel') }))

    expect(props.onBatchSetTodo).toHaveBeenCalledWith('TODO')
  })

  it('DOING button calls onBatchSetTodo with "DOING"', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('blockContext.doingLabel') }))

    expect(props.onBatchSetTodo).toHaveBeenCalledWith('DOING')
  })

  // ── Priority parity (#1734) ────────────────────────────────────────
  it('renders a Priority button and calls onBatchSetPriority (parity with the bulk context menu)', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    const priorityBtn = screen.getByRole('button', { name: t('contextMenu.cyclePrioritySelected') })
    expect(priorityBtn).toBeInTheDocument()

    await user.click(priorityBtn)
    expect(props.onBatchSetPriority).toHaveBeenCalledTimes(1)
  })

  it('hides the Priority button when no onBatchSetPriority handler is provided', () => {
    renderToolbar({ onBatchSetPriority: undefined })
    expect(
      screen.queryByRole('button', { name: t('contextMenu.cyclePrioritySelected') }),
    ).not.toBeInTheDocument()
  })

  it('DONE button calls onBatchSetTodo with "DONE"', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('blockContext.doneLabel') }))

    expect(props.onBatchSetTodo).toHaveBeenCalledWith('DONE')
  })

  // ── Delete + confirm dialog ────────────────────────────────────────
  it('Delete button opens the confirm dialog (does not delete immediately)', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('blockContext.delete') }))

    expect(props.onSetBatchDeleteConfirm).toHaveBeenCalledWith(true)
    // The actual delete is deferred to the dialog's confirm action.
    expect(props.onBatchDelete).not.toHaveBeenCalled()
  })

  it('does not render the confirm dialog while batchDeleteConfirm is false', () => {
    renderToolbar({ batchDeleteConfirm: false })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('renders the confirm dialog with the selected count when batchDeleteConfirm is true', () => {
    renderToolbar({ selectedBlockIds: ['A', 'B'], batchDeleteConfirm: true })

    const dialog = screen.getByRole('alertdialog')
    expect(
      within(dialog).getByText(t('blockContext.deleteConfirmTitle', { count: 2 })),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(t('blockContext.deleteConfirmDescription'))).toBeInTheDocument()
  })

  it('confirm action in the dialog calls onBatchDelete', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ batchDeleteConfirm: true })

    await user.click(screen.getByRole('button', { name: t('blockContext.deleteConfirmAction') }))

    expect(props.onBatchDelete).toHaveBeenCalledTimes(1)
  })

  it('cancel in the dialog requests the dialog to close (onSetBatchDeleteConfirm(false))', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ batchDeleteConfirm: true })

    await user.click(screen.getByRole('button', { name: t('dialog.cancel') }))

    expect(props.onSetBatchDeleteConfirm).toHaveBeenCalledWith(false)
    expect(props.onBatchDelete).not.toHaveBeenCalled()
  })

  // ── Clear selection ────────────────────────────────────────────────
  it('Clear-selection (X) button calls onClearSelection', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()

    await user.click(screen.getByRole('button', { name: t('history.clearSelectionButton') }))

    expect(props.onClearSelection).toHaveBeenCalledTimes(1)
  })

  // ── Disabled state ─────────────────────────────────────────────────
  it('disables the TODO-state and Delete buttons while a batch is in progress', () => {
    renderToolbar({ batchInProgress: true })

    const toolbar = screen.getByTestId('batch-toolbar')
    for (const name of [
      t('blockContext.clear'),
      t('blockContext.todoLabel'),
      t('blockContext.doingLabel'),
      t('blockContext.doneLabel'),
      t('contextMenu.cyclePrioritySelected'),
      t('blockContext.delete'),
    ]) {
      expect(within(toolbar).getByRole('button', { name })).toBeDisabled()
    }
  })

  it('does not fire onBatchSetTodo when a disabled button is clicked', async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ batchInProgress: true })

    await user.click(screen.getByRole('button', { name: t('blockContext.todoLabel') }))

    expect(props.onBatchSetTodo).not.toHaveBeenCalled()
  })

  it('keeps the Clear-selection (X) button enabled while a batch is in progress', () => {
    renderToolbar({ batchInProgress: true })

    const toolbar = screen.getByTestId('batch-toolbar')
    expect(
      within(toolbar).getByRole('button', { name: t('history.clearSelectionButton') }),
    ).toBeEnabled()
  })

  // ── a11y ───────────────────────────────────────────────────────────
  it('has no a11y violations (toolbar only)', async () => {
    const { container } = renderToolbar()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
