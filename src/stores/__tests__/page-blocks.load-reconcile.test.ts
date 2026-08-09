/**
 * #3321 — `load()` row-identity reconciliation.
 *
 * `buildFlatTree` allocates a fresh object per block (`{ ...child, depth }`),
 * so before this reconcile a `load()` replaced EVERY `FlatBlock` reference
 * even when the backend snapshot was byte-identical to what the store already
 * held. Those objects are the memo key downstream: `BlockListRenderer` passes
 * `block={block}` into the `React.memo`-wrapped `SortableBlockWrapper` and
 * every other prop at that call site is a primitive or deliberately
 * identity-stabilised, so a reload memo-missed every mounted row. `load()` is
 * the remote-write hot path — `reloadChangedPageStores` calls it for each page
 * named in `changed_page_ids` on every `sync:complete` / MCP `blocks:changed`.
 *
 * These tests count PRESERVED OBJECT REFERENCES, which is exactly the quantity
 * `React.memo`'s shallow compare reads.
 */
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import type { BlockRow } from '@/lib/bindings'
import { createPageBlockStore, type FlatBlock, type PageBlockState } from '@/stores/page-blocks'
import { buildBlocksById, reuseUnchangedBlocks } from '@/stores/page-blocks-map'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'
const PAGE_ID = 'PAGE_1'

vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({ onNewAction: vi.fn(), clearPage: vi.fn() }),
  },
}))

vi.mock('@/stores/blocks', () => ({
  useBlockStore: {
    getState: () => ({
      focusedBlockId: null,
      selectedBlockIds: [],
      setFocused: vi.fn(),
      setSelected: vi.fn(),
    }),
    setState: vi.fn(),
  },
}))

/**
 * A backend row as it arrives over IPC: a fresh plain object per response,
 * with NO `depth` field (depth is a frontend annotation added by
 * `buildFlatTree`). Building the rows fresh per load is what makes this an
 * honest simulation — reusing the same fixture objects across two loads would
 * preserve identity for the wrong reason.
 */
function makeRows(count: number, editedIndex?: number, editedContent?: string): BlockRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `B${i}`,
    block_type: 'content',
    content: i === editedIndex ? (editedContent ?? `block ${i}`) : `block ${i}`,
    parent_id: PAGE_ID,
    position: i,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: PAGE_ID,
  }))
}

function subtreeResp(blocks: BlockRow[]): {
  blocks: BlockRow[]
  truncated: boolean
  total: number
} {
  return { blocks, truncated: false, total: blocks.length }
}

/** How many entries of `next` are the very same object as in `prev`. */
function countReusedRefs(prev: FlatBlock[], next: FlatBlock[]): number {
  const byId = new Map(prev.map((b) => [b.id, b]))
  let reused = 0
  for (const b of next) if (byId.get(b.id) === b) reused++
  return reused
}

describe('reuseUnchangedBlocks', () => {
  const row = (over: Partial<FlatBlock> = {}): FlatBlock => ({
    id: 'A',
    block_type: 'content',
    content: 'hello',
    parent_id: PAGE_ID,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: PAGE_ID,
    depth: 0,
    ...over,
  })

  it('hands back the previous object for a field-identical row', () => {
    const prevRow = row()
    const next = [row()]
    const out = reuseUnchangedBlocks(next, buildBlocksById([prevRow]))

    expect(out[0]).toBe(prevRow)
    // The ARRAY is still new, so Zustand subscribers on `blocks` still fire.
    expect(out).not.toBe(next)
  })

  it('keeps the fresh object when any field differs', () => {
    const prevRow = row()
    for (const changed of [
      row({ content: 'edited' }),
      row({ depth: 1 }),
      row({ position: 7 }),
      row({ todo_state: 'done' }),
      row({ deleted_at: 12 }),
    ]) {
      const out = reuseUnchangedBlocks([changed], buildBlocksById([prevRow]))
      expect(out[0]).toBe(changed)
    }
  })

  it('keeps the fresh object when the row is new to this page', () => {
    const fresh = row({ id: 'NEW' })
    const out = reuseUnchangedBlocks([fresh], buildBlocksById([row()]))
    expect(out[0]).toBe(fresh)
  })
})

describe('load() row identity (#3321)', () => {
  let store: StoreApi<PageBlockState>

  beforeEach(() => {
    store = createPageBlockStore(PAGE_ID)
    useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
    vi.clearAllMocks()
  })

  it('reuses every row object across a reload that changed nothing', async () => {
    mockedInvoke.mockResolvedValueOnce(subtreeResp(makeRows(1000)))
    await store.getState().load()
    const first = store.getState().blocks

    mockedInvoke.mockResolvedValueOnce(subtreeResp(makeRows(1000)))
    await store.getState().load()
    const second = store.getState().blocks

    expect(second).toHaveLength(1000)
    expect(countReusedRefs(first, second)).toBe(1000)
    // The array + map references still change so Zustand notifies.
    expect(second).not.toBe(first)
    expect(store.getState().blocksById).not.toBe(buildBlocksById(first))
  })

  it('reallocates ONLY the row a remote peer edited', async () => {
    mockedInvoke.mockResolvedValueOnce(subtreeResp(makeRows(1000)))
    await store.getState().load()
    const first = store.getState().blocks

    // The `sync:complete` tick: a peer edited one block on this page.
    mockedInvoke.mockResolvedValueOnce(subtreeResp(makeRows(1000, 500, 'edited by peer')))
    await store.getState().load()
    const second = store.getState().blocks

    expect(countReusedRefs(first, second)).toBe(999)
    expect(second[500]).not.toBe(first[500])
    expect(second[500]?.content).toBe('edited by peer')
    expect(store.getState().blocksById.get('B500')).toBe(second[500])
  })

  it('reflects structural changes (insert shifts depth/position) as fresh rows', async () => {
    mockedInvoke.mockResolvedValueOnce(subtreeResp(makeRows(3)))
    await store.getState().load()
    const first = store.getState().blocks

    // B1 becomes a child of B0 → its depth changes, so it must NOT be reused.
    const rows = makeRows(3)
    for (const r of rows) if (r.id === 'B1') r.parent_id = 'B0'
    mockedInvoke.mockResolvedValueOnce(subtreeResp(rows))
    await store.getState().load()
    const second = store.getState().blocks

    const b1 = second.find((b) => b.id === 'B1')
    expect(b1?.depth).toBe(1)
    expect(b1).not.toBe(first[1])
    // The untouched sibling is still reused.
    expect(second.find((b) => b.id === 'B0')).toBe(first[0])
  })
})
