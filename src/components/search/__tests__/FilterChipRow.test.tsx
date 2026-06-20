/**
 * Tests for the chip-row projection of the parsed AST.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

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

  it('labels a valid chip group via i18n, not a hardcoded string', () => {
    const filters: FilterToken[] = [{ kind: 'tag', value: 'urgent', span: [0, 11] }]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    // The translated `search.filterGroupLabel` resolves to "Filter: …".
    expect(screen.getByRole('group', { name: 'Filter: tag:#urgent' })).toBeInTheDocument()
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

  // New token kinds render via tokenSource(), no special branch.

  it('renders state / priority chips with the canonical label', () => {
    const filters: FilterToken[] = [
      { kind: 'state', value: 'TODO', span: [0, 10] },
      { kind: 'priority', value: '1', span: [11, 21] },
      { kind: 'notState', value: 'DONE', span: [22, 36] },
      { kind: 'notPriority', value: 'none', span: [37, 53] },
    ]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    expect(screen.getByText('state:TODO')).toBeInTheDocument()
    expect(screen.getByText('priority:1')).toBeInTheDocument()
    expect(screen.getByText('not-state:DONE')).toBeInTheDocument()
    expect(screen.getByText('not-priority:none')).toBeInTheDocument()
  })

  it('renders due / scheduled chips for both named and op forms', () => {
    const filters: FilterToken[] = [
      {
        kind: 'due',
        raw: 'today',
        value: { kind: 'named', name: 'today' },
        span: [0, 9],
      },
      {
        kind: 'scheduled',
        raw: '>=2026-01-01',
        value: { kind: 'op', op: '>=', date: '2026-01-01' },
        span: [10, 32],
      },
    ]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    expect(screen.getByText('due:today')).toBeInTheDocument()
    expect(screen.getByText('scheduled:>=2026-01-01')).toBeInTheDocument()
  })

  it('renders prop / not-prop chips with key=value', () => {
    const filters: FilterToken[] = [
      { kind: 'prop', key: 'status', value: 'done', span: [0, 17] },
      { kind: 'notProp', key: 'archived', value: 'true', span: [18, 41] },
    ]
    render(<FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />)
    expect(screen.getByText('prop:status=done')).toBeInTheDocument()
    expect(screen.getByText('not-prop:archived=true')).toBeInTheDocument()
  })

  it('renders duplicate filter tokens as separate chips without duplicate React keys (#756)', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Same kind + value twice — only due:/scheduled: duplicates are
      // invalidated by the parser, so this is a legal AST. Keys must
      // differ via span[0] or React logs the "same key" warning and
      // chip removal targets the wrong index after reconciliation.
      const filters: FilterToken[] = [
        { kind: 'tag', value: 'urgent', span: [0, 11] },
        { kind: 'tag', value: 'urgent', span: [12, 23] },
      ]
      render(<FilterChipRow filters={filters} onRemove={onRemove} onClearAll={vi.fn()} />)
      expect(screen.getAllByText('tag:#urgent')).toHaveLength(2)
      const dupKeyWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === 'string' && a.includes('same key')),
      )
      expect(dupKeyWarnings).toHaveLength(0)
      // Removing the second duplicate still reports its own index.
      const removeButtons = screen.getAllByRole('button', { name: /Remove filter/ })
      const second = removeButtons[1]
      expect(second).toBeDefined()
      if (!second) throw new Error('expected second remove button')
      await user.click(second)
      expect(onRemove).toHaveBeenCalledWith(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('duplicate chips pass an axe scan (#756)', async () => {
    const filters: FilterToken[] = [
      { kind: 'tag', value: 'urgent', span: [0, 11] },
      { kind: 'tag', value: 'urgent', span: [12, 23] },
    ]
    const { container } = render(
      <FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    )
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations', async () => {
    const filters: FilterToken[] = [
      { kind: 'tag', value: 'urgent', span: [0, 11] },
      {
        kind: 'invalid',
        source: 'path:[unclosed',
        error: 'InvalidGlob: unbalanced bracket',
        span: [12, 26],
      },
    ]
    const { container } = render(
      <FilterChipRow filters={filters} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    )
    const results = await axe(container as any)
    expect(results).toHaveNoViolations()
  })
})
