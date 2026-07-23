/**
 * Tests for src/hooks/useSavedPagesViews.ts — localStorage-backed named
 * Pages-view snapshots with cross-instance sync (#2003 piece 1).
 *
 * Covers:
 *  - saveView / deleteView update `views` for the calling instance
 *  - cross-instance broadcast sync (mirrors useStarredPages.test.ts)
 *  - active-view detection against a live `PagesViewTuple`
 *  - the schemaMismatchDetected recovery signal (render-phase peek, timed
 *    ahead of the registry's mount-effect write-back) and its
 *    self-clearing acknowledgment
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSavedPagesViews } from '@/hooks/useSavedPagesViews'
import { getSavedPagesViews, type PagesViewTuple } from '@/lib/saved-pages-views'

const STORAGE_KEY = 'agaric:pages:savedViews:v1'

const BASE_TUPLE: PagesViewTuple = {
  sort: 'alphabetical',
  density: 'regular',
  filters: [],
}

beforeEach(() => {
  localStorage.clear()
})

describe('useSavedPagesViews', () => {
  it('starts with an empty views list and a null activeView', () => {
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    expect(result.current.views).toEqual([])
    expect(result.current.activeView).toBeNull()
  })

  it('saveView persists a new view and reflects it in views', () => {
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))

    act(() => {
      result.current.saveView('My view', BASE_TUPLE)
    })

    expect(result.current.views).toHaveLength(1)
    expect(result.current.views[0]?.name).toBe('My view')
    expect(getSavedPagesViews()).toHaveLength(1)
  })

  it('deleteView removes a view by id', () => {
    const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    let created!: ReturnType<typeof result.current.saveView>
    act(() => {
      created = result.current.saveView('Doomed', BASE_TUPLE)
    })

    act(() => {
      result.current.deleteView(created.id)
    })

    expect(result.current.views).toEqual([])
  })

  it('broadcasts so a second instance re-reads the fresh views list', () => {
    const a = renderHook(() => useSavedPagesViews(BASE_TUPLE))
    const b = renderHook(() => useSavedPagesViews(BASE_TUPLE))

    act(() => {
      a.result.current.saveView('Shared', BASE_TUPLE)
    })

    expect(b.result.current.views).toHaveLength(1)
    expect(b.result.current.views[0]?.name).toBe('Shared')
  })

  describe('activeView detection', () => {
    it('matches the saved view whose tuple equals the current tuple', () => {
      const { result, rerender } = renderHook(
        ({ tuple }: { tuple: PagesViewTuple }) => useSavedPagesViews(tuple),
        { initialProps: { tuple: BASE_TUPLE } },
      )

      act(() => {
        result.current.saveView('Match', BASE_TUPLE)
      })
      rerender({ tuple: BASE_TUPLE })

      expect(result.current.activeView?.name).toBe('Match')
    })

    it('returns null when the current tuple matches no saved view', () => {
      const { result, rerender } = renderHook(
        ({ tuple }: { tuple: PagesViewTuple }) => useSavedPagesViews(tuple),
        { initialProps: { tuple: BASE_TUPLE } },
      )

      act(() => {
        result.current.saveView('Other', { ...BASE_TUPLE, sort: 'recent' })
      })
      rerender({ tuple: BASE_TUPLE })

      expect(result.current.activeView).toBeNull()
    })

    it('returns null when currentTuple is omitted', () => {
      const { result } = renderHook(() => useSavedPagesViews())
      act(() => {
        result.current.saveView('Untargeted', BASE_TUPLE)
      })
      expect(result.current.activeView).toBeNull()
    })
  })

  describe('schemaMismatchDetected', () => {
    it('is false when nothing is stored', () => {
      const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
      expect(result.current.schemaMismatchDetected).toBe(false)
    })

    it('is true on mount when a future/unknown schemaVersion payload is on disk', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999, views: [] }))
      const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
      expect(result.current.schemaMismatchDetected).toBe(true)
      // The mismatched payload was still discarded back to the empty envelope.
      expect(result.current.views).toEqual([])
    })

    it('clearSchemaMismatch acknowledges the notice so it does not re-arm', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999, views: [] }))
      const { result } = renderHook(() => useSavedPagesViews(BASE_TUPLE))
      expect(result.current.schemaMismatchDetected).toBe(true)

      act(() => {
        result.current.clearSchemaMismatch()
      })

      expect(result.current.schemaMismatchDetected).toBe(false)
    })
  })
})
