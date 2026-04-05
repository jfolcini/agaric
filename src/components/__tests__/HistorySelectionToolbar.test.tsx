/**
 * Tests for HistorySelectionToolbar component.
 *
 * Validates:
 *  - Renders selection count badge
 *  - Shows "Revert selected" button
 *  - Shows "Clear selection" button
 *  - Shows keyboard hint text
 *  - Revert button calls onRevertClick
 *  - Clear button calls onClearSelection
 *  - Buttons disabled when reverting
 *  - Shows "Reverting..." text when reverting
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistorySelectionToolbar } from '../HistorySelectionToolbar'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistorySelectionToolbar', () => {
  it('renders selection count badge', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={3}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  it('renders "Revert selected" button', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Revert selected/ })).toBeInTheDocument()
  })

  it('renders "Clear selection" button', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Clear selection/ })).toBeInTheDocument()
  })

  it('renders keyboard hint', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByText('Space to toggle, Enter to revert')).toBeInTheDocument()
  })

  it('calls onRevertClick when Revert button is clicked', async () => {
    const user = userEvent.setup()
    const onRevertClick = vi.fn()
    render(
      <HistorySelectionToolbar
        selectedCount={2}
        reverting={false}
        onRevertClick={onRevertClick}
        onClearSelection={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Revert selected/ }))
    expect(onRevertClick).toHaveBeenCalledTimes(1)
  })

  it('calls onClearSelection when Clear button is clicked', async () => {
    const user = userEvent.setup()
    const onClearSelection = vi.fn()
    render(
      <HistorySelectionToolbar
        selectedCount={2}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Clear selection/ }))
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('disables buttons when reverting', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={true}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Reverting/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Clear selection/ })).toBeDisabled()
  })

  it('shows "Reverting..." text when reverting', () => {
    render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={true}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByText(/Reverting/)).toBeInTheDocument()
  })

  it('updates selection count when prop changes', () => {
    const { rerender } = render(
      <HistorySelectionToolbar
        selectedCount={1}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByText('1 selected')).toBeInTheDocument()

    rerender(
      <HistorySelectionToolbar
        selectedCount={5}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    expect(screen.getByText('5 selected')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <HistorySelectionToolbar
        selectedCount={2}
        reverting={false}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when reverting', async () => {
    const { container } = render(
      <HistorySelectionToolbar
        selectedCount={2}
        reverting={true}
        onRevertClick={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
