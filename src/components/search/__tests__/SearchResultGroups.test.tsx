/**
 * Tests for `SearchResultGroups` — the page-grouped, virtualized result
 * tree (PEND-58f FE-3).
 *
 * Focus of this file: the virtualization wiring + the a11y contract that
 * must survive it.
 *  - Per-group `role="listbox"` + `role="option"` rows + `data-testid`s
 *    are unchanged (one listbox per expanded group).
 *  - `aria-activedescendant` points at the focused row's id, and ONLY the
 *    group owning the focused row carries it.
 *  - When `focusedIndex` lands on a row, the OWNING group's virtualizer is
 *    asked to `scrollToIndex` that row's *in-group* index — the load-
 *    bearing detail that keeps `aria-activedescendant` pointing at a
 *    mounted element under windowing.
 *  - Large groups do not eagerly render every row (only the windowed
 *    slice the virtualizer yields).
 *  - `groupResultsByPage` grouping semantics (pure helper).
 *
 * The `@tanstack/react-virtual` mock is configurable per test: by default
 * it yields every row (so role/aria assertions see the full list), but the
 * "windowing" test overrides it to yield only a slice and records the
 * `scrollToIndex` calls.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchBlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { groupResultsByPage, SearchResultGroups } from '../SearchResultGroups'

// ── Configurable virtualizer mock ───────────────────────────────────────
// `windowSize === null` → yield every row (default). A number → yield only
// the first `windowSize` rows, simulating a real virtual window. Every
// `scrollToIndex` call is recorded so tests can assert the a11y scroll.
const scrollCalls: number[] = []
let windowSize: number | null = null

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const limit = windowSize === null ? opts.count : Math.min(windowSize, opts.count)
    let start = 0
    const items = Array.from({ length: limit }, (_, index) => {
      const size = opts.estimateSize(index)
      const item = { index, key: index, start, size, end: start + size }
      start += size
      return item
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * 36,
      scrollToIndex: (i: number) => {
        scrollCalls.push(i)
      },
      scrollToOffset: vi.fn(),
      measureElement: vi.fn(),
    }
  },
}))

afterEach(() => {
  scrollCalls.length = 0
  windowSize = null
})

function makeRow(o: Partial<SearchBlockRow> & { id: string }): SearchBlockRow {
  return {
    id: o.id,
    block_type: o.block_type ?? 'content',
    content: o.content ?? `content ${o.id}`,
    parent_id: o.parent_id ?? null,
    page_id: o.page_id ?? null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: o.snippet ?? null,
    match_offsets: o.match_offsets ?? null,
  } as SearchBlockRow
}

interface SetupOpts {
  groups: { pageId: string; title: string; rows: SearchBlockRow[] }[]
  focusedIndex?: number
  expanded?: Record<string, boolean>
}

function setup({ groups: groupDefs, focusedIndex = 0, expanded = {} }: SetupOpts) {
  const groups = groupDefs.map((g) => ({
    page_id: g.pageId,
    page_title: g.title,
    has_page_name_match: false,
    blocks: g.rows,
  }))
  // flatRows = expanded groups, in order (mirrors SearchPanel.visibleRows).
  const flatRows = groups.flatMap((g) => ((expanded[g.page_id] ?? true) ? g.blocks : []))
  const onResultClick = vi.fn()
  const onKeyDown = vi.fn(() => false)
  const onToggleGroup = vi.fn()
  render(
    <SearchResultGroups
      groups={groups}
      flatRows={flatRows}
      focusedIndex={focusedIndex}
      expandedGroups={expanded}
      onToggleGroup={onToggleGroup}
      onResultClick={onResultClick}
      loadingResultId={null}
      onKeyDown={onKeyDown}
      t={t}
    />,
  )
  return { onResultClick, onKeyDown, onToggleGroup }
}

describe('SearchResultGroups (virtualized)', () => {
  it('renders one role=listbox per expanded group with the right data-testid', () => {
    setup({
      groups: [
        { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        {
          pageId: 'PAGE_B',
          title: 'Beta',
          rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })],
        },
      ],
    })
    expect(screen.getAllByRole('listbox')).toHaveLength(2)
    expect(screen.getByTestId('search-result-group-PAGE_A')).toBeInTheDocument()
    expect(screen.getByTestId('search-result-group-PAGE_B')).toBeInTheDocument()
  })

  it('renders each block as a role=option <li> with the stable activedescendant id', () => {
    setup({
      groups: [
        {
          pageId: 'PAGE_A',
          title: 'Alpha',
          rows: [
            makeRow({ id: 'A1', page_id: 'PAGE_A' }),
            makeRow({ id: 'A2', page_id: 'PAGE_A' }),
          ],
        },
      ],
    })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAttribute('id', 'search-result-A1')
    expect(options[0]).toHaveAttribute('aria-selected', 'true') // focusedIndex=0
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('only the group owning the focused row carries aria-activedescendant', () => {
    setup({
      groups: [
        { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        {
          pageId: 'PAGE_B',
          title: 'Beta',
          rows: [
            makeRow({ id: 'B1', page_id: 'PAGE_B' }),
            makeRow({ id: 'B2', page_id: 'PAGE_B' }),
          ],
        },
      ],
      // flatRows = [A1, B1, B2]; index 2 → B2, owned by PAGE_B.
      focusedIndex: 2,
    })
    const lbA = screen.getByTestId('search-result-group-PAGE_A')
    const lbB = screen.getByTestId('search-result-group-PAGE_B')
    expect(lbA).not.toHaveAttribute('aria-activedescendant')
    expect(lbB).toHaveAttribute('aria-activedescendant', 'search-result-B2')
  })

  it('scrolls the focused row into view by its IN-GROUP index (a11y under windowing)', () => {
    // flatRows = [A1, B1, B2, B3]; focusedIndex 3 → B3, the 3rd row (index
    // 2) WITHIN PAGE_B. The virtualizer for PAGE_B must scrollToIndex(2),
    // not 3 (the flat index), so the active descendant mounts.
    setup({
      groups: [
        { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        {
          pageId: 'PAGE_B',
          title: 'Beta',
          rows: [
            makeRow({ id: 'B1', page_id: 'PAGE_B' }),
            makeRow({ id: 'B2', page_id: 'PAGE_B' }),
            makeRow({ id: 'B3', page_id: 'PAGE_B' }),
          ],
        },
      ],
      focusedIndex: 3,
    })
    // PAGE_A's group has no focused row → no scroll. PAGE_B scrolls to 2.
    expect(scrollCalls).toContain(2)
    expect(scrollCalls).not.toContain(3)
  })

  it('windows large groups: renders only the virtual slice, but the active row is reachable', () => {
    // 200-row group; the mock yields only the first 20. The active row at
    // in-group index 5 is inside the window, and aria-activedescendant
    // points at it. (Production scrolls it into the window first; the
    // contract verified separately above.)
    windowSize = 20
    const rows = Array.from({ length: 200 }, (_, i) =>
      makeRow({ id: `R${i}`, page_id: 'PAGE_BIG' }),
    )
    setup({
      groups: [{ pageId: 'PAGE_BIG', title: 'Big', rows }],
      focusedIndex: 5,
    })
    const options = screen.getAllByRole('option')
    // Only the windowed slice mounted — NOT all 200.
    expect(options.length).toBe(20)
    expect(options.length).toBeLessThan(rows.length)
    const lb = screen.getByTestId('search-result-group-PAGE_BIG')
    expect(lb).toHaveAttribute('aria-activedescendant', 'search-result-R5')
    // The active row (in-group index 5) is mounted in the window.
    expect(screen.getByText('content R5')).toBeInTheDocument()
    // The virtualizer was asked to scroll the active in-group index in.
    expect(scrollCalls).toContain(5)
  })

  it('renders the per-group count label and the result-count summary', () => {
    setup({
      groups: [
        {
          pageId: 'PAGE_A',
          title: 'Alpha',
          rows: [
            makeRow({ id: 'A1', page_id: 'PAGE_A' }),
            makeRow({ id: 'A2', page_id: 'PAGE_A' }),
          ],
        },
      ],
    })
    // The header button renders `{title} {countLabel}` as one text node, so
    // match the count substring flexibly rather than as a standalone node.
    const countLabel = t('search.matchCountInGroupPlural', { count: 2 })
    expect(screen.getByRole('button', { name: new RegExp(countLabel) })).toBeInTheDocument()
    expect(screen.getByTestId('search-result-count-summary')).toBeInTheDocument()
  })

  it('collapsed groups render no listbox', () => {
    setup({
      groups: [
        { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
      ],
      expanded: { PAGE_A: false },
    })
    expect(screen.getAllByRole('listbox')).toHaveLength(1)
    expect(screen.queryByTestId('search-result-group-PAGE_A')).not.toBeInTheDocument()
    expect(screen.getByTestId('search-result-group-PAGE_B')).toBeInTheDocument()
  })

  it('renders null for an empty group set', () => {
    const { container } = render(
      <SearchResultGroups
        groups={[]}
        flatRows={[]}
        focusedIndex={0}
        expandedGroups={{}}
        onToggleGroup={vi.fn()}
        onResultClick={vi.fn()}
        loadingResultId={null}
        onKeyDown={vi.fn(() => false)}
        t={t}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('groupResultsByPage', () => {
  it('buckets rows under their owning page, preserving order', () => {
    const rows = [
      makeRow({ id: 'A1', page_id: 'PAGE_A' }),
      makeRow({ id: 'B1', page_id: 'PAGE_B' }),
      makeRow({ id: 'A2', page_id: 'PAGE_A' }),
    ]
    const titles = new Map([
      ['PAGE_A', 'Alpha'],
      ['PAGE_B', 'Beta'],
    ])
    const groups = groupResultsByPage(rows, titles)
    expect(groups.map((g) => g.page_id)).toEqual(['PAGE_A', 'PAGE_B'])
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['A1', 'A2'])
    expect(groups[0]?.page_title).toBe('Alpha')
  })

  it('seeds a page-typed row as its own group titled by its content', () => {
    const rows = [makeRow({ id: 'P1', block_type: 'page', content: 'My Page', page_id: null })]
    const groups = groupResultsByPage(rows, new Map())
    expect(groups).toHaveLength(1)
    expect(groups[0]?.page_id).toBe('P1')
    expect(groups[0]?.page_title).toBe('My Page')
    expect(groups[0]?.has_page_name_match).toBe(true)
  })
})
