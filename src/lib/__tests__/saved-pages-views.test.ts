/**
 * Pages-view saved views (#2003 piece 1):
 *  - the device's old localStorage list (`PREFERENCES.savedPagesViews`) as
 *    the migration into view pages reads it (#6544): the `schemaVersion`
 *    guard, malformed entries, the retired `default` sort and `density` field
 *  - `findMatchingSavedPagesView` / `viewMatchesTuple` structural equality
 *  - `dropOtherSpacesTagChips`
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { FilterPrimitive } from '@/lib/bindings'
import { PREFERENCES, readPreference } from '@/lib/preferences'
import {
  dropOtherSpacesTagChips,
  findMatchingSavedPagesView,
  type PagesViewTuple,
  type SavedPagesView,
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

function getSavedPagesViews() {
  return readPreference(PREFERENCES.savedPagesViews).views
}

function view(name: string, tuple: PagesViewTuple): SavedPagesView {
  return { id: name, name, ...tuple }
}

describe('saved-pages-views', () => {
  describe('the device list the migration reads', () => {
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

    // #5371 — the retired `default` sort reads as `created`, so a view saved
    // under it is kept, not dropped as an unknown sort.
    it('keeps a view saved under the retired `default` sort, as Created', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          views: [
            {
              id: 'old',
              name: 'Old',
              createdAt: '2026-01-01T00:00:00.000Z',
              sort: 'default',
              filters: [TAG_FILTER],
            },
            { id: 'v1', name: 'Valid', createdAt: '2026-01-01T00:00:00.000Z', ...BASE_TUPLE },
          ],
        }),
      )
      const views = getSavedPagesViews()
      expect(views.map((v) => [v.id, v.sort])).toEqual([
        ['old', 'created'],
        ['v1', 'alphabetical'],
      ])
      expect(
        findMatchingSavedPagesView(views, { sort: 'created', filters: [TAG_FILTER] })?.id,
      ).toBe('old')
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

  describe('viewMatchesTuple / findMatchingSavedPagesView', () => {
    it('matches when sort and filters are both structurally equal', () => {
      const v = view('Match me', { ...BASE_TUPLE, filters: [TAG_FILTER] })
      expect(viewMatchesTuple(v, { ...BASE_TUPLE, filters: [TAG_FILTER] })).toBe(true)
    })

    it('does not match when sort differs', () => {
      expect(viewMatchesTuple(view('View', BASE_TUPLE), { ...BASE_TUPLE, sort: 'recent' })).toBe(
        false,
      )
    })

    it('does not match when filters differ in content', () => {
      const v = view('View', { ...BASE_TUPLE, filters: [TAG_FILTER] })
      expect(viewMatchesTuple(v, { ...BASE_TUPLE, filters: [{ type: 'Tag', tag: 'home' }] })).toBe(
        false,
      )
    })

    it('does not match when filter order differs', () => {
      const other: FilterPrimitive = { type: 'Tag', tag: 'home' }
      const v = view('View', { ...BASE_TUPLE, filters: [TAG_FILTER, other] })
      expect(viewMatchesTuple(v, { ...BASE_TUPLE, filters: [other, TAG_FILTER] })).toBe(false)
    })

    it('findMatchingSavedPagesView returns the matching view', () => {
      const a = view('A', { ...BASE_TUPLE, sort: 'recent' })
      const b = view('B', BASE_TUPLE)
      expect(findMatchingSavedPagesView([a, b], BASE_TUPLE)?.id).toBe('B')
    })

    it('findMatchingSavedPagesView returns null when nothing matches', () => {
      const a = view('A', { ...BASE_TUPLE, sort: 'recent' })
      expect(findMatchingSavedPagesView([a], { ...BASE_TUPLE, sort: 'created' })).toBeNull()
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
