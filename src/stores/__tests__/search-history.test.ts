/**
 * PEND-55 — tests for the search-history Zustand store.
 *
 * Coverage:
 * - `push` prepends to the MRU list, deduping by exact match.
 * - `push` caps at `MAX_HISTORY` (20).
 * - `push` ignores empty / whitespace-only queries.
 * - `clear` empties the active-space slot without touching others.
 * - Per-space partitioning: a push in space-A is invisible from
 *   space-B's selector.
 * - Legacy partition fires when no space id is supplied.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_HISTORY_SPACE_KEY,
  MAX_HISTORY,
  selectHistoryForSpace,
  useSearchHistoryStore,
} from '../search-history'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'

describe('useSearchHistoryStore', () => {
  beforeEach(() => {
    useSearchHistoryStore.setState({ bySpace: {} })
    localStorage.clear()
  })

  it('starts empty for every space', () => {
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual([])
    expect(selectHistoryForSpace(state, null)).toEqual([])
  })

  it('push prepends the query to the active-space MRU list', () => {
    const { push } = useSearchHistoryStore.getState()
    push(SPACE_A, 'alpha')
    push(SPACE_A, 'beta')
    push(SPACE_A, 'gamma')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('push dedupes — re-submitting an existing query moves it to the front', () => {
    const { push } = useSearchHistoryStore.getState()
    push(SPACE_A, 'alpha')
    push(SPACE_A, 'beta')
    push(SPACE_A, 'alpha')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['alpha', 'beta'])
  })

  it('push caps at MAX_HISTORY entries', () => {
    const { push } = useSearchHistoryStore.getState()
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      push(SPACE_A, `q${i}`)
    }
    const state = useSearchHistoryStore.getState()
    const list = selectHistoryForSpace(state, SPACE_A)
    expect(list).toHaveLength(MAX_HISTORY)
    // The newest entry is `q24` (since we pushed 25 entries); the
    // oldest retained is `q5`.
    expect(list[0]).toBe(`q${MAX_HISTORY + 4}`)
    expect(list[list.length - 1]).toBe(`q5`)
  })

  it('push ignores empty / whitespace-only queries', () => {
    const { push } = useSearchHistoryStore.getState()
    push(SPACE_A, '')
    push(SPACE_A, '   ')
    push(SPACE_A, '\t\n')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual([])
  })

  it('push trims surrounding whitespace before storing', () => {
    const { push } = useSearchHistoryStore.getState()
    push(SPACE_A, '  alpha  ')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['alpha'])
  })

  it('clear empties only the named space', () => {
    const { push, clear } = useSearchHistoryStore.getState()
    push(SPACE_A, 'a1')
    push(SPACE_B, 'b1')
    clear(SPACE_A)
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual([])
    expect(selectHistoryForSpace(state, SPACE_B)).toEqual(['b1'])
  })

  it('partitions entries per space — a push in A is invisible from B', () => {
    const { push } = useSearchHistoryStore.getState()
    push(SPACE_A, 'private-A')
    push(SPACE_B, 'private-B')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['private-A'])
    expect(selectHistoryForSpace(state, SPACE_B)).toEqual(['private-B'])
  })

  it('routes null / undefined spaceId to the legacy partition', () => {
    const { push } = useSearchHistoryStore.getState()
    push(null, 'no-space')
    push(undefined, 'also-no-space')
    const state = useSearchHistoryStore.getState()
    expect(state.bySpace[LEGACY_HISTORY_SPACE_KEY]).toEqual(['also-no-space', 'no-space'])
  })
})
