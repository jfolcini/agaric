/**
 * Tests for useBlockLinkResolve — scans loaded blocks for `[[ULID]]`
 * tokens not yet in the resolve cache and batch-fetches them via the
 * `batchResolve` IPC. Covers cache-membership filtering,
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
import { keyFor } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import {
  collectUncachedLinkIds,
  fetchAndCacheLinks,
  useBlockLinkResolve,
} from '../useBlockLinkResolve'

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

// Block ids for the hook fixtures (the hook now keys its memo on
// id+content, so fixtures must carry an `id`).
const BLOCK_1 = '01TESTBLOCK000000000BLOCK1'
const BLOCK_2 = '01TESTBLOCK000000000BLOCK2'

describe('useBlockLinkResolve', () => {
  it('does nothing when no uncached link tokens exist', async () => {
    renderHook(() => useBlockLinkResolve([{ id: BLOCK_1, content: 'plain text' }]))

    // Allow the async effect's promise chain to settle.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  it('calls batchResolve with the uncached ids and caches each result', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked block A', block_type: 'content', deleted: false },
    ])

    renderHook(() => useBlockLinkResolve([{ id: BLOCK_1, content: `see [[${ULID_A}]]` }]))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], TEST_SPACE_ID)
    })

    await waitFor(() => {
      const cached = useResolveStore.getState().cache
      expect(cached.size).toBeGreaterThan(0)
    })
  })

  it('caches ids the backend did not return as deleted placeholders', async () => {
    mockedBatchResolve.mockResolvedValueOnce([])

    renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, content: `[[${ULID_A}]] and [[${ULID_B}]]` }]),
    )

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

    const { unmount } = renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, content: `[[${ULID_A}]]` }]),
    )

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

    renderHook(() => useBlockLinkResolve([{ id: BLOCK_1, content: `[[${ULID_A}]]` }]))

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

describe('useBlockLinkResolve — content-signature memo guard (#1266)', () => {
  it('does NOT re-run the full-page scan when the block array is reallocated with unchanged ids+content', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
    ])

    // The scan (`collectUncachedLinkIds`) reads `useResolveStore.getState()`
    // exactly once per invocation, so a spy on `getState` is a faithful
    // counter for "did the expensive matchAll scan run?". (The store is
    // also read elsewhere, so we measure the *delta* across a rerender,
    // not an absolute count.)
    const getStateSpy = vi.spyOn(useResolveStore, 'getState')

    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [{ id: BLOCK_1, content: `see [[${ULID_A}]]` }] },
    })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })
    // Let the post-IPC writeback's store reads settle so the spy delta
    // below isolates *only* the rerender's scan (if any).
    await new Promise<void>((r) => queueMicrotask(r))
    const getStateCallsBefore = getStateSpy.mock.calls.length

    // Reallocate the outer array AND the block object, but keep id +
    // content byte-identical (simulates a keystroke-flush / indent that
    // produces a fresh array without touching link content).
    rerender({ blocks: [{ id: BLOCK_1, content: `see [[${ULID_A}]]` }] })
    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => queueMicrotask(r))

    // The memo guard kept `contentSignature` stable → the effect did not
    // re-fire → the scan did not run again → no new store read.
    expect(getStateSpy.mock.calls.length).toBe(getStateCallsBefore)
    getStateSpy.mockRestore()
  })

  it('DOES re-scan when a block`s content changes (new uncached token appears)', async () => {
    mockedBatchResolve.mockResolvedValue([])

    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [{ id: BLOCK_1, content: 'no links yet' }] },
    })

    // No tokens initially → no IPC.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(mockedBatchResolve).not.toHaveBeenCalled()

    // Edit the block to introduce a `[[ULID]]` token → signature changes
    // → effect re-fires → scan finds the uncached token → IPC fires.
    rerender({ blocks: [{ id: BLOCK_1, content: `now [[${ULID_B}]]` }] })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_B], TEST_SPACE_ID)
    })
  })

  it('does NOT re-fire on a different block`s content change unrelated to ids set', async () => {
    // Sanity: a content change anywhere bumps the signature and re-runs
    // the (cheap, local) scan — but the IPC stays guarded. Here BLOCK_2
    // gains plain text (no token), so no new IPC despite the re-scan.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
    ])

    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: {
        blocks: [
          { id: BLOCK_1, content: `[[${ULID_A}]]` },
          { id: BLOCK_2, content: 'plain' },
        ],
      },
    })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })
    const callsAfterFirst = mockedBatchResolve.mock.calls.length

    rerender({
      blocks: [
        { id: BLOCK_1, content: `[[${ULID_A}]]` },
        { id: BLOCK_2, content: 'plain edited' },
      ],
    })
    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => queueMicrotask(r))

    // Signature changed → effect re-fired → scan re-ran, but ULID_A is
    // now cached and BLOCK_2 has no token → no additional IPC.
    expect(mockedBatchResolve.mock.calls.length).toBe(callsAfterFirst)
  })
})

// 26-char Crockford base32 ULIDs to satisfy the [[ULID]] regex / id slices.
const ULID_C = '01TESTLINK0000000000ULIDC3'
const ULID_D = '01TESTLINK0000000000ULIDD4'

describe('fetchAndCacheLinks — single-batchSet writeback (#1072)', () => {
  it('resolving K links + M missing bumps version exactly ONCE', async () => {
    // K = 2 resolved, M = 2 missing (requested but not returned).
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
      { id: ULID_B, title: 'Linked B', block_type: 'content', deleted: false },
    ])

    const versionBefore = useResolveStore.getState().version
    let bumps = 0
    const unsub = useResolveStore.subscribe((s, prev) => {
      if (s.version !== prev.version) bumps += 1
    })

    await fetchAndCacheLinks(new Set([ULID_A, ULID_B, ULID_C, ULID_D]), TEST_SPACE_ID, () => false)
    unsub()

    // Exactly one version bump for the whole K+M batch (was K+M = 4 before #1072).
    expect(bumps).toBe(1)
    expect(useResolveStore.getState().version).toBe(versionBefore + 1)
  })

  it('writes the same titles/deleted flags as the old per-item set loops', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      // resolved with a title — cached verbatim (≤60 chars here).
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
      // resolved, deleted flag preserved.
      { id: ULID_B, title: 'Deleted B', block_type: 'content', deleted: true },
      // resolved with an empty title — falls back to the [[id…]] placeholder.
      { id: ULID_C, title: '', block_type: 'content', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A, ULID_B, ULID_C, ULID_D]), TEST_SPACE_ID, () => false)

    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_A))).toEqual({
      title: 'Linked A',
      deleted: false,
    })
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_B))).toEqual({
      title: 'Deleted B',
      deleted: true,
    })
    // Empty title → [[<first 8 of id>...]] fallback (matches old `set` loop).
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_C))).toEqual({
      title: `[[${ULID_C.slice(0, 8)}...]]`,
      deleted: false,
    })
    // Requested but not returned → deleted placeholder.
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_D))).toEqual({
      title: `[[${ULID_D.slice(0, 8)}...]]`,
      deleted: true,
    })
  })

  it('truncates resolved titles to 60 chars like the old loop', async () => {
    const longTitle = 'x'.repeat(120)
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: longTitle, block_type: 'content', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A]), TEST_SPACE_ID, () => false)

    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, ULID_A))).toEqual({
      title: longTitle.slice(0, 60),
      deleted: false,
    })
  })

  it('a fully-cached re-resolve causes ZERO version bumps', async () => {
    // First pass populates the cache.
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
      { id: ULID_B, title: 'Linked B', block_type: 'content', deleted: false },
    ])
    await fetchAndCacheLinks(new Set([ULID_A, ULID_B]), TEST_SPACE_ID, () => false)

    // Second pass returns identical results — batchSet must diff-and-no-op.
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked A', block_type: 'content', deleted: false },
      { id: ULID_B, title: 'Linked B', block_type: 'content', deleted: false },
    ])

    const versionBefore = useResolveStore.getState().version
    let bumps = 0
    const unsub = useResolveStore.subscribe((s, prev) => {
      if (s.version !== prev.version) bumps += 1
    })

    await fetchAndCacheLinks(new Set([ULID_A, ULID_B]), TEST_SPACE_ID, () => false)
    unsub()

    expect(bumps).toBe(0)
    expect(useResolveStore.getState().version).toBe(versionBefore)
  })
})
