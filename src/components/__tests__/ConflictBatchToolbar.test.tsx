/**
 * Tests for ConflictBatchToolbar component.
 *
 * Validates:
 *  - Renders selection count
 *  - Select all / Deselect all toggle
 *  - Keep all button callback
 *  - Discard all button callback
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ConflictBatchToolbar } from '../ConflictBatchToolbar'

describe('ConflictBatchToolbar', () => {
  const defaultProps = {
    selectedCount: 2,
    totalCount: 5,
    onToggleSelectAll: vi.fn(),
    onKeepAll: vi.fn(),
    onDiscardAll: vi.fn(),
  }

  it('renders selection count', () => {
    render(<ConflictBatchToolbar {...defaultProps} />)

    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('renders different selection count', () => {
    render(<ConflictBatchToolbar {...defaultProps} selectedCount={1} />)

    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('shows "Select all" when not all are selected', () => {
    render(<ConflictBatchToolbar {...defaultProps} selectedCount={2} totalCount={5} />)

    expect(screen.getByRole('button', { name: /Select all/i })).toBeInTheDocument()
  })

  it('shows "Deselect all" when all are selected', () => {
    render(<ConflictBatchToolbar {...defaultProps} selectedCount={5} totalCount={5} />)

    expect(screen.getByRole('button', { name: /Deselect all/i })).toBeInTheDocument()
  })

  it('calls onToggleSelectAll when select all button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleSelectAll = vi.fn()

    render(<ConflictBatchToolbar {...defaultProps} onToggleSelectAll={onToggleSelectAll} />)

    const selectAllBtn = screen.getByRole('button', { name: /Select all/i })
    await user.click(selectAllBtn)

    expect(onToggleSelectAll).toHaveBeenCalledTimes(1)
  })

  it('calls onToggleSelectAll when deselect all button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleSelectAll = vi.fn()

    render(
      <ConflictBatchToolbar
        {...defaultProps}
        selectedCount={5}
        totalCount={5}
        onToggleSelectAll={onToggleSelectAll}
      />,
    )

    const deselectAllBtn = screen.getByRole('button', { name: /Deselect all/i })
    await user.click(deselectAllBtn)

    expect(onToggleSelectAll).toHaveBeenCalledTimes(1)
  })

  it('renders Keep all button', () => {
    render(<ConflictBatchToolbar {...defaultProps} />)

    expect(screen.getByRole('button', { name: /Keep all/i })).toBeInTheDocument()
  })

  it('renders Discard all button', () => {
    render(<ConflictBatchToolbar {...defaultProps} />)

    expect(screen.getByRole('button', { name: /Discard all/i })).toBeInTheDocument()
  })

  it('calls onKeepAll when Keep all button is clicked', async () => {
    const user = userEvent.setup()
    const onKeepAll = vi.fn()

    render(<ConflictBatchToolbar {...defaultProps} onKeepAll={onKeepAll} />)

    const keepAllBtn = screen.getByRole('button', { name: /Keep all/i })
    await user.click(keepAllBtn)

    expect(onKeepAll).toHaveBeenCalledTimes(1)
  })

  it('calls onDiscardAll when Discard all button is clicked', async () => {
    const user = userEvent.setup()
    const onDiscardAll = vi.fn()

    render(<ConflictBatchToolbar {...defaultProps} onDiscardAll={onDiscardAll} />)

    const discardAllBtn = screen.getByRole('button', { name: /Discard all/i })
    await user.click(discardAllBtn)

    expect(onDiscardAll).toHaveBeenCalledTimes(1)
  })

  it('has the conflict-batch-toolbar class', () => {
    const { container } = render(<ConflictBatchToolbar {...defaultProps} />)

    expect(container.querySelector('.conflict-batch-toolbar')).toBeTruthy()
  })

  describe('a11y', () => {
    it('has no a11y violations', async () => {
      const { container } = render(<ConflictBatchToolbar {...defaultProps} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('has no a11y violations when all selected', async () => {
      const { container } = render(
        <ConflictBatchToolbar {...defaultProps} selectedCount={5} totalCount={5} />,
      )

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
