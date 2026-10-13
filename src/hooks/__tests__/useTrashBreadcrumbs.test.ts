/**
 * Tests for useTrashBreadcrumbs — owning-page resolution via the
 * `batchResolve` IPC, with cancellation on prop change and a
 * deletedPage fallback for purged or missing pages.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 5 — the hook now calls the generated `commands.batchResolve`, so
// mocking only the hand-written wrapper no longer intercepts. Back the
// generated surface instead, resolving the same typed-result envelope `unwrap`
// expects.
const mockedBatchResolve = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { makeBlock } from '@/__tests__/fixtures'
import { useTrashBreadcrumbs } from '@/hooks/useTrashBreadcrumbs'
import type { BlockRow, ResolvedBlock } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

const mockedLoggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
  // #5415 — breadcrumb resolution carries the active space.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
})

describe('useTrashBreadcrumbs', () => {
  it('dispatches nothing while there is no active space, then resolves once one hydrates', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    mockedBatchResolve.mockResolvedValue([
      { id: 'P1', title: 'Page One', block_type: 'page', deleted: false },
    ] satisfies ResolvedBlock[])
    const blocks: BlockRow[] = [makeBlock({ id: 'A', page_id: 'P1' })]
    const { result, rerender } = renderHook(() => useTrashBreadcrumbs(blocks))
    rerender()

    expect(mockedBatchResolve).not.toHaveBeenCalled()
    expect(result.current(blocks[0] as BlockRow)).toBe(null)

    // Hydration is the trigger: the same blocks resolve once a space is known.
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    })
    await waitFor(() => {
      expect(result.current(blocks[0] as BlockRow)).toBe('Page One')
    })
    expect(mockedBatchResolve).toHaveBeenCalledWith(['P1'], { kind: 'active', space_id: 'SPACE_1' })
  })

  it('returns null for blocks without a page_id and never invokes batchResolve', () => {
    const blocks: BlockRow[] = [makeBlock({ id: 'A', page_id: null })]
    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    expect(result.current(blocks[0] as BlockRow)).toBe(null)
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  it('returns the resolved page title after batchResolve fulfills', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      { id: 'P1', title: 'Project Alpha', block_type: 'page', deleted: false },
    ])
    const blocks: BlockRow[] = [makeBlock({ id: 'A', page_id: 'P1' })]

    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    expect(mockedBatchResolve).toHaveBeenCalledWith(['P1'], { kind: 'active', space_id: 'SPACE_1' })
    // Before resolve flushes: page map empty, getPageLabel returns null.
    expect(result.current(blocks[0] as BlockRow)).toBe(null)

    await waitFor(() => {
      expect(result.current(blocks[0] as BlockRow)).toBe('Project Alpha')
    })
  })

  it('returns the deletedPage fallback when the page is missing from the resolved set', async () => {
    mockedBatchResolve.mockResolvedValueOnce([])
    const blocks: BlockRow[] = [makeBlock({ id: 'A', page_id: 'GONE' })]

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

    const initial: BlockRow[] = [makeBlock({ id: 'A', page_id: 'P1' })]
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockRow[] }) => useTrashBreadcrumbs(blocks),
      { initialProps: { blocks: initial } },
    )

    const next: BlockRow[] = [makeBlock({ id: 'B', page_id: 'P2' })]
    rerender({ blocks: next })

    // Resolve the cancelled (first) promise with stale data — it must be
    // ignored, leaving the map populated only by the second resolve.
    resolveFirst([{ id: 'P1', title: 'Stale First', block_type: 'page', deleted: false }])

    await waitFor(() => {
      expect(result.current(next[0] as BlockRow)).toBe('Second Parent')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(2)
  })

  it('logs a warning and leaves the page map empty when batchResolve rejects', async () => {
    mockedBatchResolve.mockRejectedValueOnce(new Error('ipc-fail'))
    const blocks: BlockRow[] = [makeBlock({ id: 'A', page_id: 'P1' })]

    const { result } = renderHook(() => useTrashBreadcrumbs(blocks))

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'TrashView',
        'breadcrumb resolution failed',
        undefined,
        expect.any(Error),
      )
    })

    // Page never made it into the map → getPageLabel returns null.
    expect(result.current(blocks[0] as BlockRow)).toBe(null)
  })
})
