import { beforeEach, describe, expect, it } from 'vitest'
import { selectRecentPagesForSpace, useRecentPagesStore } from '../recent-pages'
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

    it('selectRecentPagesForSpace falls back to flat list when slice is missing', () => {
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'A', title: 'Alpha' }],
        recentPagesBySpace: {},
      })
      const state = useRecentPagesStore.getState()
      // Null space → flat
      expect(selectRecentPagesForSpace(state, null)).toHaveLength(1)
      // Unknown space → fall back to flat (per-space slice missing)
      expect(selectRecentPagesForSpace(state, 'space-unknown')).toHaveLength(1)
    })
  })
})
