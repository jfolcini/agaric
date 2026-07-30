/**
 * Guard for the strict-IPC test infrastructure itself (#3225).
 *
 * The property under test: a Tauri command nobody stubbed must be the
 * LOUDEST failure in a test, not the quietest. Before this landed, the shared
 * `invoke` mock resolved `undefined` for any unstubbed command, `typedError`
 * wrapped that as `{ status: 'ok', data: undefined }`, and `unwrap` reported
 * SUCCESS — so a missing mock was indistinguishable from a command that
 * genuinely returned nothing (#3217's silent behaviour inversion).
 *
 * Every test here drains the recorder via `takeUnstubbedInvokes()` before it
 * ends, because the global `afterEach` in `src/test-setup.ts` deliberately
 * fails any test that leaves an unstubbed call recorded.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mockInvokeCommands,
  pageRowInvokeFallback,
  strictInvokeFallback,
  takeUnstubbedInvokes,
} from '@/__tests__/helpers/invoke'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'

afterEach(() => {
  vi.mocked(invoke).mockReset()
})

describe('strict invoke fallback', () => {
  it('rejects an unstubbed command and names it', async () => {
    await expect(invoke('load_page_subtree')).rejects.toThrow(
      /no mock registered for command "load_page_subtree"/,
    )
    expect(takeUnstubbedInvokes()).toEqual(['load_page_subtree'])
  })

  it('records every distinct unstubbed command, deduped', async () => {
    await expect(strictInvokeFallback('delete_block')).rejects.toThrow()
    await expect(strictInvokeFallback('delete_block')).rejects.toThrow()
    await expect(strictInvokeFallback('edit_block')).rejects.toThrow()

    expect(takeUnstubbedInvokes()).toEqual(['delete_block', 'edit_block'])
    // Draining is exhaustive: a second read sees nothing.
    expect(takeUnstubbedInvokes()).toEqual([])
  })

  it('surfaces the failure through the generated bindings, where a resolved undefined would not', async () => {
    // The regression this guards: `typedError` turns ANY resolved value into
    // `{ status: 'ok' }`, so `unwrap` cannot tell a phantom success from a
    // real one. Rejecting is what keeps the distinction observable.
    await expect(commands.deleteBlock('BLOCK_1')).rejects.toThrow(
      /no mock registered for command "delete_block"/,
    )
    expect(takeUnstubbedInvokes()).toEqual(['delete_block'])
  })

  it('honours an explicit stub that resolves nothing (the `()`-returning case)', async () => {
    // A command whose Rust signature returns `()` legitimately produces no
    // payload. Once it is stubbed, `undefined` must flow through as a real
    // success — the fallback, not the value, is what objects.
    vi.mocked(invoke).mockResolvedValue(undefined)

    expect(unwrap(await commands.deleteBlock('BLOCK_1'))).toBeUndefined()
    expect(takeUnstubbedInvokes()).toEqual([])
  })
})

describe('mockInvokeCommands', () => {
  it('dispatches on the command name, not on call position', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        delete_block: () => Promise.reject(new Error('Delete failed')),
        load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }),
      }),
    )

    // The prefetch lands FIRST, which is exactly what stole the positional
    // slot in #3217. Keyed dispatch is invariant to it.
    await expect(invoke('load_page_subtree')).resolves.toMatchObject({ total: 0 })
    await expect(invoke('delete_block')).rejects.toThrow('Delete failed')
    expect(takeUnstubbedInvokes()).toEqual([])
  })

  it('passes the command arguments to the handler', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ edit_block: (args) => `saw:${String(args['toText'])}` }),
    )

    await expect(invoke('edit_block', { blockId: 'B1', toText: 'hello' })).resolves.toBe(
      'saw:hello',
    )
  })

  it('honours a handler that returns undefined', async () => {
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ record_page_visit: () => undefined }))

    await expect(invoke('record_page_visit')).resolves.toBeUndefined()
    expect(takeUnstubbedInvokes()).toEqual([])
  })

  it('turns a handler that throws synchronously into a rejected call', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        edit_block: () => {
          throw new Error('boom')
        },
      }),
    )

    await expect(invoke('edit_block')).rejects.toThrow('boom')
    expect(takeUnstubbedInvokes()).toEqual([])
  })

  it('sends an unlisted command to the strict fallback', async () => {
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ edit_block: () => null }))

    await expect(invoke('create_block')).rejects.toThrow(
      /no mock registered for command "create_block"/,
    )
    expect(takeUnstubbedInvokes()).toEqual(['create_block'])
  })

  it('accepts an alternative fallback that still fails on the unknown', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ edit_block: () => null }, { fallback: pageRowInvokeFallback }),
    )

    // The one modelled incidental call resolves…
    await expect(invoke('load_page_subtree')).resolves.toMatchObject({ truncated: false })
    // …everything else is still loud.
    await expect(invoke('create_block')).rejects.toThrow(/no mock registered/)
    expect(takeUnstubbedInvokes()).toEqual(['create_block'])
  })
})
