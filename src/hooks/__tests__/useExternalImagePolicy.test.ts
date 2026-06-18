/**
 * Tests for the external-image policy + allowlist persistence hooks (#1492).
 *
 * Mirrors the useJournalDateFormat/useWeekStart pattern: localStorage-backed,
 * `useSyncExternalStore`, synthetic `storage` events for same-tab live updates,
 * and quota/security failures degrading to a silent no-op.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EXTERNAL_IMAGE_ALLOWLIST_KEY,
  EXTERNAL_IMAGE_POLICY_KEY,
} from '@/lib/external-image-policy'

import {
  getExternalImageAllowlist,
  getExternalImagePolicy,
  useExternalImageAllowlist,
  useExternalImagePolicy,
} from '../useExternalImagePolicy'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useExternalImagePolicy', () => {
  it('defaults to click (privacy-first) with no stored value', () => {
    const { result } = renderHook(() => useExternalImagePolicy())
    expect(result.current.policy).toBe('click')
  })

  it('persists the chosen policy to localStorage', () => {
    const { result } = renderHook(() => useExternalImagePolicy())
    act(() => result.current.setPolicy('always'))
    expect(localStorage.getItem(EXTERNAL_IMAGE_POLICY_KEY)).toBe('always')
    expect(result.current.policy).toBe('always')
  })

  it('reflects a stored policy on mount', () => {
    localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'never')
    const { result } = renderHook(() => useExternalImagePolicy())
    expect(result.current.policy).toBe('never')
  })

  it('reacts to a cross-tab (native) storage event for its key', () => {
    const { result } = renderHook(() => useExternalImagePolicy())
    act(() => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'always')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: EXTERNAL_IMAGE_POLICY_KEY,
          newValue: 'always',
          storageArea: window.localStorage,
        }),
      )
    })
    expect(result.current.policy).toBe('always')
  })

  it('degrades to a no-op (no throw) when setItem throws (quota/private mode)', () => {
    const { result } = renderHook(() => useExternalImagePolicy())
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => act(() => result.current.setPolicy('always'))).not.toThrow()
    spy.mockRestore()
  })

  it('non-hook getter returns the stored policy', () => {
    localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'always')
    expect(getExternalImagePolicy()).toBe('always')
  })
})

describe('useExternalImageAllowlist', () => {
  it('defaults to an empty set', () => {
    const { result } = renderHook(() => useExternalImageAllowlist())
    expect(result.current.allowlist.size).toBe(0)
  })

  it('addHost persists the host and exposes it in the set', () => {
    const { result } = renderHook(() => useExternalImageAllowlist())
    act(() => result.current.addHost('example.com'))
    expect(result.current.allowlist.has('example.com')).toBe(true)
    expect(localStorage.getItem(EXTERNAL_IMAGE_ALLOWLIST_KEY)).toBe(JSON.stringify(['example.com']))
  })

  it('addHost is a no-op for null/empty', () => {
    const { result } = renderHook(() => useExternalImageAllowlist())
    act(() => result.current.addHost(null))
    act(() => result.current.addHost(''))
    expect(result.current.allowlist.size).toBe(0)
  })

  it('addHost does not duplicate an existing host', () => {
    const { result } = renderHook(() => useExternalImageAllowlist())
    act(() => result.current.addHost('example.com'))
    act(() => result.current.addHost('example.com'))
    expect([...result.current.allowlist]).toEqual(['example.com'])
  })

  it('removeHost drops the host', () => {
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['a.com', 'b.com']))
    const { result } = renderHook(() => useExternalImageAllowlist())
    act(() => result.current.removeHost('a.com'))
    expect(result.current.allowlist.has('a.com')).toBe(false)
    expect(result.current.allowlist.has('b.com')).toBe(true)
  })

  it('getSnapshot is referentially stable between writes (no useSyncExternalStore loop)', () => {
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['x.com']))
    const a = getExternalImageAllowlist()
    const b = getExternalImageAllowlist()
    expect(a).toBe(b)
  })

  it('tolerates a corrupt allowlist value (treats as empty, no throw)', () => {
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, 'not json{')
    const { result } = renderHook(() => useExternalImageAllowlist())
    expect(result.current.allowlist.size).toBe(0)
  })

  it('degrades to a no-op when setItem throws on addHost', () => {
    const { result } = renderHook(() => useExternalImageAllowlist())
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => act(() => result.current.addHost('example.com'))).not.toThrow()
    spy.mockRestore()
  })
})
