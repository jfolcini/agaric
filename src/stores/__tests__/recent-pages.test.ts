import { beforeEach, describe, expect, it } from 'vitest'

import {
  getRecentPagesForSpace,
  migrateRawRecentPagesKeys,
  type PageRef,
  reconcileRecentPagesOnSpaceChange,
  selectRecentPagesForSpace,
  useRecentPagesStore,
} from '../recent-pages'
import { useSpaceStore } from '../space'

const STORAGE_KEY = 'agaric:recent-pages'

describe('useRecentPagesStore', () => {
  beforeEach(() => {
    // Phase 3 — clear both the flat MRU and the per-space slices so
    // a prior test's per-space write doesn't leak into the active view via
    // the selector fall-back path. #1149 — also reset `rawKeysMerged` so the
    // raw-key migration's one-time guard starts fresh each test.
    useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {}, rawKeysMerged: false })
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
  // Phase 3 — per-space MRU partitioning
  // ---------------------------------------------------------------------------
  describe(' per-space MRU', () => {
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

    it('recordVisit builds from the active space slice, not a stale foreign flat mirror (Defect 1)', () => {
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

    it('boot: rehydrate with a foreign flat mirror + first-fire reconcile leaves no cross-space leak', async () => {
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

    it('first-fire reconciles the flat mirror to the active space slice (Defect 2)', () => {
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

  // ---------------------------------------------------------------------------
  // #1149 — consolidated pinning + removal + addRecentPage (folded in from the
  // removed `lib/recent-pages.ts`).
  // ---------------------------------------------------------------------------
  describe('#1149 addRecentPage', () => {
    beforeEach(() => {
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    })

    it('prepends a new entry with a fresh visitedAt', () => {
      const before = new Date().toISOString()
      useRecentPagesStore.getState().addRecentPage('A', 'Alpha')
      const after = new Date().toISOString()

      const [first] = useRecentPagesStore.getState().recentPages
      expect(first?.pageId).toBe('A')
      expect(first?.title).toBe('Alpha')
      expect(first?.visitedAt).toBeDefined()
      if (first?.visitedAt != null) {
        expect(first.visitedAt >= before).toBe(true)
        expect(first.visitedAt <= after).toBe(true)
      }
    })

    it('dedups by id, moving an existing entry to the front', () => {
      const { addRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      addRecentPage('B', 'Bravo')
      addRecentPage('A', 'Alpha (revisited)')

      const ids = useRecentPagesStore.getState().recentPages.map((p) => p.pageId)
      expect(ids).toEqual(['A', 'B'])
      expect(useRecentPagesStore.getState().recentPages[0]?.title).toBe('Alpha (revisited)')
    })

    it('caps unpinned entries at 10, evicting the oldest', () => {
      const { addRecentPage } = useRecentPagesStore.getState()
      for (let i = 0; i < 13; i++) addRecentPage(`P${i}`, `Page ${i}`)

      const ids = useRecentPagesStore.getState().recentPages.map((p) => p.pageId)
      expect(ids).toHaveLength(10)
      expect(ids[0]).toBe('P12')
      expect(ids).not.toContain('P0')
      expect(ids).not.toContain('P2')
      expect(ids[9]).toBe('P3')
    })

    it('preserves the pinned flag when re-adding a pinned page', () => {
      const { addRecentPage, togglePinRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      togglePinRecentPage('A')
      addRecentPage('A', 'Alpha (updated)')

      const [first] = useRecentPagesStore.getState().recentPages
      expect(first?.pageId).toBe('A')
      expect(first?.pinned).toBe(true)
      expect(first?.title).toBe('Alpha (updated)')
    })
  })

  describe('#1149 togglePinRecentPage', () => {
    beforeEach(() => {
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    })

    it('flips an existing entry to pinned and returns true', () => {
      const { addRecentPage, togglePinRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      expect(togglePinRecentPage('A')).toBe(true)
      expect(useRecentPagesStore.getState().recentPages[0]?.pinned).toBe(true)
    })

    it('returns null for an unknown id', () => {
      expect(useRecentPagesStore.getState().togglePinRecentPage('GHOST')).toBeNull()
    })

    it('sorts pinned entries before unpinned (pin-first ordering)', () => {
      const { addRecentPage, togglePinRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      addRecentPage('B', 'Bravo')
      addRecentPage('C', 'Charlie')
      // Pin the OLDEST entry — it must jump to position 0.
      togglePinRecentPage('A')
      expect(useRecentPagesStore.getState().recentPages.map((p) => p.pageId)).toEqual([
        'A',
        'C',
        'B',
      ])
    })

    it('does not count pinned entries against the MAX_RETAINED cap', () => {
      const { addRecentPage, togglePinRecentPage } = useRecentPagesStore.getState()
      for (let i = 0; i < 3; i++) {
        addRecentPage(`PIN${i}`, `Pinned ${i}`)
        togglePinRecentPage(`PIN${i}`)
      }
      for (let i = 0; i < 15; i++) addRecentPage(`U${i}`, `Unpinned ${i}`)

      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages.filter((p) => p.pinned === true)).toHaveLength(3)
      expect(recentPages.filter((p) => p.pinned !== true)).toHaveLength(10)
    })

    it('unpinning re-stamps visitedAt to now (entry lands atop the unpinned partition)', () => {
      const { addRecentPage, togglePinRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      togglePinRecentPage('A')
      addRecentPage('B', 'Bravo')
      expect(useRecentPagesStore.getState().recentPages.map((p) => p.pageId)).toEqual(['A', 'B'])

      togglePinRecentPage('A')
      const result = useRecentPagesStore.getState().recentPages
      expect(result[0]?.pinned).toBeUndefined()
      expect(result.map((p) => p.pageId)).toEqual(['A', 'B'])
    })
  })

  describe('#1149 removeRecentPage', () => {
    beforeEach(() => {
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    })

    it('removes a matching entry and returns true', () => {
      const { addRecentPage, removeRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      addRecentPage('B', 'Bravo')
      expect(removeRecentPage('A')).toBe(true)
      expect(useRecentPagesStore.getState().recentPages.map((p) => p.pageId)).toEqual(['B'])
    })

    it('returns false when the id is not present', () => {
      const { addRecentPage, removeRecentPage } = useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      expect(removeRecentPage('GHOST')).toBe(false)
      expect(useRecentPagesStore.getState().recentPages.map((p) => p.pageId)).toEqual(['A'])
    })

    it('removes a pinned entry too (pin status does not block removal)', () => {
      const { addRecentPage, togglePinRecentPage, removeRecentPage } =
        useRecentPagesStore.getState()
      addRecentPage('A', 'Alpha')
      togglePinRecentPage('A')
      expect(removeRecentPage('A')).toBe(true)
      expect(useRecentPagesStore.getState().recentPages).toEqual([])
    })
  })

  describe('#1149 getRecentPagesForSpace (RecentPage-shaped snapshot read)', () => {
    it('maps the active-space slice to id-keyed RecentPage entries, pin-first', () => {
      useSpaceStore.setState({ currentSpaceId: 'space-1' })
      useRecentPagesStore.setState({
        recentPagesBySpace: {
          'space-1': [
            { pageId: 'A', title: 'Alpha', visitedAt: '2026-01-01T00:00:00.000Z' },
            { pageId: 'B', title: 'Bravo', visitedAt: '2026-01-02T00:00:00.000Z', pinned: true },
          ],
        },
      })
      const result = getRecentPagesForSpace('space-1')
      // Pinned B sorts first; entries are `{ id, title, visitedAt }`-shaped.
      expect(result.map((r) => r.id)).toEqual(['B', 'A'])
      expect(result[0]).toEqual({
        id: 'B',
        title: 'Bravo',
        visitedAt: '2026-01-02T00:00:00.000Z',
        pinned: true,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // #1149 — one-time migration of the raw `recent_pages:<spaceId>` keys
  // written by the removed `lib/recent-pages.ts`.
  // ---------------------------------------------------------------------------
  describe('#1149 raw-key migration', () => {
    it('merges a raw per-space key into recentPagesBySpace and clears it', () => {
      localStorage.setItem(
        'recent_pages:space-1',
        JSON.stringify([
          { id: 'R1', title: 'Raw One', visitedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'R2', title: 'Raw Two', visitedAt: '2026-01-02T00:00:00.000Z', pinned: true },
        ]),
      )

      const { bySpace, changed } = migrateRawRecentPagesKeys({})
      expect(changed).toBe(true)
      // Pinned R2 sorts first after the merge.
      expect(bySpace['space-1']?.map((p) => p.pageId)).toEqual(['R2', 'R1'])
      expect(bySpace['space-1']?.find((p) => p.pageId === 'R2')?.pinned).toBe(true)
      // Raw key cleared so a later hydrate cannot re-merge.
      expect(localStorage.getItem('recent_pages:space-1')).toBeNull()
    })

    it('folds the pre- unscoped `recent_pages` key into the __legacy__ slot', () => {
      localStorage.setItem(
        'recent_pages',
        JSON.stringify([{ id: 'OLD', title: 'Old', visitedAt: '2024-01-01T00:00:00.000Z' }]),
      )
      const { bySpace, changed } = migrateRawRecentPagesKeys({})
      expect(changed).toBe(true)
      expect(bySpace['__legacy__']?.map((p) => p.pageId)).toEqual(['OLD'])
      expect(localStorage.getItem('recent_pages')).toBeNull()
    })

    it('merges WITHOUT losing either MRU set (store order wins for shared ids, raw-only appended)', () => {
      const existing: Record<string, PageRef[]> = {
        'space-1': [
          { pageId: 'S1', title: 'Store One' },
          { pageId: 'SHARED', title: 'Store shared' },
        ],
      }
      localStorage.setItem(
        'recent_pages:space-1',
        JSON.stringify([
          {
            id: 'SHARED',
            title: 'Raw shared',
            visitedAt: '2026-05-01T00:00:00.000Z',
            pinned: true,
          },
          { id: 'R1', title: 'Raw only', visitedAt: '2026-04-01T00:00:00.000Z' },
        ]),
      )

      const { bySpace } = migrateRawRecentPagesKeys(existing)
      const slice = bySpace['space-1'] ?? []
      // SHARED was pinned in the raw set → pin union makes it pinned, so it
      // sorts first; store-only S1 then raw-only R1 follow (both unpinned).
      expect(slice.map((p) => p.pageId)).toEqual(['SHARED', 'S1', 'R1'])
      expect(slice.find((p) => p.pageId === 'SHARED')?.pinned).toBe(true)
      // No entry lost from either source.
      expect(slice.map((p) => p.pageId).sort()).toEqual(['R1', 'S1', 'SHARED'])
    })

    it('is a no-op when there are no raw keys', () => {
      const { changed } = migrateRawRecentPagesKeys({
        'space-1': [{ pageId: 'A', title: 'Alpha' }],
      })
      expect(changed).toBe(false)
    })

    it('runs once on rehydrate: seeds the store from raw keys then clears them', async () => {
      useSpaceStore.setState({ currentSpaceId: 'space-1', isReady: true })
      // Persisted store blob has no raw-key merge yet; the raw key exists.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: { recentPages: [], recentPagesBySpace: {}, rawKeysMerged: false },
          version: 1,
        }),
      )
      localStorage.setItem(
        'recent_pages:space-1',
        JSON.stringify([{ id: 'R1', title: 'Raw One', visitedAt: '2026-01-01T00:00:00.000Z' }]),
      )

      await useRecentPagesStore.persist.rehydrate()

      const state = useRecentPagesStore.getState()
      expect(state.rawKeysMerged).toBe(true)
      expect(state.recentPagesBySpace['space-1']?.map((p) => p.pageId)).toEqual(['R1'])
      // Flat mirror reconciled to the active (space-1) slice.
      expect(state.recentPages.map((p) => p.pageId)).toEqual(['R1'])
      // Raw key cleared.
      expect(localStorage.getItem('recent_pages:space-1')).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // CR-PERSIST (#1578) — coerce malformed persisted blobs on rehydrate. The
  // store's `persist` config wires `coercePersistedRecentPages` into BOTH
  // `migrate` (version-mismatched blobs) and `merge` (same-version blobs), so
  // a corrupt/hand-edited `agaric:recent-pages` payload can't flow unvalidated
  // into `recordVisit` / `selectRecentPagesForSpace` / `applyPinFirstCap`.
  // ---------------------------------------------------------------------------
  describe('#1578 persisted-blob coercion', () => {
    it('drops malformed PageRef entries via the merge path (same-version blob)', async () => {
      // version: 1 matches options.version, so zustand skips `migrate` and the
      // raw blob reaches `merge` — the entry point the old bare cast bypassed.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            recentPages: [
              { pageId: 'A', title: 'Alpha' },
              { pageId: 'B' }, // missing title
              { title: 'No id' }, // missing pageId
              null,
              42,
              { pageId: 'C', title: 'Charlie', visitedAt: 123, pinned: 'yes' }, // bad optionals
            ],
            recentPagesBySpace: {
              'space-1': [
                { pageId: 'S1', title: 'Slice One' },
                { pageId: 'S2' }, // dropped
              ],
              'bad-space': 'not-an-array', // dropped key
            },
            rawKeysMerged: true,
          },
          version: 1,
        }),
      )

      await useRecentPagesStore.persist.rehydrate()

      const state = useRecentPagesStore.getState()
      // Only the two valid flat entries survive; garbage optionals are stripped.
      expect(state.recentPages).toEqual([
        { pageId: 'A', title: 'Alpha' },
        { pageId: 'C', title: 'Charlie' },
      ])
      // bad-space dropped; space-1's malformed entry dropped.
      expect(Object.keys(state.recentPagesBySpace)).toEqual(['space-1'])
      expect(state.recentPagesBySpace['space-1']).toEqual([{ pageId: 'S1', title: 'Slice One' }])
    })

    it('coerces a non-array recentPages to an empty list via merge', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: { recentPages: 'corrupt', recentPagesBySpace: {} },
          version: 1,
        }),
      )

      await useRecentPagesStore.persist.rehydrate()

      expect(useRecentPagesStore.getState().recentPages).toEqual([])
    })

    it('coerces malformed entries via the migrate path (version mismatch)', async () => {
      // version: 0 != options.version (1), so zustand runs `migrate`. The flat
      // list is seeded into the `__legacy__` slot, and garbage entries dropped.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            recentPages: [
              { pageId: 'A', title: 'Alpha' },
              { pageId: 'B' }, // dropped
              'garbage',
            ],
          },
          version: 0,
        }),
      )

      await useRecentPagesStore.persist.rehydrate()

      const state = useRecentPagesStore.getState()
      expect(state.recentPages).toEqual([{ pageId: 'A', title: 'Alpha' }])
      // v0→v1: flat list seeded into the __legacy__ per-space slot.
      expect(state.recentPagesBySpace['__legacy__']).toEqual([{ pageId: 'A', title: 'Alpha' }])
    })

    it('leaves a valid blob unchanged round-tripping through merge', async () => {
      const validPages = [
        { pageId: 'A', title: 'Alpha', visitedAt: '2026-01-01T00:00:00.000Z', pinned: true },
        { pageId: 'B', title: 'Bravo' },
      ]
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            recentPages: validPages,
            recentPagesBySpace: { 'space-1': validPages },
            rawKeysMerged: true,
          },
          version: 1,
        }),
      )

      await useRecentPagesStore.persist.rehydrate()

      const state = useRecentPagesStore.getState()
      expect(state.recentPages).toEqual(validPages)
      expect(state.recentPagesBySpace['space-1']).toEqual(validPages)
    })
  })
})
