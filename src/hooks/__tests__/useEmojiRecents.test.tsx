// @vitest-environment jsdom
// Spies on `Storage.prototype.*` don't intercept under happy-dom; this hook is
// localStorage-backed, so pin to jsdom (same rationale as
// useLocalStoragePreference.test.tsx).

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearEmojiRecents,
  EMOJI_FREQUENCY_KEY,
  EMOJI_RECENTS_KEY,
  MAX_EMOJI_FREQUENCY,
  pushEmojiRecent,
  useEmojiRecents,
} from '../useEmojiRecents'

beforeEach(() => {
  localStorage.clear()
  // Reset the module-level snapshot shared across mounts/tests.
  clearEmojiRecents()
  localStorage.clear()
})

afterEach(() => {
  clearEmojiRecents()
  localStorage.clear()
})

describe('useEmojiRecents (frequently-used)', () => {
  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.frequent).toEqual([])
  })

  it('pushes an emoji and persists the frequency map', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push('\u{1F600}'))
    expect(result.current.frequent[0]).toBe('\u{1F600}')
    const stored = JSON.parse(localStorage.getItem(EMOJI_FREQUENCY_KEY) ?? '{}')
    expect(stored['\u{1F600}']?.n).toBe(1)
  })

  it('ranks by use COUNT, not recency — a more-used emoji stays ahead of a one-off', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => {
      result.current.push('\u{1F600}') // used 3x
      result.current.push('\u{1F44D}')
      result.current.push('\u{1F600}')
      result.current.push('\u{1F600}')
      result.current.push('\u{1F44D}') // used 2x, more RECENT than the last 😀
    })
    // Strict-MRU would put 👍 first; frequency keeps the 3×-used 😀 ahead.
    expect(result.current.frequent).toEqual(['\u{1F600}', '\u{1F44D}'])
  })

  it('breaks equal counts by most-recently-used', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => {
      result.current.push('\u{1F600}') // count 1, older
      result.current.push('\u{1F44D}') // count 1, newer
    })
    expect(result.current.frequent).toEqual(['\u{1F44D}', '\u{1F600}'])
  })

  it('caps the stored map at MAX_EMOJI_FREQUENCY', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => {
      for (let i = 0; i < MAX_EMOJI_FREQUENCY + 5; i++) {
        result.current.push(String.fromCodePoint(0x1f600 + i))
      }
    })
    expect(result.current.frequent).toHaveLength(MAX_EMOJI_FREQUENCY)
  })

  it('ignores an empty push', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push(''))
    expect(result.current.frequent).toEqual([])
  })

  it('clears the list', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push('\u{1F600}'))
    act(() => result.current.clear())
    expect(result.current.frequent).toEqual([])
  })

  it('shares state across two mounted consumers', () => {
    const a = renderHook(() => useEmojiRecents())
    const b = renderHook(() => useEmojiRecents())
    act(() => a.result.current.push('\u{1F680}'))
    expect(b.result.current.frequent[0]).toBe('\u{1F680}')
  })

  it('migrates a pre-existing legacy MRU array, most-recent first', () => {
    localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(['\u{2705}', '\u{1F525}']))
    const { result } = renderHook(() => useEmojiRecents())
    // Legacy order is preserved as the recency tiebreak (all seeded at count 1).
    expect(result.current.frequent).toEqual(['\u{2705}', '\u{1F525}'])
  })

  it('hydrates from a stored frequency map (highest count first)', () => {
    localStorage.setItem(
      EMOJI_FREQUENCY_KEY,
      JSON.stringify({ '\u{2705}': { n: 1, t: 100 }, '\u{1F525}': { n: 5, t: 50 } }),
    )
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.frequent).toEqual(['\u{1F525}', '\u{2705}'])
  })

  it('falls back to empty on a corrupted stored blob', () => {
    localStorage.setItem(EMOJI_FREQUENCY_KEY, 'not json{')
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.frequent).toEqual([])
  })

  it('exposes a standalone pushEmojiRecent that feeds mounted hooks', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => pushEmojiRecent('\u{1F389}'))
    expect(result.current.frequent[0]).toBe('\u{1F389}')
  })

  // Regression: the `subscribe` storage-listener must not leak with
  // OVERLAPPING subscribers. The bug (PR #319 review) created a fresh
  // `onStorage` closure per subscribe but only the first attached; the last
  // unsubscribe called `removeEventListener` with a *different* closure
  // identity, so it silently no-op'd and leaked the originally-attached
  // handler. Two concurrently-mounted hooks expose the mismatch (sequential
  // mount/unmount pairs would each match their own closure and hide it).
  it('detaches the same storage listener it attached (no leak with overlapping subscribers)', () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    try {
      const a = renderHook(() => useEmojiRecents())
      const b = renderHook(() => useEmojiRecents()) // overlapping: listeners size 2
      a.unmount() // size 1 → no detach
      b.unmount() // size 0 → detach

      const storageAdds = added.mock.calls.filter(([type]) => type === 'storage')
      const storageRemoves = removed.mock.calls.filter(([type]) => type === 'storage')
      expect(storageAdds).toHaveLength(1)
      expect(storageRemoves).toHaveLength(1)
      const attached = storageAdds[0]?.[1]
      const detached = storageRemoves[0]?.[1]
      expect(attached).toBeTypeOf('function')
      expect(detached).toBe(attached)
    } finally {
      added.mockRestore()
      removed.mockRestore()
    }
  })
})
