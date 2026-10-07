/**
 * #5281 — the single-block `restore_block` refuses to revive a tag onto a name
 * a live tag of its space holds. Rename and batch restore are pinned by the
 * backend-authored `tag_name_unique_on_rename_and_restore.json` fixture; this
 * command takes a `deleted_at` ref the two stacks mint differently, so no
 * fixture can drive it. Rust twin: `restore_block_rejects_tag_whose_name_a_live_tag_holds_5281`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { validationCode } from '@/lib/app-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties } from '@/lib/tauri-mock/seed'

const SPACE_A = '01SPACEA000000000000000001'
const SPACE_B = '01SPACEB000000000000000001'
const TRASHED_A = '000000000000000000TRASHEDA'
const LIVE_A = '000000000000000000000LIVEA'
const TRASHED_B = '000000000000000000TRASHEDB'

function seedTag(id: string, name: string, spaceId: string, deletedAt: string | null): void {
  blocks.set(id, {
    ...makeBlock(id, 'tag', name, null, 1),
    space_id: spaceId,
    deleted_at: deletedAt,
  })
}

describe('tauri-mock restore_block tag-name uniqueness (#5281)', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    opLog.length = 0
    seedTag(TRASHED_A, 'meeting', SPACE_A, '2026-01-01T00:00:00.000Z#000001')
    seedTag(LIVE_A, 'Meeting', SPACE_A, null)
    seedTag(TRASHED_B, 'meeting', SPACE_B, '2026-01-01T00:00:00.000Z#000002')
  })

  it('refuses a tag whose name a live tag of its space holds, restoring nothing', () => {
    let thrown: unknown = null
    try {
      dispatch('restore_block', { blockId: TRASHED_A, deletedAtRef: 0 })
    } catch (err) {
      thrown = err
    }

    expect(validationCode(thrown)).toBe('DuplicatePageTitle')
    expect(blocks.get(TRASHED_A)?.['deleted_at']).toBe('2026-01-01T00:00:00.000Z#000001')
    expect(opLog.length).toBe(0)
  })

  it('restores a tag whose name is held only in another space', () => {
    dispatch('restore_block', { blockId: TRASHED_B, deletedAtRef: 0 })

    expect(blocks.get(TRASHED_B)?.['deleted_at']).toBeNull()
    expect(opLog.map((o) => o.op_type)).toEqual(['restore_block'])
  })
})
