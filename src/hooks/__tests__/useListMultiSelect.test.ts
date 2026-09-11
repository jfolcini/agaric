/**
 * Tests for useListMultiSelect hook.
 *
 * Validates:
 *  - toggleSelection adds/removes items
 *  - rangeSelect with targetState=true adds range
 * RangeSelect with targetState=false removes range
 *  - selectAll respects filterPredicate
 *  - clearSelection empties set
 *  - handleRowClick with shift key triggers rangeSelect
 *  - handleRowClick with ctrl/meta key triggers toggle
 *  - items change prunes the selection to the ids still listed
 *  - a paginated append / a re-sort of the same ids keeps the selection
 *  - filterPredicate prevents toggle of non-selectable items
 *  - rangeSelect skips non-selectable items
 */

import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it } from 'vitest'

import { useListMultiSelect } from '@/hooks/useListMultiSelect'

interface TestItem {
  id: string
  name: string
  selectable?: boolean
}

const items: TestItem[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Charlie' },
  { id: 'd', name: 'Delta' },
]

function mouseEvent(overrides: Partial<React.MouseEvent> = {}): React.MouseEvent {
  return {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  } as React.MouseEvent
}

describe('useListMultiSelect', () => {
  it('toggleSelection adds/removes items', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    act(() => result.current.toggleSelection('a'))
    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.size).toBe(1)

    act(() => result.current.toggleSelection('a'))
    expect(result.current.selected.has('a')).toBe(false)
    expect(result.current.selected.size).toBe(0)
  })

  it('rangeSelect with targetState=true adds range', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    // Set anchor by toggling first item
    act(() => result.current.toggleSelection('a'))

    // Range select from a to c
    act(() => result.current.rangeSelect('c', true))

    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.selected.has('c')).toBe(true)
    expect(result.current.selected.has('d')).toBe(false)
  })

  it('rangeSelect with targetState=false removes range', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    // Select all first
    act(() => result.current.selectAll())
    expect(result.current.selected.size).toBe(4)

    // Toggle 'a' off → sets anchor to 'a', removes 'a'
    act(() => result.current.toggleSelection('a'))
    expect(result.current.selected.has('a')).toBe(false)
    expect(result.current.selected.size).toBe(3)

    // Range remove from a to c
    act(() => result.current.rangeSelect('c', false))

    expect(result.current.selected.has('a')).toBe(false)
    expect(result.current.selected.has('b')).toBe(false)
    expect(result.current.selected.has('c')).toBe(false)
    expect(result.current.selected.has('d')).toBe(true)
  })

  it('selectAll respects filterPredicate', () => {
    const itemsWithFilter: TestItem[] = [
      { id: 'a', name: 'Alpha', selectable: true },
      { id: 'b', name: 'Beta', selectable: false },
      { id: 'c', name: 'Charlie', selectable: true },
    ]
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items: itemsWithFilter,
        getItemId: (item) => item.id,
        filterPredicate: (item) => item.selectable !== false,
      }),
    )

    act(() => result.current.selectAll())

    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(false)
    expect(result.current.selected.has('c')).toBe(true)
    expect(result.current.selected.size).toBe(2)
  })

  it('clearSelection empties set', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)

    act(() => result.current.clearSelection())
    expect(result.current.selected.size).toBe(0)
  })

  it('handleRowClick with shift key triggers rangeSelect', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    // Normal click to set anchor
    act(() => result.current.handleRowClick('a', mouseEvent()))
    expect(result.current.selected.has('a')).toBe(true)

    // Shift+click on c — 'c' is not selected, so targetState=true → add range
    act(() => result.current.handleRowClick('c', mouseEvent({ shiftKey: true })))
    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.selected.has('c')).toBe(true)
    expect(result.current.selected.has('d')).toBe(false)
  })

  it('handleRowClick with ctrl/meta key triggers toggle', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    act(() => result.current.handleRowClick('a', mouseEvent({ ctrlKey: true })))
    expect(result.current.selected.has('a')).toBe(true)

    act(() => result.current.handleRowClick('a', mouseEvent({ ctrlKey: true })))
    expect(result.current.selected.has('a')).toBe(false)
  })

  it('items change resets selection', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items } },
    )

    act(() => result.current.toggleSelection('a'))
    expect(result.current.selected.size).toBe(1)
    expect(result.current.lastClickedId).toBe('a')

    // Change items (different length)
    rerender({
      hookItems: [
        { id: 'x', name: 'X-ray' },
        { id: 'y', name: 'Yankee' },
      ],
    })

    expect(result.current.selected.size).toBe(0)
    expect(result.current.lastClickedId).toBe(null)
  })

  it('resets selection when the ids change but the length does not', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items } },
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)
    expect(result.current.lastClickedId).toBe('b')

    // A filter swap that happens to yield the same row count (#3283).
    rerender({
      hookItems: [
        { id: 'w', name: 'Whiskey' },
        { id: 'x', name: 'X-ray' },
        { id: 'y', name: 'Yankee' },
        { id: 'z', name: 'Zulu' },
      ],
    })

    expect(result.current.selected.size).toBe(0)
    expect(result.current.lastClickedId).toBe(null)
  })

  it('keeps the selection when a rerender carries the same ids', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items } },
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)

    // Same array identity.
    rerender({ hookItems: items })
    expect(result.current.selected.size).toBe(2)

    // Fresh array, identical ids (paginated reload).
    rerender({
      hookItems: [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Charlie' },
        { id: 'd', name: 'Delta' },
      ],
    })

    expect(result.current.selected.size).toBe(2)
    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.lastClickedId).toBe('b')
  })

  it('keeps the selection when a page is appended (Load more)', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items.slice(0, 2) } },
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)

    // "Load more" appends a page: the id set grows, the selected rows stay.
    rerender({ hookItems: items })

    expect(result.current.selected.size).toBe(2)
    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.lastClickedId).toBe('b')
  })

  // An append drops nothing, so the prune has nothing to do; handing back a
  // fresh equal Set commits a state update — and re-renders every consumer of
  // `selected` — once per page the user loads.
  it('does not replace the selection Set when the append dropped nothing', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items.slice(0, 2) } },
    )

    act(() => {
      result.current.toggleSelection('a')
    })
    const before = result.current.selected

    rerender({ hookItems: items })

    expect(result.current.selected).toBe(before)
  })

  it('keeps the selection when the same ids are re-sorted', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items } },
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)

    rerender({ hookItems: [...items].toReversed() })

    expect(result.current.selected.size).toBe(2)
    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.lastClickedId).toBe('b')
  })

  it('drops only the ids that left the list', () => {
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({
          items: hookItems,
          getItemId: (item) => item.id,
        }),
      { initialProps: { hookItems: items } },
    )

    act(() => {
      result.current.toggleSelection('a')
      result.current.toggleSelection('b')
    })
    expect(result.current.selected.size).toBe(2)
    expect(result.current.lastClickedId).toBe('b')

    // 'b' is gone (restored on another device); a batch purge must never carry
    // it, so the pruned selection is exactly the ids still on screen (#3283).
    rerender({
      hookItems: [
        { id: 'a', name: 'Alpha' },
        { id: 'z', name: 'Zulu' },
      ],
    })

    expect(Array.from(result.current.selected)).toEqual(['a'])
    expect(result.current.lastClickedId).toBe(null)
  })

  it('shift-click propagates removal state', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    // Select all via selectAll
    act(() => result.current.selectAll())
    expect(result.current.selected.size).toBe(4)

    // Normal click on 'a' toggles it off, sets anchor
    act(() => result.current.handleRowClick('a', mouseEvent()))
    expect(result.current.selected.has('a')).toBe(false)

    // Shift+click on 'c' — 'c' IS still selected → targetState=false → remove range
    act(() => result.current.handleRowClick('c', mouseEvent({ shiftKey: true })))
    expect(result.current.selected.has('a')).toBe(false)
    expect(result.current.selected.has('b')).toBe(false)
    expect(result.current.selected.has('c')).toBe(false)
    expect(result.current.selected.has('d')).toBe(true) // not in range
  })

  it('filterPredicate prevents toggle of non-selectable items', () => {
    const itemsWithFilter: TestItem[] = [
      { id: 'a', name: 'Alpha', selectable: true },
      { id: 'b', name: 'Beta', selectable: false },
    ]
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items: itemsWithFilter,
        getItemId: (item) => item.id,
        filterPredicate: (item) => item.selectable !== false,
      }),
    )

    act(() => result.current.toggleSelection('b'))
    expect(result.current.selected.has('b')).toBe(false)
  })

  it('rangeSelect skips non-selectable items', () => {
    const itemsWithFilter: TestItem[] = [
      { id: 'a', name: 'Alpha', selectable: true },
      { id: 'b', name: 'Beta', selectable: false },
      { id: 'c', name: 'Charlie', selectable: true },
    ]
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items: itemsWithFilter,
        getItemId: (item) => item.id,
        filterPredicate: (item) => item.selectable !== false,
      }),
    )

    act(() => result.current.toggleSelection('a'))
    act(() => result.current.rangeSelect('c', true))

    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(false) // skipped by predicate
    expect(result.current.selected.has('c')).toBe(true)
  })

  it('lastClickedId updates on toggle and range select', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    expect(result.current.lastClickedId).toBe(null)

    act(() => result.current.toggleSelection('b'))
    expect(result.current.lastClickedId).toBe('b')

    act(() => result.current.rangeSelect('d', true))
    expect(result.current.lastClickedId).toBe('d')
  })

  it('toggleSelection identity is stable across items changes ()', () => {
    const getItemId = (item: TestItem) => item.id
    const { result, rerender } = renderHook(
      ({ hookItems }: { hookItems: TestItem[] }) =>
        useListMultiSelect<TestItem>({ items: hookItems, getItemId }),
      { initialProps: { hookItems: items } },
    )

    const initialToggle = result.current.toggleSelection

    // Same length, different reference (simulates paginated reload).
    rerender({
      hookItems: [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Charlie' },
        { id: 'd', name: 'Delta' },
      ],
    })

    expect(result.current.toggleSelection).toBe(initialToggle)
  })

  it('rangeSelect defaults to index 0 when lastClickedId is null', () => {
    const { result } = renderHook(() =>
      useListMultiSelect<TestItem>({
        items,
        getItemId: (item) => item.id,
      }),
    )

    // No anchor set — range from 0 to 'c'
    act(() => result.current.rangeSelect('c', true))

    expect(result.current.selected.has('a')).toBe(true)
    expect(result.current.selected.has('b')).toBe(true)
    expect(result.current.selected.has('c')).toBe(true)
    expect(result.current.selected.has('d')).toBe(false)
  })
})
