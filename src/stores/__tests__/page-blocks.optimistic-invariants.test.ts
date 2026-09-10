// Split from the page-blocks.test.ts monolith (#2929). Concern: optimistic
// block writes, the blocksById Map invariant, and storeOwnsBlock.
import { invoke } from '@tauri-apps/api/core'
import { act, render } from '@testing-library/react'
import { createElement, type ReactElement, useRef } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow, withOps } from '@/__tests__/fixtures'
import {
  type CommandReturns,
  mockInvokeCommands,
  strictInvokeFallback,
  type TypedInvokeHandlers,
} from '@/__tests__/helpers/invoke'
import type { BlockRow } from '@/lib/bindings'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import {
  createPageBlockStore,
  type FlatBlock,
  PageBlockContext,
  type PageBlockState,
  storeOwnsBlock,
  usePageBlockStore,
} from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'

// #1258 — `load_page_subtree` now returns `{ blocks, truncated, total }`
// (the `PageSubtree` wrapper) instead of a bare `BlockRow[]`. `load()` reads
// `.blocks` and surfaces `.truncated`/`.total`. This helper wraps a row array
// in the un-truncated shape so the many `load()` mocks below keep their
// intent (a full, non-truncated page load) without each spelling out the
// wrapper. See the dedicated truncation test for the `truncated: true` path.
function subtreeResp(blocks: BlockRow[]): CommandReturns['load_page_subtree'] {
  return { blocks, truncated: false, total: blocks.length }
}

/**
 * Install this test's command-keyed `invoke` handlers. Anything the store
 * fires that is not listed hits `strictInvokeFallback` and fails by name
 * instead of stealing a positional slot (#3217).
 */
function stubInvoke(handlers: TypedInvokeHandlers): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/** A `move_block` response: `WithOps<MoveResponse>`, `op_refs` included. */
function moveResp(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): CommandReturns['move_block'] {
  return withOps({ block_id: blockId, new_parent_id: newParentId, new_position: newPosition })
}

/** The `edit_block` echo: the row the backend just wrote, `WithOps`-wrapped. */
function echoEditBlock(args: Record<string, unknown>): CommandReturns['edit_block'] {
  return withOps(
    makeBlockRow({ id: args['blockId'] as string, content: args['toText'] as string, position: 0 }),
  )
}

/**
 * A successful `delete_block`: `WithOps<DeleteResponse>`, whose `deleted_at` is
 * epoch-ms (migration 0080) and which carries the cascade's `affected_page_ids`.
 */
function deleteResp(blockId: string, descendantsAffected: number): CommandReturns['delete_block'] {
  return withOps({
    block_id: blockId,
    deleted_at: 1_735_689_600_000,
    descendants_affected: descendantsAffected,
    affected_page_ids: [],
  })
}

/**
 * A promise the test settles by hand, so one command's response can be parked
 * while the flow's OTHER commands (an interleaved edit, the reconciling load)
 * keep answering — which a positional `…Once` queue cannot model (#3217).
 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
    // Every test installs its own persistent implementation, so restore the
    // strict base first — otherwise one test's handlers would serve the next.
    mockedInvoke.mockImplementation(strictInvokeFallback)
    // #2849 PR2 — reset the client-ULID counter so each test's first
    // `createBelow` mints `CID_1` deterministically.
    resetClientIds()
    // #2850 — the prefetch map is a module-level singleton; reset it so a
    // prefetch parked by one test can never leak into the next.
    _resetPrefetchPageSubtreeForTest()
  })

  describe('optimistic block writes (#2849)', () => {
    /** Array/Map consistency: same length, every array entry present in the Map. */
    function expectMapMatchesArray(s: PageBlockState): void {
      expect(s.blocksById.size).toBe(s.blocks.length)
      for (const b of s.blocks) expect(s.blocksById.get(b.id)).toBe(b)
    }

    const root = (id: string, position: number) =>
      makeBlock({ id, position, parent_id: null, depth: 0 })

    // ── remove ────────────────────────────────────────────────────────────
    describe('remove', () => {
      it('(a) the provisional removal is visible BEFORE the delete IPC resolves', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const del = deferred<CommandReturns['delete_block']>()
        stubInvoke({ delete_block: () => del.promise, edit_block: echoEditBlock })

        const p = store.getState().remove('A')
        // Applied synchronously — no await needed to see A gone.
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B'])

        del.resolve(deleteResp('A', 1))
        await p
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B'])
        expectMapMatchesArray(store.getState())
      })

      it('(b) a successful delete keeps the block removed and notifies undo', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        stubInvoke({ delete_block: () => deleteResp('A', 1) })

        await store.getState().remove('A')

        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B'])
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })

      it('(c) an IPC rejection rolls back to the EXACT pre-op state (same refs)', async () => {
        const a = root('A', 0)
        const b = root('B', 1)
        store.setState({ blocks: [a, b] })
        const before = store.getState().blocks
        stubInvoke({ delete_block: () => Promise.reject(new Error('delete failed')) })

        await store.getState().remove('A')

        // Exact restore — the pre-op array AND its entries by reference.
        expect(store.getState().blocks).toBe(before)
        expect(store.getState().blocks[0]).toBe(a)
        expect(store.getState().blocks[1]).toBe(b)
        expectMapMatchesArray(store.getState())
        expect(toast.error).toHaveBeenCalledWith('Failed to delete block')
      })

      it('(d) an interleaved edit survives and the removal still commits (no clobber)', async () => {
        store.setState({ blocks: [root('A', 0), makeBlock({ id: 'B', content: 'old B' })] })
        const del = deferred<CommandReturns['delete_block']>()
        stubInvoke({ delete_block: () => del.promise, edit_block: echoEditBlock })

        const p = store.getState().remove('A')
        // Interleave an edit flush on a surviving block while delete is in flight.
        await store.getState().edit('B', 'edited mid-flight')

        del.resolve(deleteResp('A', 1))
        await p

        const s = store.getState()
        // A stays removed; the interleaved edit survived; no duplicate B.
        expect(s.blocks.map((b) => b.id)).toEqual(['B'])
        expect(s.blocksById.get('B')?.content).toBe('edited mid-flight')
        expectMapMatchesArray(s)
      })

      it('(e) undo is NOT notified until the delete IPC resolves (undo-before-settle race)', async () => {
        store.setState({ blocks: [root('A', 0)] })
        const del = deferred<CommandReturns['delete_block']>()
        stubInvoke({ delete_block: () => del.promise, edit_block: echoEditBlock })

        const p = store.getState().remove('A')
        // The provisional removal shows immediately, but Ctrl+Z now would find
        // no registered action for this delete — it lands only on resolve.
        expect(store.getState().blocks).toHaveLength(0)
        expect(mockOnNewAction).not.toHaveBeenCalled()

        del.resolve(deleteResp('A', 1))
        await p
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })
    })

    // ── indent (cross-parent structural move) ──────────────────────────────
    describe('indent', () => {
      it('(a) the provisional indent is visible BEFORE the move IPC resolves', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        stubInvoke({ move_block: () => move.promise, edit_block: echoEditBlock })

        const p = store.getState().indent('B')
        const bp = store.getState().blocksById.get('B')
        expect(bp?.parent_id).toBe('A')
        expect(bp?.depth).toBe(1)

        move.resolve(moveResp('B', 'A', 0))
        await expect(p).resolves.toBe(true)
        expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
        expectMapMatchesArray(store.getState())
      })

      it('(b) success confirms the indent and notifies undo', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        stubInvoke({ move_block: () => moveResp('B', 'A', 0) })

        await expect(store.getState().indent('B')).resolves.toBe(true)

        expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })

      it('(c) an IPC rejection rolls back to the EXACT pre-op state (same refs)', async () => {
        const a = root('A', 0)
        const b = root('B', 1)
        store.setState({ blocks: [a, b] })
        const before = store.getState().blocks
        stubInvoke({ move_block: () => Promise.reject(new Error('move failed')) })

        await expect(store.getState().indent('B')).resolves.toBe(false)

        expect(store.getState().blocks).toBe(before)
        expect(store.getState().blocks[1]).toBe(b)
        expect(store.getState().blocksById.get('B')?.parent_id).toBeNull()
        expectMapMatchesArray(store.getState())
      })

      it('(d) an interleaved edit survives and the indent commits exactly once (no double-apply)', async () => {
        store.setState({
          blocks: [makeBlock({ id: 'A', content: 'old A', position: 0 }), root('B', 1)],
        })
        const move = deferred<CommandReturns['move_block']>()
        stubInvoke({ move_block: () => move.promise, edit_block: echoEditBlock })

        const p = store.getState().indent('B')
        await store.getState().edit('A', 'edited mid-flight')

        move.resolve(moveResp('B', 'A', 0))
        await expect(p).resolves.toBe(true)

        const s = store.getState()
        expect(s.blocks.map((b) => b.id)).toEqual(['A', 'B'])
        // B appears exactly once — the provisional splice was not re-applied.
        expect(s.blocks.filter((b) => b.id === 'B')).toHaveLength(1)
        expect(s.blocksById.get('B')?.parent_id).toBe('A')
        expect(s.blocksById.get('A')?.content).toBe('edited mid-flight')
        expectMapMatchesArray(s)
      })

      it('(e) undo is NOT notified until the move IPC resolves (undo-before-settle race)', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        stubInvoke({ move_block: () => move.promise, edit_block: echoEditBlock })

        const p = store.getState().indent('B')
        expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
        expect(mockOnNewAction).not.toHaveBeenCalled()

        move.resolve(moveResp('B', 'A', 0))
        await p
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })
    })

    // ── moveUp (same-parent swap) ──────────────────────────────────────────
    describe('moveUp', () => {
      it('(a) the provisional swap is visible BEFORE the move IPC resolves', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        stubInvoke({ move_block: () => move.promise, edit_block: echoEditBlock })

        const p = store.getState().moveUp('B')
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'A'])

        move.resolve(moveResp('B', null, 0))
        await expect(p).resolves.toBe(true)
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'A'])
        expectMapMatchesArray(store.getState())
      })

      it('(b) success heals the moved block position to the backend dense rank', async () => {
        store.setState({ blocks: [root('A', 1), root('B', 2)] })
        stubInvoke({ move_block: () => moveResp('B', null, 1) })

        await expect(store.getState().moveUp('B')).resolves.toBe(true)

        const s = store.getState()
        expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
        // Provisional kept B's old position (2); resolve healed it to 1.
        expect(s.blocks[0]?.position).toBe(1)
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })

      it('(c) an IPC rejection rolls back to the EXACT pre-op state (same refs)', async () => {
        const a = root('A', 0)
        const b = root('B', 1)
        store.setState({ blocks: [a, b] })
        const before = store.getState().blocks
        stubInvoke({ move_block: () => Promise.reject(new Error('move failed')) })

        await expect(store.getState().moveUp('B')).resolves.toBe(false)

        expect(store.getState().blocks).toBe(before)
        expect(store.getState().blocks[0]).toBe(a)
        expect(store.getState().blocks[1]).toBe(b)
        expectMapMatchesArray(store.getState())
      })

      it('(d) a rapid second press computes against the APPLIED provisional first move (no collapse)', async () => {
        // A,B,C at root. Two rapid moveUp('C') before the first resolves must
        // climb C two slots (past B, then past A), reading the post-first-move
        // provisional state — not a stale pre-move snapshot.
        store.setState({ blocks: [root('A', 0), root('B', 1), root('C', 2)] })
        // The ORDER is the subject: the first press lands C at slot 1, the
        // second — computed against the applied first move — at slot 0.
        let press = 0
        stubInvoke({ move_block: () => moveResp('C', null, press++ === 0 ? 1 : 0) })

        const p1 = store.getState().moveUp('C')
        const p2 = store.getState().moveUp('C')
        const [r1, r2] = await Promise.all([p1, p2])

        expect(r1).toBe(true)
        expect(r2).toBe(true)
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'B'])
        expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'move_block', {
          blockId: 'C',
          newParentId: null,
          newIndex: 1,
        })
        expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'move_block', {
          blockId: 'C',
          newParentId: null,
          newIndex: 0,
        })
        expectMapMatchesArray(store.getState())
      })

      it('(e) undo is NOT notified until the move IPC resolves (undo-before-settle race)', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        stubInvoke({ move_block: () => move.promise, edit_block: echoEditBlock })

        const p = store.getState().moveUp('B')
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'A'])
        expect(mockOnNewAction).not.toHaveBeenCalled()

        move.resolve(moveResp('B', null, 0))
        await p
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
      })
    })

    // ── createBelow (optimistic pre-await insert, #2849 PR2) ────────────────
    // The new block's id is generated CLIENT-side (mocked to `CID_1`) so the row
    // can be spliced in before the create IPC resolves and the id is stable from
    // insertion — focus/selection never relocate to a server-minted id.
    describe('createBelow', () => {
      it('(a) the provisional block is visible BEFORE the create IPC resolves, under the client id', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const create = deferred<CommandReturns['create_block']>()
        stubInvoke({ create_block: () => create.promise, edit_block: echoEditBlock })

        const p = store.getState().createBelow('A', 'new')
        // Spliced synchronously with the client id — before any await.
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])
        expect(store.getState().blocksById.get('CID_1')?.content).toBe('new')
        // The create IPC carried the client id verbatim.
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_block',
          expect.objectContaining({ blockId: 'CID_1', content: 'new' }),
        )

        create.resolve(withOps(makeBlockRow({ id: 'CID_1', content: 'new', position: 1 })))
        await expect(p).resolves.toBe('CID_1')
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])
        expectMapMatchesArray(store.getState())
      })

      it('(b) success confirms in place — no id swap, focus stays, position healed', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        // Backend echoes the client id and returns the authoritative dense rank.
        stubInvoke({
          create_block: () => withOps(makeBlockRow({ id: 'CID_1', content: 'new', position: 2 })),
        })

        const newId = await store.getState().createBelow('A', 'new')

        // No id swap: the returned id is the client id already in the store.
        expect(newId).toBe('CID_1')
        const s = store.getState()
        expect(s.blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])
        // Provisional carried `position: null`; the resolve healed it to the
        // backend dense rank (2).
        expect(s.blocksById.get('CID_1')?.position).toBe(2)
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', [])
        expectMapMatchesArray(s)
      })

      it('(c) an IPC rejection rolls back to the EXACT pre-op state (same refs)', async () => {
        const a = root('A', 0)
        const b = root('B', 1)
        store.setState({ blocks: [a, b] })
        const before = store.getState().blocks
        stubInvoke({ create_block: () => Promise.reject(new Error('create failed')) })

        await expect(store.getState().createBelow('A', 'x')).resolves.toBeNull()

        // Exact restore — the pre-op array AND its entries by reference; the
        // provisional block is gone from both structures.
        expect(store.getState().blocks).toBe(before)
        expect(store.getState().blocks[0]).toBe(a)
        expect(store.getState().blocks[1]).toBe(b)
        expect(store.getState().blocksById.has('CID_1')).toBe(false)
        expectMapMatchesArray(store.getState())
        expect(toast.error).toHaveBeenCalledWith('Failed to create block')
      })

      it('(d) a concurrent write that built on the provisional block is not clobbered by rollback', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const create = deferred<CommandReturns['create_block']>()
        // The guarded rollback must reload (not restore the stale [A,B] pre-op
        // snapshot, which would DROP both CID_1 and the child built on it).
        stubInvoke({
          create_block: () => create.promise,
          load_page_subtree: () =>
            subtreeResp([
              makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
              makeBlock({ id: 'CID_1', parent_id: 'PAGE_1', position: 1 }),
              makeBlock({ id: 'CHILD', parent_id: 'CID_1', position: 0 }),
              makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2 }),
            ]),
        })

        const p = store.getState().createBelow('A', 'x')
        // Provisional: [A, CID_1, B].
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'B'])

        // A concurrent write builds ON the provisional block: a child was
        // indented under CID_1 while create_block was in flight (fresh array
        // ref, so the pre-op snapshot no longer equals live state).
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'CID_1', position: 1, parent_id: null, depth: 0 }),
            makeBlock({ id: 'CHILD', position: 0, parent_id: 'CID_1', depth: 1 }),
            makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
          ],
        })
        // Reject the deferred create IPC, driving the catch/rollback.
        create.reject(new Error('create failed'))
        await expect(p).resolves.toBeNull()

        expect(mockedInvoke).toHaveBeenCalledWith(
          'load_page_subtree',
          expect.objectContaining({ rootBlockId: 'PAGE_1' }),
        )
        // The concurrent child survives — the stale snapshot did not clobber it.
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'CHILD', 'B'])
        expectMapMatchesArray(store.getState())
      })
    })

    // ── adversarial interleavings (traps #2/#3/#4) ─────────────────────────
    // These exercise the reconcile/rollback branches a benign in-flight edit
    // does NOT reach: a racing load() that REVERTS or SUPERSEDES the provisional
    // splice mid-flight, and a delete-subtree whose descendant set changed under
    // it. Each simulates the concurrent write with `store.setState({ blocks })`
    // (a fresh array ref — exactly what a real load() replacement produces),
    // mirroring the #714 stale-capture suite's technique.
    describe('interleavings', () => {
      it('trap#2 — indent: a racing load() reverts the move mid-flight, success reconciles via reload (no stale provisional)', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        // The reconcile detects supersession (B no longer under A at provIndex)
        // and reloads; the backend now has the indent committed.
        stubInvoke({
          move_block: () => move.promise,
          load_page_subtree: () =>
            subtreeResp([
              makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
              makeBlock({ id: 'B', parent_id: 'A', position: 0 }),
            ]),
        })

        const p = store.getState().indent('B')
        // Provisional applied: B under A.
        expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')

        // A racing load() lands mid-flight whose backend snapshot PREDATED the
        // indent — it reverts B to root (fresh array ref, like a real reload).
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          ],
        })

        move.resolve(moveResp('B', 'A', 0))
        await expect(p).resolves.toBe(true)

        // Reconciled from the backend, NOT left in the reverted-provisional limbo.
        expect(mockedInvoke).toHaveBeenCalledWith(
          'load_page_subtree',
          expect.objectContaining({ rootBlockId: 'PAGE_1' }),
        )
        expect(store.getState().blocksById.get('B')?.parent_id).toBe('A')
        expectMapMatchesArray(store.getState())
      })

      it('trap#4a — remove: a racing load() restores the whole subtree mid-flight, success re-splices it out (#2543)', async () => {
        // A → C (C is A's child). Deleting A must cascade C.
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'C', position: 0, parent_id: 'A', depth: 1 }),
          ],
        })
        const del = deferred<CommandReturns['delete_block']>()
        stubInvoke({ delete_block: () => del.promise, edit_block: echoEditBlock })

        const p = store.getState().remove('A')
        // Provisional: both A and its descendant C gone.
        expect(store.getState().blocks).toHaveLength(0)

        // A racing load() (snapshot predating the delete commit) restores the
        // FULL subtree while delete_block is in flight.
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'C', position: 0, parent_id: 'A', depth: 1 }),
          ],
        })

        del.resolve(deleteResp('A', 2))
        await p

        // Commit-time re-confirm removed A AND its recomputed descendant C.
        expect(store.getState().blocks).toHaveLength(0)
        expectMapMatchesArray(store.getState())
      })

      it('trap#4b — remove: a child dedented OUT mid-flight survives the commit-time re-confirm (fresh descendants)', async () => {
        // A → C. Deleting A; but a racing load() shows C reparented to root
        // (dedented OUT) with A still present. C must NOT be dropped: it is no
        // longer a descendant of A, so the backend kept it alive.
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'C', position: 0, parent_id: 'A', depth: 1 }),
          ],
        })
        const del = deferred<CommandReturns['delete_block']>()
        stubInvoke({ delete_block: () => del.promise, edit_block: echoEditBlock })

        const p = store.getState().remove('A')
        expect(store.getState().blocks).toHaveLength(0)

        // Racing load(): A present, C now a root sibling (moved out of A).
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'C', position: 1, parent_id: null, depth: 0 }),
          ],
        })

        del.resolve(deleteResp('A', 1))
        await p

        // Only A removed; the dedented-out C survives (fresh descendant recompute).
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['C'])
        expectMapMatchesArray(store.getState())
      })

      it('trap#3 — moveUp: a concurrent write lands before an IPC rejection, rollback reloads instead of clobbering it', async () => {
        store.setState({ blocks: [root('A', 0), root('B', 1)] })
        const move = deferred<CommandReturns['move_block']>()
        // The guarded rollback must reload (not restore the stale [A,B] pre-op
        // snapshot, which would DROP the concurrently-synced C).
        stubInvoke({
          move_block: () => move.promise,
          load_page_subtree: () =>
            subtreeResp([
              makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
              makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 }),
              makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 2 }),
            ]),
        })

        const p = store.getState().moveUp('B')
        // Provisional swap: [B, A].
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'A'])

        // A concurrent write (e.g. a synced remote insert of C) lands while
        // move_block is in flight — fresh array ref, so the pre-op snapshot no
        // longer equals live state.
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
            makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
            makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
          ],
        })
        // Reject the deferred move IPC, driving the mover's catch/rollback.
        move.reject(new Error('move failed'))
        await expect(p).resolves.toBe(false)

        expect(mockedInvoke).toHaveBeenCalledWith(
          'load_page_subtree',
          expect.objectContaining({ rootBlockId: 'PAGE_1' }),
        )
        // C preserved — the stale snapshot did not clobber the concurrent write.
        expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
        expectMapMatchesArray(store.getState())
      })

      it('trap#1/ABA — moveUp: position heal writes only the moved block, never corrupts array order', async () => {
        // Backend echoes a dense rank (1) differing from the stale provisional
        // position (2). The heal must update ONLY B's position, leaving array
        // order (authoritative) untouched.
        store.setState({ blocks: [root('A', 5), root('B', 9)] })
        stubInvoke({ move_block: () => moveResp('B', null, 1) })

        await expect(store.getState().moveUp('B')).resolves.toBe(true)

        const s = store.getState()
        expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
        expect(s.blocks[0]?.position).toBe(1) // healed
        expect(s.blocks[1]?.position).toBe(5) // A untouched
        expectMapMatchesArray(s)
      })
    })
  })
  describe('blocksById Map invariant', () => {
    it('seeds an empty Map on a freshly created store', () => {
      const fresh = createPageBlockStore('PAGE_FRESH')
      const { blocks, blocksById } = fresh.getState()
      expect(blocks).toEqual([])
      expect(blocksById).toBeInstanceOf(Map)
      expect(blocksById.size).toBe(0)
    })

    it('load() populates blocksById from the loaded blocks', async () => {
      const items = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ]
      stubInvoke({ load_page_subtree: () => subtreeResp(items) })

      await store.getState().load()

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(2)
      expect(blocksById.get('A')).toBe(blocks[0])
      expect(blocksById.get('B')).toBe(blocks[1])
    })

    it('createBelow keeps blocksById in sync', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      stubInvoke({
        create_block: () => withOps(makeBlockRow({ id: 'CID_1', content: 'new', position: 1 })),
      })

      await store.getState().createBelow('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      expect(blocksById.get('CID_1')?.content).toBe('new')
      expect(blocksById.get('A')?.id).toBe('A')
    })

    it('edit keeps blocksById in sync', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      stubInvoke({ edit_block: echoEditBlock })

      await store.getState().edit('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.get('A')?.content).toBe('new')
      expect(blocksById.get('A')).toBe(blocks[0])
    })

    it('remove keeps blocksById in sync', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      })
      stubInvoke({ delete_block: () => deleteResp('A', 1) })

      await store.getState().remove('A')

      const { blocks, blocksById } = store.getState()
      expect(blocks).toHaveLength(1)
      expect(blocksById.size).toBe(1)
      expect(blocksById.has('A')).toBe(false)
      expect(blocksById.get('B')?.id).toBe('B')
    })

    it('reorder keeps blocksById in sync', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      stubInvoke({ move_block: () => moveResp('A', null, 2) })

      await store.getState().reorder('A', 1)

      const { blocks, blocksById } = store.getState()
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(blocksById.size).toBe(2)
      // Map points to the new array entries (after reorder).
      expect(blocksById.get('A')).toBe(blocks[1])
      expect(blocksById.get('B')).toBe(blocks[0])
    })

    it('indent keeps blocksById in sync', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      // #774 — indent checks the backend parent echo; echo the requested
      // parent ('A') so the local-splice path runs (was a bare `undefined`).
      stubInvoke({ move_block: () => moveResp('B', 'A', 0) })

      await store.getState().indent('B')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      // Indented block's depth/parent updated and the Map entry reflects that.
      const indented = blocksById.get('B')
      expect(indented?.parent_id).toBe('A')
      expect(indented?.depth).toBe(1)
    })

    it('dedent keeps blocksById in sync', async () => {
      const parent = makeBlock({ id: 'P', position: 1, parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', position: 1, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child] })
      stubInvoke({ move_block: () => moveResp('C', null, 2) })

      await store.getState().dedent('C')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      const dedented = blocksById.get('C')
      expect(dedented?.parent_id).toBe(null)
      expect(dedented?.depth).toBe(0)
    })

    it('edit rollback on backend error restores both blocks and blocksById', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      stubInvoke({ edit_block: () => Promise.reject(new Error('edit failed')) })

      await store.getState().edit('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocks[0]?.content).toBe('old')
      expect(blocksById.get('A')?.content).toBe('old')
      expect(blocksById.get('A')).toBe(blocks[0])
    })

    it('produces a fresh Map reference on every blocks-touching mutation', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      const map1 = store.getState().blocksById

      stubInvoke({ edit_block: echoEditBlock })
      await store.getState().edit('A', 'new')
      const map2 = store.getState().blocksById
      expect(map2).not.toBe(map1)

      stubInvoke({
        create_block: () =>
          withOps(makeBlockRow({ id: 'NEW', block_type: 'text', content: '', position: 1 })),
      })
      await store.getState().createBelow('A')
      const map3 = store.getState().blocksById
      expect(map3).not.toBe(map2)
    })

    it('subscribe listeners fire when blocksById changes', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      const seen: Map<string, FlatBlock>[] = []
      const unsub = store.subscribe((state, prev) => {
        if (state.blocksById !== prev.blocksById) seen.push(state.blocksById)
      })

      stubInvoke({ edit_block: echoEditBlock })
      await store.getState().edit('A', 'new')

      expect(seen).toHaveLength(1)
      expect(seen[0]?.get('A')?.content).toBe('new')
      unsub()
    })

    it('getBlockById returns the matching block or undefined', () => {
      const a = makeBlock({ id: 'A' })
      const b = makeBlock({ id: 'B' })
      store.setState({ blocks: [a, b] })

      expect(store.getState().getBlockById('A')?.id).toBe('A')
      expect(store.getState().getBlockById('B')?.id).toBe('B')
      expect(store.getState().getBlockById('NOPE')).toBeUndefined()
    })

    it('external setState({ blocks }) auto-derives blocksById', () => {
      store.setState({ blocks: [makeBlock({ id: 'X' }), makeBlock({ id: 'Y' })] })

      const { blocksById } = store.getState()
      expect(blocksById.size).toBe(2)
      expect(blocksById.get('X')?.id).toBe('X')
      expect(blocksById.get('Y')?.id).toBe('Y')
    })

    it('external setState honours an explicitly provided blocksById', () => {
      const explicit = new Map<string, ReturnType<typeof makeBlock>>([
        // Intentionally drop one entry so we can prove the explicit Map wins
        // over the would-be auto-derived one.
        ['A', makeBlock({ id: 'A' })],
      ])
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
        blocksById: explicit,
      })

      expect(store.getState().blocksById).toBe(explicit)
      expect(store.getState().blocksById.size).toBe(1)
    })

    it('setState that does not touch blocks leaves blocksById identity intact', () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })
      const before = store.getState().blocksById

      store.setState({ loading: false })

      expect(store.getState().blocksById).toBe(before)
    })

    // ── perf invariant (perf-review Tier 1 #2, 2026-05-09) ───────────────
    // Single-block-edit hot paths MUST NOT walk the entire `blocks` array to
    // rebuild `blocksById`. They derive the new Map from the previous one and
    // touch only the affected keys (`cloneBlocksByIdWith` / `cloneBlocksByIdWithout`).
    //
    // We assert this by counting reads of the per-block `.id` property across
    // a single `edit()` call. The old `buildBlocksById(newBlocks)` path walks
    // every block in the new array and reads `b.id` once per entry (to use as
    // the Map key) — yielding at least N reads. The new cloneBlocksByIdWith
    // path clones via `new Map(prev)`, which iterates the existing Map's
    // internal slots without touching any FlatBlock's `.id` property, then
    // sets the single touched key. Result: zero `.id` reads on the
    // unedited blocks during the Map rebuild.
    //
    // We still allow a few `.id` reads (logger context, etc.) so the
    // threshold is generous: any regression to a full-scan rebuild would
    // produce O(N) reads, far above the small constant we allow.
    it('edit() does not full-scan rebuild blocksById from the blocks array', async () => {
      // Seed a 50-block page — large enough that a regression to full-scan
      // would produce ~50 .id reads on top of any normal overhead.
      const N = 50
      const idReads = new Map<string, number>()
      const seeded = Array.from({ length: N }, (_, i) => {
        const raw = makeBlock({
          id: `B${i}`,
          content: `c${i}`,
          position: i,
          parent_id: 'PAGE_1',
        })
        idReads.set(raw.id, 0)
        // Replace `.id` with an accessor that bumps a counter on read while
        // preserving the same value semantics.
        const trueId = raw.id
        Object.defineProperty(raw, 'id', {
          get() {
            idReads.set(trueId, (idReads.get(trueId) ?? 0) + 1)
            return trueId
          },
          enumerable: true,
          configurable: true,
        })
        return raw
      })
      store.setState({ blocks: seeded })

      // Reset counters after seeding (setState calls augmentBlocksUpdate,
      // which legitimately walks the blocks array once on this entry path
      // — that's seeding, not the hot path we're measuring).
      for (const k of idReads.keys()) idReads.set(k, 0)

      stubInvoke({ edit_block: echoEditBlock })
      await store.getState().edit('B25', 'edited content')

      const total = [...idReads.values()].reduce((a, b) => a + b, 0)
      // The hot path may legitimately read `.id` on the edited block (to
      // identify it during `state.blocks.map`) — that's O(N) array walks
      // touching `.id` for every block. Wait: the `.map` callback reads
      // `b.id` on every entry. So we expect ~N reads from the `.map`
      // identity check. What we're guarding against is the SECOND O(N)
      // walk that `buildBlocksById` used to do. So budget: at most N + a
      // small constant. With the new cloneBlocksByIdWith path the second
      // walk is gone, leaving just the single `.map` traversal.
      expect(total).toBeLessThanOrEqual(N + 5)

      // Correctness check: the Map is right.
      const { blocksById } = store.getState()
      expect(blocksById.size).toBe(N)
      expect(blocksById.get('B25')?.content).toBe('edited content')
    })

    it('Probe component subscribed to blocksById re-renders on every mutation', async () => {
      let renderCount = 0

      function Probe(): ReactElement {
        const map = usePageBlockStore((s) => s.blocksById)
        const renderedRef = useRef(0)
        // oxlint-disable-next-line react/refs -- render-count probe: this test asserts the exact number of re-renders a store subscription causes, so incrementing a ref during render is the mechanism under test (#4409)
        renderedRef.current++
        // oxlint-disable-next-line react/globals, react/refs -- publishes the render count to an outer variable so the assertion after render can read it (react/globals); reading the same probe ref a second time to do so is part of the same test-only instrumentation as line above, not production render logic (react/refs) (#4409)
        renderCount = renderedRef.current
        return createElement('span', { 'data-testid': 'probe' }, `size=${map.size}`)
      }

      const { getByTestId } = render(
        createElement(PageBlockContext.Provider, { value: store }, createElement(Probe)),
      )

      const initialRenders = renderCount
      expect(getByTestId('probe').textContent).toBe('size=0')

      // Mutation 1: setState with new blocks → derives new Map → re-render.
      act(() => {
        store.setState({ blocks: [makeBlock({ id: 'A' })] })
      })
      expect(renderCount).toBeGreaterThan(initialRenders)
      expect(getByTestId('probe').textContent).toBe('size=1')

      // Mutation 2: edit() → new Map → re-render.
      const beforeEdit = renderCount
      stubInvoke({ edit_block: echoEditBlock })
      await act(async () => {
        await store.getState().edit('A', 'new content')
      })
      expect(renderCount).toBeGreaterThan(beforeEdit)

      // Non-blocks mutation should NOT re-render.
      const beforeIdle = renderCount
      act(() => {
        store.setState({ loading: false })
      })
      expect(renderCount).toBe(beforeIdle)
    })
  })
  describe('storeOwnsBlock (#713)', () => {
    it('returns true when the block id is in the store', () => {
      store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
      expect(storeOwnsBlock(store, 'OWNED')).toBe(true)
    })

    it('returns false when the block is not in the store', () => {
      store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
      expect(storeOwnsBlock(store, 'FOREIGN')).toBe(false)
    })

    it('returns false when the block id is null', () => {
      store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
      expect(storeOwnsBlock(store, null)).toBe(false)
    })
  })
})
