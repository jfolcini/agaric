/**
 * Tests for platform detection helpers (UX-223 / BUG-31 bundled fix).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetPlatformCacheForTests, isAndroid, isMac, modKey } from '../platform'

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')

function setNavigatorUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
    writable: true,
  })
}

function restoreNavigatorUserAgent(): void {
  if (originalUserAgent) {
    Object.defineProperty(navigator, 'userAgent', originalUserAgent)
  }
}

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
    restoreNavigatorUserAgent()
    clearUserAgentData()
  })

  describe('isAndroid (#716)', () => {
    it('returns true for an Android WebView user agent', () => {
      setNavigatorUserAgent(
        'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      )
      expect(isAndroid()).toBe(true)
    })

    it('returns false for a desktop Linux user agent', () => {
      setNavigatorUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      )
      expect(isAndroid()).toBe(false)
    })

    it('returns false for iOS user agents', () => {
      setNavigatorUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      )
      expect(isAndroid()).toBe(false)
    })

    it('caches the result until the test reset hook runs', () => {
      setNavigatorUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
      expect(isAndroid()).toBe(false)
      setNavigatorUserAgent('Mozilla/5.0 (Linux; Android 15)')
      expect(isAndroid()).toBe(false) // cached
      __resetPlatformCacheForTests()
      expect(isAndroid()).toBe(true)
    })
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
