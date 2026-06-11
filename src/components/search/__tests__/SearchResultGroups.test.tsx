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

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import type { SearchBlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'

import { groupResultsByPage, SearchResultGroups } from '../SearchResultGroups'

// ── Configurable virtualizer mock ───────────────────────────────────────
// `windowSize === null` → yield every row (default). A number → yield only
// the first `windowSize` rows, simulating a real virtual window. Every
// `scrollToIndex` call is recorded so tests can assert the a11y scroll.
const scrollCalls: number[] = []
let windowSize: number | null = null

// Shared virtualizer mock (src/__tests__/mocks/react-virtual.ts) with a lazy
// `windowSize` getter (it changes per test) and a `scrollToIndex` capture.
vi.mock('@tanstack/react-virtual', () =>
  mockReactVirtual({
    windowSize: () => windowSize,
    scrollToIndex: (i: number) => {
      scrollCalls.push(i)
    },
  }),
)

// FE-A5: spy on the PAGE-level `Element.prototype.scrollIntoView` (jsdom
// stubs it to a no-op in test-setup; we replace it with a recording spy so
// the active-row page scroll is observable). Restored after each test.
let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scrollIntoViewSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  scrollCalls.length = 0
  windowSize = null
  scrollIntoViewSpy.mockRestore()
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
  const utils = render(
    <SearchResultGroups
      groups={groups}
      flatRows={flatRows}
      focusedIndex={focusedIndex}
      expandedGroups={expanded}
      onToggleGroup={onToggleGroup}
      onResultClick={onResultClick}
      loadingResultId={null}
      onKeyDown={onKeyDown}
    />,
  )
  return { onResultClick, onKeyDown, onToggleGroup, ...utils }
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
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  // FE-A7 — exactly one listbox must stay in the tab order so the results
  // region is reachable with Tab. When `focusedRow` is undefined (e.g. right
  // after a collapse leaves the focused flat index past the shrunk list),
  // the FIRST expanded group must fall back to `tabIndex=0`.
  describe('FE-A7: results region stays tabbable', () => {
    it('keeps the first expanded group tabbable when focusedRow is undefined', () => {
      setup({
        groups: [
          { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
          { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
        ],
        // flatRows length is 2; an out-of-range focusedIndex => focusedRow
        // is undefined (the post-collapse window described in FE-A7).
        focusedIndex: 99,
      })
      const lbA = screen.getByTestId('search-result-group-PAGE_A')
      const lbB = screen.getByTestId('search-result-group-PAGE_B')
      // First expanded group is tabbable; later groups are roving (-1).
      expect(lbA).toHaveAttribute('tabindex', '0')
      expect(lbB).toHaveAttribute('tabindex', '-1')
      // At least one listbox is in the tab order — region not orphaned.
      const tabbable = screen
        .getAllByRole('listbox')
        .filter((el) => el.getAttribute('tabindex') === '0')
      expect(tabbable).toHaveLength(1)
    })

    it('falls back to the first EXPANDED group when an earlier group is collapsed', () => {
      setup({
        groups: [
          { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
          { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
        ],
        expanded: { PAGE_A: false },
        focusedIndex: 99, // focusedRow undefined
      })
      // PAGE_A is collapsed → no listbox; PAGE_B is the first EXPANDED group
      // and must carry tabIndex=0.
      expect(screen.queryByTestId('search-result-group-PAGE_A')).not.toBeInTheDocument()
      expect(screen.getByTestId('search-result-group-PAGE_B')).toHaveAttribute('tabindex', '0')
    })

    it('keeps the focused group tabbable (not the first) when a row IS focused', () => {
      setup({
        groups: [
          { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
          { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
        ],
        focusedIndex: 1, // flatRows=[A1,B1] → B1, owned by PAGE_B
      })
      expect(screen.getByTestId('search-result-group-PAGE_A')).toHaveAttribute('tabindex', '-1')
      expect(screen.getByTestId('search-result-group-PAGE_B')).toHaveAttribute('tabindex', '0')
    })
  })

  // FE-A5 — per-group `scrollToIndex` only scrolls within the group's own
  // overflow container; the active row can still be below the page fold.
  // A page-level `scrollIntoView({ block: 'nearest' })` must run on the
  // active row element when the active row changes.
  describe('FE-A5: page-level scrollIntoView on the active row', () => {
    it('calls scrollIntoView on the active row element when a row is focused', () => {
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
        focusedIndex: 1, // A2 is active
      })
      // The active row element (id=search-result-A2) had scrollIntoView
      // invoked with block:'nearest' (page-level follow).
      const activeEl = document.getElementById('search-result-A2')
      expect(activeEl).not.toBeNull()
      expect(scrollIntoViewSpy).toHaveBeenCalled()
      const calledOnActive = scrollIntoViewSpy.mock.contexts.some(
        (ctx: unknown) => ctx === activeEl,
      )
      expect(calledOnActive).toBe(true)
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })

    it('re-runs the page scroll when the active row changes across groups', () => {
      const { rerender } = setup({
        groups: [
          { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
          { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
        ],
        focusedIndex: 0, // A1 active
      })
      scrollIntoViewSpy.mockClear()

      // Move focus to the next group's row (cross-group roving).
      const a1 = makeRow({ id: 'A1', page_id: 'PAGE_A' })
      const b1 = makeRow({ id: 'B1', page_id: 'PAGE_B' })
      const groups = [
        { page_id: 'PAGE_A', page_title: 'Alpha', has_page_name_match: false, blocks: [a1] },
        { page_id: 'PAGE_B', page_title: 'Beta', has_page_name_match: false, blocks: [b1] },
      ]
      rerender(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={1} // now B1 is active
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )
      const newActive = document.getElementById('search-result-B1')
      expect(newActive).not.toBeNull()
      const scrolledNewActive = scrollIntoViewSpy.mock.contexts.some(
        (ctx: unknown) => ctx === newActive,
      )
      expect(scrolledNewActive).toBe(true)
    })

    it('does not page-scroll when no row is focused (focusedRow undefined)', () => {
      setup({
        groups: [
          { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        ],
        focusedIndex: 99, // out of range → focusedRow undefined
      })
      // No active row in any group → no page-level scroll invoked.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    })
  })

  // CR-A11Y (#151) — when roving arrows carry the active row across a group
  // boundary, DOM focus must follow onto the newly-active group's listbox so
  // `aria-activedescendant` (which only the owning group carries) is always
  // exposed on the FOCUSED element. Without this the screen reader loses the
  // active descendant at the boundary because focus stays on the old group's
  // `<ul>`, which no longer points at any option.
  describe('CR-A11Y #151: focus follows the active row across group boundaries', () => {
    function makeGroups() {
      const a1 = makeRow({ id: 'A1', page_id: 'PAGE_A' })
      const b1 = makeRow({ id: 'B1', page_id: 'PAGE_B' })
      return {
        a1,
        b1,
        groups: [
          { page_id: 'PAGE_A', page_title: 'Alpha', has_page_name_match: false, blocks: [a1] },
          { page_id: 'PAGE_B', page_title: 'Beta', has_page_name_match: false, blocks: [b1] },
        ],
      }
    }

    it('moves DOM focus to the next group listbox when the active row crosses the boundary', () => {
      const { a1, b1, groups } = makeGroups()
      const { rerender } = render(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={0} // A1 active → PAGE_A owns the active row
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )
      const lbA = screen.getByTestId('search-result-group-PAGE_A')
      const lbB = screen.getByTestId('search-result-group-PAGE_B')
      // Simulate the user having Tabbed into / roving the results: DOM focus is
      // on the active group's listbox (PAGE_A).
      lbA.focus()
      expect(document.activeElement).toBe(lbA)

      // Arrow down crosses into PAGE_B: focusedIndex now points at B1.
      rerender(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={1} // B1 active → PAGE_B owns the active row
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )

      // Focus followed the active row to PAGE_B's listbox.
      expect(document.activeElement).toBe(lbB)
      // aria-activedescendant is on the FOCUSED listbox and points at B1.
      expect(lbB).toHaveAttribute('aria-activedescendant', 'search-result-B1')
      // The old group no longer carries an active descendant.
      expect(lbA).not.toHaveAttribute('aria-activedescendant')
    })

    it('does NOT steal focus from the search input on initial render', () => {
      const { a1, b1, groups } = makeGroups()
      // A standalone input simulates the search box keeping DOM focus while
      // results render (focusedIndex defaults to 0 / first row).
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      expect(document.activeElement).toBe(input)

      render(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={0}
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )

      // The first group is the active group, but focus is on the input (not on
      // a sibling results listbox), so we must NOT hijack it.
      expect(document.activeElement).toBe(input)
      input.remove()
    })

    it('keeps aria-activedescendant resolving to a mounted descendant of the focused listbox', () => {
      const { a1, b1, groups } = makeGroups()
      const { rerender } = render(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={0}
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )
      screen.getByTestId('search-result-group-PAGE_A').focus()
      rerender(
        <SearchResultGroups
          groups={groups}
          flatRows={[a1, b1]}
          focusedIndex={1}
          expandedGroups={{}}
          onToggleGroup={vi.fn()}
          onResultClick={vi.fn()}
          loadingResultId={null}
          onKeyDown={vi.fn(() => false)}
        />,
      )
      const focused = document.activeElement as HTMLElement
      const adId = focused.getAttribute('aria-activedescendant')
      expect(adId).toBe('search-result-B1')
      // The active descendant id resolves to a real element that is a
      // descendant of the focused listbox (mounted by the virtualizer).
      const ad = document.getElementById(adId as string)
      expect(ad).not.toBeNull()
      expect(focused.contains(ad)).toBe(true)
    })
  })

  it('has no a11y violations (focused row state)', async () => {
    const { container } = setup({
      groups: [
        {
          pageId: 'PAGE_A',
          title: 'Alpha',
          rows: [
            makeRow({ id: 'A1', page_id: 'PAGE_A' }),
            makeRow({ id: 'A2', page_id: 'PAGE_A' }),
          ],
        },
        { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
      ],
      focusedIndex: 0,
    })
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations (focusedRow undefined / region still tabbable)', async () => {
    const { container } = setup({
      groups: [
        { pageId: 'PAGE_A', title: 'Alpha', rows: [makeRow({ id: 'A1', page_id: 'PAGE_A' })] },
        { pageId: 'PAGE_B', title: 'Beta', rows: [makeRow({ id: 'B1', page_id: 'PAGE_B' })] },
      ],
      focusedIndex: 99, // focusedRow undefined → FE-A7 fallback engaged
    })
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
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
