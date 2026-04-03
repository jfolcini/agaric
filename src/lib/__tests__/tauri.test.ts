/**
 * Tests for src/lib/tauri.ts — type-safe Tauri invoke wrappers.
 *
 * Verifies that each wrapper:
 *  1. Calls `invoke` with the correct Rust command name (snake_case).
 *  2. Passes arguments with correct camelCase keys (Tauri 2 convention).
 *  3. Defaults optional parameters to `null` (not `undefined`), which
 *     Tauri 2 requires for `Option<T>` Rust parameters.
 *  4. Returns the value from `invoke` unchanged.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addTag,
  batchResolve,
  cancelPairing,
  cancelSync,
  confirmPairing,
  createBlock,
  deleteBlock,
  deletePeerRef,
  deleteProperty,
  editBlock,
  getBacklinks,
  getBatchProperties,
  getBlock,
  getBlockHistory,
  getConflicts,
  getDeviceId,
  getPeerRef,
  getProperties,
  getStatus,
  listBlocks,
  listPageHistory,
  listPeerRefs,
  listPropertyKeys,
  listTagsByPrefix,
  listTagsForBlock,
  moveBlock,
  purgeBlock,
  queryBacklinksFiltered,
  queryByProperty,
  queryByTags,
  redoPageOp,
  removeTag,
  restoreBlock,
  revertOps,
  searchBlocks,
  setDueDate,
  setPriority,
  setProperty,
  setTodoState,
  startPairing,
  startSync,
  undoPageOp,
  updatePeerName,
} from '../tauri'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// createBlock
// ---------------------------------------------------------------------------

describe('createBlock', () => {
  it('invokes create_block with all parameters', async () => {
    const expected = {
      id: 'BLK001',
      block_type: 'content',
      content: 'hello',
      parent_id: 'PARENT01',
      position: 3,
      deleted_at: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await createBlock({
      blockType: 'content',
      content: 'hello',
      parentId: 'PARENT01',
      position: 3,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: 'hello',
      parentId: 'PARENT01',
      position: 3,
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional parentId and position to null', async () => {
    mockedInvoke.mockResolvedValueOnce({
      id: 'BLK002',
      block_type: 'page',
      content: 'test',
      parent_id: null,
      position: null,
      deleted_at: null,
    })

    await createBlock({ blockType: 'page', content: 'test' })

    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'page',
      content: 'test',
      parentId: null,
      position: null,
    })
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Validation error'))
    await expect(createBlock({ blockType: 'bad', content: '' })).rejects.toThrow('Validation error')
  })
})

// ---------------------------------------------------------------------------
// editBlock
// ---------------------------------------------------------------------------

describe('editBlock', () => {
  it('invokes edit_block with correct args', async () => {
    const expected = {
      id: 'BLK001',
      block_type: 'content',
      content: 'updated',
      parent_id: null,
      position: null,
      deleted_at: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await editBlock('BLK001', 'updated')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLK001',
      toText: 'updated',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// deleteBlock
// ---------------------------------------------------------------------------

describe('deleteBlock', () => {
  it('invokes delete_block with correct args', async () => {
    const expected = {
      block_id: 'BLK001',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 3,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await deleteBlock('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// restoreBlock
// ---------------------------------------------------------------------------

describe('restoreBlock', () => {
  it('invokes restore_block with blockId and deletedAtRef', async () => {
    const expected = { block_id: 'BLK001', restored_count: 2 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await restoreBlock('BLK001', '2025-01-15T00:00:00Z')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
      blockId: 'BLK001',
      deletedAtRef: '2025-01-15T00:00:00Z',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// purgeBlock
// ---------------------------------------------------------------------------

describe('purgeBlock', () => {
  it('invokes purge_block with blockId', async () => {
    const expected = { block_id: 'BLK001', purged_count: 5 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await purgeBlock('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// listBlocks
// ---------------------------------------------------------------------------

describe('listBlocks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes list_blocks with all nulls when no params given', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const result = await listBlocks()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: null,
      blockType: null,
      tagId: null,
      showDeleted: null,
      agendaDate: null,
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(emptyPage)
  })

  it('passes all optional parameters through', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'test',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: 'abc123',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await listBlocks({
      parentId: 'PARENT01',
      blockType: 'page',
      tagId: 'TAG01',
      showDeleted: true,
      agendaDate: '2025-01-15',
      cursor: 'cursor123',
      limit: 25,
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: 'PARENT01',
      blockType: 'page',
      tagId: 'TAG01',
      showDeleted: true,
      agendaDate: '2025-01-15',
      cursor: 'cursor123',
      limit: 25,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults missing optional params to null (not undefined)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await listBlocks({ blockType: 'page' })

    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>
    // Tauri 2 requires null for Option<T>, not undefined
    expect(args.parentId).toBeNull()
    expect(args.tagId).toBeNull()
    expect(args.showDeleted).toBeNull()
    expect(args.agendaDate).toBeNull()
    expect(args.cursor).toBeNull()
    expect(args.limit).toBeNull()
    // blockType should be the value we passed
    expect(args.blockType).toBe('page')
  })
})

// ---------------------------------------------------------------------------
// getBlock
// ---------------------------------------------------------------------------

describe('getBlock', () => {
  it('invokes get_block with blockId', async () => {
    const expected = {
      id: 'BLK001',
      block_type: 'content',
      content: 'hello',
      parent_id: null,
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getBlock('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// moveBlock
// ---------------------------------------------------------------------------

describe('moveBlock', () => {
  it('invokes move_block with all args', async () => {
    const expected = {
      block_id: 'BLK001',
      new_parent_id: 'PARENT02',
      new_position: 5,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await moveBlock('BLK001', 'PARENT02', 5)

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
      blockId: 'BLK001',
      newParentId: 'PARENT02',
      newPosition: 5,
    })
    expect(result).toEqual(expected)
  })

  it('passes null newParentId for top-level move', async () => {
    const expected = { block_id: 'BLK001', new_parent_id: null, new_position: 0 }
    mockedInvoke.mockResolvedValueOnce(expected)

    await moveBlock('BLK001', null, 0)

    expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
      blockId: 'BLK001',
      newParentId: null,
      newPosition: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// addTag
// ---------------------------------------------------------------------------

describe('addTag', () => {
  it('invokes add_tag with blockId and tagId', async () => {
    const expected = { block_id: 'BLK001', tag_id: 'TAG01' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await addTag('BLK001', 'TAG01')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('add_tag', {
      blockId: 'BLK001',
      tagId: 'TAG01',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// removeTag
// ---------------------------------------------------------------------------

describe('removeTag', () => {
  it('invokes remove_tag with blockId and tagId', async () => {
    const expected = { block_id: 'BLK001', tag_id: 'TAG01' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await removeTag('BLK001', 'TAG01')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('remove_tag', {
      blockId: 'BLK001',
      tagId: 'TAG01',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// searchBlocks
// ---------------------------------------------------------------------------

describe('searchBlocks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes search_blocks with all nulls when no optional params given', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const result = await searchBlocks({ query: 'hello' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'hello',
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(emptyPage)
  })

  it('passes all optional parameters through', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'found',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: 'next123',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await searchBlocks({
      query: 'found',
      cursor: 'cursor123',
      limit: 25,
    })

    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'found',
      cursor: 'cursor123',
      limit: 25,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults query to empty string when no params given', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await searchBlocks()

    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: '',
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// queryByTags
// ---------------------------------------------------------------------------

describe('queryByTags', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes query_by_tags with required params and null defaults', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const result = await queryByTags({
      tagIds: ['TAG01', 'TAG02'],
      prefixes: ['work'],
      mode: 'and',
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['TAG01', 'TAG02'],
      prefixes: ['work'],
      mode: 'and',
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(emptyPage)
  })

  it('passes all optional parameters through', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'found',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: 'next123',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await queryByTags({
      tagIds: ['TAG01'],
      prefixes: [],
      mode: 'or',
      cursor: 'cursor123',
      limit: 25,
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['TAG01'],
      prefixes: [],
      mode: 'or',
      cursor: 'cursor123',
      limit: 25,
    })
    expect(result).toEqual(pageResp)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('query failed'))
    await expect(queryByTags({ tagIds: ['TAG01'], prefixes: [], mode: 'and' })).rejects.toThrow(
      'query failed',
    )
  })
})

// ---------------------------------------------------------------------------
// listTagsByPrefix
// ---------------------------------------------------------------------------

describe('listTagsByPrefix', () => {
  it('invokes list_tags_by_prefix with prefix', async () => {
    const expected = [
      { tag_id: 'TAG01', name: 'work', usage_count: 5, updated_at: '2025-01-15T00:00:00Z' },
      { tag_id: 'TAG02', name: 'work/meeting', usage_count: 3, updated_at: '2025-01-15T00:00:00Z' },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listTagsByPrefix({ prefix: 'work' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_by_prefix', {
      prefix: 'work',
      limit: null,
    })
    expect(result).toEqual(expected)
  })

  it('returns empty array for no matches', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const result = await listTagsByPrefix({ prefix: 'nonexistent' })

    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_by_prefix', {
      prefix: 'nonexistent',
      limit: null,
    })
    expect(result).toEqual([])
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('list failed'))
    await expect(listTagsByPrefix({ prefix: 'fail' })).rejects.toThrow('list failed')
  })
})

// ---------------------------------------------------------------------------
// batchResolve
// ---------------------------------------------------------------------------

describe('batchResolve', () => {
  it('invokes batch_resolve with ids', async () => {
    const expected = [
      { id: 'B1', title: 'Block 1', block_type: 'content', deleted: false },
      { id: 'B2', title: null, block_type: 'page', deleted: true },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await batchResolve(['B1', 'B2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', { ids: ['B1', 'B2'] })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// getBacklinks
// ---------------------------------------------------------------------------

describe('getBacklinks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes get_backlinks with all parameters', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'ref',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: 'next1',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await getBacklinks({ blockId: 'TARGET', cursor: 'cur1', limit: 10 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
      blockId: 'TARGET',
      cursor: 'cur1',
      limit: 10,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional cursor and limit to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await getBacklinks({ blockId: 'TARGET' })

    expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
      blockId: 'TARGET',
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getBlockHistory
// ---------------------------------------------------------------------------

describe('getBlockHistory', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes get_block_history with all parameters', async () => {
    const pageResp = {
      items: [{ op_type: 'edit', seq: 1, device_id: 'dev1', timestamp: '2025-01-15T00:00:00Z' }],
      next_cursor: 'next1',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await getBlockHistory({ blockId: 'BLK001', cursor: 'cur1', limit: 5 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
      blockId: 'BLK001',
      cursor: 'cur1',
      limit: 5,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional cursor and limit to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await getBlockHistory({ blockId: 'BLK001' })

    expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
      blockId: 'BLK001',
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getConflicts
// ---------------------------------------------------------------------------

describe('getConflicts', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes get_conflicts with all parameters', async () => {
    const pageResp = {
      items: [
        {
          id: 'C1',
          block_type: 'content',
          content: 'conflict',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: true,
        },
      ],
      next_cursor: 'next1',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await getConflicts({ cursor: 'cur1', limit: 10 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', {
      cursor: 'cur1',
      limit: 10,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional cursor and limit to null when no params given', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await getConflicts()

    expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', {
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('invokes get_status with no arguments', async () => {
    const expected = { queue_length: 0, last_sync: '2025-01-15T00:00:00Z' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getStatus()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_status')
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// listTagsForBlock
// ---------------------------------------------------------------------------

describe('listTagsForBlock', () => {
  it('invokes list_tags_for_block with blockId', async () => {
    const expected = ['tag1', 'tag2', 'tag3']
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listTagsForBlock('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_for_block', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// setProperty
// ---------------------------------------------------------------------------

describe('setProperty', () => {
  it('invokes set_property with all value fields', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await setProperty({
      blockId: 'BLK001',
      key: 'priority',
      valueText: 'high',
      valueNum: 1,
      valueDate: '2025-01-15',
      valueRef: 'REF001',
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLK001',
      key: 'priority',
      valueText: 'high',
      valueNum: 1,
      valueDate: '2025-01-15',
      valueRef: 'REF001',
    })
  })

  it('defaults optional value fields to null', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await setProperty({ blockId: 'BLK001', key: 'status' })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLK001',
      key: 'status',
      valueText: null,
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
  })

  it('returns void (no return value)', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    const result = await setProperty({ blockId: 'BLK001', key: 'k', valueText: 'v' })

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// deleteProperty
// ---------------------------------------------------------------------------

describe('deleteProperty', () => {
  it('invokes delete_property with blockId and key', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await deleteProperty('BLK001', 'priority')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLK001',
      key: 'priority',
    })
  })

  it('returns void (no return value)', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    const result = await deleteProperty('BLK001', 'k')

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getProperties
// ---------------------------------------------------------------------------

describe('getProperties', () => {
  it('invokes get_properties with blockId', async () => {
    const expected = [
      { key: 'status', value_text: 'done', value_num: null, value_date: null, value_ref: null },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getProperties('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// getBatchProperties
// ---------------------------------------------------------------------------

describe('getBatchProperties', () => {
  it('invokes get_batch_properties with blockIds', async () => {
    const expected = {
      BLK001: [
        { key: 'status', value_text: 'done', value_num: null, value_date: null, value_ref: null },
      ],
      BLK002: [],
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getBatchProperties(['BLK001', 'BLK002'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
      blockIds: ['BLK001', 'BLK002'],
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// listPageHistory
// ---------------------------------------------------------------------------

describe('listPageHistory', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes list_page_history with all parameters', async () => {
    const pageResp = {
      items: [{ op_type: 'edit', seq: 1, device_id: 'dev1', timestamp: '2025-01-15T00:00:00Z' }],
      next_cursor: 'next1',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await listPageHistory({
      pageId: 'PAGE1',
      opTypeFilter: 'edit',
      cursor: 'cur1',
      limit: 20,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
      pageId: 'PAGE1',
      opTypeFilter: 'edit',
      cursor: 'cur1',
      limit: 20,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional opTypeFilter, cursor and limit to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await listPageHistory({ pageId: 'PAGE1' })

    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
      pageId: 'PAGE1',
      opTypeFilter: null,
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// revertOps
// ---------------------------------------------------------------------------

describe('revertOps', () => {
  it('invokes revert_ops with ops array', async () => {
    const ops = [
      { device_id: 'dev1', seq: 10 },
      { device_id: 'dev2', seq: 20 },
    ]
    const expected = { reverted: 2 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await revertOps({ ops })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('revert_ops', { ops })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// queryByProperty
// ---------------------------------------------------------------------------

describe('queryByProperty', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes query_by_property with all parameters', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'matched',
          parent_id: null,
          position: null,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: 'next1',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await queryByProperty({
      key: 'status',
      valueText: 'done',
      cursor: 'cur1',
      limit: 10,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'status',
      valueText: 'done',
      valueDate: null,
      cursor: 'cur1',
      limit: 10,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional valueText, cursor and limit to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await queryByProperty({ key: 'status' })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'status',
      valueText: null,
      valueDate: null,
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// undoPageOp
// ---------------------------------------------------------------------------

describe('undoPageOp', () => {
  it('invokes undo_page_op with pageId and undoDepth', async () => {
    const expected = {
      reversed_op: { device_id: 'dev1', seq: 5 },
      new_op_ref: { device_id: 'dev1', seq: 6 },
      new_op_type: 'edit',
      is_redo: false,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await undoPageOp({ pageId: 'PAGE1', undoDepth: 1 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('undo_page_op', {
      pageId: 'PAGE1',
      undoDepth: 1,
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// redoPageOp
// ---------------------------------------------------------------------------

describe('redoPageOp', () => {
  it('invokes redo_page_op with undoDeviceId and undoSeq', async () => {
    const expected = {
      reversed_op: { device_id: 'dev1', seq: 6 },
      new_op_ref: { device_id: 'dev1', seq: 7 },
      new_op_type: 'edit',
      is_redo: true,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await redoPageOp({ undoDeviceId: 'dev1', undoSeq: 6 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('redo_page_op', {
      undoDeviceId: 'dev1',
      undoSeq: 6,
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// listPeerRefs
// ---------------------------------------------------------------------------

describe('listPeerRefs', () => {
  it('invokes list_peer_refs with no arguments', async () => {
    const expected = [
      {
        peer_id: 'peer-1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: '2025-01-15T00:00:00Z',
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
      },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPeerRefs()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_peer_refs')
    expect(result).toEqual(expected)
  })

  it('returns empty array when no peers', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const result = await listPeerRefs()

    expect(result).toEqual([])
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(listPeerRefs()).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// getPeerRef
// ---------------------------------------------------------------------------

describe('getPeerRef', () => {
  it('invokes get_peer_ref with peerId', async () => {
    const expected = {
      peer_id: 'peer-1',
      last_hash: null,
      last_sent_hash: null,
      synced_at: '2025-01-15T00:00:00Z',
      reset_count: 0,
      last_reset_at: null,
      cert_hash: null,
      device_name: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getPeerRef('peer-1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_peer_ref', { peerId: 'peer-1' })
    expect(result).toEqual(expected)
  })

  it('returns null when peer not found', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await getPeerRef('nonexistent')

    expect(mockedInvoke).toHaveBeenCalledWith('get_peer_ref', { peerId: 'nonexistent' })
    expect(result).toBeNull()
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(getPeerRef('peer-1')).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// deletePeerRef
// ---------------------------------------------------------------------------

describe('deletePeerRef', () => {
  it('invokes delete_peer_ref with peerId', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await deletePeerRef('peer-to-delete')
    expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', { peerId: 'peer-to-delete' })
  })
})

// ---------------------------------------------------------------------------
// updatePeerName
// ---------------------------------------------------------------------------

describe('updatePeerName', () => {
  it('invokes update_peer_name with peerId and deviceName', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await updatePeerName('peer-1', "Javier's Phone")
    expect(mockedInvoke).toHaveBeenCalledWith('update_peer_name', {
      peerId: 'peer-1',
      deviceName: "Javier's Phone",
    })
  })

  it('passes null to clear the name', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await updatePeerName('peer-1', null)
    expect(mockedInvoke).toHaveBeenCalledWith('update_peer_name', {
      peerId: 'peer-1',
      deviceName: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getDeviceId
// ---------------------------------------------------------------------------

describe('getDeviceId', () => {
  it('invokes get_device_id with no arguments', async () => {
    mockedInvoke.mockResolvedValueOnce('my-device-uuid')
    const result = await getDeviceId()
    expect(result).toBe('my-device-uuid')
    expect(mockedInvoke).toHaveBeenCalledWith('get_device_id')
  })
})

// ---------------------------------------------------------------------------
// startPairing
// ---------------------------------------------------------------------------

describe('startPairing', () => {
  it('invokes start_pairing and returns pairing info', async () => {
    const expected = {
      passphrase: 'alpha bravo charlie delta',
      qr_svg: '<svg>...</svg>',
      port: 8765,
    }
    mockedInvoke.mockResolvedValueOnce(expected)
    const result = await startPairing()
    expect(result).toEqual(expected)
    expect(mockedInvoke).toHaveBeenCalledWith('start_pairing')
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('pairing unavailable'))
    await expect(startPairing()).rejects.toThrow('pairing unavailable')
  })
})

// ---------------------------------------------------------------------------
// confirmPairing
// ---------------------------------------------------------------------------

describe('confirmPairing', () => {
  it('invokes confirm_pairing with passphrase and remoteDeviceId', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await confirmPairing('alpha bravo charlie delta', 'remote-device-id')
    expect(mockedInvoke).toHaveBeenCalledWith('confirm_pairing', {
      passphrase: 'alpha bravo charlie delta',
      remoteDeviceId: 'remote-device-id',
    })
  })
})

// ---------------------------------------------------------------------------
// cancelPairing
// ---------------------------------------------------------------------------

describe('cancelPairing', () => {
  it('invokes cancel_pairing with no arguments', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await cancelPairing()
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
  })
})

// ---------------------------------------------------------------------------
// startSync
// ---------------------------------------------------------------------------

describe('startSync', () => {
  it('invokes start_sync with peerId', async () => {
    const expected = {
      state: 'syncing',
      local_device_id: 'local',
      remote_device_id: 'peer-1',
      ops_received: 0,
      ops_sent: 0,
    }
    mockedInvoke.mockResolvedValueOnce(expected)
    const result = await startSync('peer-1')
    expect(result).toEqual(expected)
    expect(mockedInvoke).toHaveBeenCalledWith('start_sync', { peerId: 'peer-1' })
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('peer unreachable'))
    await expect(startSync('peer-1')).rejects.toThrow('peer unreachable')
  })
})

// ---------------------------------------------------------------------------
// cancelSync
// ---------------------------------------------------------------------------

describe('cancelSync', () => {
  it('invokes cancel_sync with no arguments', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await cancelSync()
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_sync')
  })
})

// ---------------------------------------------------------------------------
// queryBacklinksFiltered
// ---------------------------------------------------------------------------

describe('queryBacklinksFiltered', () => {
  const emptyResponse = { items: [], next_cursor: null, has_more: false, total_count: 0 }

  it('calls invoke with correct command name', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await queryBacklinksFiltered({ blockId: 'TARGET' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke.mock.calls[0][0]).toBe('query_backlinks_filtered')
  })

  it('passes blockId parameter', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await queryBacklinksFiltered({ blockId: 'TARGET_BLOCK' })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_backlinks_filtered',
      expect.objectContaining({
        blockId: 'TARGET_BLOCK',
      }),
    )
  })

  it('defaults optional params to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await queryBacklinksFiltered({ blockId: 'TARGET' })

    expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
      blockId: 'TARGET',
      filters: null,
      sort: null,
      cursor: null,
      limit: null,
    })
  })

  it('passes filters when provided', async () => {
    const filters = [
      { type: 'BlockType' as const, block_type: 'content' },
      { type: 'Contains' as const, query: 'hello' },
    ]
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await queryBacklinksFiltered({ blockId: 'TARGET', filters })

    expect(mockedInvoke).toHaveBeenCalledWith('query_backlinks_filtered', {
      blockId: 'TARGET',
      filters,
      sort: null,
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// listPropertyKeys
// ---------------------------------------------------------------------------

describe('listPropertyKeys', () => {
  it('calls invoke with correct command name', async () => {
    mockedInvoke.mockResolvedValueOnce(['todo', 'priority'])

    await listPropertyKeys()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_property_keys')
  })

  it('returns string array', async () => {
    const expected = ['priority', 'status', 'todo']
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPropertyKeys()

    expect(result).toEqual(expected)
    expect(Array.isArray(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Thin fixed-field commands (setTodoState, setPriority, setDueDate)
// ---------------------------------------------------------------------------

describe('thin fixed-field commands', () => {
  it('setTodoState calls invoke with set_todo_state command', async () => {
    const expected = { id: 'BLOCK1', todo_state: 'TODO' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await setTodoState('BLOCK1', 'TODO')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK1',
      state: 'TODO',
    })
    expect(result).toEqual(expected)
  })

  it('setTodoState with null sends null state', async () => {
    const expected = { id: 'BLOCK1', todo_state: null }
    mockedInvoke.mockResolvedValueOnce(expected)

    await setTodoState('BLOCK1', null)

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK1',
      state: null,
    })
  })

  it('setPriority calls invoke with set_priority command', async () => {
    const expected = { id: 'BLOCK1', priority: '1' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await setPriority('BLOCK1', '1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK1',
      level: '1',
    })
    expect(result).toEqual(expected)
  })

  it('setPriority with null sends null level', async () => {
    const expected = { id: 'BLOCK1', priority: null }
    mockedInvoke.mockResolvedValueOnce(expected)

    await setPriority('BLOCK1', null)

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK1',
      level: null,
    })
  })

  it('setDueDate calls invoke with set_due_date command', async () => {
    const expected = { id: 'BLOCK1', due_date: '2026-06-15' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await setDueDate('BLOCK1', '2026-06-15')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK1',
      date: '2026-06-15',
    })
    expect(result).toEqual(expected)
  })

  it('setDueDate with null sends null date', async () => {
    const expected = { id: 'BLOCK1', due_date: null }
    mockedInvoke.mockResolvedValueOnce(expected)

    await setDueDate('BLOCK1', null)

    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK1',
      date: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting concerns
// ---------------------------------------------------------------------------

describe('cross-cutting', () => {
  it('all wrappers use snake_case command names matching Rust', async () => {
    mockedInvoke.mockResolvedValue({})

    await createBlock({ blockType: 'content', content: '' })
    await editBlock('id', 'text')
    await deleteBlock('id')
    await restoreBlock('id', 'ref')
    await purgeBlock('id')
    await listBlocks()
    await getBlock('id')
    await batchResolve(['id'])
    await moveBlock('id', null, 0)
    await addTag('id', 'tag')
    await removeTag('id', 'tag')
    await getBacklinks({ blockId: 'id' })
    await getBlockHistory({ blockId: 'id' })
    await getConflicts()
    await searchBlocks({ query: 'test' })
    await getStatus()
    await queryByTags({ tagIds: ['t'], prefixes: [], mode: 'and' })
    await listTagsByPrefix({ prefix: 'w' })
    await listTagsForBlock('id')
    await setProperty({ blockId: 'id', key: 'k' })
    await deleteProperty('id', 'k')
    await getProperties('id')
    await getBatchProperties(['id'])
    await listPageHistory({ pageId: 'id' })
    await revertOps({ ops: [{ device_id: 'd', seq: 1 }] })
    await queryByProperty({ key: 'k' })
    await queryBacklinksFiltered({ blockId: 'id' })
    await listPropertyKeys()
    await setTodoState('id', 'TODO')
    await setPriority('id', '1')
    await setDueDate('id', '2026-06-15')
    await undoPageOp({ pageId: 'id', undoDepth: 1 })
    await redoPageOp({ undoDeviceId: 'd', undoSeq: 1 })
    await listPeerRefs()
    await getPeerRef('peer-1')
    await deletePeerRef('peer-1')
    await updatePeerName('peer-1', 'My Phone')
    await getDeviceId()
    await startPairing()
    await confirmPairing('passphrase', 'remote-id')
    await cancelPairing()
    await startSync('peer-1')
    await cancelSync()

    const commandNames = mockedInvoke.mock.calls.map((call) => call[0])
    expect(commandNames).toEqual([
      'create_block',
      'edit_block',
      'delete_block',
      'restore_block',
      'purge_block',
      'list_blocks',
      'get_block',
      'batch_resolve',
      'move_block',
      'add_tag',
      'remove_tag',
      'get_backlinks',
      'get_block_history',
      'get_conflicts',
      'search_blocks',
      'get_status',
      'query_by_tags',
      'list_tags_by_prefix',
      'list_tags_for_block',
      'set_property',
      'delete_property',
      'get_properties',
      'get_batch_properties',
      'list_page_history',
      'revert_ops',
      'query_by_property',
      'query_backlinks_filtered',
      'list_property_keys',
      'set_todo_state',
      'set_priority',
      'set_due_date',
      'undo_page_op',
      'redo_page_op',
      'list_peer_refs',
      'get_peer_ref',
      'delete_peer_ref',
      'update_peer_name',
      'get_device_id',
      'start_pairing',
      'confirm_pairing',
      'cancel_pairing',
      'start_sync',
      'cancel_sync',
    ])
  })
})
