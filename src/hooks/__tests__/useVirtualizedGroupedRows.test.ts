/**
 * Tests for useVirtualizedGroupedRows — the shared virtualized grouped-list
 * scaffolding extracted from DuePanel / DonePanel / AgendaResults (#2252).
 *
 * Validates:
 *  - Row interleaving: a `group-header` row before each group's `item` rows,
 *    with `flatItemIndex` threaded continuously across groups; empty groups
 *    array, single group, zero-item group, and the headerless flat mode
 *    (`groups: null` + `ungroupedItems`, AgendaResults' groupBy 'none').
 *  - Row keys: `header:<getGroupKey(group)>` for headers, `item.id` for items.
 *  - `flatToVirtualIndex` maps items-only flat indices to virtual-row indices
 *    (headers shift item rows but not the flat count).
 *  - `estimateSize` returns `headerHeight` for header rows, `itemHeight` for
 *    item rows.
 *  - The focused-row effect calls `virtualizer.scrollToIndex(mappedIndex,
 *    { align: 'auto' })` when `focusedIndex` changes; negative and unmapped
 *    (past-the-grouped-portion, e.g. DuePanel's projected tail) indices no-op.
 *  - `virtualRows` identity survives re-renders with fresh inline accessor
 *    identities (accessors are latched in refs).
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { useVirtualizedGroupedRows } from '@/hooks/useVirtualizedGroupedRows'

const { scrollToIndex, estimators } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  estimators: [] as Array<(index: number) => number>,
}))

vi.mock('@tanstack/react-virtual', () =>
  mockReactVirtual({
    scrollToIndex,
    onEstimateSize: (estimateSize) => {
      estimators.push(estimateSize)
    },
  }),
)

interface TestItem {
  id: string
}

interface TestGroup {
  label: string
  items: TestItem[]
}

const getGroupKey = (g: TestGroup): string => g.label
const getGroupItems = (g: TestGroup): TestItem[] => g.items

function makeGroups(...sizes: Array<[label: string, count: number]>): TestGroup[] {
  return sizes.map(([label, count]) => ({
    label,
    items: Array.from({ length: count }, (_, i) => ({ id: `${label}-${i}` })),
  }))
}

interface HookProps {
  groups: TestGroup[] | null
  ungroupedItems?: TestItem[] | undefined
  focusedIndex: number
}

function renderGroupedRows(initial: HookProps) {
  const scrollParentRef = { current: null }
  return renderHook(
    (props: HookProps) =>
      useVirtualizedGroupedRows({
        groups: props.groups,
        ungroupedItems: props.ungroupedItems,
        getGroupKey,
        getGroupItems,
        headerHeight: 32,
        itemHeight: 44,
        focusedIndex: props.focusedIndex,
        scrollParentRef,
      }),
    { initialProps: initial },
  )
}

beforeEach(() => {
  scrollToIndex.mockClear()
  estimators.length = 0
})

describe('useVirtualizedGroupedRows — row interleaving', () => {
  it('interleaves a header row before each group with flatItemIndex threaded across groups', () => {
    const groups = makeGroups(['A', 2], ['B', 1])
    const { result } = renderGroupedRows({ groups, focusedIndex: -1 })

    expect(result.current.virtualRows).toEqual([
      { kind: 'group-header', key: 'header:A', group: groups[0] },
      { kind: 'item', key: 'A-0', item: { id: 'A-0' }, flatItemIndex: 0 },
      { kind: 'item', key: 'A-1', item: { id: 'A-1' }, flatItemIndex: 1 },
      { kind: 'group-header', key: 'header:B', group: groups[1] },
      { kind: 'item', key: 'B-0', item: { id: 'B-0' }, flatItemIndex: 2 },
    ])
  })

  it('renders a single group as one header followed by its items', () => {
    const groups = makeGroups(['Only', 3])
    const { result } = renderGroupedRows({ groups, focusedIndex: -1 })

    expect(result.current.virtualRows.map((r) => r.kind)).toEqual([
      'group-header',
      'item',
      'item',
      'item',
    ])
  })

  it('returns no rows for an empty groups array', () => {
    const { result } = renderGroupedRows({ groups: [], focusedIndex: -1 })
    expect(result.current.virtualRows).toEqual([])
  })

  it('still emits a header row for a zero-item group (panels pre-filter empty groups)', () => {
    const groups = makeGroups(['Empty', 0], ['Full', 1])
    const { result } = renderGroupedRows({ groups, focusedIndex: -1 })

    expect(result.current.virtualRows).toEqual([
      { kind: 'group-header', key: 'header:Empty', group: groups[0] },
      { kind: 'group-header', key: 'header:Full', group: groups[1] },
      { kind: 'item', key: 'Full-0', item: { id: 'Full-0' }, flatItemIndex: 0 },
    ])
  })

  it('headerless flat mode: groups null renders ungroupedItems as plain item rows', () => {
    const items = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    const { result } = renderGroupedRows({ groups: null, ungroupedItems: items, focusedIndex: -1 })

    expect(result.current.virtualRows).toEqual([
      { kind: 'item', key: 'x', item: { id: 'x' }, flatItemIndex: 0 },
      { kind: 'item', key: 'y', item: { id: 'y' }, flatItemIndex: 1 },
      { kind: 'item', key: 'z', item: { id: 'z' }, flatItemIndex: 2 },
    ])
  })

  it('returns no rows when groups is null and ungroupedItems is omitted', () => {
    const { result } = renderGroupedRows({ groups: null, focusedIndex: -1 })
    expect(result.current.virtualRows).toEqual([])
  })
})

describe('useVirtualizedGroupedRows — flatToVirtualIndex', () => {
  it('maps items-only flat indices to virtual-row indices, skipping headers', () => {
    // Rows: [header A, A-0, A-1, header B, B-0] → flat 0/1/2 → virtual 1/2/4.
    const { result } = renderGroupedRows({
      groups: makeGroups(['A', 2], ['B', 1]),
      focusedIndex: -1,
    })
    expect(result.current.flatToVirtualIndex).toEqual([1, 2, 4])
  })

  it('is the identity mapping in headerless flat mode', () => {
    const { result } = renderGroupedRows({
      groups: null,
      ungroupedItems: [{ id: 'x' }, { id: 'y' }],
      focusedIndex: -1,
    })
    expect(result.current.flatToVirtualIndex).toEqual([0, 1])
  })
})

describe('useVirtualizedGroupedRows — estimateSize', () => {
  it('estimates headerHeight for header rows and itemHeight for item rows', () => {
    renderGroupedRows({ groups: makeGroups(['A', 2]), focusedIndex: -1 })

    const estimateSize = estimators.at(-1)
    expect(estimateSize).toBeDefined()
    expect(estimateSize?.(0)).toBe(32) // header row
    expect(estimateSize?.(1)).toBe(44) // item row
    expect(estimateSize?.(2)).toBe(44) // item row
  })
})

describe('useVirtualizedGroupedRows — scroll focused row into view', () => {
  it('does not scroll when focusedIndex is negative', () => {
    renderGroupedRows({ groups: makeGroups(['A', 2]), focusedIndex: -1 })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('scrolls to the header-adjusted virtual index when focusedIndex changes', () => {
    const groups = makeGroups(['A', 2], ['B', 1])
    const { rerender } = renderGroupedRows({ groups, focusedIndex: -1 })
    expect(scrollToIndex).not.toHaveBeenCalled()

    // Flat item 2 (B-0) sits at virtual row 4 (two headers precede it).
    rerender({ groups, focusedIndex: 2 })
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'auto' })
  })

  it('ignores a focusedIndex past the grouped portion (DuePanel projected tail)', () => {
    const groups = makeGroups(['A', 2])
    const { rerender } = renderGroupedRows({ groups, focusedIndex: -1 })

    rerender({ groups, focusedIndex: 99 })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})

describe('useVirtualizedGroupedRows — memo stability', () => {
  it('keeps virtualRows identity across re-renders with fresh inline accessors', () => {
    const groups = makeGroups(['A', 2])
    const scrollParentRef = { current: null }
    const { result, rerender } = renderHook(
      ({ focusedIndex }: { focusedIndex: number }) =>
        useVirtualizedGroupedRows({
          groups,
          // Fresh arrow identities on every render — the hook latches them
          // in refs, so the rows memo must NOT recompute.
          getGroupKey: (g: TestGroup) => g.label,
          getGroupItems: (g: TestGroup) => g.items,
          headerHeight: 32,
          itemHeight: 44,
          focusedIndex,
          scrollParentRef,
        }),
      { initialProps: { focusedIndex: -1 } },
    )

    const firstRows = result.current.virtualRows
    rerender({ focusedIndex: 0 })
    expect(result.current.virtualRows).toBe(firstRows)
  })
})
