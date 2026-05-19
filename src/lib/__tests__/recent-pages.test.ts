/**
 * Tests for `recent-pages` — localStorage-backed list of recently visited pages.
 *
 * Validates:
 *  - `getRecentPages()` returns [] when storage is empty
 *  - `getRecentPages()` parses stored entries
 *  - `addRecentPage()` prepends new entries
 *  - `addRecentPage()` moves an existing page to the top (LRU) and drops duplicates
 *  - The list is capped at MAX_RECENT (10) entries; oldest entries are evicted
 *  - Malformed JSON in localStorage is silently tolerated
 *  - Non-array JSON in localStorage is silently tolerated
 *  - State persists across getRecentPages calls
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetMigrationFlagForTests,
  addRecentPage,
  getRecentPages,
  removeRecentPage,
  togglePinRecentPage,
} from '../recent-pages'

// Per FEAT-3 Phase 3 the key is namespaced by the active space. Tests run
// with `useSpaceStore.currentSpaceId == null`, so the active-space slot is
// `__legacy__`.
const STORAGE_KEY = 'recent_pages:__legacy__'
const LEGACY_UNSCOPED_KEY = 'recent_pages'
const MAX_RECENT = 10

beforeEach(() => {
  localStorage.clear()
  // Reset the one-shot migration guard so each test starts from a
  // clean slate (otherwise the first test to trigger migration shuts
  // it off for the rest of the file).
  __resetMigrationFlagForTests()
})

describe('recent-pages', () => {
  describe('getRecentPages', () => {
    it('returns empty array when storage is empty', () => {
      expect(getRecentPages()).toEqual([])
    })

    it('parses a stored entry', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: 'PAGE_A', title: 'First', visitedAt: '2026-01-01T00:00:00.000Z' }]),
      )
      expect(getRecentPages()).toEqual([
        { id: 'PAGE_A', title: 'First', visitedAt: '2026-01-01T00:00:00.000Z' },
      ])
    })

    it('returns empty array when storage contains malformed JSON', () => {
      localStorage.setItem(STORAGE_KEY, '{not json')
      expect(getRecentPages()).toEqual([])
    })

    it('returns empty array when stored value is not an array', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'foo' }))
      expect(getRecentPages()).toEqual([])
    })

    it('returns empty array when stored value is a JSON null', () => {
      localStorage.setItem(STORAGE_KEY, 'null')
      expect(getRecentPages()).toEqual([])
    })

    it('drops entries missing required fields', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: 'A', title: 'X', visitedAt: '2026-01-01' },
          { id: 'B' },
          { title: 'Y', visitedAt: '2026' },
        ]),
      )
      expect(getRecentPages()).toEqual([{ id: 'A', title: 'X', visitedAt: '2026-01-01' }])
    })

    it('drops entries with wrong field types', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: 'A', title: 'X', visitedAt: '2026-01-01' },
          { id: 123, title: 'Y', visitedAt: '2026' },
          { id: 'B', title: null, visitedAt: '2026' },
        ]),
      )
      expect(getRecentPages()).toEqual([{ id: 'A', title: 'X', visitedAt: '2026-01-01' }])
    })

    it('returns empty array when all entries are malformed', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([{}, { bogus: true }, null, 'string']))
      expect(getRecentPages()).toEqual([])
    })
  })

  describe('addRecentPage', () => {
    it('prepends a new page with a current timestamp', () => {
      const before = new Date().toISOString()
      addRecentPage('PAGE_A', 'First')
      const after = new Date().toISOString()

      const pages = getRecentPages()
      expect(pages).toHaveLength(1)
      expect(pages[0]?.id).toBe('PAGE_A')
      expect(pages[0]?.title).toBe('First')
      // visitedAt lies between before and after (inclusive)
      const visitedAt = pages[0]?.visitedAt
      expect(visitedAt).toBeDefined()
      if (visitedAt !== undefined) {
        expect(visitedAt >= before).toBe(true)
        expect(visitedAt <= after).toBe(true)
      }
    })

    it('adding the same page again moves it to the top and updates visitedAt', () => {
      // fake timers: deterministic visitedAt ordering — Date.now has millisecond
      // precision, so two real-time-adjacent addRecentPage calls can share the
      // same timestamp string and break the strict-greater-than comparison below.
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        addRecentPage('PAGE_A', 'First')
        addRecentPage('PAGE_B', 'Second')

        const prev = getRecentPages()[1]?.visitedAt

        vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
        addRecentPage('PAGE_A', 'First (revisited)')

        const pages = getRecentPages()
        expect(pages).toHaveLength(2)
        expect(pages[0]?.id).toBe('PAGE_A')
        expect(pages[0]?.title).toBe('First (revisited)')
        expect(pages[1]?.id).toBe('PAGE_B')
        // Latest visit has a strictly newer timestamp than the earlier one
        expect(pages[0]?.visitedAt).toBeDefined()
        expect(prev).toBeDefined()
        if (pages[0] && prev !== undefined) {
          expect(pages[0].visitedAt > prev).toBe(true)
        }
      } finally {
        vi.useRealTimers()
      }
    })

    it('orders pages most-recent first', () => {
      addRecentPage('PAGE_A', 'A')
      addRecentPage('PAGE_B', 'B')
      addRecentPage('PAGE_C', 'C')

      const ids = getRecentPages().map((p) => p.id)
      expect(ids).toEqual(['PAGE_C', 'PAGE_B', 'PAGE_A'])
    })

    it('caps the list at MAX_RECENT entries, evicting oldest', () => {
      // Add MAX_RECENT + 3 entries
      for (let i = 0; i < MAX_RECENT + 3; i++) {
        addRecentPage(`PAGE_${i}`, `Title ${i}`)
      }

      const pages = getRecentPages()
      expect(pages).toHaveLength(MAX_RECENT)

      // The most-recent entry is PAGE_(MAX_RECENT + 2)
      expect(pages[0]?.id).toBe(`PAGE_${MAX_RECENT + 2}`)
      // The oldest entries (PAGE_0, PAGE_1, PAGE_2) have been evicted
      const ids = pages.map((p) => p.id)
      expect(ids).not.toContain('PAGE_0')
      expect(ids).not.toContain('PAGE_1')
      expect(ids).not.toContain('PAGE_2')
      // The oldest surviving entry is PAGE_3
      expect(pages[pages.length - 1]?.id).toBe('PAGE_3')
    })

    it('persists state across multiple getRecentPages calls', () => {
      addRecentPage('PAGE_A', 'First')
      addRecentPage('PAGE_B', 'Second')

      const first = getRecentPages()
      const second = getRecentPages()
      expect(first).toEqual(second)
    })

    it('writes serialized JSON to localStorage', () => {
      addRecentPage('PAGE_A', 'First')

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].id).toBe('PAGE_A')
      expect(parsed[0].title).toBe('First')
    })

    it('deduplicates when the same id is added with a new title', () => {
      addRecentPage('PAGE_A', 'Old title')
      addRecentPage('PAGE_A', 'New title')

      const pages = getRecentPages()
      expect(pages).toHaveLength(1)
      expect(pages[0]?.title).toBe('New title')
    })

    it('does not crash on localStorage quota errors', () => {
      const orig = Storage.prototype.setItem
      Storage.prototype.setItem = vi.fn(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      })
      try {
        expect(() => addRecentPage('PAGE_A', 'First')).not.toThrow()
      } finally {
        Storage.prototype.setItem = orig
      }
    })
  })

  describe('legacy-key migration', () => {
    it('moves a pre-FEAT-3 unscoped `recent_pages` entry into the `__legacy__` slot on first read', () => {
      const raw = JSON.stringify([
        { id: 'OLD_A', title: 'From before', visitedAt: '2024-01-01T00:00:00.000Z' },
      ])
      localStorage.setItem(LEGACY_UNSCOPED_KEY, raw)

      const pages = getRecentPages()

      expect(pages).toEqual([
        { id: 'OLD_A', title: 'From before', visitedAt: '2024-01-01T00:00:00.000Z' },
      ])
      // Migrated INTO the legacy slot…
      expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
      // …and the old unscoped key is removed.
      expect(localStorage.getItem(LEGACY_UNSCOPED_KEY)).toBeNull()
    })

    it('does NOT clobber an existing `__legacy__` slot with stale unscoped data', () => {
      const fresh = JSON.stringify([
        { id: 'NEW', title: 'Fresh', visitedAt: '2026-01-01T00:00:00.000Z' },
      ])
      const stale = JSON.stringify([
        { id: 'OLD', title: 'Stale', visitedAt: '2024-01-01T00:00:00.000Z' },
      ])
      localStorage.setItem(STORAGE_KEY, fresh)
      localStorage.setItem(LEGACY_UNSCOPED_KEY, stale)

      const pages = getRecentPages()

      // Fresh data wins.
      expect(pages).toEqual([{ id: 'NEW', title: 'Fresh', visitedAt: '2026-01-01T00:00:00.000Z' }])
      // The unscoped key is still cleared (it was migrated away — its
      // data is just not the source of truth).
      expect(localStorage.getItem(LEGACY_UNSCOPED_KEY)).toBeNull()
    })

    it('is idempotent: re-running migration is a no-op once the unscoped key is gone', () => {
      localStorage.setItem(
        LEGACY_UNSCOPED_KEY,
        JSON.stringify([{ id: 'OLD', title: 'Stale', visitedAt: '2024-01-01T00:00:00.000Z' }]),
      )
      // First read migrates.
      getRecentPages()
      __resetMigrationFlagForTests()
      // Second read should find nothing to migrate (legacy key cleared).
      expect(() => getRecentPages()).not.toThrow()
      expect(localStorage.getItem(LEGACY_UNSCOPED_KEY)).toBeNull()
    })

    it('survives a localStorage that throws during migration', () => {
      const orig = Storage.prototype.getItem
      Storage.prototype.getItem = vi.fn(() => {
        throw new DOMException('SecurityError', 'SecurityError')
      })
      try {
        expect(() => getRecentPages()).not.toThrow()
      } finally {
        Storage.prototype.getItem = orig
      }
    })
  })

  describe('pinning (PEND-67 Phase 4)', () => {
    it('togglePinRecentPage flips an existing entry to pinned', () => {
      addRecentPage('PAGE_A', 'Alpha')
      expect(togglePinRecentPage('PAGE_A')).toBe(true)
      const first = getRecentPages()[0]
      expect(first?.id).toBe('PAGE_A')
      expect(first?.pinned).toBe(true)
    })

    it('togglePinRecentPage returns null for an unknown id', () => {
      expect(togglePinRecentPage('PAGE_GHOST')).toBeNull()
    })

    it('pinned entries sort before unpinned entries', () => {
      addRecentPage('PAGE_A', 'Alpha')
      addRecentPage('PAGE_B', 'Bravo')
      addRecentPage('PAGE_C', 'Charlie')
      // Pin the OLDEST entry; it should jump to position 0.
      togglePinRecentPage('PAGE_A')
      expect(getRecentPages().map((p) => p.id)).toEqual(['PAGE_A', 'PAGE_C', 'PAGE_B'])
    })

    it('unpinning re-stamps visitedAt to now (so the entry lands at top of the unpinned partition)', () => {
      addRecentPage('PAGE_A', 'Alpha')
      togglePinRecentPage('PAGE_A')
      // Add another entry so unpinning has somewhere to slot in.
      addRecentPage('PAGE_B', 'Bravo')
      expect(getRecentPages().map((p) => p.id)).toEqual(['PAGE_A', 'PAGE_B'])

      togglePinRecentPage('PAGE_A')
      // PAGE_A is unpinned now; its re-stamped visitedAt puts it at
      // the top of the unpinned partition (before PAGE_B which was
      // added earlier in real wall time).
      const result = getRecentPages()
      expect(result[0]?.pinned).toBeUndefined()
      expect(result.map((p) => p.id)).toEqual(['PAGE_A', 'PAGE_B'])
    })

    it('pinned entries are not counted against the MAX_RECENT cap', () => {
      // Add 3 pinned + (MAX_RECENT + 5) unpinned entries.
      for (let i = 0; i < 3; i++) {
        addRecentPage(`PINNED_${i}`, `Pinned ${i}`)
        togglePinRecentPage(`PINNED_${i}`)
      }
      for (let i = 0; i < MAX_RECENT + 5; i++) {
        addRecentPage(`UNPINNED_${i}`, `Unpinned ${i}`)
      }
      const result = getRecentPages()
      // All 3 pinned entries are retained.
      const pinned = result.filter((p) => p.pinned === true)
      expect(pinned.length).toBe(3)
      // Unpinned is capped at MAX_RECENT.
      const unpinned = result.filter((p) => p.pinned !== true)
      expect(unpinned.length).toBe(MAX_RECENT)
    })

    it('re-adding a pinned page preserves the pinned flag', () => {
      addRecentPage('PAGE_A', 'Alpha')
      togglePinRecentPage('PAGE_A')
      addRecentPage('PAGE_A', 'Alpha (updated title)')
      const result = getRecentPages()
      expect(result[0]?.id).toBe('PAGE_A')
      expect(result[0]?.pinned).toBe(true)
      expect(result[0]?.title).toBe('Alpha (updated title)')
    })
  })

  describe('removeRecentPage (PEND-67 Phase 5 follow-up)', () => {
    it('removes a matching entry and returns true', () => {
      addRecentPage('PAGE_A', 'Alpha')
      addRecentPage('PAGE_B', 'Bravo')
      expect(removeRecentPage('PAGE_A')).toBe(true)
      expect(getRecentPages().map((p) => p.id)).toEqual(['PAGE_B'])
    })

    it('returns false when the id is not present', () => {
      addRecentPage('PAGE_A', 'Alpha')
      expect(removeRecentPage('PAGE_GHOST')).toBe(false)
      expect(getRecentPages().map((p) => p.id)).toEqual(['PAGE_A'])
    })

    it('removes a pinned entry too (pin status does not block removal)', () => {
      addRecentPage('PAGE_A', 'Alpha')
      togglePinRecentPage('PAGE_A')
      expect(removeRecentPage('PAGE_A')).toBe(true)
      expect(getRecentPages()).toEqual([])
    })
  })
})
