/**
 * Tests for src/lib/ipc-helpers.ts — the permanent floor under `bindings.ts`
 * (#2927): functions that carry real logic (Channel plumbing, a chunked
 * drain, a client-side abort bridge, a scope default the wire does not have,
 * the explicit-null coercion, the sanctioned raw-`invoke` seam) and so can't
 * collapse to a bare `commands.*` call site.
 *
 * Each wrapper is checked for the same four things: the snake_case Rust
 * command name, camelCase argument keys (Tauri 2 convention), `null` — never
 * `undefined` — for optional `Option<T>` parameters, and the invoke value
 * returned unchanged.
 *
 * These describe blocks were moved verbatim (import path only) from the
 * per-wrapper test files that died with the hand-written wrapper layer.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import { type CommandReturns, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { type AppError, isCancellation } from '@/lib/app-error'
import {
  cancelledError,
  createBlock,
  importMarkdown,
  logFrontend,
  MAX_TRASH_BATCH_IDS,
  PartialPurgeError,
  purgeAllDeletedInSpace,
  readAttachment,
  restoreAllDeletedInSpace,
  searchBlocks,
  startSync,
  withAbort,
} from '@/lib/ipc-helpers'
import { paginationLimit } from '@/lib/safe-limit'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * One `list_trash` page. The command answers `PageResponse<BlockRow>` — full
 * rows and a `total_count` — even though the drain below only reads `id`.
 */
function trashPage(ids: string[], nextCursor: string | null = null): CommandReturns['list_trash'] {
  return {
    items: ids.map((id) => makeBlockRow({ id })),
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    total_count: null,
  }
}

// ---------------------------------------------------------------------------
// Client-side abort plumbing (no IPC)
// ---------------------------------------------------------------------------

describe('cancelledError', () => {
  it('returns the AppError shape isCancellation recognises', () => {
    const err = cancelledError()
    expect(err).toEqual({ kind: 'cancelled', message: 'aborted client-side' })
    expect(isCancellation(err)).toBe(true)
  })

  it('threads the supplied reason into the message', () => {
    const err = cancelledError('user closed palette')
    expect(err.message).toBe('user closed palette')
    expect(isCancellation(err)).toBe(true)
  })
})

describe('withAbort', () => {
  it('resolves with the promise value when signal never fires', async () => {
    const ctrl = new AbortController()
    await expect(withAbort(Promise.resolve('ok'), ctrl.signal)).resolves.toBe('ok')
  })

  it('forwards rejection from the underlying promise', async () => {
    const ctrl = new AbortController()
    await expect(withAbort(Promise.reject(new Error('boom')), ctrl.signal)).rejects.toThrow('boom')
  })

  it('rejects with a cancelled-kind AppError when signal aborts mid-flight', async () => {
    const ctrl = new AbortController()
    let resolveLater: (v: string) => void = () => {}
    const pending = new Promise<string>((res) => {
      resolveLater = res
    })
    const wrapped = withAbort(pending, ctrl.signal)
    ctrl.abort('palette closed')
    await expect(wrapped).rejects.toMatchObject({ kind: 'cancelled' })
    // Resolving after abort must not throw — wrapper's `onAbort` already
    // settled the outer promise.
    resolveLater('late')
  })

  it('short-circuits when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort('already aborted')
    const wrapped = withAbort(Promise.resolve('never seen'), ctrl.signal)
    await expect(wrapped).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('passes through unchanged when signal is undefined', async () => {
    await expect(withAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
  })

  it('rejected value passes isCancellation predicate', async () => {
    const ctrl = new AbortController()
    const wrapped = withAbort(new Promise(() => {}), ctrl.signal)
    ctrl.abort()
    try {
      await wrapped
      throw new Error('should have rejected')
    } catch (err) {
      expect(isCancellation(err)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// startSync
// ---------------------------------------------------------------------------

describe('startSync', () => {
  it('invokes start_sync with peerId and a Channel<SyncProgressUpdate>', async () => {
    const expected = {
      state: 'syncing',
      local_device_id: 'local',
      remote_device_id: 'peer-1',
      ops_received: 0,
      ops_sent: 0,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ start_sync: () => expected }))
    const result = await startSync('peer-1')
    expect(result).toEqual(expected)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'start_sync',
      expect.objectContaining({ peerId: 'peer-1', progress: expect.anything() }),
    )
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ start_sync: () => Promise.reject(new Error('peer unreachable')) }),
    )
    await expect(startSync('peer-1')).rejects.toThrow('peer unreachable')
  })
})

// ---------------------------------------------------------------------------
// readAttachment
// ---------------------------------------------------------------------------

// The one hand-stubbed pair left in this file, and the reason the ratchet
// (`src/__tests__/hand-stub-ratchet.test.ts`) lists it as a deliberate
// exception: `read_attachment` answers a raw-byte `tauri::ipc::Response`,
// which carries no `specta::Type`, so it has no generated binding and is not
// a key of `CommandReturns` — there is nothing for the typed seam to check.
describe('readAttachment', () => {
  it('invokes read_attachment and decodes the ArrayBuffer response to a Uint8Array', async () => {
    // #2654: read_attachment returns a raw-byte tauri::ipc::Response, so
    // `invoke` resolves an ArrayBuffer (not a JSON number[]). The wrapper must
    // wrap it with `new Uint8Array(buffer)` — NOT `Uint8Array.from`, which
    // would yield an empty array for a non-iterable ArrayBuffer.
    const source = new Uint8Array([137, 80, 78, 71, 0, 255])
    mockedInvoke.mockResolvedValueOnce(source.buffer)

    const result = await readAttachment('ATT1')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('read_attachment', { attachmentId: 'ATT1' })
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result)).toEqual([137, 80, 78, 71, 0, 255])
  })

  it('propagates a backend rejection (missing attachment) to the caller', async () => {
    const appError = { kind: 'NotFound', message: "attachment 'ATT404'" }
    mockedInvoke.mockRejectedValueOnce(appError)

    await expect(readAttachment('ATT404')).rejects.toEqual(appError)
    expect(mockedInvoke).toHaveBeenCalledWith('read_attachment', { attachmentId: 'ATT404' })
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
    mockedInvoke.mockImplementation(mockInvokeCommands({ import_markdown: () => expected }))

    const result = await importMarkdown('# Title\n\nBody', 'my-page.md', 'SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledOnce()
    // `space_id` is required; the helper threads
    // it through as `spaceId` (camelCase per the Tauri arg convention).
    expect(mockedInvoke).toHaveBeenCalledWith('import_markdown', {
      content: '# Title\n\nBody',
      filename: 'my-page.md',
      spaceId: 'SPACE_A',
      // #1925 — the helper threads `vaultFiles` (null until the vault picker
      // wires it in PR 2; the backend treats null as "no attachments").
      vaultFiles: null,
      // #128 — the helper always passes a `Channel<ImportProgressUpdate>`
      // for progress streaming (mirroring `startSync`), even when no
      // `onProgress` callback is supplied.
      progress: expect.anything(),
    })
    expect(result).toEqual(expected)
  })

  it('defaults optional filename to null', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        import_markdown: () => ({
          page_title: 'Untitled',
          blocks_created: 1,
          properties_set: 0,
          warnings: [],
        }),
      }),
    )

    await importMarkdown('hello', undefined, 'SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledWith('import_markdown', {
      content: 'hello',
      filename: null,
      spaceId: 'SPACE_A',
      vaultFiles: null,
      progress: expect.anything(),
    })
  })

  it('forwards streamed progress events to the onProgress callback (#128)', async () => {
    // #128 — when `onProgress` is supplied the
    // helper wires it to `channel.onmessage`. Capture the Channel the
    // helper hands to `invoke`, push a `started` event through it, and
    // assert the callback fires.
    let capturedChannel: { onmessage?: (u: unknown) => void } | undefined
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        import_markdown: (args) => {
          capturedChannel = args['progress'] as { onmessage?: (u: unknown) => void }
          return { page_title: 'X', blocks_created: 0, properties_set: 0, warnings: [] }
        },
      }),
    )

    const onProgress = vi.fn()
    await importMarkdown('- a', 'x.md', 'SPACE_A', onProgress)

    const event = { kind: 'started', page_title: 'X', blocks_total: 1 }
    capturedChannel?.onmessage?.(event)
    expect(onProgress).toHaveBeenCalledWith(event)
  })

  it('forwards vaultFiles to the import_markdown command (#1925)', async () => {
    // #1925 — PR 2 adds the optional 5th `vaultFiles` arg (referenced
    // attachment bytes from the vault picker). When supplied it must flow
    // through to the IPC `vaultFiles` arg unchanged.
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        import_markdown: () => ({
          page_title: 'P',
          blocks_created: 1,
          properties_set: 0,
          warnings: [],
        }),
      }),
    )

    const vaultFiles = [{ path: 'assets/a.png', bytes: [1, 2, 3] }]
    await importMarkdown('![](assets/a.png)', 'p.md', 'SPACE_A', undefined, vaultFiles)

    expect(mockedInvoke).toHaveBeenCalledWith('import_markdown', {
      content: '![](assets/a.png)',
      filename: 'p.md',
      spaceId: 'SPACE_A',
      vaultFiles,
      progress: expect.anything(),
    })
  })
})

// ---------------------------------------------------------------------------
// restoreAllDeletedInSpace / purgeAllDeletedInSpace
// ---------------------------------------------------------------------------

describe('restoreAllDeletedInSpace', () => {
  it('drains listTrash for the space and restores the collected root ids', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: (args) => {
          expect(args).toEqual({
            cursor: null,
            limit: 50,
            scope: { kind: 'active', space_id: 'SPACE_A' },
          })
          return trashPage(['A1', 'A2'])
        },
        restore_blocks_by_ids: () => ({ affected_count: 2 }),
      }),
    )

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['A1', 'A2'],
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_all_deleted')
    expect(result).toEqual({ affected_count: 2 })
  })

  it('follows the cursor chain across multiple pages before restoring', async () => {
    // The page order IS the subject here, so the handler counts its own calls.
    let call = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: () => {
          call++
          return call === 1 ? trashPage(['P1'], 'CUR') : trashPage(['P2'])
        },
        restore_blocks_by_ids: () => ({ affected_count: 2 }),
      }),
    )

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['P1', 'P2'],
    })
    expect(result).toEqual({ affected_count: 2 })
  })

  it('returns affected_count 0 without calling restoreBlocksByIds when the space has no trash', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_trash: () => trashPage([]) }))

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_blocks_by_ids', expect.anything())
    expect(result).toEqual({ affected_count: 0 })
  })

  it('chunks batches larger than the backend cap into multiple restore_blocks_by_ids calls', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `B${i}`)
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: () => trashPage(ids),
        restore_blocks_by_ids: () => ({ affected_count: 1000 }),
      }),
    )

    const result = await restoreAllDeletedInSpace('SPACE_A')

    const restoreCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'restore_blocks_by_ids')
    expect(restoreCalls).toHaveLength(2)
    const call0Args = restoreCalls[0]?.[1] as { blockIds: string[] } | undefined
    const call1Args = restoreCalls[1]?.[1] as { blockIds: string[] } | undefined
    expect(call0Args?.blockIds).toHaveLength(1000)
    expect(call1Args?.blockIds).toHaveLength(500)
    expect(result).toEqual({ affected_count: 2000 })
  })

  it('propagates errors from listTrash', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ list_trash: () => Promise.reject(new Error('db error')) }),
    )
    await expect(restoreAllDeletedInSpace('SPACE_A')).rejects.toThrow('db error')
  })

  it('chunk size is exactly MAX_TRASH_BATCH_IDS', () => {
    expect(MAX_TRASH_BATCH_IDS).toBe(1000)
  })
})

describe('purgeAllDeletedInSpace', () => {
  it('drains listTrash for the space and purges the collected root ids', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: (args) => {
          expect(args).toEqual({
            cursor: null,
            limit: 50,
            scope: { kind: 'active', space_id: 'SPACE_B' },
          })
          return trashPage(['B1'])
        },
        purge_blocks_by_ids: () => ({ affected_count: 1 }),
      }),
    )

    const result = await purgeAllDeletedInSpace('SPACE_B')

    expect(mockedInvoke).toHaveBeenCalledWith('purge_blocks_by_ids', { blockIds: ['B1'] })
    expect(mockedInvoke).not.toHaveBeenCalledWith('purge_all_deleted')
    expect(result).toEqual({ affected_count: 1 })
  })

  it('returns affected_count 0 without calling purgeBlocksByIds when the space has no trash', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_trash: () => trashPage([]) }))

    const result = await purgeAllDeletedInSpace('SPACE_B')

    expect(mockedInvoke).not.toHaveBeenCalledWith('purge_blocks_by_ids', expect.anything())
    expect(result).toEqual({ affected_count: 0 })
  })

  it('propagates errors from purgeBlocksByIds', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: () => trashPage(['B1']),
        purge_blocks_by_ids: () => {
          throw new Error('db error')
        },
      }),
    )
    await expect(purgeAllDeletedInSpace('SPACE_B')).rejects.toThrow('db error')
  })

  // #3835 — each chunk is its own committed backend transaction, so a LATER
  // chunk failing must not discard the count of EARLIER chunks that already
  // landed. A plain rethrow of the chunk error (the pre-fix behaviour)
  // surfaces a partially-completed purge as a pure failure with no sign
  // that most of it succeeded.
  it('surfaces the earlier chunks’ committed count via PartialPurgeError when a later chunk fails', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `B${i}`)
    // The chunk ORDER is the subject, so the handler counts its own calls.
    let purgeCalls = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: () => trashPage(ids),
        purge_blocks_by_ids: () => {
          purgeCalls += 1
          // First chunk (1000 ids) commits successfully; the second (500
          // ids) fails.
          if (purgeCalls === 1) return { affected_count: 1000 }
          throw new Error('db error on second chunk')
        },
      }),
    )

    const rejection: unknown = await purgeAllDeletedInSpace('SPACE_B').catch((e: unknown) => e)

    expect(rejection).toBeInstanceOf(PartialPurgeError)
    expect((rejection as PartialPurgeError).affectedCount).toBe(1000)
    // The underlying failure is still readable — this wraps, not replaces.
    expect((rejection as PartialPurgeError).message).toBe('db error on second chunk')
    expect(purgeCalls).toBe(2)
  })

  // The test above throws `new Error(...)`, which is the shape a LOCAL failure
  // takes. A real backend rejection does not: `unwrap` throws the raw
  // `{ kind, message }` AppError envelope, a plain object that is NOT an
  // `Error`. That is the realistic path — an IPC-originated chunk failure is
  // the whole reason `PartialPurgeError` exists — and a `cause instanceof
  // Error` check silently degrades it to `"[object Object]"`, discarding the
  // backend's message. Both shapes are pinned so the pair cannot go
  // half-covered again.
  it('preserves the backend message when the chunk fails with a raw AppError envelope', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `B${i}`)
    // The chunk ORDER is the subject, so the handler counts its own calls.
    let purgeCalls = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_trash: () => trashPage(ids),
        purge_blocks_by_ids: () => {
          purgeCalls += 1
          if (purgeCalls === 1) return { affected_count: 1000 }
          // What the backend actually sends: a plain object, not an Error.
          const rejection: AppError = {
            kind: 'invalid_operation',
            message: "block 'B1200' is not deleted",
          }
          throw rejection
        },
      }),
    )

    const rejection: unknown = await purgeAllDeletedInSpace('SPACE_B').catch((e: unknown) => e)

    expect(rejection).toBeInstanceOf(PartialPurgeError)
    expect((rejection as PartialPurgeError).affectedCount).toBe(1000)
    expect((rejection as PartialPurgeError).message).toBe("block 'B1200' is not deleted")
    // The envelope itself stays reachable through the standard `cause` chain.
    expect((rejection as PartialPurgeError).cause).toEqual({
      kind: 'invalid_operation',
      message: "block 'B1200' is not deleted",
    })
  })
})

// ---------------------------------------------------------------------------
// createBlock (explicit-null coercion)
// ---------------------------------------------------------------------------

describe('createBlock', () => {
  it('invokes create_block with all parameters', async () => {
    const expected = withOps(
      makeBlockRow({
        id: 'BLK001',
        block_type: 'content',
        content: 'hello',
        parent_id: 'PARENT01',
        position: 3,
      }),
    )
    mockedInvoke.mockImplementation(mockInvokeCommands({ create_block: () => expected }))

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
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        create_block: () =>
          withOps(
            makeBlockRow({ id: 'BLK002', block_type: 'page', content: 'test', position: null }),
          ),
      }),
    )

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
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ create_block: () => Promise.reject(new Error('Validation error')) }),
    )
    await expect(createBlock({ blockType: 'bad', content: '' })).rejects.toThrow('Validation error')
  })
})

// ---------------------------------------------------------------------------
// searchBlocks (scope default)
// ---------------------------------------------------------------------------

describe('searchBlocks', () => {
  const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

  // Phase 0 — the IPC payload is now a struct: `{ query, cursor, limit, filter }`
  // where `filter` carries the previously-positional `parentId`, `tagIds`, and
  // `spaceId`. The wrapper's public API stays flat — these tests verify the
  // marshalling at the IPC boundary.
  it('invokes search_blocks with default-shaped filter when no optional params given', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ search_blocks: () => emptyPage }))

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
          snippet: null,
        },
      ],
      next_cursor: 'next123',
      has_more: true,
      total_count: null,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ search_blocks: () => pageResp }))

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
    mockedInvoke.mockImplementation(mockInvokeCommands({ search_blocks: () => emptyPage }))
    await searchBlocks({ query: 'q', spaceId: 'SPACE_42' })
    const args = (mockedInvoke.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    const filter = args['filter'] as Record<string, unknown>
    expect(filter['scope']).toEqual({ kind: 'active', space_id: 'SPACE_42' })
  })

  it('marshals parentId and tagIds into the filter struct', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ search_blocks: () => emptyPage }))
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
// logFrontend (the logger's backend sink)
// ---------------------------------------------------------------------------

describe('logFrontend', () => {
  it('invokes log_frontend with all parameters', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ log_frontend: () => null }))

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
    mockedInvoke.mockImplementation(mockInvokeCommands({ log_frontend: () => null }))

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
