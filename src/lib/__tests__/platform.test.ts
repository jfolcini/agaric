/**
 * Tests for platform detection helpers (bundled fix).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetPlatformCacheForTests,
  isAndroid,
  isMac,
  isMobilePlatform,
  modKey,
} from '../platform'

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

  describe('isMobilePlatform (#742 — capability check)', () => {
    it('returns true for an Android user agent', () => {
      setNavigatorUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      )
      expect(isMobilePlatform()).toBe(true)
    })

    it('returns true for an Android TABLET user agent (the >= 768 px width case)', () => {
      // Landscape Android tablet: viewport >= 768 px (so `useIsMobile`
      // would be false), but the device still can't run the desktop-only
      // global-shortcut plugin — capability detection must catch it.
      setNavigatorUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      )
      expect(isMobilePlatform()).toBe(true)
    })

    it('returns true for iPhone / iPad / iPod user agents', () => {
      for (const ua of [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        'Mozilla/5.0 (iPod touch; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      ]) {
        setNavigatorUserAgent(ua)
        expect(isMobilePlatform()).toBe(true)
      }
    })

    it('returns false for a desktop Linux/Windows/macOS user agent', () => {
      setNavigatorUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      )
      expect(isMobilePlatform()).toBe(false)
    })

    it('is NOT cached — re-reads navigator.userAgent on every call', () => {
      setNavigatorUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
      expect(isMobilePlatform()).toBe(false)
      setNavigatorUserAgent('Mozilla/5.0 (Linux; Android 15)')
      // No reset needed, unlike isMac/isAndroid — capability gating sites
      // (and their tests) flip the UA per render.
      expect(isMobilePlatform()).toBe(true)
    })
  })

  // Dedup guard (#742, LOW): `isMobilePlatform` must live in ONE place.
  // The three former-duplicate sites must import it from `lib/platform`
  // and must NOT re-declare a local copy or carry the stale
  // `tauri.ts:1871` doc anchor.
  describe('isMobilePlatform dedup — single export, three import sites', () => {
    const sites = [
      { name: 'tauri.ts', path: '../tauri.ts', spec: "from './platform'" },
      {
        name: 'useUpdateCheck.ts',
        path: '../../hooks/useUpdateCheck.ts',
        spec: "from '../lib/platform'",
      },
      {
        name: 'HelpTab.tsx',
        path: '../../components/settings/HelpTab.tsx',
        spec: "from '@/lib/platform'",
      },
    ] as const

    function readSite(rel: string): string {
      return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    }

    it.each(sites)('$name imports isMobilePlatform from lib/platform', ({ path, spec }) => {
      const src = readSite(path)
      expect(src).toContain('isMobilePlatform')
      expect(src).toContain(spec)
    })

    it.each(sites)('$name no longer declares a local isMobilePlatform', ({ path }) => {
      const src = readSite(path)
      expect(src).not.toMatch(/function\s+isMobilePlatform\s*\(/)
    })

    it.each(sites)('$name no longer carries the stale tauri.ts:1871 doc anchor', ({ path }) => {
      const src = readSite(path)
      expect(src).not.toContain('tauri.ts:1871')
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
