/**
 * Tests for the Android theme-background bridge (#4433).
 *
 * `parseComputedRgb` is a pure function tested directly. `pushThemeBackgroundToNative`
 * is tested against a mocked `window.AgaricThemeBridge` and a mocked
 * `getComputedStyle`, since neither exists in the vitest DOM by default (see
 * module doc — bridge presence IS the platform gate).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type AndroidThemeBridge,
  parseComputedRgb,
  pushThemeBackgroundToNative,
  resolveToRgb,
  resolveViaCanvas,
} from '@/lib/platform/android-theme-bridge'

describe('parseComputedRgb', () => {
  it('parses legacy comma-separated rgb()', () => {
    expect(parseComputedRgb('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('parses legacy comma-separated rgba(), ignoring alpha', () => {
    expect(parseComputedRgb('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('parses modern space-separated rgb() with a slash alpha', () => {
    expect(parseComputedRgb('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('rounds and clamps out-of-range / fractional channels', () => {
    expect(parseComputedRgb('rgb(255.6, -1, 300)')).toEqual({ r: 255, g: 0, b: 255 })
  })

  it('returns null for an unresolved oklch() literal', () => {
    expect(parseComputedRgb('oklch(1 0 0)')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseComputedRgb('')).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseComputedRgb('not-a-color')).toBeNull()
  })
})

describe('pushThemeBackgroundToNative', () => {
  let applyBackground: ReturnType<typeof vi.fn<AndroidThemeBridge['applyBackground']>>
  let originalGetComputedStyle: typeof window.getComputedStyle

  beforeEach(() => {
    applyBackground = vi.fn<AndroidThemeBridge['applyBackground']>()
    originalGetComputedStyle = window.getComputedStyle
  })

  afterEach(() => {
    delete window.AgaricThemeBridge
    window.getComputedStyle = originalGetComputedStyle
    vi.restoreAllMocks()
  })

  function stubComputedBackground(value: string): void {
    window.getComputedStyle = vi.fn().mockReturnValue({
      backgroundColor: value,
    }) as unknown as typeof window.getComputedStyle
  }

  it('does nothing when window.AgaricThemeBridge is absent (desktop / iOS / plain tests)', () => {
    stubComputedBackground('rgb(255, 255, 255)')
    expect(() => pushThemeBackgroundToNative(false)).not.toThrow()
    // No bridge was ever installed, so there is nothing to assert a call
    // against — the absence of a throw and of any bridge mutation IS the
    // behavior under test.
  })

  it('forwards the resolved background colour and isDark flag to the bridge', () => {
    const bridge: AndroidThemeBridge = { applyBackground }
    window.AgaricThemeBridge = bridge
    stubComputedBackground('rgb(30, 30, 30)')

    pushThemeBackgroundToNative(true)

    expect(applyBackground).toHaveBeenCalledExactlyOnceWith(30, 30, 30, true)
  })

  it('passes isDark=false through unchanged for a light theme', () => {
    const bridge: AndroidThemeBridge = { applyBackground }
    window.AgaricThemeBridge = bridge
    stubComputedBackground('rgb(255, 255, 255)')

    pushThemeBackgroundToNative(false)

    expect(applyBackground).toHaveBeenCalledExactlyOnceWith(255, 255, 255, false)
  })

  it('does not call the bridge when the computed colour cannot be parsed', () => {
    const bridge: AndroidThemeBridge = { applyBackground }
    window.AgaricThemeBridge = bridge
    stubComputedBackground('')

    pushThemeBackgroundToNative(false)

    expect(applyBackground).not.toHaveBeenCalled()
  })

  it('swallows an exception thrown by the native bridge call', () => {
    const throwingBridge: AndroidThemeBridge = {
      applyBackground: vi.fn(() => {
        throw new Error('WebView reflection call failed')
      }),
    }
    window.AgaricThemeBridge = throwingBridge
    stubComputedBackground('rgb(1, 2, 3)')

    expect(() => pushThemeBackgroundToNative(true)).not.toThrow()
    expect(throwingBridge.applyBackground).toHaveBeenCalledOnce()
  })
})

describe('resolveViaCanvas — the oklch path this fix actually runs on (#4433)', () => {
  /**
   * jsdom has no canvas backend, so `getContext('2d')` returns null. These
   * tests install a fake whose `fillStyle` behaves the way a real engine's
   * does — including the part that makes this dangerous: assigning an
   * UNPARSEABLE value silently leaves the previous value in place.
   */
  const installFakeCanvas = (normalise: (input: string) => string | null) => {
    const real = document.createElement.bind(document)
    return vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return real(tag as 'div')
      let current = ''
      const ctx = {
        get fillStyle() {
          return current
        },
        set fillStyle(v: string) {
          const out = normalise(v)
          // A real engine IGNORES a value it cannot parse, keeping the old one.
          if (out !== null) current = out
        },
      }
      return { getContext: () => ctx } as unknown as HTMLCanvasElement
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves an oklch() computed value the regex cannot read', () => {
    installFakeCanvas((v) => (v.startsWith('oklch') ? '#1a2b3c' : v))
    expect(resolveViaCanvas('oklch(0.129 0.042 264.695)')).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c })
  })

  it('resolveToRgb prefers the cheap regex and never reaches the canvas for rgb()', () => {
    const spy = installFakeCanvas(() => '#ffffff')
    expect(resolveToRgb('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('resolveToRgb falls through to the canvas for oklch()', () => {
    installFakeCanvas((v) => (v.startsWith('oklch') ? '#010203' : v))
    expect(resolveToRgb('oklch(0.5 0.1 200)')).toEqual({ r: 1, g: 2, b: 3 })
  })

  it('a REJECTED colour is null, not the sentinel black left behind by the engine', () => {
    // The trap: `fillStyle = <garbage>` is a silent no-op, so the sentinel we
    // wrote first is what reads back. Without the guard this returns pure
    // black and the strip gets painted black on every unparseable theme.
    installFakeCanvas((v) => (v === '#000000' ? '#000000' : null))
    expect(resolveViaCanvas('not-a-colour')).toBeNull()
  })

  it('but a caller who genuinely asked for black still gets black', () => {
    installFakeCanvas((v) => (v === '#000000' || v === 'black' ? '#000000' : null))
    expect(resolveViaCanvas('black')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('no canvas backend at all is null — never a guessed colour', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => null,
    } as unknown as HTMLCanvasElement)
    expect(resolveViaCanvas('oklch(0.5 0.1 200)')).toBeNull()
  })
})
