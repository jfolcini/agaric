// Split from the page-blocks.test.ts monolith (#2929). Concern: block
// splitting and indent/dedent structural edits.
import { invoke } from '@tauri-apps/api/core'
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
function subtreeResp(blocks: BlockRow[]): CommandReturns['load_page_subtree'] {
  return { blocks, truncated: false, total: blocks.length }
}

/**
 * Install this test's command-keyed `invoke` handlers. Anything the store
 * fires that is not listed hits `strictInvokeFallback` and fails by name —
 * the hole #3225 found in this very file's split-rollback test, where an
 * unmodelled compensating write took the positional slot meant for another
 * command and sent the flow down the full-reload branch instead.
 */
function stubInvoke(handlers: TypedInvokeHandlers): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/**
 * The `edit_block` echo the backend really sends: the row it just wrote,
 * `WithOps`-wrapped. Echoing the argument verbatim is the un-normalized case
 * every one of this file's split stubs modelled one `…Once` value at a time.
 */
function echoEditBlock(args: Record<string, unknown>): CommandReturns['edit_block'] {
  return withOps(
    makeBlockRow({ id: args['blockId'] as string, content: args['toText'] as string, position: 0 }),
  )
}

/**
 * The `create_block` echo. #2849 PR2 — the backend takes the client-supplied
 * id verbatim, so echoing the arguments back is exactly what it answers with.
 */
function echoCreateBlock(args: Record<string, unknown>): CommandReturns['create_block'] {
  return withOps(
    makeBlockRow({
      id: args['blockId'] as string,
      block_type: args['blockType'] as string,
      content: args['content'] as string,
      parent_id: args['parentId'] as string | null,
      position: args['index'] as number | null,
    }),
  )
}

/** A `move_block` response: `WithOps<MoveResponse>`, `op_refs` included. */
function moveResp(
  blockId: string,
  newParentId: string | null,
  newPosition: number,
): CommandReturns['move_block'] {
  return withOps({ block_id: blockId, new_parent_id: newParentId, new_position: newPosition })
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

  describe('splitBlock', () => {
    it('does nothing for single-line content', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().splitBlock('A', 'no newlines')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('edits first line and creates new blocks for remaining lines', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // edit('A', 'line1') then createBelow for 'line2' and 'line3'.
      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      await store.getState().splitBlock('A', 'line1\nline2\nline3')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
      expect(blocks[2]?.content).toBe('line3')
    })

    it('handles empty first line in split — filters empty paragraphs', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Empty paragraph filtered → only 'text' remains → single block, just edit
      stubInvoke({ edit_block: echoEditBlock })

      await store.getState().splitBlock('A', '\ntext')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe('text')
    })

    it('chains createBelow sequentially using previous new id', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit, then createBelow('A','b') and createBelow on ITS new id for 'c'.
      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      await store.getState().splitBlock('A', 'a\nb\nc')

      // #2849 PR2 — the two created blocks carry CLIENT ids (`CID_1`, `CID_2`);
      // splitBlock chains on those (the store's actual ids), not server ids.
      expect(mockedInvoke).toHaveBeenCalledTimes(3)
      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'CID_1', 'CID_2'])
    })

    it('splits heading + paragraph into two blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit('A', '# Title') — heading — then createBelow('A', 'Paragraph').
      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      await store.getState().splitBlock('A', '# Title\nParagraph')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('# Title')
      expect(blocks[1]?.content).toBe('Paragraph')
    })

    it('does NOT split single code block (multi-line content is one block)', async () => {
      const codeContent = '```\ncode line 1\ncode line 2\n```'
      const block = makeBlock({ id: 'A', position: 0, content: codeContent })
      store.setState({ blocks: [block] })

      // Single code block → blockCount = 1, serialized matches input → no edit, no split
      await store.getState().splitBlock('A', codeContent)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe(codeContent)
    })

    it('does NOT split single heading (single block)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      await store.getState().splitBlock('A', '## Just a heading')

      // Single heading → blockCount = 1 → no split, no edit needed since content unchanged
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
    })

    it('filters empty paragraphs between content blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // 'hello\n\nworld' → 3 parsed blocks: paragraph("hello"), empty paragraph, paragraph("world")
      // After filtering empty: 2 blocks
      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      await store.getState().splitBlock('A', 'hello\n\nworld')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('hello')
      expect(blocks[1]?.content).toBe('world')
    })

    // #2451 review — splitBlock's resolution gates the blur path's draft
    // discard (useEditorBlur forwards it to discardDraft, which keeps the
    // draft row only when the outcome is exactly `false`). A void/undefined
    // resolution slipped past that gate and deleted the crash-recovery draft
    // even when the first-line write failed — the same content-loss class as
    // the edit path (#2407), on the symmetric split path.
    describe('splitBlock outcome (draft-discard gate)', () => {
      it('resolves false when the first-line edit fails', async () => {
        const block = makeBlock({ id: 'A', position: 0, content: 'original' })
        store.setState({ blocks: [block] })
        // edit('A', 'line1') → invoke('edit_block', ...) — rejects; edit()
        // swallows it and resolves false (the real store contract).
        stubInvoke({ edit_block: () => Promise.reject(new Error('edit failed')) })

        await expect(store.getState().splitBlock('A', 'line1\nline2')).resolves.toBe(false)
      })

      it('resolves false when a createBelow fails mid-split', async () => {
        const block = makeBlock({ id: 'A', position: 0, content: 'original' })
        store.setState({ blocks: [block] })
        // #3225 — keyed on the command, not on call position, because this
        // path issues THREE IPCs, not two: the first-line `edit_block`, the
        // failing `create_block`, and then the COMPENSATING `edit_block`
        // that restores `previousContent` (the rollback the first-iteration
        // branch above performs so the visible block doesn't keep only
        // `plan.first`).
        //
        // The positional `…Once` pair covered only the first two, so the
        // compensating write fell through to the old base implementation.
        // Here that `undefined` did NOT read as a success: `edit()` returned
        // falsy, which sent the reducer down its
        // `if (!(await get().edit(blockId, previousContent))) await get().load()`
        // reconcile branch (page-blocks-reducers.ts) and issued a FOURTH,
        // equally unstubbed IPC — `load_page_subtree`. So the test passed
        // while exercising the full-reload recovery path instead of the
        // compensating write that production actually takes. Modelling both
        // commands puts it back on the production path; the assertions below
        // pin that distinction.
        stubInvoke({
          edit_block: echoEditBlock,
          create_block: () => Promise.reject(new Error('create failed')),
        })

        await expect(store.getState().splitBlock('A', 'line1\nline2')).resolves.toBe(false)
        // The compensating edit ran and restored the pre-split content, so
        // the store never had to fall back to a full `load()`.
        const editCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'edit_block')
        expect(editCalls).toHaveLength(2)
        expect(editCalls[1]?.[1]).toMatchObject({ toText: 'original' })
        expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'load_page_subtree')).toBe(false)
      })

      it('resolves false when the edit-only plan save fails', async () => {
        const block = makeBlock({ id: 'A', position: 0, content: 'hello' })
        store.setState({ blocks: [block] })
        // 'hello\n' parses to a single paragraph whose serialization ('hello')
        // differs from the input → plan.kind === 'edit-only'.
        stubInvoke({ edit_block: () => Promise.reject(new Error('edit failed')) })

        await expect(store.getState().splitBlock('A', 'hello\n')).resolves.toBe(false)
      })

      it('resolves true on a fully successful split', async () => {
        const block = makeBlock({ id: 'A', position: 0, content: 'original' })
        store.setState({ blocks: [block] })
        stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

        await expect(store.getState().splitBlock('A', 'line1\nline2')).resolves.toBe(true)
      })

      it('resolves true for a noop plan (nothing needed persisting)', async () => {
        const block = makeBlock({ id: 'A', position: 0, content: 'no newlines' })
        store.setState({ blocks: [block] })

        await expect(store.getState().splitBlock('A', 'no newlines')).resolves.toBe(true)
        expect(mockedInvoke).not.toHaveBeenCalled()
      })
    })

    // #2913 — when the FIRST createBelow fails AFTER the first-line
    // `edit(blockId, plan.first)` already committed the truncated `plan.first`
    // DURABLY to the backend, the rollback must re-converge the BACKEND too, not
    // just the store. The pre-fix code did a local-only `set()` restore, so the
    // store showed `previousContent` while the DB held `plan.first` — the next
    // load() (sync tick / navigation / blocks:changed) silently truncated the
    // block. The fix issues a COMPENSATING `edit(blockId, previousContent)`.
    it('#2913 — compensates the backend (edit) on first-createBelow failure, not a local-only restore', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      const previousContent = store.getState().blocks[0]?.content

      // Both `edit_block` writes succeed — the first-line commit and the
      // COMPENSATING one that re-converges store AND backend on the pre-split
      // content — while `create_block` rejects.
      stubInvoke({
        edit_block: echoEditBlock,
        create_block: () => Promise.reject(new Error('create failed')),
      })

      await store.getState().splitBlock('A', 'line1\nline2')

      // Non-tautology: a compensating BACKEND write must have been issued with the
      // full pre-split content. The pre-fix local-only `set()` restore issued NO
      // such edit_block call — this assertion fails against the old code.
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'A',
        toText: 'original',
      })
      // And the store re-converges on the restored content.
      expect(store.getState().blocks[0]?.content).toBe(previousContent)
    })

    // #2913 — if the COMPENSATING edit ALSO fails, fall back to an exact restore
    // from the backend via load() (mirroring remove()'s failure fallback), so the
    // store never lingers on content the backend does not hold.
    it('#2913 — falls back to load() when the compensating edit also fails', async () => {
      const block = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      // The first-line edit succeeds; createBelow rejects; the COMPENSATING
      // edit then rejects too. Both edits are the same command, so the order
      // is explicit state here.
      let editCall = 0
      stubInvoke({
        edit_block: (args) =>
          editCall++ === 0
            ? echoEditBlock(args)
            : Promise.reject(new Error('compensating edit failed')),
        create_block: () => Promise.reject(new Error('create failed')),
        // load() reconciles from the backend, which still holds the pre-split text.
        load_page_subtree: () =>
          subtreeResp([
            makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0, content: 'original' }),
          ]),
      })

      await store.getState().splitBlock('A', 'line1\nline2')

      // Non-tautology: load() must have been invoked as the reconciling fallback —
      // the pre-fix code never called load() on this path.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      // The exact backend restore lands in the store.
      expect(store.getState().blocks[0]?.content).toBe('original')
    })

    // #976 finding 7 — the `splitInProgress` re-entrancy guard is cleared in a
    // `finally` block, so a `createBelow` failure must NOT leave the block
    // permanently wedged. The existing happy-path "clears guard after
    // completion" test and the rollback test above cover their cases, but
    // neither asserts the guard is freed on the ERROR path. This complements
    // them: after a failed createBelow, a SECOND splitBlock on the same block
    // must execute (the guard was cleared) rather than early-return as a no-op.
    it('clears the re-entrancy guard even when createBelow fails — next splitBlock executes', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      // First split: edit('A','line1') succeeds, createBelow('A','line2')
      // rejects. #2913 — that failure issues a compensating edit('A','original')
      // to re-converge the backend, which succeeds. The SECOND split's create
      // must succeed, so `create_block` fails only on its first call.
      let createCall = 0
      stubInvoke({
        edit_block: echoEditBlock,
        create_block: (args) =>
          createCall++ === 0 ? Promise.reject(new Error('create failed')) : echoCreateBlock(args),
      })

      await store.getState().splitBlock('A', 'line1\nline2')
      // edit + failed create + compensating edit = 3 IPCs.
      expect(mockedInvoke).toHaveBeenCalledTimes(3)

      // Second split on the SAME block must run — if the guard were still set,
      // splitBlock would early-return and issue zero further IPCs.
      await store.getState().splitBlock('A', 'x\ny')

      // Two more IPCs (edit + create) fired → the guard was cleared on the error
      // path. 3 (first split incl. compensating edit) + 2 = 5.
      expect(mockedInvoke).toHaveBeenCalledTimes(5)
      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.content)).toEqual(['x', 'y'])
    })

    it('rejects a second concurrent splitBlock on the same block (re-entrancy guard)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Mocks for the first (and only) splitBlock that executes: edit_block
      // for 'line1' then create_block for 'line2'.
      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      // Fire two splitBlocks simultaneously on the same block
      await Promise.all([
        store.getState().splitBlock('A', 'line1\nline2'),
        store.getState().splitBlock('A', 'line1\nline2'),
      ])

      // Only the first splitBlock should have made backend calls (edit + create = 2)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
    })

    it('clears re-entrancy guard after completion — next splitBlock works', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      stubInvoke({ edit_block: echoEditBlock, create_block: echoCreateBlock })

      // First splitBlock on block A
      await store.getState().splitBlock('A', 'line1\nline2')
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      // Second splitBlock on same block A — should work (guard cleared)
      await store.getState().splitBlock('A', 'x\ny')
      expect(mockedInvoke).toHaveBeenCalledTimes(4)
    })

    it('#730 — aborts (no duplicate creates) when the FIRST edit fails', async () => {
      // Pasting multi-line content: if the first-line edit() fails, the old
      // code STILL created every plan.rest line below the reverted original —
      // duplicating the pasted content. The fix branches on edit()'s boolean.
      const block = makeBlock({ id: 'A', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      // edit('A', 'line1') → editBlock IPC rejects (edit() resolves false and
      // rolls its optimistic update back internally).
      stubInvoke({ edit_block: () => Promise.reject(new Error('edit failed')) })

      await store.getState().splitBlock('A', 'line1\nline2\nline3')

      // Only the failed edit_block IPC fired — NO create_block for line2/line3.
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      const blocks = store.getState().blocks
      // No new blocks; original is restored by edit()'s rollback (not split).
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe('original')
    })
  })
  describe('pool_busy retry (#730)', () => {
    it('edit retries a transient pool_busy blip and commits without reverting', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })

      // First editBlock attempt rejects with pool_busy; the shared
      // retryOnPoolBusy helper retries and the second attempt succeeds.
      // The ORDER is the subject: attempt 1 is the blip, attempt 2 the retry.
      let attempt = 0
      stubInvoke({
        edit_block: (args) =>
          attempt++ === 0
            ? Promise.reject({ kind: 'pool_busy', message: 'pool exhausted' })
            : echoEditBlock(args),
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(true)
      // Two edit_block IPC attempts (the blip + the retry success).
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      // The optimistic edit survives — not reverted to 'old'.
      expect(store.getState().blocks[0]?.content).toBe('new')
      // No save-failed toast for a recovered blip.
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('moveUp retries a transient pool_busy blip before reporting failure', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // The ORDER is the subject: attempt 1 is the blip, attempt 2 the retry.
      let attempt = 0
      stubInvoke({
        move_block: () =>
          attempt++ === 0
            ? Promise.reject({ kind: 'pool_busy', message: 'pool exhausted' })
            : moveResp('B', null, 0),
      })

      const ok = await store.getState().moveUp('B')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('a non-pool_busy error is NOT retried (re-thrown immediately)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })

      // A generic database error must bubble on the first attempt — the
      // retry helper only retries pool_busy.
      stubInvoke({
        edit_block: () => Promise.reject({ kind: 'database', message: 'boom' }),
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      // Exactly one attempt — no retry for a non-pool_busy error.
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      // Rolled back to the previous content.
      expect(store.getState().blocks[0]?.content).toBe('old')
    })
  })
  describe('indent', () => {
    it('makes a block a child of its previous sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      stubInvoke({ move_block: () => moveResp('B', 'A', 0) })

      await store.getState().indent('B')

      const moved = store.getState().blocks.find((b) => b.id === 'B')
      expect(moved?.parent_id).toBe('A')
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(1)
      // #400: indent appends as last child → slot = prev sibling's child count
      // (0 here, A has no children).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newIndex: 0,
      })
    })

    it('does nothing for the first block (idx === 0)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#928 — does NOT indent when it would push the subtree past MAX_BLOCK_DEPTH', async () => {
      // Parent chain P0..P17 (depths 0..17), two siblings S1 & B at depth 18
      // under P17, and B has a child BC at depth 19. Indenting B under S1 would
      // put B at depth 19 and BC at depth 20 (> MAX_BLOCK_DEPTH-1=19) — reject
      // up front (no move_block IPC) instead of letting the backend bounce it.
      const chain = Array.from({ length: 18 }, (_, d) =>
        makeBlock({ id: `P${d}`, parent_id: d === 0 ? null : `P${d - 1}`, position: 0, depth: d }),
      )
      const s1 = makeBlock({ id: 'S1', parent_id: 'P17', position: 0, depth: 18 })
      const b = makeBlock({ id: 'B', parent_id: 'P17', position: 1, depth: 18 })
      const bc = makeBlock({ id: 'BC', parent_id: 'B', position: 0, depth: 19 })
      store.setState({ blocks: [...chain, s1, b, bc] })

      const ok = await store.getState().indent('B')

      expect(ok).toBe(false)
      expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
    })

    it('#976 f21 — surfaces a visual toast when an indent is rejected at max depth', async () => {
      // Same shape as the #928 case: indenting B under S1 would exceed the
      // depth ceiling. Sighted users previously got a silent no-op; the store
      // now emits a toast so visual + AT feedback reach parity.
      const chain = Array.from({ length: 18 }, (_, d) =>
        makeBlock({ id: `P${d}`, parent_id: d === 0 ? null : `P${d - 1}`, position: 0, depth: d }),
      )
      const s1 = makeBlock({ id: 'S1', parent_id: 'P17', position: 0, depth: 18 })
      const b = makeBlock({ id: 'B', parent_id: 'P17', position: 1, depth: 18 })
      const bc = makeBlock({ id: 'BC', parent_id: 'B', position: 0, depth: 19 })
      store.setState({ blocks: [...chain, s1, b, bc] })

      const ok = await store.getState().indent('B')

      expect(ok).toBe(false)
      expect(toast.error).toHaveBeenCalledWith('Max nesting level reached', {
        id: 'max-nesting-reached',
      })
    })

    it('#976 f21 — does NOT toast for the harmless "already outermost" no-op', async () => {
      // No previous sibling → indent is a benign no-op; it must stay silent
      // (the max-depth toast is only for the depth-ceiling rejection).
      const blockA = makeBlock({ id: 'A', parent_id: 'P', position: 0, depth: 1 })
      store.setState({ blocks: [makeBlock({ id: 'P', depth: 0 }), blockA] })

      await store.getState().indent('A')

      expect(toast.error).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when previous block has a different parent', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'P1', depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: 'P2', depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().indent('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      stubInvoke({ move_block: () => Promise.reject(new Error('move failed')) })

      await store.getState().indent('B')

      expect(store.getState().blocks.find((b) => b.id === 'B')?.parent_id).toBeNull()
    })

    it('places indented block after prevSibling existing children (while-loop)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const childA1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
      const childA2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, childA1, childA2, blockB] })

      stubInvoke({ move_block: () => moveResp('B', 'A', 0) })

      await store.getState().indent('B')

      const blocks = store.getState().blocks
      const bIdx = blocks.findIndex((b) => b.id === 'B')
      expect(bIdx).toBeGreaterThan(blocks.findIndex((b) => b.id === 'A2'))
      expect(blocks[bIdx]?.parent_id).toBe('A')
      expect(blocks[bIdx]?.depth).toBe(1)
    })

    it('#774 — reloads when the backend echoes a parent other than the requested prevSibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // indent('B') requests parent 'A', but the backend echoes a DIFFERENT
      // parent ('UNEXPECTED'). Old indent ignored the echo entirely and
      // trusted the requested parent → silent FE/BE divergence. The fix
      // mirrors reorder/moveUp: fall back to a structural reload.
      stubInvoke({
        move_block: () => moveResp('B', 'UNEXPECTED', 0),
        // The reload load_page_subtree returns the authoritative tree.
        load_page_subtree: () =>
          subtreeResp([
            makeBlock({ id: 'A', parent_id: 'PAGE_1', depth: 0 }),
            makeBlock({ id: 'B', parent_id: 'UNEXPECTED', depth: 0 }),
          ]),
      })

      const ok = await store.getState().indent('B')

      expect(ok).toBe(true)
      // A second IPC (the reload) fired — the local "indent under A" splice
      // was NOT trusted.
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenLastCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })

    it('#774 — serialized double moveDown lands two slots down (queued moves do not collapse)', async () => {
      // A → B → C → D at root. Two rapid moveDown('A') presses fired before
      // the first resolves must move A two slots (past B, then past C), not
      // collapse into a single move. Serialization makes the 2nd press read
      // the post-first-move state and request the correct next slot.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
          makeBlock({ id: 'D', position: 3, parent_id: null, depth: 0 }),
        ],
      })

      // The ORDER is the subject: the first moveDown swaps A past B → slot 1,
      // the second (computed AFTER the first commits) past C → slot 2.
      let move = 0
      stubInvoke({ move_block: () => moveResp('A', null, move++ === 0 ? 1 : 2) })

      // Fire both without awaiting the first — the queue serializes them.
      const p1 = store.getState().moveDown('A')
      const p2 = store.getState().moveDown('A')
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      // Two distinct backend moves — the second did NOT re-state the first's slot.
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 1,
      })
      expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 2,
      })
      // Final order: B, C, A, D.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'C', 'A', 'D'])
    })

    // #2200 — indent's splice (`computeIndentedBlocks`) now builds one
    // id→index map over `remaining` and reuses it for both the
    // prevSibling-descendants skip-loop and the insertion anchor, instead of
    // scanning `remaining` twice for the same id (#2041/#2200, mirrors the
    // dedent/moveDown conversion). Pin the behavior AND the identity contract:
    // prevSibling already has a child of its own (exercises the skip-loop),
    // and a trailing unrelated block must keep its exact reference.
    it("#2200 — appends past the prev sibling's existing subtree and preserves unrelated block identity", async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockA1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockA1, blockB, blockC] })

      stubInvoke({ move_block: () => moveResp('B', 'A', 2) })

      await store.getState().indent('B')

      const { blocks } = store.getState()
      // B lands AFTER A's existing child A1 (append-as-last-child), and C
      // (unrelated, after the indented subtree) stays put.
      expect(blocks.map((b) => b.id)).toEqual(['A', 'A1', 'B', 'C'])
      // A and A1 (untouched) keep their exact prior references.
      expect(blocks[0]).toBe(blockA)
      expect(blocks[1]).toBe(blockA1)
      expect(blocks[3]).toBe(blockC)
      // B itself gets a new reference (depth/parent_id/position rewritten).
      expect(blocks[2]).not.toBe(blockB)
      expect(blocks[2]?.parent_id).toBe('A')
      expect(blocks[2]?.depth).toBe(1)
    })
  })
  describe('dedent', () => {
    it('moves a block up to its grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, position: 0, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 1 })
      store.setState({ blocks: [parent, child] })

      stubInvoke({ move_block: () => moveResp('C', null, 1) })

      await store.getState().dedent('C')

      const moved = store.getState().blocks.find((b) => b.id === 'C')
      expect(moved?.parent_id).toBeNull()
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(0)
      // #400: dedent slot = parent's sibling slot (0) + 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: null,
        newIndex: 1,
      })
    })

    it('does nothing if block is at root level', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', parent_id: null })],
      })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [] })

      await store.getState().dedent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when parent is not in the blocks array', async () => {
      const orphan = makeBlock({ id: 'A', parent_id: 'MISSING_PARENT' })
      store.setState({ blocks: [orphan] })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child] })

      stubInvoke({ move_block: () => Promise.reject(new Error('move failed')) })

      await store.getState().dedent('C')

      expect(store.getState().blocks.find((b) => b.id === 'C')?.parent_id).toBe('P')
    })

    it('positions after parent when moving to grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 5, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      store.setState({ blocks: [parent, child] })

      stubInvoke({ move_block: () => moveResp('C', 'GP', 2) })

      await store.getState().dedent('C')

      // #400: P is the only known child of GP → slot 0 → dedent slot 0 + 1 = 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: 'GP',
        newIndex: 1,
      })
    })

    it('places dedented block after parent subtree with other descendants (while-loop)', async () => {
      const grandparent = makeBlock({ id: 'GP', parent_id: null, position: 0, depth: 0 })
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 0, depth: 1 })
      const sibling = makeBlock({ id: 'S', parent_id: 'P', position: 0, depth: 2 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 1, depth: 2 })
      const otherRoot = makeBlock({ id: 'R', parent_id: null, position: 1, depth: 0 })
      store.setState({ blocks: [grandparent, parent, sibling, child, otherRoot] })

      stubInvoke({ move_block: () => moveResp('C', 'GP', 1) })

      await store.getState().dedent('C')

      const blocks = store.getState().blocks
      const cIdx = blocks.findIndex((b) => b.id === 'C')
      const sIdx = blocks.findIndex((b) => b.id === 'S')
      const pIdx = blocks.findIndex((b) => b.id === 'P')
      expect(cIdx).toBeGreaterThan(sIdx)
      expect(cIdx).toBeGreaterThan(pIdx)
      expect(blocks[cIdx]?.depth).toBe(1)
      expect(blocks[cIdx]?.parent_id).toBe('GP')
    })

    it('#774 — reloads when the backend echoes a parent other than the requested grandparent', async () => {
      // C under P under GP. dedent('C') requests grandparent GP, but the
      // backend echoes a DIFFERENT parent. Old dedent checked the slot but
      // never the parent echo against the REQUESTED parent — trusting the
      // local "place after parent" splice. The fix reloads on disagreement.
      const grandparent = makeBlock({ id: 'GP', parent_id: null, position: 0, depth: 0 })
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 0, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      store.setState({ blocks: [grandparent, parent, child] })

      stubInvoke({
        move_block: () => moveResp('C', 'UNEXPECTED', 0),
        load_page_subtree: () =>
          subtreeResp([
            makeBlock({ id: 'GP', parent_id: 'PAGE_1', depth: 0 }),
            makeBlock({ id: 'P', parent_id: 'GP', depth: 1 }),
            makeBlock({ id: 'C', parent_id: 'UNEXPECTED', depth: 1 }),
          ]),
      })

      const ok = await store.getState().dedent('C')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenLastCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })
})
