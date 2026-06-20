/**
 * Tests for `path-history` — per-space MRU of path-glob strings used in the
 * Search input's caret-anchored autocomplete (Phase 2).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearPathHistory,
  getPathHistory,
  PATH_HISTORY_LIMIT,
  recordPathHistory,
} from '../path-history'

const KEY_PREFIX = 'agaric:pathHistory:v1:'

beforeEach(() => {
  localStorage.clear()
})

describe('path-history', () => {
  it('returns [] for an unknown space', () => {
    expect(getPathHistory('SPACE_A')).toEqual([])
  })

  it('records a single glob', () => {
    recordPathHistory('SPACE_A', 'Journal/*')
    expect(getPathHistory('SPACE_A')).toEqual(['Journal/*'])
  })

  it('returns entries newest-first', () => {
    recordPathHistory('SPACE_A', 'A/*')
    recordPathHistory('SPACE_A', 'B/*')
    recordPathHistory('SPACE_A', 'C/*')
    expect(getPathHistory('SPACE_A')).toEqual(['C/*', 'B/*', 'A/*'])
  })

  it('deduplicates by jumping the repeated entry to the top', () => {
    recordPathHistory('SPACE_A', 'Alpha')
    recordPathHistory('SPACE_A', 'Bravo')
    recordPathHistory('SPACE_A', 'Alpha')
    expect(getPathHistory('SPACE_A')).toEqual(['Alpha', 'Bravo'])
  })

  it('partitions history per space', () => {
    recordPathHistory('SPACE_A', 'A/*')
    expect(getPathHistory('SPACE_B')).toEqual([])

    recordPathHistory('SPACE_B', 'B/*')
    expect(getPathHistory('SPACE_A')).toEqual(['A/*'])
    expect(getPathHistory('SPACE_B')).toEqual(['B/*'])
  })

  it('trims to PATH_HISTORY_LIMIT entries, dropping the oldest', () => {
    for (let i = 0; i < PATH_HISTORY_LIMIT + 5; i++) {
      recordPathHistory('SPACE_A', `glob-${i}`)
    }
    const history = getPathHistory('SPACE_A')
    expect(history).toHaveLength(PATH_HISTORY_LIMIT)
    expect(history[0]).toBe(`glob-${PATH_HISTORY_LIMIT + 4}`)
    expect(history).not.toContain('glob-0')
    expect(history).not.toContain('glob-1')
    expect(history).not.toContain('glob-2')
    expect(history).not.toContain('glob-3')
    expect(history).not.toContain('glob-4')
    expect(history[history.length - 1]).toBe('glob-5')
  })

  it('is a no-op for empty / null space ids and empty / whitespace globs', () => {
    recordPathHistory(null, 'X')
    recordPathHistory('', 'X')
    recordPathHistory('SPACE_A', '')
    recordPathHistory('SPACE_A', '   ')
    recordPathHistory('SPACE_A', '\t\n')

    expect(getPathHistory('SPACE_A')).toEqual([])
    expect(getPathHistory(null)).toEqual([])
    expect(getPathHistory('')).toEqual([])
    // No stray keys created anywhere.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      expect(key?.startsWith(KEY_PREFIX)).not.toBe(true)
    }
  })

  it('clears the MRU for the given space', () => {
    recordPathHistory('SPACE_A', 'A/*')
    recordPathHistory('SPACE_A', 'B/*')
    clearPathHistory('SPACE_A')
    expect(getPathHistory('SPACE_A')).toEqual([])
  })

  it('clear is a no-op for empty / null space ids', () => {
    recordPathHistory('SPACE_A', 'A/*')
    clearPathHistory(null)
    clearPathHistory('')
    expect(getPathHistory('SPACE_A')).toEqual(['A/*'])
  })

  it('rejects single-character / punctuation-only globs as junk', () => {
    recordPathHistory('SPACE_A', 'a')
    recordPathHistory('SPACE_A', '*')
    recordPathHistory('SPACE_A', '/')
    recordPathHistory('SPACE_A', '?')
    expect(getPathHistory('SPACE_A')).toEqual([])

    // Two-character bare words still qualify (substring-match queries).
    recordPathHistory('SPACE_A', 'Wo')
    expect(getPathHistory('SPACE_A')).toEqual(['Wo'])

    // Two-character globs with `/` or `*` qualify.
    recordPathHistory('SPACE_A', 'A/')
    expect(getPathHistory('SPACE_A')).toEqual(['A/', 'Wo'])
    recordPathHistory('SPACE_A', '*B')
    expect(getPathHistory('SPACE_A')).toEqual(['*B', 'A/', 'Wo'])
  })

  it('returns [] when the stored value is corrupted', () => {
    localStorage.setItem(`${KEY_PREFIX}SPACE_A`, '{not json')
    expect(() => getPathHistory('SPACE_A')).not.toThrow()
    expect(getPathHistory('SPACE_A')).toEqual([])

    localStorage.setItem(`${KEY_PREFIX}SPACE_A`, JSON.stringify({ wrong: 'shape' }))
    expect(getPathHistory('SPACE_A')).toEqual([])

    localStorage.setItem(`${KEY_PREFIX}SPACE_A`, 'null')
    expect(getPathHistory('SPACE_A')).toEqual([])

    localStorage.setItem(`${KEY_PREFIX}SPACE_A`, JSON.stringify(['ok', 123, null, 'fine']))
    expect(getPathHistory('SPACE_A')).toEqual(['ok', 'fine'])
  })
})
