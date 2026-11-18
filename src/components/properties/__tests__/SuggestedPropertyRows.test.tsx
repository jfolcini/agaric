/**
 * #6755 — the empty rows a block's tags offer it: labelled with the tag they
 * come from, edited in the key's definition type (text when undeclared),
 * saving only a filled value, and hidden by their remove button. A key the
 * block shows a row for already is not offered.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SuggestedPropertyRows } from '@/components/properties/SuggestedPropertyRows'
import type { PropertyDefinition, SuggestedProperty } from '@/lib/bindings'
import { t } from '@/lib/i18n'

const SUGGESTIONS: SuggestedProperty[] = [
  { key: 'isbn', tag_id: 'TAG1', tag_name: 'book' },
  { key: 'pages', tag_id: 'TAG2', tag_name: 'book/novel' },
]
const DEFS: PropertyDefinition[] = [
  { key: 'pages', value_type: 'number', options: null, created_at: '', builtin: false },
]

const onSave = vi.fn()
const onWritten = vi.fn()

function renderRows(shownKeys: string[] = []) {
  return render(
    <SuggestedPropertyRows
      blockId="BLOCK"
      suggestions={SUGGESTIONS}
      definitions={DEFS}
      shownKeys={new Set(shownKeys)}
      onSave={onSave}
      onWritten={onWritten}
    />,
  )
}

function input(key: string): HTMLInputElement {
  return screen.getByLabelText(t('pageProperty.valueLabel', { key }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SuggestedPropertyRows', () => {
  it('labels each row with its tag and types it by its definition', () => {
    renderRows()
    expect(screen.getByText(t('property.suggestedFrom', { tag: 'book' }))).toBeInTheDocument()
    expect(screen.getByText(t('property.suggestedFrom', { tag: 'book/novel' }))).toBeInTheDocument()
    expect(input('isbn')).toHaveAttribute('type', 'text')
    expect(input('pages')).toHaveAttribute('type', 'number')
  })

  it('saves a filled row and nothing for one left empty', async () => {
    const user = userEvent.setup()
    renderRows()
    await user.click(input('pages'))
    await user.tab()
    expect(onSave).not.toHaveBeenCalled()
    await user.type(input('isbn'), '978')
    await user.tab()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('isbn', undefined, '978')
  })

  it('hides a row its remove button dismisses, and a key already shown', async () => {
    const user = userEvent.setup()
    renderRows(['pages'])
    expect(screen.queryByTestId('suggested-property-pages')).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: t('pageProperty.deletePropertyLabel', { key: 'isbn' }) }),
    )
    expect(screen.queryByTestId('suggested-property-isbn')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    const { container } = renderRows()
    expect(await axe(container)).toHaveNoViolations()
  })
})
