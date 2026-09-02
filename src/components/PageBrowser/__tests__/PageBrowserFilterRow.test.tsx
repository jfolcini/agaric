/**
 * Phase 3 — PageBrowserFilterRow tests.
 *
 * The Radix Popover (inside the nested AddFilterPopover) is mocked to
 * render inline so the Add-Filter affordance is always present.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  ALL_PROPERTY_OPS,
  PROPERTY_OP_ARITY,
  type PropertyOpKind,
} from '@/components/PageBrowser/add-filter/vocab'
import {
  MAX_PAGE_FILTERS,
  PageBrowserFilterRow,
  type PageFilterWithKey,
  pageFilterChipTitle,
  pageFilterSummary,
} from '@/components/PageBrowser/PageBrowserFilterRow'
import type { PropertyPredicate } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import type { FilterPrimitive } from '@/lib/tauri'

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
    ['Priority', { type: 'Priority', values: ['A'], is_null: false, exclude: false }, 'priority A'],
    ['Space', { type: 'Space', space_id: 's-1' }, 'this space'],
    // PathGlob — both exclude values (D24 ships the path-exclude toggle, so the
    // Pages popover emits exclude=true too).
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
    // HasProperty — every predicate arm, incl. the `=`/`≠` glyph distinction
    // and a Ref-valued Eq (the summary renders Ref values too, even though the
    // Pages UI only emits Text — D26).
    [
      'HasProperty Exists',
      { type: 'HasProperty', key: 'status', predicate: { type: 'Exists' } },
      'has: status',
    ],
    [
      'HasProperty NotExists',
      { type: 'HasProperty', key: 'status', predicate: { type: 'NotExists' } },
      'no: status',
    ],
    [
      'HasProperty Eq (Text)',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'done' } },
      },
      'status = done',
    ],
    [
      'HasProperty Eq (Ref)',
      {
        type: 'HasProperty',
        key: 'space',
        predicate: { type: 'Eq', value: { type: 'Ref', value: 'SPACE_1' } },
      },
      'space = SPACE_1',
    ],
    [
      'HasProperty Ne (Text)',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Ne', value: { type: 'Text', value: 'done' } },
      },
      'status ≠ done',
    ],
    // #4553 Phase 1 (review) — the six operators the advanced surface made
    // emittable. These all used to fall into the renderer's `default` arm and
    // render as `=`, so `estimate > 3` and `estimate < 3` were byte-identical
    // chips. One row per operator, with the glyph/word spelled out, so a
    // TRANSPOSED mapping (`>` where `<` belongs) fails too — distinctness
    // alone would not catch that.
    [
      'HasProperty Lt (Num)',
      {
        type: 'HasProperty',
        key: 'estimate',
        predicate: { type: 'Lt', value: { type: 'Num', value: 3 } },
      },
      'estimate < 3',
    ],
    [
      'HasProperty Lte (Num)',
      {
        type: 'HasProperty',
        key: 'estimate',
        predicate: { type: 'Lte', value: { type: 'Num', value: 3 } },
      },
      'estimate ≤ 3',
    ],
    [
      'HasProperty Gt (Num)',
      {
        type: 'HasProperty',
        key: 'estimate',
        predicate: { type: 'Gt', value: { type: 'Num', value: 3 } },
      },
      'estimate > 3',
    ],
    [
      'HasProperty Gte (Num)',
      {
        type: 'HasProperty',
        key: 'estimate',
        predicate: { type: 'Gte', value: { type: 'Num', value: 3 } },
      },
      'estimate ≥ 3',
    ],
    [
      'HasProperty Lte (Date)',
      {
        type: 'HasProperty',
        key: 'deadline',
        predicate: { type: 'Lte', value: { type: 'Date', value: '2026-03-01' } },
      },
      'deadline ≤ 2026-03-01',
    ],
    [
      'HasProperty Contains (Text)',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'Contains', value: { type: 'Text', value: 'ship' } },
      },
      'status contains ship',
    ],
    [
      'HasProperty StartsWith (Text)',
      {
        type: 'HasProperty',
        key: 'status',
        predicate: { type: 'StartsWith', value: { type: 'Text', value: 'ship' } },
      },
      'status starts with ship',
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
    // #1280 D2 — advanced facet summaries.
    [
      'State values',
      { type: 'State', values: ['TODO', 'DOING'], is_null: false, exclude: false },
      'state: TODO, DOING',
    ],
    [
      'State exclude + none',
      { type: 'State', values: ['DONE'], is_null: true, exclude: true },
      'state not: DONE, none',
    ],
    [
      'BlockType values',
      { type: 'BlockType', values: ['content', 'page'], exclude: false },
      'type: content, page',
    ],
    ['BlockType exclude', { type: 'BlockType', values: ['tag'], exclude: true }, 'type not: tag'],
    [
      'DueDate OnOrBefore',
      { type: 'DueDate', predicate: { type: 'OnOrBefore', date: '2026-04-01' } },
      'due ≤ 2026-04-01',
    ],
    ['DueDate IsNull', { type: 'DueDate', predicate: { type: 'IsNull' } }, 'due unset'],
    [
      'Scheduled Between',
      { type: 'Scheduled', predicate: { type: 'Between', from: '2026-01-01', to: '2026-03-31' } },
      'scheduled 2026-01-01…2026-03-31',
    ],
    [
      'Created after only',
      { type: 'Created', after: '2026-01-01', before: null },
      'created after 2026-01-01',
    ],
    [
      'Created both bounds',
      { type: 'Created', after: '2026-01-01', before: '2026-06-01' },
      'created 2026-01-01…2026-06-01',
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

  // #4553 review, note 1 — a `Ref`-valued property operand is a page ULID, the
  // same kind of id the relational `LinksTo`/`LinkedFrom` chips already resolve.
  // `PropertyRefValueInput` emits the picked page's id, so without the resolver
  // the chip for "owner is Roadmap" reads `owner = 01ARZ…`.
  it('resolves a Ref-valued property operand through refResolver (4th arg)', () => {
    const filter: FilterPrimitive = {
      type: 'HasProperty',
      key: 'owner',
      predicate: { type: 'Eq', value: { type: 'Ref', value: 'PAGE_A' } },
    }
    const refResolver = (id: string): string => (id === 'PAGE_A' ? 'Roadmap' : id)
    expect(pageFilterSummary(filter, t, undefined, refResolver)).toBe('owner = Roadmap')
    // The resolver is the REF one, not the tag one: passing only a tagResolver
    // must not reach the property operand.
    expect(pageFilterSummary(filter, t, () => 'WRONG')).toBe('owner = PAGE_A')
  })

  // A Text operand that happens to look like an id is NOT a Ref and must not be
  // resolved — the variant, not the shape, decides.
  it('leaves a Text-valued property operand unresolved', () => {
    const filter: FilterPrimitive = {
      type: 'HasProperty',
      key: 'owner',
      predicate: { type: 'Eq', value: { type: 'Text', value: 'PAGE_A' } },
    }
    expect(pageFilterSummary(filter, t, undefined, () => 'Roadmap')).toBe('owner = PAGE_A')
  })
})

/**
 * #4553 review — the BLOCKING finding's class guard.
 *
 * `vocab.test.ts` pins the operator TABLE (`ALL_PROPERTY_OPS` is exhaustive
 * over the bindings union, arity is classified for every member). Nothing
 * pinned the operator RENDERER, which is how six operators shipped rendering
 * as `=`: the table grew, the chip's `predicate.type === 'Ne' ? '≠' : '='`
 * ternary did not, and every suite stayed green.
 *
 * This walks the TABLE and renders each operator through the production
 * summary function, so it is not a snapshot of today's eight — a ninth
 * operator added to `ALL_PROPERTY_OPS` is picked up automatically and must
 * earn its own distinct rendering to pass.
 */
describe('HasProperty chip renderer — exhaustive over ALL_PROPERTY_OPS', () => {
  /** A representative predicate for `op`, shaped by its DECLARED arity. */
  function predicateFor(op: PropertyOpKind): PropertyPredicate {
    return PROPERTY_OP_ARITY[op] === 'nullary'
      ? ({ type: op } as PropertyPredicate)
      : ({ type: op, value: { type: 'Text', value: 'ship' } } as PropertyPredicate)
  }

  it('renders every operator in the table, each distinctly', () => {
    const seen = new Map<string, PropertyOpKind>()
    for (const { value: op } of ALL_PROPERTY_OPS) {
      const label = pageFilterSummary(
        { type: 'HasProperty', key: 'status', predicate: predicateFor(op) },
        t,
      )
      // A collision means two different filters are indistinguishable in the
      // UI — exactly the shipped bug (`>` and `<` both rendering as `=`).
      expect(
        seen.get(label),
        `${op} renders as "${label}", which ${seen.get(label) ?? '—'} already claims`,
      ).toBeUndefined()
      // And it must actually SAY something: an unmapped operator that fell
      // through to an empty/undefined glyph would still be "distinct".
      expect(label).toContain('status')
      expect(label.trim()).not.toBe('status')
      expect(label).not.toContain('undefined')
      seen.set(label, op)
    }
    expect(seen.size).toBe(ALL_PROPERTY_OPS.length)
  })

  // The value-bearing ops must also SHOW the operand — a rendering that dropped
  // the value would still be distinct from its siblings via the glyph.
  it('every value-bearing operator renders its operand', () => {
    for (const { value: op } of ALL_PROPERTY_OPS) {
      if (PROPERTY_OP_ARITY[op] === 'nullary') continue
      const label = pageFilterSummary(
        { type: 'HasProperty', key: 'status', predicate: predicateFor(op) },
        t,
      )
      expect(label, `${op} dropped its operand`).toContain('ship')
    }
  })
})

describe('pageFilterChipTitle', () => {
  // D24: the boolean Pages facets carry a long-form description surfaced as the
  // chip's `title` tooltip; value-bearing facets have no extra title.
  it('returns the long-form description for the boolean Pages facets', () => {
    expect(pageFilterChipTitle({ type: 'Orphan' }, t)).toBe(
      'Fully isolated — no inbound links and no outbound links.',
    )
    expect(pageFilterChipTitle({ type: 'Stub' }, t)).toBe('A titled page with no content blocks.')
    expect(pageFilterChipTitle({ type: 'HasNoInboundLinks' }, t)).toBe(
      'Nothing links to this page (it may still link out).',
    )
  })

  it('returns undefined for value-bearing facets (label self-describes)', () => {
    expect(pageFilterChipTitle({ type: 'Tag', tag: 'urgent' }, t)).toBeUndefined()
    expect(
      pageFilterChipTitle({ type: 'PathGlob', pattern: 'x', exclude: false }, t),
    ).toBeUndefined()
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

  // D24: the boolean Pages facets surface their description as the chip title.
  it('sets the per-facet description as the chip title tooltip', () => {
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Filter: Orphan' })).toHaveAttribute(
      'title',
      'Fully isolated — no inbound links and no outbound links.',
    )
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

  // --- D12: clear-all control ---
  it('renders the clear-all control when filters are present and onClearAll is given', () => {
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument()
  })

  it('omits the clear-all control when no filters are active', () => {
    render(
      <PageBrowserFilterRow
        filters={[]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument()
  })

  it('omits the clear-all control when onClearAll is not supplied', () => {
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument()
  })

  it('calls onClearAll when the clear-all control is clicked', async () => {
    const onClearAll = vi.fn<() => void>()
    render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Orphan' }), withKey({ type: 'Stub' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
        onClearAll={onClearAll}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Clear all filters' }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PageBrowserFilterRow
        filters={[withKey({ type: 'Tag', tag: 'urgent' })]}
        onAddFilter={vi.fn()}
        onRemoveFilter={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
