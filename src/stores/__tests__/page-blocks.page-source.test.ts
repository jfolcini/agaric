// #5140 Phase 4b — `applyPageSource` saves the page edited as its source
// buffer as one `apply_page_source` command and one undo entry. The success
// path runs against the REAL tauri-mock dispatch and reads the page back
// through `load()`; the undo half reads the REAL undo store's stack.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlockRow } from '@/__tests__/fixtures'
import { type CommandReturns, strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import type { OpRef } from '@/lib/bindings'
import { type NameChange, subscribeToNameChanges } from '@/lib/name-change-bus'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

function report(
  overrides: Partial<CommandReturns['apply_page_source']> = {},
): CommandReturns['apply_page_source'] {
  return {
    op_refs: [],
    created: 0,
    edited: 0,
    moved: 0,
    deleted: 0,
    properties_set: 0,
    properties_deleted: 0,
    names_created: [],
    warnings: [],
    ...overrides,
  }
}

const emptySubtree = (): CommandReturns['load_page_subtree'] => ({
  blocks: [],
  truncated: false,
  total: 0,
})

let store: StoreApi<PageBlockState>

describe('page-blocks applyPageSource (#5140 Phase 4b)', () => {
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

  it('saves an edit and a delete in ONE command, reloads the page and records ONE undo entry of exactly the returned refs', async () => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    let returnedRefs: OpRef[] = []
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const resp = dispatch(cmd, args)
      if (cmd === 'apply_page_source') returnedRefs = (resp as { op_refs: OpRef[] }).op_refs
      return resp
    })
    const { BLOCK_GS_1, BLOCK_GS_2, PAGE_GETTING_STARTED } = SEED_IDS
    const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
    await pageStore.getState().load()
    const base = dispatch('get_page_source', { pageId: PAGE_GETTING_STARTED }) as string
    const source = base
      .split('\n')
      .filter((line) => !line.endsWith(`^${BLOCK_GS_2}`))
      .join('\n')
      .replace(`- Welcome to Agaric!`, `- Hello, Agaric!`)

    const result = await pageStore.getState().applyPageSource(source, base, false, false)

    expect(result).toMatchObject({ edited: 1, deleted: 1, created: 0, moved: 0 })
    const { blocks, blocksById } = pageStore.getState()
    expect(blocksById.get(BLOCK_GS_1)?.content).toBe(
      'Hello, Agaric! This is your personal knowledge base.',
    )
    expect(blocksById.has(BLOCK_GS_2)).toBe(false)
    expect(blocks).toHaveLength(4)
    expect(returnedRefs).toHaveLength(2)
    const page = useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)
    expect(page?.undoStack).toHaveLength(1)
    expect(page?.undoStack[0]?.refs).toEqual(returnedRefs)
  })

  it('a save that writes nothing adds no undo entry and keeps the redo stack', async () => {
    const redoRef: OpRef = { device_id: 'dev1', seq: 7 }
    useUndoStore.setState({
      pages: new Map([
        ['PAGE_1', { undoStack: [], undoDepth: 1, redoStack: [redoRef], redoGroupSizes: [1] }],
      ]),
    })
    stubInvoke(mockedInvoke, {
      apply_page_source: () => report(),
      load_page_subtree: emptySubtree,
    })

    await store.getState().applyPageSource('- same ^X\n', '- same ^X\n', false, false)

    const page = useUndoStore.getState().pages.get('PAGE_1')
    expect(page?.undoStack).toEqual([])
    expect(page?.redoStack).toEqual([redoRef])
  })

  it('announces each created page and tag in the space the save was made in, not the one live when it replies', async () => {
    const events: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => events.push(change))
    stubInvoke(mockedInvoke, {
      apply_page_source: () => {
        // The user switches space while the save is in flight (#4391).
        useSpaceStore.setState({ currentSpaceId: 'SPACE_OTHER' })
        return report({
          op_refs: [{ device_id: 'dev1', seq: 1 }],
          names_created: [
            makeBlockRow({ id: 'NEW_PAGE', block_type: 'page', content: 'Reading list' }),
            makeBlockRow({ id: 'NEW_TAG', block_type: 'tag', content: 'later' }),
          ],
        })
      },
      load_page_subtree: emptySubtree,
    })

    try {
      await store.getState().applyPageSource('- see [[Reading list]] #later\n', '', false, false)
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

  it('rethrows a rejection untouched, without a toast, an undo entry or a reload', async () => {
    const stale = { kind: 'validation', code: 'RequiresRefresh', message: 'page changed' }
    stubInvoke(mockedInvoke, {
      apply_page_source: () => Promise.reject(stale),
    })

    await expect(store.getState().applyPageSource('- a\n', '- b\n', true, false)).rejects.toBe(
      stale,
    )

    expect(mockedInvoke.mock.calls).toEqual([
      [
        'apply_page_source',
        { pageId: 'PAGE_1', source: '- a\n', baseSource: '- b\n', force: true, merge: false },
      ],
    ])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
  })
})
