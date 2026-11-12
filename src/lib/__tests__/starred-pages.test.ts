/**
 * The one-time move of a device's localStorage bookmarks into the synced
 * `bookmark` page property (#6544).
 *
 * `invoke` is routed through the real tauri-mock `dispatch`, so each
 * assertion re-reads the stored property.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addDeviceBookmarks, migrateDeviceBookmarks } from '@/lib/starred-pages'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const QN = SEED_IDS.PAGE_QUICK_NOTES
const PROJ = SEED_IDS.PAGE_PROJECTS
const MEET = SEED_IDS.PAGE_MEETINGS
const GS = SEED_IDS.PAGE_GETTING_STARTED
const PURGED = '0000000000000000000PURGED1'

function seedBookmark(id: string, num: number): void {
  const held = properties.get(id) ?? new Map<string, Record<string, unknown>>()
  held.set('bookmark', {
    block_id: id,
    key: 'bookmark',
    value_text: null,
    value_num: num,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
  properties.set(id, held)
}

function storedOrder(id: string): unknown {
  return properties.get(id)?.get('bookmark')?.['value_num']
}

function storeDeviceList(ids: string[]): void {
  localStorage.setItem('starred-pages', JSON.stringify(ids))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  seedBlocks()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
})

describe('migrateDeviceBookmarks', () => {
  it('writes the device list in its order after the highest bookmark, then forgets the list', async () => {
    seedBookmark(GS, 7)
    storeDeviceList([QN, PROJ])

    await migrateDeviceBookmarks(['SPACE_PERSONAL'])

    expect(storedOrder(QN)).toBe(8)
    expect(storedOrder(PROJ)).toBe(9)
    expect(storedOrder(GS)).toBe(7)
    expect(localStorage.getItem('starred-pages')).toBeNull()
  })

  it('keeps a bookmark another device already synced, and drops a purged or trashed page', async () => {
    seedBookmark(PROJ, 3)
    const trashed = blocks.get(MEET)
    if (trashed) trashed['deleted_at'] = '2026-11-01T00:00:00Z'
    storeDeviceList([PURGED, PROJ, MEET, QN])

    await migrateDeviceBookmarks(['SPACE_PERSONAL'])

    expect(storedOrder(PROJ)).toBe(3)
    expect(properties.get(MEET)?.has('bookmark') ?? false).toBe(false)
    expect(storedOrder(QN)).toBe(4)
    expect(localStorage.getItem('starred-pages')).toBeNull()
  })

  it('keeps the list when a write fails, and the next boot finishes without duplicates', async () => {
    storeDeviceList([QN, PROJ])
    let failOnce = true
    vi.mocked(invoke).mockImplementation((cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property' && (args as { blockId?: string }).blockId === PROJ && failOnce) {
        failOnce = false
        return Promise.reject({ kind: 'database', message: 'disk I/O error' })
      }
      return Promise.resolve(dispatch(cmd, args))
    })

    await migrateDeviceBookmarks(['SPACE_PERSONAL'])

    expect(localStorage.getItem('starred-pages')).toBe(JSON.stringify([QN, PROJ]))
    expect(storedOrder(QN)).toBe(1)

    await migrateDeviceBookmarks(['SPACE_PERSONAL'])

    expect(storedOrder(QN)).toBe(1)
    expect(storedOrder(PROJ)).toBe(2)
    expect(localStorage.getItem('starred-pages')).toBeNull()
  })

  it('sends nothing when the device holds no list', async () => {
    await migrateDeviceBookmarks(['SPACE_PERSONAL'])

    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })
})

describe('addDeviceBookmarks', () => {
  it('adds the rescued ids the migration will move, once each', () => {
    storeDeviceList([QN])

    addDeviceBookmarks([PROJ, QN])

    expect(JSON.parse(localStorage.getItem('starred-pages') ?? 'null')).toEqual([QN, PROJ])
  })
})
