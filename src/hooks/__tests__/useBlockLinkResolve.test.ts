/**
 * Tests for useBlockLinkResolve — scans loaded blocks for `[[ULID]]`
 * tokens not yet in the resolve cache and batch-fetches them via the
 * `batchResolve` IPC. Covers cache-membership filtering, FEAT-3p7
 * space scoping, cancellation on unmount, and graceful error handling.
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

import { logger } from '../../lib/logger'
import type { ResolvedBlock } from '../../lib/tauri'
import { batchResolve } from '../../lib/tauri'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { collectUncachedLinkIds, useBlockLinkResolve } from '../useBlockLinkResolve'

const mockedBatchResolve = vi.mocked(batchResolve)
const mockedLoggerWarn = vi.mocked(logger.warn)

const TEST_SPACE_ID = 'SPACE_TEST'
// 26-char Crockford base32 ULIDs to satisfy the [[ULID]] regex.
const ULID_A = '01TESTLINK0000000000ULIDA1'
const ULID_B = '01TESTLINK0000000000ULIDB2'

beforeEach(async () => {
  await new Promise<void>((r) => queueMicrotask(r))
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [{ id: TEST_SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
  vi.clearAllMocks()
})

describe('collectUncachedLinkIds', () => {
  it('returns the empty set when blocks contain no link tokens', () => {
    const blocks = [{ content: 'just plain text' }, { content: null }]
    expect(collectUncachedLinkIds(blocks, TEST_SPACE_ID).size).toBe(0)
  })

  it('extracts ULID ids embedded in `[[…]]` tokens across multiple blocks', () => {
    const blocks = [
      { content: `pre [[${ULID_A}]] mid` },
      { content: `[[${ULID_B}]]` },
      { content: `dup [[${ULID_A}]] again` },
    ]
    const ids = collectUncachedLinkIds(blocks, TEST_SPACE_ID)
    expect(ids).toEqual(new Set([ULID_A, ULID_B]))
  })

  it('skips ids already present in the active-space cache', () => {
    useResolveStore.getState().set(ULID_A, 'Already cached', false)

    const blocks = [{ content: `[[${ULID_A}]] [[${ULID_B}]]` }]
    const ids = collectUncachedLinkIds(blocks, TEST_SPACE_ID)
    expect(ids).toEqual(new Set([ULID_B]))
  })
})

describe('useBlockLinkResolve', () => {
  it('does nothing when no uncached link tokens exist', async () => {
    renderHook(() => useBlockLinkResolve([{ content: 'plain text' }]))

    // Allow the async effect's promise chain to settle.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  it('calls batchResolve with the uncached ids and caches each result', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked block A', block_type: 'content', deleted: false },
    ])

    renderHook(() => useBlockLinkResolve([{ content: `see [[${ULID_A}]]` }]))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], TEST_SPACE_ID)
    })

    await waitFor(() => {
      const cached = useResolveStore.getState().cache
      expect(cached.size).toBeGreaterThan(0)
    })
  })

  it('caches ids the backend did not return as deleted placeholders (FEAT-3p7)', async () => {
    mockedBatchResolve.mockResolvedValueOnce([])

    renderHook(() => useBlockLinkResolve([{ content: `[[${ULID_A}]] and [[${ULID_B}]]` }]))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })

    // Each requested id is cached as a deleted placeholder so the chip
    // renders via the broken-link UX.
    await waitFor(() => {
      const cached = useResolveStore.getState().cache
      expect(cached.size).toBe(2)
    })
  })

  it('cancels caching when the hook unmounts before the promise settles', async () => {
    let resolveBatch: (value: ResolvedBlock[]) => void = () => {}
    mockedBatchResolve.mockImplementationOnce(
      () =>
        new Promise<ResolvedBlock[]>((resolve) => {
          resolveBatch = resolve
        }),
    )

    const { unmount } = renderHook(() => useBlockLinkResolve([{ content: `[[${ULID_A}]]` }]))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })

    // Unmount before the promise resolves; subsequent .set() writes must
    // be skipped because the cancellation flag flips.
    unmount()
    resolveBatch([{ id: ULID_A, title: 'Late', block_type: 'content', deleted: false }])

    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => queueMicrotask(r))

    expect(useResolveStore.getState().cache.size).toBe(0)
  })

  it('logs and swallows transport failures from batchResolve', async () => {
    mockedBatchResolve.mockRejectedValueOnce(new Error('transport-fail'))

    renderHook(() => useBlockLinkResolve([{ content: `[[${ULID_A}]]` }]))

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'BlockTree',
        'Batch resolve failed for uncached block links',
        undefined,
        expect.any(Error),
      )
    })
  })
})
