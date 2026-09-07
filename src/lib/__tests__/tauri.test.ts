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
  createBlock,
  createBlocksBatch,
  deleteBlock,
  deleteBlocksByIds,
  deleteProperty,
  editBlock,
  firstChildForBlocks,
  getBatchProperties,
  getBlock,
  getProperties,
  getProperty,
  getPropertyDef,
  listProjectedAgenda,
  listProjectedAgendaLimit,
  listPropertyDefs,
  listUndatedTasks,
  logFrontend,
  paginationLimit,
  purgeBlock,
  restoreBlock,
  searchBlocks,
  setPropertyBatch,
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

// `listBlocks` retired its `@/lib/tauri` wrapper (#4412) — call sites build the
// `ListBlocksRequest` DTO and pass the scope themselves; coverage lives there
// (`useDuePanelData`, `resolve`, `SpaceManageDialog`, `useQueryExecution`).

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

// `filteredBlocksQuery` retired its `@/lib/tauri` wrapper (#4412) — its
// `?? []` / `?? 'eq'` / `?? 'or'` / `?? false` defaults are the backend's own
// serde defaults (`PropertyFilter` / `TagFilterExpr` in
// `src-tauri/src/commands/queries.rs`), pinned by `wrapper-default-parity.test.ts`.

// ---------------------------------------------------------------------------
// listTagsByPrefix
// ---------------------------------------------------------------------------

// `listTagsByPrefix` retired its `@/lib/tauri` wrapper (#4411); its
// invoke-shape coverage now lives at its call sites.

// `batchResolve` retired its `@/lib/tauri` wrapper (#4412) — call sites build
// the `SpaceScope` themselves; coverage lives there (`useSearchResults`,
// `DonePanel`, `resolve`, …).

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

// `getStatus` retired its `@/lib/tauri` wrapper (#4411); it's a bare
// no-arg passthrough (`unwrap(await commands.getStatus())`), covered at its
// call site.

// `setProperty` retired its `@/lib/tauri` wrapper (#4412) — every
// `SetPropertyArgs` field carries `#[serde(default)]`, so an omitted field and
// the wrapper's `?? null` are the same `None`; pinned by
// `wrapper-default-parity.test.ts`.

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

// `queryByProperty` retired its `@/lib/tauri` wrapper (#4412) — call sites build
// the `QueryByPropertyRequest` DTO and pass the scope themselves.

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

// `listBacklinksGrouped` / `listUnlinkedReferences` retired their `@/lib/tauri`
// wrappers (#4411) — `useBacklinkGroups` / `useUnlinkedReferences` call
// `commands.*` directly. Their hook tests already drive the same
// `list_backlinks_grouped` / `list_unlinked_references` invokes by command
// name, so wire coverage is unchanged.

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

// `restoreAllDeletedInSpace` / `purgeAllDeletedInSpace` moved to
// `@/lib/ipc-helpers` (#4413, the migration floor — a ~120-LOC chunked
// drain, not a passthrough); their coverage now lives in
// `ipc-helpers.test.ts` verbatim.

// `restoreBlocksByIds` / `purgeBlocksByIds` retired their `@/lib/tauri`
// wrappers (#4412, RESHAPE — they only read `.affected_count` off the DTO).
// Coverage now lives at the call sites: `TrashView.test.tsx` asserts both
// batch paths fire exactly ONE IPC and render the returned count, and
// `ipc-helpers.test.ts` covers the chunked drains, which already called
// `commands.*` directly.

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

// `listPageLinks` retired its `@/lib/tauri` wrapper (#4411, SCOPE —
// `toSpaceScope` only) — coverage now lives at its call site
// (`GraphView.helpers.test.ts`).

// `addAttachmentWithBytes` retired its `@/lib/tauri` wrapper (#4411, PURE
// passthrough) — coverage now lives at its call sites (`EditableBlock.test.tsx`,
// `PdfViewerDialog.test.tsx`).

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

// `fetchLinkMetadata` / `getLinkMetadata` retired their `@/lib/tauri` wrappers
// (#4411, the whole link-metadata pair) — `useLinkMetadata` / `useLinkPreview`
// call `commands.*` directly and coverage lives in their hook tests.

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
    await getBlock('id')
    await searchBlocks({ query: 'test', spaceId: 'TEST_SPACE_01' })
    await deleteProperty('id', 'k')
    await getProperties('id')
    await getProperty('id', 'k')
    await getBatchProperties(['id'])
    await getPropertyDef('k')
    await listPropertyDefs()

    const commandNames = mockedInvoke.mock.calls.map((call) => call[0])
    expect(commandNames).toEqual([
      'create_block',
      'edit_block',
      'delete_block',
      'restore_block',
      'purge_block',
      'get_block',
      'search_blocks',
      'delete_property',
      'get_properties',
      'get_property',
      'get_batch_properties',
      'get_property_def',
      'list_property_defs',
    ])
  })
})
