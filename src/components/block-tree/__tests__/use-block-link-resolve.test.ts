/**
 * Tests for useBlockLinkResolve — scans loaded blocks for `[[ULID]]`
 * tokens not yet in the resolve cache and batch-fetches them via the
 * `batchResolve` IPC. Covers cache-membership filtering, space scoping,
 * answers that land after the rows moved on (#5443), and graceful error
 * handling.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import {
  collectUncachedLinkIds,
  fetchAndCacheLinks,
  useBlockLinkResolve,
} from '@/components/block-tree/use-block-link-resolve'
import type { ResolvedBlock } from '@/lib/bindings'
import { unresolvedBlockLabel } from '@/lib/block-title'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useResolveStore } from '@/stores/resolve'
import { keyFor } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

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

  // #4551 — the bug this widening fixes: a block reference is inserted as
  // `((ULID))` (`markdown-serialize.ts`), and before this widening the scan
  // regex only matched `[[ULID]]`, so a `((ULID))` id was never even
  // collected as "uncached" — it was invisible to the scan, not merely
  // skipped as already-cached.
  it('extracts ULID ids embedded in `((…))` block-ref tokens too, in the same pass as `[[…]]`', () => {
    const blocks = [{ content: `see ((${ULID_A})) for detail` }, { content: `[[${ULID_B}]]` }]
    const ids = collectUncachedLinkIds(blocks, TEST_SPACE_ID)
    expect(ids).toEqual(new Set([ULID_A, ULID_B]))
  })
})

// Block ids for the hook fixtures (the hook now keys its memo on
// id+content, so fixtures must carry an `id`).
const BLOCK_1 = '01TESTBLOCK000000000BLOCK1'
const BLOCK_2 = '01TESTBLOCK000000000BLOCK2'

describe('useBlockLinkResolve', () => {
  it('does nothing when no uncached link tokens exist', async () => {
    renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, block_type: 'content', content: 'plain text' }]),
    )

    // Allow the async effect's promise chain to settle.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  it('calls batchResolve with the uncached ids and caches each result', async () => {
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Linked block A', block_type: 'content', deleted: false },
    ])

    renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, block_type: 'content', content: `see [[${ULID_A}]]` }]),
    )

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], {
        kind: 'active',
        space_id: TEST_SPACE_ID,
      })
    })

    await waitFor(() => {
      const cached = useResolveStore.getState().cache
      expect(cached.size).toBeGreaterThan(0)
    })
  })

  // #4551 — the reported defect: a page mounted fresh (empty resolve store,
  // as on first load / a hard refresh) whose only reference is a
  // `((ULID))` block ref must still resolve it, exactly as it would for
  // `[[ULID]]`. The empty-store precondition is what makes this
  // non-vacuous: a pre-populated store would pass whether or not the scan
  // regex covers `((…))` at all.
  it('resolves a `((ULID))` block reference on a cold mount with an empty resolve store', async () => {
    expect(useResolveStore.getState().cache.size).toBe(0)
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: 'Referenced block', block_type: 'content', deleted: false },
    ])

    renderHook(() =>
      useBlockLinkResolve([
        { id: BLOCK_1, block_type: 'content', content: `see ((${ULID_A})) above` },
      ]),
    )

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], {
        kind: 'active',
        space_id: TEST_SPACE_ID,
      })
    })
    await waitFor(() => {
      expect(useResolveStore.getState().has(ULID_A)).toBe(true)
    })
  })

  it('caches ids the backend did not return as deleted placeholders', async () => {
    mockedBatchResolve.mockResolvedValueOnce([])

    renderHook(() =>
      useBlockLinkResolve([
        { id: BLOCK_1, block_type: 'content', content: `[[${ULID_A}]] and [[${ULID_B}]]` },
      ]),
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

  it('keeps an answer that lands after the hook unmounted (#5443)', async () => {
    let resolveBatch: (value: ResolvedBlock[]) => void = () => {}
    mockedBatchResolve.mockImplementationOnce(
      () =>
        new Promise<ResolvedBlock[]>((resolve) => {
          resolveBatch = resolve
        }),
    )

    const { unmount } = renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, block_type: 'content', content: `[[${ULID_A}]]` }]),
    )

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })

    unmount()
    resolveBatch([{ id: ULID_A, title: 'Late', block_type: 'content', deleted: false }])

    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Late')
    })
  })

  it('logs and swallows transport failures from batchResolve', async () => {
    mockedBatchResolve.mockRejectedValueOnce(new Error('transport-fail'))

    renderHook(() =>
      useBlockLinkResolve([{ id: BLOCK_1, block_type: 'content', content: `[[${ULID_A}]]` }]),
    )

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
      initialProps: {
        blocks: [{ id: BLOCK_1, block_type: 'content', content: `see [[${ULID_A}]]` }],
      },
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
    rerender({ blocks: [{ id: BLOCK_1, block_type: 'content', content: `see [[${ULID_A}]]` }] })
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
      initialProps: { blocks: [{ id: BLOCK_1, block_type: 'content', content: 'no links yet' }] },
    })

    // No tokens initially → no IPC.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(mockedBatchResolve).not.toHaveBeenCalled()

    // Edit the block to introduce a `[[ULID]]` token → signature changes
    // → effect re-fires → scan finds the uncached token → IPC fires.
    rerender({ blocks: [{ id: BLOCK_1, block_type: 'content', content: `now [[${ULID_B}]]` }] })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_B], {
        kind: 'active',
        space_id: TEST_SPACE_ID,
      })
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
          { id: BLOCK_1, block_type: 'content', content: `[[${ULID_A}]]` },
          { id: BLOCK_2, block_type: 'content', content: 'plain' },
        ],
      },
    })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })
    const callsAfterFirst = mockedBatchResolve.mock.calls.length

    rerender({
      blocks: [
        { id: BLOCK_1, block_type: 'content', content: `[[${ULID_A}]]` },
        { id: BLOCK_2, block_type: 'content', content: 'plain edited' },
      ],
    })
    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => queueMicrotask(r))

    // Signature changed → effect re-fired → scan re-ran, but ULID_A is
    // now cached and BLOCK_2 has no token → no additional IPC.
    expect(mockedBatchResolve.mock.calls.length).toBe(callsAfterFirst)
  })
})

describe('useBlockLinkResolve — answers that land after the rows moved on (#5443)', () => {
  interface HeldCall {
    ids: string[]
    resolve: (rows: ResolvedBlock[]) => void
  }

  afterEach(() => {
    mockedBatchResolve.mockReset()
  })

  /** Every call stays unanswered until the test answers it. */
  function holdBatchResolve(): HeldCall[] {
    const held: HeldCall[] = []
    mockedBatchResolve.mockImplementation(
      (ids: string[]) =>
        new Promise<ResolvedBlock[]>((resolve) => {
          held.push({ ids, resolve })
        }),
    )
    return held
  }

  const resolved = (id: string, title: string): ResolvedBlock => ({
    id,
    title,
    block_type: 'content',
    deleted: false,
  })
  const rowLinking = (id: string, target: string) => ({
    id,
    block_type: 'content',
    content: `see [[${target}]]`,
  })

  it('keeps an answer for its ids after the rows moved on, and does not ask for them again', async () => {
    const held = holdBatchResolve()
    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [rowLinking(BLOCK_1, ULID_A)] },
    })
    await waitFor(() => expect(held).toHaveLength(1))

    rerender({ blocks: [rowLinking(BLOCK_2, ULID_B)] })
    await waitFor(() => expect(held).toHaveLength(2))
    held[0]?.resolve([resolved(ULID_A, 'Target A')])
    held[1]?.resolve([resolved(ULID_B, 'Target B')])
    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Target A')
    })

    rerender({ blocks: [rowLinking(BLOCK_1, ULID_A), rowLinking(BLOCK_2, ULID_B)] })
    await new Promise<void>((r) => queueMicrotask(r))
    expect(held.map((c) => c.ids)).toEqual([[ULID_A], [ULID_B]])
  })

  it('does not ask again for an id whose answer is still in flight', async () => {
    const held = holdBatchResolve()
    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [rowLinking(BLOCK_1, ULID_A)] },
    })
    await waitFor(() => expect(held).toHaveLength(1))

    rerender({ blocks: [rowLinking(BLOCK_1, ULID_A), rowLinking(BLOCK_2, ULID_B)] })
    await waitFor(() => expect(held).toHaveLength(2))
    expect(held.map((c) => c.ids)).toEqual([[ULID_A], [ULID_B]])
  })

  it('a space switch drops the answer in flight and asks again in the new space', async () => {
    const held = holdBatchResolve()
    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [rowLinking(BLOCK_1, ULID_A)] },
    })
    await waitFor(() => expect(held).toHaveLength(1))

    useSpaceStore.setState({ currentSpaceId: 'SPACE_OTHER' })
    rerender({ blocks: [{ ...rowLinking(BLOCK_1, ULID_A), content: `again [[${ULID_A}]]` }] })
    await waitFor(() => expect(held).toHaveLength(2))
    expect(held[1]?.ids).toEqual([ULID_A])

    held[1]?.resolve([resolved(ULID_A, 'From the second space')])
    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('From the second space')
    })
    held[0]?.resolve([resolved(ULID_A, 'From the first space')])
    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => queueMicrotask(r))
    expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('From the second space')
    expect(useResolveStore.getState().cache.size).toBe(1)
  })

  it('asks again for an id once its answer landed and the cache dropped it', async () => {
    const held = holdBatchResolve()
    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [rowLinking(BLOCK_1, ULID_A)] },
    })
    await waitFor(() => expect(held).toHaveLength(1))
    held[0]?.resolve([resolved(ULID_A, 'Target A')])
    await waitFor(() => expect(useResolveStore.getState().has(ULID_A)).toBe(true))

    useResolveStore.getState().clearAllForSpace(TEST_SPACE_ID)
    rerender({ blocks: [{ ...rowLinking(BLOCK_1, ULID_A), content: `again [[${ULID_A}]]` }] })
    await waitFor(() => expect(held).toHaveLength(2))
    expect(held[1]?.ids).toEqual([ULID_A])
  })
})

describe('useBlockLinkResolve — chips follow the tree’s own rows (#5245)', () => {
  it('re-titles a cached entry when its block is edited, and undeletes it once back', async () => {
    // Another block's `((BLOCK_1))` chip resolved it once; then it was deleted.
    useResolveStore.getState().set(BLOCK_1, 'Buy milk', true)

    const { rerender } = renderHook(({ blocks }) => useBlockLinkResolve(blocks), {
      initialProps: { blocks: [{ id: BLOCK_2, block_type: 'content', content: 'other' }] },
    })
    await new Promise<void>((r) => queueMicrotask(r))
    expect(useResolveStore.getState().resolveStatus(BLOCK_1)).toBe('deleted')

    // Undo brings the block back into the tree, edited.
    rerender({
      blocks: [
        { id: BLOCK_1, block_type: 'content', content: 'Buy oat milk\nsecond line' },
        { id: BLOCK_2, block_type: 'content', content: 'other' },
      ],
    })

    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(BLOCK_1)).toBe('Buy oat milk')
    })
    expect(useResolveStore.getState().resolveStatus(BLOCK_1)).toBe('active')
    // A row no chip references stays out of the cache.
    expect(useResolveStore.getState().has(BLOCK_2)).toBe(false)
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
      // #4228 — resolved with an empty title now gets the SAME "Untitled"
      // placeholder every other seed call site uses for blank content
      // (`normalizeBlockRefTitle`, `@/lib/block-title`), not the `[[id…]]`
      // broken-link shape the pre-#4228 seed wrote here — that shape is
      // reserved for a target the backend didn't return at all (ULID_D,
      // below), a different situation from "resolved, but blank".
      { id: ULID_C, title: '', block_type: 'content', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A, ULID_B, ULID_C, ULID_D]), TEST_SPACE_ID, () => false)

    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_A))).toEqual({
      title: 'Linked A',
      deleted: false,
      resolved: true,
    })
    // #4238 — `deleted: true` and `resolved: true` together, which is the
    // whole reason the cache-miss signal could NOT be folded into `deleted`:
    // a soft-deleted block comes back from `batch_resolve` with its real
    // title, so it is a perfectly ordinary resolution.
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_B))).toEqual({
      title: 'Deleted B',
      deleted: true,
      resolved: true,
    })
    // Empty title (resolved, blank content) → "Untitled" placeholder, and
    // still `resolved: true`: the row exists, it just has no name.
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_C))).toEqual({
      title: t('block.untitled'),
      deleted: false,
      resolved: true,
    })
    // Requested but not returned → the one entry in the cache that means
    // "the backend handed us nothing". #4238 moved that verdict onto
    // `resolved`; the label is still stored so a direct `.title` reader
    // agrees with the resolvers.
    expect(cache.get(keyFor(TEST_SPACE_ID, ULID_D))).toEqual({
      title: unresolvedBlockLabel(ULID_D),
      deleted: true,
      resolved: false,
    })
  })

  // #4228 — the old loop hard-cut at exactly 60 chars with no ellipsis
  // (`.slice(0, 60)`); the shared seed normalisation caps at 60 chars
  // WITH a trailing `...` (57 chars of content + `...`), matching what
  // `searchBlockRefs` and `handleNavigate` write for the same-length input.
  it('writes a long PAGE title verbatim — capping it would break the leaf-name split', async () => {
    // `batch_resolve` returns `b.content` for EVERY block type, so a page's
    // namespaced path arrives here too. `renderBlockLink` splits the stored
    // title via `getPageDisplayName(title, 'leaf')`; a cap that lands before
    // the last `/` yields a namespace segment as the page name, and one that
    // lands after it truncates the leaf. `preload` also writes `p.content`
    // verbatim under this same key, so capping here re-opens the divergence
    // #4228 exists to close.
    const longPath = `Engineering/Platform/Observability/${'z'.repeat(40)}`
    expect(longPath.length).toBeGreaterThan(60)
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: longPath, block_type: 'page', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A]), TEST_SPACE_ID, () => false)

    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, ULID_A))).toEqual({
      title: longPath,
      deleted: false,
      resolved: true,
    })
  })

  it('writes a long TAG name verbatim too — same reason, same gate', async () => {
    const longTag = `area/${'t'.repeat(80)}`
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: longTag, block_type: 'tag', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A]), TEST_SPACE_ID, () => false)

    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, ULID_A))?.title).toBe(longTag)
  })

  it('caps resolved titles to 60 chars (57 + ellipsis) like the shared seed normalisation', async () => {
    const longTitle = 'x'.repeat(120)
    mockedBatchResolve.mockResolvedValueOnce([
      { id: ULID_A, title: longTitle, block_type: 'content', deleted: false },
    ])

    await fetchAndCacheLinks(new Set([ULID_A]), TEST_SPACE_ID, () => false)

    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, ULID_A))).toEqual({
      title: `${'x'.repeat(57)}...`,
      deleted: false,
      resolved: true,
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
