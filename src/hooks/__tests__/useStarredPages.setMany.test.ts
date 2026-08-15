/**
 * Tests for src/hooks/useStarredPages.ts — localStorage-backed starred pages
 * with cross-instance sync via the shared preference broadcast (#2666).
 *
 * Focuses on the bulk `setMany` writer added for the Pages batch toolbar:
 *  - it updates `starredIds` for the calling instance, and
 *  - the broadcast keeps a second mounted instance in sync.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useStarredPages } from '@/hooks/useStarredPages'
import { getStarredPages } from '@/lib/starred-pages'

beforeEach(() => {
  localStorage.clear()
})

describe('useStarredPages.setMany', () => {
  it('stars every id in the batch and reflects it in starredIds', () => {
    const { result } = renderHook(() => useStarredPages())

    act(() => {
      result.current.setMany(['P1', 'P2', 'P3'], true)
    })

    expect(result.current.starredIds.has('P1')).toBe(true)
    expect(result.current.starredIds.has('P2')).toBe(true)
    expect(result.current.starredIds.has('P3')).toBe(true)
    expect(getStarredPages()).toEqual(['P1', 'P2', 'P3'])
  })

  it('unstars every id in the batch', () => {
    localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2', 'P3']))
    const { result } = renderHook(() => useStarredPages())

    act(() => {
      result.current.setMany(['P1', 'P3'], false)
    })

    expect(result.current.starredIds.has('P1')).toBe(false)
    expect(result.current.starredIds.has('P3')).toBe(false)
    expect(result.current.starredIds.has('P2')).toBe(true)
    expect(getStarredPages()).toEqual(['P2'])
  })

  it('broadcasts so a second instance re-reads the fresh set (cross-instance sync)', () => {
    const a = renderHook(() => useStarredPages())
    const b = renderHook(() => useStarredPages())

    act(() => {
      a.result.current.setMany(['P1', 'P2'], true)
    })

    // The other instance saw the same event and re-read localStorage.
    expect(b.result.current.starredIds.has('P1')).toBe(true)
    expect(b.result.current.starredIds.has('P2')).toBe(true)
  })

  it('is exposed alongside the existing toggle/isStarred API', () => {
    const { result } = renderHook(() => useStarredPages())
    expect(typeof result.current.setMany).toBe('function')
    expect(typeof result.current.toggle).toBe('function')
    expect(typeof result.current.isStarred).toBe('function')
  })
})
