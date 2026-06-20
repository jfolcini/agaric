/**
 * Issue #1647 follow-up — the search "State" builder form and the backlink
 * "Status" category form MUST share ONE canonical task-state vocabulary so
 * the two surfaces can never re-diverge.
 *
 * This test renders both forms and asserts:
 *  - each offers exactly the canonical `STATE_FILTER_VALUES` value set, and
 *  - the two surfaces offer the SAME value set (a future edit that changes
 *    one without the other — or a re-introduced shortlist — fails here).
 *
 * `@/components/ui/select` is globally mocked as a native `<select>` (see
 * `src/test-setup.ts`), so options surface as `<option>` elements.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusFilterForm } from '@/components/backlink-filter/categories/StatusFilterForm'
import { StateFilterForm } from '@/components/search/filter-forms/StateFilterForm'
import { t } from '@/lib/i18n'

import { STATE_FILTER_VALUES } from '../forms/stateVocabulary'

function optionValuesOf(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
}

describe('state/status vocabulary is a single shared source', () => {
  it('search State and backlink Status offer the identical canonical set', () => {
    const search = render(<StateFilterForm onAddFilter={() => {}} onBack={() => {}} />)
    const searchSelect = search.getByLabelText(t('search.filterHelper.stateValueLabel'))
    const searchValues = optionValuesOf(searchSelect)
    search.unmount()

    const backlink = render(<StatusFilterForm />)
    const statusSelect = screen.getByLabelText(t('backlink.statusValueLabel'))
    const statusValues = optionValuesOf(statusSelect)
    backlink.unmount()

    // Both pinned to the one canonical source...
    expect(searchValues).toEqual([...STATE_FILTER_VALUES])
    expect(statusValues).toEqual([...STATE_FILTER_VALUES])
    // ...and therefore identical to each other (drift-guard).
    expect(statusValues).toEqual(searchValues)
  })
})
