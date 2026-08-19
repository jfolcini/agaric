// Split from the page-blocks.test.ts monolith (#2929). Concern: sibling
// reorder, moveUp/moveDown, DnD slot-safety invariants, and moveBlocks.
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { logger } from '@/lib/logger'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { wouldCreateMoveCycle } from '@/stores/page-blocks-move'
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

    // #3759 EQUIVALENCE LEDGER — `reconcileBatchMove` mutants that survive by
    // construction, so the next triage pass does not re-derive them. Each was
    // ORIGINALLY checked by differential execution: original vs. spliced copy
    // over 3,068 generated (tree, request, response) triples (722 reaching
    // the splice), with the mutants the tests below DO kill included as
    // controls — all five were detected, so a zero was meaningful. That sweep
    // was "a canary compiled into the source and then reverted" — never
    // committed, so it could not be re-run (#3804).
    //
    // #3804 — #3799 (same PR as this comment's own line-number correction,
    // #3887) deleted THREE of the four equivalence entries this ledger used
    // to carry outright: the `byId.has` pre-check and the vacated-source
    // dense-renumber loop were removed as subsumed/redundant, and the dead
    // `: (b.position ?? null)` ternary arm was removed as unreachable. There
    // is no mutant left at any of those positions to be equivalent about —
    // retired below, the same way `tree-utils.mutants-drop.test.ts` already
    // retired two notes after #3793. The one surviving entry (the
    // `updatedBag` sentinel) and the five controls are re-cited below at
    // their CURRENT `page-blocks-move.ts` line:col (the whole function moved
    // when `wouldCreateMoveCycle` was inserted above it), and now have a
    // committed, re-runnable harness:
    // `scripts/mutation-harnesses/page-blocks-move-reconcile-batch.harness.ts`.
    //
    // Controls (mutants the tests below — or this harness's own generation —
    // DO kill; several distinct mutants share one position, so named by
    // MUTATOR, not bare line:col):
    //   133:7  ConditionalExpression `resp.length !== orderedIds.length` -> false
    //   172:25 MethodExpression `base.slice(0, p)` -> `base`
    //   174:48 ArithmeticOperator `i + 1` -> `i - 1`
    //   222:7  ConditionalExpression `par === (b.parent_id ?? null)` -> true
    //   232:9  ConditionalExpression `!present.has(id)` -> false
    //     Re-verified by the harness above: this control alone differs on
    //     6,488 / 21,120 generated inputs (restricted sweep) — strong
    //     confirmation the harness has power, not just a report of zero.
    //
    // RETIRED (#3804, code deleted by #3799/#3887 — nothing left to be
    // equivalent about):
    //   - the `byId.has` pre-check (previously 101:32 BlockStatement / 102:9
    //     ConditionalExpression): replaced outright by the `wouldCreateMoveCycle`
    //     guard; the "moved id still exists" fast path it described no longer
    //     exists as a separate check.
    //   - the vacated-source dense-renumber loop (previously 129:32 BlockStatement /
    //     130:18 LogicalOperator / 131:9 ConditionalExpression / 133:35
    //     BlockStatement / 134:35 ArrowFunction): deleted as redundant — see
    //     `page-blocks-move.ts`'s own doc comment on the #3320 loop, which now
    //     states directly that it "assigns the BYTE-IDENTICAL ranks" this loop
    //     used to.
    //   - the dead ternary arm (previously 173:64 LogicalOperator
    //     `b.position ?? null` -> `b.position && null`, reported NoCoverage):
    //     the `posOf.has(b.id) ? … : (b.position ?? null)` ternary itself is
    //     gone — `page-blocks-move.ts` now just reads `posOf.get(b.id) ?? null`
    //     unconditionally (Finding 3, #3799), exactly the outcome this
    //     equivalence note predicted (the arm was dead code) made literal.
    //
    // SURVIVING equivalence claim:
    //   217:35 ArrayDeclaration `const updatedBag: FlatBlock[] = []` ->
    //          `['Stryker was here']`
    //     The injected sentinel has no `parent_id`, so it is a child of `null`.
    //     `createPageBlockStore(pageId: string)` always seeds a non-null
    //     `rootParentId` (immutable for the store's lifetime), so the sentinel
    //     is never reachable from the root and `buildFlatTree` drops it.
    //     Originally measured both ways: 526 differing inputs when the sweep
    //     is allowed to use `rootParentId: null`, 0 when restricted to the
    //     shapes the factory can actually produce. Killing it would require a
    //     test that observes Stryker's own placeholder, which is not a
    //     contract worth pinning.
    //     #3804 re-measurement (different generator — a small random-forest
    //     sweep, not the original hand-built one — so the raw counts differ;
    //     the verdict does not): 0 / 21,120 differing when restricted to
    //     `rootParentId: 'PAGE_1'`, 9,581 / 42,240 differing when
    //     `rootParentId: null` is allowed in. Both directions of the original
    //     claim hold under re-run.

    // #3759 — the OTHER half of the backend-echo guard. The parent-echo loop
    // above only inspects the responses that came back; a SHORT response means
    // the backend did not move every root we asked for, and the local
    // remove-then-splice replay (which lands all of `orderedIds` unconditionally)
    // would commit a tree the backend never produced.
    it('falls back to a reload when the backend echoes FEWER responses than moved ids', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      // Two roots requested, ONE response — and the response it does carry
      // echoes the requested parent, so the count check is the only guard that
      // can catch the mismatch.
      mockedInvoke.mockResolvedValueOnce(batchResp(['A'], 'PAGE_1'))
      // Backend truth: only A actually moved to the tail.
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 2 }),
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 3 }),
        ]),
      )

      await store.getState().moveBlocks(['A', 'B'], 'PAGE_1', 2)

      expect(reloaded()).toBe(true)
      // Backend truth won. Replaying the short response locally would have
      // committed C,A,B — a run the backend never landed.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
    })

    // #3759 — every other splice test lands the run at (or past) the tail, where
    // the head slice happens to BE the whole base. This one lands it strictly
    // inside the base run so head and tail slices are both non-empty.
    it('splices the run at a MID-LIST base slot and re-densifies the whole destination group', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'D', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'B'], 'PAGE_1'))

      // Base slot 1 among the non-selected children [C, D].
      await store.getState().moveBlocks(['A', 'B'], 'PAGE_1', 1)

      expect(reloaded()).toBe(false)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'B', 'D'])
      // Dense 1-based ranks across the WHOLE destination group. Re-emitting the
      // base instead of its head slice re-ranks the duplicated tail last and
      // yields 1,3,4,5 — an order-preserving but NON-dense group that the next
      // batch reconcile would replay from.
      expect(store.getState().blocks.map((b) => b.position)).toEqual([1, 2, 3, 4])
    })

    // #3759 — the vacated source group is renumbered from 1, matching the
    // backend's 1-based dense ranks. An off-by-one here is invisible in the
    // rendered ORDER (a uniform shift preserves the sort) but leaves the group
    // holding 0/-1 ranks that no backend reprojection can produce.
    it('densely renumbers the VACATED source group from 1 on a cross-parent batch', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'A', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 3, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 4, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['A', 'B'], 'P'))

      await store.getState().moveBlocks(['A', 'B'], 'P', 0)

      expect(reloaded()).toBe(false)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['P', 'A', 'B', 'C'])
      // Destination group (P's children) AND the vacated root group are both
      // dense and 1-based.
      expect(Object.fromEntries(store.getState().blocks.map((b) => [b.id, b.position]))).toEqual({
        P: 1,
        A: 1,
        B: 2,
        C: 2,
      })
    })

    // #3759 — the row-reuse guard is per-FIELD: a block whose dense rank happens
    // to be unchanged still needs a new row when its PARENT changed. Reusing the
    // old row on a rank match alone silently drops the reparent.
    it('re-parents a block whose new dense rank EQUALS its stored position', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P1', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          // X is P1's only child at rank 1; P2 is empty, so landing X there
          // gives it rank 1 again and ONLY its parent changes.
          makeBlock({ id: 'X', position: 1, parent_id: 'P1', depth: 1 }),
          makeBlock({ id: 'P2', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce(batchResp(['X'], 'P2'))

      await store.getState().moveBlocks(['X'], 'P2', 0)

      expect(reloaded()).toBe(false)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['P1', 'P2', 'X'])
      expect(store.getState().blocksById.get('X')?.parent_id).toBe('P2')
      expect(store.getState().blocksById.get('X')?.depth).toBe(1)
    })

    // #3759/#3799 — `moveBlocks` now has a `wouldCreateMoveCycle` guard that
    // rejects a cyclic request up front, so this reload is no longer the only
    // thing standing between such a request and a lost subtree. The two are
    // outcome-equivalent (a moved id whose new parent is its own descendant is
    // always absent from the rebuilt tree, so the presence check always caught
    // it too); this test still pins the backstop independently of the guard.
    it('falls back to a reload when a moved id would fall OUT of the rebuilt tree', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'A1', position: 1, parent_id: 'A', depth: 1 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      // A re-parented under its OWN child: the replayed bag holds the cycle
      // A→A1→A, which `buildFlatTree` cannot reach from the root and drops.
      mockedInvoke.mockResolvedValueOnce(batchResp(['A'], 'A1'))
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'A1', parent_id: 'A', position: 1 }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2 }),
        ]),
      )

      await store.getState().moveBlocks(['A'], 'A1', 0)

      expect(reloaded()).toBe(true)
      // Without the presence check the store would commit the rebuilt tree
      // ['B'] — both A and A1 gone from the page.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'A1', 'B'])
    })

    // #3759 — `wouldCreateMoveCycle` rejects UP FRONT and logs a warning
    // BEFORE returning null; the presence check below it (previous test)
    // reaches the SAME null/reload outcome for a DIFFERENT reason and never
    // logs. Asserting the exact warning call is the only way to prove the
    // cycle-guard branch itself ran, since both paths converge on "reload".
    it('rejects a cyclic move via the wouldCreateMoveCycle guard and logs a warning before falling back to reload', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      // Requesting to move A under itself — the simplest cycle
      // `wouldCreateMoveCycle` rejects (`orderedIds.includes(wantParent)`).
      mockedInvoke.mockResolvedValueOnce(batchResp(['A'], 'A'))
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2 }),
        ]),
      )

      await store.getState().moveBlocks(['A'], 'A', 0)

      expect(reloaded()).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(
        'page-blocks-move',
        'moveBlocks: rejected — newParentId would create a cycle',
        { orderedIds: ['A'], wantParent: 'A' },
      )
      warnSpy.mockRestore()
    })

    // #3759 — the presence check is the SOLE catch-all for a moved id that no
    // longer exists in local `blocks` AT ALL by commit time — as opposed to a
    // CYCLE (caught by `wouldCreateMoveCycle` above, which never fires here:
    // 'C' is absent, not a self/descendant match). Documented directly in
    // `reconcileBatchMove`'s own comment: "an id absent from `blocks`
    // entirely ... is likewise not a concern [for the cycle guard] ... the
    // presence check below remains the (sole, necessary) catch-all for that".
    // The pre-filter in the `moveBlocks` reducer (`ids.filter((id) =>
    // order.has(id))`) only runs against the CALL-TIME snapshot, so a
    // concurrent write landing AFTER that filter but BEFORE the batch IPC
    // resolves can still drop an already-`ordered` id out of `state.blocks`
    // by the time `reconcileBatchMove` reads it at commit time.
    it('falls back to a reload when a moved id vanishes from local state entirely by commit time (not a cycle)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      let resolveBatch!: (v: unknown) => void
      mockedInvoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBatch = resolve
          }),
      )
      // Queued for the reload the presence check will trigger.
      mockedInvoke.mockResolvedValueOnce(
        subtreeResp([
          makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1 }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2 }),
        ]),
      )

      const moving = store.getState().moveBlocks(['A', 'C'], 'PAGE_1', 1)

      // A concurrent sync load lands mid-flight and drops C from local state
      // — no cycle involved, C simply no longer exists by the time the batch
      // resolves.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 1, parent_id: 'PAGE_1', depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: 'PAGE_1', depth: 0 }),
        ],
      })

      // Backend still echoes success for BOTH requested ids — it processed
      // the request before C's local removal landed.
      resolveBatch(batchResp(['A', 'C'], 'PAGE_1'))
      await moving

      // Without the presence check, C would silently vanish from the
      // committed tree instead of triggering a reconciling reload.
      expect(reloaded()).toBe(true)
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

    // #3320 — `reconcileBatchMove` densely renumbers only the destination and
    // vacated-source sibling groups; every OTHER group falls through with its
    // stale, possibly duplicated/out-of-order `position` integers untouched,
    // and `buildFlatTree`'s position-only sibling sort then re-derives that
    // group's RENDERED order from those stale integers instead of reproducing
    // it. A prior version of `reconcileBatchMove`'s doc comment argued sort
    // STABILITY rescues this — wrong: stability only preserves relative order
    // among EQUAL keys, not among keys that are already out of order.
    it('#3320 — a batch move in a disjoint parent does not scramble an untouched sibling group left stale by prior optimistic reorders', async () => {
      // GROUP_A and GROUP_B are two sibling containers under the page root,
      // each with their own children — GROUP_B is wholly DISJOINT from
      // GROUP_A (neither destination nor vacated source for the batch move
      // below).
      const groupA = makeBlock({ id: 'GROUP_A', position: 1, parent_id: 'PAGE_1', depth: 0 })
      const groupB = makeBlock({ id: 'GROUP_B', position: 2, parent_id: 'PAGE_1', depth: 0 })
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: 'GROUP_A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: 'GROUP_A', depth: 1 })
      const blockC = makeBlock({ id: 'C', position: 3, parent_id: 'GROUP_A', depth: 1 })
      const blockD = makeBlock({ id: 'D', position: 4, parent_id: 'GROUP_A', depth: 1 })
      const blockP = makeBlock({ id: 'P', position: 1, parent_id: 'GROUP_B', depth: 1 })
      const blockQ = makeBlock({ id: 'Q', position: 2, parent_id: 'GROUP_B', depth: 1 })
      const blockR = makeBlock({ id: 'R', position: 3, parent_id: 'GROUP_B', depth: 1 })
      store.setState({
        blocks: [groupA, groupB, blockA, blockB, blockC, blockD, blockP, blockQ, blockR],
      })

      // Three stacked, legal, unrelated single-block reorders inside GROUP_A
      // — the worked counterexample from the `reconcileBatchMove` doc
      // comment: dense run A=1,B=2,C=3,D=4 → reorder(C,0) → reorder(D,0) →
      // reorder(B,1) leaves array order [D,B,C,A] with STALE/duplicated
      // stored positions D=1,B=2,C=1,A=1 (each reorder heals only the ONE
      // moved block's `position`, per #404).
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GROUP_A',
        new_position: 1,
      })
      await store.getState().reorder('C', 0)

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'D',
        new_parent_id: 'GROUP_A',
        new_position: 1,
      })
      await store.getState().reorder('D', 0)

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'GROUP_A',
        new_position: 2,
      })
      await store.getState().reorder('B', 1)

      // Sanity: GROUP_A is now exactly the corrupting pre-state the issue
      // describes — rendered order [D,B,C,A] with stale/duplicate positions.
      const beforeBatch = store.getState().blocks
      expect(beforeBatch.filter((b) => b.parent_id === 'GROUP_A').map((b) => b.id)).toEqual([
        'D',
        'B',
        'C',
        'A',
      ])
      expect(
        Object.fromEntries(
          beforeBatch.filter((b) => b.parent_id === 'GROUP_A').map((b) => [b.id, b.position]),
        ),
      ).toEqual({ D: 1, B: 2, C: 1, A: 1 })
      const untouchedD = beforeBatch.find((b) => b.id === 'D')
      const untouchedB = beforeBatch.find((b) => b.id === 'B')
      expect(store.getState().blocksById.get('D')).toBe(untouchedD)
      expect(store.getState().blocksById.get('B')).toBe(untouchedB)

      // A MULTI-SELECT batch move entirely inside GROUP_B — GROUP_A is
      // neither the destination nor a vacated source.
      mockedInvoke.mockResolvedValueOnce(batchResp(['R'], 'GROUP_B'))
      await store.getState().moveBlocks(['R'], 'GROUP_B', 0)

      const after = store.getState().blocks
      // GROUP_B's own batch move landed correctly.
      expect(after.filter((b) => b.parent_id === 'GROUP_B').map((b) => b.id)).toEqual([
        'R',
        'P',
        'Q',
      ])
      // GROUP_A's RENDERED order must survive untouched. Pre-fix, buildFlatTree
      // re-sorted GROUP_A by its stale (position, array-index) keys and
      // produced [D,C,A,B] — a scramble of a group nobody in this move
      // touched (the issue's exact worked-example result).
      expect(after.filter((b) => b.parent_id === 'GROUP_A').map((b) => b.id)).toEqual([
        'D',
        'B',
        'C',
        'A',
      ])
      // The fix also heals GROUP_A's stale positions to a fresh dense rank
      // matching that rendered order.
      expect(
        Object.fromEntries(
          after.filter((b) => b.parent_id === 'GROUP_A').map((b) => [b.id, b.position]),
        ),
      ).toEqual({ D: 1, B: 2, C: 3, A: 4 })
      // D/B already had the dense ranks that reconciliation requested. They
      // are outside the moved sibling group and therefore keep their exact
      // FlatBlock identities through buildFlatTree; only C/A need new rows to
      // heal their stale ranks.
      expect(after.find((b) => b.id === 'D')).toBe(untouchedD)
      expect(after.find((b) => b.id === 'B')).toBe(untouchedB)
      expect(store.getState().blocksById.get('D')).toBe(untouchedD)
      expect(store.getState().blocksById.get('B')).toBe(untouchedB)
    })
  })
})

// #3759 — direct unit coverage for `wouldCreateMoveCycle`, per its own doc
// comment ("Exported for direct unit coverage"): pin the pure predicate's
// branches here instead of reaching them only indirectly through `moveBlocks`
// three call-frames away, where a broken check surfaces as a silent tree
// scramble rather than a failing assertion at the source.
describe('wouldCreateMoveCycle', () => {
  it('is not a cycle when the requested parent is root (null)', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    expect(wouldCreateMoveCycle([a], ['A'], null)).toBe(false)
  })

  it('is not a cycle when the requested parent is unrelated to the moved roots', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    const x = makeBlock({ id: 'X', parent_id: null, depth: 0 })
    expect(wouldCreateMoveCycle([a, x], ['A'], 'X')).toBe(false)
  })

  it('is a cycle when the requested parent IS one of the moved roots (self-parent)', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    expect(wouldCreateMoveCycle([a], ['A'], 'A')).toBe(true)
  })

  // Also distinguishes `.some` from `.every` (only A's subtree contains D)
  // and the per-id lambda from a constant-`undefined` stand-in (only a real
  // per-id `.has(wantParent)` check can find D under A but not under B).
  it('is a cycle when the requested parent is a DESCENDANT of only ONE of several moved roots', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    const d = makeBlock({ id: 'D', parent_id: 'A', depth: 1 })
    const b = makeBlock({ id: 'B', parent_id: null, depth: 0 })
    expect(wouldCreateMoveCycle([a, d, b], ['A', 'B'], 'D')).toBe(true)
  })

  // EQUIVALENCE — the `if (wantParent == null) return false` guard skipped
  // outright (Stryker's `if (false)` ConditionalExpression mutant at this
  // line): `orderedIds` is always `readonly string[]` and every `FlatBlock.id`
  // is always a `string`, so for `wantParent === null`, both
  // `orderedIds.includes(null)` and `getDragDescendants(...).has(null)` are
  // ALWAYS false regardless of `blocks`/`orderedIds` content (no string ever
  // `===` `null`) — the fall-through path converges on the exact same `false`
  // the early return would have produced. Killing this would require an id
  // that is literally `null` at runtime, contradicting the `string[]`
  // contract every real caller (and this suite) respects. Confirmed by
  // applying the mutation by hand and running this file plus
  // `page-blocks.move-reparent.test.ts`: unchanged green (not the proof
  // itself — the argument above is — just consistent with it).
})
