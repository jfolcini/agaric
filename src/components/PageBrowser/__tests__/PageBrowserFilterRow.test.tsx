/**
 * PEND-58 Phase 3 — PageBrowserFilterRow tests.
 *
 * The Radix Popover (inside the nested AddFilterPopover) is mocked to
 * render inline so the Add-Filter affordance is always present.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import type { FilterPrimitive } from '@/lib/tauri'
import {
  MAX_PAGE_FILTERS,
  PageBrowserFilterRow,
  type PageFilterWithKey,
  pageFilterSummary,
} from '../PageBrowserFilterRow'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-root">{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    [key: string]: unknown
  }) => (asChild ? <>{children}</> : <button {...props}>{children}</button>),
  PopoverContent: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <div data-testid="popover-content" {...props}>
      {children}
    </div>
  ),
}))

let nextId = 0
function withKey(f: FilterPrimitive): PageFilterWithKey {
  return { ...f, _addId: ++nextId }
}

describe('pageFilterSummary', () => {
  it('formats each Pages primitive', () => {
    expect(pageFilterSummary({ type: 'Orphan' }, t)).toBe('Orphan')
    expect(pageFilterSummary({ type: 'Stub' }, t)).toBe('Stub')
    expect(pageFilterSummary({ type: 'HasNoInboundLinks' }, t)).toBe('No inbound links')
    expect(pageFilterSummary({ type: 'Tag', tag: 'urgent' }, t)).toBe('tag: urgent')
    expect(pageFilterSummary({ type: 'Priority', priority: 'A' }, t)).toBe('priority A')
    expect(pageFilterSummary({ type: 'LastEdited', spec: { type: 'Rolling', days: 7 } }, t)).toBe(
      'Edited this week',
    )
    expect(
      pageFilterSummary({ type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } }, t),
    ).toBe('Edited long ago')
  })

  it('resolves tag ids through the resolver when provided', () => {
    const summary = pageFilterSummary({ type: 'Tag', tag: 'tag-1' }, t, (id) =>
      id === 'tag-1' ? 'Work' : id,
    )
    expect(summary).toBe('tag: Work')
  })
})

describe('PageBrowserFilterRow', () => {
  it('renders a chip per active filter', () => {
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' }), withKey({ type: 'Stub' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
      />,
    )
    // Scope to the FilterPill group labels — the popover menu also has
    // "Orphan" / "Stub" items, so a bare getByText would be ambiguous.
    expect(screen.getByRole('group', { name: 'Filter: Orphan' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()
  })

  it('fires onRemoveFilter with the chip index', async () => {
    const onRemoveFilter = vi.fn<(i: number) => void>()
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' }), withKey({ type: 'Stub' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={onRemoveFilter}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Stub' }))
    expect(onRemoveFilter).toHaveBeenCalledWith(1)
  })

  it('fires onAddFilter when a primitive is chosen', async () => {
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<PageBrowserFilterRow filters={[]} onAddFilter={onAddFilter} onRemoveFilter={vi.fn()} />)
    await userEvent.click(screen.getByText('Stub'))
    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Stub' })
  })

  it('shows only the Add-Filter affordance when no filters are active', () => {
    render(<PageBrowserFilterRow filters={[]} onAddFilter={vi.fn()} onRemoveFilter={vi.fn()} />)
    expect(screen.queryByLabelText('Active filters')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeInTheDocument()
  })

  it('surfaces the many-filters warning at the soft cap', () => {
    const filters = Array.from({ length: MAX_PAGE_FILTERS }, () => withKey({ type: 'Orphan' }))
    render(
      <PageBrowserFilterRow filters={filters} onAddFilter={vi.fn()} onRemoveFilter={vi.fn()} />,
    )
    expect(screen.getByText('Many filters can slow the view.')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Tag', tag: 'urgent' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
