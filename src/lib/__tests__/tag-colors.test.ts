/**
 * Tests for tag-colors localStorage helpers.
 *
 * Validates:
 *  - getTagColors / getTagColor / setTagColor / clearTagColor round-trip
 *    through localStorage under the `tag-colors` key.
 *  - Graceful handling of missing / corrupted / non-object data.
 *  - These helpers stay off IPC: the best-effort `color` property write lives
 *    in `useTagColors`.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearTagColor,
  getTagColor,
  getTagColors,
  isAccentToken,
  LEGACY_HEX_TO_TOKEN,
  migrateTagColors,
  resolveTagBackground,
  setTagColor,
  TAG_COLOR_PRESETS,
  tagColorStyle,
} from '@/lib/tag-colors'

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
      // Use accent tokens + a custom hex (non-legacy) so the #1099 migration
      // is a no-op and we're testing pure round-trip mechanics.
      localStorage.setItem('tag-colors', JSON.stringify({ TAG1: 'accent-rose', TAG2: '#123456' }))
      expect(getTagColors()).toEqual({ TAG1: 'accent-rose', TAG2: '#123456' })
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
        JSON.stringify({ TAG1: 'accent-rose', TAG2: 42, TAG3: null, TAG4: '#123456' }),
      )
      expect(getTagColors()).toEqual({ TAG1: 'accent-rose', TAG4: '#123456' })
    })
  })

  describe('getTagColor', () => {
    it('returns undefined when tag has no color set', () => {
      expect(getTagColor('TAG1')).toBeUndefined()
    })

    it('returns the color for a stored tag', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ TAG1: 'accent-rose' }))
      expect(getTagColor('TAG1')).toBe('accent-rose')
    })
  })

  describe('setTagColor', () => {
    it('writes the color to localStorage under the `tag-colors` key', () => {
      setTagColor('TAG1', 'accent-rose')
      const raw = localStorage.getItem('tag-colors')
      expect(raw).toBe(JSON.stringify({ TAG1: 'accent-rose' }))
    })

    it('preserves existing entries when adding a new color', () => {
      setTagColor('TAG1', 'accent-rose')
      setTagColor('TAG2', 'accent-emerald')
      expect(getTagColors()).toEqual({ TAG1: 'accent-rose', TAG2: 'accent-emerald' })
    })

    it('overwrites the color for an existing tag', () => {
      setTagColor('TAG1', 'accent-rose')
      setTagColor('TAG1', 'accent-emerald')
      expect(getTagColor('TAG1')).toBe('accent-emerald')
    })
  })

  describe('clearTagColor', () => {
    it('removes the color for the given tag', () => {
      setTagColor('TAG1', 'accent-rose')
      setTagColor('TAG2', 'accent-emerald')
      clearTagColor('TAG1')
      expect(getTagColors()).toEqual({ TAG2: 'accent-emerald' })
    })

    it('is a no-op when the tag has no color', () => {
      clearTagColor('TAG1')
      expect(getTagColors()).toEqual({})
    })
  })

  describe('device-local only (regression guard)', () => {
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

  // #1099 — presets re-keyed onto the themed --accent-* token palette
  describe('TAG_COLOR_PRESETS (accent-token palette, #1099)', () => {
    it('every preset value is an accent-* token, never a raw sRGB hex', () => {
      for (const preset of TAG_COLOR_PRESETS) {
        expect(preset.value).toMatch(/^accent-[a-z]+$/)
        expect(preset.value).not.toMatch(/^#/)
        expect(isAccentToken(preset.value)).toBe(true)
      }
    })

    it('covers the seven themed accent tokens defined in index.css', () => {
      const tokens = TAG_COLOR_PRESETS.map((p) => p.value)
      expect(new Set(tokens)).toEqual(
        new Set([
          'accent-emerald',
          'accent-blue',
          'accent-violet',
          'accent-amber',
          'accent-rose',
          'accent-slate',
          'accent-orange',
        ]),
      )
    })
  })

  describe('resolveTagBackground (#1099)', () => {
    it('resolves an accent token to a themed var(--accent-*) reference', () => {
      expect(resolveTagBackground('accent-rose')).toBe('var(--accent-rose, var(--accent-current))')
      expect(resolveTagBackground('accent-blue')).toBe('var(--accent-blue, var(--accent-current))')
    })

    it('passes a free-form custom hex through verbatim (escape hatch)', () => {
      expect(resolveTagBackground('#123456')).toBe('#123456')
      expect(resolveTagBackground('#abc')).toBe('#abc')
    })

    it('never wraps a custom hex in a css var()', () => {
      expect(resolveTagBackground('#ef4444')).not.toContain('var(')
    })
  })

  describe('tagColorStyle', () => {
    it('paints an accent token through its themed var(--accent-*)', () => {
      expect(tagColorStyle('accent-rose')).toEqual({
        '--tag-color': 'var(--accent-rose, var(--accent-current))',
        color: 'color-mix(in oklab, var(--tag-color) 50%, var(--foreground))',
        backgroundColor: 'color-mix(in oklab, var(--tag-color) 15%, transparent)',
      })
    })

    it('paints a custom hex verbatim', () => {
      expect(tagColorStyle('#123456')?.['--tag-color']).toBe('#123456')
    })

    it('leaves an uncoloured tag unstyled', () => {
      expect(tagColorStyle(undefined)).toBeUndefined()
    })
  })

  describe('migrateTagColors (legacy hex → accent token, #1099)', () => {
    it('maps every legacy preset hex to a recognised accent token', () => {
      for (const [hex, token] of Object.entries(LEGACY_HEX_TO_TOKEN)) {
        const { colors, changed } = migrateTagColors({ T: hex })
        expect(colors['T']).toBe(token)
        expect(isAccentToken(token)).toBe(true)
        expect(changed).toBe(true)
      }
    })

    it('is case-insensitive on the legacy hex', () => {
      expect(migrateTagColors({ T: '#EF4444' }).colors['T']).toBe('accent-rose')
    })

    it('leaves accent tokens and custom hex untouched (no silent recolor)', () => {
      const { colors, changed } = migrateTagColors({
        A: 'accent-violet',
        B: '#123456', // deliberate custom color — must survive
      })
      expect(colors).toEqual({ A: 'accent-violet', B: '#123456' })
      expect(changed).toBe(false)
    })

    it('getTagColors migrates legacy values on read and persists the new shape once', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ T1: '#ef4444', T2: '#3b82f6' }))
      expect(getTagColors()).toEqual({ T1: 'accent-rose', T2: 'accent-blue' })
      // Persisted back so the next read is already token-shaped.
      expect(JSON.parse(localStorage.getItem('tag-colors') ?? '{}')).toEqual({
        T1: 'accent-rose',
        T2: 'accent-blue',
      })
    })

    it('preserves a custom hex through getTagColors (escape hatch survives migration)', () => {
      localStorage.setItem('tag-colors', JSON.stringify({ T1: '#0a0a0a' }))
      expect(getTagColors()).toEqual({ T1: '#0a0a0a' })
    })
  })
})
