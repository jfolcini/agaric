/**
 * Tests for the Advanced Query saved views adapter (#5738): save / rename /
 * delete round-trip through `PREFERENCES.savedQueryViews`, kept per space, and
 * a corrupt stored value reading as no views.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { PREFERENCES, readPreference } from '@/lib/preferences'
import { deleteSavedQueryView, renameSavedQueryView, saveQueryView } from '@/lib/saved-query-views'

const SPACE_A = 'SPACE_A'
const SPACE_B = 'SPACE_B'
const KEY_A = `agaric:advancedQuery:savedViews:${SPACE_A}`
const SPEC = JSON.stringify({ filter: { type: 'And', children: [] } })

function viewsIn(spaceId: string): Array<{ name: string; spec: string }> {
  return readPreference(PREFERENCES.savedQueryViews, spaceId).map(({ name, spec }) => ({
    name,
    spec,
  }))
}

beforeEach(() => {
  localStorage.clear()
})

describe('saved-query-views', () => {
  it('saves views in creation order, in their own space only', () => {
    saveQueryView(SPACE_A, 'First', SPEC)
    saveQueryView(SPACE_A, 'Second', '{}')

    expect(viewsIn(SPACE_A)).toEqual([
      { name: 'First', spec: SPEC },
      { name: 'Second', spec: '{}' },
    ])
    expect(viewsIn(SPACE_B)).toEqual([])
    expect(localStorage.getItem(KEY_A)).not.toBeNull()
  })

  it('renames and deletes a view by id, leaving the others', () => {
    const first = saveQueryView(SPACE_A, 'First', SPEC)
    const second = saveQueryView(SPACE_A, 'Second', SPEC)

    renameSavedQueryView(SPACE_A, first.id, 'Renamed')
    expect(viewsIn(SPACE_A).map((v) => v.name)).toEqual(['Renamed', 'Second'])

    deleteSavedQueryView(SPACE_A, second.id)
    expect(viewsIn(SPACE_A).map((v) => v.name)).toEqual(['Renamed'])
  })

  it('reads invalid JSON or a non-array as no views', () => {
    localStorage.setItem(KEY_A, 'not-json')
    expect(viewsIn(SPACE_A)).toEqual([])
    localStorage.setItem(KEY_A, JSON.stringify({ views: [] }))
    expect(viewsIn(SPACE_A)).toEqual([])
  })

  it('drops malformed entries and keeps the valid ones', () => {
    localStorage.setItem(
      KEY_A,
      JSON.stringify([
        { id: 'v1', name: 'Valid', spec: SPEC },
        { id: '', name: 'Empty id', spec: SPEC },
        { id: 'v3', name: 'Object spec', spec: { filter: null } },
        { id: 'v4', spec: SPEC },
        'not-an-object',
      ]),
    )
    expect(viewsIn(SPACE_A)).toEqual([{ name: 'Valid', spec: SPEC }])
  })

  it('saving over a corrupt value starts a fresh list', () => {
    localStorage.setItem(KEY_A, 'not-json')
    saveQueryView(SPACE_A, 'Fresh', SPEC)
    expect(viewsIn(SPACE_A)).toEqual([{ name: 'Fresh', spec: SPEC }])
  })
})
