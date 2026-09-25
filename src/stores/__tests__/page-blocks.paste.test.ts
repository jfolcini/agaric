// #5140 Phase 3b — `pasteBlocks` is one `paste_blocks` command and one undo
// entry. The success path runs against the REAL tauri-mock dispatch and reads
// the pasted tree back through `load()`; the undo half reads the REAL undo
// store's stack.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow } from '@/__tests__/fixtures'
import { type CommandReturns, strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import type { BlockRow, OpRef, PasteInput } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { type NameChange, subscribeToNameChanges } from '@/lib/name-change-bus'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const OTHER_SPACE = 'SPACE_OTHER'

function subtreeResp(blocks: BlockRow[]): CommandReturns['load_page_subtree'] {
  return { blocks, truncated: false, total: blocks.length }
}

let store: StoreApi<PageBlockState>

describe('page-blocks pasteBlocks (#5140 Phase 3b)', () => {
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

  it('lands a pasted outline after the anchor in ONE command and records ONE undo entry of exactly the returned refs', async () => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    let returnedRefs: OpRef[] = []
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const resp = dispatch(cmd, args)
      if (cmd === 'paste_blocks') returnedRefs = (resp as { op_refs: OpRef[] }).op_refs
      return resp
    })
    const { BLOCK_GS_1, BLOCK_GS_2, PAGE_GETTING_STARTED } = SEED_IDS
    const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
    await pageStore.getState().load()
    const input: PasteInput = { kind: 'text', text: '- parent\n  - child\n- second' }

    const ids = await pageStore.getState().pasteBlocks(BLOCK_GS_1, input)

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'paste_blocks')).toEqual([
      ['paste_blocks', { anchorBlockId: BLOCK_GS_1, input, splice: null }],
    ])
    expect(ids).toHaveLength(3)
    const [parentId, childId, secondId] = ids as [string, string, string]
    const { blocks, blocksById } = pageStore.getState()
    expect(blocks.map((b) => b.id).slice(0, 5)).toEqual([
      BLOCK_GS_1,
      parentId,
      childId,
      secondId,
      BLOCK_GS_2,
    ])
    expect(blocksById.get(parentId)?.content).toBe('parent')
    expect(blocksById.get(childId)?.content).toBe('child')
    expect(blocksById.get(childId)?.parent_id).toBe(parentId)
    expect(blocksById.get(secondId)?.parent_id).toBe(PAGE_GETTING_STARTED)

    expect(returnedRefs).toHaveLength(3)
    const page = useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)
    expect(page?.undoStack).toHaveLength(1)
    expect(page?.undoStack[0]?.refs).toEqual(returnedRefs)
  })

  it('seeds the resolve cache with the pages and tags the paste created and returns only the pasted content ids', async () => {
    store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
    stubInvoke(mockedInvoke, {
      paste_blocks: () => ({
        op_refs: [{ device_id: 'dev1', seq: 1 }],
        blocks: [
          makeBlockRow({ id: 'NEW_PAGE', block_type: 'page', content: 'Reading list' }),
          makeBlockRow({ id: 'NEW_TAG', block_type: 'tag', content: 'later' }),
          makeBlockRow({ id: 'PASTED', content: 'see [[NEW_PAGE]] #[NEW_TAG]' }),
        ],
      }),
      load_page_subtree: () => subtreeResp([]),
    })

    const ids = await store.getState().pasteBlocks('A', { kind: 'text', text: 'x' })

    expect(ids).toEqual(['PASTED'])
    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor('SPACE_TEST', 'NEW_PAGE'))?.title).toBe('Reading list')
    expect(cache.get(keyFor('SPACE_TEST', 'NEW_TAG'))?.title).toBe('later')
    expect(cache.has(keyFor('SPACE_TEST', 'PASTED'))).toBe(false)
  })

  it('announces each created page and tag in the space the paste was made in, not the one live when it replies', async () => {
    store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
    const events: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => events.push(change))
    stubInvoke(mockedInvoke, {
      paste_blocks: () => {
        // The user switches space while the paste is in flight (#4391).
        useSpaceStore.setState({ currentSpaceId: OTHER_SPACE })
        return {
          op_refs: [{ device_id: 'dev1', seq: 1 }],
          blocks: [
            makeBlockRow({ id: 'NEW_PAGE', block_type: 'page', content: 'Reading list' }),
            makeBlockRow({ id: 'NEW_TAG', block_type: 'tag', content: 'later' }),
            makeBlockRow({ id: 'PASTED', content: 'text' }),
          ],
        }
      },
      load_page_subtree: () => subtreeResp([]),
    })

    try {
      await store.getState().pasteBlocks('A', { kind: 'text', text: 'x' })
    } finally {
      unsubscribe()
    }

    expect(events).toEqual([
      {
        kind: 'added',
        entity: 'page',
        id: 'NEW_PAGE',
        name: 'Reading list',
        spaceId: 'SPACE_TEST',
      },
      { kind: 'added', entity: 'tag', id: 'NEW_TAG', name: 'later', spaceId: 'SPACE_TEST' },
    ])
  })

  it('a rejected paste toasts, logs, adds no undo entry, announces nothing and resolves no ids', async () => {
    store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
    const errorSpy = vi.spyOn(logger, 'error')
    const events: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => events.push(change))
    const failure = new Error('backend refused the paste')
    stubInvoke(mockedInvoke, {
      paste_blocks: () => Promise.reject(failure),
    })

    let ids: string[] = []
    try {
      ids = await store.getState().pasteBlocks('A', { kind: 'text', text: 'x' })
    } finally {
      unsubscribe()
    }

    expect(ids).toEqual([])
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.pasteBlocksFailed'))
    expect(errorSpy).toHaveBeenCalledWith(
      'page-blocks',
      'Failed to paste blocks',
      { anchorBlockId: 'A' },
      failure,
    )
    expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
    expect(events).toEqual([])
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['A'])
  })

  it('an anchor this page does not hold makes no IPC and resolves no ids', async () => {
    store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })

    const ids = await store.getState().pasteBlocks('NOT_ON_THIS_PAGE', { kind: 'text', text: 'x' })

    expect(ids).toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
  })
})
