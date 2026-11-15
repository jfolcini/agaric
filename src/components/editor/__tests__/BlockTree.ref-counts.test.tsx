/**
 * #6746 — a page's reference counts come in one read, whatever its size, and
 * reach each row through `BlockRefCountsContext`.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import type { PageSubtree } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { useBlockStore } from '@/stores/blocks'
import { PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/SortableBlock', async () => {
  const { useBlockRefCount } = await import('@/hooks/useBlockRefCounts')
  function SortableBlock({ blockId }: { blockId: string }): React.ReactElement {
    return <div data-testid={`sortable-block-${blockId}`}>{useBlockRefCount(blockId)}</div>
  }
  return { SortableBlock, INDENT_WIDTH: 24 }
})

const rovingEditor = {
  editor: null,
  mount: vi.fn(),
  unmount: vi.fn(() => null),
  getMarkdown: vi.fn(() => null),
  activeBlockId: null,
}
vi.mock('@/editor/use-roving-editor', () => ({
  useRovingEditor: () => rovingEditor,
}))
vi.mock('@/editor/use-block-keyboard', () => ({
  useBlockKeyboard: vi.fn(),
  INERT_BLOCK_KEYBOARD_CALLBACKS: {},
}))
const viewport = {
  isOffscreen: () => false,
  createObserveRef: () => vi.fn(),
  getHeight: () => 40,
  subscribe: () => () => {},
  subscribeWindow: () => () => {},
  getWindowVersion: () => 0,
}
vi.mock('@/hooks/useViewportObserver', () => ({
  useViewportObserver: () => viewport,
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

function subtreeOf(pageId: string, count: number): PageSubtree {
  const blocks = Array.from({ length: count }, (_, i) =>
    makeBlockRow({ id: `${pageId}_B${i}`, parent_id: pageId, page_id: pageId, position: i }),
  )
  return { blocks, truncated: false, total: count }
}

let counts: Record<string, number> | Error = {}

beforeEach(() => {
  vi.clearAllMocks()
  counts = {}
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'load_page_subtree') {
      return subtreeOf((args as { rootBlockId: string }).rootBlockId, 3)
    }
    if (cmd === 'count_backlinks_in_page') {
      if (counts instanceof Error) throw counts
      return counts
    }
    return []
  })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

function renderTree(pageId: string) {
  return render(
    <PageBlockStoreProvider pageId={pageId}>
      <BlockTree parentId={pageId} autoCreateFirstBlock={false} />
    </PageBlockStoreProvider>,
  )
}

const countCalls = () =>
  mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_backlinks_in_page')

describe('BlockTree reference counts (#6746)', () => {
  it('loading a page makes one count call, whatever its size', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      // Past `MAX_BATCH_BLOCK_IDS`, so a per-id batch would have to split.
      if (cmd === 'load_page_subtree') return subtreeOf('BIG', 1500)
      if (cmd === 'count_backlinks_in_page') return {}
      return []
    })
    renderTree('BIG')
    expect(await screen.findByTestId('sortable-block-BIG_B0')).toBeInTheDocument()
    await waitFor(() => expect(countCalls()).toHaveLength(1))
    expect(countCalls()[0]).toEqual([
      'count_backlinks_in_page',
      { pageId: 'BIG', scope: { kind: 'active', space_id: 'SPACE_TEST' } },
    ])
  })

  it('gives a referenced row its count and the others none', async () => {
    counts = { PAGE_B1: 2 }
    renderTree('PAGE')
    await waitFor(() => expect(screen.getByTestId('sortable-block-PAGE_B1')).toHaveTextContent('2'))
    expect(screen.getByTestId('sortable-block-PAGE_B0')).toHaveTextContent('0')
    expect(screen.getByTestId('sortable-block-PAGE_B2')).toHaveTextContent('0')
  })

  it('shows no counts and warns when the read fails', async () => {
    const warn = vi.spyOn(logger, 'warn')
    counts = new Error('backend gone')
    renderTree('PAGE')
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'useBlockRefCounts',
        'reference counts failed',
        { pageId: 'PAGE' },
        expect.any(Error),
      ),
    )
    expect(screen.getByTestId('sortable-block-PAGE_B1')).toHaveTextContent('0')
  })

  // Page mode's count opens block mode zoomed on its block: the tree zooms as it mounts.
  it('zooms the block it is asked to as it mounts', async () => {
    const onZoomChange = vi.fn()
    render(
      <PageBlockStoreProvider pageId="PAGE">
        <BlockTree
          parentId="PAGE"
          autoCreateFirstBlock={false}
          zoomOnMount="PAGE_B1"
          onZoomChange={onZoomChange}
        />
      </PageBlockStoreProvider>,
    )
    await waitFor(() => expect(onZoomChange).toHaveBeenLastCalledWith('PAGE_B1'))
  })

  it('has no a11y violations', async () => {
    counts = { PAGE_B1: 2 }
    const { container } = renderTree('PAGE')
    await screen.findByTestId('sortable-block-PAGE_B1')
    expect(await axe(container)).toHaveNoViolations()
  })
})
