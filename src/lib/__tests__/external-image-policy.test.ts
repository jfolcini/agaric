/**
 * Tests for the external-image gating helper (#1492).
 *
 * `shouldLoadExternalImage(src, policy, allowlist)` is the single source of
 * truth for whether an image's real `<img src>` may be mounted. The security
 * property under test is EXACT-HOST matching: an allowlisted `example.com` must
 * NOT authorize `evil-example.com`.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EXTERNAL_IMAGE_POLICY,
  externalImageHost,
  shouldLoadExternalImage,
} from '../external-image-policy'

const EMPTY: ReadonlySet<string> = new Set()

describe('shouldLoadExternalImage — non-external srcs always load', () => {
  for (const policy of ['always', 'click', 'never'] as const) {
    it(`relative path loads under policy=${policy}`, () => {
      expect(shouldLoadExternalImage('/favicon.svg', policy, EMPTY)).toBe(true)
      expect(shouldLoadExternalImage('img/cat.png', policy, EMPTY)).toBe(true)
    })
    it(`data: URI loads under policy=${policy}`, () => {
      expect(shouldLoadExternalImage('data:image/gif;base64,R0lGOD', policy, EMPTY)).toBe(true)
    })
    it(`blob: URL loads under policy=${policy}`, () => {
      expect(shouldLoadExternalImage('blob:abc-123', policy, EMPTY)).toBe(true)
    })
    it(`asset: URL loads under policy=${policy}`, () => {
      expect(shouldLoadExternalImage('asset://localhost/x.png', policy, EMPTY)).toBe(true)
    })
  }

  it('same-origin http(s) src loads (not a cross-origin concern)', () => {
    // jsdom origin defaults to http://localhost; same-origin → load even in
    // never mode with an empty allowlist.
    const sameOrigin = `${window.location.origin}/local/x.png`
    expect(shouldLoadExternalImage(sameOrigin, 'never', EMPTY)).toBe(true)
    expect(shouldLoadExternalImage(sameOrigin, 'click', EMPTY)).toBe(true)
  })
})

describe('shouldLoadExternalImage — always / never policies', () => {
  it('always loads an external image regardless of allowlist', () => {
    expect(shouldLoadExternalImage('https://example.com/x.png', 'always', EMPTY)).toBe(true)
  })
  it('never blocks an external image even if allowlisted', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://example.com/x.png', 'never', allow)).toBe(false)
  })
})

describe('shouldLoadExternalImage — click policy + allowlist', () => {
  it('loads when the exact host is allowlisted', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://example.com/x.png', 'click', allow)).toBe(true)
  })

  it('shows the placeholder (does not load) when the host is not allowlisted', () => {
    expect(shouldLoadExternalImage('https://example.com/x.png', 'click', EMPTY)).toBe(false)
  })

  it('default policy is click (privacy-first), so external is withheld by default', () => {
    expect(DEFAULT_EXTERNAL_IMAGE_POLICY).toBe('click')
    expect(
      shouldLoadExternalImage('https://example.com/x.png', DEFAULT_EXTERNAL_IMAGE_POLICY, EMPTY),
    ).toBe(false)
  })

  it('matches host case-insensitively and ignores the default port', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://EXAMPLE.com/x.png', 'click', allow)).toBe(true)
    expect(shouldLoadExternalImage('https://example.com:443/x.png', 'click', allow)).toBe(true)
  })

  it('does NOT match a non-default port against a port-less entry', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://example.com:8443/x.png', 'click', allow)).toBe(false)
  })
})

describe('shouldLoadExternalImage — EXACT-HOST security (no substring match)', () => {
  it('evil-example.com does NOT match an allowlisted example.com', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://evil-example.com/x.png', 'click', allow)).toBe(false)
  })

  it('example.com.evil.com does NOT match an allowlisted example.com', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://example.com.evil.com/x.png', 'click', allow)).toBe(
      false,
    )
  })

  it('a subdomain (cdn.example.com) does NOT match an allowlisted example.com', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://cdn.example.com/x.png', 'click', allow)).toBe(false)
  })

  it('userinfo bypass: https://example.com@evil.com gates on evil.com, not example.com', () => {
    // Classic spoof — the authority is `evil.com`; `example.com` is just the
    // userinfo. `new URL().host` correctly resolves to `evil.com`, so an
    // allowlisted `example.com` must NOT authorize this image.
    const allow = new Set(['example.com'])
    expect(externalImageHost('https://example.com@evil.com/x.png')).toBe('evil.com')
    expect(shouldLoadExternalImage('https://example.com@evil.com/x.png', 'click', allow)).toBe(
      false,
    )
    // …and it IS authorized only when the REAL host (evil.com) is allowlisted.
    expect(
      shouldLoadExternalImage('https://example.com@evil.com/x.png', 'click', new Set(['evil.com'])),
    ).toBe(true)
  })

  it('userinfo with password (user:pass@host) still gates on the real host', () => {
    const allow = new Set(['example.com'])
    expect(externalImageHost('https://example.com:tok@evil.com/x.png')).toBe('evil.com')
    expect(shouldLoadExternalImage('https://example.com:tok@evil.com/x.png', 'click', allow)).toBe(
      false,
    )
  })

  it('a trailing-dot FQDN (example.com.) does NOT match an allowlisted example.com', () => {
    const allow = new Set(['example.com'])
    expect(shouldLoadExternalImage('https://example.com./x.png', 'click', allow)).toBe(false)
  })
})

describe('shouldLoadExternalImage — malformed URLs never throw and never load', () => {
  for (const policy of ['always', 'click', 'never'] as const) {
    it(`malformed http(s) URL is not loaded under policy=${policy}, no throw`, () => {
      // `http://` with no host is malformed.
      expect(() => shouldLoadExternalImage('https://', policy, EMPTY)).not.toThrow()
      expect(shouldLoadExternalImage('https://', policy, EMPTY)).toBe(false)
    })
  }
})

describe('externalImageHost', () => {
  it('returns null for local/data/asset/relative srcs', () => {
    expect(externalImageHost('/favicon.svg')).toBeNull()
    expect(externalImageHost('data:image/png;base64,AAA')).toBeNull()
    expect(externalImageHost('blob:abc')).toBeNull()
    expect(externalImageHost('asset://localhost/x.png')).toBeNull()
  })

  it('returns the lowercased, default-port-stripped host for external https', () => {
    expect(externalImageHost('https://Example.COM:443/x.png')).toBe('example.com')
    expect(externalImageHost('https://cdn.example.com/a/b.png')).toBe('cdn.example.com')
  })

  it('returns null (no throw) for a malformed URL', () => {
    expect(() => externalImageHost('https://')).not.toThrow()
    expect(externalImageHost('https://')).toBeNull()
  })
})
