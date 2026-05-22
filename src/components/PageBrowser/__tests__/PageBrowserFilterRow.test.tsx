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
  }) => (asChild ? children : <button {...props}>{children}</button>),
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
  // One row per discriminated-union arm. A swapped i18n key or a flipped
  // `=`/`≠` glyph would otherwise ship silently (P1-G).
  const cases: ReadonlyArray<[string, FilterPrimitive, string]> = [
    ['Orphan', { type: 'Orphan' }, 'Orphan'],
    ['Stub', { type: 'Stub' }, 'Stub'],
    ['HasNoInboundLinks', { type: 'HasNoInboundLinks' }, 'No inbound links'],
    ['Tag', { type: 'Tag', tag: 'urgent' }, 'tag: urgent'],
    ['Priority', { type: 'Priority', priority: 'A' }, 'priority A'],
    ['Space', { type: 'Space', space_id: 's-1' }, 'this space'],
    // PathGlob — both exclude values (exclude=true is reserved for Search).
    [
      'PathGlob exclude=false',
      { type: 'PathGlob', pattern: 'Projects/*', exclude: false },
      'path: Projects/*',
    ],
    [
      'PathGlob exclude=true',
      { type: 'PathGlob', pattern: 'Projects/*', exclude: true },
      'not path: Projects/*',
    ],
    // HasProperty — every op, incl. the `=`/`≠` glyph distinction.
    [
      'HasProperty exists',
      { type: 'HasProperty', key: 'status', op: 'exists', value: null },
      'has: status',
    ],
    [
      'HasProperty notExists',
      { type: 'HasProperty', key: 'status', op: 'notExists', value: null },
      'no: status',
    ],
    [
      'HasProperty eq',
      { type: 'HasProperty', key: 'status', op: 'eq', value: { type: 'Text', value: 'done' } },
      'status = done',
    ],
    [
      'HasProperty ne',
      { type: 'HasProperty', key: 'status', op: 'ne', value: { type: 'Text', value: 'done' } },
      'status ≠ done',
    ],
    // LastEdited — Range, every Rolling bucket, OlderThan.
    [
      'LastEdited Range',
      { type: 'LastEdited', spec: { type: 'Range', start: '2026-01-01', end: '2026-02-01' } },
      'edited 2026-01-01…2026-02-01',
    ],
    [
      'LastEdited Rolling{1}',
      { type: 'LastEdited', spec: { type: 'Rolling', days: 1 } },
      'Edited today',
    ],
    [
      'LastEdited Rolling{7}',
      { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } },
      'Edited this week',
    ],
    [
      'LastEdited Rolling{30}',
      { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } },
      'Edited this month',
    ],
    [
      'LastEdited OlderThan{30}',
      { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } },
      'Edited long ago',
    ],
    // summaryUnknown default — a Search-only primitive that never reaches the
    // Pages surface (allow-list gated) but must still summarise safely.
    ['Search-only (Regex) → unknown', { type: 'Regex', pattern: 'foo' }, 'filter'],
  ]

  it.each(cases)('formats %s', (_name, filter, expected) => {
    expect(pageFilterSummary(filter, t)).toBe(expected)
  })

  it('formats a non-bucket OlderThan via the value-aware rolling fallback (P2-G)', () => {
    expect(
      pageFilterSummary({ type: 'LastEdited', spec: { type: 'OlderThan', days: 90 } }, t),
    ).toBe('edited ≤ 90d')
  })

  it('formats a non-bucket Rolling via the value-aware fallback', () => {
    expect(pageFilterSummary({ type: 'LastEdited', spec: { type: 'Rolling', days: 14 } }, t)).toBe(
      'edited ≤ 14d',
    )
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
