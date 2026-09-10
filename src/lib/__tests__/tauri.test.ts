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

import { createBlock, logFrontend, paginationLimit, searchBlocks } from '@/lib/tauri'

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

// `listBlocks` retired its `@/lib/tauri` wrapper (#4412) — call sites build the
// `ListBlocksRequest` DTO and pass the scope themselves; coverage lives there
// (`useDuePanelData`, `resolve`, `SpaceManageDialog`, `useQueryExecution`).

// The rest of `blocks.ts` — `createBlocksBatch`, `editBlock`, `deleteBlock`,
// `deleteBlocksByIds`, `moveBlocksToSpace`, `restoreBlock`, `purgeBlock`,
// `firstChildForBlocks`, `getBlock` and `listTrash` — retired its `@/lib/tauri`
// wrappers (#4411). All were bare `unwrap(await commands.X(…))` passthroughs
// except `listTrash`, whose only addition was `toSpaceScope`, now called at the
// call site. Coverage lives there: `TrashView`, `HistoryPanel`, `PageHeader`,
// `SavedViews`, `TagList`, `UnlinkedReferences`, `useAliasResolution`,
// `useSearchResults`, `useDeepLinkRouter`, `template-utils`,
// `PageBrowserBatchToolbar`. `createBlock` stays — it carries the H-3a
// page/space invariant and the #2849 client-ULID contract.

// The whole `properties.ts` domain module retired its `@/lib/tauri` wrappers
// (#4411) — `deleteProperty`, `getProperties`, `getProperty`,
// `getBatchProperties`, `setPropertyBatch`, `getPropertyDef` and
// `listPropertyDefs` were all bare passthroughs. Coverage lives at the call
// sites (`useBlockPropertyIpc`, `list-style`, `TagList`, `TemplatesView`,
// `SpaceManageDialog`, `StaticBlock`, `useAutocompleteSources`,
// `PageBrowserBatchToolbar`, `SavedViews`, `template-utils`).

// The whole `queries.ts` domain module retired its `@/lib/tauri` wrappers
// (#4411) — `runAdvancedQuery` was a bare passthrough; `listUndatedTasks`,
// `listProjectedAgenda` and `listUnfinishedTasks` only added `toSpaceScope`,
// now called at the call site. Coverage lives there (`useAdvancedQuery`,
// `useQueryExecution`, `agenda-filters`, `useDuePanelData`, `UnfinishedTasks`).

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
// `src-tauri/src/commands/queries.rs`).

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

// `setProperty` retired its `@/lib/tauri` wrapper (#4412). Its five fields
// carry `#[serde(default)]`, but the contract is all five present with exactly
// one non-null — an omitted key drops what was stored — so what replaces the
// wrapper is `check-set-property-args` (#3127), not the serde default.

// `queryByProperty` retired its `@/lib/tauri` wrapper (#4412) — call sites build
// the `QueryByPropertyRequest` DTO and pass the scope themselves.

// `listBacklinksGrouped` / `listUnlinkedReferences` retired their `@/lib/tauri`
// wrappers (#4411) — `useBacklinkGroups` / `useUnlinkedReferences` call
// `commands.*` directly. Their hook tests already drive the same
// `list_backlinks_grouped` / `list_unlinked_references` invokes by command
// name, so wire coverage is unchanged.

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
    await searchBlocks({ query: 'test', spaceId: 'TEST_SPACE_01' })
    await logFrontend('info', 'mod', 'msg')

    const commandNames = mockedInvoke.mock.calls.map((call) => call[0])
    expect(commandNames).toEqual(['create_block', 'search_blocks', 'log_frontend'])
  })
})
