/**
 * #5329 / #5330 — the initial render window and frame-budgeted hydration,
 * wired end-to-end through the REAL `useViewportObserver` (the other BlockTree
 * suites mock it away): `BlockListRenderer` marks the rows past
 * `INITIAL_WINDOW_ROWS`, `SortableBlockWrapper` mounts them as placeholders
 * that seed the observer off-screen, and the observer hydrates the ones that
 * intersect `HYDRATION_ROWS_PER_FRAME` per animation frame. Opening a
 * 500-block page used to render all 500 blocks in full in one commit (a 1.2 s
 * frame) and a scroll tick flipped a whole batch on in one task (70–140 ms).
 *
 * Focus is the one thing that bypasses both: a focused row renders in full on
 * the same commit, whether it was a placeholder a moment ago (link / search
 * jump, `PageEditor` → `setFocused`) or ArrowDown stepped onto it.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import {
  MockIntersectionObserver,
  stubAnimationFrames,
} from '@/__tests__/helpers/viewport-observer-mocks'
import { INITIAL_WINDOW_ROWS } from '@/components/editor/BlockListRenderer'
import { HYDRATION_ROWS_PER_FRAME } from '@/hooks/useViewportObserver'
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

// The real keymap needs a live ProseMirror editor, which `useRovingEditor` is
// mocked away above. Capturing the callback bundle lets the arrow-key cases
// below drive the ArrowDown / ArrowUp handlers themselves.
let lastKeyboardCallbacks: { onFocusNext?: () => void; onFocusPrev?: () => void } = {}
vi.mock('@/editor/use-block-keyboard', () => ({
  useBlockKeyboard: (
    _editor: unknown,
    callbacks: { onFocusNext?: () => void; onFocusPrev?: () => void },
  ) => {
    lastKeyboardCallbacks = callbacks
  },
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
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

const TOTAL = INITIAL_WINDOW_ROWS * 2

let pageStore: StoreApi<PageBlockState>
let frames: ReturnType<typeof stubAnimationFrames>

async function renderBlockTree(): Promise<void> {
  render(
    <PageBlockContext.Provider value={pageStore}>
      <BlockTree autoCreateFirstBlock={false} />
    </PageBlockContext.Provider>,
  )
  // The mount-time `load()` (mocked to reject) resolves loading:false
  // asynchronously; wait for the real render to replace the skeleton.
  await screen.findByTestId('sortable-block-BLK_0')
}

function makeFlatBlocks(count: number): FlatBlock[] {
  return Array.from({ length: count }, (_, i) => makeBlock({ id: `BLK_${i}`, content: `b${i}` }))
}

/** Ids of the rows currently rendered in full, in DOM order. */
function fullRowIds(): string[] {
  return screen
    .getAllByTestId(/^sortable-block-/)
    .map((el) => el.dataset['testid']?.replace('sortable-block-', '') ?? '')
}

function placeholderIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('li.block-placeholder[data-block-id]')].map(
    (el) => el.dataset['blockId'] ?? '',
  )
}

/** The observer BlockTree's hook built last (a root change rebuilds it). */
function observer(): MockIntersectionObserver {
  return MockIntersectionObserver.instances.at(-1) as MockIntersectionObserver
}

function runFrame(): void {
  act(() => {
    frames.runFrame()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  frames = stubAnimationFrames()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    return []
  })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: makeFlatBlocks(TOTAL), loading: false })
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BlockTree initial render window (#5329)', () => {
  it('renders only the initial window in full on first mount; the rest are placeholders', async () => {
    await renderBlockTree()

    expect(fullRowIds()).toEqual(Array.from({ length: INITIAL_WINDOW_ROWS }, (_, i) => `BLK_${i}`))
    const placeholders = placeholderIds()
    expect(placeholders).toHaveLength(TOTAL - INITIAL_WINDOW_ROWS)
    expect(placeholders[0]).toBe(`BLK_${INITIAL_WINDOW_ROWS}`)
    // Every row, placeholder or not, is observed, so the first callback can
    // correct the window either way.
    expect(observer().observed.size).toBe(TOTAL)
  })

  it('a navigation target that is still a placeholder renders in full the moment it is focused', async () => {
    await renderBlockTree()
    const target = `BLK_${TOTAL - 5}`
    expect(placeholderIds()).toContain(target)

    // What `PageEditor` does for a link / search-result jump.
    act(() => {
      useBlockStore.setState({ focusedBlockId: target })
    })

    // No observer callback, no animation frame: focus alone hydrates it.
    expect(screen.getByTestId(`sortable-block-${target}`)).toBeInTheDocument()
    expect(placeholderIds()).not.toContain(target)
  })

  it('ArrowDown from the last full row steps onto a placeholder and renders it; ArrowUp returns', async () => {
    const last = `BLK_${INITIAL_WINDOW_ROWS - 1}`
    const next = `BLK_${INITIAL_WINDOW_ROWS}`
    useBlockStore.setState({ focusedBlockId: last })
    await renderBlockTree()
    expect(placeholderIds()).toContain(next)

    act(() => {
      lastKeyboardCallbacks.onFocusNext?.()
    })
    expect(useBlockStore.getState().focusedBlockId).toBe(next)
    expect(screen.getByTestId(`sortable-block-${next}`)).toBeInTheDocument()

    act(() => {
      lastKeyboardCallbacks.onFocusPrev?.()
    })
    expect(useBlockStore.getState().focusedBlockId).toBe(last)
    expect(screen.getByTestId(`sortable-block-${last}`)).toBeInTheDocument()
  })
})

describe('BlockTree frame-budgeted hydration (#5330)', () => {
  it('hydrates the placeholders the observer reports on screen a few rows per frame', async () => {
    await renderBlockTree()
    const revealed = Array.from(
      { length: HYDRATION_ROWS_PER_FRAME * 2 + 1 },
      (_, i) => `BLK_${INITIAL_WINDOW_ROWS + i}`,
    )

    // The viewport shows the whole initial window plus the next few rows.
    act(() => {
      observer().reportAll(true)
    })
    // Nothing flips in the callback itself…
    expect(fullRowIds()).toHaveLength(INITIAL_WINDOW_ROWS)

    // …the first frame hydrates the first `HYDRATION_ROWS_PER_FRAME` rows past
    // the window…
    runFrame()
    expect(fullRowIds()).toHaveLength(INITIAL_WINDOW_ROWS + HYDRATION_ROWS_PER_FRAME)
    expect(fullRowIds().slice(INITIAL_WINDOW_ROWS)).toEqual(
      revealed.slice(0, HYDRATION_ROWS_PER_FRAME),
    )

    // …and the rest follow over the next frames, in order.
    runFrame()
    expect(fullRowIds()).toHaveLength(INITIAL_WINDOW_ROWS + HYDRATION_ROWS_PER_FRAME * 2)
    // Stop reporting the rest as intersecting from here: the observed set is
    // the whole page, so drain only what this test revealed.
    while (frames.pending() > 0) runFrame()
    expect(fullRowIds()).toHaveLength(TOTAL)
    expect(placeholderIds()).toEqual([])
  })

  it('swaps the initial-window rows the observer reports off screen for placeholders at once', async () => {
    await renderBlockTree()
    const obs = observer()
    const offscreen = [...obs.observed].filter(
      (el) => Number((el as HTMLElement).dataset['blockId']?.slice(4)) >= 20,
    )

    act(() => {
      obs.trigger(
        offscreen.map((target) => ({
          target,
          isIntersecting: false,
          boundingClientRect: { height: 40 } as DOMRectReadOnly,
        })),
      )
    })

    // Flipping OFF is cheap (a placeholder replaces a block) and still happens
    // in the callback; only flipping ON is spread across frames.
    expect(fullRowIds()).toEqual(Array.from({ length: 20 }, (_, i) => `BLK_${i}`))
    // A measured row keeps its real height as the placeholder's.
    const measured = document.querySelector<HTMLElement>('li[data-block-id="BLK_20"]')
    expect(measured?.style.minHeight).toBe('40px')
  })
})
