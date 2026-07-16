/**
 * Tests for useStarredPages hook (sub-item b).
 *
 * Validates:
 *  - `isStarred` returns false for an unstarred page.
 *  - `toggle()` adds a page to the starred set.
 *  - `toggle()` again removes the page from the starred set.
 *  - `starredIds` is referentially stable across renders when contents
 *    have not changed (so consuming memos stay quiet).
 *  - `toggle()` writes the canonical localStorage shape (JSON array
 *    under the `starred-pages` key — byte-equivalent to the legacy
 *    bare-lib usage).
 *  - Pre-existing localStorage data is read on mount.
 *  - Cross-instance sync: two mounted hook instances stay in sync via
 *    the shared preference broadcast (#2666 — the registry write
 *    dispatches a synthetic StorageEvent; previously a custom
 *    `starred-pages-changed` window event).
 *  - Malformed localStorage values fall back to an empty set without
 *    throwing.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useStarredPages } from '@/hooks/useStarredPages'

const STORAGE_KEY = 'starred-pages'

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
})

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY)
})

describe('useStarredPages', () => {
  it('isStarred returns false for an unstarred page', () => {
    const { result } = renderHook(() => useStarredPages())
    expect(result.current.isStarred('P1')).toBe(false)
    expect(result.current.starredIds.size).toBe(0)
  })

  it('toggle() adds a page to the starred set', () => {
    const { result } = renderHook(() => useStarredPages())

    act(() => {
      result.current.toggle('P1')
    })

    expect(result.current.isStarred('P1')).toBe(true)
    expect(result.current.starredIds.has('P1')).toBe(true)
  })

  it('toggle() again removes the page from the starred set', () => {
    const { result } = renderHook(() => useStarredPages())

    act(() => {
      result.current.toggle('P1')
    })
    expect(result.current.isStarred('P1')).toBe(true)

    act(() => {
      result.current.toggle('P1')
    })
    expect(result.current.isStarred('P1')).toBe(false)
    expect(result.current.starredIds.size).toBe(0)
  })

  it('starredIds is referentially stable across renders when contents are unchanged', () => {
    const { result, rerender } = renderHook(() => useStarredPages())

    const initialSet = result.current.starredIds
    rerender()
    expect(result.current.starredIds).toBe(initialSet)

    // After a no-op refresh broadcast (the stored raw value is unchanged),
    // the set instance should still be the same — the primitive's snapshot
    // is cached against the raw string, so an equal raw short-circuits.
    const raw = localStorage.getItem(STORAGE_KEY)
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          oldValue: raw,
          newValue: raw,
          storageArea: window.localStorage,
        }),
      )
    })
    expect(result.current.starredIds).toBe(initialSet)
  })

  it('toggle() writes JSON-array localStorage shape (byte-equivalent to lib)', () => {
    const { result } = renderHook(() => useStarredPages())

    act(() => {
      result.current.toggle('P1')
    })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(['P1']))

    act(() => {
      result.current.toggle('P2')
    })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(['P1', 'P2']))
  })

  it('reads pre-existing starred pages from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['P1', 'P2']))

    const { result } = renderHook(() => useStarredPages())

    expect(result.current.isStarred('P1')).toBe(true)
    expect(result.current.isStarred('P2')).toBe(true)
    expect(result.current.isStarred('P3')).toBe(false)
    expect(result.current.starredIds.size).toBe(2)
  })

  it('cross-instance sync: toggle in one instance updates the other', () => {
    const a = renderHook(() => useStarredPages())
    const b = renderHook(() => useStarredPages())

    expect(a.result.current.isStarred('P1')).toBe(false)
    expect(b.result.current.isStarred('P1')).toBe(false)

    act(() => {
      a.result.current.toggle('P1')
    })

    // Both instances pick up the change via the shared preference
    // broadcast (#2666).
    expect(a.result.current.isStarred('P1')).toBe(true)
    expect(b.result.current.isStarred('P1')).toBe(true)

    // Untoggle from B — A also sees the unstar.
    act(() => {
      b.result.current.toggle('P1')
    })
    expect(a.result.current.isStarred('P1')).toBe(false)
    expect(b.result.current.isStarred('P1')).toBe(false)
  })

  it('falls back to an empty set when localStorage holds a malformed value', () => {
    localStorage.setItem(STORAGE_KEY, '{not-valid-json')

    expect(() => renderHook(() => useStarredPages())).not.toThrow()

    const { result } = renderHook(() => useStarredPages())
    expect(result.current.starredIds.size).toBe(0)
    expect(result.current.isStarred('P1')).toBe(false)
  })

  it('falls back to an empty set when localStorage holds a non-array JSON value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'P1' }))

    const { result } = renderHook(() => useStarredPages())

    expect(result.current.starredIds.size).toBe(0)
    expect(result.current.isStarred('P1')).toBe(false)
  })
})
