/**
 * PEND-55 — tests for `<SearchToggleRow>`.
 *
 * Coverage:
 * - `role="toolbar"` on the container.
 * - Each toggle exposes its full label as `aria-label` (accessible name).
 * - Each toggle shows its always-visible abbreviation (#154 UX-A8 —
 *   touch-safe, no tooltip reliance).
 * - `aria-pressed` reflects the controlled state and flips on click.
 * - All three toggles render distinct SVG icons (regression guard
 *   against a swap).
 * - axe finds no violations.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SearchToggleRow, type SearchToggleState } from '../SearchToggleRow'

const OFF: SearchToggleState = { caseSensitive: false, wholeWord: false, isRegex: false }

describe('SearchToggleRow', () => {
  it('exposes a toolbar landmark with the localised label', () => {
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const toolbar = screen.getByRole('toolbar', { name: /Search modes/i })
    expect(toolbar).toBeInTheDocument()
  })

  it('renders three toggles in VS Code order: Aa / Ab| / .*', () => {
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/Case-sensitive/))
    expect(buttons[1]).toHaveAttribute('aria-label', expect.stringMatching(/Whole word/))
    expect(buttons[2]).toHaveAttribute('aria-label', expect.stringMatching(/Regex/))
  })

  it('shows an always-visible abbreviation on each toggle (#154 UX-A8)', () => {
    // The abbreviation text is what makes the mode legible on touch,
    // where the old hover tooltip never fired. It is decorative
    // (aria-hidden) since the button already carries the full aria-label.
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    expect(screen.getByTestId('search-toggle-case-sensitive-abbr')).toHaveTextContent('Aa')
    expect(screen.getByTestId('search-toggle-whole-word-abbr')).toHaveTextContent('Ab|')
    expect(screen.getByTestId('search-toggle-regex-abbr')).toHaveTextContent('.*')
    for (const testId of [
      'search-toggle-case-sensitive-abbr',
      'search-toggle-whole-word-abbr',
      'search-toggle-regex-abbr',
    ]) {
      expect(screen.getByTestId(testId)).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('reflects controlled state via aria-pressed', () => {
    render(
      <SearchToggleRow
        toggles={{ caseSensitive: true, wholeWord: false, isRegex: true }}
        onChange={vi.fn()}
      />,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'false')
    expect(buttons[2]).toHaveAttribute('aria-pressed', 'true')
  })

  it('emits the next state object on click', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SearchToggleRow toggles={OFF} onChange={onChange} />)
    await user.click(screen.getByTestId('search-toggle-case-sensitive'))
    expect(onChange).toHaveBeenCalledWith({
      caseSensitive: true,
      wholeWord: false,
      isRegex: false,
    })
  })

  it('toggling each button preserves the other two', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SearchToggleRow
        toggles={{ caseSensitive: true, wholeWord: false, isRegex: true }}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByTestId('search-toggle-whole-word'))
    expect(onChange).toHaveBeenLastCalledWith({
      caseSensitive: true,
      wholeWord: true,
      isRegex: true,
    })
  })

  it('disables every button when `disabled` is set', () => {
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} disabled />)
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toBeDisabled()
    }
  })

  it('renders a non-colour active indicator only on pressed toggles (UX-15)', () => {
    render(
      <SearchToggleRow
        toggles={{ caseSensitive: true, wholeWord: false, isRegex: false }}
        onChange={vi.fn()}
      />,
    )
    // The pressed toggle gets a shape-only dot; the others do not.
    expect(screen.getByTestId('search-toggle-case-sensitive-active-dot')).toBeInTheDocument()
    expect(screen.queryByTestId('search-toggle-whole-word-active-dot')).toBeNull()
    expect(screen.queryByTestId('search-toggle-regex-active-dot')).toBeNull()
  })

  it('has no axe violations', async () => {
    const { container } = render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })
})
