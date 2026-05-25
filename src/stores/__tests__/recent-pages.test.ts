import { beforeEach, describe, expect, it } from 'vitest'
import {
  reconcileRecentPagesOnSpaceChange,
  selectRecentPagesForSpace,
  useRecentPagesStore,
} from '../recent-pages'
import { useSpaceStore } from '../space'

const STORAGE_KEY = 'agaric:recent-pages'

describe('useRecentPagesStore', () => {
  beforeEach(() => {
    // FEAT-3 Phase 3 — clear both the flat MRU and the per-space slices so
    // a prior test's per-space write doesn't leak into the active view via
    // the selector fall-back path.
    useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
    localStorage.clear()
  })

  describe('recordVisit', () => {
    it('adds to the front of recentPages', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(1)
      expect(recentPages[0]).toEqual({ pageId: 'A', title: 'Alpha' })
    })

    it('pushes most-recent visit to the front (MRU order)', () => {
      const { recordVisit } = useRecentPagesStore.getState()

      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(3)
      expect(recentPages[0]?.pageId).toBe('C')
      expect(recentPages[1]?.pageId).toBe('B')
      expect(recentPages[2]?.pageId).toBe('A')
    })

    it('with an existing pageId moves it to the front (dedup by id)', () => {
      const { recordVisit } = useRecentPagesStore.getState()

      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'A', title: 'Alpha' })

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(2)
      expect(recentPages[0]?.pageId).toBe('A')
      expect(recentPages[1]?.pageId).toBe('B')
    })

    it('retains at most 10 entries', () => {
      const { recordVisit } = useRecentPagesStore.getState()

      for (let i = 0; i < 12; i++) {
        recordVisit({ pageId: `P${i}`, title: `Page ${i}` })
      }

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(10)
      // Most recent is P11; oldest retained is P2 (P0 and P1 are evicted).
      expect(recentPages[0]?.pageId).toBe('P11')
      expect(recentPages[9]?.pageId).toBe('P2')
      expect(recentPages.some((p) => p.pageId === 'P0')).toBe(false)
      expect(recentPages.some((p) => p.pageId === 'P1')).toBe(false)
    })

    it('preserves title updates on re-visit', () => {
      const { recordVisit } = useRecentPagesStore.getState()

      recordVisit({ pageId: 'A', title: 'Old' })
      recordVisit({ pageId: 'A', title: 'New' })

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(1)
      expect(recentPages[0]).toEqual({ pageId: 'A', title: 'New' })
    })
  })

  describe('clear', () => {
    it('empties recentPages', () => {
      const { recordVisit, clear } = useRecentPagesStore.getState()

      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      expect(useRecentPagesStore.getState().recentPages).toHaveLength(2)

      clear()

      expect(useRecentPagesStore.getState().recentPages).toHaveLength(0)
    })

    it('is a no-op when already empty', () => {
      useRecentPagesStore.getState().clear()
      expect(useRecentPagesStore.getState().recentPages).toHaveLength(0)
    })
  })

  describe('persistence', () => {
    it('persists recentPages to localStorage', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.state.recentPages).toHaveLength(1)
      expect(parsed.state.recentPages[0]).toEqual({ pageId: 'A', title: 'Alpha' })
    })

    it('round-trips a visit through localStorage rehydrate', async () => {
      // Seed localStorage directly (mimicking a prior session). Avoids the
      // zustand-persist write-on-setState behaviour that would otherwise
      // clobber the persisted blob when we try to reset in-memory state.
      const persistedState = {
        state: {
          recentPages: [
            { pageId: 'B', title: 'Bravo' },
            { pageId: 'A', title: 'Alpha' },
          ],
        },
        version: 0,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState))

      await useRecentPagesStore.persist.rehydrate()

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(2)
      expect(recentPages[0]).toEqual({ pageId: 'B', title: 'Bravo' })
      expect(recentPages[1]).toEqual({ pageId: 'A', title: 'Alpha' })
    })

    it('round-trips raw localStorage shape matches the PageRef contract', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed).toHaveProperty('state')
      expect(parsed.state).toHaveProperty('recentPages')
      expect(parsed.state.recentPages).toHaveLength(1)
      expect(parsed.state.recentPages[0]).toHaveProperty('pageId', 'A')
      expect(parsed.state.recentPages[0]).toHaveProperty('title', 'Alpha')
    })
  })

  // ---------------------------------------------------------------------------
  // FEAT-3 Phase 3 — per-space MRU partitioning
  // ---------------------------------------------------------------------------
  describe('FEAT-3p3 per-space MRU', () => {
    beforeEach(() => {
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    })

    it('recordVisit in space-1 then space-2 keeps each MRU isolated and dedup-correct', () => {
      // space-1: visit A
      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [
          { id: 'space-1', name: 'One', accent_color: null },
          { id: 'space-2', name: 'Two', accent_color: null },
        ],
        isReady: true,
      })
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })
      // Visit A again in the same space — must NOT duplicate within space-1.
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      // Switch to space-2 and visit A again.
      useSpaceStore.setState({ currentSpaceId: 'space-2' })
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      const state = useRecentPagesStore.getState()
      // Both spaces have A in their MRU.
      expect(state.recentPagesBySpace['space-1']?.some((p) => p.pageId === 'A')).toBe(true)
      expect(state.recentPagesBySpace['space-2']?.some((p) => p.pageId === 'A')).toBe(true)
      // Neither space duplicates A within its own slice.
      expect(state.recentPagesBySpace['space-1']?.filter((p) => p.pageId === 'A')).toHaveLength(1)
      expect(state.recentPagesBySpace['space-2']?.filter((p) => p.pageId === 'A')).toHaveLength(1)
    })

    it('persistence round-trips recentPagesBySpace', () => {
      localStorage.removeItem(STORAGE_KEY)

      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [{ id: 'space-1', name: 'One', accent_color: null }],
        isReady: true,
      })
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })
      useRecentPagesStore.getState().recordVisit({ pageId: 'B', title: 'Bravo' })

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(1)
      expect(parsed.state.recentPagesBySpace['space-1']).toBeDefined()
      expect(parsed.state.recentPagesBySpace['space-1']).toHaveLength(2)
      // MRU order: most-recent first.
      expect(parsed.state.recentPagesBySpace['space-1'][0]).toEqual({
        pageId: 'B',
        title: 'Bravo',
      })
    })

    it('migration from v0 (flat-only) seeds recentPagesBySpace.__legacy__', async () => {
      const legacy = {
        state: {
          recentPages: [
            { pageId: 'B', title: 'Bravo' },
            { pageId: 'A', title: 'Alpha' },
          ],
        },
        version: 0,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy))

      await useRecentPagesStore.persist.rehydrate()

      const state = useRecentPagesStore.getState()
      expect(state.recentPagesBySpace['__legacy__']).toBeDefined()
      expect(state.recentPagesBySpace['__legacy__']).toHaveLength(2)
      // Flat field is also populated so legacy reads keep working.
      expect(state.recentPages).toHaveLength(2)
    })

    it('selectRecentPagesForSpace returns flat only for null space; unknown space yields []', () => {
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'A', title: 'Alpha' }],
        recentPagesBySpace: {},
      })
      const state = useRecentPagesStore.getState()
      // Null space → flat (pre-bootstrap fallback).
      expect(selectRecentPagesForSpace(state, null)).toHaveLength(1)
      // Unknown real space → [] (do NOT leak the flat mirror, which
      // holds whichever space was last active before the swap).
      expect(selectRecentPagesForSpace(state, 'space-unknown')).toHaveLength(0)
    })

    it('switching from __legacy__ to a fresh real space does NOT seed the real space slot from the flat mirror', () => {
      // Start under the legacy space and record two visits there.
      useSpaceStore.setState({ currentSpaceId: null })
      useRecentPagesStore.getState().recordVisit({ pageId: 'L1', title: 'Legacy 1' })
      useRecentPagesStore.getState().recordVisit({ pageId: 'L2', title: 'Legacy 2' })

      expect(useRecentPagesStore.getState().recentPagesBySpace['__legacy__']).toHaveLength(2)

      // Switch to a real space that has never been visited. The
      // subscriber must flush the legacy mirror into the legacy slot
      // and pull an empty list into the active mirror — without
      // seeding `recentPagesBySpace['SPACE_X']` from the flat field,
      // which is the cross-space leak vector the strip's
      // `selectRecentPagesForSpace` used to fall through to.
      useSpaceStore.setState({ currentSpaceId: 'SPACE_X' })

      const state = useRecentPagesStore.getState()
      expect(state.recentPagesBySpace['SPACE_X']).toBeUndefined()
      expect(state.recentPages).toEqual([])
      // Legacy slot retained (no data lost).
      expect(state.recentPagesBySpace['__legacy__']).toHaveLength(2)
    })

    it('recordVisit builds from the active space slice, not a stale foreign flat mirror (PEND-78 Defect 1)', () => {
      useSpaceStore.setState({ currentSpaceId: 'space-A' })
      // Post-rehydrate inconsistency: the flat mirror holds space-B's list
      // while the active space is space-A (with its own slice).
      useRecentPagesStore.setState({
        recentPages: [
          { pageId: 'B1', title: 'B One' },
          { pageId: 'B2', title: 'B Two' },
        ],
        recentPagesBySpace: {
          'space-A': [{ pageId: 'A1', title: 'A One' }],
          'space-B': [
            { pageId: 'B1', title: 'B One' },
            { pageId: 'B2', title: 'B Two' },
          ],
        },
      })

      useRecentPagesStore.getState().recordVisit({ pageId: 'A2', title: 'A Two' })

      const state = useRecentPagesStore.getState()
      // space-A grew from its OWN slice — no space-B bleed.
      expect(state.recentPagesBySpace['space-A']?.map((p) => p.pageId)).toEqual(['A2', 'A1'])
      expect(state.recentPagesBySpace['space-A']?.some((p) => p.pageId.startsWith('B'))).toBe(false)
      expect(
        selectRecentPagesForSpace(state, 'space-A').some((p) => p.pageId.startsWith('B')),
      ).toBe(false)
    })

    it('boot: rehydrate with a foreign flat mirror + first-fire reconcile leaves no cross-space leak (PEND-78)', async () => {
      // Order matters: change space FIRST so the subscriber's persist write
      // fires now, THEN seed localStorage so `rehydrate()` reads our blob
      // (not the just-written empty state).
      useSpaceStore.setState({ currentSpaceId: 'space-A' })
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            // Foreign (space-B) flat mirror persisted alongside the real slices.
            recentPages: [{ pageId: 'B1', title: 'B One' }],
            recentPagesBySpace: {
              'space-A': [{ pageId: 'A1', title: 'A One' }],
              'space-B': [{ pageId: 'B1', title: 'B One' }],
            },
          },
          version: 1,
        }),
      )
      await useRecentPagesStore.persist.rehydrate()
      // Boot first-fire: currentSpaceId already resolved to the real space.
      reconcileRecentPagesOnSpaceChange('space-A', 'space-A')

      const afterReconcile = useRecentPagesStore.getState()
      // Flat reconciled to space-A; the null-space read no longer flashes space-B.
      expect(afterReconcile.recentPages.map((p) => p.pageId)).toEqual(['A1'])
      expect(selectRecentPagesForSpace(afterReconcile, null).some((p) => p.pageId === 'B1')).toBe(
        false,
      )

      // A subsequent visit stays within space-A's own slice.
      useRecentPagesStore.getState().recordVisit({ pageId: 'A2', title: 'A Two' })
      const finalState = useRecentPagesStore.getState()
      expect(finalState.recentPagesBySpace['space-A']?.map((p) => p.pageId)).toEqual(['A2', 'A1'])
    })

    it('first-fire reconciles the flat mirror to the active space slice (PEND-78 Defect 2)', () => {
      useSpaceStore.setState({ currentSpaceId: 'space-A' })
      // Set the foreign flat mirror AFTER the space change so only the
      // first-fire reconcile (not the diff-branch pull) can correct it.
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'B1', title: 'B One' }],
        recentPagesBySpace: {
          'space-A': [{ pageId: 'A1', title: 'A One' }],
          'space-B': [{ pageId: 'B1', title: 'B One' }],
        },
      })

      // Simulate the boot-time first fire (prevKey === newKey).
      reconcileRecentPagesOnSpaceChange('space-A', 'space-A')

      const state = useRecentPagesStore.getState()
      expect(state.recentPages.map((p) => p.pageId)).toEqual(['A1'])
    })

    it('first-fire still seeds the legacy slot from the flat mirror (v0→v1 path)', () => {
      useSpaceStore.setState({ currentSpaceId: null })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'L1', title: 'Legacy 1' }],
        recentPagesBySpace: {},
      })

      reconcileRecentPagesOnSpaceChange('__legacy__', '__legacy__')

      const state = useRecentPagesStore.getState()
      expect(state.recentPagesBySpace['__legacy__']).toEqual([{ pageId: 'L1', title: 'Legacy 1' }])
      expect(state.recentPages.map((p) => p.pageId)).toEqual(['L1'])
    })
  })
})
