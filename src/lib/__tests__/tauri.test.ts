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
  createBlock,
  deleteBlock,
  editBlock,
  getBlock,
  listBlocks,
  moveBlock,
  purgeBlock,
  removeTag,
  restoreBlock,
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
// Cross-cutting concerns
// ---------------------------------------------------------------------------

describe('cross-cutting', () => {
  it('all wrappers use snake_case command names matching Rust', async () => {
    // Fire each wrapper once and collect command names
    mockedInvoke.mockResolvedValue({})

    await createBlock({ blockType: 'content', content: '' })
    await editBlock('id', 'text')
    await deleteBlock('id')
    await restoreBlock('id', 'ref')
    await purgeBlock('id')
    await listBlocks()
    await getBlock('id')
    await moveBlock('id', null, 0)
    await addTag('id', 'tag')
    await removeTag('id', 'tag')

    const commandNames = mockedInvoke.mock.calls.map((call) => call[0])
    expect(commandNames).toEqual([
      'create_block',
      'edit_block',
      'delete_block',
      'restore_block',
      'purge_block',
      'list_blocks',
      'get_block',
      'move_block',
      'add_tag',
      'remove_tag',
    ])
  })
})
