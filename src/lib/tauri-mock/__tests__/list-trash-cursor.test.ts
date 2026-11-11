/**
 * `list_trash`'s keyset cursor carries `deleted_at` the way the backend's
 * `Cursor.deleted_at: Option<String>` does: the epoch-ms value as a string,
 * which `pagination/trash.rs` parses back to an integer.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { base64UrlToUtf8 } from '@/lib/base64url'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, seedBlocks } from '@/lib/tauri-mock/seed'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

interface TrashPage {
  items: Record<string, unknown>[]
  next_cursor: string | null
}

function leafContentIds(count: number): string[] {
  const rows = [...blocks.values()]
  const parents = new Set(rows.map((b) => b['parent_id']))
  return rows
    .filter((b) => b['block_type'] === 'content' && !parents.has(b['id']) && !b['deleted_at'])
    .slice(0, count)
    .map((b) => b['id'] as string)
}

describe('list_trash cursor', () => {
  beforeEach(() => {
    seedBlocks()
  })

  it('carries deleted_at as a string and pages on it', () => {
    const [first, second] = leafContentIds(2)
    dispatch('delete_block', { blockId: first })
    dispatch('delete_block', { blockId: second })

    const page1 = dispatch('list_trash', { scope: SCOPE, limit: 1 }) as TrashPage
    expect(page1.items.map((b) => b['id'])).toEqual([second])
    const cursor = JSON.parse(base64UrlToUtf8(page1.next_cursor ?? '')) as Record<string, unknown>
    expect(cursor['deleted_at']).toBe(String(page1.items[0]?.['deleted_at']))

    const page2 = dispatch('list_trash', {
      scope: SCOPE,
      limit: 1,
      cursor: page1.next_cursor,
    }) as TrashPage
    expect(page2.items.map((b) => b['id'])).toEqual([first])
  })
})
