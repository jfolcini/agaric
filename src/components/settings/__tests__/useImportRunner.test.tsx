/**
 * Tests for `useImportRunner` — the shared import-runner state machine.
 *
 * Drives a run (success + failure), a mid-loop cancel, and streamed per-block
 * progress, asserting the progress/failure/summary state and the returned
 * outcome. IPC (`importMarkdown`) is mocked with `vi.mocked`.
 */

import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useImportRunner } from '@/components/settings/useImportRunner'
import { useCalendarPageDatesEpoch } from '@/hooks/useCalendarPageDates'
import { hasPreference, PREFERENCES, readPreference } from '@/lib/preferences'
import { propertyKeysQueryKey } from '@/lib/property-keys-cache'
import { queryClient } from '@/lib/query-client'
import type { ImportUnit } from '@/lib/vault-import'

const mockImportMarkdown = vi.fn()
vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return { ...actual, importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args) }
})

// Post-import navigation resolves the title through `commands.resolvePageByAlias`;
// nothing matches here.
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      resolvePageByAlias: async () => ({ status: 'ok', data: null }),
    },
  }
})

const mockLoggerError = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}))

// The hook subscribes to the tabs store for post-import navigation.
vi.mock('@/stores/tabs', () => ({
  useTabsStore: (selector: (s: { navigateToPage: () => void }) => unknown) =>
    selector({ navigateToPage: vi.fn() }),
}))

/** A minimal unit whose content/path/bytes derive from its name. */
function unit(name: string): ImportUnit {
  return {
    name,
    bytes: name.length,
    load: async () => ({ content: `c-${name}`, path: name, vaultFiles: null }),
  }
}

/** A fake change event carrying a resettable input value. */
function mkEvent(): React.ChangeEvent<HTMLInputElement> {
  return { target: { value: 'seed' } } as unknown as React.ChangeEvent<HTMLInputElement>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockImportMarkdown.mockReset()
})

describe('useImportRunner', () => {
  it('runs a mixed success/failure batch and constructs the summary + outcome', async () => {
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'ok',
        blocks_created: 3,
        properties_set: 2,
        page_id: 'PAGE',
        collapsed: [],
        warnings: ['w1'],
      })
      .mockRejectedValueOnce({ kind: 'validation', message: 'bad' })

    const { result } = renderHook(() => useImportRunner())
    const event = mkEvent()

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      result.current.begin()
      outcome = await result.current.run({
        event,
        activeSpaceId: 'SPACE',
        units: [unit('ok.md'), unit('bad.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    // Outcome aggregate.
    expect(outcome).toEqual({
      totalBlocks: 3,
      succeededFiles: 1,
      failedFiles: [{ name: 'bad.md', reason: 'bad' }],
      cancelled: false,
      navTitle: 'ok',
    })

    // IPC shape: (content, path, spaceId, onProgress fn, vaultFiles).
    expect(mockImportMarkdown).toHaveBeenNthCalledWith(
      1,
      'c-ok.md',
      'ok.md',
      'SPACE',
      expect.any(Function),
      null,
    )

    // The per-unit failure is logged at ERROR with a name-distinct message.
    expect(mockLoggerError).toHaveBeenCalledWith(
      'DataSettingsTab',
      'file import failed: bad.md',
      { fileName: 'bad.md' },
      expect.anything(),
    )

    // Summary state.
    expect(result.current.importing).toBe(false)
    expect(result.current.currentFileIndex).toBeNull()
    expect(result.current.importResult).toMatchObject({
      pageTitle: null,
      notes: false,
      importedCount: 1,
      cancelled: false,
      blocksCreated: 3,
      propertiesSet: 2,
      warnings: ['w1'],
      failures: [{ name: 'bad.md', reason: 'bad' }],
      navTitle: 'ok',
    })

    // The input is reset so a retry re-opens the picker cleanly.
    expect(event.target.value).toBe('')
  })

  it('seeds initial warnings/failures and reports notes-based single-unit title', async () => {
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'Note',
      blocks_created: 5,
      properties_set: 0,
      page_id: 'PAGE',
      collapsed: [],
      warnings: [],
    })

    const { result } = renderHook(() => useImportRunner())
    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      result.current.begin()
      outcome = await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('Note.md')],
        notes: true,
        loggerFailLabel: 'enex note failed',
        initialWarnings: ['skipped 1 encrypted item'],
        initialFailures: [{ name: 'broken.enex', reason: 'not valid' }],
      })
    })

    // Seeded parse failure is carried into the combined outcome.
    expect(outcome?.failedFiles).toEqual([{ name: 'broken.enex', reason: 'not valid' }])
    expect(result.current.importResult).toMatchObject({
      // Single unit ⇒ pageTitle is the imported title (not the placeholder).
      pageTitle: 'Note',
      notes: true,
      importedCount: 1,
      cancelled: false,
      blocksCreated: 5,
      warnings: ['skipped 1 encrypted item'],
      failures: [{ name: 'broken.enex', reason: 'not valid' }],
    })
  })

  // #5258 — an imported journal day must show in a journal calendar already open.
  // #5296 — and an imported `key:: value` in the property pickers.
  it.each([
    [
      're-fetches the journal calendar and property lists after a run that imported a page',
      true,
      1,
    ],
    ['leaves the journal calendar and property lists alone when every unit failed', false, 0],
  ])('%s', async (_label, succeeds, expectedEpochMoves) => {
    const keys = propertyKeysQueryKey('SPACE')
    queryClient.setQueryData(keys, ['status'])
    if (succeeds) {
      mockImportMarkdown.mockResolvedValueOnce({
        page_title: '2026-06-15',
        blocks_created: 1,
        properties_set: 0,
        page_id: 'PAGE',
        collapsed: [],
        warnings: [],
      })
    } else {
      mockImportMarkdown.mockRejectedValueOnce({ kind: 'validation', message: 'bad' })
    }
    const calendar = renderHook(() => useCalendarPageDatesEpoch())
    const epochBefore = calendar.result.current

    const { result } = renderHook(() => useImportRunner())
    await act(async () => {
      result.current.begin()
      await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('2026-06-15.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    expect(calendar.result.current).toBe(epochBefore + expectedEpochMoves)
    expect(queryClient.getQueryState(keys)?.isInvalidated).toBe(succeeds)
  })

  it("folds the blocks a Logseq page folded in that page's collapse layout", async () => {
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'Atlas',
        blocks_created: 3,
        properties_set: 0,
        page_id: 'PAGE_ATLAS',
        collapsed: ['BLOCK_1', 'BLOCK_3'],
        warnings: [],
      })
      .mockResolvedValueOnce({
        page_title: 'Plain',
        blocks_created: 1,
        properties_set: 0,
        page_id: 'PAGE_PLAIN',
        collapsed: [],
        warnings: [],
      })

    const { result } = renderHook(() => useImportRunner())
    await act(async () => {
      result.current.begin()
      await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('Atlas.md'), unit('Plain.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    expect(readPreference(PREFERENCES.blockCollapse, 'PAGE_ATLAS')).toEqual(['BLOCK_1', 'BLOCK_3'])
    expect(hasPreference(PREFERENCES.blockCollapse, 'PAGE_PLAIN')).toBe(false)
  })

  it('cancels between units: the in-flight unit completes, the next never starts', async () => {
    const { result } = renderHook(() => useImportRunner())

    // First unit sets the abort flag while in flight, then resolves.
    mockImportMarkdown
      .mockImplementationOnce(async () => {
        result.current.cancel()
        return {
          page_title: 'a',
          blocks_created: 1,
          properties_set: 0,
          page_id: 'PAGE',
          collapsed: [],
          warnings: [],
        }
      })
      .mockImplementationOnce(() => {
        throw new Error('second unit should not start after cancel')
      })

    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      result.current.begin()
      outcome = await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('a.md'), unit('b.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    expect(outcome?.cancelled).toBe(true)
    expect(outcome?.succeededFiles).toBe(1)
    expect(outcome?.totalBlocks).toBe(1)
    // Only the first unit ran; the second was never started.
    expect(mockImportMarkdown).toHaveBeenCalledTimes(1)
    expect(result.current.importing).toBe(false)
    expect(result.current.importResult).toMatchObject({
      importedCount: 1,
      cancelled: true,
    })
  })

  it('reflects streamed per-block progress while a unit is in flight', async () => {
    let resolveImport: (r: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      (
        _content: string,
        _path: string,
        _spaceId: string,
        onProgress?: (u: { kind: string; blocks_total?: number; blocks_done?: number }) => void,
      ) => {
        onProgress?.({ kind: 'started', blocks_total: 3 })
        onProgress?.({ kind: 'progress', blocks_done: 2, blocks_total: 3 })
        return new Promise((resolve) => {
          resolveImport = resolve
        })
      },
    )

    const { result } = renderHook(() => useImportRunner())
    let runPromise: Promise<unknown> | undefined
    await act(async () => {
      result.current.begin()
      runPromise = result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('big.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
      // Let the unit's async load resolve and importMarkdown fire its
      // synchronous progress events, then park on the pending promise.
      await new Promise((r) => setTimeout(r, 0))
    })

    // Mid-flight: the streamed progress drives the block counters.
    expect(result.current.currentFileIndex).toBe(1)
    expect(result.current.currentFileBlocksDone).toBe(2)
    expect(result.current.currentFileBlocksTotal).toBe(3)
    expect(result.current.importing).toBe(true)

    await act(async () => {
      resolveImport({
        page_title: 'big',
        blocks_created: 3,
        properties_set: 0,
        page_id: 'PAGE',
        collapsed: [],
        warnings: [],
      })
      await runPromise
    })

    // After completion the progress UI clears.
    expect(result.current.currentFileIndex).toBeNull()
    expect(result.current.importing).toBe(false)
    expect(result.current.importResult).toMatchObject({
      blocksCreated: 3,
      importedCount: 1,
      cancelled: false,
    })
  })
})
