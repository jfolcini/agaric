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

import { clearMockErrors, injectMockError, resetMock, SEED_IDS, setupMock } from '../tauri-mock'

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
    expect(result.items).toHaveLength(6)
    const titles = result.items.map((b) => b.content)
    expect(titles).toContain('Getting Started')
    expect(titles).toContain('Quick Notes')
    expect(titles).toContain('Projects')
    expect(titles).toContain('Meetings')
    expect(titles).toContain('Meeting Notes Template')
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
    expect(result.items[0]?.content as string).toContain('Welcome')
  })

  it('populates children of daily page', () => {
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_DAILY }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(5)
    expect(result.items[0]?.content as string).toContain('standup')
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
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
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
    expect(result[0]?.name).toBe('personal')
    expect(result[0]?.tag_id).toBe(SEED_IDS.TAG_PERSONAL)
  })

  it('returns TagCacheRow shape', () => {
    const result = invoke('list_tags_by_prefix', { prefix: 'work' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0] as Record<string, unknown>).toHaveProperty('tag_id', SEED_IDS.TAG_WORK)
    expect(result[0] as Record<string, unknown>).toHaveProperty('name', 'work')
    expect(result[0] as Record<string, unknown>).toHaveProperty('usage_count', 0)
    expect(result[0] as Record<string, unknown>).toHaveProperty('updated_at')
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
    expect(result[0]?.name).toBe('work')
  })

  it('includes dynamically created tags', () => {
    invoke('create_block', { blockType: 'tag', content: 'project-alpha' })
    const result = invoke('list_tags_by_prefix', { prefix: 'project' }) as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('project-alpha')
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
    expect((result.items[0]?.content as string).toLowerCase()).toContain('knowledge base')
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
    expect(result.items[0]?.id).toBe(SEED_IDS.BLOCK_GS_1)
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
      valueText: '1',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >[]
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ key: 'priority', value_text: '1' })
  })

  it('set_property overwrites existing key', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: '1',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: '2',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const props = invoke('get_properties', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >[]
    expect(props).toHaveLength(1)
    expect(props[0]?.value_text).toBe('2')
  })

  it('delete_property removes a property', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'priority',
      valueText: '1',
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
      valueText: '2',
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
    expect(result).toHaveProperty('new_op_ref')
    expect(result).toHaveProperty('new_op_type')
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
    expect(result).toHaveProperty('new_op_ref')
    expect(result).toHaveProperty('new_op_type')
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
    expect(tags[0]?.tag_id).toBe(SEED_IDS.TAG_WORK)
    expect(tags[0]?.name).toBe('work')
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
    expect(tags[0]?.tag_id).toBe(SEED_IDS.TAG_PERSONAL)
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
    // 2 dynamically added + 3 seed associations (PROJ_1, PROJ_2, MTG_1) = 5
    expect(result.items.length).toBeGreaterThanOrEqual(5)
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
    expect(result.items[0]?.id).toBe(SEED_IDS.BLOCK_GS_1)
  })

  it('excludes deleted blocks', () => {
    invoke('add_tag', { blockId: SEED_IDS.BLOCK_GS_1, tagId: SEED_IDS.TAG_WORK })
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('query_by_tags', { tagIds: [SEED_IDS.TAG_WORK] }) as {
      items: Record<string, unknown>[]
    }
    // BLOCK_GS_1 deleted, but seed associations (PROJ_1, PROJ_2, MTG_1) still there
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.BLOCK_GS_1)
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

// ---------------------------------------------------------------------------
// restore_block
// ---------------------------------------------------------------------------

describe('restore_block', () => {
  it('un-soft-deletes a deleted block', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const deleted = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(deleted.deleted_at).not.toBeNull()

    const result = invoke('restore_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    expect(result.restored_count).toBe(1)

    const restored = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(restored.deleted_at).toBeNull()
  })

  it('is idempotent — restoring a non-deleted block still works', () => {
    const result = invoke('restore_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    expect(result.restored_count).toBe(1)

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.deleted_at).toBeNull()
  })

  it('restored block reappears in list_blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    invoke('restore_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.find((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// purge_block
// ---------------------------------------------------------------------------

describe('purge_block', () => {
  it('permanently removes a block from the store', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('purge_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    expect(result.purged_count).toBe(1)

    expect(() => invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 })).toThrow('not found')
  })

  it('purged block is gone from list_blocks', () => {
    invoke('purge_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', { parentId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.find((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBeUndefined()
  })

  it('purging a parent does not automatically purge children, but parent is gone', () => {
    // Purge the "Getting Started" page itself
    invoke('purge_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED })
    expect(() => invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED })).toThrow(
      'not found',
    )
    // Children still exist (orphaned) — mock doesn't cascade purge
    const child = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(child.parent_id).toBe(SEED_IDS.PAGE_GETTING_STARTED)
  })
})

// ---------------------------------------------------------------------------
// batch_resolve
// ---------------------------------------------------------------------------

describe('batch_resolve', () => {
  it('resolves existing block IDs to metadata', () => {
    const result = invoke('batch_resolve', {
      ids: [SEED_IDS.PAGE_GETTING_STARTED, SEED_IDS.TAG_WORK],
    }) as Array<Record<string, unknown>>
    expect(result).toHaveLength(2)

    const page = result.find((b) => b.id === SEED_IDS.PAGE_GETTING_STARTED)
    expect(page).toBeDefined()
    expect(page?.title).toBe('Getting Started')
    expect(page?.block_type).toBe('page')
    expect(page?.deleted).toBe(false)

    const tag = result.find((b) => b.id === SEED_IDS.TAG_WORK)
    expect(tag).toBeDefined()
    expect(tag?.title).toBe('work')
    expect(tag?.block_type).toBe('tag')
  })

  it('omits non-existing IDs from the result', () => {
    const result = invoke('batch_resolve', {
      ids: [SEED_IDS.PAGE_GETTING_STARTED, 'NONEXISTENT_ID_XXXXXXXXXX', SEED_IDS.TAG_IDEA],
    }) as Array<Record<string, unknown>>
    // Non-existing IDs are filtered out
    expect(result).toHaveLength(2)
    const ids = result.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.PAGE_GETTING_STARTED)
    expect(ids).toContain(SEED_IDS.TAG_IDEA)
  })

  it('marks deleted blocks with deleted: true', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('batch_resolve', {
      ids: [SEED_IDS.BLOCK_GS_1, SEED_IDS.BLOCK_GS_2],
    }) as Array<Record<string, unknown>>
    expect(result).toHaveLength(2)

    const deletedEntry = result.find((b) => b.id === SEED_IDS.BLOCK_GS_1)
    expect(deletedEntry?.deleted).toBe(true)

    const liveEntry = result.find((b) => b.id === SEED_IDS.BLOCK_GS_2)
    expect(liveEntry?.deleted).toBe(false)
  })

  it('returns empty array for all-nonexistent IDs', () => {
    const result = invoke('batch_resolve', {
      ids: ['NONEXISTENT_1_XXXXXXXXXXXXX', 'NONEXISTENT_2_XXXXXXXXXXXXX'],
    }) as Array<Record<string, unknown>>
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// get_backlinks
// ---------------------------------------------------------------------------

describe('get_backlinks', () => {
  it('finds blocks that reference a target via [[ULID]] pattern', () => {
    // BLOCK_QN_1 content contains [[PAGE_GETTING_STARTED]]
    const result = invoke('get_backlinks', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_QN_1)
  })

  it('finds backlinks from seed BLOCK_GS_2 → PAGE_QUICK_NOTES', () => {
    // BLOCK_GS_2 content contains [[PAGE_QUICK_NOTES]]
    const result = invoke('get_backlinks', { blockId: SEED_IDS.PAGE_QUICK_NOTES }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_GS_2)
  })

  it('returns empty for blocks with no references', () => {
    const result = invoke('get_backlinks', { blockId: SEED_IDS.TAG_WORK }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('excludes deleted blocks from backlinks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_QN_1 })
    const result = invoke('get_backlinks', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as {
      items: Record<string, unknown>[]
    }
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.BLOCK_QN_1)
  })

  it('detects dynamically created backlinks', () => {
    const created = invoke('create_block', {
      blockType: 'content',
      content: `Link to [[${SEED_IDS.TAG_IDEA}]] here`,
      parentId: SEED_IDS.PAGE_QUICK_NOTES,
    }) as Record<string, unknown>
    const result = invoke('get_backlinks', { blockId: SEED_IDS.TAG_IDEA }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe(created.id)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('get_backlinks', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

// ---------------------------------------------------------------------------
// query_backlinks_filtered
// ---------------------------------------------------------------------------

describe('query_backlinks_filtered', () => {
  it('returns backlinks for target block', () => {
    // BLOCK_QN_1 contains [[PAGE_GETTING_STARTED]]
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as { items: Record<string, unknown>[] }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_QN_1)
  })

  it('returns empty for block with no backlinks', () => {
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.TAG_WORK,
    }) as { items: Record<string, unknown>[] }
    expect(result.items).toHaveLength(0)
  })

  it('applies BlockType filter', () => {
    // Create a page-type block referencing Getting Started
    invoke('create_block', {
      blockType: 'page',
      content: `Page linking to [[${SEED_IDS.PAGE_GETTING_STARTED}]]`,
    })
    // Filter to only 'page' type — should exclude the seed content block BLOCK_QN_1
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
      filters: [{ type: 'BlockType', block_type: 'page' }],
    }) as { items: Record<string, unknown>[] }
    for (const item of result.items) {
      expect(item.block_type).toBe('page')
    }
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.BLOCK_QN_1)
  })

  it('applies Contains filter', () => {
    // Create another block referencing Getting Started with unique text
    invoke('create_block', {
      blockType: 'content',
      content: `Unique xylophone text [[${SEED_IDS.PAGE_GETTING_STARTED}]]`,
      parentId: SEED_IDS.PAGE_QUICK_NOTES,
    })
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
      filters: [{ type: 'Contains', query: 'xylophone' }],
    }) as { items: Record<string, unknown>[] }
    expect(result.items).toHaveLength(1)
    expect((result.items[0]?.content as string).toLowerCase()).toContain('xylophone')
  })

  it('returns correct total_count', () => {
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as { total_count: number; items: Record<string, unknown>[] }
    expect(result.total_count).toBe(result.items.length)
  })

  it('returns BacklinkQueryResponse shape', () => {
    const result = invoke('query_backlinks_filtered', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total_count')
    expect(result).toHaveProperty('has_more')
    expect(result).toHaveProperty('next_cursor')
  })
})

// ---------------------------------------------------------------------------
// list_property_keys
// ---------------------------------------------------------------------------

describe('list_property_keys', () => {
  it('returns sorted distinct keys', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'status',
      valueText: 'done',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_2,
      key: 'category',
      valueText: 'work',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    const result = invoke('list_property_keys') as string[]
    // Should be sorted and include 'category', 'status', plus defaults 'priority' and 'todo'
    expect(result).toEqual([...result].sort())
    expect(result).toContain('status')
    expect(result).toContain('category')
  })

  it('includes default keys', () => {
    // Even with no properties set, 'todo' and 'priority' should always be present
    const result = invoke('list_property_keys') as string[]
    expect(result).toContain('todo')
    expect(result).toContain('priority')
  })
})

// ---------------------------------------------------------------------------
// get_conflicts
// ---------------------------------------------------------------------------

describe('get_conflicts', () => {
  it('returns seed conflict block', () => {
    const result = invoke('get_conflicts') as { items: Record<string, unknown>[] }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.CONFLICT_01)
  })

  it('conflict block has is_conflict true', () => {
    const result = invoke('get_conflicts') as { items: Record<string, unknown>[] }
    const conflict = result.items.find((b) => b.id === SEED_IDS.CONFLICT_01)
    expect(conflict).toBeDefined()
    expect(conflict?.is_conflict).toBe(true)
  })

  it('excludes non-conflict blocks', () => {
    const result = invoke('get_conflicts') as { items: Record<string, unknown>[] }
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.PAGE_GETTING_STARTED)
    expect(ids).not.toContain(SEED_IDS.BLOCK_GS_1)
  })

  it('excludes deleted conflict blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.CONFLICT_01 })
    const result = invoke('get_conflicts') as { items: Record<string, unknown>[] }
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.CONFLICT_01)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('get_conflicts') as Record<string, unknown>
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

// ---------------------------------------------------------------------------
// revert_ops
// ---------------------------------------------------------------------------

describe('revert_ops', () => {
  it('reverts a create_block op → block becomes soft-deleted', () => {
    const created = invoke('create_block', {
      blockType: 'content',
      content: 'to-revert',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as Record<string, unknown>

    // Get the op log entry for this create
    const history = invoke('list_page_history', {}) as { items: Array<Record<string, unknown>> }
    const createOp = history.items.find((o) => {
      const p = JSON.parse(o.payload as string) as Record<string, unknown>
      return o.op_type === 'create_block' && p.block_id === created.id
    })
    expect(createOp).toBeDefined()

    const results = invoke('revert_ops', {
      ops: [{ device_id: createOp?.device_id, seq: createOp?.seq }],
    }) as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)

    const block = invoke('get_block', { blockId: created.id as string }) as Record<string, unknown>
    expect(block.deleted_at).not.toBeNull()
  })

  it('reverts a delete_block op → block becomes restored', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_3 })
    const deleted = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_3 }) as Record<string, unknown>
    expect(deleted.deleted_at).not.toBeNull()

    const history = invoke('list_page_history', {}) as { items: Array<Record<string, unknown>> }
    const deleteOp = history.items.find((o) => {
      const p = JSON.parse(o.payload as string) as Record<string, unknown>
      return o.op_type === 'delete_block' && p.block_id === SEED_IDS.BLOCK_GS_3
    })
    expect(deleteOp).toBeDefined()

    invoke('revert_ops', {
      ops: [{ device_id: deleteOp?.device_id, seq: deleteOp?.seq }],
    })

    const restored = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_3 }) as Record<
      string,
      unknown
    >
    expect(restored.deleted_at).toBeNull()
  })

  it('reverts an edit_block op → content reverts to previous value', () => {
    const original = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_4 }) as Record<
      string,
      unknown
    >
    const originalContent = original.content

    invoke('edit_block', { blockId: SEED_IDS.BLOCK_GS_4, toText: 'changed content' })

    const history = invoke('list_page_history', {}) as { items: Array<Record<string, unknown>> }
    const editOp = history.items.find((o) => {
      const p = JSON.parse(o.payload as string) as Record<string, unknown>
      return o.op_type === 'edit_block' && p.block_id === SEED_IDS.BLOCK_GS_4
    })
    expect(editOp).toBeDefined()

    invoke('revert_ops', {
      ops: [{ device_id: editOp?.device_id, seq: editOp?.seq }],
    })

    const reverted = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_4 }) as Record<
      string,
      unknown
    >
    expect(reverted.content).toBe(originalContent)
  })

  it('returns empty array when no matching ops found', () => {
    const results = invoke('revert_ops', {
      ops: [{ device_id: 'nonexistent', seq: 99999 }],
    }) as Array<Record<string, unknown>>
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// list_blocks with showDeleted
// ---------------------------------------------------------------------------

describe('list_blocks with showDeleted', () => {
  it('showDeleted=true includes deleted blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', { showDeleted: true }) as {
      items: Record<string, unknown>[]
    }
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_GS_1)
    // All returned items should have deleted_at set
    for (const item of result.items) {
      expect(item.deleted_at).not.toBeNull()
    }
  })

  it('showDeleted=false (default) excludes deleted blocks', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', {}) as {
      items: Record<string, unknown>[]
    }
    const ids = result.items.map((b) => b.id)
    expect(ids).not.toContain(SEED_IDS.BLOCK_GS_1)
  })

  it('showDeleted=true with blockType filter', () => {
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1 })
    const result = invoke('list_blocks', { showDeleted: true, blockType: 'content' }) as {
      items: Record<string, unknown>[]
    }
    for (const item of result.items) {
      expect(item.block_type).toBe('content')
      expect(item.deleted_at).not.toBeNull()
    }
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_GS_1)
  })

  it('showDeleted=true returns empty when nothing is deleted', () => {
    const result = invoke('list_blocks', { showDeleted: true }) as {
      items: Record<string, unknown>[]
    }
    // Only seed conflict block is not deleted; no blocks have deleted_at set initially
    expect(result.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// undo_page_op edge cases
// ---------------------------------------------------------------------------

describe('undo_page_op edge cases', () => {
  it('throws when no undoable ops exist', () => {
    // Fresh state — no ops have been performed
    expect(() =>
      invoke('undo_page_op', { pageId: SEED_IDS.PAGE_GETTING_STARTED, undoDepth: 0 }),
    ).toThrow('no undoable op found')
  })

  it('throws when undoDepth exceeds available ops', () => {
    invoke('create_block', {
      blockType: 'content',
      content: 'only-op',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    // undoDepth=0 should work (there's 1 op), but undoDepth=1 should fail
    expect(() =>
      invoke('undo_page_op', { pageId: SEED_IDS.PAGE_GETTING_STARTED, undoDepth: 1 }),
    ).toThrow('no undoable op found')
  })

  it('undo of edit_block restores previous content', () => {
    invoke('edit_block', { blockId: SEED_IDS.BLOCK_GS_5, toText: 'Edited for undo test' })
    const edited = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_5 }) as Record<string, unknown>
    expect(edited.content).toBe('Edited for undo test')

    invoke('undo_page_op', { pageId: SEED_IDS.PAGE_GETTING_STARTED, undoDepth: 0 })
    const undone = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_5 }) as Record<string, unknown>
    expect(undone.content).toBe('**Use the search panel** to find anything across all your pages.')
  })
})

// ---------------------------------------------------------------------------
// redo_page_op edge cases
// ---------------------------------------------------------------------------

describe('redo_page_op edge cases', () => {
  it('throws when referencing a non-existent op seq', () => {
    expect(() => invoke('redo_page_op', { undoDeviceId: 'mock-device', undoSeq: 99999 })).toThrow(
      'op not found for redo',
    )
  })

  it('redo re-applies an undone create_block', () => {
    const created = invoke('create_block', {
      blockType: 'content',
      content: 'redo-me',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as Record<string, unknown>
    const createdId = created.id as string

    // Undo the create → block becomes deleted
    const undoResult = invoke('undo_page_op', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
      undoDepth: 0,
    }) as { reversed_op: { device_id: string; seq: number } }

    const afterUndo = invoke('get_block', { blockId: createdId }) as Record<string, unknown>
    expect(afterUndo.deleted_at).not.toBeNull()

    // Redo → block is restored
    invoke('redo_page_op', {
      undoDeviceId: undoResult.reversed_op.device_id,
      undoSeq: undoResult.reversed_op.seq,
    })

    const afterRedo = invoke('get_block', { blockId: createdId }) as Record<string, unknown>
    expect(afterRedo.deleted_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resetMock clears state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// query_by_property
// ---------------------------------------------------------------------------

describe('query_by_property', () => {
  it('returns empty array when no blocks have the property', () => {
    const result = invoke('query_by_property', { key: 'nonexistent', valueText: null }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })

  it('returns blocks matching property key', () => {
    // First set a property on a known block
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'todo',
      valueText: 'TODO',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })

    const result = invoke('query_by_property', { key: 'todo', valueText: null }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    expect(result.items.some((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBe(true)
  })

  it('filters by valueText when provided', () => {
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
      key: 'todo',
      valueText: 'DONE',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })

    const result = invoke('query_by_property', { key: 'todo', valueText: 'TODO' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.some((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBe(true)
    expect(result.items.some((b) => b.id === SEED_IDS.BLOCK_GS_2)).toBe(false)
  })

  it('excludes deleted blocks', () => {
    invoke('set_property', {
      blockId: SEED_IDS.BLOCK_GS_1,
      key: 'status',
      valueText: 'active',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    // Delete the block
    invoke('delete_block', { blockId: SEED_IDS.BLOCK_GS_1, cascade: false })

    const result = invoke('query_by_property', { key: 'status', valueText: null }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items.some((b) => b.id === SEED_IDS.BLOCK_GS_1)).toBe(false)
  })

  it('returns PageResponse shape', () => {
    const result = invoke('query_by_property', { key: 'any', valueText: null }) as Record<
      string,
      unknown
    >
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })
})

// ---------------------------------------------------------------------------
// Fixed-field commands (set_todo_state / set_priority / set_due_date)
// ---------------------------------------------------------------------------

describe('fixed-field commands', () => {
  it('set_todo_state updates block todo_state column', () => {
    const result = invoke('set_todo_state', {
      blockId: SEED_IDS.BLOCK_GS_1,
      state: 'TODO',
    }) as Record<string, unknown>

    expect(result.todo_state).toBe('TODO')
    expect(result.id).toBe(SEED_IDS.BLOCK_GS_1)

    // Verify persisted
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.todo_state).toBe('TODO')
  })

  it('set_todo_state with null clears todo_state', () => {
    // First set a state
    invoke('set_todo_state', { blockId: SEED_IDS.BLOCK_GS_1, state: 'TODO' })
    const before = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(before.todo_state).toBe('TODO')

    // Now clear it
    const result = invoke('set_todo_state', {
      blockId: SEED_IDS.BLOCK_GS_1,
      state: null,
    }) as Record<string, unknown>

    expect(result.todo_state).toBeNull()

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.todo_state).toBeNull()
  })

  it('set_priority updates block priority column', () => {
    const result = invoke('set_priority', {
      blockId: SEED_IDS.BLOCK_GS_1,
      level: '2',
    }) as Record<string, unknown>

    expect(result.priority).toBe('2')
    expect(result.id).toBe(SEED_IDS.BLOCK_GS_1)

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.priority).toBe('2')
  })

  it('set_priority with null clears priority', () => {
    invoke('set_priority', { blockId: SEED_IDS.BLOCK_GS_1, level: '1' })
    const before = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(before.priority).toBe('1')

    const result = invoke('set_priority', {
      blockId: SEED_IDS.BLOCK_GS_1,
      level: null,
    }) as Record<string, unknown>

    expect(result.priority).toBeNull()

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.priority).toBeNull()
  })

  it('set_due_date updates block due_date column', () => {
    const result = invoke('set_due_date', {
      blockId: SEED_IDS.BLOCK_GS_1,
      date: '2026-06-15',
    }) as Record<string, unknown>

    expect(result.due_date).toBe('2026-06-15')
    expect(result.id).toBe(SEED_IDS.BLOCK_GS_1)

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.due_date).toBe('2026-06-15')
  })

  it('set_due_date with null clears due_date', () => {
    invoke('set_due_date', { blockId: SEED_IDS.BLOCK_GS_1, date: '2026-06-15' })
    const before = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(before.due_date).toBe('2026-06-15')

    const result = invoke('set_due_date', {
      blockId: SEED_IDS.BLOCK_GS_1,
      date: null,
    }) as Record<string, unknown>

    expect(result.due_date).toBeNull()

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.due_date).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Error injection (injectMockError / clearMockErrors)
// ---------------------------------------------------------------------------

describe('error injection', () => {
  it('injectMockError causes command to throw', () => {
    injectMockError('create_block', 'test error')
    expect(() =>
      invoke('create_block', {
        blockType: 'content',
        content: 'should fail',
        parentId: SEED_IDS.PAGE_GETTING_STARTED,
      }),
    ).toThrow('test error')
    clearMockErrors()
  })

  it('clearMockErrors restores normal operation', () => {
    injectMockError('get_block', 'injected failure')
    clearMockErrors()
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(block.content).toBe('Getting Started')
  })

  it('only the injected command throws; others still work', () => {
    injectMockError('edit_block', 'edit is broken')
    // get_block should still work fine
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(block.content).toBe('Getting Started')
    // edit_block should throw
    expect(() =>
      invoke('edit_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED, toText: 'nope' }),
    ).toThrow('edit is broken')
    clearMockErrors()
  })

  it('resetMock clears injected errors', () => {
    injectMockError('get_block', 'should be cleared')
    resetMock()
    const block = invoke('get_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED }) as Record<
      string,
      unknown
    >
    expect(block.content).toBe('Getting Started')
  })
})

// ---------------------------------------------------------------------------
// Seed data — rich agenda / task data
// ---------------------------------------------------------------------------

describe('seed task blocks', () => {
  it('daily page has TODO blocks with due dates', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_DAILY_3 }) as Record<
      string,
      unknown
    >
    expect(block.todo_state).toBe('TODO')
    expect(block.priority).toBe('1')
    expect(block.due_date).not.toBeNull()
  })

  it('daily page has DOING block', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_DAILY_4 }) as Record<
      string,
      unknown
    >
    expect(block.todo_state).toBe('DOING')
    expect(block.priority).toBe('2')
  })

  it('daily page has DONE block', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_DAILY_5 }) as Record<
      string,
      unknown
    >
    expect(block.todo_state).toBe('DONE')
  })

  it('projects page has blocks with scheduled dates', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_PROJ_1 }) as Record<string, unknown>
    expect(block.scheduled_date).not.toBeNull()
    expect(block.due_date).not.toBeNull()
  })

  it('overdue block has yesterday due date', () => {
    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_OVERDUE_1 }) as Record<
      string,
      unknown
    >
    expect(block.todo_state).toBe('TODO')
    expect(block.due_date).not.toBeNull()
    // Due date should be before today (string comparison works for YYYY-MM-DD)
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect((block.due_date as string) < todayStr).toBe(true)
  })

  it('seed properties include completed_at on DONE blocks', () => {
    const props = invoke('get_properties', {
      blockId: SEED_IDS.BLOCK_DAILY_5,
    }) as Record<string, unknown>[]
    expect(props.length).toBeGreaterThanOrEqual(1)
    const completedAt = props.find((p) => p.key === 'completed_at')
    expect(completedAt).toBeDefined()
    expect(completedAt?.value_date).not.toBeNull()
  })

  it('seed properties include custom props on meeting blocks', () => {
    const props = invoke('get_properties', {
      blockId: SEED_IDS.BLOCK_MTG_1,
    }) as Record<string, unknown>[]
    expect(props).toHaveLength(2)
    const keys = props.map((p) => p.key)
    expect(keys).toContain('context')
    expect(keys).toContain('project')
  })

  it('seed tag associations are in place', () => {
    const tags = invoke('list_tags_for_block', {
      blockId: SEED_IDS.BLOCK_PROJ_1,
    }) as Array<Record<string, unknown>>
    expect(tags).toHaveLength(1)
    expect(tags[0]?.tag_id).toBe(SEED_IDS.TAG_WORK)
  })
})

// ---------------------------------------------------------------------------
// list_blocks with agendaDate / agendaSource
// ---------------------------------------------------------------------------

describe('list_blocks with agendaDate', () => {
  it('returns blocks due on the given date', () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const result = invoke('list_blocks', { agendaDate: todayStr }) as {
      items: Record<string, unknown>[]
    }
    // Should include blocks with due_date=today OR scheduled_date=today
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    for (const item of result.items) {
      expect(item.due_date === todayStr || item.scheduled_date === todayStr).toBe(true)
    }
  })

  it('filters by agendaSource column:due_date', () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const result = invoke('list_blocks', {
      agendaDate: todayStr,
      agendaSource: 'column:due_date',
    }) as { items: Record<string, unknown>[] }
    for (const item of result.items) {
      expect(item.due_date).toBe(todayStr)
    }
  })

  it('filters by agendaSource column:scheduled_date', () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const result = invoke('list_blocks', {
      agendaDate: todayStr,
      agendaSource: 'column:scheduled_date',
    }) as { items: Record<string, unknown>[] }
    for (const item of result.items) {
      expect(item.scheduled_date).toBe(todayStr)
    }
    // BLOCK_PROJ_1 is scheduled for today
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_PROJ_1)
  })

  it('returns empty for a date with no items', () => {
    const result = invoke('list_blocks', { agendaDate: '1900-01-01' }) as {
      items: Record<string, unknown>[]
    }
    expect(result.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// query_by_property with valueDate
// ---------------------------------------------------------------------------

describe('query_by_property with valueDate', () => {
  it('filters by valueDate for completed_at', () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const result = invoke('query_by_property', {
      key: 'completed_at',
      valueDate: todayStr,
    }) as { items: Record<string, unknown>[] }
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    const ids = result.items.map((b) => b.id)
    expect(ids).toContain(SEED_IDS.BLOCK_DAILY_5)
    expect(ids).toContain(SEED_IDS.BLOCK_PROJ_3)
  })

  it('returns empty for valueDate with no matches', () => {
    const result = invoke('query_by_property', {
      key: 'completed_at',
      valueDate: '1900-01-01',
    }) as { items: Record<string, unknown>[] }
    expect(result.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// set_scheduled_date
// ---------------------------------------------------------------------------

describe('set_scheduled_date', () => {
  it('sets scheduled_date on a block', () => {
    const result = invoke('set_scheduled_date', {
      blockId: SEED_IDS.BLOCK_GS_1,
      date: '2026-07-01',
    }) as Record<string, unknown>
    expect(result.scheduled_date).toBe('2026-07-01')

    const block = invoke('get_block', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<string, unknown>
    expect(block.scheduled_date).toBe('2026-07-01')
  })

  it('clears scheduled_date with null', () => {
    invoke('set_scheduled_date', { blockId: SEED_IDS.BLOCK_GS_1, date: '2026-07-01' })
    const result = invoke('set_scheduled_date', {
      blockId: SEED_IDS.BLOCK_GS_1,
      date: null,
    }) as Record<string, unknown>
    expect(result.scheduled_date).toBeNull()
  })

  it('throws for non-existent block', () => {
    expect(() =>
      invoke('set_scheduled_date', { blockId: 'NONEXISTENT', date: '2026-07-01' }),
    ).toThrow('not found')
  })
})

// ---------------------------------------------------------------------------
// count_agenda_batch
// ---------------------------------------------------------------------------

describe('count_agenda_batch', () => {
  it('returns counts per date', () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const result = invoke('count_agenda_batch', {
      dates: [todayStr, '1900-01-01'],
    }) as Record<string, number>
    expect(result[todayStr]).toBeGreaterThanOrEqual(1)
    expect(result['1900-01-01']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// count_backlinks_batch
// ---------------------------------------------------------------------------

describe('count_backlinks_batch', () => {
  it('returns backlink counts per page', () => {
    const result = invoke('count_backlinks_batch', {
      pageIds: [SEED_IDS.PAGE_GETTING_STARTED, SEED_IDS.TAG_IDEA],
    }) as Record<string, number>
    // BLOCK_QN_1 links to PAGE_GETTING_STARTED
    expect(result[SEED_IDS.PAGE_GETTING_STARTED]).toBeGreaterThanOrEqual(1)
    expect(result[SEED_IDS.TAG_IDEA]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// list_backlinks_grouped
// ---------------------------------------------------------------------------

describe('list_backlinks_grouped', () => {
  it('returns backlinks grouped by source page', () => {
    const result = invoke('list_backlinks_grouped', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as { groups: Array<Record<string, unknown>>; total_count: number }
    expect(result.groups.length).toBeGreaterThanOrEqual(1)
    expect(result.total_count).toBeGreaterThanOrEqual(1)
  })

  it('returns GroupedBacklinkResponse shape', () => {
    const result = invoke('list_backlinks_grouped', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('groups')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
    expect(result).toHaveProperty('total_count')
  })
})

// ---------------------------------------------------------------------------
// list_unlinked_references
// ---------------------------------------------------------------------------

describe('list_unlinked_references', () => {
  it('finds blocks mentioning page title as text without [[link]]', () => {
    // Create a block that mentions "Quick Notes" as text but without [[ ]]
    invoke('create_block', {
      blockType: 'content',
      content: 'Check Quick Notes for details',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    const result = invoke('list_unlinked_references', {
      pageId: SEED_IDS.PAGE_QUICK_NOTES,
    }) as { groups: Array<Record<string, unknown>>; total_count: number }
    expect(result.total_count).toBeGreaterThanOrEqual(1)
  })

  it('returns empty for page with no unlinked mentions', () => {
    // Create a page with a unique title that doesn't appear elsewhere
    const page = invoke('create_block', {
      blockType: 'page',
      content: 'Xyzzyspoon',
    }) as Record<string, unknown>
    const result = invoke('list_unlinked_references', {
      pageId: page.id as string,
    }) as { total_count: number }
    expect(result.total_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// compute_edit_diff
// ---------------------------------------------------------------------------

describe('compute_edit_diff', () => {
  it('returns diff spans for an edit_block op', () => {
    invoke('edit_block', { blockId: SEED_IDS.BLOCK_GS_5, toText: 'New content here' })
    const history = invoke('list_page_history', {}) as { items: Array<Record<string, unknown>> }
    const editOp = history.items.find((o) => o.op_type === 'edit_block')
    expect(editOp).toBeDefined()

    const spans = invoke('compute_edit_diff', {
      deviceId: editOp?.device_id,
      seq: editOp?.seq,
    }) as Array<Record<string, unknown>>
    expect(spans.length).toBeGreaterThanOrEqual(1)
  })

  it('returns null for non-edit ops', () => {
    invoke('create_block', {
      blockType: 'content',
      content: 'diff-test',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    const history = invoke('list_page_history', {}) as { items: Array<Record<string, unknown>> }
    const createOp = history.items.find((o) => o.op_type === 'create_block')

    const result = invoke('compute_edit_diff', {
      deviceId: createOp?.device_id,
      seq: createOp?.seq,
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

describe('property definition commands', () => {
  it('list_property_defs returns seed definitions', () => {
    const defs = invoke('list_property_defs') as Array<Record<string, unknown>>
    expect(defs.length).toBeGreaterThanOrEqual(2)
    const keys = defs.map((d) => d.key)
    expect(keys).toContain('context')
    expect(keys).toContain('project')
  })

  it('create_property_def adds a new definition', () => {
    const def = invoke('create_property_def', {
      key: 'effort',
      valueType: 'number',
      options: null,
    }) as Record<string, unknown>
    expect(def.key).toBe('effort')
    expect(def.value_type).toBe('number')

    const defs = invoke('list_property_defs') as Array<Record<string, unknown>>
    expect(defs.some((d) => d.key === 'effort')).toBe(true)
  })

  it('update_property_def_options updates options', () => {
    invoke('create_property_def', {
      key: 'status',
      valueType: 'select',
      options: JSON.stringify(['open', 'closed']),
    })
    const updated = invoke('update_property_def_options', {
      key: 'status',
      options: JSON.stringify(['open', 'in-progress', 'closed']),
    }) as Record<string, unknown>
    expect(updated.options).toBe(JSON.stringify(['open', 'in-progress', 'closed']))
  })

  it('update_property_def_options throws for non-existent key', () => {
    expect(() =>
      invoke('update_property_def_options', { key: 'nonexistent', options: '[]' }),
    ).toThrow('property definition not found')
  })

  it('delete_property_def removes a definition', () => {
    invoke('create_property_def', { key: 'temp', valueType: 'text' })
    invoke('delete_property_def', { key: 'temp' })
    const defs = invoke('list_property_defs') as Array<Record<string, unknown>>
    expect(defs.some((d) => d.key === 'temp')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Page alias commands
// ---------------------------------------------------------------------------

describe('page alias commands', () => {
  it('get_page_aliases returns seed aliases', () => {
    const aliases = invoke('get_page_aliases', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as string[]
    expect(aliases).toEqual(['gs', 'getting-started'])
  })

  it('set_page_aliases replaces existing aliases', () => {
    invoke('set_page_aliases', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
      aliases: ['intro', 'welcome'],
    })
    const aliases = invoke('get_page_aliases', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as string[]
    expect(aliases).toEqual(['intro', 'welcome'])
  })

  it('resolve_page_by_alias finds page by alias', () => {
    const result = invoke('resolve_page_by_alias', { alias: 'gs' }) as
      | [string, string | null]
      | null
    expect(result).not.toBeNull()
    expect(result?.[0]).toBe(SEED_IDS.PAGE_GETTING_STARTED)
    expect(result?.[1]).toBe('Getting Started')
  })

  it('resolve_page_by_alias is case-insensitive', () => {
    const result = invoke('resolve_page_by_alias', { alias: 'GS' }) as
      | [string, string | null]
      | null
    expect(result).not.toBeNull()
    expect(result?.[0]).toBe(SEED_IDS.PAGE_GETTING_STARTED)
  })

  it('resolve_page_by_alias returns null for unknown alias', () => {
    const result = invoke('resolve_page_by_alias', { alias: 'zzzzz' })
    expect(result).toBeNull()
  })

  it('get_page_aliases returns empty for page with no aliases', () => {
    const aliases = invoke('get_page_aliases', {
      pageId: SEED_IDS.PAGE_DAILY,
    }) as string[]
    expect(aliases).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// export_page_markdown
// ---------------------------------------------------------------------------

describe('export_page_markdown', () => {
  it('returns markdown with page title and child blocks', () => {
    const md = invoke('export_page_markdown', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as string
    expect(md).toContain('# Getting Started')
    expect(md).toContain('- Welcome to Agaric!')
  })

  it('throws for non-existent page', () => {
    expect(() => invoke('export_page_markdown', { pageId: 'NONEXISTENT' })).toThrow('not found')
  })
})

// ---------------------------------------------------------------------------
// get_block_history (list_block_history in REVIEW-LATER)
// ---------------------------------------------------------------------------

describe('get_block_history', () => {
  it('returns empty PageResponse shape', () => {
    const result = invoke('get_block_history', { blockId: SEED_IDS.BLOCK_GS_1 }) as Record<
      string,
      unknown
    >
    expect(result).toEqual({ items: [], next_cursor: null, has_more: false })
  })

  it('returns same shape for any block ID', () => {
    const result = invoke('get_block_history', {
      blockId: SEED_IDS.PAGE_GETTING_STARTED,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
    expect(result.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// list_page_history
// ---------------------------------------------------------------------------

describe('list_page_history', () => {
  it('returns empty when no ops performed', () => {
    const result = invoke('list_page_history', {}) as {
      items: Array<Record<string, unknown>>
    }
    expect(result.items).toHaveLength(0)
    expect(result).toHaveProperty('next_cursor', null)
    expect(result).toHaveProperty('has_more', false)
  })

  it('records ops in reverse chronological order', () => {
    invoke('create_block', {
      blockType: 'content',
      content: 'first',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    invoke('create_block', {
      blockType: 'content',
      content: 'second',
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    const result = invoke('list_page_history', {}) as {
      items: Array<Record<string, unknown>>
    }
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    // Most recent op should be first
    const seqs = result.items.map((o) => o.seq as number)
    expect(seqs[0] ?? 0).toBeGreaterThan(seqs[1] ?? 0)
  })

  it('returns op entries with expected shape', () => {
    invoke('edit_block', { blockId: SEED_IDS.BLOCK_GS_1, toText: 'history-shape-test' })
    const result = invoke('list_page_history', {}) as {
      items: Array<Record<string, unknown>>
    }
    const op = result.items[0]
    expect(op).toHaveProperty('device_id')
    expect(op).toHaveProperty('seq')
    expect(op).toHaveProperty('op_type')
    expect(op).toHaveProperty('payload')
    expect(op).toHaveProperty('created_at')
  })
})

// ---------------------------------------------------------------------------
// Sync / Peer-ref commands
// ---------------------------------------------------------------------------

describe('list_peer_refs', () => {
  it('returns an empty array', () => {
    const result = invoke('list_peer_refs')
    expect(result).toEqual([])
  })
})

describe('get_peer_ref', () => {
  it('returns null', () => {
    const result = invoke('get_peer_ref', { peerId: 'any-id' })
    expect(result).toBeNull()
  })
})

describe('delete_peer_ref', () => {
  it('returns undefined', () => {
    const result = invoke('delete_peer_ref', { peerId: 'any-id' })
    expect(result).toBeUndefined()
  })
})

describe('get_device_id', () => {
  it('returns a mock device ID string', () => {
    const result = invoke('get_device_id')
    expect(result).toBe('mock-device-id-0000')
    expect(typeof result).toBe('string')
  })
})

describe('start_pairing', () => {
  it('returns pairing info with passphrase, qr_svg, and port', () => {
    const result = invoke('start_pairing') as Record<string, unknown>
    expect(result).toHaveProperty('passphrase')
    expect(result).toHaveProperty('qr_svg')
    expect(result).toHaveProperty('port')
    expect(typeof result.passphrase).toBe('string')
    expect(typeof result.qr_svg).toBe('string')
    expect(typeof result.port).toBe('number')
  })

  it('returns expected default values', () => {
    const result = invoke('start_pairing') as Record<string, unknown>
    expect(result).toEqual({
      passphrase: 'alpha bravo charlie delta',
      qr_svg: '<svg></svg>',
      port: 8765,
    })
  })
})

describe('confirm_pairing', () => {
  it('returns undefined', () => {
    const result = invoke('confirm_pairing', { passphrase: 'alpha bravo charlie delta' })
    expect(result).toBeUndefined()
  })
})

describe('cancel_pairing', () => {
  it('returns undefined', () => {
    const result = invoke('cancel_pairing')
    expect(result).toBeUndefined()
  })
})

describe('start_sync', () => {
  it('returns SyncStatus shape with syncing state', () => {
    const result = invoke('start_sync', { peerId: 'peer-123' }) as Record<string, unknown>
    expect(result).toEqual({
      state: 'syncing',
      local_device_id: 'mock-device-id-0000',
      remote_device_id: 'peer-123',
      ops_received: 0,
      ops_sent: 0,
    })
  })

  it('echoes back the provided peerId as remote_device_id', () => {
    const result = invoke('start_sync', { peerId: 'other-peer' }) as Record<string, unknown>
    expect(result.remote_device_id).toBe('other-peer')
  })
})

describe('cancel_sync', () => {
  it('returns undefined', () => {
    const result = invoke('cancel_sync')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Attachment commands (F-7)
// ---------------------------------------------------------------------------

describe('list_attachments', () => {
  it('returns an empty array', () => {
    const result = invoke('list_attachments', { blockId: SEED_IDS.BLOCK_GS_1 })
    expect(result).toEqual([])
  })
})

describe('add_attachment', () => {
  it('returns attachment with expected shape', () => {
    const result = invoke('add_attachment', {
      blockId: SEED_IDS.BLOCK_GS_1,
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      fsPath: '/tmp/test.pdf',
    }) as Record<string, unknown>
    expect(result).toHaveProperty('id')
    expect(result.block_id).toBe(SEED_IDS.BLOCK_GS_1)
    expect(result.filename).toBe('test.pdf')
    expect(result.mime_type).toBe('application/pdf')
    expect(result.size_bytes).toBe(1024)
    expect(result.fs_path).toBe('/tmp/test.pdf')
    expect(result).toHaveProperty('created_at')
  })

  it('generates unique IDs for each attachment', () => {
    const a1 = invoke('add_attachment', {
      blockId: SEED_IDS.BLOCK_GS_1,
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      fsPath: '/tmp/a.png',
    }) as Record<string, unknown>
    const a2 = invoke('add_attachment', {
      blockId: SEED_IDS.BLOCK_GS_1,
      filename: 'b.png',
      mimeType: 'image/png',
      sizeBytes: 200,
      fsPath: '/tmp/b.png',
    }) as Record<string, unknown>
    expect(a1.id).not.toBe(a2.id)
  })
})

describe('delete_attachment', () => {
  it('returns null', () => {
    const result = invoke('delete_attachment', { attachmentId: 'any-id' })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// list_projected_agenda
// ---------------------------------------------------------------------------

describe('list_projected_agenda', () => {
  it('returns an empty array', () => {
    const result = invoke('list_projected_agenda', {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------

describe('save_draft', () => {
  it('returns null', () => {
    const result = invoke('save_draft', {
      blockId: SEED_IDS.BLOCK_GS_1,
      content: 'draft content',
    })
    expect(result).toBeNull()
  })
})

describe('flush_draft', () => {
  it('returns null', () => {
    const result = invoke('flush_draft', { blockId: SEED_IDS.BLOCK_GS_1 })
    expect(result).toBeNull()
  })
})

describe('delete_draft', () => {
  it('returns null', () => {
    const result = invoke('delete_draft', { blockId: SEED_IDS.BLOCK_GS_1 })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// set_peer_address
// ---------------------------------------------------------------------------

describe('set_peer_address', () => {
  it('returns null', () => {
    const result = invoke('set_peer_address', {
      peerId: 'peer-123',
      address: '192.168.1.1:8765',
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// update_peer_name
// ---------------------------------------------------------------------------

describe('update_peer_name', () => {
  it('returns undefined', () => {
    const result = invoke('update_peer_name', { peerId: 'peer-123', name: 'My Laptop' })
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// import_markdown
// ---------------------------------------------------------------------------

describe('import_markdown', () => {
  it('creates a page from markdown content with heading', () => {
    const result = invoke('import_markdown', {
      content: '# My Imported Page\n\nFirst paragraph\nSecond paragraph',
      filename: null,
    }) as Record<string, unknown>
    expect(result).toHaveProperty('page_title', 'My Imported Page')
    expect(result).toHaveProperty('blocks_created')
    expect(result.blocks_created).toBeGreaterThanOrEqual(2)
    expect(result).toHaveProperty('properties_set', 0)
    expect(result).toHaveProperty('warnings')
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('derives page title from filename when no heading present', () => {
    const result = invoke('import_markdown', {
      content: 'Some content without a heading',
      filename: 'my-notes.md',
    }) as Record<string, unknown>
    expect(result.page_title).toBe('my-notes')
  })

  it('prefers heading over filename for page title', () => {
    const result = invoke('import_markdown', {
      content: '# Heading Title\n\nContent here',
      filename: 'fallback.md',
    }) as Record<string, unknown>
    expect(result.page_title).toBe('Heading Title')
  })

  it('strips list markers from content lines', () => {
    const result = invoke('import_markdown', {
      content: '# List Page\n- Item one\n- Item two\n* Item three',
      filename: null,
    }) as Record<string, unknown>
    expect(result.blocks_created).toBe(3)
  })

  it('skips empty lines', () => {
    const result = invoke('import_markdown', {
      content: '# Sparse\n\n\nOnly one line\n\n',
      filename: null,
    }) as Record<string, unknown>
    expect(result.blocks_created).toBe(1)
  })

  it('imported page is accessible via list_blocks', () => {
    invoke('import_markdown', {
      content: '# Unique Import Test\n\nTest block content',
      filename: null,
    })
    const pages = invoke('list_blocks', { blockType: 'page' }) as {
      items: Record<string, unknown>[]
    }
    expect(pages.items.some((p) => p.content === 'Unique Import Test')).toBe(true)
  })
})
