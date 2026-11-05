/**
 * Tests for `useImportRunner`'s merges (#6277 decision 7): before a run that
 * may merge files into existing pages it asks which pages, through
 * `list_import_merges`, and waits on the user; each file that can merge then
 * carries the pages the run wrote so far, and a merge is its page's undo step.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stubInvoke } from '@/__tests__/helpers/invoke'
import { useImportRunner } from '@/components/settings/useImportRunner'
import type { ImportResult } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import type { ImportUnit } from '@/lib/vault-import'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockImportMarkdown = vi.fn()
vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return { ...actual, importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args) }
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

vi.mock('@/stores/tabs', () => ({
  useTabsStore: (selector: (s: { navigateToPage: () => void }) => unknown) =>
    selector({ navigateToPage: vi.fn() }),
}))

/** A Markdown unit that may merge, as a single-file pick makes one. */
function unit(name: string, merges = true): ImportUnit {
  return {
    name,
    bytes: 1,
    ...(merges ? { merges: name } : {}),
    load: async () => ({
      content: `c-${name}`,
      path: name,
      dialect: 'Markdown',
      vaultFiles: null,
      vaultNotes: null,
    }),
  }
}

function imported(pageId: string, merged: ImportResult['merged']): ImportResult {
  return {
    page_title: pageId,
    page_id: pageId,
    blocks_created: 0,
    properties_set: 0,
    collapsed: [],
    warnings: [],
    anchors: [],
    deferred: [],
    merged,
  }
}

function mkEvent(): React.ChangeEvent<HTMLInputElement> {
  return { target: { value: 'seed' } } as unknown as React.ChangeEvent<HTMLInputElement>
}

const listImportMerges = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockImportMarkdown.mockReset()
  listImportMerges.mockReset()
  useSpaceStore.setState({ currentSpaceId: 'SPACE' })
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useUndoStore.setState({ pages: new Map() })
  stubInvoke(vi.mocked(invoke), {
    list_import_merges: (args) => listImportMerges(args),
    list_all_tags_in_space: () => [],
    batch_resolve: () => [],
  })
})

describe('useImportRunner merges', () => {
  it('asks about the pages it updates, then imports with the run so far and keeps the undo step', async () => {
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    const ops = [{ device_id: 'D', seq: 7 }]
    mockImportMarkdown
      .mockResolvedValueOnce(imported('PLAN', ops))
      .mockResolvedValueOnce(imported('NEW', null))
      .mockResolvedValueOnce(imported('NOTE', null))
    const { result } = renderHook(() => useImportRunner())

    let running: Promise<unknown> | undefined
    act(() => {
      result.current.begin()
      running = result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('Plan.md'), unit('New.md'), unit('note.md', false)],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })
    await waitFor(() => expect(result.current.mergeQuestion).not.toBeNull())
    expect(listImportMerges).toHaveBeenCalledExactlyOnceWith({
      spaceId: 'SPACE',
      filenames: ['Plan.md', 'New.md'],
    })
    expect(result.current.mergeQuestion?.pages).toEqual([{ page_id: 'PLAN', title: 'Plan' }])
    expect(mockImportMarkdown).not.toHaveBeenCalled()

    let outcome: unknown
    await act(async () => {
      result.current.mergeQuestion?.answer(true)
      outcome = await running
    })

    expect(result.current.mergeQuestion).toBeNull()
    expect(mockImportMarkdown.mock.calls.map((call) => call[7])).toEqual([[], ['PLAN'], []])
    expect(outcome).toMatchObject({ pagesUpdated: 1, totalBlocks: 0, navTitle: 'NOTE' })
    expect(result.current.importResult).toMatchObject({ pagesUpdated: 1, cancelled: false })
    expect(useUndoStore.getState().pages.get('PLAN')?.undoStack[0]?.refs).toEqual(ops)
  })

  it('imports nothing when the user declines', async () => {
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    const { result } = renderHook(() => useImportRunner())

    let running: Promise<unknown> | undefined
    act(() => {
      result.current.begin()
      running = result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('Plan.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })
    await waitFor(() => expect(result.current.mergeQuestion).not.toBeNull())
    let outcome: unknown
    await act(async () => {
      result.current.mergeQuestion?.answer(false)
      outcome = await running
    })

    expect(mockImportMarkdown).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ cancelled: true, succeededFiles: 0 })
    expect(result.current.importing).toBe(false)
  })

  it('asks nothing when no page would be updated, or no unit merges', async () => {
    listImportMerges.mockReturnValue([])
    mockImportMarkdown.mockResolvedValue(imported('NEW', null))
    const { result } = renderHook(() => useImportRunner())

    await act(async () => {
      result.current.begin()
      await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('New.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
      await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('folder.md', false)],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    expect(listImportMerges).toHaveBeenCalledOnce()
    expect(mockImportMarkdown).toHaveBeenCalledTimes(2)
  })

  it('runs nothing and says why when the pages cannot be read', async () => {
    listImportMerges.mockRejectedValue({ kind: 'database', message: 'disk gone' })
    const { result } = renderHook(() => useImportRunner())

    let outcome: unknown
    await act(async () => {
      result.current.begin()
      outcome = await result.current.run({
        event: mkEvent(),
        activeSpaceId: 'SPACE',
        units: [unit('Plan.md')],
        notes: false,
        loggerFailLabel: 'file import failed',
      })
    })

    expect(mockImportMarkdown).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ cancelled: true, succeededFiles: 0 })
    expect(result.current.importResult?.warnings).toEqual([
      t('data.importMergeCheckFailed', { reason: 'disk gone' }),
    ])
    expect(mockLoggerError).toHaveBeenCalledWith(
      'DataSettingsTab',
      'reading the pages the import updates failed',
      undefined,
      expect.anything(),
    )
  })
})
