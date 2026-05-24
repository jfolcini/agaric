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
  coerceBySpace,
  LEGACY_HISTORY_SPACE_KEY,
  MAX_HISTORY,
  selectHistoryForSpace,
  useSearchHistoryStore,
} from '../search-history'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'

describe('useSearchHistoryStore', () => {
  beforeEach(() => {
    useSearchHistoryStore.setState({ bySpace: {}, historyEnabled: true })
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

  // UX-11 — per-row delete.
  it('removeEntry drops a single query, leaving siblings + other spaces intact', () => {
    const { push, removeEntry } = useSearchHistoryStore.getState()
    push(SPACE_A, 'alpha')
    push(SPACE_A, 'beta')
    push(SPACE_A, 'gamma')
    push(SPACE_B, 'beta')
    removeEntry(SPACE_A, 'beta')
    const state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['gamma', 'alpha'])
    // The identically-named entry in another space is untouched.
    expect(selectHistoryForSpace(state, SPACE_B)).toEqual(['beta'])
  })

  it('removeEntry is a no-op (stable reference) when the query is absent', () => {
    const { push, removeEntry } = useSearchHistoryStore.getState()
    push(SPACE_A, 'alpha')
    const before = useSearchHistoryStore.getState().bySpace
    removeEntry(SPACE_A, 'not-present')
    expect(useSearchHistoryStore.getState().bySpace).toBe(before)
  })

  // UX-11 — record-history toggle.
  it('push becomes a no-op while history is disabled, and resumes when re-enabled', () => {
    const { push, setHistoryEnabled } = useSearchHistoryStore.getState()
    push(SPACE_A, 'before')
    setHistoryEnabled(false)
    push(SPACE_A, 'while-off')
    let state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['before'])
    setHistoryEnabled(true)
    push(SPACE_A, 'after')
    state = useSearchHistoryStore.getState()
    expect(selectHistoryForSpace(state, SPACE_A)).toEqual(['after', 'before'])
  })
})

// FE-14 — corrupt-payload coercion on hydrate.
describe('coerceBySpace', () => {
  it('returns {} for non-object inputs', () => {
    expect(coerceBySpace(null)).toEqual({})
    expect(coerceBySpace(undefined)).toEqual({})
    expect(coerceBySpace('nope')).toEqual({})
    expect(coerceBySpace(42)).toEqual({})
    expect(coerceBySpace(['a', 'b'])).toEqual({})
  })

  it('drops keys whose value is not an array', () => {
    expect(coerceBySpace({ A: 'oops', B: ['ok'] })).toEqual({ B: ['ok'] })
  })

  it('drops non-string, empty, whitespace-only and duplicate entries', () => {
    expect(coerceBySpace({ A: ['keep', 1, '', '   ', 'keep', null, 'second'] })).toEqual({
      A: ['keep', 'second'],
    })
  })

  it('trims entries and omits keys that end up empty', () => {
    expect(coerceBySpace({ A: ['  spaced  '], B: [42, null] })).toEqual({ A: ['spaced'] })
  })

  it('clamps each space to MAX_HISTORY entries', () => {
    const many = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => `q${i}`)
    expect(coerceBySpace({ A: many })['A']).toHaveLength(MAX_HISTORY)
  })
})

// FE-14 — `migrate` hydration seam. The persist `migrate` callback runs
// before merge on every load; it must coerce `bySpace` *and* fall back to
// `historyEnabled: true` for corrupt / missing persisted toggle values
// (and preserve a legitimate `false`).
describe('persist migrate — historyEnabled fallback', () => {
  // `migrate` is wired into the persist middleware (not exported), so we
  // reach it through the same public seam zustand uses on rehydrate.
  const migrate = useSearchHistoryStore.persist.getOptions().migrate

  it('is wired into the persist options', () => {
    expect(typeof migrate).toBe('function')
  })

  it('falls back to true when persisted historyEnabled is a non-boolean', () => {
    const result = migrate?.({ bySpace: {}, historyEnabled: 'yes' }, 0) as {
      historyEnabled: boolean
    }
    expect(result.historyEnabled).toBe(true)
  })

  it('falls back to true when historyEnabled is missing from the blob', () => {
    const result = migrate?.({ bySpace: {} }, 0) as { historyEnabled: boolean }
    expect(result.historyEnabled).toBe(true)
  })

  it('preserves a legitimately-persisted historyEnabled: false', () => {
    const result = migrate?.({ bySpace: {}, historyEnabled: false }, 0) as {
      historyEnabled: boolean
    }
    expect(result.historyEnabled).toBe(false)
  })
})
