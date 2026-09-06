import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyMotionPreference,
  getMotionPreference,
  useMotionPreference,
} from '@/hooks/useMotionPreference'
import { shouldReduceMotion } from '@/lib/preferences'

const KEY = 'agaric-motion'

function reset() {
  localStorage.clear()
  document.documentElement.style.removeProperty('--motion-scale')
  document.documentElement.removeAttribute('data-motion')
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

afterEach(reset)

describe('applyMotionPreference', () => {
  const root = document.documentElement

  it('writes no inline override for "system" (media query governs)', () => {
    // Start dirty to prove it clears.
    root.style.setProperty('--motion-scale', '0.5')
    root.setAttribute('data-motion', 'off')
    applyMotionPreference('system')
    expect(root.style.getPropertyValue('--motion-scale')).toBe('')
    expect(root.getAttribute('data-motion')).toBeNull()
  })

  it('maps "full" and "fast" to their numeric scales without the off attribute', () => {
    applyMotionPreference('full')
    expect(root.style.getPropertyValue('--motion-scale')).toBe('1')
    expect(root.getAttribute('data-motion')).toBeNull()

    applyMotionPreference('fast')
    expect(root.style.getPropertyValue('--motion-scale')).toBe('0.5')
    expect(root.getAttribute('data-motion')).toBeNull()
  })

  it('maps "off" to scale 0 plus the hard-kill attribute', () => {
    applyMotionPreference('off')
    expect(root.style.getPropertyValue('--motion-scale')).toBe('0')
    expect(root.getAttribute('data-motion')).toBe('off')
  })
})

describe('useMotionPreference', () => {
  it('defaults to "system" and applies nothing to the DOM (no-change baseline)', () => {
    const { result } = renderHook(() => useMotionPreference())
    expect(result.current.motion).toBe('system')
    expect(document.documentElement.style.getPropertyValue('--motion-scale')).toBe('')
  })

  it('reads a stored value from localStorage and applies it', () => {
    localStorage.setItem(KEY, 'fast')
    const { result } = renderHook(() => useMotionPreference())
    expect(result.current.motion).toBe('fast')
    expect(document.documentElement.style.getPropertyValue('--motion-scale')).toBe('0.5')
  })

  it('falls back to "system" for an unknown stored value', () => {
    localStorage.setItem(KEY, 'warp-speed')
    const { result } = renderHook(() => useMotionPreference())
    expect(result.current.motion).toBe('system')
  })

  it('setMotion persists the choice and re-applies the DOM state', () => {
    const { result } = renderHook(() => useMotionPreference())
    act(() => result.current.setMotion('off'))
    expect(result.current.motion).toBe('off')
    expect(localStorage.getItem(KEY)).toBe('off')
    expect(document.documentElement.style.getPropertyValue('--motion-scale')).toBe('0')
    expect(document.documentElement.getAttribute('data-motion')).toBe('off')
  })
})

describe('getMotionPreference', () => {
  it('returns the default when nothing is stored', () => {
    expect(getMotionPreference()).toBe('system')
  })

  it('returns a valid stored value', () => {
    localStorage.setItem(KEY, 'full')
    expect(getMotionPreference()).toBe('full')
  })
})

describe('shouldReduceMotion', () => {
  const originalMatchMedia = window.matchMedia

  /** Stub the OS `(prefers-reduced-motion: reduce)` query. */
  function osReducedMotion(matches: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('reduces for "off" even when the OS asks for full motion', () => {
    localStorage.setItem(KEY, 'off')
    osReducedMotion(false)
    expect(shouldReduceMotion()).toBe(true)
  })

  it('does not reduce for "full" even when the OS asks for reduced motion', () => {
    localStorage.setItem(KEY, 'full')
    osReducedMotion(true)
    expect(shouldReduceMotion()).toBe(false)
  })

  it('reduces for "system" when the OS asks for reduced motion', () => {
    localStorage.setItem(KEY, 'system')
    osReducedMotion(true)
    expect(shouldReduceMotion()).toBe(true)
  })

  it('does not reduce for "system" when the OS does not ask', () => {
    localStorage.setItem(KEY, 'system')
    osReducedMotion(false)
    expect(shouldReduceMotion()).toBe(false)
  })
})
