// @vitest-environment jsdom

/**
 * #1267 — drag re-render scoping.
 *
 * Proves the per-move DnD state no longer fans out to every row. During a drag,
 * `projected` is a fresh reference on every pointer move; previously
 * BlockListRenderer forwarded it as a prop to every `SortableBlockWrapper`, so
 * the per-row `React.memo` could never short-circuit and ALL visible rows
 * re-rendered on every move. The fix routes the per-move state through a
 * per-id-subscribed `DragStateStore` (mirroring the #1067 viewport store), so
 * only the rows whose derived snapshot actually changes (the previous over-row,
 * the new over-row, and the active row) re-render.
 *
 * This test counts how many times each block's content renders as `overId` /
 * `projected` move from one row to another, and asserts a row that is neither
 * the active nor the over-row does NOT re-render, while the over-rows do.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'

// Record a render per blockId so we can prove which rows re-rendered. The real
// SortableBlock is React.memo-wrapped; the mock is a plain function that runs
// on every render of its SortableBlockWrapper parent — so a bump here means the
// wrapper re-rendered (the memo did NOT short-circuit).
const renderCounts = new Map<string, number>()

vi.mock('../SortableBlock', () => ({
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
import type { Projection } from '@/lib/tree-utils'

const noop = () => {}

function makeProps(overrides: Partial<React.ComponentProps<typeof BlockListRenderer>> = {}) {
  return {
    visibleItems: [],
    blocks: [],
    loading: false,
    rootParentId: 'PAGE_1',
    focusedBlockId: null,
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
    blockProperties: {},
    ...overrides,
  }
}

/** A fresh projection reference each call — exactly what useBlockDnD produces. */
function projection(depth: number): Projection {
  return { depth, parentId: null, maxDepth: 3, minDepth: 0 }
}

/**
 * Build a base props object ONCE so that everything except the per-move DnD
 * state (`projected` / `overId` / `dropAfter`) keeps stable identity across
 * rerenders — exactly the production invariant mid-drag (`visibleItems`,
 * `viewport`, `rovingEditor`, the Sets are all stable while only the pointer
 * moves). This isolates the variable under test: without the #1267 fix, the
 * fresh `projected` reference alone re-renders every row.
 */
function makeStableBase(activeId: string, ids: string[]) {
  const blocks = ids.map((id) => makeBlock({ id, content: id, depth: 0 }))
  return makeProps({
    visibleItems: blocks,
    blocks,
    activeId,
  })
}

describe('BlockListRenderer drag re-render scoping (#1267)', () => {
  it('re-renders only the over-rows on a pointer move, not the bystander rows', () => {
    renderCounts.clear()
    const base = makeStableBase('BLK_A', ['BLK_A', 'BLK_B', 'BLK_C', 'BLK_D'])

    // Drag in progress: BLK_A is the active (lifted) row, cursor over BLK_B.
    const { rerender } = render(
      <BlockListRenderer {...base} overId="BLK_B" projected={projection(0)} />,
    )

    // All four rendered once at mount.
    for (const id of ['BLK_A', 'BLK_B', 'BLK_C', 'BLK_D']) {
      expect(renderCounts.get(id)).toBe(1)
    }

    const before = {
      B: renderCounts.get('BLK_B') ?? 0,
      C: renderCounts.get('BLK_C') ?? 0,
      D: renderCounts.get('BLK_D') ?? 0,
    }

    // Pointer move: the cursor leaves BLK_B and hovers BLK_C. `projected` is a
    // BRAND-NEW reference (as it is on every real move). Only the prior over-row
    // (B) and the new over-row (C) should update; the far bystander row D must
    // stay memoized.
    rerender(<BlockListRenderer {...base} overId="BLK_C" projected={projection(0)} />)

    // Bystander row D did NOT re-render despite the fresh `projected` reference —
    // the #1267 win (pre-fix this would have bumped to 2 like every other row).
    expect(renderCounts.get('BLK_D')).toBe(before.D)

    // The two over-rows DID update (B lost the indicator, C gained it).
    expect(renderCounts.get('BLK_B')).toBeGreaterThan(before.B)
    expect(renderCounts.get('BLK_C')).toBeGreaterThan(before.C)
  })

  it('does not re-render a bystander row when a horizontal move only changes the projected depth', () => {
    renderCounts.clear()
    const base = makeStableBase('BLK_A', ['BLK_A', 'BLK_B', 'BLK_C'])

    const { rerender } = render(
      <BlockListRenderer {...base} overId="BLK_B" projected={projection(0)} />,
    )

    const beforeC = renderCounts.get('BLK_C') ?? 0

    // A horizontal-only move (depth 0 → 1): a fresh `projected` reference with a
    // new depth. The active row (A) and over-row (B) preview the depth and DO
    // update; the bystander row C is unaffected and stays memoized.
    rerender(<BlockListRenderer {...base} overId="BLK_B" projected={projection(1)} />)

    expect(renderCounts.get('BLK_C')).toBe(beforeC)
  })
})
