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

import { makeBlock } from '../../../__tests__/fixtures'
import { useBlockStore } from '../../../stores/blocks'
import { createPageBlockStore, type PageBlockState } from '../../../stores/page-blocks'
import { useBlockAutoCreateFirstBlock } from '../use-block-auto-create-first-block'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

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
    const newBlock = makeBlock({ id: 'NEW_1', content: '', parent_id: 'PAGE_1' })
    mockedInvoke.mockResolvedValue(newBlock)

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
    })
    expect(pageStore.getState().blocks[0]).toEqual({ ...newBlock, depth: 0 })
    // #752 — the wrapped store setState derives blocksById for `{ blocks }`
    // partials, so the O(1) lookup map must contain the new block too.
    expect(pageStore.getState().blocksById.get('NEW_1')).toEqual({ ...newBlock, depth: 0 })
    expect(useBlockStore.getState().focusedBlockId).toBe('NEW_1')
  })

  it('does not clobber a block that appeared while the create IPC was in flight (#752)', async () => {
    const newBlock = makeBlock({ id: 'NEW_1', content: '', parent_id: 'PAGE_1' })
    let resolveCreate!: (value: unknown) => void
    mockedInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === 'create_block') resolveCreate = resolve
          else resolve(undefined)
        }),
    )

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', expect.anything())
    })

    // A user-created block lands in the store before the IPC settles.
    const userBlock = makeBlock({ id: 'USER_1', content: 'typed fast', parent_id: 'PAGE_1' })
    pageStore.setState({ blocks: [userBlock] })

    await act(async () => {
      resolveCreate(newBlock)
      await Promise.resolve()
    })

    // Pre-#752 this was replaced wholesale by `[NEW_1]`.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(['USER_1'])
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('discards the result when the page changed while the IPC was in flight', async () => {
    const newBlock = makeBlock({ id: 'NEW_1', content: '', parent_id: 'PAGE_1' })
    let resolveCreate!: (value: unknown) => void
    mockedInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === 'create_block') resolveCreate = resolve
          else resolve(undefined)
        }),
    )

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', expect.anything())
    })

    pageStore.setState({ rootParentId: 'PAGE_2' })

    await act(async () => {
      resolveCreate(newBlock)
      await Promise.resolve()
    })

    expect(pageStore.getState().blocks).toHaveLength(0)
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('shows a failure toast when create_block rejects', async () => {
    mockedInvoke.mockRejectedValue(new Error('DB error'))

    renderHook(() => useBlockAutoCreateFirstBlock(makeParams()))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.createFirstBlockFailed')
    })
    expect(pageStore.getState().blocks).toHaveLength(0)
  })
})
