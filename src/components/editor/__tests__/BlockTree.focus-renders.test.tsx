/**
 * #5447 — a focus move re-renders only the trees it touches.
 *
 * The journal week view mounts one BlockTree per day, all reading the GLOBAL
 * focus and selection. A tree that neither owns the focused block nor held it
 * has nothing to update, so a focus move must not re-render it.
 *
 * Probes: a `<Profiler>` per tree counts tree commits; the mocked leaf
 * `SortableBlock` counts row renders. Like the real one it reads the block
 * actions context, so a row renders when its memoized wrapper does or when
 * that context changes.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const rowRenders = new Map<string, number>()

// The real `SortableBlock` reads the action bag from context, so the probe does
// too: a bag that changes identity re-renders every row, as it does in the app.
vi.mock('@/components/editor/SortableBlock', async () => {
  const { useBlockActions } = await import('@/components/block-tree/use-block-actions')
  return {
    SortableBlock: (props: { blockId: string }) => {
      useBlockActions()
      rowRenders.set(props.blockId, (rowRenders.get(props.blockId) ?? 0) + 1)
      return <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
    },
    INDENT_WIDTH: 24,
  }
})

// Both hooks return a stable object in the app; a fresh one per render would
// defeat the row memo and count renders production never does.
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

const DAYS = 7
const BLOCKS_PER_DAY = 5
const treeCommits = new Map<string, number>()

function blockId(day: number, row: number): string {
  return `D${day}_B${row}`
}

function makeDayStore(day: number): StoreApi<PageBlockState> {
  const store = createPageBlockStore(`PAGE_${day}`)
  store.setState({
    blocks: Array.from({ length: BLOCKS_PER_DAY }, (_, row) =>
      makeBlock({ id: blockId(day, row), parent_id: `PAGE_${day}`, content: `d${day} b${row}` }),
    ),
    loading: false,
  })
  return store
}

/** Mounts a week of trees the way the journal does: one page store per day. */
async function renderWeek(): Promise<HTMLElement> {
  const stores = Array.from({ length: DAYS }, (_, day) => makeDayStore(day))
  const { container } = render(
    <>
      {stores.map((store) => (
        <Profiler
          key={store.getState().rootParentId}
          id={store.getState().rootParentId ?? ''}
          onRender={(id) => treeCommits.set(id, (treeCommits.get(id) ?? 0) + 1)}
        >
          <PageBlockContext.Provider value={store}>
            <BlockTree autoCreateFirstBlock={false} />
          </PageBlockContext.Provider>
        </Profiler>
      ))}
    </>,
  )
  await screen.findByTestId(`sortable-block-${blockId(DAYS - 1, 0)}`)
  // Let the mount-time `load()` rejection and its loading toggles settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return container
}

/**
 * Which days `move` re-rendered: per day, whether its tree committed and
 * whether any of its rows rendered. The owning tree's own commit and row
 * counts are not pinned here.
 */
function rerenderedDays(move: () => void) {
  treeCommits.clear()
  rowRenders.clear()
  act(move)
  const rowsOf = (day: number) =>
    [...rowRenders].filter(([id]) => id.startsWith(`D${day}_`)).reduce((sum, [, n]) => sum + n, 0)
  return {
    trees: Array.from({ length: DAYS }, (_, day) => (treeCommits.get(`PAGE_${day}`) ?? 0) > 0),
    rows: Array.from({ length: DAYS }, (_, day) => rowsOf(day) > 0),
  }
}

const only = (...days: number[]) => Array.from({ length: DAYS }, (_, day) => days.includes(day))

const setFocused = (id: string | null) => useBlockStore.getState().setFocused(id)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    return []
  })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('BlockTree focus-move re-renders (#5447)', () => {
  it('a focus move within a day (ArrowDown) re-renders only that day of the week', async () => {
    await renderWeek()
    act(() => setFocused(blockId(2, 0)))

    const { trees, rows } = rerenderedDays(() => setFocused(blockId(2, 1)))

    expect(trees).toEqual(only(2))
    expect(rows).toEqual(only(2))
  })

  it('moving focus to another day re-renders only the day losing and the day gaining it', async () => {
    await renderWeek()
    act(() => setFocused(blockId(2, 4)))

    const { trees, rows } = rerenderedDays(() => setFocused(blockId(3, 0)))

    expect(trees).toEqual(only(2, 3))
    expect(rows).toEqual(only(2, 3))
  })

  it('selecting a block re-renders only the day that owns it', async () => {
    await renderWeek()

    const { trees, rows } = rerenderedDays(() =>
      useBlockStore.getState().setSelected([blockId(5, 1)]),
    )

    expect(trees).toEqual(only(5))
    expect(rows).toEqual(only(5))
  })

  it('has no a11y violations with a week of trees mounted', async () => {
    const container = await renderWeek()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
