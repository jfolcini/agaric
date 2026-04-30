/**
 * Tests for useTrashBreadcrumbs — parent-page resolution via the
 * `batchResolve` IPC, with cancellation on prop change and a
 * deletedPage fallback for purged or missing parents.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  batchResolve: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { makeBlock } from '../../__tests__/fixtures'
import { logger } from '../../lib/logger'
import type { BlockRow, ResolvedBlock } from '../../lib/tauri'
import { batchResolve } from '../../lib/tauri'
import { useTrashBreadcrumbs } from '../useTrashBreadcrumbs'

const mockedBatchResolve = vi.mocked(batchResolve)
const mockedLoggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTrashBreadcrumbs', () => {
  it('returns null for blocks without a parent_id and never invokes batchResolve', () => {
    const blocks: BlockRow[] = [makeBlock({ id: 'A', parent_id: null })]
    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    expect(result.current(blocks[0] as BlockRow)).toBe(null)
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  it('returns the resolved parent title after batchResolve fulfills', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      { id: 'P1', title: 'Project Alpha', block_type: 'page', deleted: false },
    ])
    const blocks: BlockRow[] = [makeBlock({ id: 'A', parent_id: 'P1' })]

    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    expect(mockedBatchResolve).toHaveBeenCalledWith(['P1'])
    // Before resolve flushes: parent map empty, getParentLabel returns null.
    expect(result.current(blocks[0] as BlockRow)).toBe(null)

    await waitFor(() => {
      expect(result.current(blocks[0] as BlockRow)).toBe('Project Alpha')
    })
  })

  it('returns the deletedPage fallback when the parent is missing from the resolved set', async () => {
    mockedBatchResolve.mockResolvedValueOnce([])
    const blocks: BlockRow[] = [makeBlock({ id: 'A', parent_id: 'GONE' })]

    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    await waitFor(() => {
      expect(result.current(blocks[0] as BlockRow)).toBe('(deleted page)')
    })
  })

  it('cancels an in-flight resolve when blockIds change before it settles', async () => {
    let resolveFirst: (value: ResolvedBlock[]) => void = () => {}
    mockedBatchResolve.mockImplementationOnce(
      () =>
        new Promise<ResolvedBlock[]>((resolve) => {
          resolveFirst = resolve
        }),
    )
    mockedBatchResolve.mockResolvedValueOnce([
      { id: 'P2', title: 'Second Parent', block_type: 'page', deleted: false },
    ])

    const initial: BlockRow[] = [makeBlock({ id: 'A', parent_id: 'P1' })]
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockRow[] }) => useTrashBreadcrumbs(blocks),
      { initialProps: { blocks: initial } },
    )

    const next: BlockRow[] = [makeBlock({ id: 'B', parent_id: 'P2' })]
    rerender({ blocks: next })

    // Resolve the cancelled (first) promise with stale data — it must be
    // ignored, leaving the map populated only by the second resolve.
    resolveFirst([{ id: 'P1', title: 'Stale First', block_type: 'page', deleted: false }])

    await waitFor(() => {
      expect(result.current(next[0] as BlockRow)).toBe('Second Parent')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(2)
  })

  it('logs a warning and leaves the parent map empty when batchResolve rejects', async () => {
    mockedBatchResolve.mockRejectedValueOnce(new Error('ipc-fail'))
    const blocks: BlockRow[] = [makeBlock({ id: 'A', parent_id: 'P1' })]

    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'TrashView',
        'breadcrumb resolution failed',
        undefined,
        expect.any(Error),
      )
    })

    // Parent never made it into the map → getParentLabel returns null.
    expect(result.current(blocks[0] as BlockRow)).toBe(null)
  })
})
