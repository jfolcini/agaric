/**
 * Tests for SearchDateFilterForm — focus on the #2275 op-mode ISO validation.
 *
 * The comparison ("op") shape must apply the SAME calendar-aware YYYY-MM-DD
 * check the parser uses before it can emit a `due:`/`scheduled:` token. Gating
 * only on non-empty let a malformed date (e.g. a `type=date` input degraded to
 * a text field, or a programmatically-set value) produce a filter the parser
 * would reject as invalid.
 *
 * The form opens directly into comparison mode via `initialShape` — the shape
 * `<Select>` is controlled, which jsdom's Radix implementation cannot drive.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SearchDateFilterForm } from '@/components/search/filter-forms/SearchDateFilterForm'

describe('SearchDateFilterForm — op-mode ISO validation (#2275)', () => {
  it('keeps Add disabled, shows an error, and emits nothing for an invalid date', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn()
    render(
      <SearchDateFilterForm
        kind="due"
        onAddFilter={onAddFilter}
        onBack={() => {}}
        initialShape="op"
      />,
    )

    const dateInput = screen.getByLabelText('Date')
    // Reproduce the item's premise: a `type=date` control that degrades to a
    // plain text field (WebKitGTK/WKWebView) accepts an arbitrary string a
    // native date picker would never yield. Feb 30 is well-formed but not a
    // real calendar day — the parser rejects it.
    dateInput.setAttribute('type', 'text')
    await user.clear(dateInput)
    await user.type(dateInput, '2026-02-30')

    const addButton = screen.getByRole('button', { name: 'Add' })
    expect(addButton).toBeDisabled()
    expect(screen.getByTestId('date-filter-error')).toBeInTheDocument()

    // Even forcing a submit must not emit an invalid token.
    await user.click(addButton)
    expect(onAddFilter).not.toHaveBeenCalled()
  })

  it('enables Add and emits an op token for a valid ISO date', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn()
    render(
      <SearchDateFilterForm
        kind="scheduled"
        onAddFilter={onAddFilter}
        onBack={() => {}}
        initialShape="op"
      />,
    )

    const dateInput = screen.getByLabelText('Date')
    await user.clear(dateInput)
    await user.type(dateInput, '2026-03-15')

    const addButton = screen.getByRole('button', { name: 'Add' })
    await waitFor(() => expect(addButton).toBeEnabled())
    expect(screen.queryByTestId('date-filter-error')).not.toBeInTheDocument()

    await user.click(addButton)
    expect(onAddFilter).toHaveBeenCalledTimes(1)
    const token = onAddFilter.mock.calls[0]?.[0]
    expect(token).toMatchObject({
      kind: 'scheduled',
      value: { kind: 'op', op: '=', date: '2026-03-15' },
    })
  })
})
