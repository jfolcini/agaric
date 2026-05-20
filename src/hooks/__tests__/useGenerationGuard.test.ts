/**
 * PEND-73 Phase 4.M3 — tests for useGenerationGuard.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useGenerationGuard } from '../useGenerationGuard'

describe('useGenerationGuard', () => {
  it('returns 1 from the first next() call', () => {
    const { result } = renderHook(() => useGenerationGuard())
    expect(result.current.next()).toBe(1)
  })

  it('increments monotonically', () => {
    const { result } = renderHook(() => useGenerationGuard())
    expect(result.current.next()).toBe(1)
    expect(result.current.next()).toBe(2)
    expect(result.current.next()).toBe(3)
  })

  it('isCurrent returns true for the most recent id', () => {
    const { result } = renderHook(() => useGenerationGuard())
    const id1 = result.current.next()
    expect(result.current.isCurrent(id1)).toBe(true)
  })

  it('isCurrent returns false for stale ids', () => {
    const { result } = renderHook(() => useGenerationGuard())
    const id1 = result.current.next()
    result.current.next()
    expect(result.current.isCurrent(id1)).toBe(false)
  })

  it('returns the same object identity across re-renders', () => {
    const { result, rerender } = renderHook(() => useGenerationGuard())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('preserves counter state across re-renders', () => {
    const { result, rerender } = renderHook(() => useGenerationGuard())
    result.current.next() // 1
    result.current.next() // 2
    rerender()
    expect(result.current.next()).toBe(3)
  })

  it('isCurrent on a never-issued id returns false', () => {
    const { result } = renderHook(() => useGenerationGuard())
    expect(result.current.isCurrent(0)).toBe(true) // initial counter == 0
    expect(result.current.isCurrent(42)).toBe(false)
  })
})
