/**
 * Tests for url-state helpers (UX-276).
 *
 * Validates query-param read/write contract via `history.replaceState` for
 * the SettingsView deep-link feature. Helpers are total — corrupted URLs
 * degrade to `null` / no-op, never throw.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSettingsTabFromUrl, setSettingsTabInUrl } from '../url-state'

const ALLOWED = ['general', 'keyboard', 'sync'] as const

function resetUrl() {
  window.history.replaceState(null, '', '/')
}

beforeEach(() => {
  resetUrl()
})

afterEach(() => {
  resetUrl()
})

describe('getSettingsTabFromUrl', () => {
  it('returns null when no settings query param is present', () => {
    expect(getSettingsTabFromUrl(ALLOWED)).toBeNull()
  })

  it('returns the value when it is in the allowed list', () => {
    window.history.replaceState(null, '', '/?settings=keyboard')
    expect(getSettingsTabFromUrl(ALLOWED)).toBe('keyboard')
  })

  it('returns null when the value is not in the allowed list', () => {
    window.history.replaceState(null, '', '/?settings=not-a-real-tab')
    expect(getSettingsTabFromUrl(ALLOWED)).toBeNull()
  })

  it('preserves other params and still extracts settings', () => {
    window.history.replaceState(null, '', '/?foo=bar&settings=sync&baz=qux')
    expect(getSettingsTabFromUrl(ALLOWED)).toBe('sync')
  })

  it('handles an empty value as "not in the allowed list"', () => {
    window.history.replaceState(null, '', '/?settings=')
    expect(getSettingsTabFromUrl(ALLOWED)).toBeNull()
  })
})

describe('setSettingsTabInUrl', () => {
  it('adds the settings param when missing', () => {
    setSettingsTabInUrl('keyboard')
    expect(window.location.search).toBe('?settings=keyboard')
  })

  it('replaces an existing settings param value', () => {
    window.history.replaceState(null, '', '/?settings=general')
    setSettingsTabInUrl('sync')
    expect(window.location.search).toBe('?settings=sync')
  })

  it('preserves other query params when adding settings', () => {
    window.history.replaceState(null, '', '/?foo=bar')
    setSettingsTabInUrl('keyboard')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('foo')).toBe('bar')
    expect(params.get('settings')).toBe('keyboard')
  })

  it('removes the settings param when called with null', () => {
    window.history.replaceState(null, '', '/?settings=keyboard&foo=bar')
    setSettingsTabInUrl(null)
    const params = new URLSearchParams(window.location.search)
    expect(params.has('settings')).toBe(false)
    expect(params.get('foo')).toBe('bar')
  })

  it('is a no-op when removing and no settings param exists', () => {
    window.history.replaceState(null, '', '/?foo=bar')
    setSettingsTabInUrl(null)
    expect(window.location.search).toBe('?foo=bar')
  })

  it('uses replaceState (no new history entry) on each update', () => {
    const before = window.history.length
    setSettingsTabInUrl('keyboard')
    setSettingsTabInUrl('sync')
    setSettingsTabInUrl(null)
    expect(window.history.length).toBe(before)
  })

  it('preserves the URL hash fragment', () => {
    window.history.replaceState(null, '', '/?foo=bar#section')
    setSettingsTabInUrl('keyboard')
    expect(window.location.hash).toBe('#section')
    expect(window.location.search).toContain('settings=keyboard')
  })
})
