// Split from the page-blocks.test.ts monolith (#2929). Concern: moveToParent
// reparenting, its race conditions, and stale-capture races.
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

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

  describe('moveToParent', () => {
    it('#2900 — applies the reparent optimistically, WITHOUT a full load(), on the happy path', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await store.getState().moveToParent('B', 'A', 0)

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newIndex: 0,
      })
      // The last unconditional full reload in the move family is gone: a
      // matching parent echo reconciles in place — no `load_page_subtree`
      // round-trip (mirrors the equivalent `reorder` assertion).
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'B'])
      expect(s.blocksById.get('B')?.parent_id).toBe('A')
      expect(s.blocksById.get('B')?.depth).toBe(1)
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('provisional reparent is visible BEFORE the move IPC resolves', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      let resolveMove!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveMove = resolve
        }),
      )

      const p = store.getState().moveToParent('B', 'A', 0)
      // Applied synchronously — no await needed for B to already sit under A.
      expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
      expect(store.getState().blocksById.get('B')?.depth).toBe(1)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B'])

      resolveMove({ block_id: 'B', new_parent_id: 'A', new_position: 0 })
      await p

      expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
    })

    it('moves descendants along with the reparented block, splicing the subtree together', async () => {
      // P (with child C) reparents under X, a sibling root. C must travel
      // with P: same relative order, `depth` shifted with the subtree,
      // `parent_id` unchanged (still points at P, not X).
      const x = makeBlock({ id: 'X', position: 1, parent_id: null, depth: 0 })
      const p = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const c = makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [p, c, x] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'P',
        new_parent_id: 'X',
        new_position: 1,
      })

      await store.getState().moveToParent('P', 'X', 0)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['X', 'P', 'C'])
      expect(s.blocksById.get('P')?.parent_id).toBe('X')
      expect(s.blocksById.get('P')?.depth).toBe(1)
      expect(s.blocksById.get('C')?.parent_id).toBe('P')
      expect(s.blocksById.get('C')?.depth).toBe(2)
    })

    it("reparents a block AND its descendant multiple levels DEEPER, generalizing dedent's fixed -1 shift to an arbitrary delta", async () => {
      // G -> M -> D -> E  (D is depth 2, moved; E is its depth-3 child)
      // R -> S -> T -> U  (U, depth 3, is the new — much deeper — parent)
      const g = makeBlock({ id: 'G', position: 0, parent_id: null, depth: 0 })
      const m = makeBlock({ id: 'M', position: 0, parent_id: 'G', depth: 1 })
      const d = makeBlock({ id: 'D', position: 0, parent_id: 'M', depth: 2 })
      const e = makeBlock({ id: 'E', position: 0, parent_id: 'D', depth: 3 })
      const r = makeBlock({ id: 'R', position: 1, parent_id: null, depth: 0 })
      const s = makeBlock({ id: 'S', position: 0, parent_id: 'R', depth: 1 })
      const t = makeBlock({ id: 'T', position: 0, parent_id: 'S', depth: 2 })
      const u = makeBlock({ id: 'U', position: 0, parent_id: 'T', depth: 3 })
      store.setState({ blocks: [g, m, d, e, r, s, t, u] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'D',
        new_parent_id: 'U',
        new_position: 0,
      })

      // D goes from depth 2 to depth 4 (U's depth 3 + 1) — a delta of +2, not
      // the fixed +/-1 shift indent/dedent always apply.
      await store.getState().moveToParent('D', 'U', 0)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const state = store.getState()
      expect(state.blocks.map((b) => b.id)).toEqual(['G', 'M', 'R', 'S', 'T', 'U', 'D', 'E'])
      expect(state.blocksById.get('D')?.parent_id).toBe('U')
      expect(state.blocksById.get('D')?.depth).toBe(4)
      // E travels with D: parent_id unchanged (still points at D), depth
      // shifted by the SAME delta (+2) as D, not reset to a fixed offset.
      expect(state.blocksById.get('E')?.parent_id).toBe('D')
      expect(state.blocksById.get('E')?.depth).toBe(5)
    })

    it('reparents a block AND its descendant multiple levels SHALLOWER in one step (straight to root)', async () => {
      // G -> M -> D -> E, plus a root sibling X. D (depth 2) moves straight to
      // root — a delta of -2 in one hop, which no single indent/dedent call
      // could produce (each only ever shifts by exactly 1).
      const g = makeBlock({ id: 'G', position: 0, parent_id: null, depth: 0 })
      const m = makeBlock({ id: 'M', position: 0, parent_id: 'G', depth: 1 })
      const d = makeBlock({ id: 'D', position: 0, parent_id: 'M', depth: 2 })
      const e = makeBlock({ id: 'E', position: 0, parent_id: 'D', depth: 3 })
      const x = makeBlock({ id: 'X', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [g, m, d, e, x] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'D',
        new_parent_id: null,
        new_position: 1,
      })

      // newIndex 1 among root siblings-remaining ([G, X]) anchors on X, so D
      // (+ E) lands between G and X.
      await store.getState().moveToParent('D', null, 1)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const state = store.getState()
      expect(state.blocks.map((b) => b.id)).toEqual(['G', 'M', 'D', 'E', 'X'])
      expect(state.blocksById.get('D')?.parent_id).toBeNull()
      expect(state.blocksById.get('D')?.depth).toBe(0)
      expect(state.blocksById.get('E')?.parent_id).toBe('D')
      expect(state.blocksById.get('E')?.depth).toBe(1)
    })

    it("inserts at a MID-LIST sibling slot among the target parent's existing children, not just head/tail", async () => {
      // T already has three children (T1, T2, T3); S (a root block with no
      // descendants) is dropped at slot 1 — it must land strictly between T1
      // and T2, not merely appended after the last sibling or prepended.
      const tp = makeBlock({ id: 'T', position: 0, parent_id: null, depth: 0 })
      const t1 = makeBlock({ id: 'T1', position: 0, parent_id: 'T', depth: 1 })
      const t2 = makeBlock({ id: 'T2', position: 1, parent_id: 'T', depth: 1 })
      const t3 = makeBlock({ id: 'T3', position: 2, parent_id: 'T', depth: 1 })
      const sBlock = makeBlock({ id: 'S', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [tp, t1, t2, t3, sBlock] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'S',
        new_parent_id: 'T',
        new_position: 1,
      })

      await store.getState().moveToParent('S', 'T', 1)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const state = store.getState()
      expect(state.blocks.map((b) => b.id)).toEqual(['T', 'T1', 'S', 'T2', 'T3'])
      expect(state.blocksById.get('S')?.parent_id).toBe('T')
      expect(state.blocksById.get('S')?.depth).toBe(1)
    })

    it('preserves descendant object identity (no re-allocation) when the reparent does not change depth (delta === 0)', async () => {
      // A and B are both root-level (depth 0) parents; P (A's child, depth 1)
      // has a child C (depth 2). Moving P from A to B keeps P at depth 1 — no
      // depth shift for the subtree — so C must come out of the splice as the
      // EXACT SAME object reference (the subtree-touch perf invariant this
      // reducer's `delta === 0` branch exists for).
      const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      const p = makeBlock({ id: 'P', position: 0, parent_id: 'A', depth: 1 })
      const c = makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 2 })
      store.setState({ blocks: [a, p, c, b] })
      const cRefBefore = store.getState().blocksById.get('C')
      const pRefBefore = store.getState().blocksById.get('P')

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'P',
        new_parent_id: 'B',
        new_position: 0,
      })

      await store.getState().moveToParent('P', 'B', 0)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const state = store.getState()
      expect(state.blocksById.get('P')?.parent_id).toBe('B')
      expect(state.blocksById.get('P')?.depth).toBe(1)
      expect(state.blocksById.get('C')?.parent_id).toBe('P')
      expect(state.blocksById.get('C')?.depth).toBe(2)
      // Identity: C's object is untouched (delta === 0); P's is always
      // re-allocated (its own parent_id changed).
      expect(state.blocksById.get('C')).toBe(cRefBefore)
      expect(state.blocksById.get('P')).not.toBe(pRefBefore)
    })

    it('canSplice guard: reparenting a block under its OWN DESCENDANT falls back to a full reload instead of corrupting the tree', async () => {
      // P has child C. Requesting moveToParent(P, C, ...) asks P to become a
      // child of its own child — a cycle a flat splice cannot represent. The
      // canSplice guard must refuse the optimistic path and take the
      // pre-#2900 fallback (fire the IPC, then unconditionally reload).
      const p = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const c = makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [p, c] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'P',
        new_parent_id: 'C',
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'C', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'P', parent_id: 'C', depth: 1 }),
        ]),
      )

      await store.getState().moveToParent('P', 'C', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('#2900 — reconciles via exactly one load() when the backend echoes a parent other than requested', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'UNEXPECTED',
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'UNEXPECTED', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', parent_id: 'UNEXPECTED', depth: 1 }),
        ]),
      )

      await store.getState().moveToParent('B', 'A', 0)

      const loadCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'load_page_subtree')
      expect(loadCalls).toHaveLength(1)
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    // Non-tautology: this mismatch fallback is not free-standing test theater
    // — if the parent-echo guard above is removed/broken, this test fails
    // (the reconciling `load()` never fires and the store is left holding
    // the WRONG optimistic parent). Verified by temporarily deleting the
    // guard locally and re-running: this test — and only this one in the
    // `moveToParent` suite — goes red.
    it('#2900 — non-tautology: a broken parent-echo guard would leave the store diverged from the backend', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'UNEXPECTED',
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'UNEXPECTED', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', parent_id: 'UNEXPECTED', depth: 1 }),
        ]),
      )

      await store.getState().moveToParent('B', 'A', 0)

      // The reconciled (post-load) state reflects the BACKEND's actual
      // parent ('UNEXPECTED'), not the optimistically-guessed one ('A') — a
      // guard that failed to detect the mismatch would leave `B` parented
      // under 'A' here instead.
      expect(store.getState().blocksById.get('B')?.parent_id).toBe('UNEXPECTED')
    })

    it('does not update blocks or notify undo on backend error, rolling back the provisional splice', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().moveToParent('B', 'A', 0)

      const s = store.getState()
      expect(s.blocks).toHaveLength(2)
      expect(s.blocks[0]?.id).toBe('A')
      expect(s.blocks[1]?.id).toBe('B')
      expect(s.blocksById.get('B')?.parent_id).toBeNull()
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('rolled-back reparent leaves no residual load() call (rollback restores the exact snapshot)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().moveToParent('B', 'A', 0)

      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
    })

    it('#2900 — falls back to the pre-#2900 unconditional reload when the block is not loaded locally', async () => {
      // moveToParent is a public store action; a caller could invoke it for a
      // block id the store has not loaded yet (defensive fallback path).
      store.setState({ blocks: [] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'GHOST',
        new_parent_id: 'A',
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce(subtreeResp([]))

      await store.getState().moveToParent('GHOST', 'A', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })
  })
  describe('moveToParent race conditions', () => {
    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // Deferred promise for move_block so we can mutate state mid-flight.
      let resolveMove!: (v: unknown) => void
      const movePending = new Promise((resolve) => {
        resolveMove = resolve
      })
      mockedInvoke.mockReturnValueOnce(movePending)

      const promise = store.getState().moveToParent('B', 'A', 0)

      // Simulate the user navigating to a different page while the IPC is in flight.
      store.setState({ rootParentId: 'DIFFERENT_PAGE' })

      // Resolve the move_block IPC; the #2900 optimistic reconcile (no load())
      // and notifyUndoNewAction run after.
      resolveMove({ block_id: 'B', new_parent_id: 'A', new_position: 0 })
      await promise

      // The undo notification must target the ORIGINAL page, not the one the user navigated to.
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
      expect(mockOnNewAction).not.toHaveBeenCalledWith('DIFFERENT_PAGE')
    })
  })
  describe('stale-capture races (#714)', () => {
    /** Array/Map consistency: same length, every array entry present AND identical in the Map. */
    function expectMapMatchesArray(s: PageBlockState): void {
      expect(s.blocksById.size).toBe(s.blocks.length)
      for (const b of s.blocks) {
        expect(s.blocksById.get(b.id)).toBe(b)
      }
    }

    /** Deferred IPC: queue a promise we can resolve mid-test. */
    function deferInvoke(): (v: unknown) => void {
      let resolve!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((r) => {
          resolve = r
        }),
      )
      return resolve
    }

    it('createBelow: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'new content')
      // #2849 PR2 — the provisional block is spliced in SYNCHRONOUSLY, before
      // the IPC resolves, under the client id `CID_1`.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])

      // Interleave an edit flush while create_block is in flight.
      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'edited mid-flight')

      resolveCreate({
        id: 'CID_1',
        block_type: 'content',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('CID_1')

      const s = store.getState()
      // Structural change persisted: CID_1 sits right after A.
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])
      // The interleaved write survived in BOTH the array and the Map.
      expect(s.blocks.find((b) => b.id === 'A')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('A')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('createBelow: falls back to load() when the anchor disappeared mid-flight (sync reload race)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // Simulate a sync:complete registry-wide load() that dropped the anchor
      // AND the provisional block (CID_1) while create_block was in flight.
      store.setState({ blocks: [makeBlock({ id: 'B', position: 0, parent_id: null, depth: 0 })] })

      // The fallback load() will hit load_page_subtree — give it the backend
      // truth (the backend committed CID_1 verbatim).
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 0 }),
          makeBlock({ id: 'CID_1', parent_id: 'PAGE_1', position: 1, content: 'x' }),
        ]),
      )

      resolveCreate({
        id: 'CID_1',
        block_type: 'content',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('CID_1')

      // The provisional block vanished mid-flight (racing load rebuilt
      // blocksById without it), so the resolve path reconciles via load()
      // instead of blindly healing a splice that is no longer there.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'CID_1'])
      expectMapMatchesArray(s)
    })

    it('reorder: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', content: 'orig C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const reorderPromise = store.getState().reorder('C', 0)

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('B', 'edited mid-flight')

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 0 })
      await reorderPromise

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['C', 'A', 'B'])
      expect(s.blocks.find((b) => b.id === 'B')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('B')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('moveUp: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const movePromise = store.getState().moveUp('B')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'edited mid-flight')

      resolveMove({ block_id: 'B', new_parent_id: null, new_position: 0 })
      await expect(movePromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(s.blocks.find((b) => b.id === 'A')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('A')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('all six mutators keep the blocks array and blocksById Map consistent', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      // createBelow: A,CID_1,B,C (client id CID_1)
      mockedInvoke.mockResolvedValueOnce({
        id: 'CID_1',
        block_type: 'content',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await store.getState().createBelow('A', 'x')
      expectMapMatchesArray(store.getState())

      // reorder: C,A,CID_1,B
      mockedInvoke.mockResolvedValueOnce({ block_id: 'C', new_parent_id: null, new_position: 0 })
      await store.getState().reorder('C', 0)
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'CID_1', 'B'])

      // moveUp: C,A,B,CID_1
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 2 })
      await store.getState().moveUp('B')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'B', 'CID_1'])

      // moveDown: C,B,A,CID_1
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })
      await store.getState().moveDown('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'B', 'A', 'CID_1'])

      // indent: A becomes child of B. #774 — indent now checks the backend
      // parent echo, so the mock must echo the requested parent ('B') to
      // exercise the local-splice path (an unexpected/absent parent reloads).
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: 'B', new_position: 0 })
      await store.getState().indent('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocksById.get('A')?.parent_id).toBe('B')
      expect(store.getState().blocksById.get('A')?.depth).toBe(1)

      // dedent: A back to root, after B
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })
      await store.getState().dedent('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocksById.get('A')?.parent_id).toBe(null)
      expect(store.getState().blocksById.get('A')?.depth).toBe(0)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'B', 'A', 'CID_1'])
    })

    it('createBelow: skips the splice when an interleaved load() already delivered the new block', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // A sync:complete load() landed mid-flight whose snapshot already contains
      // the freshly created block — with the SAME client id (CID_1) the backend
      // committed verbatim — still at the provisional slot.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'CID_1', content: 'x', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      resolveCreate({
        id: 'CID_1',
        block_type: 'content',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('CID_1')

      const s = store.getState()
      // No duplicate entry, no fallback reload — the block sits at the same
      // slot+parent under its stable id, so the resolve path just heals position.
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      expectMapMatchesArray(s)
    })

    it('createBelow: falls back to load() when the anchor was re-parented mid-flight', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // A was re-parented under B while create_block was in flight — the racing
      // load rebuilt blocksById without the provisional block at its slot, so
      // the resolve path reconciles via load() rather than heal a moved splice.
      store.setState({
        blocks: [
          makeBlock({ id: 'B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'A', position: 0, parent_id: 'B', depth: 1 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 0 }),
          makeBlock({ id: 'A', parent_id: 'B', position: 0 }),
          makeBlock({ id: 'CID_1', parent_id: 'PAGE_1', position: 1, content: 'x' }),
        ]),
      )

      resolveCreate({
        id: 'CID_1',
        block_type: 'content',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('CID_1')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expectMapMatchesArray(store.getState())
    })

    it('moveUp: falls back to load() when a sibling was inserted above mid-flight (slot drift)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      // moveUp(C) → backend slot 1 among the other siblings, anchored on B.
      const movePromise = store.getState().moveUp('C')

      // A sibling X appeared between A and B mid-flight: slot 1 among the
      // current others is now X, not B — backend and local interpretations
      // diverge, so the store must reload instead of splicing before B.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'X', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: null, depth: 0 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
          makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'X', parent_id: 'PAGE_1', position: 2 }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 3 }),
        ]),
      )

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(movePromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'C', 'X', 'B'])
      expectMapMatchesArray(s)
    })

    it('moveDown: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const movePromise = store.getState().moveDown('A')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('B', 'edited mid-flight')

      resolveMove({ block_id: 'A', new_parent_id: null, new_position: 1 })
      await expect(movePromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(s.blocks.find((b) => b.id === 'B')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('B')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('indent: falls back to load() when the new parent gained a child mid-flight (slot drift)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      // indent(B) → backend appends at slot 0 under A (A had no children).
      const indentPromise = store.getState().indent('B')

      // A gained a child K mid-flight: the backend's captured append slot no
      // longer means "last child", so the local append must yield to load().
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'K', position: 0, parent_id: 'A', depth: 1 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
          makeBlock({ id: 'B', parent_id: 'A', position: 0 }),
          makeBlock({ id: 'K', parent_id: 'A', position: 1 }),
        ]),
      )

      resolveMove(undefined)
      await expect(indentPromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocksById.get('B')?.parent_id).toBe('A')
      expectMapMatchesArray(s)
    })

    it('dedent: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', content: 'orig P', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', content: 'orig C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })

      const resolveMove = deferInvoke()
      const dedentPromise = store.getState().dedent('C')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('P', 'edited mid-flight')

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(dedentPromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['P', 'C'])
      expect(s.blocksById.get('C')?.parent_id).toBeNull()
      expect(s.blocksById.get('C')?.depth).toBe(0)
      expect(s.blocks.find((b) => b.id === 'P')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('P')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it("dedent: falls back to load() when the parent's sibling slot changed mid-flight (slot drift)", async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })

      const resolveMove = deferInvoke()
      // dedent(C) → backend slot 1 under the root (right after P at slot 0).
      const dedentPromise = store.getState().dedent('C')

      // A sibling X appeared ABOVE P mid-flight: P's slot is now 1, so the
      // backend's captured slot 1 no longer means "right after P".
      store.setState({
        blocks: [
          makeBlock({ id: 'X', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'P', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'X', parent_id: 'PAGE_1', position: 0 }),
          makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'P', parent_id: 'PAGE_1', position: 2 }),
        ]),
      )

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(dedentPromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['X', 'C', 'P'])
      expectMapMatchesArray(s)
    })

    // #2543 — remove() used to compute its descendant set from the
    // PRE-await `get()` snapshot, then filter COMMIT-time state with that
    // stale set. Example B from the issue: a block is dedented OUT of the
    // parent's subtree while the parent's delete_block IPC is still in
    // flight. The backend keeps the dedented block alive (it's no longer
    // a descendant by the time delete cascades), but the stale pre-await
    // descendant set still contained it — the user would watch a live
    // block vanish locally. Recomputing inside the functional updater
    // (current state at commit time) fixes this.
    it('remove: descendant set recomputed from commit-time state — a block dedented out of the subtree mid-flight survives', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'B', content: 'parent B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'X', content: 'child X', position: 0, parent_id: 'B', depth: 1 }),
        ],
      })

      const resolveDelete = deferInvoke()
      const removePromise = store.getState().remove('B')

      // X is dedented OUT of B's subtree mid-flight (simulating a
      // completed dedent commit that landed while delete_block for B was
      // still in flight).
      store.setState({
        blocks: [
          makeBlock({ id: 'B', content: 'parent B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'X', content: 'child X', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      resolveDelete({ block_id: 'B', deleted_at: '2025-01-01T00:00:00Z', descendants_affected: 0 })
      await removePromise

      const s = store.getState()
      // B is removed; X — no longer a descendant of B at commit time —
      // survives instead of being swept away by a stale descendant set.
      expect(s.blocks.map((b) => b.id)).toEqual(['X'])
      expectMapMatchesArray(s)
    })

    it('remove: a block re-parented UNDER the deleted block mid-flight is cascaded from commit-time state', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'B', content: 'parent B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'Y', content: 'other Y', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveDelete = deferInvoke()
      const removePromise = store.getState().remove('B')

      // Y is indented UNDER B mid-flight (simulating a completed indent
      // commit that landed while delete_block for B was still in flight).
      store.setState({
        blocks: [
          makeBlock({ id: 'B', content: 'parent B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'Y', content: 'other Y', position: 0, parent_id: 'B', depth: 1 }),
        ],
      })

      resolveDelete({ block_id: 'B', deleted_at: '2025-01-01T00:00:00Z', descendants_affected: 1 })
      await removePromise

      const s = store.getState()
      // Y is now a descendant of B at commit time, so it is swept away
      // along with B — matching the backend's cascade delete instead of
      // stranding Y locally with a dangling parent_id.
      expect(s.blocks.map((b) => b.id)).toEqual([])
      expectMapMatchesArray(s)
    })
  })
})
