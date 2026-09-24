// #5140 Phase 3a — `duplicateBlock` is one `duplicate_block` command and one
// undo entry. The success path runs against the REAL tauri-mock dispatch and
// reads the copy back through `load()`; the undo half reads the REAL undo
// store's stack.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import type { OpRef } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks as mockBlocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

let store: StoreApi<PageBlockState>

describe('page-blocks duplicateBlock (#5140 Phase 3a)', () => {
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

  it('lands the copy and its child right after the original and records ONE undo entry of exactly the returned refs', async () => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    let returnedRefs: OpRef[] = []
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const resp = dispatch(cmd, args)
      if (cmd === 'duplicate_block') returnedRefs = (resp as { op_refs: OpRef[] }).op_refs
      return resp
    })
    const { BLOCK_GS_1, BLOCK_GS_2, PAGE_GETTING_STARTED } = SEED_IDS
    const child = dispatch('create_block', {
      blockType: 'content',
      content: 'nested under GS_1',
      parentId: BLOCK_GS_1,
      index: null,
      scope: { kind: 'global' },
      blockId: null,
    }) as { id: string }
    dispatch('set_todo_state', { blockId: BLOCK_GS_1, state: 'TODO' })
    const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
    await pageStore.getState().load()
    const before = pageStore.getState().blocks.length

    await pageStore.getState().duplicateBlock(BLOCK_GS_1)

    const { blocks } = pageStore.getState()
    expect(blocks).toHaveLength(before + 2)
    const [original, originalChild, copy, copyChild, next] = blocks
    expect([original?.id, originalChild?.id, next?.id]).toEqual([BLOCK_GS_1, child.id, BLOCK_GS_2])
    expect(copy?.content).toBe(mockBlocks.get(BLOCK_GS_1)?.['content'])
    expect(copy?.todo_state).toBe('TODO')
    expect(copyChild?.parent_id).toBe(copy?.id)
    expect(copyChild?.content).toBe('nested under GS_1')

    // Root create, its todo_state, the child's create.
    expect(returnedRefs).toHaveLength(3)
    const page = useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)
    expect(page?.undoStack).toHaveLength(1)
    expect(page?.undoStack[0]?.refs).toEqual(returnedRefs)
  })

  it('a rejected duplicate toasts, logs, and adds no undo entry', async () => {
    const original = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1 })
    store.setState({ blocks: [original] })
    const errorSpy = vi.spyOn(logger, 'error')
    const failure = new Error('backend refused the duplicate')
    stubInvoke(mockedInvoke, {
      duplicate_block: () => Promise.reject(failure),
    })

    await store.getState().duplicateBlock('A')

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.duplicateFailed'))
    expect(errorSpy).toHaveBeenCalledWith(
      'page-blocks',
      'Failed to duplicate block',
      { blockId: 'A' },
      failure,
    )
    expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['A'])
  })

  it('an id this page does not hold makes no IPC', async () => {
    store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })

    await store.getState().duplicateBlock('NOT_ON_THIS_PAGE')

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
  })
})
