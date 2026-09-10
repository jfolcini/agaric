/**
 * Tests for useBlockAutoCreateFirstBlock (H-9 / #752).
 *
 * Validates:
 * - Happy path: creates the first block, writes it to the store (including
 *   the derived blocksById map) and focuses it
 * - #752 clobber guard: a block that appeared while the create IPC was in
 *   flight is never replaced by the wholesale setState
 * - Page-identity guard: result is discarded after a page switch
 * - Error path: failure toast
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow, withOps } from '@/__tests__/fixtures'
import { type CommandReturns, deferred, stubInvoke } from '@/__tests__/helpers/invoke'
import { useBlockAutoCreateFirstBlock } from '@/components/block-tree/use-block-auto-create-first-block'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

/**
 * What `create_block` answers: `WithOps<BlockRow>`, not the bare row. The
 * store keeps whatever came back, so `op_refs` rides along into the block the
 * assertions below compare against.
 */
function created(id: string): CommandReturns['create_block'] {
  return withOps(makeBlockRow({ id, content: '', parent_id: 'PAGE_1', position: 0 }))
}

function makeParams(
  overrides?: Partial<Parameters<typeof useBlockAutoCreateFirstBlock>[0]>,
): Parameters<typeof useBlockAutoCreateFirstBlock>[0] {
  return {
    enabled: true,
    loading: false,
    blocksLength: 0,
    rootParentId: 'PAGE_1',
    pageStore,
    t: vi.fn((key: string) => key) as unknown as TFunction,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [], loading: false })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
})

describe('useBlockAutoCreateFirstBlock', () => {
  it('creates the first block, stores it (blocks + blocksById) and focuses it', async () => {
    const newBlock = created('NEW_1')
    stubInvoke(mockedInvoke, { create_block: () => newBlock })

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))

    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(1)
    })
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'PAGE_1',
      index: null,
      scope: { kind: 'global' },
      // #2849 PR2 — auto-create supplies no client id (null).
      blockId: null,
    })
    expect(pageStore.getState().blocks[0]).toEqual({ ...newBlock, depth: 0 })
    // #752 — the wrapped store setState derives blocksById for `{ blocks }`
    // partials, so the O(1) lookup map must contain the new block too.
    expect(pageStore.getState().blocksById.get('NEW_1')).toEqual({ ...newBlock, depth: 0 })
    expect(useBlockStore.getState().focusedBlockId).toBe('NEW_1')
  })

  it('clears selection fields when focusing the new block (#2465 mutual-exclusivity invariant)', async () => {
    stubInvoke(mockedInvoke, { create_block: () => created('NEW_1') })

    // Set up stale selection state (e.g., cross-page block selection from a previous page)
    useBlockStore.setState({
      selectedBlockIds: ['STALE_1', 'STALE_2'],
      selectionAnchorId: 'STALE_1',
      selectionFocusId: 'STALE_2',
    })

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))

    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(1)
    })

    // After focusing the new block, the stale selection fields must be cleared
    // to maintain the #2465 invariant: focus and selection are mutually exclusive
    expect(useBlockStore.getState().focusedBlockId).toBe('NEW_1')
    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    expect(useBlockStore.getState().selectionAnchorId).toBeNull()
    expect(useBlockStore.getState().selectionFocusId).toBeNull()
  })

  it('does not clobber a block that appeared while the create IPC was in flight (#752)', async () => {
    const create = deferred<CommandReturns['create_block']>()
    stubInvoke(mockedInvoke, { create_block: () => create.promise })

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', expect.anything())
    })

    // A user-created block lands in the store before the IPC settles.
    const userBlock = makeBlock({ id: 'USER_1', content: 'typed fast', parent_id: 'PAGE_1' })
    pageStore.setState({ blocks: [userBlock] })

    await act(async () => {
      create.resolve(created('NEW_1'))
      await Promise.resolve()
    })

    // Pre-#752 this was replaced wholesale by `[NEW_1]`.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['USER_1'])
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('discards the result when the page changed while the IPC was in flight', async () => {
    const create = deferred<CommandReturns['create_block']>()
    stubInvoke(mockedInvoke, { create_block: () => create.promise })

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', expect.anything())
    })

    pageStore.setState({ rootParentId: 'PAGE_2' })

    await act(async () => {
      create.resolve(created('NEW_1'))
      await Promise.resolve()
    })

    expect(pageStore.getState().blocks).toHaveLength(0)
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('shows a failure toast when create_block rejects', async () => {
    stubInvoke(mockedInvoke, {
      create_block: () => {
        throw new Error('DB error')
      },
    })

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.createFirstBlockFailed')
    })
    expect(pageStore.getState().blocks).toHaveLength(0)
  })

  it('resets the idempotency ref on failure so a re-render retries (#1566 recovery)', async () => {
    // First create rejects; the second (on the next render) succeeds — the
    // attempt order IS the subject here, so the handler counts its calls.
    const newBlock = created('NEW_1')
    let attempts = 0
    stubInvoke(mockedInvoke, {
      create_block: () => {
        attempts += 1
        if (attempts === 1) throw new Error('DB error')
        return newBlock
      },
    })

    const { rerender } = renderHook((props) => useBlockAutoCreateFirstBlock(props), {
      initialProps: makeParams(),
    })

    // The first attempt fails and surfaces the toast.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.createFirstBlockFailed')
    })
    expect(pageStore.getState().blocks).toHaveLength(0)

    // A subsequent render re-fires the effect (the ref was reset on failure),
    // and the retry succeeds — the user is no longer stranded on a blank page.
    rerender(makeParams())

    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(1)
    })
    const createCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')
    expect(createCalls).toHaveLength(2)
    expect(pageStore.getState().blocks[0]).toEqual({ ...newBlock, depth: 0 })
    expect(useBlockStore.getState().focusedBlockId).toBe('NEW_1')
  })

  it('does not re-create on success (idempotency preserved across re-renders)', async () => {
    stubInvoke(mockedInvoke, { create_block: () => created('NEW_1') })

    const { rerender } = renderHook((props) => useBlockAutoCreateFirstBlock(props), {
      initialProps: makeParams(),
    })
    await waitFor(() => {
      expect(pageStore.getState().blocks).toHaveLength(1)
    })

    // A re-render with the same page must not create a second block; the ref
    // stays set on success.
    rerender(makeParams())
    await Promise.resolve()
    const createCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'create_block')
    expect(createCalls).toHaveLength(1)
  })
})
