/**
 * #712 — BlockTree × zoom × DnD wiring.
 *
 * `useBlockZoom.zoomedVisible` rebases `depth` to 0 at the zoomed block's
 * children but keeps real `parent_id`s. `getProjection` resolves any depth-0
 * drop to the root it is given, so BlockTree MUST pass the zoomed block id
 * (not the page root) as the DnD drop root while a zoom is active — otherwise
 * every in-place reorder inside the zoom looks like a reparent to the page
 * root and the block is ejected out of the zoomed subtree.
 *
 * The drop-math itself is covered by `src/lib/__tests__/dnd-pipeline.test.ts`
 * ("zoomed view (#712)"); this file pins the wiring: the `rootParentId` that
 * BlockTree hands to `useBlockDnD` is `zoomedBlockId ?? rootParentId`.
 */

import { invoke } from '@tauri-apps/api/core'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'

import type { FlatBlock } from '@/lib/tree-utils'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

// ── Capture useBlockDnD params (stable return identities — BlockTree's
// effects list them as deps, fresh fns each render would loop) ────────────
let capturedDnDParams: { rootParentId: string | null; collapsedVisible: FlatBlock[] } | undefined

const stableDnDReturn = {
  activeId: null,
  overId: null,
  projected: null,
  visibleItems: [] as FlatBlock[],
  sensors: [],
  handleDragStart: vi.fn(),
  handleDragMove: vi.fn(),
  handleDragOver: vi.fn(),
  handleDragEnd: vi.fn(),
  handleDragCancel: vi.fn(),
}

vi.mock('@/hooks/useBlockDnD', () => ({
  useBlockDnD: (params: { rootParentId: string | null; collapsedVisible: FlatBlock[] }) => {
    capturedDnDParams = params
    return { ...stableDnDReturn, visibleItems: params.collapsedVisible }
  },
}))

// ── Controllable zoom state (stable callbacks for the same reason) ────────
let mockZoomedBlockId: string | null = null

const stableZoomIn = vi.fn()
const stableZoomOut = vi.fn()
const stableZoomToRoot = vi.fn()

vi.mock('@/hooks/useBlockZoom', () => ({
  useBlockZoom: (_blocks: FlatBlock[], collapseVisible: FlatBlock[]) => ({
    zoomedBlockId: mockZoomedBlockId,
    zoomIn: stableZoomIn,
    zoomOut: stableZoomOut,
    zoomToRoot: stableZoomToRoot,
    breadcrumbs: [],
    zoomedVisible: collapseVisible,
  }),
}))

// ── Editor + dnd-kit stubs (same shape as BlockTree.test.tsx) ─────────────
vi.mock('@/editor/use-roving-editor', () => ({
  useRovingEditor: () => ({
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
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
  MeasuringStrategy: { Always: 'always' },
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock('../SortableBlock', () => ({
  SortableBlock: ({ blockId }: { blockId: string }) => <div data-testid={`row-${blockId}`} />,
  INDENT_WIDTH: 24,
}))

import { emptyPage } from '@/__tests__/fixtures'
import { BlockTree } from '@/components/editor/BlockTree'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>

function renderBlockTree() {
  return render(
    <PageBlockContext.Provider value={pageStore}>
      <BlockTree autoCreateFirstBlock={false} />
    </PageBlockContext.Provider>,
  )
}

beforeEach(() => {
  capturedDnDParams = undefined
  mockZoomedBlockId = null
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    if (cmd === 'list_all_pages_in_space') return []
    return emptyPage
  })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [], loading: false })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('BlockTree zoom × DnD drop-root wiring (#712)', () => {
  it('passes the page rootParentId as the drop root when not zoomed', () => {
    renderBlockTree()
    expect(capturedDnDParams).toBeDefined()
    expect(capturedDnDParams?.rootParentId).toBe('PAGE_1')
  })

  it('passes the ZOOMED block id as the drop root when a zoom is active', () => {
    mockZoomedBlockId = 'ZOOMED_BLOCK'
    renderBlockTree()
    expect(capturedDnDParams).toBeDefined()
    // Pre-#712 this was the page root ('PAGE_1'), which made getProjection
    // resolve every depth-0 drop inside the zoom to the page root → ejection.
    expect(capturedDnDParams?.rootParentId).toBe('ZOOMED_BLOCK')
  })

  it('has no a11y violations', async () => {
    const { container } = renderBlockTree()
    expect(await axe(container)).toHaveNoViolations()
  })
})
