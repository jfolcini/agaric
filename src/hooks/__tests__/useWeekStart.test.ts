import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWeekStartDay, useWeekStart } from '../useWeekStart'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  localStorage.clear()
})

describe('useWeekStart', () => {
  it('defaults to Monday (1) when no preference set', () => {
    const { result } = renderHook(() => useWeekStart())
    expect(result.current.weekStartsOn).toBe(1)
  })

  it('reads Sunday (0) from localStorage', () => {
    localStorage.setItem('week-start-preference', '0')
    const { result } = renderHook(() => useWeekStart())
    expect(result.current.weekStartsOn).toBe(0)
  })

  it('setWeekStart persists to localStorage', () => {
    const { result } = renderHook(() => useWeekStart())
    act(() => result.current.setWeekStart(0))
    expect(localStorage.getItem('week-start-preference')).toBe('0')
  })

  it('handles invalid localStorage value', () => {
    localStorage.setItem('week-start-preference', 'invalid')
    const { result } = renderHook(() => useWeekStart())
    expect(result.current.weekStartsOn).toBe(1)
  })

  it('dispatches a fully populated StorageEvent on setWeekStart', () => {
    localStorage.setItem('week-start-preference', '1')
    const events: StorageEvent[] = []
    const listener = (e: StorageEvent) => events.push(e)
    window.addEventListener('storage', listener)
    try {
      const { result } = renderHook(() => useWeekStart())
      act(() => result.current.setWeekStart(0))
      expect(events).toHaveLength(1)
      const e = events[0]
      if (!e) throw new Error('no StorageEvent dispatched')
      expect(e.key).toBe('week-start-preference')
      expect(e.oldValue).toBe('1')
      expect(e.newValue).toBe('0')
      expect(e.url).toBe(window.location.href)
      expect(e.storageArea).toBe(window.localStorage)
    } finally {
      window.removeEventListener('storage', listener)
    }
  })

  it('setWeekStart degrades to no-op (no throw, no event) when storage write throws', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const events: StorageEvent[] = []
    const listener = (e: StorageEvent) => events.push(e)
    window.addEventListener('storage', listener)
    try {
      const { result } = renderHook(() => useWeekStart())
      expect(() => act(() => result.current.setWeekStart(0))).not.toThrow()
      expect(events).toHaveLength(0)
    } finally {
      window.removeEventListener('storage', listener)
      spy.mockRestore()
    }
  })
})

describe('getWeekStartDay', () => {
  it('returns 1 when no preference set', () => {
    expect(getWeekStartDay()).toBe(1)
  })

  it('returns 0 when set to Sunday', () => {
    localStorage.setItem('week-start-preference', '0')
    expect(getWeekStartDay()).toBe(0)
  })

  it('returns the default without throwing when storage read throws (render-path safety)', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(() => getWeekStartDay()).not.toThrow()
      expect(getWeekStartDay()).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
