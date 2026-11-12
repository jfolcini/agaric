/**
 * Saved views as pages carrying the synced `saved_view` property (#6544):
 * the payload codec, the per-space list, save / rename / delete / restore,
 * and the one-time move of the device's localStorage views.
 *
 * `invoke` is routed through the real tauri-mock `dispatch`, so every
 * assertion re-reads the mock's stored pages and properties.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { utf8ToBase64Url } from '@/lib/base64url'
import { PREFERENCES, writePreference } from '@/lib/preferences'
import {
  decodeSavedView,
  deleteSavedView,
  encodeSavedView,
  loadSavedViews,
  migrateDeviceSavedViews,
  renameSavedView,
  restoreSavedView,
  type SavedViewPayload,
  saveView,
} from '@/lib/saved-views'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const PERSONAL = 'SPACE_PERSONAL'
const WORK = 'SPACE_WORK'
const ORPHANS: SavedViewPayload = {
  kind: 'pages',
  sort: 'most-content',
  filters: [{ type: 'Orphan' }],
}
const SPEC = { filter: { type: 'And', children: [] }, sort: [], fulltext: 'x' }

/** The live view pages of `spaceId` as the mock stores them: title and decoded payload. */
function storedViews(spaceId: string): Array<{ title: unknown; payload: SavedViewPayload | null }> {
  return [...blocks.values()]
    .filter((b) => {
      const held = properties.get(b['id'] as string)?.has('saved_view') ?? false
      return held && !b['deleted_at'] && b['space_id'] === spaceId
    })
    .map((b) => ({
      title: b['content'],
      payload: decodeSavedView(
        (properties.get(b['id'] as string)?.get('saved_view')?.['value_text'] as string) ?? null,
      ),
    }))
}

function setRawValue(id: string, valueText: string): void {
  const held = properties.get(id) ?? new Map<string, Record<string, unknown>>()
  held.set('saved_view', {
    block_id: id,
    key: 'saved_view',
    value_text: valueText,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
  properties.set(id, held)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('__mockWorkSpace', 'true')
  seedBlocks()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
})

describe('encodeSavedView / decodeSavedView', () => {
  it.each([
    ['a Pages view', ORPHANS],
    ['an Advanced Query view', { kind: 'query', spec: SPEC } as SavedViewPayload],
  ])('round-trips %s through a `v1:` base64url value', (_label, payload) => {
    const value = encodeSavedView(payload)

    expect(value).toMatch(/^v1:[A-Za-z0-9_-]+$/)
    expect(decodeSavedView(value)).toEqual(payload)
  })

  it.each([
    ['no value', null],
    ['another version', `v2:${utf8ToBase64Url(JSON.stringify(ORPHANS))}`],
    ['bytes that are not base64url', 'v1:***'],
    ['text that is not JSON', `v1:${utf8ToBase64Url('{not json')}`],
    ['an unknown kind', `v1:${utf8ToBase64Url(JSON.stringify({ ...ORPHANS, kind: 'board' }))}`],
    ['an unknown sort', `v1:${utf8ToBase64Url(JSON.stringify({ ...ORPHANS, sort: 'size' }))}`],
    ['a query without a spec', `v1:${utf8ToBase64Url(JSON.stringify({ kind: 'query' }))}`],
  ])('reads %s as no view', (_label, value) => {
    expect(decodeSavedView(value)).toBeNull()
  })

  it('leaves a view whose value cannot be read out of the list instead of failing it', async () => {
    const kept = await saveView(PERSONAL, 'Kept', ORPHANS)
    const broken = await saveView(PERSONAL, 'Broken', ORPHANS)
    setRawValue(broken?.id ?? '', 'v1:***')

    expect((await loadSavedViews(PERSONAL)).map((v) => v.id)).toEqual([kept?.id])
  })
})

describe('saveView', () => {
  it('makes a page in the space titled as the view, carrying its payload', async () => {
    const view = await saveView(PERSONAL, 'Orphans by size', ORPHANS)

    expect(view?.name).toBe('Orphans by size')
    expect(storedViews(PERSONAL)).toEqual([{ title: 'Orphans by size', payload: ORPHANS }])
    expect(storedViews(WORK)).toEqual([])
    expect(await loadSavedViews(PERSONAL)).toEqual([view])
  })

  it('refuses a live page title and leaves that page unstamped', async () => {
    const view = await saveView(PERSONAL, 'projects', ORPHANS)

    expect(view).toBeNull()
    expect(properties.get(SEED_IDS.PAGE_PROJECTS)?.has('saved_view') ?? false).toBe(false)
    expect(storedViews(PERSONAL)).toEqual([])
  })

  it('refuses the name of another view of the space, and takes it in another space', async () => {
    await saveView(PERSONAL, 'Mine', ORPHANS)

    expect(await saveView(PERSONAL, 'MINE ', { kind: 'query', spec: SPEC })).toBeNull()
    expect(storedViews(PERSONAL)).toEqual([{ title: 'Mine', payload: ORPHANS }])
    expect(await saveView(WORK, 'Mine', ORPHANS)).not.toBeNull()
  })
})

describe('renameSavedView', () => {
  it('retitles the view page, and refuses a name the space holds', async () => {
    const view = await saveView(PERSONAL, 'Draft', ORPHANS)
    const id = view?.id ?? ''

    expect(await renameSavedView(PERSONAL, id, 'Final')).toBe(true)
    expect(blocks.get(id)?.['content']).toBe('Final')
    expect(await renameSavedView(PERSONAL, id, 'Quick Notes')).toBe(false)
    expect(blocks.get(id)?.['content']).toBe('Final')
    // Its own title respelled is not taken.
    expect(await renameSavedView(PERSONAL, id, 'FINAL')).toBe(true)
    expect(blocks.get(id)?.['content']).toBe('FINAL')
  })
})

describe('deleteSavedView / restoreSavedView', () => {
  it('moves the view page to the Trash, and a restore lists it again', async () => {
    const view = await saveView(PERSONAL, 'Doomed', ORPHANS)
    const id = view?.id ?? ''

    const deletedAt = await deleteSavedView(id)

    expect(blocks.get(id)?.['deleted_at']).not.toBeNull()
    expect(await loadSavedViews(PERSONAL)).toEqual([])

    await restoreSavedView(id, deletedAt)

    expect(blocks.get(id)?.['deleted_at']).toBeNull()
    expect((await loadSavedViews(PERSONAL)).map((v) => v.name)).toEqual(['Doomed'])
  })
})

describe('migrateDeviceSavedViews', () => {
  const TAGGED = {
    id: 'v-tagged',
    name: 'Work tagged',
    createdAt: '2026-01-01T00:00:00.000Z',
    sort: 'alphabetical' as const,
    filters: [{ type: 'Tag' as const, tag: SEED_IDS.TAG_WORK }, { type: 'Orphan' as const }],
  }

  function storeDevicePagesViews(): void {
    writePreference(PREFERENCES.savedPagesViews, { schemaVersion: 1, views: [TAGGED] })
  }

  it('copies the Pages views into every space, less the tag chips of other spaces', async () => {
    storeDevicePagesViews()

    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(storedViews(PERSONAL)).toEqual([
      {
        title: 'Work tagged',
        payload: { kind: 'pages', sort: 'alphabetical', filters: TAGGED.filters },
      },
    ])
    expect(storedViews(WORK)).toEqual([
      {
        title: 'Work tagged',
        payload: { kind: 'pages', sort: 'alphabetical', filters: [{ type: 'Orphan' }] },
      },
    ])
    expect(localStorage.getItem('agaric:pages:savedViews:v1')).toBeNull()
  })

  it('moves each space its own Advanced Query views and leaves a deleted space behind', async () => {
    writePreference(
      PREFERENCES.savedQueryViews,
      [
        { id: 'q1', name: 'Q', spec: JSON.stringify(SPEC) },
        // Never parsed, so never loaded: dropped rather than holding the key forever.
        { id: 'q0', name: 'Broken', spec: '{not json' },
      ],
      WORK,
    )
    writePreference(
      PREFERENCES.savedQueryViews,
      [{ id: 'q2', name: 'Gone', spec: JSON.stringify(SPEC) }],
      'SPACE_DELETED',
    )

    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(storedViews(WORK)).toEqual([{ title: 'Q', payload: { kind: 'query', spec: SPEC } }])
    expect(storedViews(PERSONAL)).toEqual([])
    expect(localStorage.getItem('agaric:advancedQuery:savedViews:SPACE_WORK')).toBeNull()
    expect(localStorage.getItem('agaric:advancedQuery:savedViews:SPACE_DELETED')).not.toBeNull()
  })

  it('skips a view whose payload the space already holds, and suffixes a taken title', async () => {
    await saveView(PERSONAL, 'Synced first', ORPHANS)
    writePreference(PREFERENCES.savedPagesViews, {
      schemaVersion: 1,
      views: [
        {
          ...TAGGED,
          id: 'same',
          name: 'Same payload',
          sort: 'most-content',
          filters: [{ type: 'Orphan' }],
        },
        { ...TAGGED, id: 'clash', name: 'Projects', filters: [] },
      ],
    })

    await migrateDeviceSavedViews([PERSONAL])

    expect(storedViews(PERSONAL)).toEqual([
      { title: 'Synced first', payload: ORPHANS },
      { title: 'Projects (2)', payload: { kind: 'pages', sort: 'alphabetical', filters: [] } },
    ])
    expect(blocks.get(SEED_IDS.PAGE_PROJECTS)?.['content']).toBe('Projects')
  })

  it('keeps the key when a write fails, and the next boot finishes without duplicates', async () => {
    storeDevicePagesViews()
    let failOnce = true
    vi.mocked(invoke).mockImplementation((cmd: string, args?: InvokeArgs) => {
      const spaceId = (args as { spaceId?: string } | undefined)?.spaceId
      if (cmd === 'create_page_in_space' && spaceId === WORK && failOnce) {
        failOnce = false
        return Promise.reject({ kind: 'database', message: 'disk I/O error' })
      }
      return Promise.resolve(dispatch(cmd, args))
    })

    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(localStorage.getItem('agaric:pages:savedViews:v1')).not.toBeNull()
    expect(storedViews(PERSONAL)).toHaveLength(1)
    expect(storedViews(WORK)).toHaveLength(0)

    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(storedViews(PERSONAL)).toHaveLength(1)
    expect(storedViews(WORK)).toHaveLength(1)
    expect(localStorage.getItem('agaric:pages:savedViews:v1')).toBeNull()
  })

  it('moves the well-formed entries of a device query list and leaves a corrupt one alone', async () => {
    localStorage.setItem(
      'agaric:advancedQuery:savedViews:SPACE_WORK',
      JSON.stringify([
        { id: 'q1', name: 'Q', spec: JSON.stringify(SPEC) },
        { id: 'q2', name: 7, spec: JSON.stringify({ ...SPEC, fulltext: 'y' }) },
        7,
      ]),
    )
    localStorage.setItem('agaric:advancedQuery:savedViews:SPACE_PERSONAL', '{not json')

    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(storedViews(WORK)).toEqual([{ title: 'Q', payload: { kind: 'query', spec: SPEC } }])
    expect(localStorage.getItem('agaric:advancedQuery:savedViews:SPACE_WORK')).toBeNull()
    expect(storedViews(PERSONAL)).toEqual([])
    expect(localStorage.getItem('agaric:advancedQuery:savedViews:SPACE_PERSONAL')).toBe('{not json')
  })

  it('sends nothing when the device holds no saved views', async () => {
    await migrateDeviceSavedViews([PERSONAL, WORK])

    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })
})
