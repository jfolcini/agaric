/**
 * Tests for the `applySafePosition` Floating-UI fallback helper.
 *
 * Validates the shared helper used by `BlockPropertyEditor`
 * and `suggestion-renderer.ts` to apply computed coordinates on success
 * and push the popup off-screen on failure.
 */

import { describe, expect, it } from 'vitest'

import { applySafePosition } from '../floating-position'

describe('applySafePosition', () => {
  it('applies x/y in px on success', () => {
    const div = document.createElement('div')
    applySafePosition(div, { x: 100, y: 200 })
    expect(div.style.left).toBe('100px')
    expect(div.style.top).toBe('200px')
  })

  it('applies the off-screen fallback when given null', () => {
    const div = document.createElement('div')
    applySafePosition(div, null)
    expect(div.style.left).toBe('-9999px')
    expect(div.style.top).toBe('-9999px')
  })

  it('cleanly overwrites the off-screen fallback on a subsequent success', () => {
    const div = document.createElement('div')
    applySafePosition(div, null)
    applySafePosition(div, { x: 50, y: 60 })
    expect(div.style.left).toBe('50px')
    expect(div.style.top).toBe('60px')
  })

  it('does not preserve earlier coordinates when the fallback kicks in', () => {
    const div = document.createElement('div')
    applySafePosition(div, { x: 50, y: 60 })
    applySafePosition(div, null)
    expect(div.style.left).toBe('-9999px')
    expect(div.style.top).toBe('-9999px')
  })
})
