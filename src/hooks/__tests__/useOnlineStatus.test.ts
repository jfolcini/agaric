import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useOnlineStatus } from '../useOnlineStatus'

describe('useOnlineStatus', () => {
  const originalOnLine = navigator.onLine

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
  })

  it('returns true when online', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)
  })

  it('returns false when offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)
  })

  it('updates when going offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      window.dispatchEvent(new Event('offline'))
    })
    expect(result.current).toBe(false)
  })

  it('updates when going online', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
      window.dispatchEvent(new Event('online'))
    })
    expect(result.current).toBe(true)
  })
})
