/**
 * #3277 finding 3 — mount-cap exclusion Sets rebuilt over the whole page on
 * every focus move.
 *
 * `mountCapExcludedIds` (BlockTree.tsx) used to list `focusedBlockId` as a
 * memo dependency so it could carve the focused row back out of the excluded
 * set inline. That meant EVERY focus move rebuilt the Set by rescanning the
 * full (page-sized, not window-sized) visible list, and — because the
 * resulting Set got a fresh identity — busted `useViewportWindow`'s memo,
 * which re-filters the FULL page list again.
 *
 * This file pins two things:
 *  1. (the perf property) moving focus between two already-mounted rows (the
 *     overwhelmingly common case) must NOT change the `excludedIds` Set
 *     identity passed into `useViewportWindow` — this is what stops the
 *     cascade.
 *  2. (behaviour preservation) the #2580 carve-out itself still works: a
 *     block the mount cap excluded still gets its metadata IPC once it
 *     becomes the focused row, even though the exclusion Set no longer
 *     encodes that carve-out directly.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { INITIAL_MOUNT_LIMIT } from '@/components/block-tree/use-block-mount-limit'
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

// Spy on `useViewportWindow`'s `excludedIds` argument (3rd positional arg)
// while still running the REAL implementation, so rendering behaves exactly
// as production does — this test only observes what identity BlockTree hands
// it across renders, it doesn't fake the hook's own logic.
const excludedIdsCalls: Array<ReadonlySet<string> | null | undefined> = []
vi.mock('@/hooks/useViewportWindow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useViewportWindow')>()
  return {
    useViewportWindow: (...args: Parameters<typeof actual.useViewportWindow>) => {
      excludedIdsCalls.push(args[2])
      return actual.useViewportWindow(...args)
    },
  }
})

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

beforeEach(() => {
  vi.clearAllMocks()
  excludedIdsCalls.length = 0
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

describe('BlockTree mount-cap exclusion identity across focus moves (#3277)', () => {
  it('keeps the excludedIds Set identity stable when focus moves between two already-mounted rows', async () => {
    const total = INITIAL_MOUNT_LIMIT + 50
    pageStore.setState({ blocks: makeFlatBlocks(total), loading: false })

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'BLK_0' })
    })
    await waitFor(() => expect(excludedIdsCalls.length).toBeGreaterThan(0))
    const afterFirstFocus = excludedIdsCalls.at(-1)

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'BLK_1' })
    })
    await waitFor(() => expect(excludedIdsCalls.length).toBeGreaterThan(0))
    const afterSecondFocus = excludedIdsCalls.at(-1)

    // Both BLK_0 and BLK_1 are well within the mounted set (mount limit is
    // 500), so this is the common case the fix targets: focus moving among
    // ALREADY-mounted rows must not rebuild the mount-cap exclusion Set.
    expect(afterFirstFocus).not.toBeNull()
    expect(afterSecondFocus).toBe(afterFirstFocus)
  })

  it('still resolves metadata for a focused row the mount cap had excluded (#2580 preserved)', async () => {
    const total = INITIAL_MOUNT_LIMIT + 50
    pageStore.setState({ blocks: makeFlatBlocks(total), loading: false })
    mockBatchProperties()

    renderBlockTree()
    await screen.findByTestId('block-tree-mount-boundary')
    await waitFor(() => {
      expect(lastBatchPropertiesIds()).not.toContain(`BLK_${INITIAL_MOUNT_LIMIT}`)
    })

    // Focus a row PAST the mount cap (simulating a link-navigation jump
    // before `useBlockMountLimit` has expanded to reach it).
    const excludedFocusId = `BLK_${INITIAL_MOUNT_LIMIT + 10}`
    act(() => {
      useBlockStore.setState({ focusedBlockId: excludedFocusId })
    })

    await waitFor(() => {
      expect(lastBatchPropertiesIds()).toContain(excludedFocusId)
    })
  })
})
