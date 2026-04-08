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
})

describe('getWeekStartDay', () => {
  it('returns 1 when no preference set', () => {
    expect(getWeekStartDay()).toBe(1)
  })

  it('returns 0 when set to Sunday', () => {
    localStorage.setItem('week-start-preference', '0')
    expect(getWeekStartDay()).toBe(0)
  })
})
