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

describe('transparent is not black (#4464 review, finding 1)', () => {
  // The reachable path: on a WebView too old to parse `oklch()`, `--background`
  // is invalid, so `background-color: var(--background)` computes to the
  // initial value `transparent` and `getComputedStyle` returns this exact
  // string. Dropping alpha painted the strip PURE BLACK under every theme,
  // including the white one -- worse than the bug being fixed.
  it('rgba(0, 0, 0, 0) is null, not black', () => {
    expect(parseComputedRgb('rgba(0, 0, 0, 0)')).toBeNull()
  })

  it('the modern slash form is caught too', () => {
    expect(parseComputedRgb('rgb(0 0 0 / 0)')).toBeNull()
  })

  it('a percentage alpha of 0% is caught', () => {
    expect(parseComputedRgb('rgba(12, 34, 56, 0%)')).toBeNull()
  })

  it('but a merely TRANSLUCENT colour is still a real colour', () => {
    expect(parseComputedRgb('rgba(12, 34, 56, 0.5)')).toEqual({ r: 12, g: 34, b: 56 })
  })

  it('and an opaque black is still black — the fix must not swallow it', () => {
    expect(parseComputedRgb('rgba(0, 0, 0, 1)')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseComputedRgb('rgb(0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0 })
  })
})

describe('resolveViaCanvas reads PIXELS, not the serialised string (#4464 review, finding 2)', () => {
  /**
   * Blink's `fillStyle` getter returns `#rrggbb` only for an opaque colour in
   * a legacy colour space; `oklch(...)` reads back as `oklch(...)`. So the
   * fake below deliberately does NOT normalise the string -- it models the
   * real engine, where only the painted pixel answers the question.
   */
  const installCanvas = (paint: (input: string) => [number, number, number, number] | null) => {
    const real = document.createElement.bind(document)
    return vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return real(tag as 'div')
      let px: [number, number, number, number] = [0, 0, 0, 0]
      // Models the real default: opaque black. This is what makes the
      // transparent sentinel in the implementation load-bearing.
      let pending = '#000000'
      const ctx = {
        clearRect: () => {
          px = [0, 0, 0, 0]
        },
        // A real engine IGNORES a value it cannot parse, keeping the old one.
        set fillStyle(v: string) {
          if (paint(v) !== null) pending = v
        },
        get fillStyle() {
          return pending
        },
        fillRect: () => {
          const out = paint(pending)
          if (out) px = out
        },
        getImageData: () => ({ data: px }),
      }
      return { getContext: () => ctx, width: 0, height: 0 } as unknown as HTMLCanvasElement
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves an oklch() value even though its serialisation stays oklch()', () => {
    installCanvas((v) =>
      v === 'rgba(0, 0, 0, 0)' ? [0, 0, 0, 0] : v.startsWith('oklch') ? [26, 43, 60, 255] : null,
    )
    expect(resolveViaCanvas('oklch(0.129 0.042 264.695)')).toEqual({ r: 26, g: 43, b: 60 })
  })

  it('a REJECTED colour leaves the cleared canvas, and reads as null', () => {
    // This is what the sentinel dance used to guard by hand. Alpha subsumes it.
    installCanvas((v) =>
      v === 'rgba(0, 0, 0, 0)' ? [0, 0, 0, 0] : v === '#000000' ? [0, 0, 0, 255] : null,
    )
    expect(resolveViaCanvas('not-a-colour')).toBeNull()
  })

  it('a genuinely transparent colour is null, not black', () => {
    installCanvas(() => [0, 0, 0, 0])
    expect(resolveViaCanvas('transparent')).toBeNull()
  })

  it('an opaque black IS returned — alpha, not the channels, is the test', () => {
    installCanvas((v) => (v === 'rgba(0, 0, 0, 0)' ? [0, 0, 0, 0] : [0, 0, 0, 255]))
    expect(resolveViaCanvas('black')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('no canvas backend is null, never a guessed colour', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => null,
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement)
    expect(resolveViaCanvas('oklch(0.5 0.1 200)')).toBeNull()
  })

  it('a context without getImageData is null, not a crash', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillStyle: '' }),
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement)
    expect(resolveViaCanvas('oklch(0.5 0.1 200)')).toBeNull()
  })

  it('resolveToRgb prefers the cheap regex and never builds a canvas for rgb()', () => {
    const spy = installCanvas(() => [9, 9, 9, 255])
    expect(resolveToRgb('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('resolveToRgb falls through to the canvas for oklch()', () => {
    installCanvas((v) =>
      v === 'rgba(0, 0, 0, 0)' ? [0, 0, 0, 0] : v.startsWith('oklch') ? [1, 2, 3, 255] : null,
    )
    expect(resolveToRgb('oklch(0.5 0.1 200)')).toEqual({ r: 1, g: 2, b: 3 })
  })
})
