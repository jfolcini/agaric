/**
 * Tests for starred-pages localStorage helpers.
 *
 * Validates:
 *  - toggleStarred adds/removes page IDs
 *  - getStarredPages returns the persisted list
 *  - isStarred returns correct boolean
 *  - localStorage integration (persistence across calls)
 *  - Graceful handling of corrupted/missing data
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getStarredPages, isStarred, setStarred, toggleStarred } from '@/lib/starred-pages'

beforeEach(() => {
  localStorage.removeItem('starred-pages')
})

describe('starred-pages', () => {
  describe('getStarredPages', () => {
    it('returns empty array when no data is stored', () => {
      expect(getStarredPages()).toEqual([])
    })

    it('returns persisted list of page IDs', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      expect(getStarredPages()).toEqual(['P1', 'P2'])
    })

    it('returns empty array for invalid JSON', () => {
      localStorage.setItem('starred-pages', 'not-json')
      expect(getStarredPages()).toEqual([])
    })

    it('returns empty array for non-array JSON', () => {
      localStorage.setItem('starred-pages', JSON.stringify({ id: 'P1' }))
      expect(getStarredPages()).toEqual([])
    })

    it('filters out non-string entries', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 42, null, 'P2']))
      expect(getStarredPages()).toEqual(['P1', 'P2'])
    })
  })

  describe('isStarred', () => {
    it('returns false when page is not starred', () => {
      expect(isStarred('P1')).toBe(false)
    })

    it('returns true when page is starred', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      expect(isStarred('P1')).toBe(true)
      expect(isStarred('P2')).toBe(true)
    })

    it('returns false for page not in starred list', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      expect(isStarred('P99')).toBe(false)
    })
  })

  describe('toggleStarred', () => {
    it('adds page ID when not starred', () => {
      toggleStarred('P1')
      expect(getStarredPages()).toEqual(['P1'])
    })

    it('removes page ID when already starred', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      toggleStarred('P1')
      expect(getStarredPages()).toEqual(['P2'])
    })

    it('toggle twice returns to original state', () => {
      toggleStarred('P1')
      expect(isStarred('P1')).toBe(true)
      toggleStarred('P1')
      expect(isStarred('P1')).toBe(false)
      expect(getStarredPages()).toEqual([])
    })

    it('persists across multiple calls', () => {
      toggleStarred('P1')
      toggleStarred('P2')
      toggleStarred('P3')
      expect(getStarredPages()).toEqual(['P1', 'P2', 'P3'])
    })

    it('persists to localStorage', () => {
      toggleStarred('P1')
      const raw = localStorage.getItem('starred-pages')
      expect(raw).toBe(JSON.stringify(['P1']))
    })
  })

  describe('setStarred', () => {
    it('adds every id when starred=true', () => {
      setStarred(['P1', 'P2', 'P3'], true)
      expect(getStarredPages()).toEqual(['P1', 'P2', 'P3'])
    })

    it('removes every id when starred=false', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2', 'P3']))
      setStarred(['P1', 'P3'], false)
      expect(getStarredPages()).toEqual(['P2'])
    })

    it('merges added ids with the existing set without duplicating', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      setStarred(['P2', 'P3'], true)
      expect(getStarredPages()).toEqual(['P1', 'P2', 'P3'])
    })

    it('is idempotent when starring already-starred ids', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      setStarred(['P1', 'P2'], true)
      expect(getStarredPages()).toEqual(['P1', 'P2'])
    })

    it('is idempotent when unstarring absent ids', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      setStarred(['P2', 'P3'], false)
      expect(getStarredPages()).toEqual(['P1'])
    })

    it('dedupes repeated ids within the input', () => {
      setStarred(['P1', 'P1', 'P1'], true)
      expect(getStarredPages()).toEqual(['P1'])
    })

    it('handles an empty list as a no-op', () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      setStarred([], true)
      expect(getStarredPages()).toEqual(['P1'])
      setStarred([], false)
      expect(getStarredPages()).toEqual(['P1'])
    })

    it('writes localStorage exactly once regardless of id count', () => {
      const spy = vi.spyOn(localStorage, 'setItem')
      setStarred(['P1', 'P2', 'P3', 'P4'], true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('starred-pages', JSON.stringify(['P1', 'P2', 'P3', 'P4']))
      spy.mockRestore()
    })
  })
})
