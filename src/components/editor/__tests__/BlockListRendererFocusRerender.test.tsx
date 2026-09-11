// @vitest-environment jsdom

/**
 * #4959 — focus-move re-render scoping.
 *
 * `BlockListRenderer` used to forward the page-wide `focusedBlockId` to every
 * `SortableBlockWrapper`. That value is identical for all N rows and changes on
 * every focus move, so the per-row `React.memo` never short-circuited and the
 * whole mounted list re-reconciled when exactly two rows' focus state changed.
 * Passing the derived boolean `isFocused` instead makes the memo hold for the
 * (N − 2) bystander rows.
 *
 * Same probe as `BlockListRendererDragRerender.test.tsx` (#1267): the mocked
 * leaf `SortableBlock` is a plain function, so a bump in its render count means
 * the memoized wrapper above it actually re-rendered.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'

const renderCounts = new Map<string, number>()

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => {
    renderCounts.set(props.blockId, (renderCounts.get(props.blockId) ?? 0) + 1)
    return <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  },
  INDENT_WIDTH: 24,
}))

vi.mock('@/components/common/EmptyState', () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}))

import { BlockListRenderer } from '@/components/editor/BlockListRenderer'

const noop = () => {}

const IDS = ['BLK_A', 'BLK_B', 'BLK_C', 'BLK_D', 'BLK_E']

/**
 * Everything except `focusedBlockId` keeps stable identity across the rerender
 * — the production invariant on a bare focus move (`visibleItems`, `viewport`,
 * `rovingEditor` and the Sets are all unchanged). That isolates the variable
 * under test: pre-fix the focused id alone re-rendered every row.
 */
function makeStableBase() {
  const blocks = IDS.map((id) => makeBlock({ id, content: id, depth: 0 }))
  return {
    visibleItems: blocks,
    blocks,
    loading: false,
    rootParentId: 'PAGE_1',
    isZoomed: false,
    onExitZoom: noop,
    selectedBlockIds: [] as string[],
    projected: null,
    activeId: null,
    overId: null,
    dropAfter: false,
    viewport: {
      isOffscreen: () => false,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
    },
    rovingEditor: {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    } as never,
    onContainerPointerDown: noop,
    hasChildrenSet: new Set<string>(),
    collapsedIds: new Set<string>(),
    hiddenMountCount: 0,
    onExpandMount: noop,
  }
}

describe('BlockListRenderer focus re-render scoping (#4959)', () => {
  it('re-renders only the two rows whose focus changed, not every mounted row', () => {
    renderCounts.clear()
    const base = makeStableBase()

    const { rerender } = render(<BlockListRenderer {...base} focusedBlockId="BLK_A" />)

    for (const id of IDS) {
      expect(renderCounts.get(id)).toBe(1)
    }

    // Focus moves A → B. Only those two rows' `isFocused` flips.
    rerender(<BlockListRenderer {...base} focusedBlockId="BLK_B" />)

    expect(renderCounts.get('BLK_A')).toBe(2)
    expect(renderCounts.get('BLK_B')).toBe(2)
    // The bystanders stay memoized — pre-fix all three bumped to 2.
    expect(renderCounts.get('BLK_C')).toBe(1)
    expect(renderCounts.get('BLK_D')).toBe(1)
    expect(renderCounts.get('BLK_E')).toBe(1)
  })

  it('re-renders only the previously focused row when focus is cleared', () => {
    renderCounts.clear()
    const base = makeStableBase()

    const { rerender } = render(<BlockListRenderer {...base} focusedBlockId="BLK_C" />)

    rerender(<BlockListRenderer {...base} focusedBlockId={null} />)

    expect(renderCounts.get('BLK_C')).toBe(2)
    for (const id of ['BLK_A', 'BLK_B', 'BLK_D', 'BLK_E']) {
      expect(renderCounts.get(id)).toBe(1)
    }
  })
})
