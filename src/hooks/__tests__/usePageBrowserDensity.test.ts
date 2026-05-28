/**
 * PEND-56 — tests for usePageBrowserDensity.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DENSITY_ROW_HEIGHT, usePageBrowserDensity } from '../usePageBrowserDensity'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('usePageBrowserDensity', () => {
  it('defaults to regular', () => {
    const { result } = renderHook(() => usePageBrowserDensity())
    expect(result.current.density).toBe('regular')
    expect(result.current.rowHeight).toBe(DENSITY_ROW_HEIGHT.regular)
  })

  it('round-trips each mode through localStorage', () => {
    const { result, rerender } = renderHook(() => usePageBrowserDensity())
    for (const mode of ['compact', 'regular', 'expanded'] as const) {
      act(() => result.current.setDensity(mode))
      rerender()
      expect(result.current.density).toBe(mode)
      expect(result.current.rowHeight).toBe(DENSITY_ROW_HEIGHT[mode])
    }
  })

  it('persists across remount', () => {
    const first = renderHook(() => usePageBrowserDensity())
    act(() => first.result.current.setDensity('expanded'))
    first.unmount()

    const second = renderHook(() => usePageBrowserDensity())
    expect(second.result.current.density).toBe('expanded')
  })

  it('falls back to default on invalid stored value', () => {
    localStorage.setItem('page-browser-density', 'huge')
    const { result } = renderHook(() => usePageBrowserDensity())
    expect(result.current.density).toBe('regular')
  })

  it('density transitions do not collide with each other (state-machine sanity)', () => {
    const { result, rerender } = renderHook(() => usePageBrowserDensity())
    // compact → regular → expanded → compact (full cycle)
    for (const next of ['compact', 'regular', 'expanded', 'compact'] as const) {
      act(() => result.current.setDensity(next))
      rerender()
      expect(result.current.density).toBe(next)
    }
  })

  it('rowHeight monotonically increases compact → regular → expanded', () => {
    expect(DENSITY_ROW_HEIGHT.compact).toBeLessThan(DENSITY_ROW_HEIGHT.regular)
    expect(DENSITY_ROW_HEIGHT.regular).toBeLessThan(DENSITY_ROW_HEIGHT.expanded)
  })
})
