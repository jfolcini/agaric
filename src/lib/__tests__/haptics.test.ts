/**
 * Tests for the #137 haptics helper — feature-detected `navigator.vibrate`
 * wrapper that no-ops when the Vibration API is absent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '../haptics'

describe('haptic', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    // Remove any vibrate we attached so the next test starts clean.
    // happy-dom's navigator has no vibrate by default.
    delete (navigator as { vibrate?: unknown }).vibrate
  })

  it('calls navigator.vibrate with the tick pattern by default', () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    haptic()
    expect(vibrate).toHaveBeenCalledWith(10)
  })

  it('maps the dismiss pattern to a firmer pulse', () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    haptic('dismiss')
    expect(vibrate).toHaveBeenCalledWith(15)
  })

  it('no-ops when navigator.vibrate is unavailable', () => {
    delete (navigator as { vibrate?: unknown }).vibrate
    expect(() => haptic('tick')).not.toThrow()
  })

  it('swallows errors thrown by vibrate (e.g. NotAllowedError outside a gesture)', () => {
    const vibrate = vi.fn(() => {
      throw new Error('NotAllowedError')
    })
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    expect(() => haptic()).not.toThrow()
    expect(vibrate).toHaveBeenCalled()
  })
})
