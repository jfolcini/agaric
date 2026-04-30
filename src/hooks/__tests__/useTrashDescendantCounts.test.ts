/**
 * Tests for useTrashDescendantCounts — UX-243 cascade-count badges
 * fetched via the `trashDescendantCounts` IPC, with cancellation on
 * prop change and a warn-logged empty fallback on failure.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  trashDescendantCounts: vi.fn(),
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
import type { BlockRow } from '../../lib/tauri'
import { trashDescendantCounts } from '../../lib/tauri'
import { useTrashDescendantCounts } from '../useTrashDescendantCounts'

const mockedTrashDescendantCounts = vi.mocked(trashDescendantCounts)
const mockedLoggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTrashDescendantCounts', () => {
  it('returns an empty record and skips the IPC when blocks is empty', () => {
    // Stable reference — passing `[]` inline would create a new array on each
    // render, defeating the `useMemo([blocks])` cache and re-triggering the
    // `setCounts({})` branch in a render loop.
    const empty: BlockRow[] = []
    const { result } = renderHook(() => useTrashDescendantCounts(empty))

    expect(result.current).toEqual({})
    expect(mockedTrashDescendantCounts).not.toHaveBeenCalled()
  })

  it('populates the record with counts after the IPC resolves', async () => {
    mockedTrashDescendantCounts.mockResolvedValueOnce({ A: 3, B: 1 })
    const blocks: BlockRow[] = [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })]

    const { result } = renderHook(() => useTrashDescendantCounts(blocks))

    expect(mockedTrashDescendantCounts).toHaveBeenCalledWith(['A', 'B'])

    await waitFor(() => {
      expect(result.current).toEqual({ A: 3, B: 1 })
    })
  })

  it('refetches when the block id list changes', async () => {
    mockedTrashDescendantCounts.mockResolvedValueOnce({ A: 1 })
    const initial: BlockRow[] = [makeBlock({ id: 'A' })]

    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockRow[] }) => useTrashDescendantCounts(blocks),
      { initialProps: { blocks: initial } },
    )

    await waitFor(() => {
      expect(result.current).toEqual({ A: 1 })
    })

    mockedTrashDescendantCounts.mockResolvedValueOnce({ B: 2 })
    rerender({ blocks: [makeBlock({ id: 'B' })] })

    expect(mockedTrashDescendantCounts).toHaveBeenCalledTimes(2)
    expect(mockedTrashDescendantCounts).toHaveBeenLastCalledWith(['B'])
    await waitFor(() => {
      expect(result.current).toEqual({ B: 2 })
    })
  })

  it('cancels an in-flight fetch when blockIds change before it settles', async () => {
    let resolveFirst: (value: Record<string, number>) => void = () => {}
    mockedTrashDescendantCounts.mockImplementationOnce(
      () =>
        new Promise<Record<string, number>>((resolve) => {
          resolveFirst = resolve
        }),
    )
    mockedTrashDescendantCounts.mockResolvedValueOnce({ B: 5 })

    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockRow[] }) => useTrashDescendantCounts(blocks),
      { initialProps: { blocks: [makeBlock({ id: 'A' })] } },
    )

    rerender({ blocks: [makeBlock({ id: 'B' })] })

    // The first promise resolves AFTER cancellation; its data must not leak.
    resolveFirst({ A: 99 })

    await waitFor(() => {
      expect(result.current).toEqual({ B: 5 })
    })
  })

  it('logs a warning and leaves the record empty when the IPC rejects', async () => {
    mockedTrashDescendantCounts.mockRejectedValueOnce(new Error('ipc-fail'))
    const blocks: BlockRow[] = [makeBlock({ id: 'A' })]

    const { result } = renderHook(() => useTrashDescendantCounts(blocks))

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'TrashView',
        'descendant count resolution failed',
        undefined,
        expect.any(Error),
      )
    })

    expect(result.current).toEqual({})
  })
})
