import { beforeEach, describe, expect, it } from 'vitest'

import type { FilterPrimitive } from '@/lib/tauri'

import { selectPageFiltersForSpace, usePageBrowserFiltersStore } from '../pageBrowserFilters'
import { LEGACY_SPACE_KEY } from '../space'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'
const orphan: FilterPrimitive = { type: 'Orphan' }
const tagX: FilterPrimitive = { type: 'Tag', tag: 'X' }

function filtersFor(spaceId: string | null) {
  return selectPageFiltersForSpace(usePageBrowserFiltersStore.getState(), spaceId)
}

describe('pageBrowserFilters store', () => {
  beforeEach(() => {
    usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
  })

  it('appends a chip with a monotonic _addId', () => {
    const { addFilter } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    addFilter(SPACE_A, tagX)
    const chips = filtersFor(SPACE_A)
    expect(chips).toHaveLength(2)
    expect(chips[0]).toMatchObject({ type: 'Orphan', _addId: 1 })
    expect(chips[1]).toMatchObject({ type: 'Tag', tag: 'X', _addId: 2 })
  })

  it('dedupes structurally-identical chips (ignoring _addId)', () => {
    const { addFilter } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    addFilter(SPACE_A, orphan)
    expect(filtersFor(SPACE_A)).toHaveLength(1)
  })

  it('partitions chips by space', () => {
    const { addFilter } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    addFilter(SPACE_B, tagX)
    expect(filtersFor(SPACE_A)).toMatchObject([{ type: 'Orphan' }])
    expect(filtersFor(SPACE_B)).toMatchObject([{ type: 'Tag', tag: 'X' }])
  })

  it('keeps _addId unique across spaces', () => {
    const { addFilter } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    addFilter(SPACE_B, orphan)
    expect(filtersFor(SPACE_A)[0]?._addId).not.toBe(filtersFor(SPACE_B)[0]?._addId)
  })

  it('removes a chip by index', () => {
    const { addFilter, removeFilter } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    addFilter(SPACE_A, tagX)
    removeFilter(SPACE_A, 0)
    expect(filtersFor(SPACE_A)).toMatchObject([{ type: 'Tag', tag: 'X' }])
  })

  it('clears every chip for a space; clearing an empty space is a no-op', () => {
    const { addFilter, clearFilters } = usePageBrowserFiltersStore.getState()
    addFilter(SPACE_A, orphan)
    clearFilters(SPACE_A)
    expect(filtersFor(SPACE_A)).toHaveLength(0)

    // No-op path: clearing a space that never had chips returns the same state
    // object (so subscribers don't re-render).
    const snapshot = usePageBrowserFiltersStore.getState()
    clearFilters(SPACE_B)
    expect(usePageBrowserFiltersStore.getState()).toBe(snapshot)
  })

  it('maps a null space id to the legacy slot via a stable empty array', () => {
    const first = filtersFor(null)
    const second = filtersFor(null)
    expect(first).toHaveLength(0)
    expect(first).toBe(second) // referentially stable so the selector is idempotent
    usePageBrowserFiltersStore.getState().addFilter(LEGACY_SPACE_KEY, orphan)
    expect(filtersFor(null)).toHaveLength(1)
  })
})
