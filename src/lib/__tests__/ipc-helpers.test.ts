/**
 * Tests for src/lib/ipc-helpers.ts (#4413) — the floor of the
 * `@/lib/tauri` → `bindings.ts` migration (#2927): functions that carry real
 * logic (Channel plumbing, a chunked drain, a client-side abort bridge, the
 * sanctioned raw-`invoke` seam) and so can't collapse to a bare `commands.*`
 * call site.
 *
 * These describe blocks were moved verbatim (import path only) from the
 * former `src/lib/__tests__/tauri.test.ts` / `tauri-abort.test.ts` when the
 * underlying functions moved out of `src/lib/tauri/`.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isCancellation } from '@/lib/app-error'
import {
  cancelledError,
  importMarkdown,
  MAX_TRASH_BATCH_IDS,
  PartialPurgeError,
  purgeAllDeletedInSpace,
  readAttachment,
  restoreAllDeletedInSpace,
  startSync,
  withAbort,
} from '@/lib/ipc-helpers'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

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
    mockedInvoke.mockResolvedValueOnce(expected)
    const result = await startSync('peer-1')
    expect(result).toEqual(expected)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'start_sync',
      expect.objectContaining({ peerId: 'peer-1', progress: expect.anything() }),
    )
  })

  it('propagates errors from invoke', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('peer unreachable'))
    await expect(startSync('peer-1')).rejects.toThrow('peer unreachable')
  })
})

// ---------------------------------------------------------------------------
// readAttachment
// ---------------------------------------------------------------------------

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
    mockedInvoke.mockResolvedValueOnce(expected)

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
    mockedInvoke.mockResolvedValueOnce({
      page_title: 'Untitled',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    })

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
    mockedInvoke.mockImplementationOnce(async (_cmd, args) => {
      capturedChannel = (args as Record<string, unknown>)['progress'] as {
        onmessage?: (u: unknown) => void
      }
      return { page_title: 'X', blocks_created: 0, properties_set: 0, warnings: [] }
    })

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
    mockedInvoke.mockResolvedValueOnce({
      page_title: 'P',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    })

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
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_trash') {
        expect(args).toEqual({
          cursor: null,
          limit: 50,
          scope: { kind: 'active', space_id: 'SPACE_A' },
        })
        return { items: [{ id: 'A1' }, { id: 'A2' }], next_cursor: null, has_more: false }
      }
      if (cmd === 'restore_blocks_by_ids') return { affected_count: 2 }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['A1', 'A2'],
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_all_deleted')
    expect(result).toEqual({ affected_count: 2 })
  })

  it('follows the cursor chain across multiple pages before restoring', async () => {
    let call = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash') {
        call++
        return call === 1
          ? { items: [{ id: 'P1' }], next_cursor: 'CUR', has_more: true }
          : { items: [{ id: 'P2' }], next_cursor: null, has_more: false }
      }
      if (cmd === 'restore_blocks_by_ids') return { affected_count: 2 }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['P1', 'P2'],
    })
    expect(result).toEqual({ affected_count: 2 })
  })

  it('returns affected_count 0 without calling restoreBlocksByIds when the space has no trash', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash') return { items: [], next_cursor: null, has_more: false }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await restoreAllDeletedInSpace('SPACE_A')

    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_blocks_by_ids', expect.anything())
    expect(result).toEqual({ affected_count: 0 })
  })

  it('chunks batches larger than the backend cap into multiple restore_blocks_by_ids calls', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `B${i}`)
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash')
        return { items: ids.map((id) => ({ id })), next_cursor: null, has_more: false }
      if (cmd === 'restore_blocks_by_ids') return { affected_count: 1000 }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

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
    mockedInvoke.mockRejectedValueOnce(new Error('db error'))
    await expect(restoreAllDeletedInSpace('SPACE_A')).rejects.toThrow('db error')
  })

  it('chunk size is exactly MAX_TRASH_BATCH_IDS', () => {
    expect(MAX_TRASH_BATCH_IDS).toBe(1000)
  })
})

describe('purgeAllDeletedInSpace', () => {
  it('drains listTrash for the space and purges the collected root ids', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_trash') {
        expect(args).toEqual({
          cursor: null,
          limit: 50,
          scope: { kind: 'active', space_id: 'SPACE_B' },
        })
        return { items: [{ id: 'B1' }], next_cursor: null, has_more: false }
      }
      if (cmd === 'purge_blocks_by_ids') return { affected_count: 1 }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await purgeAllDeletedInSpace('SPACE_B')

    expect(mockedInvoke).toHaveBeenCalledWith('purge_blocks_by_ids', { blockIds: ['B1'] })
    expect(mockedInvoke).not.toHaveBeenCalledWith('purge_all_deleted')
    expect(result).toEqual({ affected_count: 1 })
  })

  it('returns affected_count 0 without calling purgeBlocksByIds when the space has no trash', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash') return { items: [], next_cursor: null, has_more: false }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await purgeAllDeletedInSpace('SPACE_B')

    expect(mockedInvoke).not.toHaveBeenCalledWith('purge_blocks_by_ids', expect.anything())
    expect(result).toEqual({ affected_count: 0 })
  })

  it('propagates errors from purgeBlocksByIds', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash') return { items: [{ id: 'B1' }], next_cursor: null, has_more: false }
      if (cmd === 'purge_blocks_by_ids') throw new Error('db error')
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    await expect(purgeAllDeletedInSpace('SPACE_B')).rejects.toThrow('db error')
  })

  // #3835 — each chunk is its own committed backend transaction, so a LATER
  // chunk failing must not discard the count of EARLIER chunks that already
  // landed. A plain rethrow of the chunk error (the pre-fix behaviour)
  // surfaces a partially-completed purge as a pure failure with no sign
  // that most of it succeeded.
  it('surfaces the earlier chunks’ committed count via PartialPurgeError when a later chunk fails', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `B${i}`)
    let purgeCalls = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash')
        return { items: ids.map((id) => ({ id })), next_cursor: null, has_more: false }
      if (cmd === 'purge_blocks_by_ids') {
        purgeCalls += 1
        // First chunk (1000 ids) commits successfully; the second (500
        // ids) fails.
        if (purgeCalls === 1) return { affected_count: 1000 }
        throw new Error('db error on second chunk')
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

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
    let purgeCalls = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_trash')
        return { items: ids.map((id) => ({ id })), next_cursor: null, has_more: false }
      if (cmd === 'purge_blocks_by_ids') {
        purgeCalls += 1
        if (purgeCalls === 1) return { affected_count: 1000 }
        // What the backend actually sends: a plain object, not an Error.
        throw { kind: 'invalid_operation', message: "block 'B1200' is not deleted" }
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

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
