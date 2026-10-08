/**
 * Tests for the saved Pages views localStorage adapter (#2003 piece 1).
 *
 * Validates:
 *  - round-trip save/read/delete against `PREFERENCES.savedPagesViews`
 *  - the `schemaVersion` guard silently discards a mismatched envelope
 *  - `peekSavedPagesViewsSchemaMismatch` recovers the discard signal that
 *    `parse` itself can't surface
 *  - cross-tab broadcast: every registry write dispatches a synthetic
 *    `StorageEvent` for the key (the app-wide same-tab convention, #2666)
 *  - `findMatchingSavedPagesView` / `viewMatchesTuple` structural equality
 *  - a view saved while views still carried `density` loads and matches
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { FilterPrimitive } from '@/lib/bindings'
import { PREFERENCES } from '@/lib/preferences'
import {
  deleteSavedPagesView,
  dropOtherSpacesTagChips,
  findMatchingSavedPagesView,
  getSavedPagesViews,
  type PagesViewTuple,
  peekSavedPagesViewsSchemaMismatch,
  savePagesView,
  viewMatchesTuple,
} from '@/lib/saved-pages-views'

const STORAGE_KEY = 'agaric:pages:savedViews:v1'

const TAG_FILTER: FilterPrimitive = { type: 'Tag', tag: 'work' }

const BASE_TUPLE: PagesViewTuple = {
  sort: 'alphabetical',
  filters: [],
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
})

describe('saved-pages-views', () => {
  describe('getSavedPagesViews', () => {
    it('returns empty array when nothing is stored', () => {
      expect(getSavedPagesViews()).toEqual([])
    })

    it('returns empty array for invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-json')
      expect(getSavedPagesViews()).toEqual([])
    })

    it('returns empty array when schemaVersion is missing entirely', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [] }))
      expect(getSavedPagesViews()).toEqual([])
    })

    it('discards the payload when schemaVersion is a future/unknown value', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 999,
          views: [
            { id: 'v1', name: 'Future view', createdAt: '2030-01-01T00:00:00.000Z', ...BASE_TUPLE },
          ],
        }),
      )
      expect(getSavedPagesViews()).toEqual([])
    })

    it('filters out structurally invalid entries but keeps valid ones', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          views: [
            { id: 'v1', name: 'Valid', createdAt: '2026-01-01T00:00:00.000Z', ...BASE_TUPLE },
            {
              id: 'v2',
              name: 'Bad sort',
              createdAt: '2026-01-01T00:00:00.000Z',
              sort: 'nope',
              filters: [],
            },
            { id: '', name: 'Empty id', createdAt: '2026-01-01T00:00:00.000Z', ...BASE_TUPLE },
            'not-an-object',
          ],
        }),
      )
      const views = getSavedPagesViews()
      expect(views).toHaveLength(1)
      expect(views[0]?.id).toBe('v1')
    })

    it('keeps a view saved with the retired `density` field and matches it as active', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          views: [
            {
              id: 'legacy',
              name: 'Legacy',
              createdAt: '2026-01-01T00:00:00.000Z',
              ...BASE_TUPLE,
              density: 'compact',
            },
          ],
        }),
      )
      const views = getSavedPagesViews()
      expect(views.map((v) => v.id)).toEqual(['legacy'])
      expect(findMatchingSavedPagesView(views, BASE_TUPLE)?.id).toBe('legacy')
    })
  })

  describe('savePagesView / deleteSavedPagesView round-trip', () => {
    it('saves a view and reads it back with a generated id and timestamp', () => {
      const view = savePagesView('My view', BASE_TUPLE)
      expect(view.name).toBe('My view')
      expect(view.id).toBeTruthy()
      expect(view.createdAt).toBeTruthy()
      expect(getSavedPagesViews()).toEqual([view])
    })

    it('appends to existing views without clobbering them', () => {
      const first = savePagesView('First', BASE_TUPLE)
      const second = savePagesView('Second', { ...BASE_TUPLE, sort: 'recent' })
      expect(getSavedPagesViews()).toEqual([first, second])
    })

    it('generates distinct ids for views saved under the same name', () => {
      const a = savePagesView('Dup', BASE_TUPLE)
      const b = savePagesView('Dup', BASE_TUPLE)
      expect(a.id).not.toBe(b.id)
      expect(getSavedPagesViews()).toHaveLength(2)
    })

    it('persists filters verbatim', () => {
      savePagesView('With filters', { ...BASE_TUPLE, filters: [TAG_FILTER] })
      expect(getSavedPagesViews()[0]?.filters).toEqual([TAG_FILTER])
    })

    it('deletes a view by id', () => {
      const a = savePagesView('A', BASE_TUPLE)
      const b = savePagesView('B', BASE_TUPLE)
      deleteSavedPagesView(a.id)
      expect(getSavedPagesViews()).toEqual([b])
    })

    it('deleting an unknown id is a no-op', () => {
      const a = savePagesView('A', BASE_TUPLE)
      deleteSavedPagesView('does-not-exist')
      expect(getSavedPagesViews()).toEqual([a])
    })
  })

  describe('viewMatchesTuple / findMatchingSavedPagesView', () => {
    it('matches when sort and filters are both structurally equal', () => {
      const view = savePagesView('Match me', { ...BASE_TUPLE, filters: [TAG_FILTER] })
      expect(viewMatchesTuple(view, { ...BASE_TUPLE, filters: [TAG_FILTER] })).toBe(true)
    })

    it('does not match when sort differs', () => {
      const view = savePagesView('View', BASE_TUPLE)
      expect(viewMatchesTuple(view, { ...BASE_TUPLE, sort: 'recent' })).toBe(false)
    })

    it('does not match when filters differ in content', () => {
      const view = savePagesView('View', { ...BASE_TUPLE, filters: [TAG_FILTER] })
      expect(
        viewMatchesTuple(view, { ...BASE_TUPLE, filters: [{ type: 'Tag', tag: 'home' }] }),
      ).toBe(false)
    })

    it('does not match when filter order differs', () => {
      const other: FilterPrimitive = { type: 'Tag', tag: 'home' }
      const view = savePagesView('View', { ...BASE_TUPLE, filters: [TAG_FILTER, other] })
      expect(viewMatchesTuple(view, { ...BASE_TUPLE, filters: [other, TAG_FILTER] })).toBe(false)
    })

    it('findMatchingSavedPagesView returns the matching view', () => {
      const a = savePagesView('A', { ...BASE_TUPLE, sort: 'recent' })
      const b = savePagesView('B', BASE_TUPLE)
      const found = findMatchingSavedPagesView(getSavedPagesViews(), BASE_TUPLE)
      expect(found?.id).toBe(b.id)
      expect(a.sort).toBe('recent')
    })

    it('findMatchingSavedPagesView returns null when nothing matches', () => {
      savePagesView('A', { ...BASE_TUPLE, sort: 'recent' })
      const found = findMatchingSavedPagesView(getSavedPagesViews(), {
        ...BASE_TUPLE,
        sort: 'created',
      })
      expect(found).toBeNull()
    })
  })

  describe('peekSavedPagesViewsSchemaMismatch', () => {
    it('returns false when nothing is stored', () => {
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(false)
    })

    it('returns false when the stored schemaVersion matches the current one', () => {
      savePagesView('View', BASE_TUPLE)
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(false)
    })

    it('returns false for invalid JSON (indistinguishable from "nothing meaningful stored")', () => {
      localStorage.setItem(STORAGE_KEY, 'not-json')
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(false)
    })

    it('returns false when schemaVersion is absent from an otherwise valid object', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ views: [] }))
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(false)
    })

    it('returns true when the stored schemaVersion is a future/unknown value', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999, views: [] }))
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(true)
    })

    it('reflects PREFERENCES.savedPagesViews.defaultValue.schemaVersion as the "current" version', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: PREFERENCES.savedPagesViews.defaultValue.schemaVersion,
          views: [],
        }),
      )
      expect(peekSavedPagesViewsSchemaMismatch()).toBe(false)
    })
  })

  describe('cross-tab broadcast (#2666 synthetic StorageEvent)', () => {
    it('savePagesView dispatches a storage event for the key', () => {
      const handler = vi.fn()
      window.addEventListener('storage', handler)
      savePagesView('View', BASE_TUPLE)
      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0]?.[0] as StorageEvent
      expect(event.key).toBe(STORAGE_KEY)
      window.removeEventListener('storage', handler)
    })

    it('deleteSavedPagesView dispatches a storage event for the key', () => {
      const view = savePagesView('View', BASE_TUPLE)
      const handler = vi.fn()
      window.addEventListener('storage', handler)
      deleteSavedPagesView(view.id)
      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0]?.[0] as StorageEvent
      expect(event.key).toBe(STORAGE_KEY)
      window.removeEventListener('storage', handler)
    })
  })
})

// #5294 — a saved view applied in another space must not carry that space's tag ids.
describe('dropOtherSpacesTagChips', () => {
  const here = { tag_id: 'TAG_HERE', name: 'here', usage_count: 1, updated_at: '' }
  const chips: FilterPrimitive[] = [
    { type: 'Tag', tag: 'TAG_HERE' },
    { type: 'TagOrRef', tag: 'TAG_ELSEWHERE' },
    { type: 'Orphan' },
  ]

  it('keeps only the tag chips whose tag is in the space', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ list_all_tags_in_space: () => [here] }),
    )

    expect(await dropOtherSpacesTagChips(chips, 'SPACE_A')).toEqual([
      { type: 'Tag', tag: 'TAG_HERE' },
      { type: 'Orphan' },
    ])
  })

  it('returns the chips unchanged when the space tags cannot be listed', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        list_all_tags_in_space: () => Promise.reject(new Error('backend down')),
      }),
    )

    expect(await dropOtherSpacesTagChips(chips, 'SPACE_A')).toEqual(chips)
  })
})
