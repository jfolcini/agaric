/**
 * Tests for URL validation helpers.
 *
 * Validates:
 *  - `isAllowedUrl` rejects every blocked scheme (case-insensitive) and
 *    accepts common allowed schemes.
 *  - `normalizeUrl` trims whitespace, prepends `https://` for bare hosts,
 *    preserves `scheme://`, `mailto:`, and `tel:` as-is, and returns
 *    `null` for empty / blocked input.
 *  - Round-trip: `isAllowedUrl(normalizeUrl(raw))` for a happy-path host.
 */

import { describe, expect, it } from 'vitest'

import { isAllowedUrl, normalizeUrl } from '../url-validation'

describe('isAllowedUrl', () => {
  it.each([
    ['javascript:alert("xss")'],
    ['JavaScript:void(0)'],
    ['JAVASCRIPT:void(0)'],
    ['vbscript:msgbox(1)'],
    ['VBScript:Execute("…")'],
    ['data:text/html,<script>alert(1)</script>'],
    ['DATA:text/html,test'],
    ['file:///etc/passwd'],
    ['FILE:///c:/Windows/System32'],
    ['blob:https://example.com/abc-def'],
    ['about:blank'],
    ['About:config'],
  ])('rejects blocked scheme %s', (url) => {
    expect(isAllowedUrl(url)).toBe(false)
  })

  it.each([
    ['https://example.com'],
    ['http://example.com'],
    ['ftp://files.example.com/readme.txt'],
    ['mailto:user@example.com'],
    ['tel:+1234567890'],
    ['custom-app://open'],
    ['example.com'],
  ])('accepts allowed URL %s', (url) => {
    expect(isAllowedUrl(url)).toBe(true)
  })

  it('ignores leading/trailing whitespace', () => {
    expect(isAllowedUrl('  javascript:alert(1)  ')).toBe(false)
    expect(isAllowedUrl('  https://example.com  ')).toBe(true)
  })

  // Regression: interior control / whitespace chars must not let a blocked
  // scheme slip past the denylist. Browsers ignore these when resolving a
  // scheme (e.g. `java\tscript:` resolves to `javascript:`), so we strip
  // ASCII control chars (0x00-0x1F, 0x7F) and whitespace before the check.
  it.each([
    ['java\tscript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['java\rscript:alert(1)'],
    ['java\x00script:alert(1)'],
    ['\x00javascript:alert(1)'],
    ['\tjavascript:alert(1)'],
    ['java\x01script:alert(1)'],
    ['java\x7fscript:alert(1)'],
    ['j\ta\nv\ra\x00script:alert(1)'],
  ])('rejects control-char obfuscated blocked scheme %j', (url) => {
    expect(isAllowedUrl(url)).toBe(false)
  })

  it('still allows legitimate URLs with no scheme obfuscation', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true)
    expect(isAllowedUrl('mailto:user@example.com')).toBe(true)
    expect(isAllowedUrl('https://example.com/path?q=a+b')).toBe(true)
  })
})

describe('normalizeUrl', () => {
  it('returns null for empty input', () => {
    expect(normalizeUrl('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(normalizeUrl('   ')).toBeNull()
    expect(normalizeUrl('\t\n')).toBeNull()
  })

  it('prepends https:// when no protocol is present', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com')
  })

  it('preserves http(s)://, ftp://, and custom scheme:// URLs', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('ftp://files.example.com/readme.txt')).toBe(
      'ftp://files.example.com/readme.txt',
    )
    expect(normalizeUrl('custom-app://open')).toBe('custom-app://open')
  })

  it('preserves mailto: and tel: URLs (no authority component)', () => {
    expect(normalizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com')
    expect(normalizeUrl('tel:+1234567890')).toBe('tel:+1234567890')
  })

  it('is case-insensitive for mailto/tel schemes', () => {
    expect(normalizeUrl('MAILTO:user@example.com')).toBe('MAILTO:user@example.com')
    expect(normalizeUrl('Tel:+1234567890')).toBe('Tel:+1234567890')
  })

  it.each([
    ['javascript:alert("xss")'],
    ['JavaScript:alert("xss")'],
    ['JAVASCRIPT:void(0)'],
    ['vbscript:msgbox(1)'],
    ['VBScript:Execute("…")'],
    ['data:text/html,<script>alert(1)</script>'],
    ['DATA:text/html,test'],
    ['file:///etc/passwd'],
    ['FILE:///c:/Windows/System32'],
    ['blob:https://example.com/abc-def'],
    ['about:blank'],
    ['About:config'],
  ])('returns null for blocked scheme %s', (url) => {
    expect(normalizeUrl(url)).toBeNull()
  })

  it('round-trip: a normalised allowed URL is still allowed', () => {
    const normalised = normalizeUrl('  example.com/path  ')
    expect(normalised).toBe('https://example.com/path')
    expect(normalised && isAllowedUrl(normalised)).toBe(true)
  })
})
