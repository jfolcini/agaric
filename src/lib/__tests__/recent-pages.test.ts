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

import { beforeEach, describe, expect, it } from 'vitest'
import { addRecentPage, getRecentPages } from '../recent-pages'

const STORAGE_KEY = 'recent_pages'
const MAX_RECENT = 10

beforeEach(() => {
  localStorage.clear()
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

    it('adding the same page again moves it to the top and updates visitedAt', async () => {
      addRecentPage('PAGE_A', 'First')
      addRecentPage('PAGE_B', 'Second')
      // Ensure visitedAt changes (Date.now has millisecond precision)
      await new Promise((r) => setTimeout(r, 5))
      const prev = getRecentPages()[1]?.visitedAt
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
  })
})
