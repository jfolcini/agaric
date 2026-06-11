/**
 * #752 — BlockTree × DnD wiring fixes:
 *
 * 1. `DndContext` must receive `autoScroll={false}`: `useBlockDnD` already
 *    runs the custom `useAutoScrollOnDrag` RAF loop, so dnd-kit's built-in
 *    edge auto-scroll would scroll ON TOP of it (additive jank) — and the
 *    built-in ignores `prefers-reduced-motion`, defeating the custom loop's
 *    opt-out.
 * 2. The drag-overlay count badge must be computed over the FULL `blocks`
 *    list, not `collapsedVisible`: dragging a COLLAPSED parent moves its
 *    whole subtree, but its children are filtered out of `collapsedVisible`,
 *    so the badge showed "1" while 3 blocks moved.
 */

import { invoke } from '@tauri-apps/api/core'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'

import type { FlatBlock } from '@/lib/tree-utils'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

// ── Capture DndContext props (autoScroll assertion) ───────────────────────
let capturedDndContextProps: Record<string, unknown> | undefined

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props: { children?: React.ReactNode }) => {
    capturedDndContextProps = props
    return <div>{props.children}</div>
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  MeasuringStrategy: { Always: 'always', WhileDragging: 'whileDragging' },
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

// ── Capture the overlay count badge value ─────────────────────────────────
let capturedOverlayCount: number | undefined

vi.mock('@/components/block-tree/BlockDndOverlay', () => ({
  BlockDndOverlay: ({ count }: { count?: number }) => {
    capturedOverlayCount = count
    return null
  },
}))

// ── Controllable DnD state (stable return identities, as in
// BlockTree.zoom-dnd.test.tsx) ─────────────────────────────────────────────
let mockDnDActiveId: string | null = null

const stableDnDReturn = {
  overId: null,
  projected: null,
  sensors: [],
  handleDragStart: vi.fn(),
  handleDragMove: vi.fn(),
  handleDragOver: vi.fn(),
  handleDragEnd: vi.fn(),
  handleDragCancel: vi.fn(),
}

vi.mock('@/hooks/useBlockDnD', () => ({
  useBlockDnD: (params: { collapsedVisible: FlatBlock[] }) => ({
    ...stableDnDReturn,
    activeId: mockDnDActiveId,
    visibleItems: params.collapsedVisible,
  }),
}))

// ── Editor + row stubs (same shape as BlockTree.test.tsx) ─────────────────
vi.mock('@/editor/use-roving-editor', () => ({
  useRovingEditor: () => ({
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
  }),
}))

vi.mock('../SortableBlock', () => ({
  SortableBlock: ({ blockId }: { blockId: string }) => <div data-testid={`row-${blockId}`} />,
  INDENT_WIDTH: 24,
}))

import { emptyPage, makeBlock } from '@/__tests__/fixtures'
import { BlockTree } from '@/components/editor/BlockTree'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

/** A (collapsed parent) → B → C subtree plus a top-level sibling E. */
const subtreeBlocks: FlatBlock[] = [
  makeBlock({ id: 'A', depth: 0, parent_id: 'PAGE_1', content: 'parent' }),
  makeBlock({ id: 'B', depth: 1, parent_id: 'A', content: 'child' }),
  makeBlock({ id: 'C', depth: 2, parent_id: 'B', content: 'grandchild' }),
  makeBlock({ id: 'E', depth: 0, parent_id: 'PAGE_1', content: 'sibling' }),
]

function renderBlockTree() {
  return render(
    <PageBlockContext.Provider value={pageStore}>
      <BlockTree autoCreateFirstBlock={false} />
    </PageBlockContext.Provider>,
  )
}

beforeEach(() => {
  capturedDndContextProps = undefined
  capturedOverlayCount = undefined
  mockDnDActiveId = null
  localStorage.clear()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    // Reject the mount-time load so the seeded `pageStore.blocks` survive.
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    if (cmd === 'list_all_pages_in_space') return []
    return emptyPage
  })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: subtreeBlocks, loading: false })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('BlockTree DndContext auto-scroll (#752)', () => {
  it('disables dnd-kit built-in auto-scroll (custom useAutoScrollOnDrag loop owns it)', () => {
    renderBlockTree()
    expect(capturedDndContextProps).toBeDefined()
    expect(capturedDndContextProps?.['autoScroll']).toBe(false)
  })
})

describe('BlockTree drag-overlay subtree count (#752)', () => {
  it('counts the full subtree when dragging a COLLAPSED parent', () => {
    // Collapse A so B and C are filtered out of `collapsedVisible`.
    localStorage.setItem('collapsed_ids:PAGE_1', JSON.stringify(['A']))
    mockDnDActiveId = 'A'

    renderBlockTree()

    // A + B + C move together — pre-#752 this read `collapsedVisible` and
    // reported 1 because the collapsed children were filtered out.
    expect(capturedOverlayCount).toBe(3)
  })

  it('counts the active block alone when it has no descendants', () => {
    mockDnDActiveId = 'E'

    renderBlockTree()

    expect(capturedOverlayCount).toBe(1)
  })

  it('has no a11y violations', async () => {
    const { container } = renderBlockTree()
    expect(await axe(container)).toHaveNoViolations()
  })
})
