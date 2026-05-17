/**
 * PEND-54 — tests for the chip-row projection of the parsed AST.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FilterToken } from '@/lib/search-query'
import { FilterChipRow } from '../FilterChipRow'

describe('FilterChipRow', () => {
  it('renders nothing when there are no filters and no trailing slot', () => {
    const { container } = render(
      <FilterChipRow filters={[]} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a chip per filter token', () => {
    const filters: FilterToken[] = [
      { kind: 'tag', value: 'urgent', span: [0, 11] },
      { kind: 'pathInclude', value: 'Journal/*', span: [12, 26] },
    ]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    expect(screen.getByText('tag:#urgent')).toBeInTheDocument()
    expect(screen.getByText('path:Journal/*')).toBeInTheDocument()
  })

  it('calls onRemove(index) when × is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const filters: FilterToken[] = [
      { kind: 'tag', value: 'a', span: [0, 5] },
      { kind: 'tag', value: 'b', span: [6, 11] },
    ]
    render(<FilterChipRow filters={filters} onRemove={onRemove} onClearAll={vi.fn()} />)
    const removeButtons = screen.getAllByRole('button', { name: /Remove filter/ })
    const second = removeButtons[1]
    expect(second).toBeDefined()
    if (!second) throw new Error('expected second remove button')
    await user.click(second)
    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('shows Clear all when filters are present', async () => {
    const user = userEvent.setup()
    const onClearAll = vi.fn()
    const filters: FilterToken[] = [{ kind: 'tag', value: 'a', span: [0, 5] }]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={onClearAll} />)
    await user.click(screen.getByText('Clear all'))
    expect(onClearAll).toHaveBeenCalled()
  })

  it('marks invalid tokens with a styled chip and the typed error tooltip', () => {
    const filters: FilterToken[] = [
      {
        kind: 'invalid',
        source: 'path:[unclosed',
        error: 'InvalidGlob: unbalanced bracket',
        span: [0, 14],
      },
    ]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    const pill = screen.getByText('path:[unclosed').closest('[data-slot="filter-pill"]')
    expect(pill).toHaveAttribute('title', 'InvalidGlob: unbalanced bracket')
  })
})
