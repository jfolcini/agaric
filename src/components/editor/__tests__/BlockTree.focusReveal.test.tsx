/**
 * #3881 — adversarial-review finding 2 on #3276: the BlockTree wiring effect
 * (`BlockTree.tsx`, "#3276: reveal a navigation target hidden by collapse or
 * the mount cap") that calls `expandAncestors`/`revealIndex` when
 * `focusedBlockId` changes had ZERO integration coverage. The unit tests for
 * `useBlockCollapse`/`useBlockMountLimit` exercise those hooks in isolation,
 * and `PageEditor.test.tsx` mocks `BlockTree` to a plain div — so nothing
 * drove the actual wiring. Disabling either call in the effect body left all
 * other suites green.
 *
 * This file renders the REAL `BlockTree` (only `SortableBlock` is mocked, to
 * a lightweight row, mirroring `BlockTree.mount-envelope.test.tsx`) with a
 * block that is BOTH collapsed under an ancestor AND past the mount cap, and
 * asserts the row actually mounts once it becomes focused.
 *
 * #4038 adds two more cases that only exist at this level, because both are
 * about the ORDER in which the wiring runs, not about any one hook: a zoom
 * pane surviving the release of the reveal that opened its way in, and a
 * user's collapse of an ancestor of the focused block surviving the same
 * effect's re-run.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { INITIAL_MOUNT_LIMIT } from '@/components/block-tree/use-block-mount-limit'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import type { FlatBlock } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

// The row mock pulls its affordances out of `useBlockActions()`, exactly as
// the production `SortableBlock` does (same shape as `BlockTree.test.tsx`'s
// mock), so the collapse-chevron and zoom-in tests below drive the REAL
// wiring — `toggleCollapse` through `beforeCollapse`, and `handleZoomIn`
// through `expandBlock` + `rawZoomIn` — rather than poking hook state.
vi.mock('@/components/editor/SortableBlock', async () => {
  const { useBlockActions } = await import('@/components/block-tree/use-block-actions')
  return {
    SortableBlock: (props: { blockId: string; hasChildren?: boolean }) => {
      const actions = useBlockActions()
      const onToggleCollapse = actions.onToggleCollapse
      // Ungated on purpose: the CONTEXT-MENU zoom affordance is gated on
      // hasChildren, but #922 dropped that gate from keyboard zoom-in, so a
      // leaf can be zoomed. This button stands in for both entry points.
      const onZoomIn = actions.onZoomIn
      return (
        <div data-testid={`sortable-block-${props.blockId}`}>
          SortableBlock
          {props.hasChildren && onToggleCollapse && (
            <button
              data-testid={`toggle-${props.blockId}`}
              onClick={() => onToggleCollapse(props.blockId)}
              type="button"
            >
              Toggle
            </button>
          )}
          {onZoomIn && (
            <button
              data-testid={`zoom-in-${props.blockId}`}
              onClick={() => onZoomIn(props.blockId)}
              type="button"
            >
              Zoom
            </button>
          )}
        </div>
      )
    },
    INDENT_WIDTH: 24,
  }
})

vi.mock('@/editor/use-roving-editor', () => ({
  useRovingEditor: () => ({
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    getMarkdown: vi.fn(() => null),
    activeBlockId: null,
  }),
}))

vi.mock('@/editor/use-block-keyboard', () => ({
  useBlockKeyboard: () => {},
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/hooks/useViewportObserver', () => ({
  useViewportObserver: () => ({
    isOffscreen: () => false,
    createObserveRef: () => vi.fn(),
    getHeight: () => 40,
    subscribe: () => () => {},
    subscribeWindow: () => () => {},
    getWindowVersion: () => 0,
  }),
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  MeasuringStrategy: { Always: 'always', WhileDragging: 'while-dragging' },
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

import { BlockTree } from '@/components/editor/BlockTree'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

function renderBlockTree(
  props: { onRevealSettled?: (blockId: string, found: boolean) => void } = {},
) {
  return render(
    <PageBlockContext.Provider value={pageStore}>
      <BlockTree autoCreateFirstBlock={false} onRevealSettled={props.onRevealSettled} />
    </PageBlockContext.Provider>,
  )
}

function makeFlatBlocks(count: number): FlatBlock[] {
  return Array.from({ length: count }, (_, i) => makeBlock({ id: `BLK_${i}`, content: `b${i}` }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    return []
  })
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('collapsed_ids')) localStorage.removeItem(key)
    }
  } catch {
    // jsdom localStorage may not be available
  }
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [], loading: false })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('BlockTree reveals a focused target hidden by collapse + the mount cap (#3276 gap 2)', () => {
  it('mounts a block that is both collapsed under an ancestor and past the mount cap once it is focused', async () => {
    // `ROOT` sits exactly at the mount cap boundary (index INITIAL_MOUNT_LIMIT)
    // and starts COLLAPSED, so `TARGET` (its child) is doubly hidden: not in
    // the collapse-filtered visible list at all, and — once expanded — still
    // past the mount cap.
    const filler = makeFlatBlocks(INITIAL_MOUNT_LIMIT)
    const root = makeBlock({ id: 'ROOT', content: 'root', depth: 0 })
    const target = makeBlock({ id: 'TARGET', content: 'target', parent_id: 'ROOT', depth: 1 })
    writePreference(PREFERENCES.blockCollapse, ['ROOT'], 'PAGE_1')
    pageStore.setState({ blocks: [...filler, root, target], loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    // Confirms the premise: neither ROOT nor TARGET is mounted yet.
    expect(screen.queryByTestId('sortable-block-ROOT')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sortable-block-TARGET')).not.toBeInTheDocument()

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'TARGET' })
    })

    // The ancestor was expanded (expandAncestors) AND the mount cap was
    // raised past TARGET's position (revealIndex) — both rows now mount.
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-TARGET')).toBeInTheDocument()
    })
    expect(screen.getByTestId('sortable-block-ROOT')).toBeInTheDocument()

    // #4002 — the reveal is EPHEMERAL: the row above is mounted, but the
    // user's saved layout still has ROOT collapsed. Before the fix this read
    // back `[]` — one backlink click silently deleted the arrangement, with no
    // undo and across reloads.
    expect(readPreference(PREFERENCES.blockCollapse, 'PAGE_1')).toEqual(['ROOT'])
  })

  // #4002 — the reveal is released by the next focus move, which is why the
  // wiring effect calls `expandAncestors` BEFORE its "already mounted" bail.
  // Keeping the call behind that bail would leave the previous target's
  // ancestors expanded on screen indefinitely.
  it('re-collapses the revealed ancestor once focus moves out of the subtree', async () => {
    const filler = makeFlatBlocks(INITIAL_MOUNT_LIMIT)
    const root = makeBlock({ id: 'ROOT', content: 'root', depth: 0 })
    const target = makeBlock({ id: 'TARGET', content: 'target', parent_id: 'ROOT', depth: 1 })
    writePreference(PREFERENCES.blockCollapse, ['ROOT'], 'PAGE_1')
    pageStore.setState({ blocks: [...filler, root, target], loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'TARGET' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-TARGET')).toBeInTheDocument()
    })

    // Focus leaves for a block outside the revealed subtree (already mounted,
    // so nothing else about the projection has to change).
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'BLK_0' })
    })

    await waitFor(() => {
      expect(screen.queryByTestId('sortable-block-TARGET')).not.toBeInTheDocument()
    })
    // ROOT itself stays mounted — it is collapsed again, not hidden.
    expect(screen.getByTestId('sortable-block-ROOT')).toBeInTheDocument()
    expect(readPreference(PREFERENCES.blockCollapse, 'PAGE_1')).toEqual(['ROOT'])
  })
})

/** Let queued effects/state cascades settle without racing an assertion. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

// #4011 — `onRevealSettled` reports the two DECIDABLE end states of the
// reveal effect above directly, instead of leaving a caller (`PageEditor`) to
// infer them from elapsed frames. Both arms are proven here against the REAL
// effect, not a stub of it.
describe('BlockTree reports reveal completion via onRevealSettled (#4011)', () => {
  it('reports found: true once — and only once the row is actually mounted', async () => {
    const filler = makeFlatBlocks(INITIAL_MOUNT_LIMIT)
    const root = makeBlock({ id: 'ROOT', content: 'root', depth: 0 })
    const target = makeBlock({ id: 'TARGET', content: 'target', parent_id: 'ROOT', depth: 1 })
    writePreference(PREFERENCES.blockCollapse, ['ROOT'], 'PAGE_1')
    pageStore.setState({ blocks: [...filler, root, target], loading: false })

    const onRevealSettled = vi.fn()
    renderBlockTree({ onRevealSettled })
    await screen.findByTestId('block-tree-mount-boundary')
    expect(onRevealSettled).not.toHaveBeenCalled()

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'TARGET' })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-TARGET')).toBeInTheDocument()
    })

    // The row is doubly hidden (collapsed ancestor PAST the mount cap), so
    // this genuinely takes more than one commit to converge — proving the
    // callback fires from the SETTLED state, not merely once, on the first
    // render.
    expect(onRevealSettled).toHaveBeenLastCalledWith('TARGET', true)
    // Never told the caller the target was unreachable along the way.
    expect(onRevealSettled).not.toHaveBeenCalledWith('TARGET', false)
  })

  it('reports found: false once the target turns out to be outside the active zoom pane', async () => {
    // ZOOM is a normal, uncollapsed child of ANC — nothing here is hidden by
    // collapse or the mount cap. OUT sits at the page root, outside the pane
    // zooming into ZOOM opens, which is the one case the reveal effect's own
    // comment documents it cannot address (BlockTree.tsx, "#3276").
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'ANC', content: 'ancestor', depth: 0 }),
        makeBlock({ id: 'ZOOM', content: 'zoom root', parent_id: 'ANC', depth: 1 }),
        makeBlock({ id: 'KID', content: 'kid', parent_id: 'ZOOM', depth: 2 }),
        makeBlock({ id: 'OUT', content: 'outside', depth: 0 }),
      ],
      loading: false,
    })

    const onRevealSettled = vi.fn()
    renderBlockTree({ onRevealSettled })
    await screen.findByTestId('sortable-block-ZOOM')

    fireEvent.click(screen.getByTestId('zoom-in-ZOOM'))
    await settle()
    expect(screen.getByTestId('sortable-block-KID')).toBeInTheDocument()
    // Confirms the premise: OUT really is excluded from the active pane.
    expect(screen.queryByTestId('sortable-block-OUT')).not.toBeInTheDocument()

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'OUT' })
    })
    await settle()

    expect(onRevealSettled).toHaveBeenCalledWith('OUT', false)
    expect(onRevealSettled).not.toHaveBeenCalledWith('OUT', true)
  })
})

// #4038 note 1 — the release of a transient reveal used to empty an OPEN zoom
// pane. Reproducing it requires the real ordering (reveal → zoom → focus
// leaves the pane); constructing the end state directly is green against the
// broken code, because the pane is only empty when it was populated first.
describe('a zoom pane survives the release of the reveal that opened it (#4038)', () => {
  const tree = (): FlatBlock[] => [
    makeBlock({ id: 'ANC', content: 'ancestor', depth: 0 }),
    makeBlock({ id: 'ZOOM', content: 'zoom root', parent_id: 'ANC', depth: 1 }),
    makeBlock({ id: 'KID', content: 'kid', parent_id: 'ZOOM', depth: 2 }),
    makeBlock({ id: 'OUT', content: 'outside', depth: 0 }),
  ]

  it('keeps the pane populated when focus moves to a block outside it', async () => {
    // ANC is collapsed in the SAVED layout, so ZOOM (and KID under it) are
    // reachable only through the transient reveal.
    writePreference(PREFERENCES.blockCollapse, ['ANC'], 'PAGE_1')
    pageStore.setState({ blocks: tree(), loading: false })

    renderBlockTree()
    // ANC renders (collapsed); ZOOM under it does not.
    await screen.findByTestId('sortable-block-ANC')
    expect(screen.queryByTestId('sortable-block-ZOOM')).not.toBeInTheDocument()

    // 1. Navigate into the collapsed subtree (backlink / search hit).
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'ZOOM' })
    })
    await screen.findByTestId('sortable-block-ZOOM')

    // 2. Zoom into the revealed descendant.
    fireEvent.click(screen.getByTestId('zoom-in-ZOOM'))
    await settle()
    expect(screen.getByTestId('sortable-block-KID')).toBeInTheDocument()
    // Really zoomed: the page-root rows are gone from the projection.
    expect(screen.queryByTestId('sortable-block-OUT')).not.toBeInTheDocument()

    // 3. Focus moves OUT of the pane — `PageEditor` calls `setFocused` for a
    //    same-page search hit or backlink without consulting the zoom. The
    //    reveal is recomputed against that target, so ANC re-collapses.
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'OUT' })
    })
    await settle()

    // Before #4038, KID had left the page-wide collapse-filtered list with
    // ANC, and the pane rendered `[]` under its breadcrumbs.
    expect(screen.getByTestId('sortable-block-KID')).toBeInTheDocument()
    // Still ephemeral: the saved layout is untouched throughout.
    expect(readPreference(PREFERENCES.blockCollapse, 'PAGE_1')).toEqual(['ANC'])
  })

  it('still renders an empty pane for a genuinely childless zoom root', async () => {
    // The other arm: the fix must not "work" by refusing to filter. KID is a
    // leaf, so zooming into it shows nothing — and the seed effect is off
    // here (`autoCreateFirstBlock={false}`), so nothing fills it in.
    pageStore.setState({ blocks: tree(), loading: false })

    renderBlockTree()
    await screen.findByTestId('sortable-block-ZOOM')

    fireEvent.click(screen.getByTestId('zoom-in-ZOOM'))
    await settle()
    expect(screen.getByTestId('sortable-block-KID')).toBeInTheDocument()

    // Zoom one level deeper, into the leaf.
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'KID' })
    })
    fireEvent.click(screen.getByTestId('zoom-in-KID'))
    await settle()

    expect(screen.queryByTestId('sortable-block-KID')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sortable-block-ZOOM')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sortable-block-OUT')).not.toBeInTheDocument()
  })
})

// #4038 note 4 — pins the coupling documented at the reveal effect in
// `BlockTree.tsx`: the effect re-runs when the user collapses something
// (`mountedVisible` changes identity), and the ONLY reason it does not
// immediately re-reveal what they just closed is that `beforeCollapse`
// clears `focusedBlockId` first, so the effect bails at its guard. Delete
// that `setFocused(null)` and this test goes red — the ancestor becomes
// uncollapsable while one of its descendants holds focus.
describe('collapsing an ancestor of the focused block sticks (#4038)', () => {
  it('stays collapsed instead of being re-revealed by the focus-reveal effect', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'ANC', content: 'ancestor', depth: 0 }),
        makeBlock({ id: 'KID', content: 'kid', parent_id: 'ANC', depth: 1 }),
        makeBlock({ id: 'OUT', content: 'outside', depth: 0 }),
      ],
      loading: false,
    })

    renderBlockTree()
    await screen.findByTestId('sortable-block-KID')

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'KID' })
    })
    await settle()
    expect(screen.getByTestId('sortable-block-KID')).toBeInTheDocument()

    // The user collapses the ancestor of the block they are editing.
    fireEvent.click(screen.getByTestId('toggle-ANC'))
    await settle()

    expect(screen.queryByTestId('sortable-block-KID')).not.toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-ANC')).toBeInTheDocument()
    expect(readPreference(PREFERENCES.blockCollapse, 'PAGE_1')).toEqual(['ANC'])
    // The mechanism, asserted so a future change to the rescue is visibly the
    // thing that broke it: the collapsing subtree contained the focused block,
    // so `beforeCollapse` flushed and released focus.
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })
})
