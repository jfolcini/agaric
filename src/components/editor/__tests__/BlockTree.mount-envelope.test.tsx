/**
 * #2467 — frontend mount envelope, wired end-to-end through BlockTree.
 *
 * Complements the focused unit tests in `useBlockMountLimit.test.ts` and
 * `BlockListRenderer.test.tsx` by pinning the full wiring: a large page's
 * flat block list is capped BEFORE it reaches `BlockListRenderer`, the
 * excess rows are not mounted at all (not placeholders — absent from the
 * DOM), a boundary affordance reports how many are hidden, and clicking it
 * mounts the next batch.
 *
 * Below the cap, behavior is pinned unchanged: every row mounts and no
 * boundary appears (regression coverage for the common case).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import {
  INITIAL_MOUNT_LIMIT,
  MOUNT_LIMIT_STEP,
} from '@/components/block-tree/use-block-mount-limit'
import { t } from '@/lib/i18n'
import type { FlatBlock } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
  INDENT_WIDTH: 24,
}))

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

function renderBlockTree() {
  return render(
    <PageBlockContext.Provider value={pageStore}>
      <BlockTree autoCreateFirstBlock={false} />
    </PageBlockContext.Provider>,
  )
}

function makeFlatBlocks(count: number): FlatBlock[] {
  return Array.from({ length: count }, (_, i) => makeBlock({ id: `BLK_${i}`, content: `b${i}` }))
}

/** The boundary row's "Show N more" button, asserted present (not queried loosely). */
function getBoundaryButton(): HTMLElement {
  return within(screen.getByTestId('block-tree-mount-boundary')).getByRole('button')
}

beforeEach(() => {
  vi.clearAllMocks()
  // The mount-time `load()` fails silently (catch branch) so the directly
  // seeded `pageStore.blocks` below is what actually renders — mirrors
  // BlockTree.test.tsx's setup.
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

describe('BlockTree mount envelope (#2467)', () => {
  it('mounts every row and shows no boundary when the page is below the cap', async () => {
    const blocks = makeFlatBlocks(50)
    pageStore.setState({ blocks, loading: false })

    renderBlockTree()

    // The mount-time `load()` (mocked to reject) resolves loading:false
    // asynchronously; wait for the real render to replace the skeleton.
    await screen.findByTestId(`sortable-block-BLK_0`)

    for (const b of blocks) {
      expect(screen.getByTestId(`sortable-block-${b.id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('block-tree-mount-boundary')).not.toBeInTheDocument()
  })

  it('caps mounted rows at the envelope on a large flat page', async () => {
    const total = INITIAL_MOUNT_LIMIT + 700
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    // Exactly the cap's worth of rows mounted.
    expect(screen.getAllByTestId(/^sortable-block-/)).toHaveLength(INITIAL_MOUNT_LIMIT)
    // First N are mounted, in order.
    expect(screen.getByTestId(`sortable-block-BLK_0`)).toBeInTheDocument()
    expect(screen.getByTestId(`sortable-block-BLK_${INITIAL_MOUNT_LIMIT - 1}`)).toBeInTheDocument()
    // The rest are genuinely absent from the DOM — not placeholders.
    expect(
      screen.queryByTestId(`sortable-block-BLK_${INITIAL_MOUNT_LIMIT}`),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId(`sortable-block-BLK_${total - 1}`)).not.toBeInTheDocument()

    const boundary = screen.getByTestId('block-tree-mount-boundary')
    expect(boundary).toHaveTextContent(String(total - INITIAL_MOUNT_LIMIT))
  })

  it('mounts the next batch when the boundary is expanded (deferred rows load/mount)', async () => {
    const user = userEvent.setup()
    const total = INITIAL_MOUNT_LIMIT + 700
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    expect(
      screen.queryByTestId(`sortable-block-BLK_${INITIAL_MOUNT_LIMIT}`),
    ).not.toBeInTheDocument()

    await user.click(getBoundaryButton())

    // The next batch is now mounted, including the row that was previously
    // just past the boundary.
    expect(screen.getByTestId(`sortable-block-BLK_${INITIAL_MOUNT_LIMIT}`)).toBeInTheDocument()
    expect(screen.getAllByTestId(/^sortable-block-/)).toHaveLength(
      INITIAL_MOUNT_LIMIT + MOUNT_LIMIT_STEP,
    )

    const remainingHidden = total - (INITIAL_MOUNT_LIMIT + MOUNT_LIMIT_STEP)
    expect(screen.getByTestId('block-tree-mount-boundary')).toHaveTextContent(
      String(remainingHidden),
    )
  })

  it('mounts everything once enough batches are expanded, and the boundary disappears', async () => {
    const user = userEvent.setup()
    const total = INITIAL_MOUNT_LIMIT + MOUNT_LIMIT_STEP + 10
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    // Two expansions cover the full 700 + 10 remainder in this fixture size.
    await user.click(getBoundaryButton())
    await user.click(getBoundaryButton())

    expect(screen.getAllByTestId(/^sortable-block-/)).toHaveLength(total)
    expect(screen.queryByTestId('block-tree-mount-boundary')).not.toBeInTheDocument()
  })

  // #752-style pageKey reset — BlockTree is not remounted on page switch
  // (journal week/month views swap `rootParentId` in place), so an expanded
  // limit on one large page must not leak into a different page.
  it('resets the mount limit when the store instance (page) changes', async () => {
    const total = INITIAL_MOUNT_LIMIT + 5
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })

    const { rerender } = renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')
    expect(screen.getByTestId('block-tree-mount-boundary')).toHaveTextContent('5')

    // Switch to a different page's store (fresh `rootParentId`) — the
    // boundary reflects the new page's own (below-cap) size, not a leaked
    // expanded limit.
    const otherStore = createPageBlockStore('PAGE_2')
    otherStore.setState({ blocks: makeFlatBlocks(3), loading: false })
    rerender(
      <PageBlockContext.Provider value={otherStore}>
        <BlockTree autoCreateFirstBlock={false} />
      </PageBlockContext.Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId(/^sortable-block-/)).toHaveLength(3)
    })
    expect(screen.queryByTestId('block-tree-mount-boundary')).not.toBeInTheDocument()
  })

  it('the boundary button label uses the mountBoundary i18n key', async () => {
    const total = INITIAL_MOUNT_LIMIT + 1
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    expect(screen.getByTestId('block-tree-mount-boundary')).toHaveTextContent(
      t('blockTree.mountBoundary', { count: 1 }),
    )
  })
})

// =========================================================================
// #2580 — windowedBlocks scoped to the mounted set: mount-cap-excluded rows
// (never mounted, never measured) must not ride along in the batch metadata
// IPCs. Drives the real `get_batch_properties` IPC (mocked `invoke`) rather
// than asserting on internal state, mirroring `useViewportWindow.test.tsx`'s
// batch-payload-scoping tests but through the full BlockTree wiring.
// =========================================================================
describe('BlockTree mount envelope x windowed metadata IPCs (#2580)', () => {
  function mockBatchProperties(): void {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
      if (cmd === 'get_batch_properties') {
        const blockIds = (args as { blockIds?: string[] } | undefined)?.blockIds ?? []
        const result: Record<string, unknown[]> = {}
        for (const id of blockIds) result[id] = []
        return result
      }
      return []
    })
  }

  function lastBatchPropertiesIds(): string[] {
    const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
    const last = calls.at(-1) as [string, { blockIds?: string[] }] | undefined
    return last?.[1]?.blockIds ?? []
  }

  it('excludes mount-cap-excluded rows from the get_batch_properties IPC payload', async () => {
    const total = INITIAL_MOUNT_LIMIT + 50
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })
    mockBatchProperties()

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    await waitFor(() => {
      expect(lastBatchPropertiesIds()).toHaveLength(INITIAL_MOUNT_LIMIT)
    })

    const ids = lastBatchPropertiesIds()
    // The last MOUNTED row is in the batch payload...
    expect(ids).toContain(`BLK_${INITIAL_MOUNT_LIMIT - 1}`)
    // ...but the rows the mount cap excluded are not — they never mounted,
    // so there is no chip to resolve and no IPC should be spent on them.
    expect(ids).not.toContain(`BLK_${INITIAL_MOUNT_LIMIT}`)
    expect(ids).not.toContain(`BLK_${total - 1}`)
  })

  it('includes newly-revealed rows in the IPC payload once the mount limit expands', async () => {
    const user = userEvent.setup()
    const total = INITIAL_MOUNT_LIMIT + 50
    const blocks = makeFlatBlocks(total)
    pageStore.setState({ blocks, loading: false })
    mockBatchProperties()

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')
    await waitFor(() => {
      expect(lastBatchPropertiesIds()).not.toContain(`BLK_${INITIAL_MOUNT_LIMIT}`)
    })

    await user.click(getBoundaryButton())

    // Revealing the next batch mounts the previously-excluded rows — they
    // must now resolve their metadata via a fresh IPC.
    await waitFor(() => {
      expect(lastBatchPropertiesIds()).toContain(`BLK_${INITIAL_MOUNT_LIMIT}`)
    })
    // #2701: the provider's delta-fetch cache already holds the first
    // `INITIAL_MOUNT_LIMIT` rows (fetched before the boundary expanded), so
    // the fresh IPC is scoped to ONLY the newly-revealed rows, not the
    // whole expanded window.
    expect(lastBatchPropertiesIds()).toHaveLength(total - INITIAL_MOUNT_LIMIT)
    expect(lastBatchPropertiesIds()).not.toContain(`BLK_${INITIAL_MOUNT_LIMIT - 1}`)
  })
})
