import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeKeyboardInset } from '../keyboard-inset'

/** Build a VisualViewport-shaped object for the inset math. */
function makeVv(opts: { height: number; offsetTop?: number; scale?: number }): VisualViewport {
  return {
    height: opts.height,
    offsetTop: opts.offsetTop ?? 0,
    scale: opts.scale ?? 1,
  } as unknown as VisualViewport
}

describe('computeKeyboardInset', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the rounded overlap when the keyboard is present', () => {
    vi.stubGlobal('innerHeight', 800)
    // 800 - (500 + 0) = 300
    expect(computeKeyboardInset(makeVv({ height: 500 }))).toBe(300)
  })

  it('accounts for offsetTop and rounds fractional overlaps', () => {
    vi.stubGlobal('innerHeight', 800)
    // 800 - (499.6 + 40) = 260.4 -> 260
    expect(computeKeyboardInset(makeVv({ height: 499.6, offsetTop: 40 }))).toBe(260)
  })

  it('returns 0 when there is no keyboard (viewport fills the window)', () => {
    vi.stubGlobal('innerHeight', 800)
    expect(computeKeyboardInset(makeVv({ height: 800 }))).toBe(0)
  })

  it('clamps negative overlaps (transient orientation reads) to 0', () => {
    vi.stubGlobal('innerHeight', 800)
    expect(computeKeyboardInset(makeVv({ height: 900 }))).toBe(0)
  })

  it('returns 0 on a pinch-zoomed viewport even though vv.height shrank', () => {
    vi.stubGlobal('innerHeight', 800)
    // Would be a phantom 300px inset without the scale guard.
    expect(computeKeyboardInset(makeVv({ height: 500, scale: 2 }))).toBe(0)
  })
})
