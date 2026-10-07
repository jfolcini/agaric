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
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks as mockBlocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import type { MountedBlocks } from '@/lib/zoom-scope'
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
    const justCreatedBlockIds = { current: new Set<string>() }
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
        edit: store.getState().edit,
        indent: store.getState().indent,
        dedent: store.getState().dedent,
        moveUp: store.getState().moveUp,
        moveDown: store.getState().moveDown,
        createBelow: store.getState().createBelow,
        justCreatedBlockIds,
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

    // The content-bearing last block is NOT registered as a Discard-deletable
    // empty stub (parity with the caret-split path).
    expect(justCreatedBlockIds.current.size).toBe(0)
  })
})

// #5272 — the backend accepts a `[[link]]` to a block in another space only
// while a live block of the SAME page already holds that token
// (`page_holds_token`, `cross_space_validation.rs`). The caret split used to
// save the shortened source first, which removed the only holder of a link
// sitting after the caret, so the after-text's create was refused. The tauri
// mock does not model that rule (its `create_block` / `edit_block` scan no
// content), so the pin here is the ORDER against the mock's real state: the
// create lands while the source still holds the full text. Real store, real
// mock dispatch; only the roving editor handle is a stub.
describe('#5272 — a caret split creates the after-text before shortening the source', () => {
  const { BLOCK_GS_1, PAGE_GETTING_STARTED, PAGE_QUICK_NOTES } = SEED_IDS
  const LINK = `[[${PAGE_QUICK_NOTES}]]`
  const PRE_SPLIT = `intro ${LINK} outro`
  const AFTER = `${LINK} outro`

  /** Route `invoke` to the real mock, except the commands `reject` names. */
  function routeToMock(reject: string[], onCreate?: (args: Record<string, unknown>) => void): void {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (reject.includes(cmd)) throw new Error(`${cmd} failed`)
      if (cmd === 'create_block') onCreate?.((args ?? {}) as Record<string, unknown>)
      return dispatch(cmd, args)
    })
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
    const setFocused = vi.fn()
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
        edit: s.edit,
        indent: s.indent,
        dedent: s.dedent,
        moveUp: s.moveUp,
        moveDown: s.moveDown,
        createBelow: s.createBelow,
        justCreatedBlockIds: { current: new Set<string>() },
        discardDraft: vi.fn(),
        t,
      }),
    )
    return { pageStore, idsBefore, handle, setFocused, result }
  }

  it('creates the after-text while the backend still holds the full source, then shortens it', async () => {
    const { pageStore, handle, setFocused, result } = await mountGettingStarted()
    let sourceAtCreate: unknown = null
    routeToMock([], () => {
      sourceAtCreate = mockBlocks.get(BLOCK_GS_1)?.['content']
    })

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // The rule's precondition: when the create landed, a live block of the
    // page (the source) still held the link token.
    expect(sourceAtCreate).toBe(PRE_SPLIT)
    // Both halves persisted — re-query the page from the mock.
    await pageStore.getState().load()
    const [first, second] = pageStore.getState().blocks
    expect(first?.id).toBe(BLOCK_GS_1)
    expect(first?.content).toBe('intro')
    expect(second?.content).toBe(AFTER)
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe('intro')
    expect(mockBlocks.get(second?.id ?? '')?.['deleted_at']).toBeNull()
    // Focus follows the after-text, as before the reorder; no re-mount.
    expect(setFocused).toHaveBeenCalledWith(second?.id)
    expect(handle.mount).not.toHaveBeenCalled()
    // Still one Ctrl+Z for the whole split.
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it("deletes the created sibling when the source's save fails and re-mounts the full text", async () => {
    const { pageStore, idsBefore, handle, setFocused, result } = await mountGettingStarted()
    let createdId = ''
    routeToMock(['edit_block'], (args) => {
      createdId = args['blockId'] as string
    })

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // Backend: the sibling is soft-deleted, the source untouched.
    expect(createdId).not.toBe('')
    expect(mockBlocks.get(createdId)?.['deleted_at']).not.toBeNull()
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe(PRE_SPLIT)
    // Store: back to the pre-split page, and a re-query agrees.
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    await pageStore.getState().load()
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    // The user keeps the complete text editable where they were.
    expect(handle.mount).toHaveBeenCalledWith(BLOCK_GS_1, PRE_SPLIT)
    expect(setFocused).not.toHaveBeenCalled()
  })

  it('writes nothing when the create fails and re-mounts the full text', async () => {
    const { pageStore, idsBefore, handle, setFocused, result } = await mountGettingStarted()
    const blockCount = mockBlocks.size
    routeToMock(['create_block'])

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockBlocks.size).toBe(blockCount)
    expect(mockBlocks.get(BLOCK_GS_1)?.['content']).toBe(PRE_SPLIT)
    expect(pageStore.getState().blocks.map((b) => b.id)).toEqual(idsBefore)
    expect(pageStore.getState().blocksById.get(BLOCK_GS_1)?.content).toBe(PRE_SPLIT)
    expect(handle.mount).toHaveBeenCalledWith(BLOCK_GS_1, PRE_SPLIT)
    expect(setFocused).not.toHaveBeenCalled()
  })
})
