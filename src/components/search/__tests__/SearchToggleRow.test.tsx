/**
 * Tests for `<SearchToggleRow>`, the match-mode toggles of Search and of find in page.
 *
 * Coverage:
 * - A named group (a `fieldset`; find in page nests it in its toolbar).
 * - Each toggle is an icon button whose full label is its accessible name and
 *   its tooltip (hover, or a press-and-hold on touch).
 * - `aria-pressed` reflects the controlled state and flips on click.
 * - axe finds no violations.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SearchToggleRow, type SearchToggleState } from '@/components/search/SearchToggleRow'

const OFF: SearchToggleState = { caseSensitive: false, wholeWord: false, isRegex: false }

describe('SearchToggleRow', () => {
  it('groups the toggles under the localised label', () => {
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const group = screen.getByRole('group', { name: /Search modes/i })
    expect(group).toBeInTheDocument()
  })

  it('renders three toggles in VS Code order: Aa / Ab| / .*', () => {
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/Case-sensitive/))
    expect(buttons[1]).toHaveAttribute('aria-label', expect.stringMatching(/Whole word/))
    expect(buttons[2]).toHaveAttribute('aria-label', expect.stringMatching(/Regex/))
  })

  // #7040 S12 — the name shows on hover, and on touch with a press-and-hold (`IconButton`).
  it.each([
    ['search-toggle-case-sensitive', 'Case-sensitive'],
    ['search-toggle-whole-word', 'Whole word'],
    ['search-toggle-regex', 'Regex'],
  ])('%s names itself in a tooltip', async (testId, name) => {
    const user = userEvent.setup()
    render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const button = screen.getByTestId(testId)
    expect(button).toHaveAttribute('data-slot', 'icon-button')
    await user.hover(button)
    expect((await screen.findAllByRole('tooltip'))[0]).toHaveTextContent(name)
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

  it('has no axe violations', async () => {
    const { container } = render(<SearchToggleRow toggles={OFF} onChange={vi.fn()} />)
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })
})
