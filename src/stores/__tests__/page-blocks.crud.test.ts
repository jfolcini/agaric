// Split from the page-blocks.test.ts monolith (#2929). Concern: block CRUD
// lifecycle — load, membership-rejection healing, createBelow, edit, remove,
// appendBlock.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { t as translate } from '@/lib/i18n'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { properties, seedBlocks, SEED_IDS } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, selectTabsForSpace, type Tab, useTabsStore } from '@/stores/tabs'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'

// #1258 — `load_page_subtree` now returns `{ blocks, truncated, total }`
// (the `PageSubtree` wrapper) instead of a bare `BlockRow[]`. `load()` reads
// `.blocks` and surfaces `.truncated`/`.total`. This helper wraps a row array
// in the un-truncated shape so the many `load()` mocks below keep their
// intent (a full, non-truncated page load) without each spelling out the
// wrapper. See the dedicated truncation test for the `truncated: true` path.
function subtreeResp<T>(blocks: T[]): { blocks: T[]; truncated: boolean; total: number } {
  return { blocks, truncated: false, total: blocks.length }
}

// #2849 PR2 — `createBelow` now generates the new block's id CLIENT-SIDE (a
// ULID) BEFORE the create IPC, so the row can be spliced in optimistically. Mock
// the generator deterministically (`CID_1`, `CID_2`, …, reset per test) so tests
// can address the new block by a stable, predictable id instead of a random
// ULID. `resetClientIds` runs in `beforeEach`.
const { newBlockIdMock, resetClientIds } = vi.hoisted(() => {
  let counter = 0
  return {
    newBlockIdMock: () => `CID_${++counter}`,
    resetClientIds: () => {
      counter = 0
    },
  }
})
vi.mock('@/lib/block-id', () => ({
  newBlockId: newBlockIdMock,
}))

// --- Mock for undo store (used by notifyUndoNewAction in page-blocks.ts) ---
const mockOnNewAction = vi.fn()
const mockClearPage = vi.fn()
vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({
      onNewAction: mockOnNewAction,
      clearPage: mockClearPage,
    }),
  },
}))

// Mock the global block store (focus/selection) — page-blocks.ts imports it for cross-store updates
let mockGlobalBlockState = {
  focusedBlockId: null as string | null,
  selectedBlockIds: [] as string[],
}
const mockGlobalSetState = vi.fn()
// #773 — load() clears phantom focus via the store ACTION (setFocused), not
// raw setState. Mirror the real action's semantics (clearing focus also
// clears the coupled selection) so state assertions hold after the call.
const mockSetFocused = vi.fn((blockId: string | null) => {
  mockGlobalBlockState = { focusedBlockId: blockId, selectedBlockIds: [] }
})
// #798 — load() prunes remotely-deleted ids from the global selection via the
// store ACTION (setSelected). Mirror the real action so post-load assertions
// can read the pruned selection back off the mock.
const mockSetSelected = vi.fn((ids: string[]) => {
  mockGlobalBlockState = { ...mockGlobalBlockState, selectedBlockIds: ids }
})
vi.mock('@/stores/blocks', () => ({
  useBlockStore: {
    getState: () => ({
      ...mockGlobalBlockState,
      setFocused: mockSetFocused,
      setSelected: mockSetSelected,
    }),
    setState: (...args: unknown[]) => mockGlobalSetState(...args),
  },
}))

let store: StoreApi<PageBlockState>

describe('PageBlockStore', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }
    // FE-H-22 — `load()` now early-returns when `currentSpaceId` is
    // null/undefined (pre-bootstrap). Seed the space store so the
    // existing post-bootstrap load tests still drive the IPC path.
    // The pre-bootstrap no-op contract is exercised in its own test.
    useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
    vi.clearAllMocks()
    // #2849 PR2 — reset the client-ULID counter so each test's first
    // `createBelow` mints `CID_1` deterministically.
    resetClientIds()
    // #2850 — the prefetch map is a module-level singleton; reset it so a
    // prefetch parked by one test can never leak into the next.
    _resetPrefetchPageSubtreeForTest()
  })

  describe('load', () => {
    it('fetches blocks from the backend and stores them with depth', async () => {
      const blocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ]
      mockedInvoke.mockResolvedValueOnce(subtreeResp(blocks))

      await store.getState().load()

      const result = store.getState().blocks
      expect(result).toHaveLength(2)
      expect(result[0]?.id).toBe('A')
      expect(result[0]?.depth).toBe(0)
      expect(result[1]?.id).toBe('B')
      expect(store.getState().loading).toBe(false)
    })

    // #1258 — when the backend caps the page at PAGE_SUBTREE_MAX_BLOCKS it
    // returns `truncated: true` + the true `total`. The store surfaces this as
    // `truncatedTotal` (the true total) so BlockTree can render a non-blocking
    // "showing the first N of M" notice. A non-truncated load clears it.
    it('surfaces truncatedTotal when the backend caps the page (#1258)', async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      // total > blocks.length — the cap fired, descendants were dropped.
      mockedInvoke.mockResolvedValueOnce({ blocks, truncated: true, total: 10_005 })

      await store.getState().load()

      expect(store.getState().truncatedTotal).toBe(10_005)
      expect(store.getState().blocks).toHaveLength(1)
    })

    it('clears truncatedTotal on a subsequent non-truncated load (#1258)', async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      mockedInvoke.mockResolvedValueOnce({ blocks, truncated: true, total: 10_005 })
      await store.getState().load()
      expect(store.getState().truncatedTotal).toBe(10_005)

      mockedInvoke.mockResolvedValueOnce(subtreeResp(blocks))
      await store.getState().load()
      expect(store.getState().truncatedTotal).toBeNull()
    })

    it('sets loading=true while the request is in flight', async () => {
      let resolvePromise!: (v: unknown) => void
      const pending = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockedInvoke.mockReturnValueOnce(pending)

      const loadPromise = store.getState().load()
      expect(store.getState().loading).toBe(true)

      resolvePromise([])
      await loadPromise

      expect(store.getState().loading).toBe(false)
    })

    it('resets loading on error without changing blocks', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await store.getState().load()

      expect(store.getState().loading).toBe(false)
      expect(store.getState().blocks).toEqual([])
    })

    it('#2926 — a failed load shows a retry toast whose action re-invokes load()', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await store.getState().load()

      expect(toast.error).toHaveBeenCalledWith(
        translate('error.loadBlocksFailed'),
        expect.objectContaining({
          id: 'load-blocks-failed',
          action: expect.objectContaining({ onClick: expect.any(Function) }),
        }),
      )

      // Simulate the user clicking the toast's "Retry" action: it should
      // re-invoke load(), issuing a fresh IPC call and (on success)
      // recovering the tree.
      mockedInvoke.mockResolvedValueOnce(subtreeResp([]))
      const [, opts] = vi.mocked(toast.error).mock.calls.at(-1) as unknown as [
        unknown,
        { action: { onClick: () => void } },
      ]
      opts.action.onClick()
      await vi.waitFor(() => {
        expect(store.getState().loading).toBe(false)
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(2)
    })

    it('passes rootBlockId through to load_page_subtree', async () => {
      const s = createPageBlockStore('PARENT_42')
      mockedInvoke.mockResolvedValue(subtreeResp([]))

      await s.getState().load()

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PARENT_42' }),
      )
    })

    it('#753 — overlapping loads of the same page: the latest-started load wins', async () => {
      const resolvers: Array<(v: unknown) => void> = []
      mockedInvoke.mockImplementation(async () => new Promise((resolve) => resolvers.push(resolve)))

      // Two loads for the SAME page overlap (e.g. a sync:complete reload
      // racing a mount load). `rootParentId` is identical for both, so
      // the old guard could never discard either.
      const load1 = store.getState().load()
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      const load2 = store.getState().load()
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))

      // The NEWER load's snapshot arrives first and commits.
      resolvers[1]?.(subtreeResp([makeBlock({ id: 'FRESH', parent_id: 'PAGE_1' })]))
      await load2
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['FRESH'])
      expect(store.getState().loading).toBe(false)

      // The STALE snapshot resolves last — last-resolve-wins would
      // clobber FRESH with STALE here. The generation guard discards it.
      resolvers[0]?.(subtreeResp([makeBlock({ id: 'STALE', parent_id: 'PAGE_1' })]))
      await load1
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['FRESH'])
      expect(store.getState().blocksById.has('STALE')).toBe(false)
      expect(store.getState().loading).toBe(false)
    })

    it('#753 — a stale FAILED load neither resets the newer load’s loading flag nor toasts', async () => {
      let rejectStale!: (e: unknown) => void
      const resolvers: Array<(v: unknown) => void> = []
      mockedInvoke
        .mockImplementationOnce(
          async () =>
            new Promise((_resolve, reject) => {
              rejectStale = reject
            }),
        )
        .mockImplementationOnce(async () => new Promise((resolve) => resolvers.push(resolve)))

      const load1 = store.getState().load()
      await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1))
      const load2 = store.getState().load()
      await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2))

      // The stale load fails while the newer one is still in flight —
      // it must not flip `loading` back to false (the newer load owns
      // the flag) and must not surface an error toast for a snapshot
      // nobody wants.
      rejectStale(new Error('stale failure'))
      await load1
      expect(store.getState().loading).toBe(true)
      expect(toast.error).not.toHaveBeenCalled()

      resolvers[0]?.(subtreeResp([]))
      await load2
      expect(store.getState().loading).toBe(false)
    })

    it('preserves focused block content during sync reload', async () => {
      // Pre-populate store with blocks (simulating user editing block A)
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'user is typing here' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'original B' })
      store.setState({ blocks: [blockA, blockB] })

      // Simulate block A being focused (user is editing it)
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      // Backend returns different (stale) content for block A
      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old backend content' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'updated B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(subtreeResp(backendBlocks))

      await store.getState().load()

      const result = store.getState().blocks
      // Focused block A should preserve its pre-load content
      expect(result.find((b) => b.id === 'A')?.content).toBe('user is typing here')
      // Non-focused block B should be updated from backend
      expect(result.find((b) => b.id === 'B')?.content).toBe('updated B from backend')
    })

    it('updates non-focused blocks from backend during sync reload', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      const blockC = makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'old C' })
      store.setState({ blocks: [blockA, blockB, blockC] })

      // Only block B is focused
      mockGlobalBlockState = { focusedBlockId: 'B', selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
        makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'new C from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(subtreeResp(backendBlocks))

      await store.getState().load()

      const result = store.getState().blocks
      // Non-focused blocks A and C should be updated
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'C')?.content).toBe('new C from backend')
      // Focused block B should preserve its pre-load content
      expect(result.find((b) => b.id === 'B')?.content).toBe('old B')
    })

    it('updates all blocks when no block is focused (normal reload)', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      store.setState({ blocks: [blockA, blockB] })

      // No block is focused
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(subtreeResp(backendBlocks))

      await store.getState().load()

      const result = store.getState().blocks
      // All blocks should be updated from backend
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'B')?.content).toBe('new B from backend')
    })

    it('FE-H-22 — skips IPC entirely when currentSpaceId is null (pre-bootstrap)', async () => {
      // Pre-bootstrap state: the space store has not hydrated yet.
      // Earlier code would forward `?? ''` to the page-load IPC and
      // rely on the backend treating `''` as a no-match SQL filter.
      // We now fail closed: no IPC, no block-state change.
      useSpaceStore.setState({ currentSpaceId: null })
      const blocksBefore = store.getState().blocks

      await store.getState().load()

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(store.getState().blocks).toBe(blocksBefore)
    })

    // #2921 — a stuck `loading: true` with no `currentSpaceId` left every
    // BlockTree mounted in that window on a perpetual skeleton (nothing
    // else ever re-invokes `load()` for it). `load()` must clear `loading`
    // even on this early-return path.
    it('#2921 — clears loading (no perpetual skeleton) when currentSpaceId is null', async () => {
      useSpaceStore.setState({ currentSpaceId: null })
      expect(store.getState().loading).toBe(true)

      await store.getState().load()

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(store.getState().loading).toBe(false)
    })

    // ── #773 — sync-delete focus reconciliation ─────────────────────────
    it('#773 — clears global focus when a sync-delete + registry reload drops the focused block', async () => {
      // The store owns the focused block before the reload.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'focused' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'other' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      // Registry-wide reload — exactly what useSyncEvents' sync:complete
      // handler does (now via `forEachPageStore`). The fresh backend snapshot
      // no longer contains A (a remote peer deleted it).
      mockedInvoke.mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'B', parent_id: 'PAGE_1' })]))
      await store.getState().load()

      expect(mockSetFocused).toHaveBeenCalledWith(null)
      expect(mockGlobalBlockState.focusedBlockId).toBeNull()
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B'])
    })

    it('#773 — retains focus when the focused block survives the reload', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'focused' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'other' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'from backend' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'from backend' }),
        ]),
      )
      await store.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('A')
    })

    it('#773 — does not clear focus owned by another page when THIS store reloads (no spurious clears)', async () => {
      // Focus belongs to a block on page A; this store is page B and has
      // never contained that block (e.g. ordinary navigation load, or one
      // of N journal-day trees reloading after sync). Ownership pre-check
      // fails → focus must stay untouched even though the snapshot lacks
      // the focused id.
      const pageB = createPageBlockStore('PAGE_B')
      pageB.setState({ blocks: [makeBlock({ id: 'X', parent_id: 'PAGE_B' })] })
      mockGlobalBlockState = { focusedBlockId: 'BLOCK_ON_PAGE_A', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'X', parent_id: 'PAGE_B' })]))
      await pageB.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('BLOCK_ON_PAGE_A')
    })

    it('#773 — does not clear focus on a block created and focused while the load was in flight', async () => {
      // Race: a sync-triggered load() is in flight (its backend snapshot was
      // taken at query time) when the user presses Enter — createBelow's
      // optimistic splice adds block N to blocksById and focus moves to N
      // BEFORE the stale load response is processed. N is absent from the
      // snapshot because the snapshot predates it, NOT because a remote peer
      // deleted it. The clear guard must compare against the load-START
      // index, so N's mid-flight arrival cannot be mistaken for a deletion.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      let resolveLoad!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      )
      const loadPromise = store.getState().load()

      // Mid-flight: optimistic create lands N in the store and focus moves.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'N', parent_id: 'PAGE_1', content: 'just created' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'N', selectedBlockIds: [] }

      // Stale snapshot: predates N's insert.
      resolveLoad(subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1' })]))
      await loadPromise

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('N')
    })

    it('#773 — fresh-mount load (empty store) never clears a focus id absent from the snapshot', async () => {
      // Page-navigation case: a brand-new store loads while some focus id
      // is still set globally. The store never owned the block (blocksById
      // is empty pre-load), so it must not clear focus — that lifecycle is
      // managed elsewhere.
      const fresh = createPageBlockStore('PAGE_NAV')
      mockGlobalBlockState = { focusedBlockId: 'STALE_FOCUS', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([makeBlock({ id: 'Y', parent_id: 'PAGE_NAV' })]),
      )
      await fresh.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('STALE_FOCUS')
    })

    // ── #798 — prune remotely-deleted ids from the selection ────────────
    it('#798 — drops a remotely-deleted block id from selectedBlockIds on reload', async () => {
      // The store owns blocks A + B before the reload; both are selected.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }

      // Fresh backend snapshot lost B (a remote peer deleted it).
      mockedInvoke.mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1' })]))
      await store.getState().load()

      // B is pruned; the surviving id A stays selected.
      expect(mockSetSelected).toHaveBeenCalledWith(['A'])
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A'])
    })

    it('#798 — does not touch the selection when every selected id survives', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }

      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
        ]),
      )
      await store.getState().load()

      // No change → no setSelected call (avoids a needless selection churn).
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'B'])
    })

    it('#798 — preserves a selected id this store never owned (managed elsewhere)', async () => {
      // A selected id belonging to another page (this store never held it):
      // absent from the snapshot, but the load-START ownership guard means
      // its absence proves nothing here — it must survive.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'OTHER_PAGE_BLK'] }

      mockedInvoke.mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1' })]))
      await store.getState().load()

      // A survives (still present); OTHER_PAGE_BLK survives (never owned).
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'OTHER_PAGE_BLK'])
    })

    it('#798 — does not prune a block created+selected while the load was in flight', async () => {
      // Mirror of the #773 mid-flight guard for selection: a block spliced
      // in (and selected) AFTER the load started is absent from the snapshot
      // because the snapshot predates it, NOT because of a remote delete.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A'] }

      let resolveLoad!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      )
      const loadPromise = store.getState().load()

      // Mid-flight: optimistic create lands N and selects it.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'N', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'N'] }

      // Snapshot predates N.
      resolveLoad(subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1' })]))
      await loadPromise

      // N must NOT be pruned (load-START guard); A survives → no change.
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'N'])
    })
  })
  describe('#2802 stale old-space reference heals on membership rejection', () => {
    const OTHER_SPACE = 'SPACE_OTHER'

    /**
     * The `AppError` wire shape `load_page_subtree` rejects with (backend +
     * mock parity, #2463 / #2810) — coded `PageNotInSpace` so the heal below
     * can key on the structured code rather than the generic `kind`.
     */
    function membershipRejection(pageId: string): Error {
      const message = `block '${pageId}' not in current space '${TEST_SPACE_ID}'`
      return Object.assign(new Error(message), {
        kind: 'validation',
        code: 'PageNotInSpace',
        message,
      })
    }

    /**
     * #2810 — a validation rejection that is NOT the space-membership one
     * (e.g. a different coded validation, or an uncoded one). Proves the
     * heal discriminates on the specific `PageNotInSpace` code rather than
     * the generic `kind: 'validation'` — message-regexing was retired in
     * #2251 and `kind === 'validation'` alone would be equally fragile.
     */
    function otherValidationRejection(message: string): Error {
      return Object.assign(new Error(message), { kind: 'validation', message })
    }

    function tab(id: string, pageStack: Array<{ pageId: string; title: string }>): Tab {
      return { id, pageStack, label: pageStack.at(-1)?.title ?? '' }
    }

    beforeEach(() => {
      // The tabs / recent-pages / navigation stores are module singletons —
      // reset them so state from earlier tests (or the previous test in this
      // block) can't leak into the heal-path assertions.
      useNavigationStore.setState({ currentView: 'page-editor' })
      useTabsStore.setState({
        tabs: [tab('0', [])],
        activeTabIndex: 0,
        tabsBySpace: {},
        activeTabIndexBySpace: {},
      })
      useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
    })

    afterEach(() => {
      // The real-dispatch test installs a persistent mockImplementation;
      // vitest has no global mockReset, so drop it explicitly to keep the
      // rest of this file's `mockResolvedValueOnce`-style tests isolated.
      mockedInvoke.mockReset()
    })

    it('shows the soft moved-notice (not the raw error toast) and pops the stale top-of-stack entry', async () => {
      useTabsStore.setState({
        tabs: [
          tab('0', [
            { pageId: 'OTHER', title: 'Other page' },
            { pageId: 'PAGE_1', title: 'Moved page' },
          ]),
        ],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: {
          [TEST_SPACE_ID]: [
            { pageId: 'PAGE_1', title: 'Moved page' },
            { pageId: 'KEEP', title: 'Kept page' },
          ],
          // A DIFFERENT space's slice referencing the same page — must
          // survive untouched (the page still legitimately lives there).
          [OTHER_SPACE]: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        },
      })
      mockedInvoke.mockRejectedValueOnce(membershipRejection('PAGE_1'))

      await store.getState().load()

      // Soft notice instead of the generic failure toast.
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledWith(
        translate('error.pageNotInCurrentSpace'),
        expect.objectContaining({ id: 'page-not-in-space' }),
      )
      expect(store.getState().loading).toBe(false)

      // Stale entry popped from the active tab (back to the previous page),
      // mirroring the delete flow's navigate-away.
      expect(selectPageStack(useTabsStore.getState()).map((p) => p.pageId)).toEqual(['OTHER'])

      // Old-space recents cleaned; other entries and other spaces untouched.
      const bySpace = useRecentPagesStore.getState().recentPagesBySpace
      expect(bySpace[TEST_SPACE_ID]?.map((p) => p.pageId)).toEqual(['KEEP'])
      expect(bySpace[OTHER_SPACE]?.map((p) => p.pageId)).toEqual(['PAGE_1'])
    })

    it('leaves the tab stack alone when the rejected page is NOT the active tab top (background reload)', async () => {
      useTabsStore.setState({
        tabs: [tab('0', [{ pageId: 'OTHER', title: 'Other page' }])],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: { [TEST_SPACE_ID]: [{ pageId: 'PAGE_1', title: 'Moved page' }] },
      })
      mockedInvoke.mockRejectedValueOnce(membershipRejection('PAGE_1'))

      await store.getState().load()

      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledWith(
        translate('error.pageNotInCurrentSpace'),
        expect.objectContaining({ id: 'page-not-in-space' }),
      )
      // The active tab shows a DIFFERENT page — goBack must not fire.
      expect(selectPageStack(useTabsStore.getState()).map((p) => p.pageId)).toEqual(['OTHER'])
      // The stale recents entry is still cleaned.
      expect(useRecentPagesStore.getState().recentPagesBySpace[TEST_SPACE_ID]).toEqual([])
    })

    it('keeps the generic error toast (and touches no nav state) for non-validation failures', async () => {
      useTabsStore.setState({
        tabs: [tab('0', [{ pageId: 'PAGE_1', title: 'Moved page' }])],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: { [TEST_SPACE_ID]: [{ pageId: 'PAGE_1', title: 'Moved page' }] },
      })
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await store.getState().load()

      expect(toast.info).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        translate('error.loadBlocksFailed'),
        expect.objectContaining({ id: 'load-blocks-failed' }),
      )
      expect(selectPageStack(useTabsStore.getState()).map((p) => p.pageId)).toEqual(['PAGE_1'])
      expect(
        useRecentPagesStore.getState().recentPagesBySpace[TEST_SPACE_ID]?.map((p) => p.pageId),
      ).toEqual(['PAGE_1'])
    })

    it('#2810 — keeps the generic error toast (and touches no nav state) for a validation error that is NOT PageNotInSpace-coded', async () => {
      useTabsStore.setState({
        tabs: [tab('0', [{ pageId: 'PAGE_1', title: 'Moved page' }])],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: { [TEST_SPACE_ID]: [{ pageId: 'PAGE_1', title: 'Moved page' }] },
      })
      mockedInvoke.mockRejectedValueOnce(otherValidationRejection('some other validation failure'))

      await store.getState().load()

      // Discrimination proof: `kind: 'validation'` alone does NOT trigger
      // the heal — only the `PageNotInSpace` code does.
      expect(toast.info).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        translate('error.loadBlocksFailed'),
        expect.objectContaining({ id: 'load-blocks-failed' }),
      )
      expect(selectPageStack(useTabsStore.getState()).map((p) => p.pageId)).toEqual(['PAGE_1'])
      expect(
        useRecentPagesStore.getState().recentPagesBySpace[TEST_SPACE_ID]?.map((p) => p.pageId),
      ).toEqual(['PAGE_1'])
    })

    it('skips the heal when the active space changed while the rejection was in flight', async () => {
      // Race: the stale-ref load is scoped to TEST_SPACE_ID, but the user
      // switches to the page's NEW space before the rejection resolves.
      // Healing then would operate on the wrong space — `removeRecentPage`
      // keys on the CURRENT active space and `goBack` pops the CURRENT
      // active slice — purging a recents entry / tab entry where the page
      // legitimately lives. The guard must skip the heal entirely (lazy
      // heal re-fires on the next follow of the still-stale reference).
      useTabsStore.setState({
        tabs: [tab('0', [{ pageId: 'PAGE_1', title: 'Moved page' }])],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: {
          // The page's new home — exactly what a wrong-space heal would purge.
          [OTHER_SPACE]: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        },
      })
      mockedInvoke.mockRejectedValueOnce(membershipRejection('PAGE_1'))

      // Kick off the load (captures spaceId = TEST_SPACE_ID synchronously),
      // switch spaces BEFORE the rejection lands, then let it settle.
      const pending = store.getState().load()
      useSpaceStore.setState({ currentSpaceId: OTHER_SPACE })
      await pending

      // No heal, no toast of either kind, nothing popped or purged. The
      // space-switch subscriber flushed the flat mirror into the old space's
      // slice and pulled OTHER_SPACE's slice into the flat fields — exactly
      // the state a guard-less heal would corrupt (goBack / removeRecentPage
      // act on the ACTIVE = OTHER_SPACE partition).
      expect(toast.info).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      // Old space's slice keeps the stale ref (heals lazily on next follow).
      expect(
        selectTabsForSpace(useTabsStore.getState(), TEST_SPACE_ID)[0]?.pageStack.map(
          (p) => p.pageId,
        ),
      ).toEqual(['PAGE_1'])
      // The new (active) space's recents — where the page legitimately
      // lives — survive untouched.
      expect(useRecentPagesStore.getState().recentPages.map((p) => p.pageId)).toEqual(['PAGE_1'])
      expect(store.getState().loading).toBe(false)
    })

    it('heals end-to-end against the REAL tauri-mock dispatch rejection shape (#2463 parity)', async () => {
      // Route `invoke` through the real mock handlers so the rejection is
      // the genuine `load_page_subtree` membership `validation` AppError —
      // pins the `isValidation` branch to the production wire shape
      // (pattern from the #2792 PagePropertyTable real-dispatch tests).
      seedBlocks()
      useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
      const s = createPageBlockStore(SEED_IDS.PAGE_QUICK_NOTES)

      // Sanity: while the page still belongs to Personal, load succeeds.
      await s.getState().load()
      expect(s.getState().blocks.length).toBeGreaterThan(0)
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.info).not.toHaveBeenCalled()

      // Simulate the move: re-stamp the page's `space` ref to another space
      // (what `set_property` writes under PageHeader.handleMoveToSpace).
      properties.get(SEED_IDS.PAGE_QUICK_NOTES)?.set('space', {
        block_id: SEED_IDS.PAGE_QUICK_NOTES,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: 'SPACE_WORK',
        value_bool: null,
      })

      // Stale old-space state: the moved page tops the ONLY tab and sits in
      // the old space's recents.
      useNavigationStore.getState().setView('page-editor')
      useTabsStore.setState({
        tabs: [tab('0', [{ pageId: SEED_IDS.PAGE_QUICK_NOTES, title: 'Quick Notes' }])],
        activeTabIndex: 0,
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: SEED_IDS.PAGE_QUICK_NOTES, title: 'Quick Notes' }],
        recentPagesBySpace: {
          SPACE_PERSONAL: [{ pageId: SEED_IDS.PAGE_QUICK_NOTES, title: 'Quick Notes' }],
        },
      })

      await s.getState().load()

      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledWith(
        translate('error.pageNotInCurrentSpace'),
        expect.objectContaining({ id: 'page-not-in-space' }),
      )
      // Last tab emptied → tab reset + pages view (same landing as delete).
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
      expect(useNavigationStore.getState().currentView).toBe('pages')
      expect(useRecentPagesStore.getState().recentPagesBySpace['SPACE_PERSONAL']).toEqual([])
    })
  })
  describe('createBelow', () => {
    it('inserts a new block after the specified block', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      // #2849 PR2 — the backend uses the client-supplied id verbatim, so it
      // echoes `blockId` back. The new block is addressed by the CLIENT id
      // (`CID_1`), never a server-minted one.
      mockedInvoke.mockResolvedValueOnce({
        id: 'CID_1',
        block_type: 'content',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      const newId = await store.getState().createBelow('A', 'new content')

      expect(newId).toBe('CID_1')
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('CID_1')
      expect(blocks[1]?.content).toBe('new content')
      expect(blocks[2]?.id).toBe('B')
    })

    it('returns null when afterBlockId is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      const result = await store.getState().createBelow('NONEXISTENT')

      expect(result).toBeNull()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('returns null on backend error (state unchanged)', async () => {
      const block = makeBlock({ id: 'A' })
      store.setState({ blocks: [block] })
      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      const result = await store.getState().createBelow('A')

      expect(result).toBeNull()
      expect(store.getState().blocks).toHaveLength(1)
    })

    it('inherits parent_id from the afterBlock', async () => {
      const block = makeBlock({ id: 'A', parent_id: 'PARENT', position: 3 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: 'PARENT',
        position: 4,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          parentId: 'PARENT',
          // #400: index = afterBlock's 0-based sibling slot (0) + 1.
          index: 1,
        }),
      )
    })

    it('defaults content to empty string', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ content: '' }),
      )
    })
  })
  describe('edit', () => {
    it('updates block content locally after successful backend call', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(true)
      expect(store.getState().blocks[0]?.content).toBe('new')
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'A', toText: 'new' })
    })

    it('#753 — adopts the backend-normalized content echo on success', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      // The backend echoes a NORMALIZED version of the text we sent.
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'raw text (normalized)',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      const ok = await store.getState().edit('A', 'raw text')

      expect(ok).toBe(true)
      // Store mirrors the canonical backend row, not the raw optimistic text.
      expect(store.getState().blocks[0]?.content).toBe('raw text (normalized)')
      expect(store.getState().blocksById.get('A')?.content).toBe('raw text (normalized)')
    })

    it('#753 — a newer in-flight local edit wins over a stale echo', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementationOnce(async () => {
        // A newer optimistic edit lands while the first IPC is in flight.
        store.setState({ blocks: [makeBlock({ id: 'A', content: 'newer typed text' })] })
        return {
          id: 'A',
          block_type: 'text',
          content: 'first (normalized)',
          parent_id: null,
          position: 0,
          deleted_at: null,
        }
      })

      const ok = await store.getState().edit('A', 'first')

      expect(ok).toBe(true)
      // The echo belongs to the SUPERSEDED edit — adopting it would
      // clobber what the user typed afterwards.
      expect(store.getState().blocks[0]?.content).toBe('newer typed text')
      expect(store.getState().blocksById.get('A')?.content).toBe('newer typed text')
    })

    it('#824 — a rejected edit does NOT roll back over newer typed text', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementationOnce(async () => {
        // The user keeps typing while edit('A', 'new') is in flight — a newer
        // optimistic edit lands before this IPC rejects.
        store.setState({ blocks: [makeBlock({ id: 'A', content: 'newer typed text' })] })
        throw new Error('edit failed')
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      // Rolling back to 'old' would clobber the newer text the user typed
      // after this edit was dispatched — the guard must leave it intact.
      expect(store.getState().blocks[0]?.content).toBe('newer typed text')
      expect(store.getState().blocksById.get('A')?.content).toBe('newer typed text')
      // Failure is still surfaced.
      expect(toast.error).toHaveBeenCalledWith('Failed to save')
    })

    it('rolls back optimistic content and resolves false on backend error', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      expect(store.getState().blocks[0]?.content).toBe('old')
    })

    it('shows toast.error on backend failure', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(toast.error).toHaveBeenCalledWith('Failed to save')
    })

    it('does not crash when editing a block that does not exist in the store', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'aaa' })] })
      mockedInvoke.mockRejectedValueOnce(new Error('not found'))

      await store.getState().edit('NONEXISTENT', 'whatever')

      // Store is unchanged — no crash
      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]?.content).toBe('aaa')
    })

    it('only updates the target block, leaving others unchanged', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'aaa' }), makeBlock({ id: 'B', content: 'bbb' })],
      })
      mockedInvoke.mockResolvedValueOnce({})

      await store.getState().edit('A', 'aaa-updated')

      expect(store.getState().blocks[0]?.content).toBe('aaa-updated')
      expect(store.getState().blocks[1]?.content).toBe('bbb')
    })

    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementation(async () => {
        // Simulate rootParentId change during IPC
        store.setState({ rootParentId: 'PAGE_2' })
        return {}
      })

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    // ── array identity (#2200 — perf-review) ──────────────────────────────
    // `edit()` used to rebuild `state.blocks` via a full `.map()` on every
    // keystroke. Object identity for unchanged blocks was already preserved
    // by that `.map()` (`return b` for non-matching entries), but it still
    // walked and invoked a callback for every entry in the array. The
    // slice+index-write rewrite must keep the same observable identity
    // contract: unedited blocks keep their EXACT prior reference, the edited
    // block gets a new object, and the top-level array reference always
    // changes when something actually changed (so React/Zustand see the
    // update) — but must NOT change when nothing did.
    it('#2200 — preserves unchanged blocks by reference and only replaces the edited slot', async () => {
      const blockA = makeBlock({ id: 'A', content: 'aaa' })
      const blockB = makeBlock({ id: 'B', content: 'bbb' })
      const blockC = makeBlock({ id: 'C', content: 'ccc' })
      store.setState({ blocks: [blockA, blockB, blockC] })
      const blocksBefore = store.getState().blocks
      mockedInvoke.mockResolvedValueOnce({})

      await store.getState().edit('B', 'bbb-edited')

      const { blocks } = store.getState()
      // Top-level array reference changes — React/Zustand need a new ref to
      // see the update.
      expect(blocks).not.toBe(blocksBefore)
      // Unedited entries keep their EXACT prior object reference. Downstream
      // per-row `React.memo` (SortableBlock/EditableBlock) keys off this
      // per-block identity to skip re-rendering unrelated rows.
      expect(blocks[0]).toBe(blockA)
      expect(blocks[2]).toBe(blockC)
      // Only the edited slot gets a new object.
      expect(blocks[1]).not.toBe(blockB)
      expect(blocks[1]?.content).toBe('bbb-edited')
    })

    it('#2200 — leaves the blocks array reference untouched when the target id is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'aaa' })] })
      const blocksBefore = store.getState().blocks
      mockedInvoke.mockRejectedValueOnce(new Error('not found'))

      await store.getState().edit('NONEXISTENT', 'whatever')

      // Nothing changed — no reason to hand out a new array reference (which
      // would otherwise fan a false-positive re-render out to every
      // subscriber of `blocks`).
      expect(store.getState().blocks).toBe(blocksBefore)
    })

    it('#2200 — the #753 echo-adopt path also preserves unrelated blocks by reference', async () => {
      const blockA = makeBlock({ id: 'A', content: 'old' })
      const blockB = makeBlock({ id: 'B', content: 'bbb' })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'raw text (normalized)',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().edit('A', 'raw text')

      const { blocks } = store.getState()
      expect(blocks[1]).toBe(blockB)
      expect(blocks[0]?.content).toBe('raw text (normalized)')
    })

    it('#2200 — the rollback-on-error path also preserves unrelated blocks by reference', async () => {
      const blockA = makeBlock({ id: 'A', content: 'old' })
      const blockB = makeBlock({ id: 'B', content: 'bbb' })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      const { blocks } = store.getState()
      expect(blocks[1]).toBe(blockB)
      expect(blocks[0]?.content).toBe('old')
    })
  })
  describe('remove', () => {
    it('removes the block from local state on success', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.id).toBe('B')
    })

    it('does not mutate global block store focus — callers manage focus', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })

    it('does not modify state on backend error', async () => {
      const originalBlock = makeBlock({ id: 'A' })
      store.setState({
        blocks: [originalBlock],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await store.getState().remove('A')

      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]).toEqual(originalBlock)
    })

    it('does not mutate global block store selection — callers manage selection', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'alpha', position: 0 }),
          makeBlock({ id: 'B', content: 'beta', position: 1 }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })
  })
  describe('appendBlock', () => {
    it('pushes the row to blocks and rebuilds blocksById (no IPC)', () => {
      store.setState({ blocks: [] })

      const row = makeBlock({ id: 'NEW', parent_id: 'PAGE_1', position: 0 })
      // Drop `depth` from the BlockRow input — appendBlock supplies depth = 0.
      const { depth: _depth, ...rowWithoutDepth } = row

      store.getState().appendBlock(rowWithoutDepth)

      expect(mockedInvoke).not.toHaveBeenCalled()
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.id).toBe('NEW')
      expect(blocks[0]?.depth).toBe(0)
      expect(store.getState().blocksById.get('NEW')?.id).toBe('NEW')
    })

    it('appends to an existing block list without disturbing prior entries', () => {
      const existing = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0, depth: 0 })
      store.setState({ blocks: [existing] })

      const row = makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 })
      const { depth: _depth, ...rowWithoutDepth } = row

      store.getState().appendBlock(rowWithoutDepth)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'B'])
    })

    it('derives the blocks array and blocksById Map from the same commit-time state (#1676)', () => {
      const existing = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0, depth: 0 })
      store.setState({ blocks: [existing] })

      const row = makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 })
      const { depth: _depth, ...rowWithoutDepth } = row

      store.getState().appendBlock(rowWithoutDepth)

      // The next blocks array is recomputed inside the updater from
      // state.blocks (not a pre-set snapshot), so the array and the Map are
      // derived from the same commit-time state and cannot diverge: same
      // length, every array entry present AND identical in the Map.
      const s = store.getState()
      expect(s.blocksById.size).toBe(s.blocks.length)
      for (const b of s.blocks) {
        expect(s.blocksById.get(b.id)).toBe(b)
      }
      // Prior entry preserved by identity (clone touched only the new key).
      expect(s.blocksById.get('A')).toBe(existing)
    })
  })
})
