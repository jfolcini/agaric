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
import type { ListStyle } from '@/lib/list-style'
import { clearListStyle, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import type { FlatBlock } from '@/lib/tree-utils'
import type { MountedBlocks } from '@/lib/zoom-scope'
import { createPageBlockStore } from '@/stores/page-blocks'

vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))
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
    // #1342 — full flat tree (default mirrors collapsedVisible; merge tests
    // that exercise reparenting override this with a tree that has children).
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
      splitAtCaret: vi.fn(() => null as { before: string; after: string } | null),
    },
    setFocused: vi.fn(),
    handleFlush: vi.fn(() => null as string | null),
    pageStore,
    remove: vi.fn(async () => {}),
    moveBlocks: vi.fn(async () => {}),
    edit: vi.fn(async () => true),
    indent: vi.fn(async () => true),
    dedent: vi.fn(async () => true),
    moveUp: vi.fn(async () => true),
    moveDown: vi.fn(async () => true),
    createBelow: vi.fn(async () => 'NEW_1' as string | null),
    justCreatedBlockIds: { current: new Set<string>() },
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

    expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
    expect(params.remove).toHaveBeenCalledWith('B')
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
    expect(params.edit).toHaveBeenCalledWith('A', 'foobar')
    const merged = vi.mocked(params.edit).mock.calls[0]?.[1] as string
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

    expect(params.edit).toHaveBeenCalledWith('A', 'fooh')
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

    expect(params.edit).toHaveBeenCalledWith('A', 'foobar')
  })

  it('does nothing when at first block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('re-mounts editor on merge failure', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => {
      throw new Error('fail')
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('reverts edit when remove fails after successful edit', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => true)
    params.remove = vi.fn(async () => {
      throw new Error('remove failed')
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledTimes(2)
    expect(params.edit).toHaveBeenNthCalledWith(1, 'A', 'AlphaBeta')
    expect(params.edit).toHaveBeenNthCalledWith(2, 'A', 'Alpha')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('does not revert when edit itself fails', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => {
      throw new Error('edit failed')
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------------
  // #1342 — Backspace-merge of a block that HAS CHILDREN must reparent the
  // children onto the merge target before the source is removed, instead of
  // letting the backend's delete cascade soft-delete the whole subtree.
  // ------------------------------------------------------------------------
  describe('reparents children on merge (#1342)', () => {
    it('reparents an expanded parent’s children onto the merge target before remove', async () => {
      const params = makeDefaultParams()
      // Source B (focused, expanded) has two children B1, B2; merge target A
      // (the previous VISIBLE block) already has one child A1, which is the
      // last visible row before B — so the children append AFTER it (slot 1).
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

      const callOrder: string[] = []
      params.moveBlocks = vi.fn(async () => {
        callOrder.push('moveBlocks')
      })
      params.remove = vi.fn(async () => {
        callOrder.push('remove')
      })

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      // The previous VISIBLE block before B is A1, so the text merges there
      // and B's children reparent onto A1 (which has no children yet → slot 0).
      expect(params.edit).toHaveBeenCalledWith('A1', 'A-oneBeta')
      expect(params.moveBlocks).toHaveBeenCalledWith(['B1', 'B2'], 'A1', 0)
      // Reparent happens BEFORE the source block is removed (so the cascade
      // cannot soft-delete the now-moved subtree).
      expect(callOrder).toEqual(['moveBlocks', 'remove'])
      expect(params.remove).toHaveBeenCalledWith('B')
      expect(params.setFocused).toHaveBeenCalledWith('A1')
    })

    it('appends after the merge target’s existing children (slot = child count)', async () => {
      const params = makeDefaultParams()
      // Merge target A already has one direct child A1 (collapsed away), so B's
      // children land at slot 1 — after A1 — preserving the survivor's tail.
      params.blocks = [
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'A1', depth: 1, content: 'A-one', parent_id: 'A' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
        makeBlock({ id: 'B1', depth: 1, content: 'B-one', parent_id: 'B' }),
      ]
      params.collapsedVisible = mountScoped([
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: 'Beta' }),
      ])
      params.focusedBlockId = 'B'
      params.rovingEditor.unmount = vi.fn(() => 'Beta')

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
      expect(params.moveBlocks).toHaveBeenCalledWith(['B1'], 'A', 1)
    })

    it('reparents the children of a COLLAPSED parent (hidden from the visible projection)', async () => {
      const params = makeDefaultParams()
      // B is collapsed: its children are absent from collapsedVisible but
      // present in the full flat tree. The reparent must still find them.
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
      params.rovingEditor.unmount = vi.fn(() => 'Beta')

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      // A has no children, so the run lands at slot 0.
      expect(params.moveBlocks).toHaveBeenCalledWith(['B1', 'B2'], 'A', 0)
      expect(params.remove).toHaveBeenCalledWith('B')
    })

    it('does NOT reparent when the merged-away block is childless', async () => {
      const params = makeDefaultParams()
      params.rovingEditor.unmount = vi.fn(() => 'Beta')
      const { result } = renderHook(() => useBlockActionOrchestration(params))

      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      expect(params.moveBlocks).not.toHaveBeenCalled()
      expect(params.remove).toHaveBeenCalledWith('B')
    })

    it('aborts the merge (reverts edit, does not remove) when the reparent fails', async () => {
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
      params.moveBlocks = vi.fn(async () => {
        throw new Error('reparent failed')
      })

      const { result } = renderHook(() => useBlockActionOrchestration(params))
      await act(async () => {
        await result.current.handleMergeWithPrev()
      })

      // Edit committed then reverted; the source is NOT removed (children safe).
      expect(params.edit).toHaveBeenNthCalledWith(1, 'A', 'AlphaBeta')
      expect(params.edit).toHaveBeenNthCalledWith(2, 'A', 'Alpha')
      expect(params.remove).not.toHaveBeenCalled()
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
    })

    it('handleMergeById reparents the merged-away block’s children too', async () => {
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

      expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
      expect(params.moveBlocks).toHaveBeenCalledWith(['B1', 'B2'], 'A', 0)
      expect(params.remove).toHaveBeenCalledWith('B')
    })
  })

  // ------------------------------------------------------------------------
  // Post-merge setTimeout(setTextSelection) must be cancelled on
  // unmount to avoid moving the cursor on a stale (next-mounted) editor.
  // ------------------------------------------------------------------------
  describe('post-merge setTimeout cleanup (#)', () => {
    it('does not call setTextSelection after hook unmount', async () => {
      vi.useFakeTimers()
      try {
        const setTextSelection = vi.fn()
        const fakeEditor = {
          state: { doc: { content: { size: 20 } } },
          commands: { setTextSelection },
        } as unknown as NonNullable<
          Parameters<typeof useBlockActionOrchestration>[0]['rovingEditor']['editor']
        >

        const params = makeDefaultParams()
        params.rovingEditor.unmount = vi.fn(() => 'Beta')
        // Expose a live editor so the post-merge callback *would* have
        // something to act on — but we unmount before it fires.
        ;(params.rovingEditor as { editor: unknown }).editor = fakeEditor

        const { result, unmount } = renderHook(() => useBlockActionOrchestration(params))

        await act(async () => {
          await result.current.handleMergeWithPrev()
        })

        // Merge has run; setTextSelection is still queued on the 0ms timer.
        expect(setTextSelection).not.toHaveBeenCalled()

        // Unmount the hook — cleanup must clear the pending timer.
        unmount()

        // Advance past the timer; must not throw and must not call
        // setTextSelection on the (now-stale) editor.
        expect(() => vi.advanceTimersByTime(10)).not.toThrow()
        expect(setTextSelection).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('calls setTextSelection when the timer fires before unmount', async () => {
      vi.useFakeTimers()
      try {
        const setTextSelection = vi.fn()
        const fakeEditor = {
          state: { doc: { content: { size: 20 } } },
          commands: { setTextSelection },
        } as unknown as NonNullable<
          Parameters<typeof useBlockActionOrchestration>[0]['rovingEditor']['editor']
        >

        const params = makeDefaultParams()
        params.rovingEditor.unmount = vi.fn(() => 'Beta')
        ;(params.rovingEditor as { editor: unknown }).editor = fakeEditor

        const { result } = renderHook(() => useBlockActionOrchestration(params))

        await act(async () => {
          await result.current.handleMergeWithPrev()
        })

        // Flush the timer while the hook is still mounted — setTextSelection
        // should run exactly once with the computed PM position.
        act(() => {
          vi.advanceTimersByTime(10)
        })

        expect(setTextSelection).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    // ----------------------------------------------------------------------
    // #976 f22: if the user arrow-navigates before the 0ms post-merge timer
    // fires, the roving editor has remounted onto a DIFFERENT block. The
    // deferred setTextSelection must be a no-op so the caret is never placed
    // in the wrong block. The guard keys on `activeBlockId === <merge target>`.
    // ----------------------------------------------------------------------
    it('does NOT call setTextSelection when focus moved to another block before the timer fires', async () => {
      vi.useFakeTimers()
      try {
        const setTextSelection = vi.fn()
        const fakeEditor = {
          state: { doc: { content: { size: 20 } } },
          commands: { setTextSelection },
        } as unknown as NonNullable<
          Parameters<typeof useBlockActionOrchestration>[0]['rovingEditor']['editor']
        >

        const params = makeDefaultParams()
        params.rovingEditor.unmount = vi.fn(() => 'Beta')
        ;(params.rovingEditor as { editor: unknown }).editor = fakeEditor

        const { result } = renderHook(() => useBlockActionOrchestration(params))

        await act(async () => {
          // Merge 'B' into 'A' — the post-merge mount sets activeBlockId = 'A'
          // and the deferred caret targets 'A'.
          await result.current.handleMergeWithPrev()
        })

        // Simulate an arrow-navigation that remounts the editor onto a DIFFERENT
        // block before the queued 0ms timer runs — exactly the race the guard
        // protects against (handleFocusNext/Prev would do this).
        act(() => {
          result.current.handleFocusNext()
        })
        expect(params.rovingEditor.activeBlockId).toBe('C')

        // Flush the queued timer. Because activeBlockId ('C') no longer matches
        // the merge target ('A'), the cursor placement must be skipped.
        act(() => {
          vi.advanceTimersByTime(10)
        })

        expect(setTextSelection).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Store failure CONTRACT: pageStore.edit() RESOLVES `false` on failure (it
// rolls back its optimistic write and toasts internally) — it NEVER rejects.
// The throwing-edit mocks elsewhere in this file pin the defensive catch, but
// the boolean is the only failure signal production ever emits; ignoring it
// let a failed merge-edit fall through to remove() and permanently delete the
// source block whose merged content was never saved.
// ---------------------------------------------------------------------------
describe('merge honors edit() resolving false (store contract)', () => {
  it('handleMergeWithPrev does not remove the source block when edit resolves false', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
    // Failure cleanup remounts the source block with its captured content.
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    expect(params.setFocused).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('handleMergeWithPrev skips the reparent step when edit resolves false', async () => {
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
    params.edit = vi.fn(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.moveBlocks).not.toHaveBeenCalled()
    expect(params.remove).not.toHaveBeenCalled()
  })

  it('handleMergeById does not remove the source block when edit resolves false', async () => {
    const params = makeDefaultParams()
    params.edit = vi.fn(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
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
  function deferredEdit() {
    let resolve!: (v: boolean) => void
    const promise = new Promise<boolean>((res) => {
      resolve = res
    })
    return { edit: vi.fn(() => promise), resolve }
  }

  it('handleDeleteBlock is a no-op while a merge is in flight; remove runs exactly once', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredEdit()
    params.edit = deferred.edit
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let mergePromise!: Promise<void>
    act(() => {
      mergePromise = result.current.handleMergeWithPrev()
    })
    // Autorepeat Backspace lands while the merge's edit IPC is pending: the
    // unmounted (now-empty) editor routes it to the Backspace-on-empty rule.
    act(() => {
      result.current.handleDeleteBlock({ cursorPlacement: 'end' })
    })
    expect(params.remove).not.toHaveBeenCalled()

    await act(async () => {
      deferred.resolve(true)
      await mergePromise
    })

    // Only the merge's own remove ran — once, for the merged-away block.
    expect(params.remove).toHaveBeenCalledTimes(1)
    expect(params.remove).toHaveBeenCalledWith('B')
  })

  it('a second handleMergeWithPrev while one is in flight is dropped', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredEdit()
    params.edit = deferred.edit
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleMergeWithPrev()
      second = result.current.handleMergeWithPrev()
    })
    // The merge's edit runs synchronously up to its first await, so a
    // non-guarded second call would have already invoked edit again here.
    expect(params.edit).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferred.resolve(true)
      await Promise.all([first, second])
    })
    expect(params.remove).toHaveBeenCalledTimes(1)
  })

  it('handleEnterSave is a no-op while a merge is in flight', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredEdit()
    params.edit = deferred.edit
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
    expect(params.remove).toHaveBeenCalledTimes(1)
  })

  it('handleMergeById is guarded against an in-flight merge too', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const deferred = deferredEdit()
    params.edit = deferred.edit
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleMergeWithPrev()
      second = result.current.handleMergeById('C')
    })
    expect(params.edit).toHaveBeenCalledTimes(1)

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
    expect(params.edit).not.toHaveBeenCalled()
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

    expect(params.edit).not.toHaveBeenCalled()
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

    expect(params.edit).not.toHaveBeenCalled()
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

    expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
    expect(params.remove).toHaveBeenCalledWith('B')
  })
})

describe('useBlockActionOrchestration handleMergeById', () => {
  it('merges block by id with previous', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledWith('B', 'BetaCharlie')
    expect(params.remove).toHaveBeenCalledWith('C')
    expect(params.setFocused).toHaveBeenCalledWith('B')
  })

  it('does nothing for first block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('A')
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('unmounts editor when merging focused block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    params.rovingEditor.unmount = vi.fn(() => 'Edited Charlie')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled() // no-args by contract
    expect(params.edit).toHaveBeenCalledWith('B', 'BetaEdited Charlie')
  })

  it('reverts edit when remove fails after successful edit', async () => {
    const params = makeDefaultParams()
    params.edit = vi.fn(async () => true)
    params.remove = vi.fn(async () => {
      throw new Error('remove failed')
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledTimes(2)
    expect(params.edit).toHaveBeenNthCalledWith(1, 'B', 'BetaCharlie')
    expect(params.edit).toHaveBeenNthCalledWith(2, 'B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('does not revert when edit itself fails', async () => {
    const params = makeDefaultParams()
    params.edit = vi.fn(async () => {
      throw new Error('edit failed')
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
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
    expect(params.createBelow).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
  })

  it('adds new block to justCreatedBlockIds', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.justCreatedBlockIds.current.has('NEW_1')).toBe(true)
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).not.toHaveBeenCalled()
  })

  it('does not set focused when createBelow returns null', async () => {
    const params = makeDefaultParams()
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('announces block creation on Enter', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('announce.blockCreated')
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
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // The current block keeps the before-caret text…
    expect(params.edit).toHaveBeenCalledWith('B', 'hello')
    // …and the new block is created WITH the after-caret text.
    expect(params.createBelow).toHaveBeenCalledWith('B', 'world')
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
    // The legacy whole-block flush path must NOT run on a mid-text split.
    expect(params.handleFlush).not.toHaveBeenCalled()
  })

  it('split-created block is NOT registered as a just-created empty stub', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // It carries real content, so Escape must not auto-delete it.
    expect(params.justCreatedBlockIds.current.has('NEW_1')).toBe(false)
  })

  it('caret at end (after === "") uses the legacy empty-block path', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: '' }))
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.createBelow).toHaveBeenCalledWith('B')
    expect(params.justCreatedBlockIds.current.has('NEW_1')).toBe(true)
  })

  // Store contract (#730 family): edit() RESOLVES false on failure — it never
  // rejects. Ignoring the boolean let a failed before-caret save fall through
  // to createBelow, forking the content (stale block + orphan after-text).
  it('aborts the split and restores the full content when edit resolves false', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'hello world')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello ', after: 'world' }))
    params.edit = vi.fn(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // The after-text block must NOT be created — the before-save didn't commit.
    expect(params.createBelow).not.toHaveBeenCalled()
    // The user keeps their complete, unsplit text editable.
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'hello world')
    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('restores the original block when a split createBelow fails', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'helloworld')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'helloworld')
    expect(params.setFocused).not.toHaveBeenCalled()
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
    const editOrder = vi.mocked(params.edit).mock.invocationCallOrder[0] ?? -1
    const discardOrder = vi.mocked(params.discardDraft).mock.invocationCallOrder[0] ?? -1
    expect(editOrder).toBeLessThan(discardOrder)
  })

  it('does not discard the draft when the before-caret save fails (block never departed)', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'hello world')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello ', after: 'world' }))
    params.edit = vi.fn(async () => false)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.discardDraft).not.toHaveBeenCalled()
  })

  it('still discards the departed block draft even when createBelow fails post-split', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.getMarkdown = vi.fn(() => 'helloworld')
    params.rovingEditor.splitAtCaret = vi.fn(() => ({ before: 'hello', after: 'world' }))
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    // `split.before` already committed via `edit()` before createBelow ran,
    // so the stale draft row is cleaned up regardless of createBelow's outcome.
    expect(params.discardDraft).toHaveBeenCalledWith('B')
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

describe('useBlockActionOrchestration handleEscapeCancel', () => {
  it('unmounts editor and unfocuses', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'changed content')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled() // no-args by contract
    expect(params.setFocused).toHaveBeenCalledWith(null)
    expect(vi.mocked(toast)).toHaveBeenCalledWith('blockTree.changesDiscarded', { duration: 2000 })
  })

  it('does not show toast when no changes', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.setFocused).toHaveBeenCalledWith(null)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('removes just-created empty block on Escape', () => {
    const emptyB = [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: '' }),
      makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
    ]
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: emptyB,
      // The untouched stub: empty in the STORE too, which is what the removal
      // is gated on (#4577).
      blocks: emptyB,
    })
    params.justCreatedBlockIds.current.add('B')
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.remove).toHaveBeenCalledWith('B')
    expect(params.justCreatedBlockIds.current.has('B')).toBe(false)
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not remove block that was not just created', () => {
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: [
        makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
        makeBlock({ id: 'B', depth: 0, content: '' }),
        makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
      ],
    })
    // B is NOT in justCreatedBlockIds
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not remove just-created block when user has typed content', () => {
    const typedB = [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: 'buy milk' }),
      makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
    ]
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: typedB,
      // #4577 — the typed text is in the STORE (an earlier debounced commit
      // put it there), not only in the unmount delta.
      blocks: typedB,
    })
    params.justCreatedBlockIds.current.add('B')
    // unmount returns non-null → the tail typed since that commit is discarded
    params.rovingEditor.unmount = vi.fn(() => 'buy milk and eggs')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    // Block should NOT be removed because user had typed content
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  // #4577 — the flushing slash commands (`/todo`, `/numbered-list`, `/effort`,
  // …) await `flushActiveDraft()`, whose `commitNow()` calls `markCommitted(md)`
  // and so REBASES the roving editor's delta baseline. `unmount()` then reports
  // null for a block the user filled in. Gating the removal on the unmount delta
  // alone soft-deleted the whole block — text and the property the command had
  // just written.
  it('does not remove a just-created block whose content the flush already committed', () => {
    const committedB = [
      makeBlock({ id: 'A', depth: 0, content: 'Alpha' }),
      makeBlock({ id: 'B', depth: 0, content: 'buy milk' }),
      makeBlock({ id: 'C', depth: 0, content: 'Charlie' }),
    ]
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: committedB,
      blocks: committedB,
    })
    params.justCreatedBlockIds.current.add('B')
    // The flush already committed 'buy milk' and rebased the baseline, so the
    // unmount delta is empty — exactly as it is after `/todo`.
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('calls discardDraft with the focused block ID before unmount', () => {
    const params = makeDefaultParams()
    const callOrder: string[] = []
    params.discardDraft = vi.fn(() => {
      callOrder.push('discardDraft')
    })
    params.rovingEditor.unmount = vi.fn(() => {
      callOrder.push('unmount')
      return 'changed content'
    })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).toHaveBeenCalledWith('B')
    expect(callOrder).toEqual(['discardDraft', 'unmount'])
  })

  it('calls discardDraft even when no changes on Escape', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not call discardDraft when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).not.toHaveBeenCalled()
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

    expect(params.createBelow).toHaveBeenCalledWith('B')
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

    expect(params.edit).toHaveBeenCalledWith('B', 'Be')
    expect(params.createBelow).toHaveBeenCalledWith('B', 'ta')
    expect(mockedSetListStyle).toHaveBeenCalledWith('NEW_1', 'bullet')
  })

  it('Enter on a plain block writes no property', async () => {
    const params = styledParams('none', 'Beta')
    const { result } = renderHook(() => useBlockActionOrchestration(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).toHaveBeenCalledWith('B')
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
    expect(params.edit).not.toHaveBeenCalled()
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
    expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
    expect(params.remove).toHaveBeenCalledWith('B')
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
