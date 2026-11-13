/**
 * #2914 — Enter on multi-block content must NOT race an unawaited `splitBlock`
 * against a parallel `createBelow`.
 *
 * Repro: paste multi-line content into a block, then press Enter with the caret
 * at the end. `handleEnterSave` falls to the LEGACY path, which calls
 * `handleFlush()` (a multi-block flush fires `splitBlock`, which creates the
 * trailing sibling blocks via its own chained `createBelow` calls) and THEN —
 * pre-fix — immediately `createBelow()`d an empty Enter block. The two
 * sibling-creation sequences each computed `siblingSlot` from their own
 * pre-await snapshot, racing on overlapping views (`splitInProgress` guards only
 * re-entrant `splitBlock`, not the concurrent create).
 *
 * The fix publishes the in-flight split (via `consumePendingSplit`) so
 * `handleEnterSave` AWAITS it and focuses the last block it produced, instead of
 * firing a parallel empty-block create. This test wires the REAL `useBlockFlush`
 * producer to the REAL `handleEnterSave` consumer over a REAL page-blocks store
 * (only `invoke` is mocked, and the REAL markdown parser splits on a blank line), so
 * it exercises the actual coordination end-to-end.
 *
 * NOTE: deliberately does NOT mock `@/editor/markdown-serializer` — the real
 * parser must see `alpha\n\nbravo\n\ncharlie` as three blocks so both the flush's
 * `parse()` multi-block detector and the store's `planSplit` take the split path.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { deferred } from '@/__tests__/helpers/invoke'
import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocksHandlers } from '@/lib/tauri-mock/handlers/blocks'
import { blocks as mockBlocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import type { MountedBlocks } from '@/lib/zoom-scope'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const t = ((key: string) => key) as unknown as TFunction

/** Minimal RovingEditorHandle that flushes `content` for `blockId`, caret-at-end. */
function makeHandle(blockId: string, content: string): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => content),
    activeBlockId: blockId,
    getMarkdown: vi.fn(() => content),
    // null → handleEnterSave takes the LEGACY (flush + create) path.
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
  } as unknown as RovingEditorHandle
}

let store: StoreApi<PageBlockState>

beforeEach(() => {
  // #5415 — every space-scoped IPC carries the active space.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  vi.clearAllMocks()
  store = createPageBlockStore('PAGE_1')
  store.setState({
    loading: false,
    blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'alpha', position: 0 })],
  })
  // Backend echoes: edit_block echoes the sent text; create_block accepts the
  // client-minted id verbatim (#2849) and heals `position`.
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>
    if (cmd === 'edit_block') {
      return {
        id: a['blockId'],
        block_type: 'content',
        content: a['toText'],
        parent_id: 'PAGE_1',
        position: 0,
        deleted_at: null,
        op_refs: [],
      }
    }
    if (cmd === 'create_block') {
      return {
        id: a['blockId'],
        block_type: 'content',
        content: a['content'],
        parent_id: 'PAGE_1',
        position: 1,
        deleted_at: null,
        op_refs: [],
      }
    }
    return undefined
  })
})

describe('#2914 — Enter on multi-block content does not race splitBlock vs createBelow', () => {
  it('awaits the split, skips the extra empty createBelow, and focuses the last split block', async () => {
    const setFocused = vi.fn()
    // Blank-line separated: a single newline is a line inside one paragraph
    // (#5160 D2) and would not split at all.
    const handle = makeHandle('A', 'alpha\n\nbravo\n\ncharlie')
    const rovingRef = { current: handle as RovingEditorHandle | null }

    const { result } = renderHook(() => {
      const handleFlush = useBlockFlush({
        rovingEditorRef: rovingRef,
        edit: store.getState().edit,
        splitBlock: store.getState().splitBlock,
        rootParentId: 'PAGE_1',
        pageStore: store,
      })
      return useBlockActionOrchestration({
        focusedBlockId: 'A',
        // #3344 — `collapsedVisible` is brand-gated so no command path can be
        // handed the un-zoomed page list. This test is not zoomed, where the
        // real derivation returns the page list verbatim; stand in for it.
        collapsedVisible: store.getState().blocks as unknown as MountedBlocks,
        blocks: store.getState().blocks,
        rovingEditor: handle,
        setFocused,
        setSelected: vi.fn(),
        handleFlush,
        pageStore: store,
        remove: store.getState().remove,
        moveBlocks: store.getState().moveBlocks,
        splitOff: store.getState().splitOff,
        mergeInto: store.getState().mergeInto,
        indent: store.getState().indent,
        dedent: store.getState().dedent,
        moveUp: store.getState().moveUp,
        moveDown: store.getState().moveDown,
        createBelow: store.getState().createBelow,
        discardDraft: vi.fn(),
        t,
      })
    })

    await act(async () => {
      await result.current.handleEnterSave()
    })

    const blocks = store.getState().blocks

    // Final structure is exactly the split's blocks in order — NO trailing empty
    // Enter block. (Pre-fix, the parallel empty createBelow added a 4th block.)
    expect(blocks.map((b) => b.content)).toEqual(['alpha', 'bravo', 'charlie'])

    // Non-tautology: the extra empty-block create was SKIPPED. Pre-fix,
    // `createBelow(focusedBlockId)` fired `create_block` with the default empty
    // content, so this assertion fails against the old racing code.
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '' }),
    )

    // The split's own createBelow chain carried the real rest-lines.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: 'bravo' }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: 'charlie' }),
    )

    // Focus landed on the LAST split block — proving the split was AWAITED (its
    // id is only knowable after it resolves) rather than a racing empty block.
    const lastSplit = blocks.at(-1)
    expect(lastSplit?.content).toBe('charlie')
    expect(setFocused).toHaveBeenCalledTimes(1)
    expect(setFocused).toHaveBeenCalledWith(lastSplit?.id)
  })

  // The split focuses its last block only once its creates land, so the editor
  // holds nothing meanwhile: an Enter then would split an emptied doc and add a
  // stray empty sibling.
  it('drops an Enter pressed while the split is still creating its blocks', async () => {
    const bravoCreated = deferred<void>()
    const answer = mockedInvoke.getMockImplementation()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block' && (args as Record<string, unknown>)['content'] === 'bravo') {
        await bravoCreated.promise
      }
      return answer?.(cmd, args)
    })
    const handle = makeHandle('A', 'alpha\n\nbravo\n\ncharlie')
    const rovingRef = { current: handle as RovingEditorHandle | null }
    const { result } = renderHook(() => {
      const handleFlush = useBlockFlush({
        rovingEditorRef: rovingRef,
        edit: store.getState().edit,
        splitBlock: store.getState().splitBlock,
        rootParentId: 'PAGE_1',
        pageStore: store,
      })
      return useBlockActionOrchestration({
        focusedBlockId: 'A',
        collapsedVisible: store.getState().blocks as unknown as MountedBlocks,
        blocks: store.getState().blocks,
        rovingEditor: handle,
        setFocused: vi.fn(),
        setSelected: vi.fn(),
        handleFlush,
        pageStore: store,
        remove: store.getState().remove,
        moveBlocks: store.getState().moveBlocks,
        splitOff: store.getState().splitOff,
        mergeInto: store.getState().mergeInto,
        indent: store.getState().indent,
        dedent: store.getState().dedent,
        moveUp: store.getState().moveUp,
        moveDown: store.getState().moveDown,
        createBelow: store.getState().createBelow,
        discardDraft: vi.fn(),
        t,
      })
    })

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = result.current.handleEnterSave()
    })
    // What the flush's unmount did to the handle.
    ;(handle as { activeBlockId: string | null }).activeBlockId = null
    await act(async () => {
      await result.current.handleEnterSave()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '' }),
    )

    bravoCreated.resolve()
    await act(async () => {
      await first
    })
    expect(store.getState().blocks.map((b) => b.content)).toEqual(['alpha', 'bravo', 'charlie'])
  })
})

// #5272 — the backend accepts a `[[link]]` to a block in another space only
// while a live block of the SAME page already holds that token
// (`page_holds_token`, `cross_space_validation.rs`). Saving the shortened
// source before creating the after-text removed the only holder of a link
// sitting after the caret, so the create was refused. A caret split is now one
// `split_block` (#6531), which creates and shortens in one transaction, all or
// nothing. Real store, real mock dispatch; only the roving editor handle is a
// stub.
describe('#5272 — a caret split is one split_block, all or nothing (#6531)', () => {
  const { BLOCK_GS_1, PAGE_GETTING_STARTED, PAGE_QUICK_NOTES } = SEED_IDS
  const LINK = `[[${PAGE_QUICK_NOTES}]]`
  const PRE_SPLIT = `intro ${LINK} outro`
  const AFTER = `${LINK} outro`

  /** Route `invoke` to the real mock, except the commands `reject` names. */
  function routeToMock(reject: string[]): void {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (reject.includes(cmd)) throw new Error(`${cmd} failed`)
      return dispatch(cmd, args)
    })
  }

  /** The id the split asked the backend to create. */
  function splitNewBlockId(): string {
    const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'split_block')
    const request = (call?.[1] as { request?: { newBlockId?: string } } | undefined)?.request
    return request?.newBlockId ?? ''
  }

  /** Getting Started loaded off the real mock, the caret inside GS_1 right before the link. */
  async function mountGettingStarted() {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    useUndoStore.setState({ pages: new Map() })
    dispatch('edit_block', { blockId: BLOCK_GS_1, toText: PRE_SPLIT })
    routeToMock([])
    const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
    await pageStore.getState().load()
    const idsBefore = pageStore.getState().blocks.map((b) => b.id)
    const handle = makeHandle(BLOCK_GS_1, PRE_SPLIT)
    handle.splitAtCaret = vi.fn(() => ({ before: 'intro', after: AFTER }))
    const setFocused = vi.fn((id: string | null) => useBlockStore.getState().setFocused(id))
    const s = pageStore.getState()
    const { result } = renderHook(() =>
      useBlockActionOrchestration({
        focusedBlockId: BLOCK_GS_1,
        collapsedVisible: pageStore.getState().blocks as unknown as MountedBlocks,
        blocks: pageStore.getState().blocks,
        rovingEditor: handle,
        setFocused,
        setSelected: vi.fn(),
        handleFlush: vi.fn(() => null),
        pageStore,
        remove: s.remove,
        moveBlocks: s.moveBlocks,
        splitOff: s.splitOff,
        mergeInto: s.mergeInto,
        indent: s.indent,
        dedent: s.dedent,
        moveUp: s.moveUp,
        moveDown: s.moveDown,
        createBelow: s.createBelow,
        discardDraft: vi.fn(),
        t,
      }),
    )
    return { pageStore, idsBefore, handle, setFocused, result }
  }

  it('persists both halves, the link after the caret included, as one undo entry', async () => {
    const { pageStore, handle, setFocused, result } = await mountGettingStarted()

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // Both halves persisted — re-query the page from the mock.
    await pageStore.getState().load()
    const [first, second] = pageStore.getState().blocks
    expect(first?.id).toBe(BLOCK_GS_1)
    expect(first?.content).toBe('intro')
    expect(second?.content).toBe(AFTER)
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe('intro')
    expect(mockBlocks.get(second?.id ?? '')?.['deleted_at']).toBeNull()
    // Focus follows the after-text; no re-mount.
    expect(setFocused).toHaveBeenCalledWith(second?.id)
    expect(handle.mount).not.toHaveBeenCalled()
    // One Ctrl+Z for the whole split.
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it('leaves no after-text sibling when shortening the source fails, and re-mounts the full text', async () => {
    const { pageStore, idsBefore, handle, result } = await mountGettingStarted()
    const blockCount = mockBlocks.size
    // The source's half of the split fails inside the command, after its
    // create of the after-text ran.
    const shorten = vi.spyOn(blocksHandlers, 'edit_block').mockImplementation(() => {
      throw new Error('edit failed')
    })
    onTestFinished(() => shorten.mockRestore())

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // Backend: the create went with the failed edit, the source is untouched.
    expect(shorten).toHaveBeenCalledTimes(1)
    const createdId = splitNewBlockId()
    expect(createdId).not.toBe('')
    expect(mockBlocks.has(createdId)).toBe(false)
    expect(mockBlocks.size).toBe(blockCount)
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe(PRE_SPLIT)
    // Store: back to the pre-split page, and a re-query agrees.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    await pageStore.getState().load()
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    // The user gets the complete text back, editable where they were.
    expect(handle.mount).toHaveBeenLastCalledWith(BLOCK_GS_1, PRE_SPLIT)
    expect(useBlockStore.getState().focusedBlockId).toBe(BLOCK_GS_1)
  })

  it('writes nothing when the split is refused and re-mounts the full text', async () => {
    const { pageStore, idsBefore, handle, result } = await mountGettingStarted()
    const blockCount = mockBlocks.size
    routeToMock(['split_block'])

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockBlocks.size).toBe(blockCount)
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe(PRE_SPLIT)
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    expect(pageStore.getState().blocksById.get(BLOCK_GS_1)?.content).toBe(PRE_SPLIT)
    expect(handle.mount).toHaveBeenLastCalledWith(BLOCK_GS_1, PRE_SPLIT)
    expect(useBlockStore.getState().focusedBlockId).toBe(BLOCK_GS_1)
  })
})

// Enter then a fast Tab: focus is on the block Enter creates at once, but the
// backend does not have it until the create lands, so the chord waits for the
// Enter and then acts on that block, not the one Enter left. Real store over
// the real mock; only the create is held open, as the IPC round trip holds it.
describe('a block chord pressed while Enter is creating acts on the block Enter creates', () => {
  const { BLOCK_GS_1, BLOCK_GS_2, BLOCK_GS_3, BLOCK_GS_4, BLOCK_GS_5, PAGE_GETTING_STARTED } =
    SEED_IDS

  /** Live children of `parentId` in the mock, in position order. */
  function childrenOf(parentId: string): string[] {
    return [...mockBlocks.values()]
      .filter((b) => b['parent_id'] === parentId && b['deleted_at'] === null)
      .toSorted((a, b) => (a['position'] as number) - (b['position'] as number))
      .map((b) => b['id'] as string)
  }

  type Chord = 'handleIndent' | 'handleDedent' | 'handleMoveUp' | 'handleMoveDown'

  /** Enter on GS_2, `chord` while the create is in flight, then let the create land. */
  async function enterThen(chord: Chord, { nested }: { nested: boolean }): Promise<string> {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    useUndoStore.setState({ pages: new Map() })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    const pageStore = createPageBlockStore(PAGE_GETTING_STARTED)
    await pageStore.getState().load()
    if (nested) await pageStore.getState().indent(BLOCK_GS_2)
    useBlockStore.getState().setFocused(BLOCK_GS_2)
    let release: () => void = () => undefined
    const createHeld = new Promise<void>((resolve) => {
      release = resolve
    })
    let created = ''
    const s = pageStore.getState()
    const { result } = renderHook(() =>
      useBlockActionOrchestration({
        focusedBlockId: BLOCK_GS_2,
        collapsedVisible: pageStore.getState().blocks as unknown as MountedBlocks,
        blocks: pageStore.getState().blocks,
        rovingEditor: makeHandle(BLOCK_GS_2, 'second'),
        setFocused: (id) => useBlockStore.getState().setFocused(id),
        setSelected: vi.fn(),
        handleFlush: vi.fn(() => null),
        pageStore,
        remove: s.remove,
        moveBlocks: s.moveBlocks,
        splitOff: s.splitOff,
        mergeInto: s.mergeInto,
        indent: s.indent,
        dedent: s.dedent,
        moveUp: s.moveUp,
        moveDown: s.moveDown,
        createBelow: async (afterBlockId, content, blockId) => {
          await createHeld
          created = (await s.createBelow(afterBlockId, content, blockId)) ?? ''
          return created
        },
        discardDraft: vi.fn(),
        t,
      }),
    )
    await act(async () => {
      const enter = result.current.handleEnterSave()
      result.current[chord]()
      release()
      await enter
    })
    expect(created).not.toBe('')
    return created
  }

  it('Tab indents the new block under the one Enter left', async () => {
    const created = await enterThen('handleIndent', { nested: false })
    await waitFor(() => expect(childrenOf(BLOCK_GS_2)).toEqual([created]))
    expect(childrenOf(BLOCK_GS_1)).toEqual([])
  })

  it('Shift+Tab dedents the new block and leaves the one Enter left nested', async () => {
    const created = await enterThen('handleDedent', { nested: true })
    await waitFor(() => expect(childrenOf(BLOCK_GS_1)).toEqual([BLOCK_GS_2]))
    expect(childrenOf(PAGE_GETTING_STARTED)).toEqual([
      BLOCK_GS_1,
      created,
      BLOCK_GS_3,
      BLOCK_GS_4,
      BLOCK_GS_5,
    ])
  })

  it('move up moves the new block above the one Enter left', async () => {
    const created = await enterThen('handleMoveUp', { nested: false })
    await waitFor(() =>
      expect(childrenOf(PAGE_GETTING_STARTED)).toEqual([
        BLOCK_GS_1,
        created,
        BLOCK_GS_2,
        BLOCK_GS_3,
        BLOCK_GS_4,
        BLOCK_GS_5,
      ]),
    )
  })

  it('move down moves the new block, not the one Enter left', async () => {
    const created = await enterThen('handleMoveDown', { nested: false })
    await waitFor(() =>
      expect(childrenOf(PAGE_GETTING_STARTED)).toEqual([
        BLOCK_GS_1,
        BLOCK_GS_2,
        BLOCK_GS_3,
        created,
        BLOCK_GS_4,
        BLOCK_GS_5,
      ]),
    )
  })
})
