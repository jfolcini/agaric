// @vitest-environment jsdom
// Spies on `Storage.prototype.*` don't intercept under happy-dom; this hook is
// localStorage-backed, so pin to jsdom (same rationale as
// useLocalStoragePreference.test.tsx).

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearEmojiRecents,
  EMOJI_RECENTS_KEY,
  MAX_EMOJI_RECENTS,
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

describe('useEmojiRecents', () => {
  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.recents).toEqual([])
  })

  it('pushes an emoji to the front', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push('\u{1F600}'))
    expect(result.current.recents[0]).toBe('\u{1F600}')
    expect(JSON.parse(localStorage.getItem(EMOJI_RECENTS_KEY) ?? '[]')).toEqual(['\u{1F600}'])
  })

  it('moves a re-used emoji to the front without duplicating', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => {
      result.current.push('\u{1F600}')
      result.current.push('\u{1F44D}')
      result.current.push('\u{1F600}')
    })
    expect(result.current.recents).toEqual(['\u{1F600}', '\u{1F44D}'])
  })

  it('caps the list at MAX_EMOJI_RECENTS', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => {
      for (let i = 0; i < MAX_EMOJI_RECENTS + 5; i++) {
        // Distinct chars via codepoints starting at the smileys block.
        result.current.push(String.fromCodePoint(0x1f600 + i))
      }
    })
    expect(result.current.recents).toHaveLength(MAX_EMOJI_RECENTS)
    // Most-recent first: the last pushed is at the head.
    expect(result.current.recents[0]).toBe(String.fromCodePoint(0x1f600 + MAX_EMOJI_RECENTS + 4))
  })

  it('ignores an empty push', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push(''))
    expect(result.current.recents).toEqual([])
  })

  it('clears the list', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => result.current.push('\u{1F600}'))
    act(() => result.current.clear())
    expect(result.current.recents).toEqual([])
  })

  it('shares state across two mounted consumers', () => {
    const a = renderHook(() => useEmojiRecents())
    const b = renderHook(() => useEmojiRecents())
    act(() => a.result.current.push('\u{1F680}'))
    expect(b.result.current.recents[0]).toBe('\u{1F680}')
  })

  it('hydrates from a pre-existing stored list on mount', () => {
    localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(['\u{2705}', '\u{1F525}']))
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.recents).toEqual(['\u{2705}', '\u{1F525}'])
  })

  it('falls back to empty on a corrupted stored blob', () => {
    localStorage.setItem(EMOJI_RECENTS_KEY, 'not json{')
    const { result } = renderHook(() => useEmojiRecents())
    expect(result.current.recents).toEqual([])
  })

  it('exposes a standalone pushEmojiRecent that feeds mounted hooks', () => {
    const { result } = renderHook(() => useEmojiRecents())
    act(() => pushEmojiRecent('\u{1F389}'))
    expect(result.current.recents[0]).toBe('\u{1F389}')
  })
})
