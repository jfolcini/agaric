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

  it('returns children of Quick Notes page', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_QUICK_NOTES }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(2)
    for (const item of result.items) {
      expect(item.parent_id).toBe(SEED_IDS.PAGE_QUICK_NOTES)
    }
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
      position: 10,
    })
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_QUICK_NOTES }) as {
      items: Record<string, unknown>[]
    }
    // 2 seed children + 1 dynamically created
    expect(result.items).toHaveLength(3)
    expect(result.items.some((b) => b.content === 'new child')).toBe(true)
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

// ---------------------------------------------------------------------------
// move_block
// ---------------------------------------------------------------------------

describe('move_block', () => {
  it('updates parent_id and position', () => {
    const result = invoke('move_block', {
      blockId: SEED_IDS.BLOCK_GS_1,
      newParentId: SEED_IDS.PAGE_QUICK_NOTES,
      newPosition: 99,
    }) as Record<string, unknown>
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    expect(result.new_parent_id).toBe(SEED_IDS.PAGE_QUICK_NOTES)
    expect(result.new_position).toBe(99)
    // verify persisted
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.parent_id).toBe(SEED_IDS.PAGE_QUICK_NOTES)
    expect(block.position).toBe(99)
  })

  it('throws for non-existent block', () => {
    expect(() =>
      invoke('move_block', { blockId: 'NONEXISTENT', newParentId: null, newPosition: 0 }),
    ).toThrow('not found')
  })
})

// ---------------------------------------------------------------------------
// delete_block (cascade behavior)
// ---------------------------------------------------------------------------

describe('delete_block', () => {
  it('soft-deletes a block', () => {
    const result = invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.deleted_at).not.toBeNull()
  })

  it('deleted blocks excluded from list_blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.find((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBeUndefined()
  })

  it('deleted blocks excluded from search', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('search_blocks', { query: 'Welcome' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// property commands (set_property / get_properties / delete_property)
// ---------------------------------------------------------------------------

describe('property commands', () => {
  it('set_property creates a property', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: 'A',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >[]
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ key: 'priority', value_text: 'A' })
  })

  it('set_property overwrites existing key', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: 'A',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: 'B',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >[]
    expect(props).toHaveLength(1)
    expect(props[0].value_text).toBe('B')
  })

  it('delete_property removes a property', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: 'A',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    invoke('delete_property', { blockId: SEED_IDS.BLOCK_GS_1, key: 'priority' })
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >[]
    expect(props).toHaveLength(0)
  })

  it('get_properties returns empty array for block with no properties', () => {
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_2 }) as Record<
      string,
      unknown
    >[]
    expect(props).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// get_batch_properties
// ---------------------------------------------------------------------------

describe('get_batch_properties', () => {
  it('returns properties for multiple blocks', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'todo',
      valueText: 'TODO',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_2,
      key: 'priority',
      valueText: 'B',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const result = invoke('get_batch_properties', {
      blockIds: [SEED_IDS.BLOCK_GS_1, SEED_IDS.BLOCK_GS_2, SEED_IDS.BLOCK_GS_3],
    }) as Record<string, Record<string, unknown>[]>
    expect(result[SEED_IDS.BLOCK_GS_1]).toHaveLength(1)
    expect(result[SEED_IDS.BLOCK_GS_2]).toHaveLength(1)
    expect(result[SEED_IDS.BLOCK_GS_3]).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// undo_page_op
// ---------------------------------------------------------------------------

describe('undo_page_op', () => {
  it('returns UndoResult shape', () => {
    // Create an op first so there's something to undo
    invoke('create_block', {
      blockType: 'content',
      content: 'undo-target',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })

    const result = invoke('undo_page_op', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
      undoDepth: 0,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('reversed_op')
    expect(result).toHaveProperty('new_op')
    expect(result).toHaveProperty('is_redo', false)
  })
})

// ---------------------------------------------------------------------------
// redo_page_op
// ---------------------------------------------------------------------------

describe('redo_page_op', () => {
  it('returns UndoResult shape with is_redo true', () => {
    // Create an op, then undo it, so there's an op to redo
    invoke('create_block', {
      blockType: 'content',
      content: 'redo-target',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    const undoResult = invoke('undo_page_op', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
      undoDepth: 0,
    }) as { reversed_op: { device_id: string; seq: number } }

    const result = invoke('redo_page_op', {
      undoDeviceId: undoResult.reversed_op.device_id,
      undoSeq: undoResult.reversed_op.seq,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('reversed_op')
    expect(result).toHaveProperty('new_op')
    expect(result).toHaveProperty('is_redo', true)
  })
})

// ---------------------------------------------------------------------------
// tag association commands (add_tag / remove_tag / list_tags_for_block / query_by_tags)
// ---------------------------------------------------------------------------

describe('add_tag + list_tags_for_block', () => {
  it('list_tags_for_block returns the tag after add_tag', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(1)
    expect(tags[0].tag_id).toBe(SEED_IDS.TAG_WORK)
    expect(tags[0].name).toBe('work')
  })

  it('list_tags_for_block returns multiple tags', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_PERSONAL })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_IDEA })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(3)
    const tagIds = tags.map((t) => t.tag_id)
    expect(tagIds).toContain(SEED_IDS.TAG_WORK)
    expect(tagIds).toContain(SEED_IDS.TAG_PERSONAL)
    expect(tagIds).toContain(SEED_IDS.TAG_IDEA)
  })

  it('adding the same tag twice does not duplicate', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(1)
  })

  it('returns empty array for block with no tags', () => {
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_2 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(0)
  })

  it('returns TagCacheRow shape', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags[0]).toHaveProperty('tag_id')
    expect(tags[0]).toHaveProperty('name')
    expect(tags[0]).toHaveProperty('usage_count')
    expect(tags[0]).toHaveProperty('updated_at')
  })
})

describe('remove_tag', () => {
  it('removes a tag from a block', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_PERSONAL })
    invoke('remove_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(1)
    expect(tags[0].tag_id).toBe(SEED_IDS.TAG_PERSONAL)
  })

  it('removing non-existent tag is a no-op', () => {
    invoke('remove_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(0)
  })

  it('removing the only tag leaves an empty list', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('remove_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(0)
  })
})

describe('query_by_tags', () => {
  it('returns blocks that have the specified tag', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_2, tagId: SEED_IDS.TAG_WORK })
    const result = invoke('query_by_tags', { tagIds: [SEED_IDS.TAG_WORK] }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(2)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_GS_1)
    expect(ids).toContain(SEED_IDS.BLOCK_GS_2)
  })

  it('returns empty when no blocks have the tag', () => {
    const result = invoke('query_by_tags', { tagIds: [SEED_IDS.TAG_IDEA] }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('uses AND logic for multiple tags', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_PERSONAL })
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_2, tagId: SEED_IDS.TAG_WORK })
    // Only BLOCK_GS_1 has both tags
    const result = invoke('query_by_tags', {
      tagIds: [SEED_IDS.TAG_WORK, SEED_IDS.TAG_PERSONAL],
    }) as { items: Record<string, unknown>[] }
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe(SEED_IDS.BLOCK_GS_1)
  })

  it('excludes deleted blocks', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('query_by_tags', { tagIds: [SEED_IDS.TAG_WORK] }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('query_by_tags', { tagIds: [SEED_IDS.TAG_WORK] }) as Record<
      string,
      unknown
    >
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

describe('resetMock clears tag associations', () => {
  it('tag associations are cleared after resetMock', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    resetMock()
    const tags = invoke('list_tags_for_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Array<
      Record<string, unknown>
    >
    expect(tags).toHaveLength(0)
  })
})
