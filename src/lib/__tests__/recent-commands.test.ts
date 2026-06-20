/**
 * Tests for `recent-commands` (Phase 2).
 *
 * Validates:
 *  - `getRecentCommands()` returns [] when storage is empty.
 *  - `addRecentCommand()` prepends a new entry.
 *  - `addRecentCommand()` moves an existing id to position 0 (LRU dedup).
 *  - List is capped at MAX_RECENT_COMMANDS (5); oldest is evicted.
 * Storage is partitioned by active space (invariant).
 *  - Malformed / non-array JSON tolerated silently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LEGACY_SPACE_KEY, useSpaceStore } from '../../stores/space'
import { addRecentCommand, getRecentCommands } from '../recent-commands'

const LEGACY_STORAGE_KEY = `recent_commands:${LEGACY_SPACE_KEY}`
const MAX = 5

beforeEach(() => {
  localStorage.clear()
  // Tests default to the legacy-space slot (no space selected).
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
  })
})

describe('getRecentCommands', () => {
  it('returns [] when nothing has been stored', () => {
    expect(getRecentCommands()).toEqual([])
  })

  it('returns the parsed entries for the active space', () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    expect(getRecentCommands()).toEqual([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }])
  })

  it('returns [] when the stored JSON is malformed', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, '{not valid json')
    expect(getRecentCommands()).toEqual([])
  })

  it('returns [] when the stored JSON is not an array', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ not: 'an array' }))
    expect(getRecentCommands()).toEqual([])
  })

  it('filters out malformed entries', () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([
        { id: 'go-pages', runAt: '2026-05-19T00:00:00Z' },
        { id: 42, runAt: 'broken' },
        { id: 'go-tags', runAt: '2026-05-19T01:00:00Z' },
      ]),
    )
    const result = getRecentCommands()
    expect(result.map((c) => c.id)).toEqual(['go-pages', 'go-tags'])
  })
})

describe('addRecentCommand', () => {
  it('prepends a new entry to the active-space slot', () => {
    addRecentCommand('go-pages')
    const result = getRecentCommands()
    expect(result.map((c) => c.id)).toEqual(['go-pages'])
    expect(result[0]?.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('moves an existing id to position 0 (LRU dedup)', () => {
    addRecentCommand('go-pages')
    addRecentCommand('go-tags')
    addRecentCommand('go-pages')
    expect(getRecentCommands().map((c) => c.id)).toEqual(['go-pages', 'go-tags'])
  })

  it(`caps the list at ${MAX} entries (oldest evicted)`, () => {
    for (let i = 0; i < MAX + 3; i++) {
      addRecentCommand(`cmd-${i}`)
    }
    const result = getRecentCommands()
    expect(result).toHaveLength(MAX)
    // Newest first: the last 5 ids are cmd-(MAX+2) .. cmd-3
    expect(result[0]?.id).toBe(`cmd-${MAX + 2}`)
    expect(result.at(-1)?.id).toBe('cmd-3')
  })

  it('updates the runAt timestamp when re-adding an existing id', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      addRecentCommand('go-pages')
      const firstRunAt = getRecentCommands()[0]?.runAt ?? ''
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
      addRecentCommand('go-pages')
      const updated = getRecentCommands()[0]?.runAt ?? ''
      expect(updated).not.toBe(firstRunAt)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('space scoping', () => {
  it('keeps each space-scoped slot isolated', () => {
    // Add a command under the legacy slot.
    addRecentCommand('legacy-cmd')
    expect(getRecentCommands().map((c) => c.id)).toEqual(['legacy-cmd'])

    // Switch to SPACE_A and confirm its slot is independent.
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_A',
      availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
      isReady: true,
    })
    expect(getRecentCommands()).toEqual([])

    addRecentCommand('space-a-cmd')
    expect(getRecentCommands().map((c) => c.id)).toEqual(['space-a-cmd'])

    // Switch back to legacy and confirm it still has only the legacy entry.
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })
    expect(getRecentCommands().map((c) => c.id)).toEqual(['legacy-cmd'])

    // SPACE_A's slot is still intact when we hop back.
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_A',
      availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
      isReady: true,
    })
    expect(getRecentCommands().map((c) => c.id)).toEqual(['space-a-cmd'])
  })
})
