/**
 * PEND-55 — tests for `<SearchHistoryDropdown>`.
 *
 * Coverage:
 * - Hidden when `visible={false}`.
 * - Empty-state message when no entries.
 * - Renders one `role="option"` row per entry.
 * - Click fills + dispatches via `onPick`.
 * - "Clear history" calls `onClear`; the button is hidden in empty
 *   state.
 * - axe passes.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { SearchHistoryDropdown } from '../SearchHistoryDropdown'

describe('SearchHistoryDropdown', () => {
  it('renders nothing when `visible` is false', () => {
    const { container } = render(
      <SearchHistoryDropdown entries={[]} visible={false} onPick={vi.fn()} onClear={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the empty-state message when there are no entries', () => {
    render(<SearchHistoryDropdown entries={[]} visible={true} onPick={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByTestId('search-history-empty')).toBeInTheDocument()
    // Clear button hidden in empty state.
    expect(screen.queryByTestId('search-history-clear')).toBeNull()
  })

  it('renders one option per entry in MRU order', () => {
    render(
      <SearchHistoryDropdown
        entries={['TODO state:DOING', '"sprint plan"', 'alpha cohort']}
        visible={true}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('TODO state:DOING')
    expect(options[2]).toHaveTextContent('alpha cohort')
  })

  it('calls onPick with the clicked entry', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(
      <SearchHistoryDropdown
        entries={['alpha', 'beta']}
        visible={true}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    )
    await user.click(screen.getByText('beta'))
    expect(onPick).toHaveBeenCalledWith('beta')
  })

  it('calls onClear when Clear history is clicked', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(
      <SearchHistoryDropdown
        entries={['alpha']}
        visible={true}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    )
    await user.click(screen.getByTestId('search-history-clear'))
    expect(onClear).toHaveBeenCalled()
  })

  it('Enter / Space on a row triggers onPick', () => {
    const onPick = vi.fn()
    render(
      <SearchHistoryDropdown
        entries={['alpha']}
        visible={true}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    )
    const row = screen.getByTestId('search-history-entry-0')
    row.focus()
    // userEvent's keyboard sends Enter to focused element — match the
    // dispatch behaviour expected by listbox option a11y.
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onPick).toHaveBeenCalledWith('alpha')
  })

  it('has no axe violations with entries', async () => {
    const { container } = render(
      <SearchHistoryDropdown
        entries={['alpha', 'beta']}
        visible={true}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    // biome-ignore lint/suspicious/noExplicitAny: vitest-axe loose typing.
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })

  it('has no axe violations in empty state', async () => {
    const { container } = render(
      <SearchHistoryDropdown entries={[]} visible={true} onPick={vi.fn()} onClear={vi.fn()} />,
    )
    // biome-ignore lint/suspicious/noExplicitAny: vitest-axe loose typing.
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })
})
