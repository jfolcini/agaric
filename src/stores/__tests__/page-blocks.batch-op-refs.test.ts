// #5140 — the two batch block commands carry `op_refs` like every other
// mutating command, and the store seeds the REAL undo store with them. The
// sibling suites mock `@/stores/undo`, so this one reads the stack back.
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('#5140 batch commands seed the undo stack with their op_refs', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
    useUndoStore.setState({ pages: new Map() })
    vi.clearAllMocks()
    mockedInvoke.mockImplementation(strictInvokeFallback)
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

  it('pasteBlocks: ONE undo entry carries the refs of every depth level, in append order', async () => {
    const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
    store.setState({ blocks: [anchor] })
    let seq = 0
    let created = 0
    stubInvoke(mockedInvoke, {
      create_blocks_batch: (args) => {
        const specs = ((args as { specs?: unknown }).specs ?? []) as Array<{
          content: string
          parentId: string | null
        }>
        return {
          op_refs: specs.map(() => ({ device_id: 'dev1', seq: ++seq })),
          blocks: specs.map((s) =>
            makeBlockRow({
              id: `NEW${created++}`,
              content: s.content,
              parent_id: s.parentId,
              position: null,
            }),
          ),
        }
      },
      load_page_subtree: () => subtreeResp([anchor]),
    })

    // Two depth levels → two batches: `parent` + `two` at level 0, `child` at level 1.
    await store.getState().pasteBlocks('A', 'parent\n  child\ntwo')

    const page = useUndoStore.getState().pages.get('PAGE_1')
    expect(page?.undoStack).toHaveLength(1)
    expect(page?.undoStack[0]?.refs).toEqual([
      { device_id: 'dev1', seq: 1 },
      { device_id: 'dev1', seq: 2 },
      { device_id: 'dev1', seq: 3 },
    ])
  })
})
