// #5140 — the batch move command carries `op_refs` like every other mutating
// command, and the store seeds the REAL undo store with them. The sibling
// suites mock `@/stores/undo`, so this one reads the stack back.
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow } from '@/__tests__/fixtures'
import { type CommandReturns, strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import type { BlockRow, OpRef } from '@/lib/bindings'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

function subtreeResp(blocks: BlockRow[]): CommandReturns['load_page_subtree'] {
  return { blocks, truncated: false, total: blocks.length }
}

let store: StoreApi<PageBlockState>

describe('#5140 the batch move seeds the undo stack with its op_refs', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    mockedInvoke.mockImplementation(strictInvokeFallback)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moveBlocks: the undo entry carries the move_blocks_batch response op_refs', async () => {
    const refs: OpRef[] = [
      { device_id: 'dev1', seq: 7 },
      { device_id: 'dev1', seq: 8 },
    ]
    store.setState({
      blocks: [
        makeBlock({ id: 'A', position: 0, parent_id: null }),
        makeBlock({ id: 'B', position: 1, parent_id: null }),
        makeBlock({ id: 'C', position: 2, parent_id: null }),
      ],
    })
    stubInvoke(mockedInvoke, {
      move_blocks_batch: () => ({
        op_refs: refs,
        moves: [
          { block_id: 'A', new_parent_id: 'C', new_position: 1 },
          { block_id: 'B', new_parent_id: 'C', new_position: 2 },
        ],
      }),
      load_page_subtree: () => subtreeResp([]),
    })

    await store.getState().moveBlocks(['A', 'B'], 'C', 0)

    const page = useUndoStore.getState().pages.get('PAGE_1')
    expect(page?.undoStack).toHaveLength(1)
    expect(page?.undoStack[0]?.refs).toEqual(refs)
  })
})

describe('#6608 edits sharing an undo group are one undo entry', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    mockedInvoke.mockImplementation(strictInvokeFallback)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('joins edits of different blocks past the undo window, apart from the typing before', async () => {
    store.setState({
      blocks: ['A', 'B', 'C'].map((id, position) =>
        makeBlock({ id, position, parent_id: 'PAGE_1', content: 'old' }),
      ),
    })
    let seq = 0
    stubInvoke(mockedInvoke, {
      edit_block: (args) => ({
        ...makeBlockRow({ id: String(args['blockId']), content: String(args['toText']) }),
        op_refs: [{ device_id: 'dev1', seq: ++seq }],
      }),
    })
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000)
    await store.getState().edit('A', 'typed')
    now.mockReturnValue(1_010)
    await store.getState().edit('B', 'new', { merge: false, undoGroup: 'replace' })
    now.mockReturnValue(60_000)
    await store.getState().edit('C', 'new', { undoGroup: 'replace' })

    const stack = useUndoStore.getState().pages.get('PAGE_1')?.undoStack
    expect(stack?.map((entry) => entry.refs?.map((ref) => ref.seq))).toEqual([[2, 3], [1]])
  })
})
