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

import {
  clearTagColor,
  getTagColor,
  getTagColors,
  isAccentToken,
  LEGACY_HEX_TO_TOKEN,
  migrateTagColors,
  pickReadableForeground,
  resolveTagBackground,
  setTagColor,
  TAG_COLOR_PRESETS,
  tagColorForeground,
} from '../tag-colors'

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

  describe('pickReadableForeground', () => {
    // WCAG-aware foreground selector — guards against the previous
    // hard-coded `color: '#fff'` inline style in TagList, which failed
    // 4.5:1 contrast on light pastel tag fills (e.g. amber-200).

    it('returns white on pure black', () => {
      expect(pickReadableForeground('#000000')).toBe('#fff')
    })

    it('returns black on pure white', () => {
      expect(pickReadableForeground('#ffffff')).toBe('#000')
    })

    it('returns black on light pastels (the bug the audit flagged)', () => {
      // Light amber / yellow / mint — these are exactly the fills where
      // the old `color: '#fff'` rendered illegible.
      expect(pickReadableForeground('#fde68a')).toBe('#000') // amber-200
      expect(pickReadableForeground('#fef3c7')).toBe('#000') // amber-100
      expect(pickReadableForeground('#bbf7d0')).toBe('#000') // green-200
    })

    it('returns white on genuinely dark fills', () => {
      // Strict WCAG 4.5:1 puts the crossover roughly at L≈0.179, which is
      // darker than most "saturated" mid-tone palette colors. These are
      // luminance-dark enough that white is the higher-contrast choice.
      expect(pickReadableForeground('#1e3a8a')).toBe('#fff') // blue-900
      expect(pickReadableForeground('#7f1d1d')).toBe('#fff') // red-900
      expect(pickReadableForeground('#581c87')).toBe('#fff') // purple-900
      expect(pickReadableForeground('#111111')).toBe('#fff')
    })

    it('returns black on mid-tone palette fills (higher WCAG contrast vs. black)', () => {
      // Documents the WCAG-correct behaviour for the TAG_COLOR_PRESETS:
      // mid-tone "500" Tailwind palette colors all have higher contrast
      // ratio against black than against white, so the helper picks black.
      // (red-500 = 5.58:1 vs black, 3.76:1 vs white, etc.)
      expect(pickReadableForeground('#ef4444')).toBe('#000') // red-500
      expect(pickReadableForeground('#3b82f6')).toBe('#000') // blue-500
      expect(pickReadableForeground('#a855f7')).toBe('#000') // purple-500
    })

    it('accepts 3-digit shorthand hex', () => {
      expect(pickReadableForeground('#000')).toBe('#fff')
      expect(pickReadableForeground('#fff')).toBe('#000')
      // #003 expands to #000033 — dark blue, definitively white-text territory.
      expect(pickReadableForeground('#003')).toBe('#fff')
    })

    it('accepts 8-digit hex (alpha ignored)', () => {
      expect(pickReadableForeground('#000000ff')).toBe('#fff')
      expect(pickReadableForeground('#ffffff00')).toBe('#000')
    })

    it('is case-insensitive', () => {
      expect(pickReadableForeground('#1E3A8A')).toBe('#fff')
      expect(pickReadableForeground('#FDE68A')).toBe('#000')
    })

    it('trims surrounding whitespace', () => {
      expect(pickReadableForeground('  #000000  ')).toBe('#fff')
      expect(pickReadableForeground('  #ffffff  ')).toBe('#000')
    })

    it('falls back to black for malformed input (never invisible white-on-white)', () => {
      expect(pickReadableForeground('')).toBe('#000')
      expect(pickReadableForeground('not-a-color')).toBe('#000')
      expect(pickReadableForeground('#12')).toBe('#000')
      expect(pickReadableForeground('#12345')).toBe('#000')
      expect(pickReadableForeground('rgb(0,0,0)')).toBe('#000')
      // No leading '#'
      expect(pickReadableForeground('ef4444')).toBe('#000')
      // Non-hex characters inside an otherwise well-shaped string
      expect(pickReadableForeground('#zzzzzz')).toBe('#000')
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

    it('pins a legible black/white foreground per preset', () => {
      for (const preset of TAG_COLOR_PRESETS) {
        expect(preset.fg === '#000' || preset.fg === '#fff').toBe(true)
        expect(tagColorForeground(preset.value)).toBe(preset.fg)
      }
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

  describe('tagColorForeground (#1099)', () => {
    it('returns the fixed paired foreground for accent tokens (no var() introspection)', () => {
      expect(tagColorForeground('accent-amber')).toBe('#000')
      expect(tagColorForeground('accent-blue')).toBe('#fff')
    })

    it('falls back to WCAG pickReadableForeground for custom hex', () => {
      expect(tagColorForeground('#1e3a8a')).toBe('#fff') // dark navy
      expect(tagColorForeground('#fde68a')).toBe('#000') // light amber
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
