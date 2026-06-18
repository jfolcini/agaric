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
    localStorage.clear()
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

  // #1750 — the chip set persists to localStorage so it has the same lifetime
  // as the graph view's filters (both surfaces own a durable filter set);
  // backlinks deliberately stay page-scoped and are NOT covered here.
  describe('persistence (#1750)', () => {
    const STORAGE_KEY = 'agaric:page-browser-filters'

    it('writes the chip set and nextAddId to localStorage on change', () => {
      const { addFilter } = usePageBrowserFiltersStore.getState()
      addFilter(SPACE_A, orphan)
      addFilter(SPACE_A, tagX)

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const persisted = JSON.parse(raw as string) as {
        state: { filtersBySpace: Record<string, FilterPrimitive[]>; nextAddId: number }
      }
      expect(persisted.state.filtersBySpace[SPACE_A]).toMatchObject([
        { type: 'Orphan', _addId: 1 },
        { type: 'Tag', tag: 'X', _addId: 2 },
      ])
      // nextAddId is persisted so rehydrated chips don't collide with fresh ones.
      expect(persisted.state.nextAddId).toBe(2)
    })

    it('rehydrates the chip set from localStorage', async () => {
      // Reset in-memory state first, THEN seed storage — a `setState` reset
      // triggers a persist write, so seeding afterwards is what the rehydrate
      // reads back (simulating an app restart reading the persisted slice).
      usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            filtersBySpace: { [SPACE_A]: [{ type: 'Orphan', _addId: 7 }] },
            nextAddId: 7,
          },
          version: 1,
        }),
      )

      await usePageBrowserFiltersStore.persist.rehydrate()

      expect(filtersFor(SPACE_A)).toMatchObject([{ type: 'Orphan', _addId: 7 }])
      expect(usePageBrowserFiltersStore.getState().nextAddId).toBe(7)
      // A subsequent add continues the counter from the rehydrated value.
      usePageBrowserFiltersStore.getState().addFilter(SPACE_A, tagX)
      expect(filtersFor(SPACE_A)[1]).toMatchObject({ type: 'Tag', tag: 'X', _addId: 8 })
    })
  })
})
