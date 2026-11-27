/**
 * FilterBar — the shared filter-bar layout (#7165 U3): chips on their own row,
 * then Add filter, Clear all and the view's trailing controls.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { FilterBar } from '@/components/filters/FilterBar'

function renderBar(hasChips: boolean) {
  return render(
    <FilterBar
      hasChips={hasChips}
      chips={<span>chip</span>}
      addFilter={<button type="button">Add filter</button>}
      clearAll={<button type="button">Clear all</button>}
      trailing={<span>trailing</span>}
    />,
  )
}

describe('FilterBar', () => {
  it('leaves out the chips row and Clear all without chips', () => {
    const { container } = renderBar(false)
    expect(container.querySelector('[data-slot="filter-bar-chips"]')).toBeNull()
    expect(screen.queryByText('chip')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeInTheDocument()
    expect(screen.getByText('trailing')).toBeInTheDocument()
  })

  it('puts the chips on a row above Add filter, then Clear all, then the trailing controls', () => {
    const { container } = renderBar(true)
    const chipsRow = container.querySelector('[data-slot="filter-bar-chips"]')
    const actionsRow = container.querySelector('[data-slot="filter-bar-actions"]')
    expect(chipsRow?.textContent).toBe('chip')
    expect(chipsRow?.nextElementSibling).toBe(actionsRow)
    expect([...(actionsRow?.children ?? [])].map((el) => el.textContent)).toEqual([
      'Add filter',
      'Clear all',
      'trailing',
    ])
  })

  it('has no a11y violations', async () => {
    const { container } = renderBar(true)
    expect(await axe(container)).toHaveNoViolations()
  })
})
