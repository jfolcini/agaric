import { act, renderHook } from '@testing-library/react'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import {
  createListMarkerPlugin,
  listMarkerOf,
  setListMarkerMeta,
} from '@/editor/extensions/list-marker-decoration'
import { parse } from '@/editor/markdown-serializer'
import { announce } from '@/lib/announcer'
import { newBlockId } from '@/lib/block-id'
import type { ListStyle } from '@/lib/list-style'
import { clearListStyle, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import type { FlatBlock } from '@/lib/tree-utils'
import type { MountedBlocks } from '@/lib/zoom-scope'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore } from '@/stores/page-blocks'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))
// The id Enter mints for the block it creates, which the `createBelow` double answers with.
vi.mock('@/lib/block-id', () => ({ newBlockId: vi.fn(() => 'NEW_1') }))
vi.mock('@/editor/markdown-serializer', () => ({
  parse: vi.fn((s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  })),
  serialize: vi.fn(() => 'content'),
}))
vi.mock('@/editor/types', () => ({
  pmEndOfFirstBlock: vi.fn(() => 1),
}))
// #4957 — the restructure handlers' post-flush remount baseline is gated on the
// SHARED `shouldSplitOnBlur` predicate. The file-level `parse` mock above always
// yields a single-paragraph doc, so the real predicate could never report a
// split here; this stands in for it. Defaults to `false`, leaving every other
// test in this file on the verbatim-capture path it already asserts.
const mockShouldSplitOnBlur = vi.fn((_md: string) => false)
vi.mock('@/editor/content-delta', async (importActual) => ({
  ...(await importActual<typeof import('@/editor/content-delta')>()),
  shouldSplitOnBlur: (...args: unknown[]) => mockShouldSplitOnBlur(...(args as [string])),
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

// #4552 slice 3 — the two property writers the keyboard grain reaches. Mocked
// at the helper layer (mirrors `useListStyleSyntax.test.ts`); the durable
// re-queried effect is pinned by `e2e/list-style-keyboard.spec.ts`.
vi.mock('@/lib/list-style', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/list-style')>()
  return {
    ...actual,
    setListStyle: vi.fn(async () => {}),
    clearListStyle: vi.fn(async () => {}),
  }
})

const mockedAnnounce = vi.mocked(announce)
const mockedLoggerWarn = vi.mocked(logger.warn)
const mockedSetListStyle = vi.mocked(setListStyle)
const mockedClearListStyle = vi.mocked(clearListStyle)

type OrchestrationParams = Parameters<typeof useBlockActionOrchestration>[0]

/**
 * #3344 — the hook's `collapsedVisible` is brand-gated (`MountedBlocks`), so a
 * caller cannot hand a command path the un-zoomed page list. These tests build
 * plain fixtures rather than running the real `useBlockZoom` derivation, so
 * they stand in for it here.
 *
 * Deliberately a file-local helper: the brand's whole point is that production
 * code has no reachable way to mint one, so this must not become a shared,
 * importable export.
 */
const mountScoped = (blocks: readonly FlatBlock[]): MountedBlocks => blocks as MountedBlocks

// #4957 — a REAL per-page store: the remount baseline reads `blocksById` after
// the flush, so a stub Map would pin the helper against itself rather than
// against the store the split actually writes to.
let pageStore: ReturnType<typeof createPageBlockStore>

function makeDefaultParams(
  overrides?: Partial<Omit<OrchestrationParams, 'collapsedVisible'>> & {
    collapsedVisible?: FlatBlock[]
  },
) {
  const { collapsedVisible: collapsedVisibleOverride, ...rest } = overrides ?? {}
  return {
    focusedBlockId: 'B' as string | null,
    collapsedVisible: mountScoped(
      collapsedVisibleOverride ?? [
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
        makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
      ],
    ),
    // #1342 — full flat tree (default mirrors collapsedVisible; tests of a
    // block with children override this with a tree that has them).
    blocks: [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
      makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
    ],
    rovingEditor: {
      editor: null as null,
      // #976 f22 — `mount` updates `activeBlockId` to mirror the real roving
      // editor, so the post-merge cursor guard (which checks
      // `activeBlockId === <merge target>`) behaves as it does in production.
      activeBlockId: null as string | null,
      mount: vi.fn(function (this: { activeBlockId: string | null }, id: string) {
        this.activeBlockId = id
      }),
      updateListMarker: vi.fn(),
      listMarker: vi.fn(() => ({ style: 'none' as ListStyle, ordinal: undefined })),
      unmount: vi.fn(() => null as string | null),
      getMarkdown: vi.fn(() => null as string | null),
      originalMarkdown: '' as string,
      splitAtCaret: vi.fn(() => null as { before: string; after: string } | null),
      storedMarkdown: '' as string,
      readAsTyped: vi.fn(),
    },
    // The live focus, which Enter's failure path reads to see whether the user moved on.
    setFocused: vi.fn((id: string | null) => {
      useBlockStore.setState({ focusedBlockId: id })
    }),
    setSelected: vi.fn(),
    handleFlush: vi.fn(() => null as string | null),
    pageStore,
    remove: vi.fn(async () => {}),
    moveBlocks: vi.fn(async () => {}),
    splitOff: vi.fn<OrchestrationParams['splitOff']>(async () => true),
    mergeInto: vi.fn<OrchestrationParams['mergeInto']>(async () => true),
    indent: vi.fn(async () => true),
    dedent: vi.fn(async () => true),
    moveUp: vi.fn(async () => true),
    moveDown: vi.fn(async () => true),
    createBelow: vi.fn(async () => 'NEW_1' as string | null),
    discardDraft: vi.fn(),
    t: vi.fn((key: string) => key) as unknown as TFunction,
    ...rest,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockShouldSplitOnBlur.mockReturnValue(false)
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ loading: false })
  // The live focus the default params' `focusedBlockId` stands for.
  useBlockStore.setState({ focusedBlockId: 'B' })
})

describe('useBlockActionOrchestration handleFocusPrev', () => {
  it('focuses previous block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(params.setFocused).toHaveBeenCalledWith('A')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('A', 'Alpha')
  })

  it('announces the block being edited', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.editingBlock')
  })

  it('does nothing when at first block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('announces empty block for block with no content', () => {
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: [
        makeBlock({ id: 'A', depth: 0, content: '' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
      ],
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.editingBlock')
  })
})

describe('useBlockActionOrchestration handleFocusNext', () => {
  it('focuses next block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusNext()
    })

    expect(params.setFocused).toHaveBeenCalledWith('C')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('C', 'Charlie')
  })

  it('does nothing when at last block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleFocusNext()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })

  // #4959 — `collapsedVisible` is the MOUNTED list; at the mount cap ArrowDown
  // used to dead-end with rows still below it.
  describe('at the mount boundary', () => {
    it('reveals and focuses the first row past the mount cap', () => {
      const hidden = makeBlock({ id: 'D', depth: 0, content: 'Delta' })
      const revealNextMounted = vi.fn(() => hidden as FlatBlock | null)
      const params = makeDefaultParams({ focusedBlockId: 'C', revealNextMounted })
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      act(() => {
        result.current.handleFocusNext()
      })

      expect(revealNextMounted).toHaveBeenCalledTimes(1)
      expect(params.setFocused).toHaveBeenCalledWith('D')
      expect(params.rovingEditor.mount).toHaveBeenCalledWith('D', 'Delta')
    })

    it('stays a no-op at the true last row (nothing left to reveal)', () => {
      const revealNextMounted = vi.fn(() => null)
      const params = makeDefaultParams({ focusedBlockId: 'C', revealNextMounted })
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      act(() => {
        result.current.handleFocusNext()
      })

      expect(revealNextMounted).toHaveBeenCalledTimes(1)
      expect(params.setFocused).not.toHaveBeenCalled()
      expect(params.rovingEditor.mount).not.toHaveBeenCalled()
    })

    it('does not reveal while mounted rows remain below the focused one', () => {
      const revealNextMounted = vi.fn(() => null)
      const params = makeDefaultParams({ focusedBlockId: 'B', revealNextMounted })
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      act(() => {
        result.current.handleFocusNext()
      })

      expect(revealNextMounted).not.toHaveBeenCalled()
      expect(params.setFocused).toHaveBeenCalledWith('C')
    })
  })
})

describe('useBlockActionOrchestration handleDeleteBlock', () => {
  it('deletes focused block and focuses previous', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled() // no-args by contract
    expect(params.remove).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith('A')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockDeleted')
  })

  it('focuses next block when deleting first block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.setFocused).toHaveBeenCalledWith('B')
  })

  it('prevents deletion of last remaining block', () => {
    const params = makeDefaultParams({
      collapsedVisible: [makeBlock({ id: 'A' })],
      focusedBlockId: 'A',
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(params.t).toHaveBeenCalledWith('blockTree.cannotDeleteLastBlock')
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.remove).not.toHaveBeenCalled()
  })

  it('sets focused to null when single block after delete', () => {
    const params = makeDefaultParams({
      collapsedVisible: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      focusedBlockId: 'B',
    })

    params.remove = vi.fn(async () => {
      // #3643 — the branded projection is readonly; simulate the store's
      // removal by re-deriving it rather than splicing in place.
      params.collapsedVisible = mountScoped(params.collapsedVisible.slice(0, 1))
    })

    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.setFocused).toHaveBeenCalledWith('A')
  })

  // #752 — DeleteBlockOpts.cursorPlacement was documented + passed by the
  // key-rule table but silently dropped; it now reaches mount() so the caret
  // lands at the END of the previous block after a Backspace-delete.
  it('forwards the cursorPlacement hint to mount when focusing the previous block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('A', 'Alpha', {
      cursorPlacement: 'end',
    })
  })

  it('does not apply the cursorPlacement hint when deleting the first block (next block gets default caret)', () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
  })

  // #4958 — the roving editor holds only the focused block's OWN text, so a
  // blank parent reads as "empty" and Backspace routes here instead of to the
  // merge path. Without a reparent the store (and the backend cascade behind
  // it) takes the whole subtree down with the block; when the parent is
  // collapsed nothing on screen warns that more than one row is going.
  //
  // These cases drive a tiny mutable model of the store so the assertion is on
  // re-queried tree state (each child's `parent_id`), not on a spy: `remove`
  // cascades to descendants the way `page-blocks-reducers.remove` +
  // `delete_block` do, and `moveBlocks` reparents.
  describe('reparents children on delete (#4958)', () => {
    function modelStore(params: ReturnType<typeof makeDefaultParams>, tree: FlatBlock[]) {
      params.moveBlocks = vi.fn(async (ids: string[], newParentId: string | null) => {
        for (const block of tree) {
          if (ids.includes(block.id)) block.parent_id = newParentId
        }
      })
      params.remove = vi.fn(async (id: string) => {
        const doomed = new Set([id])
        // Transitive closure over parent_id — the backend's cascade soft-delete.
        for (let grew = true; grew;) {
          grew = false
          for (const block of tree) {
            const parent = block.parent_id ?? null
            if (parent !== null && doomed.has(parent) && !doomed.has(block.id)) {
              doomed.add(block.id)
              grew = true
            }
          }
        }
        const survivors = tree.filter((block) => !doomed.has(block.id))
        tree.length = 0
        tree.push(...survivors)
      })
    }

    const blankParentTree = (): FlatBlock[] => [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: '' }),
      makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
      makeBlock({ id: 'B2', depth: 1, content: 'B-two', parent_id: 'B' }),
    ]

    it('keeps a COLLAPSED blank parent’s children, reparented onto the previous block', async () => {
      const params = makeDefaultParams()
      const tree = blankParentTree()
      params.blocks = tree
      // B is collapsed: its children never reach the visible projection, so
      // one Backspace would silently take two hidden rows with it.
      params.collapsedVisible = mountScoped([
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: '' }),
      ])
      modelStore(params, tree)

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      })

      expect(tree.map((b) => b.id)).toEqual(['A', 'B1', 'B2'])
      expect(tree.filter((b) => b.parent_id === 'A').map((b) => b.id)).toEqual(['B1', 'B2'])
      expect(params.setFocused).toHaveBeenCalledWith('A')
    })

    it('keeps an EXPANDED blank parent’s children too (plan reads the full tree)', async () => {
      const params = makeDefaultParams()
      const tree = blankParentTree()
      params.blocks = tree
      // Expanded: the children are visible rows, so `collapsedVisible` — and
      // with it the post-delete focus target — differs from the collapsed case.
      params.collapsedVisible = mountScoped(blankParentTree())
      modelStore(params, tree)

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      })

      expect(tree.map((b) => b.id)).toEqual(['A', 'B1', 'B2'])
      expect(tree.filter((b) => b.parent_id === 'A').map((b) => b.id)).toEqual(['B1', 'B2'])
    })

    it('refuses the delete when a blank parent has no row above to adopt its children', async () => {
      const params = makeDefaultParams({ focusedBlockId: 'B' })
      const tree = [
        makeBlock({ id: 'B', depth: 0, content: '' }),
        makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
        makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
      ]
      params.blocks = tree
      params.collapsedVisible = mountScoped([
        makeBlock({ id: 'B', depth: 0, content: '' }),
        makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
      ])
      modelStore(params, tree)

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      })

      expect(tree.map((b) => b.id)).toEqual(['B', 'B1', 'C'])
      expect(params.remove).not.toHaveBeenCalled()
      expect(params.moveBlocks).not.toHaveBeenCalled()
      // A refusal the user cannot see is indistinguishable from a dead
      // Backspace key, so it says why on both channels — as the neighbouring
      // last-block bail does.
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.cannotDeleteParentAtTop')
      expect(mockedAnnounce).toHaveBeenCalledWith('blockTree.cannotDeleteParentAtTop')
    })

    // `BlockTree` hands the hook a `moveBlocks` wrapper that re-reads the tree
    // and THROWS when a child did not land under the new parent, so a failed
    // reparent must not be followed by the remove that would cascade onto it.
    it('does not remove the block when the reparent fails', async () => {
      const params = makeDefaultParams()
      const tree = blankParentTree()
      params.blocks = tree
      params.collapsedVisible = mountScoped([
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: '' }),
      ])
      modelStore(params, tree)
      params.moveBlocks = vi.fn(async () => {
        throw new Error('reparent incomplete')
      })

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      })

      expect(tree.map((b) => b.id)).toEqual(['A', 'B', 'B1', 'B2'])
      expect(params.remove).not.toHaveBeenCalled()
      expect(mockedLoggerWarn).toHaveBeenCalled()
    })

    it('does NOT reparent when the deleted block is childless', async () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      await act(async () => {
        result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      })

      expect(params.moveBlocks).not.toHaveBeenCalled()
      expect(params.remove).toHaveBeenCalledWith('B')
    })
  })

  it('does not delete when delete is already in progress', () => {
    const params = makeDefaultParams()
    // Make remove block so deleteInProgress stays true within the same synchronous act
    let removeCallCount = 0
    params.remove = vi.fn(async () => {
      removeCallCount++
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleDeleteBlock()
      result.current.handleDeleteBlock()
    })

    expect(removeCallCount).toBe(1)
  })
})

describe('useBlockActionOrchestration handleIndent', () => {
  it('flushes and indents focused block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    // R6 (#405): announce now fires on the action's resolution, so flush
    // microtasks (await act) before asserting the SR announcement.
    await act(async () => {
      result.current.handleIndent()
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.indent).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockIndented')
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleIndent()
    })

    expect(params.indent).not.toHaveBeenCalled()
  })
})

/**
 * #4957 — the post-flush remount baseline.
 *
 * A multi-block capture makes `handleFlush` take `runUnmountFlush`'s split
 * branch: `splitBlock` truncates the source to line 1 (synchronously, before
 * its first `await`) and creates siblings for the rest. Remounting the FULL
 * capture handed the editor the pre-split text as its new baseline, so the next
 * keystroke re-committed lines 2..N that already existed as siblings.
 *
 * `handleFlush` is the injected mock here, so it stands in for the split by
 * writing line 1 to the store the way the real reducer does.
 */
describe('useBlockActionOrchestration remount baseline after a split flush (#4957)', () => {
  const CAPTURE = 'line1\nline2\nline3'

  function makeSplitParams(overrides?: { capture?: string; splits?: boolean }) {
    const capture = overrides?.capture ?? CAPTURE
    const splits = overrides?.splits ?? true
    mockShouldSplitOnBlur.mockImplementation((md: string) => splits && md === capture)
    pageStore.setState({ blocks: [makeBlock({ id: 'B', depth: 0, content: capture })] })
    const params = makeDefaultParams({
      rovingEditor: {
        ...makeDefaultParams().rovingEditor,
        activeBlockId: 'B',
        getMarkdown: vi.fn(() => capture as string | null),
      },
      // Stands in for the split branch's synchronous first-line write.
      handleFlush: vi.fn(() => {
        pageStore.setState({ blocks: [makeBlock({ id: 'B', depth: 0, content: 'line1' })] })
        return capture as string | null
      }),
    })
    return params
  }

  it('handleIndent remounts the store line 1, not the pre-split capture', async () => {
    const params = makeSplitParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleIndent()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'line1')
  })

  it('handleIndentById remounts the store line 1, not the pre-split capture', async () => {
    const params = makeSplitParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleIndentById('B')
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'line1')
  })

  it('handleMoveUp remounts the store line 1, not the pre-split capture', async () => {
    const params = makeSplitParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveUp()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'line1')
  })

  it('remounts the capture verbatim when the flush did not split', async () => {
    const params = makeSplitParams({ capture: 'just one line', splits: false })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleIndent()
    })

    // The store now holds 'line1' (the stand-in flush always writes it), so a
    // helper that ignored `shouldSplitOnBlur` and always read the store would
    // fail here.
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'just one line')
  })

  it('remounts the capture when the block is not in this page store (#4550 embed)', async () => {
    const params = makeSplitParams()
    // The flush returns without splitting for a foreign block; model that by
    // leaving the store without the row.
    params.handleFlush = vi.fn(() => {
      pageStore.setState({ blocks: [] })
      return null as string | null
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleIndent()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', CAPTURE)
  })
})

describe('useBlockActionOrchestration handleDedent', () => {
  it('flushes and dedents focused block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleDedent()
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.dedent).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockDedented')
  })
})

describe('useBlockActionOrchestration handleIndentById/handleDedentById', () => {
  it('flushes, indents, and announces a successful context-menu action', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleIndentById('C')
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.indent).toHaveBeenCalledWith('C')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockIndented')
    expect(params.rovingEditor.mount).not.toHaveBeenCalled()
  })

  it('preserves focused editor content while dedenting by id', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'Unsaved focused content')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleDedentById('B')
    })

    expect(params.dedent).toHaveBeenCalledWith('B')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Unsaved focused content')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockDedented')
  })

  it('announces failure when indent by id is a no-op', async () => {
    const params = makeDefaultParams({ indent: vi.fn(async () => false) })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleIndentById('A')
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.moveFailed')
  })

  it('logs and announces failure when dedent by id rejects', async () => {
    const error = new Error('dedent failed')
    const params = makeDefaultParams({
      dedent: vi.fn(async () => {
        throw error
      }),
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleDedentById('A')
    })

    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      'useBlockActionOrchestration',
      'dedent by id failed',
      { blockId: 'A' },
      error,
    )
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.moveFailed')
  })
})

describe('useBlockActionOrchestration handleMoveUp/Down', () => {
  it('flushes and moves block up', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveUp()
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.moveUp).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockMovedUp')
  })

  it('flushes and moves block down', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveDown()
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.moveDown).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockMovedDown')
  })

  it('handleMoveUp does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleMoveUp()
    })

    expect(params.moveUp).not.toHaveBeenCalled()
  })
})

describe('useBlockActionOrchestration handleMoveUpById/DownById', () => {
  it('flushes, moves, and announces a successful move up by id', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveUpById('C')
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.moveUp).toHaveBeenCalledWith('C')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockMovedUp')
  })

  it('flushes, moves, and announces a successful move down by id', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveDownById('A')
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.moveDown).toHaveBeenCalledWith('A')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockMovedDown')
  })

  it('preserves focused editor content while moving up by id', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'Unsaved focused content')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveUpById('B')
    })

    expect(params.rovingEditor.getMarkdown).toHaveBeenCalled() // no-args by contract
    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.moveUp).toHaveBeenCalledWith('B')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Unsaved focused content')
  })

  it('announces failure and retains logger metadata when move down by id rejects', async () => {
    const error = new Error('move failed')
    const params = makeDefaultParams({
      moveDown: vi.fn(async () => {
        throw error
      }),
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveDownById('A')
    })

    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      'useBlockActionOrchestration',
      'moveDown by id failed',
      { blockId: 'A' },
      error,
    )
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.moveFailed')
  })
})

// ── scrollIntoView after keyboard move ───────────────────────────

describe('useBlockActionOrchestration  scrollIntoView', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>
  let blockEl: HTMLDivElement

  beforeEach(() => {
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    blockEl = document.createElement('div')
    blockEl.setAttribute('data-block-id', 'B')
    document.body.append(blockEl)
  })

  afterEach(() => {
    scrollSpy.mockRestore()
    if (blockEl.parentNode) blockEl.parentNode.removeChild(blockEl)
  })

  it('scrolls the moved block into view after handleMoveUp resolves', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveUp()
      // Flush the moveUp promise chain so .then(() => scrollFocusedBlockIntoView) fires.
      await Promise.resolve()
    })

    // The rAF callback runs asynchronously; wait for scrollIntoView to be invoked.
    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })
  })

  it('scrolls the moved block into view after handleMoveDown resolves', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveDown()
      await Promise.resolve()
    })

    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })
  })

  it('scrolls the moved block into view after handleMoveUpById resolves', async () => {
    // Create a second block element for the id-addressed path.
    const otherEl = document.createElement('div')
    otherEl.setAttribute('data-block-id', 'C')
    document.body.append(otherEl)

    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveUpById('C')
    })

    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })

    if (otherEl.parentNode) otherEl.parentNode.removeChild(otherEl)
  })

  it('scrolls the moved block into view after handleMoveDownById resolves', async () => {
    const otherEl = document.createElement('div')
    otherEl.setAttribute('data-block-id', 'A')
    document.body.append(otherEl)

    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveDownById('A')
    })

    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })

    if (otherEl.parentNode) otherEl.parentNode.removeChild(otherEl)
  })

  it('announces failure and does not scroll when handleMoveUpById is a no-op', async () => {
    const params = makeDefaultParams({ moveUp: vi.fn(async () => false) })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMoveUpById('B')
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.moveFailed')
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('does NOT scroll when moveUp rejects', async () => {
    const moveUp = vi.fn(async () => {
      throw new Error('move failed')
    })
    const params = makeDefaultParams({ moveUp })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveUp()
      // Flush both the rejection and the chained .catch microtask.
      await Promise.resolve()
      await Promise.resolve()
    })

    // Give rAF a chance to fire — it should not be scheduled because .catch ran.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('does not crash when the DOM node is missing (block virtualised away)', async () => {
    // Remove the pre-seeded element so querySelector returns null.
    if (blockEl.parentNode) blockEl.parentNode.removeChild(blockEl)

    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleMoveUp()
      await Promise.resolve()
    })

    // Let rAF fire — scrollIntoView should be no-op'd by `?.`.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    expect(scrollSpy).not.toHaveBeenCalled()
  })
})

describe('useBlockActionOrchestration handleMergeWithPrev', () => {
  it('merges with previous block', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })
    // The delete is `merge_blocks`' own, not a second write from the hook.
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith('A')
  })

  // #921 f2 — a plain string concat would re-parse the current block's leading
  // block-marker (`- `, `# `, `> `, `1. `) as a NEW construct appended to the
  // previous paragraph. The merge must strip that leading marker so the text
  // joins inline.
  it('strips a leading list marker so merged content does not become a list item', async () => {
    const params = makeDefaultParams()
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: 'foo' }),
      makeBlock({ id: 'B', depth: 0, content: '- bar' }),
    ])
    params.rovingEditor.unmount = vi.fn(() => '- bar')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    // No leading "- " / list structure carried into the merged content.
    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'foobar', { baseText: 'foo' })
    const merged = vi.mocked(params.mergeInto).mock.calls[0]?.[2] as string
    expect(merged).not.toMatch(/^- /)
    expect(merged).not.toContain('- bar')
  })

  it('strips a leading heading marker on merge', async () => {
    const params = makeDefaultParams()
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: 'foo' }),
      makeBlock({ id: 'B', depth: 0, content: '# h' }),
    ])
    params.rovingEditor.unmount = vi.fn(() => '# h')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'fooh', { baseText: 'foo' })
  })

  it('leaves plain (marker-free) content as a simple concat', async () => {
    const params = makeDefaultParams()
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: 'foo' }),
      makeBlock({ id: 'B', depth: 0, content: 'bar' }),
    ])
    params.rovingEditor.unmount = vi.fn(() => 'bar')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'foobar', { baseText: 'foo' })
  })

  it('does nothing when at first block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).not.toHaveBeenCalled()
  })

  it('re-mounts editor on merge failure', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    // The store toasts a failed `merge_blocks`; a second toast here would double it.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('a merge that fails after the user moved on leaves the focus where it is', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    let answer: (ok: boolean) => void = () => undefined
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let merge: Promise<void> = Promise.resolve()
    act(() => {
      merge = result.current.handleMergeWithPrev()
    })
    useBlockStore.setState({ focusedBlockId: 'C' })
    await act(async () => {
      answer(false)
      await merge
    })

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(params.rovingEditor.mount).not.toHaveBeenCalledWith('B', 'Beta')
    expect(useBlockStore.getState().focusedBlockId).toBe('C')
  })

  // ------------------------------------------------------------------------
  // #1342 — Backspace-merge of a block that HAS CHILDREN keeps the children:
  // `merge_blocks` moves them onto the merge target in the same transaction
  // as the delete (#6531), so the hook sends the one merge and moves nothing.
  // ------------------------------------------------------------------------
  describe('merges a block with children (#1342)', () => {
    it('merges an expanded parent with one mergeInto and moves no children itself', async () => {
      const params = makeDefaultParams()
      // Source B (focused, expanded) has two children B1, B2; the previous
      // VISIBLE block is A's child A1, so the text merges there.
      params.blocks = [
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'A1', depth: 1, content: 'A-one', parent_id: 'A' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
        makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
        makeBlock({ id: 'B2', depth: 1, content: 'B-two', parent_id: 'B' }),
      ]
      params.collapsedVisible = mountScoped(params.blocks)
      // Focus the source B (flat index 2), not the A1 row above it.
      params.focusedBlockId = 'B'
      params.rovingEditor.unmount = vi.fn(() => 'Beta')

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      expect(params.mergeInto).toHaveBeenCalledTimes(1)
      expect(params.mergeInto).toHaveBeenCalledWith('B', 'A1', 'A-oneBeta', {
        baseText: 'A-one',
      })
      expect(params.moveBlocks).not.toHaveBeenCalled()
      expect(params.remove).not.toHaveBeenCalled()
      expect(params.setFocused).toHaveBeenCalledWith('A1')
    })

    it('handleMergeById merges a block with children the same way', async () => {
      const params = makeDefaultParams({ focusedBlockId: null })
      params.blocks = [
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
        makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
        makeBlock({ id: 'B2', depth: 1, content: 'B-two', parent_id: 'B' }),
      ]
      params.collapsedVisible = mountScoped([
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
      ])

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeById('B')
      })

      expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })
      expect(params.moveBlocks).not.toHaveBeenCalled()
      expect(params.remove).not.toHaveBeenCalled()
    })
  })

  // #6559 — the caret goes to the join before the merge lands, so keys typed
  // while it is in flight go there instead of into an unmounted editor.
  it('puts the caret at the join on the merge target before the merge answers', async () => {
    const setTextSelection = vi.fn()
    const focus = vi.fn()
    const liveEditor = {
      state: { doc: { content: { size: 20 } } },
      commands: { setTextSelection },
      view: { focus },
    } as unknown as NonNullable<
      Parameters<typeof useBlockActionOrchestration>[0]['rovingEditor']['editor']
    >
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    ;(params.rovingEditor as { editor: unknown }).editor = liveEditor
    let answer: (ok: boolean) => void = () => undefined
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let merge: Promise<void> = Promise.resolve()
    act(() => {
      merge = result.current.handleMergeWithPrev()
    })
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('A', 'AlphaBeta')
    expect(params.setFocused).toHaveBeenCalledWith('A')
    // `pmEndOfFirstBlock` is mocked to 1: the end of 'Alpha's paragraph.
    expect(setTextSelection).toHaveBeenCalledWith(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })

    await act(async () => {
      answer(true)
      await merge
    })
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.rovingEditor.mount).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Store failure CONTRACT: pageStore.mergeInto() RESOLVES `false` on failure
// (it puts both blocks back and toasts internally) — it NEVER rejects. The
// boolean is the only failure signal production emits, so the hook must give
// the merged-away block back on `false`.
// ---------------------------------------------------------------------------
describe('merge honors mergeInto() resolving false (store contract)', () => {
  it('handleMergeWithPrev gives the source block back when mergeInto resolves false', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
    // Failure cleanup gives the source block back with its captured content.
    expect(params.rovingEditor.mount).toHaveBeenLastCalledWith('B', 'Beta')
    expect(params.setFocused).toHaveBeenLastCalledWith('B')
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('handleMergeWithPrev moves and deletes nothing when mergeInto resolves false', async () => {
    const params = makeDefaultParams()
    params.blocks = [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
      makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
    ]
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
    ])
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.moveBlocks).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
  })

  it('handleMergeById does not focus the target when mergeInto resolves false', async () => {
    const params = makeDefaultParams()
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.mergeInto).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Re-entrancy: handleMergeWithPrev unmounts the roving editor (emptying the
// doc) and then awaits IPC. An autorepeat/double Backspace in that window
// routes through the Backspace-on-empty rule into handleDeleteBlock, racing
// remove() against the in-flight merge (cascade-deleting the source subtree).
// The merge needs its own in-progress guard, honored by delete/enter too.
// ---------------------------------------------------------------------------
describe('merge in-progress guard (autorepeat Backspace)', () => {
  function deferredMerge() {
    let resolve!: (v: boolean) => void
    const promise = new Promise<boolean>((res) => {
      resolve = res
    })
    return { mergeInto: vi.fn<OrchestrationParams['mergeInto']>(() => promise), resolve }
  }

  it('handleDeleteBlock is a no-op while a merge is in flight; nothing else deletes', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredMerge()
    params.mergeInto = deferred.mergeInto
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let mergePromise!: Promise<void>
    act(() => {
      mergePromise = result.current.handleMergeWithPrev()
    })
    // Autorepeat Backspace lands while the merge's IPC is pending: the
    // unmounted (now-empty) editor routes it to the Backspace-on-empty rule.
    act(() => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
    })
    expect(params.remove).not.toHaveBeenCalled()

    await act(async () => {
      deferred.resolve(true)
      await mergePromise
    })

    // Only the merge ran — once, for the merged-away block.
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.mergeInto).toHaveBeenCalledTimes(1)
    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })
  })

  it('a second handleMergeWithPrev while one is in flight is dropped', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredMerge()
    params.mergeInto = deferred.mergeInto
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleMergeWithPrev()
      second = result.current.handleMergeWithPrev()
    })
    // The merge runs synchronously up to its first await, so a non-guarded
    // second call would have already invoked mergeInto again here.
    expect(params.mergeInto).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferred.resolve(true)
      await Promise.all([first, second])
    })
    expect(params.mergeInto).toHaveBeenCalledTimes(1)
  })

  it('handleEnterSave is a no-op while a merge is in flight', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredMerge()
    params.mergeInto = deferred.mergeInto
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let mergePromise!: Promise<void>
    act(() => {
      mergePromise = result.current.handleMergeWithPrev()
    })
    await act(async () => {
      await result.current.handleEnterSave()
    })
    expect(params.createBelow).not.toHaveBeenCalled()

    await act(async () => {
      deferred.resolve(true)
      await mergePromise
    })
    expect(params.mergeInto).toHaveBeenCalledTimes(1)
    expect(params.createBelow).not.toHaveBeenCalled()
    expect(params.splitOff).not.toHaveBeenCalled()
  })

  it('handleMergeById is guarded against an in-flight merge too', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredMerge()
    params.mergeInto = deferred.mergeInto
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleMergeWithPrev()
      second = result.current.handleMergeById('C')
    })
    expect(params.mergeInto).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferred.resolve(true)
      await Promise.all([first, second])
    })
  })
})

// ---------------------------------------------------------------------------
// Backspace-at-start against a VERBATIM previous block (code fence, table,
// math block, divider): a textual join corrupts the construct ('```js\ncode\n```'
// + 'text' re-parses as an unclosed fence that swallows the text). The merge
// must be a conservative no-op join: keep both blocks, move the caret only.
// ---------------------------------------------------------------------------
describe('merge into a verbatim previous block is a no-op join', () => {
  const CODE_FENCE = '```js\ncode\n```'
  const DIVIDER = '---'

  const paragraphDoc = (s: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: s }] }],
  })

  beforeEach(() => {
    vi.mocked(parse).mockImplementation((s: string) => {
      if (s === CODE_FENCE) {
        return {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'js' },
              content: [{ type: 'text', text: 'code' }],
            },
          ],
        } as ReturnType<typeof parse>
      }
      if (s === DIVIDER) {
        return {
          type: 'doc',
          content: [{ type: 'horizontalRule' }],
        } as ReturnType<typeof parse>
      }
      return paragraphDoc(s) as ReturnType<typeof parse>
    })
  })

  afterEach(() => {
    vi.mocked(parse).mockImplementation((s: string) => paragraphDoc(s) as ReturnType<typeof parse>)
  })

  it('code-fence prev: flushes the current block and focuses prev with caret at end', async () => {
    const params = makeDefaultParams()
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: CODE_FENCE }),
      makeBlock({ id: 'B', depth: 0, content: 'text' }),
    ])
    params.blocks = [...params.collapsedVisible]
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    // No textual join, no delete — the fence would swallow the text.
    expect(params.mergeInto).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
    // Current typing is persisted, then focus moves to the fence block.
    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith('A')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('A', CODE_FENCE, {
      cursorPlacement: 'end',
    })
  })

  it('divider prev: horizontalRule last node also suppresses the join', async () => {
    const params = makeDefaultParams()
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: DIVIDER }),
      makeBlock({ id: 'B', depth: 0, content: 'text' }),
    ])
    params.blocks = [...params.collapsedVisible]
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
  })

  it('handleMergeById no-ops against a verbatim prev without unmounting the editor', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'B' })
    params.collapsedVisible = mountScoped([
      makeBlock({ id: 'A', depth: 0, content: CODE_FENCE }),
      makeBlock({ id: 'B', depth: 0, content: 'text' }),
    ])
    params.blocks = [...params.collapsedVisible]
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('B')
    })

    expect(params.mergeInto).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
  })

  it('paragraph prev still merges normally', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })
  })
})

// The by-id handlers sit in the rows' context: they must keep their identity
// across a focus move and still treat the block focused NOW as the live one.
describe('useBlockActionOrchestration by-id handlers read focus at call time', () => {
  function renderFocusedOnAThenC(params: ReturnType<typeof makeDefaultParams>) {
    const hook = renderHook((p: typeof params) => useBlockActionOrchestration(p), {
      initialProps: params,
    })
    const before = hook.result.current
    hook.rerender({ ...params, focusedBlockId: 'C' })
    return { before, after: hook.result.current }
  }

  it.each([
    ['handleIndentById', 'indent'],
    ['handleDedentById', 'dedent'],
    ['handleMoveUpById', 'moveUp'],
    ['handleMoveDownById', 'moveDown'],
  ] as const)('%s remounts the block focused since it was created', async (handler, op) => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    params.rovingEditor.getMarkdown = vi.fn(() => 'Unsaved Charlie')
    const { before, after } = renderFocusedOnAThenC(params)

    expect(after[handler]).toBe(before[handler])
    await act(async () => {
      await before[handler]('C')
    })

    expect(params[op]).toHaveBeenCalledWith('C')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('C', 'Unsaved Charlie')
  })

  it('handleMergeById unmounts the block focused since it was created', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    params.rovingEditor.unmount = vi.fn(() => 'Edited Charlie')
    const { before, after } = renderFocusedOnAThenC(params)

    expect(after.handleMergeById).toBe(before.handleMergeById)
    await act(async () => {
      await before.handleMergeById('C')
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled() // no-args by contract
    expect(params.mergeInto).toHaveBeenCalledWith('C', 'B', 'BetaEdited Charlie', {
      baseText: 'Beta',
    })
  })
})

describe('useBlockActionOrchestration handleMergeById', () => {
  it('merges block by id with previous', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.mergeInto).toHaveBeenCalledWith('C', 'B', 'BetaCharlie', { baseText: 'Beta' })
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith('B')
  })

  it('does nothing for first block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('A')
    })

    expect(params.mergeInto).not.toHaveBeenCalled()
  })

  it('unmounts editor when merging focused block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    params.rovingEditor.unmount = vi.fn(() => 'Edited Charlie')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled() // no-args by contract
    expect(params.mergeInto).toHaveBeenCalledWith('C', 'B', 'BetaEdited Charlie', {
      baseText: 'Beta',
    })
  })

  it('a failed mergeInto gives the focused block its editor back and deletes nothing', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    params.rovingEditor.unmount = vi.fn(() => 'Edited Charlie')
    params.mergeInto = vi.fn<OrchestrationParams['mergeInto']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.mergeInto).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.rovingEditor.mount).toHaveBeenLastCalledWith('C', 'Edited Charlie')
    expect(params.setFocused).not.toHaveBeenCalled()
  })
})

describe('useBlockActionOrchestration handleEnterSave', () => {
  it('flushes and creates block below', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.handleFlush).toHaveBeenCalled() // no-args by contract
    expect(params.createBelow).toHaveBeenCalledWith('B', '', 'NEW_1')
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).not.toHaveBeenCalled()
  })

  it('gives the block Enter left back when createBelow returns null', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'Beta')
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.setFocused).toHaveBeenLastCalledWith('B')
    expect(params.rovingEditor.mount).toHaveBeenLastCalledWith('B', 'Beta')
  })

  it('announces block creation on Enter', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockCreated')
  })

  // #6559 — the new block is in the store once `createBelow` is called, so
  // focus moves to it then: keys typed while the create is in flight land in it.
  describe('while the create is in flight', () => {
    /** A `createBelow` whose calls all answer `id` once `answer` is called. */
    function heldCreate() {
      const answers: Array<(id: string | null) => void> = []
      const createBelow = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            answers.push(resolve)
          }),
      )
      return {
        createBelow,
        answer: (id: string | null) => {
          for (const resolve of answers) resolve(id)
        },
      }
    }

    it('focuses the new block before the create answers', async () => {
      const held = heldCreate()
      const params = makeDefaultParams({ createBelow: held.createBelow })
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      let enter: Promise<void> = Promise.resolve()
      act(() => {
        enter = result.current.handleEnterSave()
      })
      expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
      expect(mockedAnnounce).not.toHaveBeenCalled()

      await act(async () => {
        held.answer('NEW_1')
        await enter
      })
      expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockCreated')
    })

    it('a second Enter creates below the block the first one focused', async () => {
      const held = heldCreate()
      vi.mocked(newBlockId).mockReturnValueOnce('NEW_1').mockReturnValueOnce('NEW_2')
      const params = makeDefaultParams({ createBelow: held.createBelow })
      const { result, rerender } = renderHook(() => useBlockActionOrchestration(params))

      let first: Promise<void> = Promise.resolve()
      act(() => {
        first = result.current.handleEnterSave()
      })
      // What the focus change does in BlockTree: the editor mounts on the new block.
      params.rovingEditor.activeBlockId = 'NEW_1'
      params.focusedBlockId = 'NEW_1'
      rerender()
      let second: Promise<void> = Promise.resolve()
      act(() => {
        second = result.current.handleEnterSave()
      })

      expect(params.createBelow).toHaveBeenCalledTimes(2)
      expect(params.createBelow).toHaveBeenLastCalledWith('NEW_1', '', 'NEW_2')
      expect(params.setFocused).toHaveBeenLastCalledWith('NEW_2')
      expect(mockedLoggerWarn).not.toHaveBeenCalled()
      await act(async () => {
        held.answer('NEW_1')
        await Promise.all([first, second])
      })
    })

    it('a create that fails after the user moved on leaves the focus where it is', async () => {
      const held = heldCreate()
      const params = makeDefaultParams({ createBelow: held.createBelow })
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      let enter: Promise<void> = Promise.resolve()
      act(() => {
        enter = result.current.handleEnterSave()
      })
      useBlockStore.setState({ focusedBlockId: 'C' })
      await act(async () => {
        held.answer(null)
        await enter
      })

      expect(params.setFocused).toHaveBeenLastCalledWith('NEW_1')
      expect(params.rovingEditor.mount).not.toHaveBeenCalled()
      expect(useBlockStore.getState().focusedBlockId).toBe('C')
    })
  })

  it('does not announce when createBelow returns null', async () => {
    const params = makeDefaultParams()
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockedAnnounce).not.toHaveBeenCalled()
  })

  // #909 — Enter splits the block at the caret.
  it('splits at caret: before-text stays, after-text seeds the new block', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.storedMarkdown = 'helloworld'
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // One `split_block`: the current block keeps the before-caret text and the
    // new block is created WITH the after-caret text, rebased on what the
    // block held when the editor took it.
    expect(params.splitOff).toHaveBeenCalledTimes(1)
    expect(params.splitOff).toHaveBeenCalledWith('B', 'hello', 'world', 'NEW_1', {
      baseText: 'helloworld',
    })
    expect(params.createBelow).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
    // The legacy whole-block flush path must NOT run on a mid-text split.
    expect(params.handleFlush).not.toHaveBeenCalled()
  })

  it('caret at end (after === "") uses the legacy empty-block path', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: '' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.createBelow).toHaveBeenCalledWith('B', '', 'NEW_1')
  })

  // Store contract (#730 family): splitOff() RESOLVES false on failure — it
  // never rejects, and the store has already put the block back whole. The
  // hook gives the user the unsplit text and writes nothing to compensate.
  it('a failed splitOff restores the full content and deletes nothing', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'hello world')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello ', after: 'world' }))
    params.splitOff = vi.fn<OrchestrationParams['splitOff']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.splitOff).toHaveBeenCalledTimes(1)
    expect(params.createBelow).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
    // The user keeps their complete, unsplit text editable.
    expect(params.rovingEditor.mount).toHaveBeenLastCalledWith('B', 'hello world')
    expect(params.setFocused).toHaveBeenLastCalledWith('B')
  })

  // The failure path must withdraw the #4729 exemption registered for an Enter
  // at line start, or the restored block is never cleaned up when left blank.
  it('a failed splitOff restores the source editor and withdraws the empty-source exemption', async () => {
    const preserveEmptyBlockIds = { current: new Set<string>() }
    const params = makeDefaultParams({ preserveEmptyBlockIds })
    params.rovingEditor.getMarkdown = vi.fn(() => 'hello world')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: '', after: 'hello world' }))
    params.splitOff = vi.fn<OrchestrationParams['splitOff']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(preserveEmptyBlockIds.current.has('B')).toBe(false)
    expect(params.rovingEditor.mount).toHaveBeenLastCalledWith('B', 'hello world')
    expect(params.setFocused).toHaveBeenLastCalledWith('B')
  })

  // #2786 — the caret-split branch unmounts the roving editor directly
  // instead of routing through `persistUnmount` (the shared cleanup every
  // OTHER programmatic block switch uses), so the departed (split-source)
  // block's persisted draft row was never cleaned up. Assert the fix:
  // `discardDraft` runs for the OLD block once `split.before` commits.
  it('discards the departed block draft after a successful caret split', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.discardDraft).toHaveBeenCalledWith('B')
    // Ordering matters: the draft is only stale to discard once the split
    // content is actually committed.
    const splitOrder = vi.mocked(params.splitOff).mock.invocationCallOrder[0] ?? -1
    const discardOrder = vi.mocked(params.discardDraft).mock.invocationCallOrder[0] ?? -1
    expect(splitOrder).toBeLessThan(discardOrder)
  })

  it('does not discard the draft when the split fails (block never departed)', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'hello world')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello ', after: 'world' }))
    params.splitOff = vi.fn<OrchestrationParams['splitOff']>(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.discardDraft).not.toHaveBeenCalled()
  })

  it('does not discard any draft on the legacy (non-split) Enter path', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.discardDraft).not.toHaveBeenCalled()
  })
})

// #5160 D17 — Escape keeps the text: it saves through the same flush every
// other way out of a block takes, leaves editing, and selects the block.
describe('useBlockActionOrchestration handleEscapeSave', () => {
  it('saves through the flush, leaves editing and selects the block, with no toast', () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'Beta, edited')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeSave()
    })

    expect(params.handleFlush).toHaveBeenCalledTimes(1)
    expect(params.setSelected).toHaveBeenCalledWith(['B'])
    expect(params.setFocused).not.toHaveBeenCalled()
    expect(params.discardDraft).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('leaves a blank block without selecting it', () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => '  ')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeSave()
    })

    expect(params.handleFlush).toHaveBeenCalledTimes(1)
    expect(params.setFocused).toHaveBeenCalledWith(null)
    expect(params.setSelected).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeSave()
    })

    expect(params.handleFlush).not.toHaveBeenCalled()
    expect(params.setSelected).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// #4552 slice 3 — list continuation on Enter, strip-then-merge on Backspace
// ---------------------------------------------------------------------------

const markerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
  },
})

/**
 * A roving-editor marker double backed by the REAL marker plugin, so
 * `listMarker()` returns whatever `updateListMarker()` last pushed —
 * exactly the handle contract `use-roving-editor` implements. A test can
 * therefore press the SECOND Backspace / Enter and see what the hook reads.
 */
function markerHandle(style: ListStyle) {
  const holder = {
    state: EditorState.create({ schema: markerSchema, plugins: [createListMarkerPlugin()] }),
  }
  holder.state = holder.state.apply(setListMarkerMeta(holder.state.tr, { style, ordinal: 1 }))
  return {
    listMarker: vi.fn(() => listMarkerOf(holder.state)),
    updateListMarker: vi.fn((next: ListStyle, ordinal: number | undefined) => {
      holder.state = holder.state.apply(
        setListMarkerMeta(holder.state.tr, { style: next, ordinal }),
      )
    }),
  }
}

function styledParams(style: ListStyle, content: string) {
  const params = makeDefaultParams()
  const { listMarker, updateListMarker } = markerHandle(style)
  params.rovingEditor.listMarker = listMarker
  params.rovingEditor.updateListMarker = updateListMarker
  params.rovingEditor.getMarkdown = vi.fn(() => content)
  params.rovingEditor.unmount = vi.fn(() => content)
  return params
}

describe('useBlockActionOrchestration listStyle continuation (#4552 slice 3)', () => {
  it('Enter on a styled non-empty block creates the sibling with the same listStyle', async () => {
    const params = styledParams('ordered', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).toHaveBeenCalledWith('B', '', 'NEW_1')
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
    expect(mockedSetListStyle).toHaveBeenCalledTimes(1)
    expect(mockedSetListStyle).toHaveBeenCalledWith('NEW_1', 'ordered')
    expect(mockedClearListStyle).not.toHaveBeenCalled()
  })

  it('the after-caret sibling of a caret split carries the style too', async () => {
    const params = styledParams('bullet', 'Beta')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'Be', after: 'ta' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.splitOff).toHaveBeenCalledWith('B', 'Be', 'ta', 'NEW_1', { baseText: '' })
    expect(params.createBelow).not.toHaveBeenCalled()
    expect(mockedSetListStyle).toHaveBeenCalledWith('NEW_1', 'bullet')
  })

  it('Enter on a plain block writes no property', async () => {
    const params = styledParams('none', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).toHaveBeenCalledWith('B', '', 'NEW_1')
    expect(mockedSetListStyle).not.toHaveBeenCalled()
    expect(mockedClearListStyle).not.toHaveBeenCalled()
  })

  it('Enter on an EMPTY styled block clears the style and creates no sibling', async () => {
    const params = styledParams('ordered', '')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockedClearListStyle).toHaveBeenCalledTimes(1)
    expect(mockedClearListStyle).toHaveBeenCalledWith('B')
    expect(params.rovingEditor.updateListMarker).toHaveBeenCalledWith('none', undefined)
    expect(params.createBelow).not.toHaveBeenCalled()
    expect(params.handleFlush).not.toHaveBeenCalled()
    // The block stays mounted and focused — the user keeps typing in it.
    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('after the clear, the next Enter on the still-empty block creates a plain sibling', async () => {
    const params = styledParams('ordered', '')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
      await result.current.handleEnterSave()
    })

    expect(mockedClearListStyle).toHaveBeenCalledTimes(1)
    expect(params.createBelow).toHaveBeenCalledTimes(1)
    expect(mockedSetListStyle).not.toHaveBeenCalled()
  })

  it('a second Enter inside the property-event window still LEAVES the list', async () => {
    const params = styledParams('ordered', 'Beta')
    const { result, rerender } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })
    expect(mockedSetListStyle).toHaveBeenCalledWith('NEW_1', 'ordered')

    // What production does next, and the whole point of this case: the new
    // block mounts, `mount()` resets its marker to 'none' (#3000), and its
    // `EditableBlock` effect re-pushes `ListMarkerContext`'s value — still
    // empty, because `set_property` → `block:properties-changed` → the 150 ms
    // trailing debounce → the batch refetch has not landed yet. So the marker
    // reads 'none' for a block this hook itself just made ordered.
    params.rovingEditor.activeBlockId = 'NEW_1'
    params.rovingEditor.updateListMarker('none', undefined)
    params.focusedBlockId = 'NEW_1'
    params.rovingEditor.getMarkdown = vi.fn(() => '')
    params.rovingEditor.unmount = vi.fn(() => '')
    rerender()

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // The ordinary "double Enter to leave the list" gesture. Reading 'none'
    // here took the plain `createBelow` path instead, leaving a stray empty
    // ordered item with an unstyled block under it — which
    // `empty-block-cleanup.ts` guard 5 then keeps forever, because the stray
    // carries a `listStyle` property.
    expect(mockedClearListStyle).toHaveBeenCalledTimes(1)
    expect(mockedClearListStyle).toHaveBeenCalledWith('NEW_1')
    expect(params.createBelow).toHaveBeenCalledTimes(1)
  })

  it('the optimistic style expires once focus leaves the block it was recorded for', async () => {
    const params = styledParams('ordered', 'Beta')
    const { result, rerender } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // Same stale-marker window as above, but the user clicked away to a plain
    // block instead of pressing Enter again. The record is keyed by block id,
    // so it must not answer for C.
    params.rovingEditor.activeBlockId = 'C'
    params.rovingEditor.updateListMarker('none', undefined)
    params.focusedBlockId = 'C'
    params.rovingEditor.getMarkdown = vi.fn(() => '')
    params.rovingEditor.unmount = vi.fn(() => '')
    rerender()

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // C is plain: Enter creates a sibling and clears nothing.
    expect(mockedClearListStyle).not.toHaveBeenCalled()
    expect(params.createBelow).toHaveBeenCalledTimes(2)
    expect(mockedSetListStyle).toHaveBeenCalledTimes(1)
  })

  it('a rejected clear puts back the exact marker it cleared, ordinal included', async () => {
    mockedClearListStyle.mockRejectedValueOnce(new Error('ipc failed'))
    const params = styledParams('ordered', '')
    // The editor is mounted on the block being cleared — the restore is
    // guarded on that, so a user who clicked away mid-write does not get the
    // old marker painted onto whatever block they landed on.
    params.rovingEditor.activeBlockId = 'B'
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // The `listStyle` row is still in SQLite, so `useListStyles` projects the
    // same map and `EditableBlock`'s marker effect never re-fires. Left
    // cleared, the block would render AND behave as plain while it is still a
    // list item. `markerHandle` seeds ordinal 1, so the restore has to carry
    // it — a style-only restore would renumber the item.
    expect(params.rovingEditor.updateListMarker).toHaveBeenNthCalledWith(1, 'none', undefined)
    expect(params.rovingEditor.updateListMarker).toHaveBeenNthCalledWith(2, 'ordered', 1)
  })

  it('a failed continuation write logs, toasts, and leaves the new block focused', async () => {
    const failure = new Error('ipc failed')
    mockedSetListStyle.mockRejectedValueOnce(failure)
    const params = styledParams('ordered', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'useBlockActionOrchestration',
      'setListStyle (Enter continuation) failed',
      { blockId: 'NEW_1', style: 'ordered' },
      failure,
    )
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setListStyleFailed')
  })
})

describe('useBlockActionOrchestration listStyle strip-then-merge (#4552 slice 3)', () => {
  it('Backspace at the start of a styled block clears the style instead of merging', async () => {
    const params = styledParams('ordered', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(mockedClearListStyle).toHaveBeenCalledTimes(1)
    expect(mockedClearListStyle).toHaveBeenCalledWith('B')
    expect(params.rovingEditor.updateListMarker).toHaveBeenCalledWith('none', undefined)
    expect(params.mergeInto).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
  })

  it('the second Backspace merges into the previous block', async () => {
    const params = styledParams('ordered', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
      await result.current.handleMergeWithPrev()
    })

    expect(mockedClearListStyle).toHaveBeenCalledTimes(1)
    expect(params.mergeInto).toHaveBeenCalledWith('B', 'A', 'AlphaBeta', { baseText: 'Alpha' })
    expect(params.setFocused).toHaveBeenCalledWith('A')
  })

  it('the first block of the page can leave a list too', async () => {
    const params = styledParams('bullet', 'Alpha')
    params.focusedBlockId = 'A'
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(mockedClearListStyle).toHaveBeenCalledWith('A')
  })

  it('Backspace on an EMPTY styled block clears the style instead of deleting it', async () => {
    const params = styledParams('ordered', '')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      await Promise.resolve()
    })

    expect(mockedClearListStyle).toHaveBeenCalledWith('B')
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
  })

  it('an empty styled sole block leaves the list without the last-block toast', async () => {
    const params = styledParams('bullet', '')
    params.collapsedVisible = mountScoped([makeBlock({ id: 'B', depth: 0, content: '' })])
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
      await Promise.resolve()
    })

    expect(mockedClearListStyle).toHaveBeenCalledWith('B')
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('a failed clear logs and toasts', async () => {
    const failure = new Error('ipc failed')
    mockedClearListStyle.mockRejectedValueOnce(failure)
    const params = styledParams('ordered', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'useBlockActionOrchestration',
      'clearListStyle failed',
      { blockId: 'B' },
      failure,
    )
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.clearListStyleFailed')
  })
})
