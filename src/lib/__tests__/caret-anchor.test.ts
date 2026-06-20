/**
 * Tests for `getCaretRect` — Phase 1 caret-anchor utility.
 *
 * The text measurer is injected per-test for determinism. The default
 * canvas-based measurer is exercised once to ensure it doesn't crash
 * in the test DOM environment (canvas 2D context is typically null in
 * jsdom / happy-dom).
 */

import { afterEach, describe, expect, it } from 'vitest'

import { defaultMeasureText, getCaretRect, type MeasureTextFn } from '../caret-anchor'

const STYLES = [
  'box-sizing: border-box',
  'padding: 5px 10px',
  'border: 2px solid black',
  'border-top-width: 3px',
  'font-family: Arial',
  'font-size: 16px',
  'font-style: normal',
  'font-variant: normal',
  'font-weight: normal',
  'line-height: 20px',
].join('; ')

function makeInput(value: string, extraStyle = ''): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.style.cssText = `${STYLES}; ${extraStyle}`
  document.body.append(input)
  // Pin the bounding rect so tests aren't sensitive to layout differences.
  input.getBoundingClientRect = () => new DOMRect(100, 200, 300, 24)
  return input
}

const created: HTMLInputElement[] = []
function track(input: HTMLInputElement): HTMLInputElement {
  created.push(input)
  return input
}

afterEach(() => {
  while (created.length > 0) {
    const el = created.pop()
    if (el?.parentNode) el.parentNode.removeChild(el)
  }
})

// Deterministic measurer: 8px per character regardless of font string.
const fixedWidth: MeasureTextFn = (text) => text.length * 8

describe('getCaretRect', () => {
  it('returns input left + border + padding when caret is at start', () => {
    const input = track(makeInput('hello world'))
    const rect = getCaretRect(input, 0, fixedWidth)
    // 100 (rect.left) + 2 (border-left) + 10 (padding-left) + 0 (text width)
    expect(rect.x).toBe(112)
    // 200 (rect.top) + 3 (border-top) + 5 (padding-top)
    expect(rect.y).toBe(208)
    expect(rect.width).toBe(0)
    expect(rect.height).toBe(20)
  })

  it('calls the measurer with the full value when caret is at end', () => {
    const input = track(makeInput('hello world'))
    const seen: string[] = []
    const measurer: MeasureTextFn = (text) => {
      seen.push(text)
      return text.length * 8
    }
    const rect = getCaretRect(input, input.value.length, measurer)
    expect(seen).toEqual(['hello world'])
    // 112 baseline + 11 chars × 8px = 200
    expect(rect.x).toBe(200)
  })

  it('clamps out-of-range caret indices without throwing', () => {
    const input = track(makeInput('abc'))
    const low = getCaretRect(input, -5, fixedWidth)
    const high = getCaretRect(input, input.value.length + 99, fixedWidth)
    // -5 clamps to 0 → no text measured.
    expect(low.x).toBe(112)
    // Over-large clamps to length → 3 chars × 8 = 24.
    expect(high.x).toBe(112 + 24)
    // Both rects should be finite, non-NaN.
    expect(Number.isFinite(low.x)).toBe(true)
    expect(Number.isFinite(high.x)).toBe(true)
    expect(Number.isFinite(low.height)).toBe(true)
    expect(Number.isFinite(high.height)).toBe(true)
  })

  it('handles an empty input at caret 0', () => {
    const input = track(makeInput(''))
    const rect = getCaretRect(input, 0, fixedWidth)
    expect(rect.width).toBe(0)
    expect(rect.height).toBeGreaterThan(0)
    expect(rect.x).toBe(112)
  })

  it('falls back to fontSize × 1.2 when line-height is "normal"', () => {
    const input = track(makeInput('x', 'line-height: normal; font-size: 16px'))
    const rect = getCaretRect(input, 0, fixedWidth)
    expect(rect.height).toBeCloseTo(16 * 1.2, 5)
  })

  it('reduces x by input.scrollLeft', () => {
    const input = track(makeInput('hello world'))
    const baseline = getCaretRect(input, 5, fixedWidth)
    input.scrollLeft = 50
    const scrolled = getCaretRect(input, 5, fixedWidth)
    expect(scrolled.x).toBe(baseline.x - 50)
  })
})

describe('defaultMeasureText', () => {
  it('returns a non-negative number for an empty string', () => {
    const width = defaultMeasureText('', 'normal normal normal 16px Arial')
    expect(typeof width).toBe('number')
    expect(Number.isFinite(width)).toBe(true)
    expect(width).toBeGreaterThanOrEqual(0)
  })
})
