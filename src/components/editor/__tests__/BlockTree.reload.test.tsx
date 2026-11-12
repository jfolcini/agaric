/**
 * #6533 — a reload of a loaded page keeps its tree mounted.
 *
 * `load()` is also the reload path (sync, MCP write, undo) and sets `loading`
 * on every call. The skeleton covers only the store's first load: a reload
 * leaves the rows, and the focused editor inside one, as they are. The journal
 * week view mounts one tree per day, so the trees here sit side by side, one
 * on its first load while the other reloads.
 *
 * Focus, caret, typing and scroll through a reload are pinned in
 * `e2e/reload-keeps-editor.spec.ts`; the mocked rows here have none.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, makePropertyRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { INITIAL_MOUNT_LIMIT } from '@/components/block-tree/use-block-mount-limit'
import type { PageSubtree, PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { LIST_STYLE_KEY } from '@/lib/list-style'
import { useBlockStore } from '@/stores/blocks'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/SortableBlock', async () => {
  const { useListMarker } = await import('@/components/editor/ListMarkerContext')
  function SortableBlock({ blockId }: { blockId: string }): React.ReactElement {
    const { style } = useListMarker(blockId)
    return (
      <div data-testid={`sortable-block-${blockId}`} data-list-style={style}>
        SortableBlock
      </div>
    )
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

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
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

interface PendingLoad {
  rootBlockId: string
  resolve: (subtree: PageSubtree) => void
  reject: (err: unknown) => void
}

/** Every `load_page_subtree` call, left in flight until the test answers it. */
let pendingLoads: PendingLoad[] = []
/** The `block_properties` rows `get_batch_properties` answers with, by block id. */
let storedProperties: Record<string, PropertyRow[]> = {}
/** The ids of every `get_batch_properties` call, in call order. */
let batchReads: string[][] = []

function subtreeOf(pageId: string, count: number): PageSubtree {
  const blocks = Array.from({ length: count }, (_, i) =>
    makeBlockRow({
      id: `${pageId}_B${i}`,
      parent_id: pageId,
      page_id: pageId,
      position: i,
      content: `${pageId} row ${i}`,
    }),
  )
  return { blocks, truncated: false, total: count }
}

/** Answer the oldest load of `pageId` still in flight. */
async function answerLoad(pageId: string, answer: PageSubtree | Error): Promise<void> {
  const index = pendingLoads.findIndex((load) => load.rootBlockId === pageId)
  if (index === -1) throw new Error(`no load of ${pageId} in flight`)
  const [load] = pendingLoads.splice(index, 1) as [PendingLoad]
  await act(async () => {
    if (answer instanceof Error) load.reject(answer)
    else load.resolve(answer)
  })
}

function reload(pageId: string): Promise<void> {
  const store = getPageStore(pageId)
  if (store === undefined) throw new Error(`no store mounted for ${pageId}`)
  let done!: Promise<void>
  act(() => {
    done = store.getState().load()
  })
  return done
}

/** One tree in its own pane, as the journal mounts one per day; `pane` names it for queries. */
function Pane({ pane, pageId }: { pane: string; pageId: string }): React.ReactElement {
  return (
    <section data-testid={pane}>
      <PageBlockStoreProvider pageId={pageId}>
        <BlockTree parentId={pageId} autoCreateFirstBlock={false} />
      </PageBlockStoreProvider>
    </section>
  )
}

const skeletonIn = (pane: string) => screen.getByTestId(pane).querySelector('.block-tree-loading')
const rowsIn = (pane: string) =>
  within(screen.getByTestId(pane)).queryAllByTestId(/^sortable-block-/)
const listStyleIn = (pane: string, blockId: string) =>
  within(screen.getByTestId(pane)).getByTestId(`sortable-block-${blockId}`).dataset['listStyle']

beforeEach(() => {
  vi.clearAllMocks()
  pendingLoads = []
  storedProperties = {}
  batchReads = []
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'load_page_subtree') {
      const { rootBlockId } = args as { rootBlockId: string }
      return new Promise((resolve, reject) => {
        pendingLoads.push({ rootBlockId, resolve, reject })
      })
    }
    if (cmd === 'get_batch_properties') {
      const { blockIds } = args as { blockIds: string[] }
      batchReads.push(blockIds)
      return Object.fromEntries(blockIds.map((id) => [id, storedProperties[id] ?? []]))
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

describe('BlockTree reload (#6533)', () => {
  it('a reload keeps a loaded tree’s rows, while a tree on its first load beside it shows the skeleton', async () => {
    render(
      <>
        <Pane pane="a" pageId="PAGE_A" />
        <Pane pane="b" pageId="PAGE_B" />
      </>,
    )
    await waitFor(() => expect(pendingLoads).toHaveLength(2))
    expect(skeletonIn('a')).not.toBeNull()
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 3))
    const rows = rowsIn('a')
    expect(rows).toHaveLength(3)

    const reloaded = reload('PAGE_A')
    expect(getPageStore('PAGE_A')?.getState().loading).toBe(true)

    expect(skeletonIn('a')).toBeNull()
    expect(skeletonIn('b')).not.toBeNull()
    const during = rowsIn('a')
    expect(during).toHaveLength(3)
    during.forEach((row, i) => expect(row).toBe(rows[i]))

    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 3))
    await reloaded
    const after = rowsIn('a')
    expect(after).toHaveLength(3)
    after.forEach((row, i) => expect(row).toBe(rows[i]))
    expect(skeletonIn('b')).not.toBeNull()
  })

  it('a reload keeps the "show more" boundary under a page past the mount limit', async () => {
    render(<Pane pane="a" pageId="PAGE_A" />)
    await waitFor(() => expect(pendingLoads).toHaveLength(1))
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', INITIAL_MOUNT_LIMIT + 1))
    const boundary = screen.getByTestId('block-tree-mount-boundary')

    const reloaded = reload('PAGE_A')
    expect(screen.getByTestId('block-tree-mount-boundary')).toBe(boundary)

    await answerLoad('PAGE_A', subtreeOf('PAGE_A', INITIAL_MOUNT_LIMIT + 1))
    await reloaded
    expect(screen.getByTestId('block-tree-mount-boundary')).toBe(boundary)
  })

  // A paste, an undo or a sync writes properties with no `block:properties-changed`, then reloads.
  it('a reload re-reads the rows’ properties once, for a row the write restyled as for a row it added', async () => {
    render(<Pane pane="a" pageId="PAGE_A" />)
    await waitFor(() => expect(pendingLoads).toHaveLength(1))
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 1))
    await waitFor(() => expect(batchReads).toEqual([['PAGE_A_B0']]))
    expect(listStyleIn('a', 'PAGE_A_B0')).toBe('none')

    const bullet = [makePropertyRow({ key: LIST_STYLE_KEY, value_text: 'bullet' })]
    storedProperties = { PAGE_A_B0: bullet, PAGE_A_B1: bullet }
    const reloaded = reload('PAGE_A')
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 2))
    await reloaded

    await waitFor(() => expect(listStyleIn('a', 'PAGE_A_B0')).toBe('bullet'))
    expect(listStyleIn('a', 'PAGE_A_B1')).toBe('bullet')
    expect(batchReads).toEqual([['PAGE_A_B0'], ['PAGE_A_B0', 'PAGE_A_B1']])
  })

  it('a reload that fails keeps the rows and tells the user', async () => {
    render(<Pane pane="a" pageId="PAGE_A" />)
    await waitFor(() => expect(pendingLoads).toHaveLength(1))
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 2))
    const rows = rowsIn('a')

    const reloaded = reload('PAGE_A')
    await answerLoad('PAGE_A', new Error('backend gone'))
    await reloaded

    expect(skeletonIn('a')).toBeNull()
    const after = rowsIn('a')
    expect(after).toHaveLength(2)
    after.forEach((row, i) => expect(row).toBe(rows[i]))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      t('error.loadBlocksFailed'),
      expect.objectContaining({ id: 'load-blocks-failed' }),
    )
  })

  it('switching the tree to another page shows the skeleton until that page loads', async () => {
    const { rerender } = render(<Pane pane="a" pageId="PAGE_A" />)
    await waitFor(() => expect(pendingLoads).toHaveLength(1))
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 2))
    expect(rowsIn('a')).toHaveLength(2)

    rerender(<Pane pane="a" pageId="PAGE_C" />)

    await waitFor(() => expect(pendingLoads).toHaveLength(1))
    expect(skeletonIn('a')).not.toBeNull()
    expect(rowsIn('a')).toHaveLength(0)
    await answerLoad('PAGE_C', subtreeOf('PAGE_C', 1))
    expect(skeletonIn('a')).toBeNull()
    expect(rowsIn('a').map((row) => row.dataset['testid'])).toEqual(['sortable-block-PAGE_C_B0'])
  })

  it('has no a11y violations with one tree loaded and one on its first load', async () => {
    const { container } = render(
      <>
        <Pane pane="a" pageId="PAGE_A" />
        <Pane pane="b" pageId="PAGE_B" />
      </>,
    )
    await waitFor(() => expect(pendingLoads).toHaveLength(2))
    await answerLoad('PAGE_A', subtreeOf('PAGE_A', 2))
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
