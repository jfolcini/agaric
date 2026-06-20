/**
 * Tests for `<SearchHistoryDropdown>`.
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

import { SearchHistoryDropdown, type SearchHistoryDropdownProps } from '../SearchHistoryDropdown'

// Phase 3.U2 — props gained `listboxId` + `activeIndex` for the
// listbox/combobox a11y wiring. The helper supplies stable defaults so
// existing tests don't have to thread them on every call.
function renderDropdown(
  props: Partial<SearchHistoryDropdownProps> = {},
): ReturnType<typeof render> {
  const base: SearchHistoryDropdownProps = {
    entries: [],
    visible: true,
    onPick: vi.fn(),
    onClear: vi.fn(),
    onRemoveEntry: vi.fn(),
    historyEnabled: true,
    onToggleEnabled: vi.fn(),
    listboxId: 'lb',
    activeIndex: -1,
  }
  return render(<SearchHistoryDropdown {...base} {...props} />)
}

describe('SearchHistoryDropdown', () => {
  it('renders nothing when `visible` is false', () => {
    const { container } = renderDropdown({ visible: false })
    expect(container.firstChild).toBeNull()
  })

  it('shows the empty-state message when there are no entries', () => {
    renderDropdown({ entries: [] })
    expect(screen.getByTestId('search-history-empty')).toBeInTheDocument()
    // Clear button hidden in empty state.
    expect(screen.queryByTestId('search-history-clear')).toBeNull()
  })

  it('renders one option per entry in MRU order', () => {
    renderDropdown({ entries: ['TODO state:DOING', '"sprint plan"', 'alpha cohort'] })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('TODO state:DOING')
    expect(options[2]).toHaveTextContent('alpha cohort')
  })

  it('calls onPick with the clicked entry', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderDropdown({ entries: ['alpha', 'beta'], onPick })
    await user.click(screen.getByText('beta'))
    expect(onPick).toHaveBeenCalledWith('beta')
  })

  it('calls onClear when Clear history is clicked', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    renderDropdown({ entries: ['alpha'], onClear })
    await user.click(screen.getByTestId('search-history-clear'))
    expect(onClear).toHaveBeenCalled()
  })

  it('Enter / Space on a row triggers onPick', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderDropdown({ entries: ['alpha'], onPick })
    const row = screen.getByTestId('search-history-entry-0')
    row.focus()
    // userEvent's keyboard sends Enter to the focused element — match the
    // dispatch behaviour expected by listbox option a11y, consistent with
    // the other userEvent-based interaction tests in this file.
    await user.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith('alpha')
  })

  // Per-row delete + record-history toggle.
  it('per-row delete affordance calls onRemoveEntry without picking the row', async () => {
    const user = userEvent.setup()
    const onRemoveEntry = vi.fn()
    const onPick = vi.fn()
    renderDropdown({ entries: ['alpha', 'beta'], onRemoveEntry, onPick })
    await user.click(screen.getByTestId('search-history-remove-1'))
    expect(onRemoveEntry).toHaveBeenCalledWith('beta')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('footer toggle calls onToggleEnabled and labels by state', async () => {
    const user = userEvent.setup()
    const onToggleEnabled = vi.fn()
    const { rerender } = renderDropdown({
      entries: ['alpha'],
      historyEnabled: true,
      onToggleEnabled,
    })
    const toggle = screen.getByTestId('search-history-toggle')
    expect(toggle).toHaveTextContent(/Disable/i)
    await user.click(toggle)
    expect(onToggleEnabled).toHaveBeenCalled()

    rerender(
      <SearchHistoryDropdown
        entries={[]}
        visible
        onPick={vi.fn()}
        onClear={vi.fn()}
        onRemoveEntry={vi.fn()}
        historyEnabled={false}
        onToggleEnabled={vi.fn()}
        listboxId="lb"
        activeIndex={-1}
      />,
    )
    expect(screen.getByTestId('search-history-toggle')).toHaveTextContent(/Enable/i)
    expect(screen.getByTestId('search-history-disabled-notice')).toBeInTheDocument()
    // No empty-state message while disabled — the notice replaces it.
    expect(screen.queryByTestId('search-history-empty')).toBeNull()
  })

  it('has no axe violations when disabled with no entries', async () => {
    const { container } = renderDropdown({ entries: [], historyEnabled: false })
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })

  it('has no axe violations with entries', async () => {
    const { container } = renderDropdown({ entries: ['alpha', 'beta'] })
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })

  it('has no axe violations in empty state', async () => {
    const { container } = renderDropdown({ entries: [] })
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })

  // Phase 3.U2 — listbox a11y assertions
  it('listbox has the supplied id so the input can wire aria-controls', () => {
    renderDropdown({ entries: ['alpha'], listboxId: 'history-lb-42' })
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'history-lb-42')
  })

  it('row id is derived from listboxId + index so aria-activedescendant matches', () => {
    renderDropdown({ entries: ['alpha', 'beta'], listboxId: 'lb1' })
    expect(screen.getByTestId('search-history-entry-0')).toHaveAttribute('id', 'lb1-opt-0')
    expect(screen.getByTestId('search-history-entry-1')).toHaveAttribute('id', 'lb1-opt-1')
  })

  it('reflects activeIndex via aria-selected on the matching row', () => {
    renderDropdown({ entries: ['alpha', 'beta', 'gamma'], activeIndex: 1 })
    const rows = screen.getAllByRole('option')
    expect(rows[0]).toHaveAttribute('aria-selected', 'false')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    expect(rows[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('activeIndex=-1 means no row is selected', () => {
    renderDropdown({ entries: ['alpha', 'beta'], activeIndex: -1 })
    const rows = screen.getAllByRole('option')
    for (const row of rows) {
      expect(row).toHaveAttribute('aria-selected', 'false')
    }
  })

  // CR-A11Y (#151) — the listbox container hosts `aria-activedescendant`
  // pointing at the active row id, matching the VirtualizedResultListbox
  // convention. This is the load-bearing wiring that makes the roving
  // selection (and the keyboard per-row delete it enables) announce to AT.
  it('points aria-activedescendant at the active row id', () => {
    renderDropdown({ entries: ['alpha', 'beta', 'gamma'], listboxId: 'lbx', activeIndex: 1 })
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'lbx-opt-1')
  })

  it('omits aria-activedescendant when no row is active', () => {
    renderDropdown({ entries: ['alpha', 'beta'], listboxId: 'lbx', activeIndex: -1 })
    expect(screen.getByRole('listbox')).not.toHaveAttribute('aria-activedescendant')
  })

  // The per-row delete affordance already had a coarse-pointer 44px
  // target; the row body, Clear-history, and the enable/disable toggle did not.
  it('gives the rows and footer controls a coarse-pointer 44px target', () => {
    renderDropdown({ entries: ['alpha', 'beta'] })
    expect(screen.getByTestId('search-history-entry-0')).toHaveClass(
      '[@media(pointer:coarse)]:min-h-11',
    )
    expect(screen.getByTestId('search-history-clear')).toHaveClass(
      '[@media(pointer:coarse)]:min-h-11',
    )
    expect(screen.getByTestId('search-history-toggle')).toHaveClass(
      '[@media(pointer:coarse)]:min-h-11',
    )
  })
})
