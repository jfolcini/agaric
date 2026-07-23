// Split from the page-blocks.test.ts monolith (#2929). Concern: sibling
// reorder, moveUp/moveDown, DnD slot-safety invariants, and moveBlocks.
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
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

  describe('reorder', () => {
    it('calls moveBlock and reorders the local array', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 0,
      })

      await store.getState().reorder('C', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'C', newParentId: null }),
      )
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('C')
      expect(blocks[1]?.id).toBe('A')
      expect(blocks[2]?.id).toBe('B')
    })

    it('is no-op when same index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().reorder('A', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op at the adjacent-slot boundary — reorder to own current slot (#928 f6)', async () => {
      // siblingSlot returns the index INCLUDING self (B is at slot 1), while
      // newIndex is the backend slot-basis EXCLUDING self. The guard relies on
      // these coinciding at the block's own position: reorder('B', 1) must NOT
      // emit a move_block IPC and must leave the order untouched.
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      await store.getState().reorder('B', 1)

      // No-op assertion: the move_block IPC was never invoked.
      expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
      // Store order is unchanged.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
    })

    it('moves to the adjacent slot just past its own (#928 f6)', async () => {
      // reorder('B', 2): one slot past B's current slot — must actually move.
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: null,
        new_position: 3,
      })

      await store.getState().reorder('B', 2)

      // The move IPC fires with the expected newIndex.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: null, newIndex: 2 }),
      )
      // B lands after C: [A, C, B].
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
    })

    it('is no-op when blockId not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().reorder('NONEXISTENT', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().reorder('B', 0)

      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('B')
    })

    it('moves block down in the list (arrayMove semantics)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 3,
      })

      // Move A to index 2 (where C is) → [B, C, A] via arrayMove
      await store.getState().reorder('A', 2)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'A', newParentId: null }),
      )
      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[1]?.id).toBe('C')
      expect(blocks[2]?.id).toBe('A')
    })

    it('preserves parent_id when reordering', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT' })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: 'PARENT' })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await store.getState().reorder('B', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: 'PARENT' }),
      )
    })

    it('handles consecutive positions (collision avoidance) for backward move', async () => {
      // Positions 10, 11, 12 — consecutive, no room for Math.floor average
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 11,
      })

      // Move C (idx 2) to idx 1 → between A(10) and B(11)
      // floor((10+11)/2) = 10, which <= 10, so nudge up → 11
      // Position 11 collides with B but local array order is correct
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      // Position is nudged to beforePos + 1
      expect(blocks[1]?.position).toBe(11)
    })

    it('handles consecutive positions for forward move', async () => {
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 12,
      })

      // Move A (idx 0) to idx 1 → between B(11) and C(12)
      // floor((11+12)/2) = 11, which <= 11, so nudge up → 12
      await store.getState().reorder('A', 1)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 1) → [B, A, C]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A', 'C'])
      expect(blocks[1]?.position).toBe(12)
    })

    it('assigns position after last block when moving forward to last index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 10, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 11,
      })

      // Move A to last index (2) — hits newIndex >= blocks.length - 1 branch
      await store.getState().reorder('A', 2)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
      // Position = last block's position + 1
      expect(blocks[2]?.position).toBe(11)
    })

    it('uses average position when there is room between positions', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 10, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 20, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 5,
      })

      // Move C (idx 2) to idx 1 → between A(0) and B(10)
      // floor((0+10)/2) = 5, which > 0, so no nudge needed
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      expect(blocks[1]?.position).toBe(5)
    })

    // #2200 — reorder's splice now builds one id→index map over `remaining`
    // and reuses it across every anchor lookup (the "past the last sibling"
    // branch previously scanned `remaining` twice for the same id — once via
    // `getDragDescendants`, once via `findIndex` — #2041/#2200, mirrors the
    // dedent/moveDown conversion). Pin the behavior AND identity contract for
    // that exact branch: the last remaining sibling has its own descendant
    // (exercises the skip-loop), and unrelated blocks must keep their exact
    // reference.
    it("#2200 — reordering past the last sibling lands after that sibling's subtree, preserving identity", async () => {
      // Y starts BEFORE X (slot 0) so moving it past X (slot 1, its own
      // sibling-count-excluding-self length) is a real move, not the
      // own-slot no-op (#928 f6).
      const blockY = makeBlock({ id: 'Y', position: 0, parent_id: null, depth: 0 })
      const blockX = makeBlock({ id: 'X', position: 1, parent_id: null, depth: 0 })
      const blockX1 = makeBlock({ id: 'X1', position: 0, parent_id: 'X', depth: 1 })
      store.setState({ blocks: [blockY, blockX, blockX1] })

      // Y's only remaining root sibling is X (length 1) — newIndex 1 is past
      // it, hitting the `lastSib` branch.
      mockedInvoke.mockResolvedValueOnce({ block_id: 'Y', new_parent_id: null, new_position: 2 })

      await store.getState().reorder('Y', 1)

      const { blocks } = store.getState()
      // Y lands after X's whole subtree (X, X1), not spliced in between.
      expect(blocks.map((b) => b.id)).toEqual(['X', 'X1', 'Y'])
      // X and X1 (untouched) keep their exact prior references.
      expect(blocks[0]).toBe(blockX)
      expect(blocks[1]).toBe(blockX1)
      // Y itself gets a new reference (position rewritten).
      expect(blocks[2]).not.toBe(blockY)
    })

    it('#2916 — reorder now serializes behind a queued moveUp on the same block (no interleave)', async () => {
      // #774's per-block mover queue lists moveUp/moveDown/indent/dedent/
      // reorder as serialized sibling-slot movers, but `reorder` was not
      // actually routed through `enqueueMove` — a DnD reorder could race a
      // queued keyboard mover on the SAME block. Fire moveUp('B') then
      // reorder('B', ...) back-to-back, WITHOUT awaiting the first: if
      // reorder is properly queued, its `move_block` IPC (and the target-slot
      // computation feeding it) must not fire until moveUp's full round-trip
      // settles — mirroring the "serialized double moveDown" test above.
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 })
      const blockD = makeBlock({ id: 'D', position: 3, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB, blockC, blockD] })

      const resolvers: Array<(v: unknown) => void> = []
      mockedInvoke.mockImplementation(async () => new Promise((resolve) => resolvers.push(resolve)))

      // moveUp('B') swaps B before A → [B, A, C, D] (optimistic splice) and
      // sends move_block(B, null, 0). reorder('B', 3) is fired immediately
      // after, without awaiting moveUp — same block, so #774 must chain it.
      const p1 = store.getState().moveUp('B')
      const p2 = store.getState().reorder('B', 3)

      // Only moveUp's IPC has fired. If `reorder` were NOT wrapped in
      // `enqueueMove`, its body would run synchronously right here too,
      // issuing a SECOND `move_block` call in this same turn (computed off
      // the pre-moveUp-settle snapshot) — this assertion is what catches
      // that regression.
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(mockedInvoke).toHaveBeenNthCalledWith(
        1,
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: null, newIndex: 0 }),
      )

      // Settle moveUp's round-trip.
      resolvers[0]?.({ block_id: 'B', new_parent_id: null, new_position: 0 })
      await p1

      // Only now does reorder's queued body run and send ITS `move_block`
      // call, reading the post-moveUp state ([B, A, C, D]) rather than a
      // stale pre-move snapshot.
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))
      expect(mockedInvoke).toHaveBeenNthCalledWith(
        2,
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: null, newIndex: 3 }),
      )

      resolvers[1]?.({ block_id: 'B', new_parent_id: null, new_position: 3 })
      await p2

      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      // Final order: A, C, D, B.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'C', 'D', 'B'])
    })
  })
  describe('moveUp', () => {
    it('calls move_block with the prev sibling slot, then splices locally', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes the dense new position back so FE can splice.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: null,
        new_position: 1,
      })

      await store.getState().moveUp('B')

      // #400: target slot is the previous sibling's slot (B is at slot 1 → 0).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: null,
        newIndex: 0,
      })
      // Same-parent moveUp must NOT trigger a re-list IPC.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      // The blocks array is reordered locally with the echoed dense position.
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[0]?.position).toBe(1)
      expect(blocks[1]?.id).toBe('A')
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the first sibling at ROOT (nowhere to pop out)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveUp('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#922 — first child pops OUT to become the parent previous sibling', async () => {
      // GRAND > P > {C1, C2}; P is GRAND's 2nd child (after S).
      const grand = makeBlock({ id: 'GRAND', position: 0, parent_id: null, depth: 0 })
      const sibBeforeP = makeBlock({ id: 'S', position: 0, parent_id: 'GRAND', depth: 1 })
      const parent = makeBlock({ id: 'P', position: 1, parent_id: 'GRAND', depth: 1 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 2 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 2 })
      store.setState({ blocks: [grand, sibBeforeP, parent, child1, child2] })

      // move_block — the cross-parent pop-out. C1 lands under GRAND at the
      // parent P's own sibling slot (1), i.e. right BEFORE P.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: 'GRAND',
        new_position: 1,
      })
      // load() reload after the structural move.
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'GRAND', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'S', parent_id: 'GRAND', depth: 1 }),
          makeBlock({ id: 'C1', parent_id: 'GRAND', depth: 1 }),
          makeBlock({ id: 'P', parent_id: 'GRAND', depth: 1 }),
          makeBlock({ id: 'C2', parent_id: 'P', depth: 2 }),
        ]),
      )

      const ok = await store.getState().moveUp('C1')

      expect(ok).toBe(true)
      // The pop-out targets the grandparent at parent P's sibling slot (1).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: 'GRAND',
        newIndex: 1,
      })
      // Structural move → a follow-up reload (mirrors moveToParent).
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('#922 — first child pop-out under a ROOT parent uses newParentId null', async () => {
      // P (root) > {C1, C2}. C1 pops out to root, right before P (slot 0).
      const parent = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 1 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child1, child2] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: null,
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'C1', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'P', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C2', parent_id: 'P', depth: 1 }),
        ]),
      )

      const ok = await store.getState().moveUp('C1')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: null,
        newIndex: 0,
      })
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveUp('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      // R6 (#405): move actions now resolve `false` on a caught backend error.
      await expect(store.getState().moveUp('B')).resolves.toBe(false)
      expect(store.getState().blocks).toHaveLength(2)
    })

    it('uses correct parentId in move_block call', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 3, parent_id: 'PARENT', depth: 1 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes new position
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'PARENT',
        newIndex: 0, // B is at sibling slot 1 → swap up to slot 0
      })
      // Tier 4.1 — same-parent path skips re-list.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
    })

    it('falls back to full reload if backend echoes a different parent (Tier 4.1 cross-parent guard)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block returns a parent_id different from what we asked for —
      // shouldn't happen in practice for moveUp, but the guard exists so
      // descendant chains stay consistent if it ever does.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'OTHER',
        new_position: -1,
      })
      // load_page_subtree (fallback reload)
      mockedInvoke.mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })
  describe('moveDown', () => {
    it('calls move_block with the next sibling slot, then splices locally', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes the dense new position.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 2,
      })

      await store.getState().moveDown('A')

      // #400: A is at slot 0; once it vacates, B slides to slot 0, so landing
      // AFTER B is slot 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 1,
      })
      // Same-parent moveDown must NOT trigger a re-list IPC.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[1]?.id).toBe('A')
      expect(blocks[1]?.position).toBe(2)
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the last sibling at ROOT (nowhere to pop out)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveDown('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#922 — last child pops OUT to become the parent next sibling', async () => {
      // GRAND > {P, S}; P > {C1, C2}. moveDown(C2) pops C2 out to GRAND right
      // AFTER P (parent P's sibling slot 0 + 1 = 1).
      const grand = makeBlock({ id: 'GRAND', position: 0, parent_id: null, depth: 0 })
      const parent = makeBlock({ id: 'P', position: 0, parent_id: 'GRAND', depth: 1 })
      const sibAfterP = makeBlock({ id: 'S', position: 1, parent_id: 'GRAND', depth: 1 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 2 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 2 })
      store.setState({ blocks: [grand, parent, sibAfterP, child1, child2] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C2',
        new_parent_id: 'GRAND',
        new_position: 1,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'GRAND', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'P', parent_id: 'GRAND', depth: 1 }),
          makeBlock({ id: 'C1', parent_id: 'P', depth: 2 }),
          makeBlock({ id: 'C2', parent_id: 'GRAND', depth: 1 }),
          makeBlock({ id: 'S', parent_id: 'GRAND', depth: 1 }),
        ]),
      )

      const ok = await store.getState().moveDown('C2')

      expect(ok).toBe(true)
      // Pop-out under the grandparent, right after parent P (slot 0 + 1).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C2',
        newParentId: 'GRAND',
        newIndex: 1,
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('#922 — single-child pop-out under a ROOT parent uses newParentId null', async () => {
      // P (root) > {C1}. C1 is both first AND last; moveDown pops it out to
      // root right after P (parent slot 0 + 1 = 1).
      const parent = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child1] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: null,
        new_position: 1,
      })
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'P', parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C1', parent_id: 'PAGE_1', depth: 0 }),
        ]),
      )

      const ok = await store.getState().moveDown('C1')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: null,
        newIndex: 1,
      })
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveDown('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      // R6 (#405): move actions now resolve `false` on a caught backend error.
      await expect(store.getState().moveDown('A')).resolves.toBe(false)
      expect(store.getState().blocks).toHaveLength(2)
    })

    it('falls back to full reload if backend echoes a different parent (Tier 4.1 cross-parent guard)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: 'OTHER',
        new_position: 6,
      })
      mockedInvoke.mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      await store.getState().moveDown('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })
  describe('slot-safety invariants (DnD)', () => {
    /** Pull the `newIndex` from the most recent move_block IPC call. */
    function lastMoveIndex(): number | undefined {
      const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'move_block')
      const last = calls.at(-1)?.[1] as { newIndex?: number } | undefined
      return last?.newIndex
    }

    it('moveUp emits a non-negative slot (0) when the prev sibling is at the floor', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 1 })

      await store.getState().moveUp('B')

      // B at slot 1 → swap up to slot 0 (the backend accepts "move to top").
      expect(lastMoveIndex()).toBe(0)
    })

    it('reorder to the top emits slot 0 (accepted by the backend)', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 1 })

      await store.getState().reorder('B', 0)

      expect(lastMoveIndex()).toBe(0)
    })

    it('moveDown emits a slot that does not collide with an existing sibling', async () => {
      // Consecutive positions 1,2,3 (no gaps) — the common real-world case.
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      const blockC = makeBlock({ id: 'C', position: 3, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB, blockC] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })

      // Move A down past B → slot 1 (B slides up once A vacates). The backend
      // assigns a dense rank from the slot; no collision.
      await store.getState().moveDown('A')

      expect(lastMoveIndex()).toBe(1)
    })

    it('dedent emits a slot that does not collide with the parent’s following sibling', async () => {
      // GP > P(slot 0) { X }, and P has a following sibling S at slot 1.
      // Dedent X → slot = P's sibling slot (0) + 1 = 1, BEFORE S; the backend
      // re-ranks densely so S shifts down — no collision.
      const gp = makeBlock({ id: 'GP', position: 1, parent_id: null, depth: 0 })
      const p = makeBlock({ id: 'P', position: 1, parent_id: 'GP', depth: 1 })
      const x = makeBlock({ id: 'X', position: 1, parent_id: 'P', depth: 2 })
      const s = makeBlock({ id: 'S', position: 2, parent_id: 'GP', depth: 1 })
      store.setState({
        blocks: [gp, p, x, s],
        blocksById: new Map([
          ['GP', gp],
          ['P', p],
          ['X', x],
          ['S', s],
        ]),
      })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'X', new_parent_id: 'GP', new_position: 2 })

      await store.getState().dedent('X')

      expect(lastMoveIndex()).toBe(1)
    })
  })
  describe('moveBlocks', () => {
    /** The single `move_blocks_batch` IPC payload, or undefined if none fired. */
    function batchCall() {
      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'move_blocks_batch')
      return call?.[1] as
        | { blockIds: string[]; newParentId: string | null; newIndex: number }
        | undefined
    }
    /** How many `move_blocks_batch` IPCs fired. */
    function batchCallCount() {
      return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'move_blocks_batch').length
    }
    /** Whether a reconciling `load_page_subtree` (full reload) fired. */
    function reloaded() {
      return mockedInvoke.mock.calls.some(([cmd]) => cmd === 'load_page_subtree')
    }
    /** Build an authoritative batch response echoing the requested parent. */
    function batchResp(ids: string[], parentId: string | null) {
      return ids.map((id, i) => ({ block_id: id, new_parent_id: parentId, new_position: i + 1 }))
    }

    it('issues ONE move_blocks_batch IPC and reconciles WITHOUT a full load()', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'D', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'B'], 'PAGE_1'))

      await store.getState().moveBlocks(['A', 'B'], 'PAGE_1', 2)

      // Exactly one batched IPC, carrying the ordered run + destination.
      expect(batchCallCount()).toBe(1)
      expect(batchCall()).toEqual({ blockIds: ['A', 'B'], newParentId: 'PAGE_1', newIndex: 2 })
      // Reconciled surgically from the response — NO blind reload.
      expect(reloaded()).toBe(false)
      // Contiguous-run remove-then-splice (Refs #914 / Closes #2305): base
      // position 2 over the non-selected children [C,D] appends the run ⇒
      // C,D,A,B — matching the Rust ground-truth test
      // `move_blocks_batch_interleaved_same_parent_engine_ground_truth_2274`.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'D', 'A', 'B'])
      // blocksById stays in lockstep with the flat array.
      expect([...store.getState().blocksById.keys()].toSorted()).toEqual(['A', 'B', 'C', 'D'])
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('lands a CONTIGUOUS run for an INTERLEAVED same-parent selection', async () => {
      // [A,B,C,D] under one parent; move the non-contiguous selection [A,C] at
      // base position 2. Contiguous-run remove-then-splice (Refs #914 / Closes
      // #2305): non-selected = [B,D], base position 2 appends the run ⇒ B,D,A,C.
      // Engine-path ground truth pinned by the Rust test
      // `move_blocks_batch_interleaved_same_parent_engine_ground_truth_2274`.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'D', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'C'], 'PAGE_1'))

      await store.getState().moveBlocks(['A', 'C'], 'PAGE_1', 2)

      expect(reloaded()).toBe(false)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'D', 'A', 'C'])
      // Dense 1-based positions, mirroring the backend reprojection.
      expect(store.getState().blocks.map((b) => b.position)).toEqual([1, 2, 3, 4])
    })

    // R4/R13 — the optimistic same-parent movers (#404 reorder, moveUp,
    // moveDown) keep the ARRAY order authoritative but rewrite only the moved
    // block's `position` to the backend's PROVISIONAL rank, leaving sibling
    // integers stale. The batch reconcile must therefore derive its replay
    // baseline from the rendered flat-array order, NOT by re-sorting the stale
    // `(position, id)` integers — the id tie-break silently committed a
    // sibling order that diverged from the DB until the next full load().
    it('replays against the RENDERED sibling order, not stale position integers, after an optimistic reorder (R4)', async () => {
      // State an optimistic reorder leaves behind: the user dragged A from the
      // top to the end of dense [A,B,C,D]. The splice yields array [B,C,D,A]
      // and rewrites only A.position to the provisional rank 4 — B,C,D keep
      // their pre-move integers, so the store holds a D=4/A=4 tie while the
      // backend holds dense B=1,C=2,D=3,A=4.
      store.setState({
        blocks: [
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'D', position: 4, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'A', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['B', 'C'], 'PAGE_1'))

      // Multi-select move of [B,C] to the end (slot 3 of the rendered order).
      await store.getState().moveBlocks(['B', 'C'], 'PAGE_1', 3)

      expect(reloaded()).toBe(false)
      // Contiguous-run: base = non-selected in ARRAY order [D,A]; base position 3
      // clamps to append ⇒ D,A,B,C. A stale `(position, id)` baseline would break
      // the D=4/A=4 tie by id (A<D), derive base [A,D] and commit A,D,B,C instead.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['D', 'A', 'B', 'C'])
      // The reconcile re-densifies the touched group, healing the stale ranks.
      expect(store.getState().blocks.map((b) => b.position)).toEqual([1, 2, 3, 4])
    })

    it('replays against array order even when stale positions sort OUT OF ORDER (two stacked optimistic reorders, R13)', async () => {
      // Two stacked optimistic reorders on dense [A,B,C,D]: drag A to the end
      // (array [B,C,D,A], A.position=4), then drag B to slot 2 (array
      // [C,D,B,A], B.position = provisional 3). Stored integers are now
      // C=3,D=4,B=3,A=4 — sorted `(position, id)` they read [B,C,A,D], which
      // disagrees with the true order [C,D,B,A] beyond mere ties.
      store.setState({
        blocks: [
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'D', position: 4, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'A', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['D'], 'PAGE_1'))

      // Move [D] (rendered slot 1) to the end — slot 3 among the others.
      await store.getState().moveBlocks(['D'], 'PAGE_1', 3)

      expect(reloaded()).toBe(false)
      // Contiguous-run: base = non-selected in ARRAY order [C,B,A]; append ⇒
      // C,B,A,D. A stale `(position, id)` baseline would derive base [B,C,A]
      // (B=C=3, tie by id) and commit B,C,A,D instead.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'B', 'A', 'D'])
    })

    it('preserves DOCUMENT order even when ids are passed out of order', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'C'], 'PAGE_1'))

      // Caller passes ['C', 'A'] — but A precedes C in the document, so the
      // batch must be issued as ['A', 'C'].
      await store.getState().moveBlocks(['C', 'A'], 'PAGE_1', 1)

      expect(batchCall()?.blockIds).toEqual(['A', 'C'])
    })

    it('moves the selection into a NEW parent at consecutive slots', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'A', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'B'], 'P'))

      await store.getState().moveBlocks(['A', 'B'], 'P', 0)

      expect(batchCallCount()).toBe(1)
      expect(batchCall()).toEqual({ blockIds: ['A', 'B'], newParentId: 'P', newIndex: 0 })
      expect(reloaded()).toBe(false)
      // A and B now nested under P (as its first two children).
      const blocks = store.getState().blocks
      expect(blocks.find((b) => b.id === 'A')?.parent_id).toBe('P')
      expect(blocks.find((b) => b.id === 'B')?.parent_id).toBe('P')
      expect(blocks.find((b) => b.id === 'A')?.depth).toBe(1)
      // Flattened DFS order: P, then its children A, B.
      expect(blocks.map((b) => b.id)).toEqual(['P', 'A', 'B'])
    })

    it('honours a boundary slot of 0 (move to top)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['B', 'C'], 'PAGE_1'))

      await store.getState().moveBlocks(['B', 'C'], 'PAGE_1', 0)

      expect(batchCall()).toEqual({ blockIds: ['B', 'C'], newParentId: 'PAGE_1', newIndex: 0 })
      // B,C hoisted above A.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
    })

    it('is a no-op for an empty id list (no IPC, no undo)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', depth: 0 })] })

      await store.getState().moveBlocks([], 'PAGE_1', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('drops ids that are absent from the current tree before issuing the batch', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A'], 'PAGE_1'))

      // 'GHOST' is not in the tree — only 'A' should be sent.
      await store.getState().moveBlocks(['A', 'GHOST'], 'PAGE_1', 1)

      expect(batchCall()?.blockIds).toEqual(['A'])
    })

    it('leaves the tree unchanged and does not notify undo when the batch fails', async () => {
      const before = [
        makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
      ]
      store.setState({ blocks: before })

      // The single batch IPC rejects → whole tx rolled back backend-side.
      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().moveBlocks(['A', 'B'], 'PAGE_1', 1)

      // No reconciling reload — nothing was applied optimistically, so the
      // pre-move state is still in place (R26: no snapshot restore either).
      expect(reloaded()).toBe(false)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B'])
      expect(store.getState().blocks.find((b) => b.id === 'A')?.parent_id).toBe('PAGE_1')
      expect(mockOnNewAction).not.toHaveBeenCalled()
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })

    // R26 — moveBlocks applies NO optimistic update before the IPC, and the
    // batch is all-or-nothing backend-side, so a failed batch has NOTHING to
    // roll back. The old catch handler restored a wholesale pre-move
    // blocks/blocksById snapshot, clobbering any concurrent write (edit echo
    // adoption, a sync-triggered load()) that landed while the IPC was in
    // flight — diverging the store from the DB until the next load(). The
    // commit-time state must survive a batch failure untouched.
    it('does not clobber a concurrent mid-flight write when the batch fails (R26)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      let rejectBatch!: (err: Error) => void
      mockedInvoke.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectBatch = reject
          }),
      )

      const moving = store.getState().moveBlocks(['A'], 'PAGE_1', 1)

      // Concurrent writes land while the batch IPC is in flight — an edit echo
      // rewrites B's content and a sync load delivers a new block C. Both are
      // already durable backend-side.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({
            id: 'B',
            position: 2,
            parent_id: 'PAGE_1',
            depth: 0,
            content: 'edited mid-flight',
          }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      rejectBatch(new Error('move failed'))
      await moving

      // The failed batch rolled back backend-side and nothing was applied
      // optimistically — the concurrent writes must survive.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
      expect(store.getState().blocksById.get('B')?.content).toBe('edited mid-flight')
      expect(store.getState().blocksById.has('C')).toBe(true)
      expect(reloaded()).toBe(false)
      expect(mockOnNewAction).not.toHaveBeenCalled()
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })

    it('falls back to a reload when the backend echoes a different parent', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      // Backend reparented A somewhere other than the requested 'PAGE_1' → a
      // local splice would diverge, so `reconcileBatchMove` requests a reload.
      mockedInvoke.mockResolvedValueOnce([
        { block_id: 'A', new_parent_id: 'ELSEWHERE', new_position: 1 },
      ])
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 })]),
      )

      await store.getState().moveBlocks(['A'], 'PAGE_1', 0)

      expect(reloaded()).toBe(true)
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    // #976 finding 4 — the `moveBlocks` docstring requires callers pass the
    // SELECTION ROOTS only (a nested descendant must NOT be listed; it travels
    // inside its ancestor's subtree). The implementation performs NO such
    // validation: it accepts any ids, filters absent ones, and sorts by
    // document order. This PINS that current, un-validated behavior — passing a
    // parent AND its child sends BOTH in the batch — so any future
    // contract-tightening is a deliberate, test-breaking change rather than a
    // silent behavior shift. The real caller (`useBlockDnD`) always pre-filters
    // via `computeSelectionRoots`, so production is unaffected.
    it('does NOT enforce the "selection roots only" contract — a parent + its child both move (pinned)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          // A1 is a CHILD of A — a non-root descendant the docstring says must
          // not be passed. The implementation sends it anyway.
          makeBlock({ id: 'A1', position: 1, parent_id: 'A', depth: 1 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'A1'], 'PAGE_1'))

      // Pass BOTH the parent (A) and its child (A1) — violating the contract.
      await store.getState().moveBlocks(['A', 'A1'], 'PAGE_1', 2)

      // Both ids appear in the batch, in document order. No filtering occurred.
      expect(batchCall()?.blockIds).toEqual(['A', 'A1'])
    })
  })
})
