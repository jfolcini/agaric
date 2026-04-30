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
  addAttachment,
  addTag,
  batchResolve,
  cancelPairing,
  cancelSync,
  collectBugReportMetadata,
  compactOpLog,
  computeEditDiff,
  confirmPairing,
  countAgendaBatch,
  countAgendaBatchBySource,
  countBacklinksBatch,
  createBlock,
  createPageInSpace,
  createPropertyDef,
  deleteAttachment,
  deleteBlock,
  deleteDraft,
  deletePeerRef,
  deleteProperty,
  deletePropertyDef,
  editBlock,
  exportPageMarkdown,
  fetchLinkMetadata,
  flushDraft,
  getBacklinks,
  getBatchAttachmentCounts,
  getBatchAttachments,
  getBatchProperties,
  getBlock,
  getBlockHistory,
  getCompactionStatus,
  getConflicts,
  getDeviceId,
  getLinkMetadata,
  getLogDir,
  getPageAliases,
  getPeerRef,
  getProperties,
  getStatus,
  importMarkdown,
  listAttachments,
  listBacklinksGrouped,
  listBlocks,
  listDrafts,
  listPageHistory,
  listPageLinks,
  listPeerRefs,
  listProjectedAgenda,
  listPropertyDefs,
  listPropertyKeys,
  listSpaces,
  listTagsByPrefix,
  listTagsForBlock,
  listUndatedTasks,
  listUnlinkedReferences,
  logFrontend,
  moveBlock,
  purgeAllDeleted,
  purgeBlock,
  queryBacklinksFiltered,
  queryByProperty,
  queryByTags,
  quickCaptureBlock,
  readLogsForReport,
  redoPageOp,
  removeTag,
  resolvePageByAlias,
  restoreAllDeleted,
  restoreBlock,
  restorePageToOp,
  revertOps,
  saveDraft,
  searchBlocks,
  setDueDate,
  setPageAliases,
  setPeerAddress,
  setPriority,
  setProperty,
  setScheduledDate,
  setTodoState,
  startPairing,
  startSync,
  trashDescendantCounts,
  undoPageOp,
  updatePeerName,
  updatePropertyDefOptions,
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
      // BUG-1 / H-3a: every `create_block` IPC call carries `spaceId`.
      // For non-page block types `null` is correct (the backend ignores it).
      spaceId: null,
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
      // BUG-1 / H-3a: in production a page-typed `createBlock` MUST
      // pass `spaceId`; this unit test exercises only the wrapper's
      // payload shape, so `null` here documents that the wrapper
      // forwards `undefined` → `null` (the backend will then surface
      // `Validation` for a real call).
      spaceId: null,
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
      agenda: null,
      cursor: null,
      limit: null,
      spaceId: null,
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
      agenda: {
        date: '2025-01-15',
        dateRange: null,
        source: null,
      },
      cursor: 'cursor123',
      limit: 25,
      spaceId: null,
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults missing optional params to null (not undefined)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await listBlocks({ blockType: 'page' })

    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    // Tauri 2 requires null for Option<T>, not undefined
    expect(args['parentId']).toBeNull()
    expect(args['tagId']).toBeNull()
    expect(args['showDeleted']).toBeNull()
    // agenda params bundle to null on the IPC boundary when none are set
    expect(args['agenda']).toBeNull()
    expect(args['cursor']).toBeNull()
    expect(args['limit']).toBeNull()
    expect(args['spaceId']).toBeNull()
    // blockType should be the value we passed
    expect(args['blockType']).toBe('page')
  })
})

// ---------------------------------------------------------------------------
// listUndatedTasks
// ---------------------------------------------------------------------------

describe('listUndatedTasks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false }

  it('invokes list_undated_tasks with correct args', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    const result = await listUndatedTasks({ cursor: 'abc', limit: 10 })
    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_undated_tasks', {
      cursor: 'abc',
      limit: 10,
    })
    expect(result).toEqual(emptyPage)
  })

  it('defaults optional params to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await listUndatedTasks()
    const callArgs = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(callArgs['cursor']).toBeNull()
    expect(callArgs['limit']).toBeNull()
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('query failed'))
    await expect(listUndatedTasks()).rejects.toThrow('query failed')
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
      parentId: null,
      tagIds: null,
      spaceId: null,
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
      parentId: null,
      tagIds: null,
      spaceId: null,
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
      parentId: null,
      tagIds: null,
      spaceId: null,
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
      includeInherited: null,
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
      includeInherited: null,
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
  it('invokes batch_resolve with ids and a null spaceId by default', async () => {
    const expected = [
      { id: 'B1', title: 'Block 1', block_type: 'content', deleted: false },
      { id: 'B2', title: null, block_type: 'page', deleted: true },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await batchResolve(['B1', 'B2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // FEAT-3p7 — wrapper always forwards `spaceId`; null when omitted.
    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', {
      ids: ['B1', 'B2'],
      spaceId: null,
    })
    expect(result).toEqual(expected)
  })

  it('forwards spaceId when provided (FEAT-3p7)', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    await batchResolve(['B1'], 'SPACE_X')

    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', {
      ids: ['B1'],
      spaceId: 'SPACE_X',
    })
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
      opTypeFilter: 'edit_block',
      cursor: 'cur1',
      limit: 20,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
      pageId: 'PAGE1',
      opTypeFilter: 'edit_block',
      // FEAT-3p8: `spaceId` is threaded through every history call;
      // `null` here means "all spaces" since this test doesn't pass one.
      spaceId: null,
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
      // FEAT-3p8: `spaceId` defaults to `null` (= all spaces) when the
      // caller omits it, matching the other optional knobs.
      spaceId: null,
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
      operator: null,
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
      operator: null,
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
    expect((mockedInvoke.mock.calls[0] as unknown[])[0]).toBe('query_backlinks_filtered')
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
// countAgendaBatch
// ---------------------------------------------------------------------------

describe('countAgendaBatch', () => {
  it('invokes count_agenda_batch with dates', async () => {
    const expected = { '2025-01-15': 3, '2025-01-16': 1 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await countAgendaBatch({ dates: ['2025-01-15', '2025-01-16'] })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('count_agenda_batch', {
      dates: ['2025-01-15', '2025-01-16'],
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// countAgendaBatchBySource
// ---------------------------------------------------------------------------

describe('countAgendaBatchBySource', () => {
  it('invokes count_agenda_batch_by_source with dates', async () => {
    const expected = {
      '2025-01-15': { 'column:due_date': 2, 'column:scheduled_date': 1 },
      '2025-01-16': { 'property:deadline': 1 },
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await countAgendaBatchBySource({ dates: ['2025-01-15', '2025-01-16'] })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('count_agenda_batch_by_source', {
      dates: ['2025-01-15', '2025-01-16'],
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// countBacklinksBatch
// ---------------------------------------------------------------------------

describe('countBacklinksBatch', () => {
  it('invokes count_backlinks_batch with pageIds', async () => {
    const expected = { PAGE1: 5, PAGE2: 0 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await countBacklinksBatch({ pageIds: ['PAGE1', 'PAGE2'] })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('count_backlinks_batch', {
      pageIds: ['PAGE1', 'PAGE2'],
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// setScheduledDate
// ---------------------------------------------------------------------------

describe('setScheduledDate', () => {
  it('invokes set_scheduled_date with blockId and date', async () => {
    const expected = { id: 'BLOCK1', scheduled_date: '2026-06-15' }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await setScheduledDate('BLOCK1', '2026-06-15')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
      blockId: 'BLOCK1',
      date: '2026-06-15',
    })
    expect(result).toEqual(expected)
  })

  it('passes null to clear the scheduled date', async () => {
    const expected = { id: 'BLOCK1', scheduled_date: null }
    mockedInvoke.mockResolvedValueOnce(expected)

    await setScheduledDate('BLOCK1', null)

    expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
      blockId: 'BLOCK1',
      date: null,
    })
  })
})

// ---------------------------------------------------------------------------
// computeEditDiff
// ---------------------------------------------------------------------------

describe('computeEditDiff', () => {
  it('invokes compute_edit_diff with deviceId and seq', async () => {
    const expected = [
      { tag: 'Equal', value: 'hello ' },
      { tag: 'Delete', value: 'world' },
      { tag: 'Insert', value: 'there' },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await computeEditDiff({ deviceId: 'dev1', seq: 42 })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('compute_edit_diff', {
      deviceId: 'dev1',
      seq: 42,
    })
    expect(result).toEqual(expected)
  })

  it('returns null for non-edit ops', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await computeEditDiff({ deviceId: 'dev1', seq: 1 })

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listBacklinksGrouped
// ---------------------------------------------------------------------------

describe('listBacklinksGrouped', () => {
  const emptyResponse = {
    groups: [],
    next_cursor: null,
    has_more: false,
    total_count: 0,
    filtered_count: 0,
    truncated: false,
  }

  it('invokes list_backlinks_grouped with pageId mapped to blockId', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    const result = await listBacklinksGrouped({ blockId: 'PAGE1' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
      blockId: 'PAGE1',
      filters: null,
      sort: null,
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(emptyResponse)
  })

  it('passes filters and sort when provided', async () => {
    const filters = [{ type: 'Contains' as const, query: 'hello' }]
    const sort = { type: 'Created' as const, dir: 'Desc' as const }
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await listBacklinksGrouped({ blockId: 'PAGE1', filters, sort, cursor: 'cur1', limit: 10 })

    expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
      blockId: 'PAGE1',
      filters,
      sort,
      cursor: 'cur1',
      limit: 10,
    })
  })
})

// ---------------------------------------------------------------------------
// listUnlinkedReferences
// ---------------------------------------------------------------------------

describe('listUnlinkedReferences', () => {
  const emptyResponse = {
    groups: [],
    next_cursor: null,
    has_more: false,
    total_count: 0,
    filtered_count: 0,
    truncated: false,
  }

  it('invokes list_unlinked_references with pageId', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    const result = await listUnlinkedReferences({ pageId: 'PAGE1' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_unlinked_references', {
      pageId: 'PAGE1',
      filters: null,
      sort: null,
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(emptyResponse)
  })

  it('passes cursor and limit when provided', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await listUnlinkedReferences({ pageId: 'PAGE1', cursor: 'cur1', limit: 20 })

    expect(mockedInvoke).toHaveBeenCalledWith('list_unlinked_references', {
      pageId: 'PAGE1',
      filters: null,
      sort: null,
      cursor: 'cur1',
      limit: 20,
    })
  })
})

// ---------------------------------------------------------------------------
// createPropertyDef
// ---------------------------------------------------------------------------

describe('createPropertyDef', () => {
  it('invokes create_property_def with all params', async () => {
    const expected = {
      key: 'status',
      value_type: 'select',
      options: '["todo","done"]',
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await createPropertyDef({
      key: 'status',
      valueType: 'select',
      options: '["todo","done"]',
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      key: 'status',
      valueType: 'select',
      options: '["todo","done"]',
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional options to null', async () => {
    const expected = {
      key: 'priority',
      value_type: 'text',
      options: null,
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    await createPropertyDef({ key: 'priority', valueType: 'text' })

    expect(mockedInvoke).toHaveBeenCalledWith('create_property_def', {
      key: 'priority',
      valueType: 'text',
      options: null,
    })
  })
})

// ---------------------------------------------------------------------------
// listPropertyDefs
// ---------------------------------------------------------------------------

describe('listPropertyDefs', () => {
  it('invokes list_property_defs with no arguments', async () => {
    const expected = [
      {
        key: 'status',
        value_type: 'select',
        options: '["todo","done"]',
        created_at: '2025-01-15T00:00:00Z',
      },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPropertyDefs()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs')
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// updatePropertyDefOptions
// ---------------------------------------------------------------------------

describe('updatePropertyDefOptions', () => {
  it('invokes update_property_def_options with key and options', async () => {
    const expected = {
      key: 'status',
      value_type: 'select',
      options: '["todo","done","cancelled"]',
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await updatePropertyDefOptions('status', '["todo","done","cancelled"]')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('update_property_def_options', {
      key: 'status',
      options: '["todo","done","cancelled"]',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// deletePropertyDef
// ---------------------------------------------------------------------------

describe('deletePropertyDef', () => {
  it('invokes delete_property_def with key', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await deletePropertyDef('status')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property_def', { key: 'status' })
  })
})

// ---------------------------------------------------------------------------
// setPageAliases
// ---------------------------------------------------------------------------

describe('setPageAliases', () => {
  it('invokes set_page_aliases with pageId and aliases', async () => {
    const expected = ['alias1', 'alias2']
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await setPageAliases('PAGE1', ['alias1', 'alias2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_page_aliases', {
      pageId: 'PAGE1',
      aliases: ['alias1', 'alias2'],
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// getPageAliases
// ---------------------------------------------------------------------------

describe('getPageAliases', () => {
  it('invokes get_page_aliases with pageId', async () => {
    const expected = ['alias1', 'alias2']
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getPageAliases('PAGE1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_page_aliases', { pageId: 'PAGE1' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// resolvePageByAlias
// ---------------------------------------------------------------------------

describe('resolvePageByAlias', () => {
  it('invokes resolve_page_by_alias with alias', async () => {
    const expected: [string, string | null] = ['PAGE1', 'My Page']
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await resolvePageByAlias('my-alias')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('resolve_page_by_alias', { alias: 'my-alias' })
    expect(result).toEqual(expected)
  })

  it('returns null when alias not found', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await resolvePageByAlias('nonexistent')

    expect(mockedInvoke).toHaveBeenCalledWith('resolve_page_by_alias', { alias: 'nonexistent' })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// exportPageMarkdown
// ---------------------------------------------------------------------------

describe('exportPageMarkdown', () => {
  it('invokes export_page_markdown with pageId', async () => {
    const expected = '# My Page\n\nHello world'
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await exportPageMarkdown('PAGE1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('export_page_markdown', { pageId: 'PAGE1' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// restoreAllDeleted
// ---------------------------------------------------------------------------

describe('restoreAllDeleted', () => {
  it('invokes restore_all_deleted with no arguments', async () => {
    const expected = { affected_count: 5 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await restoreAllDeleted()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('restore_all_deleted')
    expect(result).toEqual(expected)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(restoreAllDeleted()).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// purgeAllDeleted
// ---------------------------------------------------------------------------

describe('purgeAllDeleted', () => {
  it('invokes purge_all_deleted with no arguments', async () => {
    const expected = { affected_count: 8 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await purgeAllDeleted()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('purge_all_deleted')
    expect(result).toEqual(expected)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(purgeAllDeleted()).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// trashDescendantCounts
// ---------------------------------------------------------------------------

describe('trashDescendantCounts', () => {
  it('invokes trash_descendant_counts with rootIds array', async () => {
    const expected = { ROOT1: 3, ROOT2: 1 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await trashDescendantCounts(['ROOT1', 'ROOT2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('trash_descendant_counts', {
      rootIds: ['ROOT1', 'ROOT2'],
    })
    expect(result).toEqual(expected)
  })

  it('passes empty array unchanged', async () => {
    mockedInvoke.mockResolvedValueOnce({})

    await trashDescendantCounts([])

    expect(mockedInvoke).toHaveBeenCalledWith('trash_descendant_counts', { rootIds: [] })
  })
})

// ---------------------------------------------------------------------------
// listProjectedAgenda
// ---------------------------------------------------------------------------

describe('listProjectedAgenda', () => {
  it('invokes list_projected_agenda with all parameters', async () => {
    const expected = [
      {
        block: {
          id: 'BLK1',
          block_type: 'task',
          content: 'recurring',
          parent_id: null,
          position: null,
          deleted_at: null,
        },
        projected_date: '2025-02-01',
        source: 'due_date',
      },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listProjectedAgenda({
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      limit: 50,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_projected_agenda', {
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      limit: 50,
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional limit to null', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    await listProjectedAgenda({ startDate: '2025-01-15', endDate: '2025-02-15' })

    expect(mockedInvoke).toHaveBeenCalledWith('list_projected_agenda', {
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// listPageLinks
// ---------------------------------------------------------------------------

describe('listPageLinks', () => {
  it('invokes list_page_links with no arguments', async () => {
    const expected = [
      { source_id: 'PAGE1', target_id: 'PAGE2', ref_count: 3 },
      { source_id: 'PAGE2', target_id: 'PAGE3', ref_count: 1 },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPageLinks()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_links')
    expect(result).toEqual(expected)
  })

  it('returns empty array when no links exist', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const result = await listPageLinks()

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// restorePageToOp
// ---------------------------------------------------------------------------

describe('restorePageToOp', () => {
  it('invokes restore_page_to_op with all parameters', async () => {
    const expected = { ops_reverted: 3, non_reversible_skipped: 1, results: [] }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await restorePageToOp({
      pageId: 'PAGE1',
      targetDeviceId: 'dev1',
      targetSeq: 42,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('restore_page_to_op', {
      pageId: 'PAGE1',
      targetDeviceId: 'dev1',
      targetSeq: 42,
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// setPeerAddress
// ---------------------------------------------------------------------------

describe('setPeerAddress', () => {
  it('invokes set_peer_address with peerId and address', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await setPeerAddress('peer-1', '192.168.1.10:8765')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_peer_address', {
      peerId: 'peer-1',
      address: '192.168.1.10:8765',
    })
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('invalid address'))
    await expect(setPeerAddress('peer-1', 'bogus')).rejects.toThrow('invalid address')
  })
})

// ---------------------------------------------------------------------------
// listAttachments
// ---------------------------------------------------------------------------

describe('listAttachments', () => {
  it('invokes list_attachments with blockId', async () => {
    const expected = [
      {
        id: 'ATT1',
        block_id: 'BLK001',
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        fs_path: '/tmp/photo.png',
        created_at: '2025-01-15T00:00:00Z',
      },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listAttachments('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_attachments', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// getBatchAttachmentCounts
// ---------------------------------------------------------------------------

describe('getBatchAttachmentCounts', () => {
  it('invokes get_batch_attachment_counts with blockIds', async () => {
    const expected = { BLK001: 2, BLK002: 0 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getBatchAttachmentCounts(['BLK001', 'BLK002'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_batch_attachment_counts', {
      blockIds: ['BLK001', 'BLK002'],
    })
    expect(result).toEqual(expected)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(getBatchAttachmentCounts(['BLK001'])).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// getBatchAttachments
// ---------------------------------------------------------------------------

describe('getBatchAttachments', () => {
  it('invokes list_attachments_batch with blockIds', async () => {
    const expected = {
      BLK001: [
        {
          id: 'ATT1',
          block_id: 'BLK001',
          filename: 'photo.png',
          mime_type: 'image/png',
          size_bytes: 1024,
          fs_path: '/tmp/photo.png',
          created_at: '2025-01-15T00:00:00Z',
        },
      ],
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getBatchAttachments(['BLK001'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
      blockIds: ['BLK001'],
    })
    expect(result).toEqual(expected)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(getBatchAttachments(['BLK001'])).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// addAttachment
// ---------------------------------------------------------------------------

describe('addAttachment', () => {
  it('invokes add_attachment with all parameters', async () => {
    const expected = {
      id: 'ATT1',
      block_id: 'BLK001',
      filename: 'doc.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      fs_path: '/tmp/doc.pdf',
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await addAttachment({
      blockId: 'BLK001',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      fsPath: '/tmp/doc.pdf',
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('add_attachment', {
      blockId: 'BLK001',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      fsPath: '/tmp/doc.pdf',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

describe('deleteAttachment', () => {
  it('invokes delete_attachment with attachmentId', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await deleteAttachment('ATT1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_attachment', { attachmentId: 'ATT1' })
  })
})

// ---------------------------------------------------------------------------
// importMarkdown
// ---------------------------------------------------------------------------

describe('importMarkdown', () => {
  it('invokes import_markdown with content and filename', async () => {
    const expected = {
      page_title: 'My Page',
      blocks_created: 5,
      properties_set: 2,
      warnings: [],
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await importMarkdown('# Title\n\nBody', 'my-page.md')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('import_markdown', {
      content: '# Title\n\nBody',
      filename: 'my-page.md',
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional filename to null', async () => {
    mockedInvoke.mockResolvedValueOnce({
      page_title: 'Untitled',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    })

    await importMarkdown('hello')

    expect(mockedInvoke).toHaveBeenCalledWith('import_markdown', {
      content: 'hello',
      filename: null,
    })
  })
})

// ---------------------------------------------------------------------------
// saveDraft
// ---------------------------------------------------------------------------

describe('saveDraft', () => {
  it('invokes save_draft with blockId and content', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await saveDraft('BLK001', 'work in progress')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('save_draft', {
      blockId: 'BLK001',
      content: 'work in progress',
    })
  })

  it('returns void (no return value)', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    const result = await saveDraft('BLK001', 'x')

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// flushDraft
// ---------------------------------------------------------------------------

describe('flushDraft', () => {
  it('invokes flush_draft with blockId', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await flushDraft('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('flush_draft', { blockId: 'BLK001' })
  })
})

// ---------------------------------------------------------------------------
// deleteDraft
// ---------------------------------------------------------------------------

describe('deleteDraft', () => {
  it('invokes delete_draft with blockId', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await deleteDraft('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_draft', { blockId: 'BLK001' })
  })
})

// ---------------------------------------------------------------------------
// listDrafts
// ---------------------------------------------------------------------------

describe('listDrafts', () => {
  it('invokes list_drafts with no arguments', async () => {
    const expected = [{ block_id: 'BLK001', content: 'draft', updated_at: '2025-01-15T00:00:00Z' }]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listDrafts()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_drafts')
    expect(result).toEqual(expected)
  })

  it('returns empty array when no drafts', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const result = await listDrafts()

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// logFrontend
// ---------------------------------------------------------------------------

describe('logFrontend', () => {
  it('invokes log_frontend with all parameters', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await logFrontend('error', 'EditableBlock', 'failed to save', 'Error: x', 'ctx', '{"k":"v"}')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('log_frontend', {
      level: 'error',
      module: 'EditableBlock',
      message: 'failed to save',
      stack: 'Error: x',
      context: 'ctx',
      data: '{"k":"v"}',
    })
  })

  it('defaults optional stack, context and data to null', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await logFrontend('info', 'mod', 'msg')

    expect(mockedInvoke).toHaveBeenCalledWith('log_frontend', {
      level: 'info',
      module: 'mod',
      message: 'msg',
      stack: null,
      context: null,
      data: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getLogDir
// ---------------------------------------------------------------------------

describe('getLogDir', () => {
  it('invokes get_log_dir with no arguments', async () => {
    mockedInvoke.mockResolvedValueOnce('/home/user/.local/share/agaric/logs')

    const result = await getLogDir()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_log_dir')
    expect(result).toBe('/home/user/.local/share/agaric/logs')
  })
})

// ---------------------------------------------------------------------------
// getCompactionStatus
// ---------------------------------------------------------------------------

describe('getCompactionStatus', () => {
  it('invokes get_compaction_status with no arguments', async () => {
    const expected = {
      total_ops: 1000,
      oldest_op_date: '2025-01-01T00:00:00Z',
      eligible_ops: 200,
      retention_days: 30,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getCompactionStatus()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_compaction_status')
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// compactOpLog
// ---------------------------------------------------------------------------

describe('compactOpLog', () => {
  it('invokes compact_op_log_cmd with retentionDays', async () => {
    const expected = { snapshot_id: 'SNAP1', ops_deleted: 200 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await compactOpLog(30)

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('compact_op_log_cmd', { retentionDays: 30 })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// fetchLinkMetadata
// ---------------------------------------------------------------------------

describe('fetchLinkMetadata', () => {
  it('invokes fetch_link_metadata with url', async () => {
    const expected = {
      url: 'https://example.com',
      title: 'Example',
      favicon_url: 'https://example.com/favicon.ico',
      description: 'An example site',
      fetched_at: '2025-01-15T00:00:00Z',
      auth_required: false,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await fetchLinkMetadata('https://example.com')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('fetch_link_metadata', {
      url: 'https://example.com',
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// getLinkMetadata
// ---------------------------------------------------------------------------

describe('getLinkMetadata', () => {
  it('invokes get_link_metadata with url', async () => {
    const expected = {
      url: 'https://example.com',
      title: 'Example',
      favicon_url: null,
      description: null,
      fetched_at: '2025-01-15T00:00:00Z',
      auth_required: false,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getLinkMetadata('https://example.com')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_link_metadata', {
      url: 'https://example.com',
    })
    expect(result).toEqual(expected)
  })

  it('returns null when not cached', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await getLinkMetadata('https://uncached.example')

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// collectBugReportMetadata
// ---------------------------------------------------------------------------

describe('collectBugReportMetadata', () => {
  it('invokes collect_bug_report_metadata with no arguments', async () => {
    const expected = {
      app_version: '0.1.0',
      os: 'linux',
      arch: 'x86_64',
      device_id: 'dev-1',
      recent_errors: ['error: connection timeout'],
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await collectBugReportMetadata()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('collect_bug_report_metadata')
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// readLogsForReport
// ---------------------------------------------------------------------------

describe('readLogsForReport', () => {
  it('invokes read_logs_for_report with redact=true', async () => {
    const expected = [{ name: 'today.log', contents: 'INFO startup' }]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await readLogsForReport(true)

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('read_logs_for_report', { redact: true })
    expect(result).toEqual(expected)
  })

  it('invokes read_logs_for_report with redact=false', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    await readLogsForReport(false)

    expect(mockedInvoke).toHaveBeenCalledWith('read_logs_for_report', { redact: false })
  })
})

// ---------------------------------------------------------------------------
// listSpaces
// ---------------------------------------------------------------------------

describe('listSpaces', () => {
  it('invokes list_spaces with no arguments', async () => {
    const expected = [
      { id: 'SPACE1', name: 'Personal' },
      { id: 'SPACE2', name: 'Work' },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listSpaces()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_spaces')
    expect(result).toEqual(expected)
  })

  it('returns empty array when no spaces', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const result = await listSpaces()

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// createPageInSpace
// ---------------------------------------------------------------------------

describe('createPageInSpace', () => {
  it('invokes create_page_in_space with all parameters', async () => {
    mockedInvoke.mockResolvedValueOnce('NEW_PAGE_ID')

    const result = await createPageInSpace({
      parentId: 'PARENT1',
      content: 'My new page',
      spaceId: 'SPACE1',
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
      parentId: 'PARENT1',
      content: 'My new page',
      spaceId: 'SPACE1',
    })
    expect(result).toBe('NEW_PAGE_ID')
  })

  it('defaults optional parentId to null', async () => {
    mockedInvoke.mockResolvedValueOnce('NEW_PAGE_ID')

    await createPageInSpace({ content: 'Top-level page', spaceId: 'SPACE1' })

    expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
      parentId: null,
      content: 'Top-level page',
      spaceId: 'SPACE1',
    })
  })
})

// ---------------------------------------------------------------------------
// Autostart (FEAT-13)
// ---------------------------------------------------------------------------
//
// `enableAutostart`, `disableAutostart`, and `isAutostartEnabled` thin-wrap
// `@tauri-apps/plugin-autostart`'s three exports.  Unlike the rest of the
// `tauri.ts` wrappers (which call `invoke()` directly), these use a dynamic
// `import('@tauri-apps/plugin-autostart')` so the tests follow the
// `clipboard.test.ts` / `relaunch-app.test.ts` pattern: `vi.doMock(...)`
// before re-importing the wrappers via `vi.resetModules()`.

describe('autostart wrappers (FEAT-13)', () => {
  const mockEnable = vi.fn()
  const mockDisable = vi.fn()
  const mockIsEnabled = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mockEnable.mockReset()
    mockDisable.mockReset()
    mockIsEnabled.mockReset()
  })

  describe('isAutostartEnabled', () => {
    it('returns the boolean from the plugin when available', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockResolvedValueOnce(true)

      const { isAutostartEnabled } = await import('../tauri')
      const result = await isAutostartEnabled()

      expect(mockIsEnabled).toHaveBeenCalledOnce()
      expect(result).toBe(true)
    })

    it('returns false when the plugin reports disabled', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockResolvedValueOnce(false)

      const { isAutostartEnabled } = await import('../tauri')
      const result = await isAutostartEnabled()

      expect(result).toBe(false)
    })

    it('propagates rejections so callers can detect plugin unavailability', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockRejectedValueOnce(new Error('plugin not registered'))

      const { isAutostartEnabled } = await import('../tauri')

      await expect(isAutostartEnabled()).rejects.toThrow('plugin not registered')
    })
  })

  describe('enableAutostart', () => {
    it('calls enable() from the plugin and resolves on success', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockEnable.mockResolvedValueOnce(undefined)

      const { enableAutostart } = await import('../tauri')
      await enableAutostart()

      expect(mockEnable).toHaveBeenCalledOnce()
      expect(mockDisable).not.toHaveBeenCalled()
      expect(mockIsEnabled).not.toHaveBeenCalled()
    })

    it('propagates the rejection when enable() fails (caller surfaces toast)', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      vi.doMock('@/lib/logger', () => ({
        logger: { warn: vi.fn(), error: vi.fn() },
      }))
      mockEnable.mockRejectedValueOnce(new Error('IPC denied'))

      const { enableAutostart } = await import('../tauri')

      await expect(enableAutostart()).rejects.toThrow('IPC denied')
      expect(mockEnable).toHaveBeenCalledOnce()
    })
  })

  describe('disableAutostart', () => {
    it('calls disable() from the plugin and resolves on success', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockDisable.mockResolvedValueOnce(undefined)

      const { disableAutostart } = await import('../tauri')
      await disableAutostart()

      expect(mockDisable).toHaveBeenCalledOnce()
      expect(mockEnable).not.toHaveBeenCalled()
      expect(mockIsEnabled).not.toHaveBeenCalled()
    })

    it('propagates the rejection when disable() fails', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      vi.doMock('@/lib/logger', () => ({
        logger: { warn: vi.fn(), error: vi.fn() },
      }))
      mockDisable.mockRejectedValueOnce(new Error('plugin unavailable'))

      const { disableAutostart } = await import('../tauri')

      await expect(disableAutostart()).rejects.toThrow('plugin unavailable')
      expect(mockDisable).toHaveBeenCalledOnce()
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
    await countAgendaBatch({ dates: ['2025-01-15'] })
    await countBacklinksBatch({ pageIds: ['id'] })
    await setTodoState('id', 'TODO')
    await setPriority('id', '1')
    await setDueDate('id', '2026-06-15')
    await setScheduledDate('id', '2026-07-01')
    await listPageHistory({ pageId: 'id' })
    await revertOps({ ops: [{ device_id: 'd', seq: 1 }] })
    await queryByProperty({ key: 'k' })
    await undoPageOp({ pageId: 'id', undoDepth: 1 })
    await redoPageOp({ undoDeviceId: 'd', undoSeq: 1 })
    await computeEditDiff({ deviceId: 'd', seq: 1 })
    await queryBacklinksFiltered({ blockId: 'id' })
    await listBacklinksGrouped({ blockId: 'id' })
    await listUnlinkedReferences({ pageId: 'id' })
    await listPropertyKeys()
    await createPropertyDef({ key: 'k', valueType: 'text' })
    await listPropertyDefs()
    await updatePropertyDefOptions('k', '[]')
    await deletePropertyDef('k')
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
    await setPageAliases('id', ['alias'])
    await getPageAliases('id')
    await resolvePageByAlias('alias')
    await exportPageMarkdown('id')

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
      'count_agenda_batch',
      'count_backlinks_batch',
      'set_todo_state',
      'set_priority',
      'set_due_date',
      'set_scheduled_date',
      'list_page_history',
      'revert_ops',
      'query_by_property',
      'undo_page_op',
      'redo_page_op',
      'compute_edit_diff',
      'query_backlinks_filtered',
      'list_backlinks_grouped',
      'list_unlinked_references',
      'list_property_keys',
      'create_property_def',
      'list_property_defs',
      'update_property_def_options',
      'delete_property_def',
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
      'set_page_aliases',
      'get_page_aliases',
      'resolve_page_by_alias',
      'export_page_markdown',
    ])
  })
})

// ---------------------------------------------------------------------------
// FEAT-12: quickCaptureBlock + global-shortcut wrappers
// ---------------------------------------------------------------------------
//
// `registerGlobalShortcut` / `unregisterGlobalShortcut` /
// `isGlobalShortcutRegistered` use a dynamic `import('@tauri-apps/plugin-global-shortcut')`
// internally, so we mock the module factory at the file scope and import
// the wrappers separately.

const mockRegister = vi.fn()
const mockUnregister = vi.fn()
const mockIsRegistered = vi.fn()
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: mockRegister,
  unregister: mockUnregister,
  isRegistered: mockIsRegistered,
}))

// Defer the import so the vi.mock above hoists ahead of it. Using a dynamic
// import at the top of each test keeps the wrapper references fresh across
// `vi.clearAllMocks()` runs in `beforeEach`.
async function importGlobalShortcutWrappers() {
  return await import('../tauri')
}

describe('quickCaptureBlock', () => {
  it('invokes quick_capture_block with the captured content and active space', async () => {
    const expected = {
      id: 'BLK_QC1',
      block_type: 'content',
      content: 'captured note',
      parent_id: 'PARENT_PAGE',
      position: 1,
      deleted_at: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await quickCaptureBlock('captured note', 'SPACE_PERSONAL')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // FEAT-3p5: spaceId is required so quick-capture lands on the
    // active-space's daily journal page.
    expect(mockedInvoke).toHaveBeenCalledWith('quick_capture_block', {
      content: 'captured note',
      spaceId: 'SPACE_PERSONAL',
    })
    expect(result).toEqual(expected)
  })

  // MAINT-99: every IPC wrapper must have at least one mockRejectedValue
  // test so the failure path is covered.
  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('quick_capture_block failed'))
    await expect(quickCaptureBlock('foo', 'SPACE_PERSONAL')).rejects.toThrow(
      'quick_capture_block failed',
    )
  })
})

describe('registerGlobalShortcut', () => {
  beforeEach(() => {
    mockRegister.mockReset()
    mockUnregister.mockReset()
    mockIsRegistered.mockReset()
  })

  it('forwards the accelerator to the plugin and only fires the user callback on Pressed events', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    mockRegister.mockResolvedValueOnce(undefined)

    const handler = vi.fn()
    await registerGlobalShortcut('Ctrl+Alt+N', handler)

    expect(mockRegister).toHaveBeenCalledOnce()
    expect(mockRegister).toHaveBeenCalledWith('Ctrl+Alt+N', expect.any(Function))

    // Drive the captured plugin handler with a Pressed and a Released
    // event — only the Pressed activation should reach the user callback.
    const pluginHandler = mockRegister.mock.calls[0]?.[1] as (e: {
      shortcut: string
      id: number
      state: 'Pressed' | 'Released'
    }) => void
    pluginHandler({ shortcut: 'Ctrl+Alt+N', id: 1, state: 'Pressed' })
    expect(handler).toHaveBeenCalledOnce()

    pluginHandler({ shortcut: 'Ctrl+Alt+N', id: 1, state: 'Released' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('propagates errors from the plugin (chord conflict)', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    mockRegister.mockRejectedValueOnce(new Error('shortcut already registered'))

    await expect(registerGlobalShortcut('Ctrl+Alt+N', () => {})).rejects.toThrow(
      'shortcut already registered',
    )
  })

  it('is a no-op on mobile (Android user agent)', async () => {
    const { registerGlobalShortcut } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0',
    })
    try {
      await registerGlobalShortcut('Ctrl+Alt+N', () => {})
      expect(mockRegister).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})

describe('unregisterGlobalShortcut', () => {
  beforeEach(() => {
    mockUnregister.mockReset()
  })

  it('forwards the accelerator to the plugin', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    mockUnregister.mockResolvedValueOnce(undefined)

    await unregisterGlobalShortcut('Ctrl+Alt+N')

    expect(mockUnregister).toHaveBeenCalledOnce()
    expect(mockUnregister).toHaveBeenCalledWith('Ctrl+Alt+N')
  })

  it('propagates errors from the plugin', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    mockUnregister.mockRejectedValueOnce(new Error('not registered'))

    await expect(unregisterGlobalShortcut('Ctrl+Alt+N')).rejects.toThrow('not registered')
  })

  it('is a no-op on mobile (iPhone user agent)', async () => {
    const { unregisterGlobalShortcut } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    })
    try {
      await unregisterGlobalShortcut('Ctrl+Alt+N')
      expect(mockUnregister).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})

describe('isGlobalShortcutRegistered', () => {
  beforeEach(() => {
    mockIsRegistered.mockReset()
  })

  it('forwards the accelerator and returns the plugin response', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    mockIsRegistered.mockResolvedValueOnce(true)

    const result = await isGlobalShortcutRegistered('Ctrl+Alt+N')

    expect(mockIsRegistered).toHaveBeenCalledOnce()
    expect(mockIsRegistered).toHaveBeenCalledWith('Ctrl+Alt+N')
    expect(result).toBe(true)
  })

  it('propagates errors from the plugin', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    mockIsRegistered.mockRejectedValueOnce(new Error('plugin unavailable'))

    await expect(isGlobalShortcutRegistered('Ctrl+Alt+N')).rejects.toThrow('plugin unavailable')
  })

  it('returns false on mobile without invoking the plugin', async () => {
    const { isGlobalShortcutRegistered } = await importGlobalShortcutWrappers()
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0',
    })
    try {
      const result = await isGlobalShortcutRegistered('Ctrl+Alt+N')
      expect(mockIsRegistered).not.toHaveBeenCalled()
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => originalUA,
      })
    }
  })
})
