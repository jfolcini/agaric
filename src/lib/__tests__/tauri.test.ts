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
  addAttachmentWithBytes,
  batchResolve,
  createBlock,
  createBlocksBatch,
  deleteBlock,
  deleteBlocksByIds,
  deleteProperty,
  editBlock,
  exportPageMarkdown,
  fetchLinkMetadata,
  filteredBlocksQuery,
  firstChildForBlocks,
  getBatchProperties,
  getBlock,
  getBlockHistory,
  getLinkMetadata,
  getPageAliases,
  getProperties,
  getProperty,
  getPropertyDef,
  listBacklinksGrouped,
  listBlocks,
  listBlocksLimit,
  listPageHistory,
  listPageLinks,
  listProjectedAgenda,
  listProjectedAgendaLimit,
  listPropertyDefs,
  listUndatedTasks,
  listUnlinkedReferences,
  logFrontend,
  paginationLimit,
  purgeBlock,
  purgeBlocksByIds,
  queryByProperty,
  redoPageOp,
  resolvePageByAlias,
  restoreBlock,
  restoreBlocksByIds,
  searchBlocks,
  setProperty,
  setPropertyBatch,
  undoPageOp,
} from '@/lib/tauri'

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
      index: 3,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: 'hello',
      parentId: 'PARENT01',
      index: 3,
      // H-3a + Phase 3: every `create_block` IPC call
      // carries the `scope` tagged-enum. For non-page block types
      // `{ kind: 'global' }` is correct (the backend ignores it).
      scope: { kind: 'global' },
      // #2849 PR2: `blockId` defaults to null (server mints the id) when the
      // caller does not supply a client-generated ULID for optimistic create.
      blockId: null,
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
      index: null,
      // H-3a + Phase 3: in production a page-typed
      // `createBlock` MUST pass an active scope; this unit test exercises
      // only the wrapper's payload shape, so `{ kind: 'global' }` here
      // documents that the wrapper forwards `undefined` → Global (the
      // backend will then surface `Validation` for a real call).
      scope: { kind: 'global' },
      // #2849 PR2: `blockId` defaults to null when no client id is supplied.
      blockId: null,
    })
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Validation error'))
    await expect(createBlock({ blockType: 'bad', content: '' })).rejects.toThrow('Validation error')
  })
})

// ---------------------------------------------------------------------------
// CreateBlocksBatch
// ---------------------------------------------------------------------------

describe('createBlocksBatch', () => {
  it('invokes create_blocks_batch with the spec list and returns rows in input order', async () => {
    const expected = [
      { id: 'BLK1', block_type: 'content', content: 'line 1' },
      { id: 'BLK2', block_type: 'content', content: 'line 2' },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    const specs = [
      {
        blockType: 'content',
        content: 'line 1',
        parentId: 'PARENT01',
        position: null,
        properties: {},
      },
      {
        blockType: 'content',
        content: 'line 2',
        parentId: 'PARENT01',
        position: null,
        properties: { project: 'agaric' },
      },
    ]
    const result = await createBlocksBatch(specs)

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('create_blocks_batch', { specs })
    expect(result).toEqual(expected)
  })

  it('propagates Validation errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('specs list cannot be empty'))
    await expect(createBlocksBatch([])).rejects.toThrow('specs list cannot be empty')
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

  // #4523 — the mirror of the `deleteBlocksByIds` pin below. The cascade can
  // trash PAGE descendants the caller never named, and the `[[` picker's
  // per-space cache needs their ids to stop offering them; pin that the
  // wrapper passes the field through rather than narrowing the reply back down
  // to the id it was called with.
  it('passes through page ids the caller never sent (cascade)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'ROOT',
      deleted_at: 1_700_000_000_000,
      descendants_affected: 3,
      affected_page_ids: ['ROOT', 'NESTED_PAGE'],
    })

    const result = await deleteBlock('ROOT')

    expect(result.affected_page_ids).toEqual(['ROOT', 'NESTED_PAGE'])
  })
})

// ---------------------------------------------------------------------------
// DeleteBlocksByIds
// ---------------------------------------------------------------------------

describe('deleteBlocksByIds', () => {
  it('invokes delete_blocks_by_ids with the full id list', async () => {
    mockedInvoke.mockResolvedValueOnce({ deleted_count: 7, affected_page_ids: ['BLK1'] })

    const result = await deleteBlocksByIds(['BLK1', 'BLK2', 'BLK3'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['BLK1', 'BLK2', 'BLK3'],
    })
    expect(result).toEqual({ deleted_count: 7, affected_page_ids: ['BLK1'] })
  })

  it('returns the BatchDeleteResponse unchanged', async () => {
    mockedInvoke.mockResolvedValueOnce({ deleted_count: 0, affected_page_ids: [] })
    expect(await deleteBlocksByIds(['MISSING'])).toEqual({
      deleted_count: 0,
      affected_page_ids: [],
    })
  })

  // #4480 — `affected_page_ids` is the reason this wrapper stopped returning a
  // bare number: the cascade can trash PAGE descendants the caller never sent,
  // and the `[[` picker's per-space cache needs their ids to stop offering
  // them. Pin that the wrapper passes the field through rather than collapsing
  // the reply back down to its count.
  it('passes through page ids the caller never sent (cascade)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      deleted_count: 3,
      affected_page_ids: ['ROOT', 'NESTED_PAGE'],
    })
    const result = await deleteBlocksByIds(['ROOT'])
    expect(result.affected_page_ids).toEqual(['ROOT', 'NESTED_PAGE'])
  })
})

// ---------------------------------------------------------------------------
// restoreBlock
// ---------------------------------------------------------------------------

describe('restoreBlock', () => {
  it('invokes restore_block with blockId and deletedAtRef', async () => {
    const expected = { block_id: 'BLK001', restored_count: 2 }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await restoreBlock('BLK001', 1736899200000)

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
      blockId: 'BLK001',
      deletedAtRef: 1736899200000,
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
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  it('invokes list_blocks with all nulls + the required active scope', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const result = await listBlocks({ spaceId: 'TEST_SPACE_01' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // #2277 item 7 — all query params marshal into a single `request` DTO;
    // `scope` stays a separate arg.
    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      request: {
        parentId: null,
        blockType: null,
        tagId: null,
        date: null,
        dateRange: null,
        source: null,
        cursor: null,
        limit: null,
      },
      // #2248 — spaceId is wrapped into an active SpaceScope via requireActiveScope.
      scope: { kind: 'active', space_id: 'TEST_SPACE_01' },
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
        },
      ],
      next_cursor: 'abc123',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await listBlocks({
      parentId: 'PARENT01',
      blockType: 'page',
      tagId: 'TAG01',
      agendaDate: '2025-01-15',
      cursor: 'cursor123',
      limit: listBlocksLimit(25),
      spaceId: 'TEST_SPACE_01',
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      request: {
        parentId: 'PARENT01',
        blockType: 'page',
        tagId: 'TAG01',
        date: '2025-01-15',
        dateRange: null,
        source: null,
        cursor: 'cursor123',
        limit: 25,
      },
      scope: { kind: 'active', space_id: 'TEST_SPACE_01' },
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults missing optional params to null (not undefined)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await listBlocks({ blockType: 'page', spaceId: 'TEST_SPACE_01' })

    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    // #2277 item 7 — query params live in the `request` DTO.
    const request = args['request'] as Record<string, unknown>
    // Tauri 2 requires null for Option<T>, not undefined
    expect(request['parentId']).toBeNull()
    expect(request['tagId']).toBeNull()
    // agenda params default to null on the IPC boundary when none are set
    expect(request['date']).toBeNull()
    expect(request['dateRange']).toBeNull()
    expect(request['source']).toBeNull()
    expect(request['cursor']).toBeNull()
    expect(request['limit']).toBeNull()
    // #2248 — `spaceId` is wrapped into an active SpaceScope.
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'TEST_SPACE_01' })
    // blockType should be the value we passed
    expect(request['blockType']).toBe('page')
  })

  it('wraps spaceId into an active SpaceScope on the wire (#2248)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await listBlocks({ spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })

  it('throws (requireActiveScope) on an empty spaceId without dispatching (#2248)', async () => {
    // There is no cross-space block listing: callers must short-circuit
    // locally when there is no active space rather than passing `''`.
    await expect(listBlocks({ spaceId: '' })).rejects.toThrow('empty space id')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// listUndatedTasks
// ---------------------------------------------------------------------------

describe('listUndatedTasks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  it('invokes list_undated_tasks with correct args', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    const result = await listUndatedTasks({ cursor: 'abc', limit: paginationLimit(10) })
    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_undated_tasks', {
      cursor: 'abc',
      limit: 10,
      // Phase 3: omitted spaceId → `SpaceScope::Global`.
      scope: { kind: 'global' },
    })
    expect(result).toEqual(emptyPage)
  })

  it('defaults optional params to null', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await listUndatedTasks()
    const callArgs = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(callArgs['cursor']).toBeNull()
    expect(callArgs['limit']).toBeNull()
    expect(callArgs['scope']).toEqual({ kind: 'global' })
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await listUndatedTasks({ spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
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
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getBlock('BLK001')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'BLK001' })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// searchBlocks
// ---------------------------------------------------------------------------

describe('searchBlocks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  // Phase 0 — the IPC payload is now a struct: `{ query, cursor, limit, filter }`
  // where `filter` carries the previously-positional `parentId`, `tagIds`, and
  // `spaceId`. The wrapper's public API stays flat — these tests verify the
  // marshalling at the IPC boundary.
  it('invokes search_blocks with default-shaped filter when no optional params given', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const result = await searchBlocks({ query: 'hello', spaceId: 'TEST_SPACE_01' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'hello',
      cursor: null,
      limit: null,
      filter: {
        parentId: null,
        tagIds: [],
        // #2248 c — the filter carries a `scope: SpaceScope`, not a bare id.
        scope: { kind: 'active', space_id: 'TEST_SPACE_01' },
        // Additive fields default to empty arrays.
        includePageGlobs: [],
        excludePageGlobs: [],
        // Additive toggle fields default to false.
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        // Additive `block_type_filter` defaults to null.
        blockTypeFilter: null,
        // Additive metadata fields default to empty / null.
        stateFilter: [],
        priorityFilter: [],
        dueFilter: null,
        scheduledFilter: null,
        propertyFilters: [],
        excludedPropertyFilters: [],
        excludedStateFilter: [],
        excludedPriorityFilter: [],
      },
    })
    expect(result).toEqual(emptyPage)
  })

  it('passes all optional parameters through into the filter struct', async () => {
    const pageResp = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'found',
          parent_id: null,
          position: null,
          deleted_at: null,
          snippet: null,
        },
      ],
      next_cursor: 'next123',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await searchBlocks({
      query: 'found',
      cursor: 'cursor123',
      limit: paginationLimit(25),
      spaceId: 'TEST_SPACE_01',
    })

    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'found',
      cursor: 'cursor123',
      limit: 25,
      filter: {
        parentId: null,
        tagIds: [],
        // #2248 c — the filter carries a `scope: SpaceScope`, not a bare id.
        scope: { kind: 'active', space_id: 'TEST_SPACE_01' },
        // Additive fields default to empty arrays.
        includePageGlobs: [],
        excludePageGlobs: [],
        // Additive toggle fields default to false.
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        // Additive `block_type_filter` defaults to null.
        blockTypeFilter: null,
        // Additive metadata fields default to empty / null.
        stateFilter: [],
        priorityFilter: [],
        dueFilter: null,
        scheduledFilter: null,
        propertyFilters: [],
        excludedPropertyFilters: [],
        excludedStateFilter: [],
        excludedPriorityFilter: [],
      },
    })
    expect(result).toEqual(pageResp)
  })

  it('wraps spaceId into an active scope inside `filter` (#2248 c)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await searchBlocks({ query: 'q', spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    const filter = args['filter'] as Record<string, unknown>
    expect(filter['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })

  it('marshals parentId and tagIds into the filter struct', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await searchBlocks({
      query: 'q',
      parentId: 'PAGE1',
      tagIds: ['TAG1', 'TAG2'],
      spaceId: 'SPACE_42',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'q',
      cursor: null,
      limit: null,
      filter: {
        parentId: 'PAGE1',
        tagIds: ['TAG1', 'TAG2'],
        // #2248 c — the filter carries a `scope: SpaceScope`, not a bare id.
        scope: { kind: 'active', space_id: 'SPACE_42' },
        // Additive fields default to empty arrays.
        includePageGlobs: [],
        excludePageGlobs: [],
        // Additive toggle fields default to false.
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        // Additive `block_type_filter` defaults to null.
        blockTypeFilter: null,
        // Additive metadata fields default to empty / null.
        stateFilter: [],
        priorityFilter: [],
        dueFilter: null,
        scheduledFilter: null,
        propertyFilters: [],
        excludedPropertyFilters: [],
        excludedStateFilter: [],
        excludedPriorityFilter: [],
      },
    })
  })
})

// ---------------------------------------------------------------------------
// queryByTags
// ---------------------------------------------------------------------------

// `queryByTags` retired its `@/lib/tauri` wrapper (#4411); its invoke-shape
// coverage now lives at its call sites (e.g. `useAdvancedQuery`, TagList).

// ---------------------------------------------------------------------------
// FilteredBlocksQuery
// ---------------------------------------------------------------------------

describe('filteredBlocksQuery', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  it('marshals propertyFilters into the camelCase IPC shape', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await filteredBlocksQuery({
      propertyFilters: [
        { key: 'priority', valueText: '1', operator: 'eq' },
        {
          key: 'due_date',
          valueDateRange: ['2026-01-01', '2026-02-01'],
        },
      ],
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    const [cmd, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('filtered_blocks_query')
    const filters = args['propertyFilters'] as Array<Record<string, unknown>>
    expect(filters).toHaveLength(2)
    expect(filters[0]).toMatchObject({
      key: 'priority',
      valueText: '1',
      operator: 'eq',
    })
    expect(filters[0]?.['valueTextIn']).toEqual([])
    expect(filters[1]?.['key']).toBe('due_date')
    expect(filters[1]?.['valueDateRange']).toEqual(['2026-01-01', '2026-02-01'])
    expect(args['tagFilters']).toBeNull()
    expect(args['blockType']).toBeNull()
    expect(args['scope']).toEqual({ kind: 'global' })
  })

  it('marshals tagFilters into the camelCase IPC shape with defaults', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await filteredBlocksQuery({
      tagFilters: { prefixes: ['project/'] },
    })

    const [, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    const tagFilters = args['tagFilters'] as Record<string, unknown>
    expect(tagFilters).toMatchObject({
      tagIds: [],
      prefixes: ['project/'],
      mode: 'or',
      includeInherited: false,
    })
  })

  it('forwards blockType, spaceId, cursor, limit verbatim', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await filteredBlocksQuery({
      propertyFilters: [{ key: 'k', valueText: 'v' }],
      blockType: 'page',
      spaceId: 'SPACE_42',
      cursor: 'CURSOR123',
      limit: paginationLimit(25),
    })

    const [, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(args['blockType']).toBe('page')
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
    expect(args['cursor']).toBe('CURSOR123')
    expect(args['limit']).toBe(25)
  })

  it('round-trips PageResponse from invoke', async () => {
    const payload = {
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'matched',
          parent_id: null,
          position: null,
          deleted_at: null,
        },
      ],
      next_cursor: 'next123',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(payload)

    const result = await filteredBlocksQuery({
      propertyFilters: [{ key: 'priority', valueText: '1' }],
    })
    expect(result).toEqual(payload)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('filter failed'))
    await expect(
      filteredBlocksQuery({ propertyFilters: [{ key: 'k', valueText: 'v' }] }),
    ).rejects.toThrow('filter failed')
  })
})

// ---------------------------------------------------------------------------
// listTagsByPrefix
// ---------------------------------------------------------------------------

// `listTagsByPrefix` retired its `@/lib/tauri` wrapper (#4411); its
// invoke-shape coverage now lives at its call sites.

// ---------------------------------------------------------------------------
// batchResolve
// ---------------------------------------------------------------------------

describe('batchResolve', () => {
  it("invokes batch_resolve with ids and a global scope for the explicit 'global' opt-in", async () => {
    const expected = [
      { id: 'B1', title: 'Block 1', block_type: 'content', deleted: false },
      { id: 'B2', title: null, block_type: 'page', deleted: true },
    ]
    mockedInvoke.mockResolvedValueOnce(expected)

    // #2300 — the scope arg is now REQUIRED; cross-space callers must
    // spell out `'global'` (the old silent-omission default is gone).
    const result = await batchResolve(['B1', 'B2'], 'global')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // + Phase 3 — wrapper always forwards a `scope`;
    // `{ kind: 'global' }` for the explicit `'global'` opt-in.
    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', {
      ids: ['B1', 'B2'],
      scope: { kind: 'global' },
    })
    expect(result).toEqual(expected)
  })

  it('forwards a space ULID scope as an active scope (+  Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    await batchResolve(['B1'], 'SPACE_X')

    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', {
      ids: ['B1'],
      scope: { kind: 'active', space_id: 'SPACE_X' },
    })
  })
})

// ---------------------------------------------------------------------------
// getBlockHistory
// ---------------------------------------------------------------------------

describe('getBlockHistory', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  it('invokes get_block_history with all parameters', async () => {
    const pageResp = {
      items: [{ op_type: 'edit', seq: 1, device_id: 'dev1', timestamp: '2025-01-15T00:00:00Z' }],
      next_cursor: 'next1',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await getBlockHistory({
      blockId: 'BLK001',
      cursor: 'cur1',
      limit: paginationLimit(5),
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
      blockId: 'BLK001',
      opTypeFilter: null,
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
      opTypeFilter: null,
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

// `getStatus` retired its `@/lib/tauri` wrapper (#4411); it's a bare
// no-arg passthrough (`unwrap(await commands.getStatus())`), covered at its
// call site.

// ---------------------------------------------------------------------------
// setProperty
// ---------------------------------------------------------------------------

describe('setProperty', () => {
  it('invokes set_property with all value fields bundled under `value`', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await setProperty({
      blockId: 'BLK001',
      key: 'priority',
      valueText: 'high',
      valueNum: 1,
      valueDate: '2025-01-15',
      valueRef: 'REF001',
      valueBool: true,
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // Typed values are bundled under `value: SetPropertyArgs` so the
    // IPC stays under specta's 10-positional-argument cap.
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLK001',
      key: 'priority',
      value: {
        value_text: 'high',
        value_num: 1,
        value_date: '2025-01-15',
        value_ref: 'REF001',
        value_bool: true,
      },
    })
  })

  it('defaults optional value fields to null', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)

    await setProperty({ blockId: 'BLK001', key: 'status' })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLK001',
      key: 'status',
      value: {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
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
// GetProperty
// ---------------------------------------------------------------------------

describe('getProperty', () => {
  it('invokes get_property with blockId + key and unwraps the row', async () => {
    const expected = {
      key: 'image_width',
      value_text: '50',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getProperty('BLK001', 'image_width')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
      blockId: 'BLK001',
      key: 'image_width',
    })
    expect(result).toEqual(expected)
  })

  it('returns null when the backend has no row for (blockId, key)', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await getProperty('BLK001', 'journal_template')

    expect(result).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
      blockId: 'BLK001',
      key: 'journal_template',
    })
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
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  it('invokes list_page_history with all parameters', async () => {
    const pageResp = {
      items: [{ op_type: 'edit', seq: 1, device_id: 'dev1', timestamp: '2025-01-15T00:00:00Z' }],
      next_cursor: 'next1',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await listPageHistory({
      pageId: 'PAGE1',
      opTypeFilter: 'edit_block',
      cursor: 'cur1',
      limit: paginationLimit(20),
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
      pageId: 'PAGE1',
      opTypeFilter: 'edit_block',
      // + Phase 3: `scope` is threaded through every
      // history call; `{ kind: 'global' }` here means "all spaces"
      // since this test doesn't pass a spaceId.
      scope: { kind: 'global' },
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
      // + Phase 3: `scope` defaults to
      // `{ kind: 'global' }` (= all spaces) when the caller omits
      // spaceId, matching the other optional knobs.
      scope: { kind: 'global' },
      cursor: null,
      limit: null,
    })
  })
})

// ---------------------------------------------------------------------------
// queryByProperty
// ---------------------------------------------------------------------------

describe('queryByProperty', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

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
        },
      ],
      next_cursor: 'next1',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(pageResp)

    const result = await queryByProperty({
      key: 'status',
      valueText: 'done',
      cursor: 'cur1',
      limit: paginationLimit(10),
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // #2277 item 7 — all query params (key/value/operator, pagination, and
    // the push-down knobs) marshal into a single `request` DTO; unset
    // push-down knobs default to null inside the request. `scope` stays a
    // separate arg.
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      request: {
        key: 'status',
        valueText: 'done',
        valueDate: null,
        operator: null,
        cursor: 'cur1',
        limit: 10,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: null,
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: { kind: 'global' },
    })
    expect(result).toEqual(pageResp)
  })

  it('defaults optional valueText, cursor, limit to null and scope to global', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await queryByProperty({ key: 'status' })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      request: {
        key: 'status',
        valueText: null,
        valueDate: null,
        operator: null,
        cursor: null,
        limit: null,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: null,
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: { kind: 'global' },
    })
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await queryByProperty({ key: 'status', spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })

  // Push-down filters reach the binding as fields of the `request` DTO.
  it('forwards excludeParentId and contentNonEmpty into request', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await queryByProperty({
      key: 'completed_at',
      valueDate: '2026-05-08',
      excludeParentId: 'PAGE_1',
      contentNonEmpty: true,
    })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    const request = args['request'] as Record<string, unknown>
    expect(request['excludeParentId']).toBe('PAGE_1')
    expect(request['contentNonEmpty']).toBe(true)
    expect(request['blockType']).toBeNull()
    expect(request['valueTextIn']).toBeNull()
    expect(request['valueDateRange']).toBeNull()
  })

  // Block_type / valueTextIn / valueDateRange
  // round-trip through the `request` DTO.
  it('forwards blockType / valueTextIn / valueDateRange into request', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await queryByProperty({
      key: 'status',
      blockType: 'page',
      valueTextIn: ['TODO', 'DOING'],
      valueDateRange: ['2026-01-01', '2026-02-01'],
    })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    const request = args['request'] as Record<string, unknown>
    expect(request['blockType']).toBe('page')
    expect(request['valueTextIn']).toEqual(['TODO', 'DOING'])
    expect(request['valueDateRange']).toEqual(['2026-01-01', '2026-02-01'])
    // Tier 1.5 knobs default-null inside the request when not supplied.
    expect(request['excludeParentId']).toBeNull()
    expect(request['contentNonEmpty']).toBeNull()
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

// `listPeerRefs` retired its `@/lib/tauri` wrapper (#4411); `startSync`
// moved to `@/lib/ipc-helpers` (#4413, real Channel logic) — both now
// covered in `ipc-helpers.test.ts` / at their call sites.

// ---------------------------------------------------------------------------
// Thin fixed-field commands (setPropertyBatch)
//
// #2927 — the setTodoState / setTodoStateBatch / setPriority / setDueDate /
// setScheduledDate wrappers were deleted along with the whole tasks domain
// module; their call sites now invoke `commands.*` directly and are covered by
// their own suites (useBlockReschedule, useCheckboxSyntax, DateChipEditor).
// ---------------------------------------------------------------------------

describe('thin fixed-field commands', () => {
  it('setPropertyBatch passes the id list + key + value through to set_property_batch', async () => {
    mockedInvoke.mockResolvedValueOnce(3)

    const result = await setPropertyBatch(['B1', 'B2', 'B3'], 'todo_state', 'DONE')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('set_property_batch', {
      blockIds: ['B1', 'B2', 'B3'],
      key: 'todo_state',
      value: 'DONE',
    })
    expect(result).toBe(3)
  })

  it('setPropertyBatch sends null value to clear', async () => {
    mockedInvoke.mockResolvedValueOnce(2)

    await setPropertyBatch(['B1', 'B2'], 'due_date', null)

    expect(mockedInvoke).toHaveBeenCalledWith('set_property_batch', {
      blockIds: ['B1', 'B2'],
      key: 'due_date',
      value: null,
    })
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
      scope: { kind: 'global' },
    })
    expect(result).toEqual(emptyResponse)
  })

  it('passes filters and sort when provided', async () => {
    const filters = [{ type: 'Contains' as const, query: 'hello' }]
    const sort = { type: 'Created' as const, dir: 'Desc' as const }
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await listBacklinksGrouped({
      blockId: 'PAGE1',
      filters,
      sort,
      cursor: 'cur1',
      limit: paginationLimit(10),
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_backlinks_grouped', {
      blockId: 'PAGE1',
      filters,
      sort,
      cursor: 'cur1',
      limit: 10,
      scope: { kind: 'global' },
    })
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)
    await listBacklinksGrouped({ blockId: 'PAGE1', spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
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
      scope: { kind: 'global' },
    })
    expect(result).toEqual(emptyResponse)
  })

  it('passes cursor and limit when provided', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)

    await listUnlinkedReferences({ pageId: 'PAGE1', cursor: 'cur1', limit: paginationLimit(20) })

    expect(mockedInvoke).toHaveBeenCalledWith('list_unlinked_references', {
      pageId: 'PAGE1',
      filters: null,
      sort: null,
      cursor: 'cur1',
      limit: 20,
      scope: { kind: 'global' },
    })
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyResponse)
    await listUnlinkedReferences({ pageId: 'PAGE1', spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })
})

// ---------------------------------------------------------------------------
// listPropertyDefs
// ---------------------------------------------------------------------------

describe('listPropertyDefs', () => {
  it('invokes list_property_defs with cursor + limit and returns the PageResponse envelope', async () => {
    // `list_property_defs` is now cursor-paginated.
    const defs = [
      {
        key: 'status',
        value_type: 'select',
        options: '["todo","done"]',
        created_at: '2025-01-15T00:00:00Z',
      },
    ]
    const expected = { items: defs, next_cursor: null, has_more: false }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPropertyDefs()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
      cursor: null,
      limit: null,
    })
    expect(result).toEqual(expected)
  })

  it('forwards explicit cursor + limit to the IPC layer', async () => {
    const expected = { items: [], next_cursor: 'next-page-cursor', has_more: true }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPropertyDefs({ cursor: 'opaque-cursor', limit: paginationLimit(10) })

    expect(mockedInvoke).toHaveBeenCalledWith('list_property_defs', {
      cursor: 'opaque-cursor',
      limit: 10,
    })
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// GetPropertyDef
// ---------------------------------------------------------------------------

describe('getPropertyDef', () => {
  it('invokes get_property_def with the requested key and unwraps the row', async () => {
    const expected = {
      key: 'priority',
      value_type: 'select',
      options: '["1","2","3"]',
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await getPropertyDef('priority')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('get_property_def', { key: 'priority' })
    expect(result).toEqual(expected)
  })

  it('returns null when the backend has no row for the key', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await getPropertyDef('nope')

    expect(result).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('get_property_def', { key: 'nope' })
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

    const result = await resolvePageByAlias({ alias: 'my-alias' })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('resolve_page_by_alias', {
      alias: 'my-alias',
      scope: { kind: 'global' },
    })
    expect(result).toEqual(expected)
  })

  it('returns null when alias not found', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    const result = await resolvePageByAlias({ alias: 'nonexistent' })

    expect(mockedInvoke).toHaveBeenCalledWith('resolve_page_by_alias', {
      alias: 'nonexistent',
      scope: { kind: 'global' },
    })
    expect(result).toBeNull()
  })

  it('forwards spaceId as an active scope when supplied', async () => {
    mockedInvoke.mockResolvedValueOnce(null)

    await resolvePageByAlias({ alias: 'shared', spaceId: 'SPACE_A' })

    expect(mockedInvoke).toHaveBeenCalledWith('resolve_page_by_alias', {
      alias: 'shared',
      scope: { kind: 'active', space_id: 'SPACE_A' },
    })
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

// `restoreAllDeletedInSpace` / `purgeAllDeletedInSpace` moved to
// `@/lib/ipc-helpers` (#4413, the migration floor — a ~120-LOC chunked
// drain, not a passthrough); their coverage now lives in
// `ipc-helpers.test.ts` verbatim.

// ---------------------------------------------------------------------------
// RestoreBlocksByIds / purgeBlocksByIds
// ---------------------------------------------------------------------------

describe('restoreBlocksByIds', () => {
  it('invokes restore_blocks_by_ids with the id list and returns affected_count', async () => {
    mockedInvoke.mockResolvedValueOnce({ affected_count: 3 })

    const result = await restoreBlocksByIds(['B1', 'B2', 'B3'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['B1', 'B2', 'B3'],
    })
    expect(result).toBe(3)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(restoreBlocksByIds(['X'])).rejects.toThrow('db error')
  })
})

describe('purgeBlocksByIds', () => {
  it('invokes purge_blocks_by_ids with the id list and returns affected_count', async () => {
    mockedInvoke.mockResolvedValueOnce({ affected_count: 5 })

    const result = await purgeBlocksByIds(['B1', 'B2', 'B3', 'B4', 'B5'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('purge_blocks_by_ids', {
      blockIds: ['B1', 'B2', 'B3', 'B4', 'B5'],
    })
    expect(result).toBe(5)
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(purgeBlocksByIds(['X'])).rejects.toThrow('db error')
  })
})

// ---------------------------------------------------------------------------
// FirstChildForBlocks
// ---------------------------------------------------------------------------

describe('firstChildForBlocks', () => {
  it('invokes first_child_for_blocks with the blockIds array', async () => {
    const expected = {
      T1: {
        id: 'C1',
        block_type: 'content',
        content: 'first child of T1',
        parent_id: 'T1',
        position: 0,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      },
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await firstChildForBlocks(['T1', 'T2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('first_child_for_blocks', {
      blockIds: ['T1', 'T2'],
    })
    expect(result).toEqual(expected)
  })

  it('round-trips an empty array as an empty record', async () => {
    mockedInvoke.mockResolvedValueOnce({})

    const result = await firstChildForBlocks([])

    expect(mockedInvoke).toHaveBeenCalledWith('first_child_for_blocks', { blockIds: [] })
    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// listProjectedAgenda
// ---------------------------------------------------------------------------

describe('listProjectedAgenda', () => {
  it('invokes list_projected_agenda with all parameters', async () => {
    // Response is now a cursor-paginated `PageResponse`.
    const expected = {
      items: [
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
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listProjectedAgenda({
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      limit: listProjectedAgendaLimit(50),
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('list_projected_agenda', {
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      cursor: null,
      limit: 50,
      scope: { kind: 'global' },
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional cursor, limit to null and scope to global', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await listProjectedAgenda({ startDate: '2025-01-15', endDate: '2025-02-15' })

    expect(mockedInvoke).toHaveBeenCalledWith('list_projected_agenda', {
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      cursor: null,
      limit: null,
      scope: { kind: 'global' },
    })
  })

  it('forwards an explicit cursor for page-2 fetches', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await listProjectedAgenda({
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      cursor: 'OPAQUE_CURSOR',
      limit: listProjectedAgendaLimit(25),
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_projected_agenda', {
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      cursor: 'OPAQUE_CURSOR',
      limit: 25,
      scope: { kind: 'global' },
    })
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    await listProjectedAgenda({
      startDate: '2025-01-15',
      endDate: '2025-02-15',
      spaceId: 'SPACE_42',
    })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })
})

// ---------------------------------------------------------------------------
// listPageLinks
// ---------------------------------------------------------------------------

describe('listPageLinks', () => {
  it('invokes list_page_links with no arguments', async () => {
    // #2298 count-then-cap — the command now ships a `PageLinksResponse`
    // envelope (edges + true total + truncated flag), not a bare array.
    const expected = {
      edges: [
        { source_id: 'PAGE1', target_id: 'PAGE2', ref_count: 3 },
        { source_id: 'PAGE2', target_id: 'PAGE3', ref_count: 1 },
      ],
      total: 2,
      truncated: false,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPageLinks()

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // `tagIds: null` is forwarded so the backend's
    // `(?2 IS NULL OR …)` short-circuit evaluates to TRUE, preserving
    // the pre-Tier-4.5 unfiltered behaviour.
    expect(mockedInvoke).toHaveBeenCalledWith('list_page_links', {
      scope: { kind: 'global' },
      tagIds: null,
    })
    expect(result).toEqual(expected)
  })

  it('returns an empty envelope when no links exist', async () => {
    mockedInvoke.mockResolvedValueOnce({ edges: [], total: 0, truncated: false })

    const result = await listPageLinks()

    expect(result).toEqual({ edges: [], total: 0, truncated: false })
  })

  it('surfaces the truncated flag and true total when the edge cap fired (#2298)', async () => {
    const expected = {
      edges: [{ source_id: 'PAGE1', target_id: 'PAGE2', ref_count: 3 }],
      total: 5000,
      truncated: true,
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await listPageLinks()

    expect(result).toEqual(expected)
  })

  it('forwards spaceId as an active scope to the binding (Phase 3)', async () => {
    mockedInvoke.mockResolvedValueOnce({ edges: [], total: 0, truncated: false })
    await listPageLinks('SPACE_42')
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
    expect(args['tagIds']).toBeNull()
  })

  it('forwards tagIds when provided via the param-object shape', async () => {
    mockedInvoke.mockResolvedValueOnce({ edges: [], total: 0, truncated: false })
    await listPageLinks({ spaceId: 'SPACE_42', tagIds: ['TAG_A', 'TAG_B'] })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
    expect(args['tagIds']).toEqual(['TAG_A', 'TAG_B'])
  })

  it('normalises an empty tagIds array to null', async () => {
    mockedInvoke.mockResolvedValueOnce({ edges: [], total: 0, truncated: false })
    await listPageLinks({ spaceId: 'SPACE_42', tagIds: [] })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args['tagIds']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// addAttachmentWithBytes
// ---------------------------------------------------------------------------

describe('addAttachmentWithBytes', () => {
  it('invokes add_attachment_with_bytes with raw bytes', async () => {
    const expected = {
      id: 'ATT1',
      block_id: 'BLK001',
      filename: 'doc.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      fs_path: 'attachments/ATT1',
      created_at: '2025-01-15T00:00:00Z',
    }
    mockedInvoke.mockResolvedValueOnce(expected)

    const result = await addAttachmentWithBytes({
      blockId: 'BLK001',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3, 255]),
    })

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('add_attachment_with_bytes', {
      blockId: 'BLK001',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      bytes: [1, 2, 3, 255],
    })
    expect(result).toEqual(expected)
  })
})

// `readAttachment` (sanctioned raw invoke) and `importMarkdown` (Channel
// plumbing) moved to `@/lib/ipc-helpers` (#4413, the migration floor); their
// coverage now lives in `ipc-helpers.test.ts` verbatim.

// `saveDraft` / `flushAllDrafts` / `deleteDraft` retired their `@/lib/tauri`
// wrappers (#4411) — all three are bare passthroughs, covered at their call
// sites (`useDraftAutosave`, `EditableBlock`, `useSyncTrigger`, `App`'s boot
// recovery).

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
// fetchLinkMetadata
// ---------------------------------------------------------------------------

describe('fetchLinkMetadata', () => {
  it('invokes fetch_link_metadata with url', async () => {
    const expected = {
      url: 'https://example.com',
      title: 'Example',
      favicon_url: 'https://example.com/favicon.ico',
      description: 'An example site',
      fetched_at: 1736899200000, // 2025-01-15T00:00:00Z
      auth_required: false,
      not_found: false,
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
      fetched_at: 1736899200000, // 2025-01-15T00:00:00Z
      auth_required: false,
      not_found: false,
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

// `listSpaces` / `createPageInSpace` retired their `@/lib/tauri` wrappers
// (#4411) — the whole `system.ts` domain module graduated in one step
// (`getStatus`, `listSpaces`, `createPageInSpace`, `createSpace`). Coverage
// now lives at their call sites (`useSpaceStore`, `WelcomeModal`, etc.).

// ---------------------------------------------------------------------------
// Cross-cutting concerns
// ---------------------------------------------------------------------------

describe('cross-cutting', () => {
  it('all wrappers use snake_case command names matching Rust', async () => {
    mockedInvoke.mockResolvedValue({})

    await createBlock({ blockType: 'content', content: '' })
    await editBlock('id', 'text')
    await deleteBlock('id')
    await restoreBlock('id', 0)
    await purgeBlock('id')
    await listBlocks({ spaceId: 'TEST_SPACE_01' })
    await getBlock('id')
    await batchResolve(['id'], 'global')
    await getBlockHistory({ blockId: 'id' })
    await searchBlocks({ query: 'test', spaceId: 'TEST_SPACE_01' })
    await setProperty({ blockId: 'id', key: 'k' })
    await deleteProperty('id', 'k')
    await getProperties('id')
    await getProperty('id', 'k')
    await getBatchProperties(['id'])
    await listPageHistory({ pageId: 'id' })
    await queryByProperty({ key: 'k' })
    await undoPageOp({ pageId: 'id', undoDepth: 1 })
    await redoPageOp({ undoDeviceId: 'd', undoSeq: 1 })
    await listBacklinksGrouped({ blockId: 'id' })
    await listUnlinkedReferences({ pageId: 'id' })
    await getPropertyDef('k')
    await listPropertyDefs()
    await getPageAliases('id')
    await resolvePageByAlias({ alias: 'alias' })
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
      'get_block_history',
      'search_blocks',
      'set_property',
      'delete_property',
      'get_properties',
      'get_property',
      'get_batch_properties',
      'list_page_history',
      'query_by_property',
      'undo_page_op',
      'redo_page_op',
      'list_backlinks_grouped',
      'list_unlinked_references',
      'get_property_def',
      'list_property_defs',
      'get_page_aliases',
      'resolve_page_by_alias',
      'export_page_markdown',
    ])
  })
})
