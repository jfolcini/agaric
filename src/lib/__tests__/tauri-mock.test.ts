/**
 * Tests for src/lib/tauri-mock.ts — the in-memory Tauri IPC mock.
 *
 * These tests verify the mock's IPC command handler directly by capturing
 * the handler registered via mockIPC, then invoking it with command names
 * and args. This tests the mock layer in isolation from Tauri internals.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Capture the IPC handler registered by setupMock
// ---------------------------------------------------------------------------

type IpcHandler = (cmd: string, args: Record<string, unknown>) => unknown
let ipcHandler: IpcHandler | null = null

vi.mock('@tauri-apps/api/mocks', () => ({
  mockIPC: vi.fn((handler: IpcHandler) => {
    ipcHandler = handler
  }),
  mockWindows: vi.fn(),
}))

import { resetMock, SEED_IDS, setupMock } from '../tauri-mock'

/** Helper — call the captured IPC handler as if invoke() were called. */
function invoke(cmd: string, args: Record<string, unknown> = {}): unknown {
  if (!ipcHandler) throw new Error('setupMock() was not called — no IPC handler captured')
  return ipcHandler(cmd, args)
}

beforeEach(() => {
  setupMock()
})

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

describe('seed data', () => {
  it('populates pages', () => {
    const result = invoke('list_blocks', { blockType: 'page' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(3)
    const titles = result.items.map((b) => b.content)
    expect(titles).toContain('Getting Started')
    expect(titles).toContain('Quick Notes')
  })

  it('populates tags', () => {
    const result = invoke('list_blocks', { blockType: 'tag' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(3)
    const names = result.items.map((b) => b.content)
    expect(names).toContain('work')
    expect(names).toContain('personal')
    expect(names).toContain('idea')
  })

  it('populates daily page with today date', () => {
    const today = new Date()
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_DAILY }) as Record<string, unknown>
    expect(block.content).toBe(expected)
    expect(block.block_type).toBe('page')
  })

  it('populates children of Getting Started page', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(5)
    expect(result.items[0].content as string).toContain('Welcome')
  })

  it('populates children of daily page', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_DAILY }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(2)
    expect(result.items[0].content as string).toContain('standup')
  })

  it('resetMock re-seeds the store', () => {
    // Mutate state
    invoke('edit_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED, toText: 'Changed' })
    const changed = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(changed.content).toBe('Changed')

    // Reset and verify original seed is back
    resetMock()
    const restored = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(restored.content).toBe('Getting Started')
  })
})

// ---------------------------------------------------------------------------
// get_block
// ---------------------------------------------------------------------------

describe('get_block', () => {
  it('returns correct BlockRow shape for a seed page', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(block).toEqual({
      id: SEED_IDS.PAGE_GETTING_STARTED,
      block_type: 'page',
      content: 'Getting Started',
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
    })
  })

  it('returns correct data for a child block (parent lookup)', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.parent_id).toBe(SEED_IDS.PAGE_GETTING_STARTED)
    expect(block.block_type).toBe('content')
  })

  it('returns correct data for a tag block', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.TAG_WORK }) as Record<string, unknown>
    expect(block.block_type).toBe('tag')
    expect(block.content).toBe('work')
  })

  it('throws for non-existent block ID', () => {
    expect(() => invoke('get_block', { blockId: 'NONEXISTENT' })).toThrow('not found')
  })

  it('returns dynamically created blocks', () => {
    const created = invoke('create_block', {
      blockType: 'content',
      content: 'dynamic',
      parentId: SEED_IDS.PAGE_QUICK_NOTES,
    }) as Record<string, unknown>
    const fetched = invoke('get_block', { blockId: created.id as string }) as Record<
      string,
      unknown
    >
    expect(fetched.content).toBe('dynamic')
    expect(fetched.parent_id).toBe(SEED_IDS.PAGE_QUICK_NOTES)
  })
})

// ---------------------------------------------------------------------------
// list_blocks with parentId
// ---------------------------------------------------------------------------

describe('list_blocks with parentId', () => {
  it('returns only children of the specified parent', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(5)
    for (const item of result.items) {
      expect(item.parent_id).toBe(SEED_IDS.PAGE_GETTING_STARTED)
    }
  })

  it('returns empty for parent with no children', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_QUICK_NOTES }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('returns items sorted by position', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    const positions = result.items.map((b) => b.position as number)
    expect(positions).toEqual([0, 1, 2, 3, 4])
  })

  it('includes dynamically created children', () => {
    invoke('create_block', {
      blockType: 'content',
      content: 'new child',
      parentId: SEED_IDS.PAGE_QUICK_NOTES,
      position: 0,
    })
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_QUICK_NOTES }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(1)
    expect(result.items[0].content).toBe('new child')
  })

  it('combines parentId and blockType filters', () => {
    // No tags under Getting Started — only content blocks
    const result = invoke('list_blocks', {
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
      blockType: 'tag',
    }) as { items: Record<string, unknown>[] }
    expect(result.items).toHaveLength(0)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_DAILY }) as Record<
      string,
      unknown
    >
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

// ---------------------------------------------------------------------------
// list_tags_by_prefix
// ---------------------------------------------------------------------------

describe('list_tags_by_prefix', () => {
  it('returns all tags when prefix is empty', () => {
    const result = invoke('list_tags_by_prefix', { prefix: '' }) as Array<Record<string, unknown>>
    expect(result).toHaveLength(3)
  })

  it('filters tags by prefix (case-insensitive)', () => {
    const result = invoke('list_tags_by_prefix', { prefix: 'per' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('personal')
    expect(result[0].tag_id).toBe(SEED_IDS.TAG_PERSONAL)
  })

  it('returns TagCacheRow shape', () => {
    const result = invoke('list_tags_by_prefix', { prefix: 'work' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveProperty('tag_id', SEED_IDS.TAG_WORK)
    expect(result[0]).toHaveProperty('name', 'work')
    expect(result[0]).toHaveProperty('usage_count', 0)
    expect(result[0]).toHaveProperty('updated_at')
  })

  it('returns empty for non-matching prefix', () => {
    const result = invoke('list_tags_by_prefix', { prefix: 'zzz' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(0)
  })

  it('matches case-insensitively', () => {
    const result = invoke('list_tags_by_prefix', { prefix: 'WORK' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('work')
  })

  it('includes dynamically created tags', () => {
    invoke('create_block', { blockType: 'tag', content: 'project-alpha' })
    const result = invoke('list_tags_by_prefix', { prefix: 'project' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('project-alpha')
  })
})

// ---------------------------------------------------------------------------
// search_blocks
// ---------------------------------------------------------------------------

describe('search_blocks', () => {
  it('finds blocks by content substring', () => {
    const result = invoke('search_blocks', { query: 'knowledge base' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    expect((result.items[0].content as string).toLowerCase()).toContain('knowledge base')
  })

  it('search is case-insensitive', () => {
    const result = invoke('search_blocks', { query: 'WELCOME' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty for no match', () => {
    const result = invoke('search_blocks', { query: 'xyznonexistent' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('returns empty for empty query', () => {
    const result = invoke('search_blocks', { query: '' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('excludes deleted blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('search_blocks', { query: 'Welcome' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('search_blocks', { query: 'sidebar' }) as Record<string, unknown>
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

// ---------------------------------------------------------------------------
// edit_block
// ---------------------------------------------------------------------------

describe('edit_block', () => {
  it('persists content change in the store', () => {
    invoke('edit_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED, toText: 'New Title' })
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(block.content).toBe('New Title')
  })

  it('returns the updated block', () => {
    const result = invoke('edit_block', {
      blockId: SEED_IDS.BLOCK_GS_1,
      toText: 'Updated content',
    }) as Record<string, unknown>
    expect(result.content).toBe('Updated content')
    expect(result.id).toBe(SEED_IDS.BLOCK_GS_1)
  })

  it('edited content appears in search results', () => {
    invoke('edit_block', {
      blockId: SEED_IDS.BLOCK_GS_1,
      toText: 'unicorn rainbow sparkle',
    })
    const result = invoke('search_blocks', { query: 'unicorn rainbow' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe(SEED_IDS.BLOCK_GS_1)
  })

  it('edited page title persists across list_blocks', () => {
    invoke('edit_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED, toText: 'Renamed Page' })
    const result = invoke('list_blocks', { blockType: 'page' }) as {
      items: Record<string, unknown>[]
    }
    const page = result.items.find((b) => b.id === SEED_IDS.PAGE_GETTING_STARTED)
    expect(page?.content).toBe('Renamed Page')
  })

  it('throws for non-existent block', () => {
    expect(() => invoke('edit_block', { blockId: 'NONEXISTENT', toText: 'fail' })).toThrow(
      'not found',
    )
  })
})

// ---------------------------------------------------------------------------
// get_status (completeness check)
// ---------------------------------------------------------------------------

describe('get_status', () => {
  it('returns full StatusInfo shape', () => {
    const status = invoke('get_status') as Record<string, unknown>
    expect(status).toEqual({
      foreground_queue_depth: 0,
      background_queue_depth: 0,
      total_ops_dispatched: 0,
      total_background_dispatched: 0,
      fg_high_water: 0,
      bg_high_water: 0,
    })
  })
})
