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
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { INITIAL_MOUNT_LIMIT } from '@/components/block-tree/use-block-mount-limit'
import { PREFERENCES, writePreference } from '@/lib/preferences'
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
  })
})
