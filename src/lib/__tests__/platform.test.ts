/**
 * Tests for platform detection helpers (UX-223 / BUG-31 bundled fix).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetPlatformCacheForTests, isMac, modKey } from '../platform'

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')

function setNavigatorPlatform(value: string): void {
  Object.defineProperty(navigator, 'platform', {
    value,
    configurable: true,
    writable: true,
  })
}

function restoreNavigatorPlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(navigator, 'platform', originalPlatform)
  }
}

function clearUserAgentData(): void {
  Object.defineProperty(navigator, 'userAgentData', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

function setUserAgentData(platform: string): void {
  Object.defineProperty(navigator, 'userAgentData', {
    value: { platform },
    configurable: true,
    writable: true,
  })
}

describe('platform', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests()
    clearUserAgentData()
  })

  afterEach(() => {
    __resetPlatformCacheForTests()
    restoreNavigatorPlatform()
    clearUserAgentData()
  })

  describe('isMac', () => {
    it('returns true when navigator.platform contains "Mac"', () => {
      setNavigatorPlatform('MacIntel')
      expect(isMac()).toBe(true)
    })

    it('returns true for "MacARM"', () => {
      setNavigatorPlatform('MacARM')
      expect(isMac()).toBe(true)
    })

    it('returns false when navigator.platform is "Win32"', () => {
      setNavigatorPlatform('Win32')
      expect(isMac()).toBe(false)
    })

    it('returns false when navigator.platform is "Linux x86_64"', () => {
      setNavigatorPlatform('Linux x86_64')
      expect(isMac()).toBe(false)
    })

    it('returns true when userAgentData.platform reports "macOS"', () => {
      setNavigatorPlatform('Linux x86_64')
      setUserAgentData('macOS')
      expect(isMac()).toBe(true)
    })

    it('prefers userAgentData.platform over navigator.platform', () => {
      setNavigatorPlatform('MacIntel')
      setUserAgentData('Windows')
      expect(isMac()).toBe(false)
    })

    it('caches the result — a later platform change does not affect the cached value', () => {
      setNavigatorPlatform('Linux x86_64')
      expect(isMac()).toBe(false)
      setNavigatorPlatform('MacIntel')
      // Cached — still false
      expect(isMac()).toBe(false)
      __resetPlatformCacheForTests()
      expect(isMac()).toBe(true)
    })
  })

  describe('modKey', () => {
    it('returns "⌘" on macOS', () => {
      setNavigatorPlatform('MacIntel')
      expect(modKey()).toBe('\u2318')
    })

    it('returns "Ctrl" on Linux', () => {
      setNavigatorPlatform('Linux x86_64')
      expect(modKey()).toBe('Ctrl')
    })

    it('returns "Ctrl" on Windows', () => {
      setNavigatorPlatform('Win32')
      expect(modKey()).toBe('Ctrl')
    })
  })
})
