import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi } from 'zustand'

import { createPerSpaceSlice, type PerSpaceSliceOptions } from '@/stores/createPerSpaceSlice'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

// ---------------------------------------------------------------------------
// A minimal single-field store exercising the primitive in isolation: a flat
// `value` mirror derived from a `valueBySpace` map. `activeSpaceKey()` (used by
// `applyActive`) reads the real `useSpaceStore`, so tests drive `currentSpaceId`
// to steer the active space.
// ---------------------------------------------------------------------------

interface CounterState {
  value: number
  valueBySpace: Record<string, number>
  set: (v: number) => void
}

function makeCounterStore(overrides: Partial<PerSpaceSliceOptions<CounterState, number>> = {}): {
  store: StoreApi<CounterState>
  reconcile: (prevKey: string, newKey: string) => void
} {
  const slice = createPerSpaceSlice<CounterState, number>({
    readMirror: (s) => s.value,
    writeMirror: (v) => ({ value: v }),
    getSlice: (s, key) => s.valueBySpace[key],
    setSlice: (s, key, v) => ({ valueBySpace: { ...s.valueBySpace, [key]: v } }),
    fallback: () => 0,
    ...overrides,
  })
  const store = create<CounterState>((setFn, get) => ({
    value: 0,
    valueBySpace: {},
    set: (v) => setFn(slice.applyActive(get(), v)),
  }))
  const reconcile = slice.attach(store)
  return { store, reconcile }
}

describe('createPerSpaceSlice', () => {
  beforeEach(() => {
    useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
  })

  // -------------------------------------------------------------------------
  // 1. Mutate-by-key isolation: writing space A never touches space B's slice.
  // -------------------------------------------------------------------------
  describe('mutate-by-key isolation', () => {
    it('applyActive writes only the active space slice, leaving siblings untouched', () => {
      const { store } = makeCounterStore()

      useSpaceStore.setState({ currentSpaceId: 'A' })
      store.getState().set(5)
      expect(store.getState().valueBySpace['A']).toBe(5)

      useSpaceStore.setState({ currentSpaceId: 'B' })
      store.getState().set(9)

      // B added; A's slice is unchanged (no cross-space write).
      expect(store.getState().valueBySpace['A']).toBe(5)
      expect(store.getState().valueBySpace['B']).toBe(9)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Mirror derivation: the active mirror always equals the active slice.
  // -------------------------------------------------------------------------
  describe('mirror derivation', () => {
    it('every applyActive keeps the flat mirror equal to the active space slice', () => {
      const { store } = makeCounterStore()
      useSpaceStore.setState({ currentSpaceId: 'A' })

      store.getState().set(3)
      expect(store.getState().value).toBe(3)
      expect(store.getState().value).toBe(store.getState().valueBySpace['A'])

      store.getState().set(7)
      expect(store.getState().value).toBe(7)
      expect(store.getState().value).toBe(store.getState().valueBySpace['A'])
    })
  })

  // -------------------------------------------------------------------------
  // 3. Reconcile on space change: flush current + pull next, no cross-space bleed.
  // -------------------------------------------------------------------------
  describe('reconcile on space change', () => {
    it('flushes the outgoing mirror into the outgoing slice and pulls the incoming slice', () => {
      const { store, reconcile } = makeCounterStore()

      // A holds 5 in both mirror and slice; B pre-seeded to 9.
      store.setState({ value: 5, valueBySpace: { A: 5, B: 9 } })

      reconcile('A', 'B')

      expect(store.getState().value).toBe(9) // pulled B into the mirror
      expect(store.getState().valueBySpace['A']).toBe(5) // A flushed/retained
      expect(store.getState().valueBySpace['B']).toBe(9) // B untouched
    })

    it('flushes the LIVE mirror (not the stale slice) into the outgoing slice', () => {
      const { store, reconcile } = makeCounterStore()
      // Mirror advanced past the recorded A slice (a raw mirror-only write).
      store.setState({ value: 12, valueBySpace: { A: 5 } })

      reconcile('A', 'B')

      // A's slice captured the live mirror value, not the stale 5.
      expect(store.getState().valueBySpace['A']).toBe(12)
    })

    it('does NOT seed the incoming slice when the space is fresh (no leak vector)', () => {
      const { store, reconcile } = makeCounterStore()
      store.setState({ value: 5, valueBySpace: { A: 5 } })

      reconcile('A', 'B') // B never visited

      expect(store.getState().value).toBe(0) // fallback pulled into mirror
      expect(store.getState().valueBySpace['B']).toBeUndefined() // slice left absent
      expect(store.getState().valueBySpace['A']).toBe(5)
    })

    it('fallback is direction-aware (keeps current on legacy→real, defaults on real→real)', () => {
      const { store, reconcile } = makeCounterStore({
        fallback: ({ prevKey, current }) => (prevKey === LEGACY_SPACE_KEY ? current : 99),
      })

      store.setState({ value: 5, valueBySpace: {} })
      reconcile(LEGACY_SPACE_KEY, 'B')
      expect(store.getState().value).toBe(5) // legacy hydration keeps current

      store.setState({ value: 5, valueBySpace: {} })
      reconcile('A', 'B')
      expect(store.getState().value).toBe(99) // real switch uses the default
    })

    it('runs onSwitch after a real switch, but not on the first fire', () => {
      const onSwitch = vi.fn()
      const { store, reconcile } = makeCounterStore({ onSwitch })

      store.setState({ value: 5, valueBySpace: { A: 5 } })
      reconcile('A', 'A') // first fire
      expect(onSwitch).not.toHaveBeenCalled()

      reconcile('A', 'B') // real switch
      expect(onSwitch).toHaveBeenCalledTimes(1)
      expect(onSwitch).toHaveBeenCalledWith('A', 'B')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Rehydrate correctness: the first fire makes the mirror match the active
  //    space, seeding an absent slice or pulling an existing one.
  // -------------------------------------------------------------------------
  describe('first-fire / rehydrate correctness', () => {
    it('seeds an absent slice from the rehydrated mirror', () => {
      const { store, reconcile } = makeCounterStore()
      store.setState({ value: 5, valueBySpace: {} })

      reconcile('A', 'A')

      expect(store.getState().valueBySpace['A']).toBe(5) // slice materialised
      expect(store.getState().value).toBe(5) // mirror unchanged
    })

    it('pulls an existing slice into a stale mirror (Defect-2 shape)', () => {
      const { store, reconcile } = makeCounterStore()
      // Mirror holds a foreign value (8) while A's slice is 3.
      store.setState({ value: 8, valueBySpace: { A: 3 } })

      reconcile('A', 'A')

      expect(store.getState().value).toBe(3) // mirror reconciled to the active slice
    })

    it('seedOnFirstFire can refuse to seed a real space from a foreign mirror', () => {
      // recent-pages shape: the flat mirror may hold another space's data after
      // a rehydrate, so a real space must never be seeded from it.
      const { store, reconcile } = makeCounterStore({
        seedOnFirstFire: (key) => key === LEGACY_SPACE_KEY,
      })

      // Real space, absent slice, foreign mirror (8).
      store.setState({ value: 8, valueBySpace: {} })
      reconcile('A', 'A')
      expect(store.getState().valueBySpace['A']).toBeUndefined() // NOT seeded
      expect(store.getState().value).toBe(0) // mirror reset to fallback

      // Legacy key IS allowed to seed (the v0→v1 flat-only carry).
      store.setState({ value: 8, valueBySpace: {} })
      reconcile(LEGACY_SPACE_KEY, LEGACY_SPACE_KEY)
      expect(store.getState().valueBySpace[LEGACY_SPACE_KEY]).toBe(8)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Composite mirror: a slice spanning two coupled fields + two maps
  //    (the tabs shape) round-trips through flush/pull.
  // -------------------------------------------------------------------------
  describe('composite (multi-field) mirror', () => {
    interface PairState {
      a: string
      b: number
      aBySpace: Record<string, string>
      bBySpace: Record<string, number>
    }
    interface Pair {
      a: string
      b: number
    }

    it('zips/unzips two parallel maps and derives both mirror fields', () => {
      const slice = createPerSpaceSlice<PairState, Pair>({
        readMirror: (s) => ({ a: s.a, b: s.b }),
        writeMirror: (v) => ({ a: v.a, b: v.b }),
        getSlice: (s, key) => {
          const a = s.aBySpace[key]
          if (a === undefined) return undefined
          return { a, b: s.bBySpace[key] ?? 0 }
        },
        setSlice: (s, key, v) => ({
          aBySpace: { ...s.aBySpace, [key]: v.a },
          bBySpace: { ...s.bBySpace, [key]: v.b },
        }),
        fallback: () => ({ a: '', b: 0 }),
      })
      const store = create<PairState>(() => ({ a: '', b: 0, aBySpace: {}, bBySpace: {} }))
      const reconcile = slice.attach(store)

      // Active space X, mirror = {x, 1}. Pre-seed Y = {y, 2}.
      store.setState({ a: 'x', b: 1, aBySpace: { X: 'x' }, bBySpace: { X: 1, Y: 2 } })
      store.setState((prev) => ({ aBySpace: { ...prev.aBySpace, Y: 'y' } }))

      reconcile('X', 'Y')

      expect(store.getState().a).toBe('y')
      expect(store.getState().b).toBe(2)
      // X flushed into both parallel maps.
      expect(store.getState().aBySpace['X']).toBe('x')
      expect(store.getState().bBySpace['X']).toBe(1)
    })
  })
})
