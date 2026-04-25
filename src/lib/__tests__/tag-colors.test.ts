/**
 * Tests for tag-colors localStorage helpers.
 *
 * Validates:
 *  - getTagColors / getTagColor / setTagColor / clearTagColor round-trip
 *    through localStorage under the `tag-colors` key.
 *  - Graceful handling of missing / corrupted / non-object data.
 *  - Regression guard (MAINT-101): tag color reads and writes are
 *    *device-local only*. setTagColor / clearTagColor must not call the
 *    Tauri `invoke()` IPC bridge — the previous header comment in
 *    `tag-colors.ts` claimed colors were also persisted to block properties
 *    via `setProperty()` for cross-device sync, but no such call exists.
 *    This test fails loudly if anyone reintroduces a sync claim without
 *    actually wiring the IPC call (or vice-versa).
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTagColor, getTagColor, getTagColors, setTagColor } from '../tag-colors'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  localStorage.removeItem('tag-colors')
  vi.clearAllMocks()
})

describe('tag-colors', () => {
  describe('getTagColors', () => {
    it('returns empty object when no data is stored', () => {
      expect(getTagColors()).toEqual({})
    })

    it('returns persisted map of tag IDs to colors', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ TAG1: '#ef4444', TAG2: '#22c55e' }))
      expect(getTagColors()).toEqual({ TAG1: '#ef4444', TAG2: '#22c55e' })
    })

    it('returns empty object for invalid JSON', () => {
      localStorage.setItem('tag-colors', 'not-json')
      expect(getTagColors()).toEqual({})
    })

    it('returns empty object for non-object JSON (array)', () => {
      localStorage.setItem('tag-colors', JSON.stringify(['#ef4444']))
      expect(getTagColors()).toEqual({})
    })

    it('returns empty object for non-object JSON (null)', () => {
      localStorage.setItem('tag-colors', JSON.stringify(null))
      expect(getTagColors()).toEqual({})
    })

    it('filters out non-string color values', () => {
      localStorage.setItem(
        'tag-colors',
        JSON.stringify({ TAG1: '#ef4444', TAG2: 42, TAG3: null, TAG4: '#22c55e' }),
      )
      expect(getTagColors()).toEqual({ TAG1: '#ef4444', TAG4: '#22c55e' })
    })
  })

  describe('getTagColor', () => {
    it('returns undefined when tag has no color set', () => {
      expect(getTagColor('TAG1')).toBeUndefined()
    })

    it('returns the color for a stored tag', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ TAG1: '#ef4444' }))
      expect(getTagColor('TAG1')).toBe('#ef4444')
    })
  })

  describe('setTagColor', () => {
    it('writes the color to localStorage under the `tag-colors` key', () => {
      setTagColor('TAG1', '#ef4444')
      const raw = localStorage.getItem('tag-colors')
      expect(raw).toBe(JSON.stringify({ TAG1: '#ef4444' }))
    })

    it('preserves existing entries when adding a new color', () => {
      setTagColor('TAG1', '#ef4444')
      setTagColor('TAG2', '#22c55e')
      expect(getTagColors()).toEqual({ TAG1: '#ef4444', TAG2: '#22c55e' })
    })

    it('overwrites the color for an existing tag', () => {
      setTagColor('TAG1', '#ef4444')
      setTagColor('TAG1', '#22c55e')
      expect(getTagColor('TAG1')).toBe('#22c55e')
    })
  })

  describe('clearTagColor', () => {
    it('removes the color for the given tag', () => {
      setTagColor('TAG1', '#ef4444')
      setTagColor('TAG2', '#22c55e')
      clearTagColor('TAG1')
      expect(getTagColors()).toEqual({ TAG2: '#22c55e' })
    })

    it('is a no-op when the tag has no color', () => {
      clearTagColor('TAG1')
      expect(getTagColors()).toEqual({})
    })
  })

  describe('device-local only (MAINT-101 regression guard)', () => {
    // Tag colors are intentionally device-local. The header comment in
    // `tag-colors.ts` previously claimed colors were also persisted via
    // `setProperty()` for cross-device sync — that claim was wrong. If
    // anyone reintroduces a property-sync write here without updating both
    // the implementation AND the header comment, this test fails. To ship
    // real cross-device sync, see the "Future work" note in tag-colors.ts.

    it('setTagColor does not call the Tauri invoke() IPC bridge', () => {
      setTagColor('TAG1', '#ef4444')
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('clearTagColor does not call the Tauri invoke() IPC bridge', () => {
      setTagColor('TAG1', '#ef4444')
      vi.clearAllMocks()
      clearTagColor('TAG1')
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('getTagColor / getTagColors do not call the Tauri invoke() IPC bridge', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ TAG1: '#ef4444' }))
      getTagColors()
      getTagColor('TAG1')
      expect(mockedInvoke).not.toHaveBeenCalled()
    })
  })
})
