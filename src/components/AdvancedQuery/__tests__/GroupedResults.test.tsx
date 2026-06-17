/**
 * GroupedResults header-label resolution (#1447).
 *
 * The engine's `QueryGroup.key` is a RAW value: a ULID/block id for Tag/Page
 * dimensions, a display string for State/BlockType/Priority, and the literal
 * `"none"` for the NULL/absent bucket. These tests pin the display-only header
 * mapping the component applies on top of that raw key:
 *   - Tag / Page  → resolved title from `pageTitles` (the same `batchResolve`
 *                   map the member rows use), falling back to the raw id.
 *   - BlockType   → the `content`/`page`/`tag` enum code mapped to its label.
 *   - Priority    → the bare level `1`/`2`/`3` shown as the `P1`–`P3` badge.
 *   - State       → the engine key verbatim (the canonical app-wide token).
 *   - "none"      → the friendly "(none)" i18n string.
 *
 * The component is presentational (titles arrive via the `pageTitles` prop), so
 * these tests drive it directly. The IPC-driven resolution path — the hook
 * folding Tag/Page group keys into `batch_resolve` — is covered end-to-end in
 * `AdvancedQueryView.test.tsx`.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import type { ActiveBlockRow, GroupSpec, QueryGroup } from '@/lib/tauri'

import { GroupedResults } from '../GroupedResults'

/** Build a `QueryResultRow`-shaped member row (ActiveBlockRow + score). */
function makeRow(overrides: Partial<ActiveBlockRow> = {}): ActiveBlockRow & { score: null } {
  return {
    id: 'BLK_M',
    block_type: 'content',
    content: 'Member row',
    // No parent/page link so the member row stays free of a nested PageLink —
    // keeps the axe audit focused on MY header structure.
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    score: null,
    ...overrides,
  }
}

function makeGroup(over: Partial<QueryGroup> = {}): QueryGroup {
  return { key: 'none', count: 1, members: [makeRow()], ...over }
}

/** Read the rendered header-key label of the (single) group section. */
function groupKeyText(): string {
  return screen.getByTestId('advanced-query-group-key').textContent ?? ''
}

describe('GroupedResults header labels (#1447)', () => {
  it('resolves a Tag group key (block id) to its title via pageTitles', () => {
    const tagId = '01J000000000000000000TAG00'
    render(
      <GroupedResults
        groups={[makeGroup({ key: tagId, count: 3 })]}
        groupBy={{ key: { type: 'Tag' } } satisfies GroupSpec}
        pageTitles={new Map([[tagId, 'project']])}
      />,
    )
    expect(groupKeyText()).toBe('project')
    // The raw id must NOT leak into the header.
    expect(screen.queryByText(tagId)).not.toBeInTheDocument()
  })

  it('resolves a Page group key (block id) to its title via pageTitles', () => {
    const pageId = '01J000000000000000000PAGE0'
    render(
      <GroupedResults
        groups={[makeGroup({ key: pageId, count: 2 })]}
        groupBy={{ key: { type: 'Page' } } satisfies GroupSpec}
        pageTitles={new Map([[pageId, 'Roadmap']])}
      />,
    )
    expect(groupKeyText()).toBe('Roadmap')
  })

  it('falls back to the raw id when a Tag/Page key is unresolved', () => {
    const pageId = '01J0000000000000000FOREIGN'
    render(
      <GroupedResults
        groups={[makeGroup({ key: pageId, count: 1 })]}
        groupBy={{ key: { type: 'Page' } } satisfies GroupSpec}
        // Empty map ⇒ unresolved (foreign-space / deleted target).
        pageTitles={new Map()}
      />,
    )
    expect(groupKeyText()).toBe(pageId)
  })

  it('renders a State group key verbatim (already a display label)', () => {
    render(
      <GroupedResults
        groups={[makeGroup({ key: 'TODO', count: 4 })]}
        groupBy={{ key: { type: 'State' } } satisfies GroupSpec}
        pageTitles={new Map()}
      />,
    )
    expect(groupKeyText()).toBe('TODO')
  })

  it('renders a Priority group key as its P-badge label (1 → P1)', () => {
    render(
      <GroupedResults
        groups={[makeGroup({ key: '1', count: 7 })]}
        groupBy={{ key: { type: 'Priority' } } satisfies GroupSpec}
        pageTitles={new Map()}
      />,
    )
    expect(groupKeyText()).toBe('P1')
  })

  it('maps a BlockType enum code to its display label (content → Content)', () => {
    render(
      <GroupedResults
        groups={[makeGroup({ key: 'content', count: 9 })]}
        groupBy={{ key: { type: 'BlockType' } } satisfies GroupSpec}
        pageTitles={new Map()}
      />,
    )
    // Not the raw lowercase enum code.
    expect(groupKeyText()).toBe('Content')
  })

  it('renders the "none" key as the friendly "(none)" label', () => {
    render(
      <GroupedResults
        groups={[makeGroup({ key: 'none', count: 5 })]}
        groupBy={{ key: { type: 'State' } } satisfies GroupSpec}
        pageTitles={new Map()}
      />,
    )
    expect(groupKeyText()).toBe('(none)')
  })

  it('renders "(none)" even under a Tag/Page (id-keyed) dimension', () => {
    // The NULL bucket is always the literal "none" — it must never be treated
    // as an id to resolve, regardless of the grouping dimension.
    render(
      <GroupedResults
        groups={[makeGroup({ key: 'none', count: 2 })]}
        groupBy={{ key: { type: 'Page' } } satisfies GroupSpec}
        pageTitles={new Map([['none', 'WRONG']])}
      />,
    )
    expect(groupKeyText()).toBe('(none)')
  })

  it('has no a11y violations', async () => {
    const tagId = '01J000000000000000000TAG00'
    const { container } = render(
      <GroupedResults
        groups={[
          makeGroup({ key: tagId, count: 3, members: [makeRow({ content: 'A member' })] }),
          makeGroup({ key: 'none', count: 1, members: [makeRow({ content: 'B member' })] }),
        ]}
        groupBy={{ key: { type: 'Tag' } } satisfies GroupSpec}
        pageTitles={new Map([[tagId, 'project']])}
      />,
    )
    // Sanity: both headers resolved as expected before auditing.
    const headers = screen.getAllByTestId('advanced-query-group-key')
    expect(headers.map((h) => h.textContent)).toEqual(['project', '(none)'])
    expect(await axe(container)).toHaveNoViolations()
  })
})
