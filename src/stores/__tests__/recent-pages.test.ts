import { beforeEach, describe, expect, it } from 'vitest'
import { useRecentPagesStore } from '../recent-pages'

const STORAGE_KEY = 'agaric:recent-pages'

describe('useRecentPagesStore', () => {
  beforeEach(() => {
    useRecentPagesStore.setState({ recentPages: [] })
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
})
