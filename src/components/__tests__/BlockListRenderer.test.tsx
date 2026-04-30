/**
 * Tests for BlockListRenderer component.
 *
 * Validates:
 *  - Smoke render with blocks
 *  - Renders empty state when blocks array is empty
 *  - Renders SortableBlock for each visible item
 *  - Semantic tree structure: ul/li with aria attributes (UX-48)
 *  - Expand animation class applied to children of just-expanded block (UX-79)
 *  - No animation on initial render or collapse
 *  - Axe a11y audit passes
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'

// Mock SortableBlock
vi.mock('../SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
  INDENT_WIDTH: 24,
}))

// Mock EmptyState
vi.mock('../EmptyState', () => ({
  EmptyState: ({ message }: { message: string }) => <div data-testid="empty-state">{message}</div>,
}))

// Mock @dnd-kit/sortable
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
}))

// Mock @dnd-kit/core (useDroppable for SentinelDropZone)
vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}))

import { BlockListRenderer } from '../BlockListRenderer'

const noop = () => {}

/** Minimal props to render BlockListRenderer. */
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
    viewport: {
      isOffscreen: () => false,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
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

describe('BlockListRenderer', () => {
  it('renders SortableBlock for each visible item', () => {
    const blocks = [
      makeBlock({ id: 'BLK001', content: 'First' }),
      makeBlock({ id: 'BLK002', content: 'Second' }),
    ]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    expect(screen.getByTestId('sortable-block-BLK001')).toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-BLK002')).toBeInTheDocument()
    expect(container.querySelector('.block-tree')).toBeInTheDocument()
  })

  it('renders empty state when blocks array is empty and not loading', () => {
    render(
      <BlockListRenderer
        {...makeProps({ visibleItems: [], blocks: [], loading: false, rootParentId: 'PAGE_1' })}
      />,
    )

    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
  })

  it('does not render empty state when loading', () => {
    render(<BlockListRenderer {...makeProps({ visibleItems: [], blocks: [], loading: true })} />)

    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument()
  })

  it('does not render empty state when blocks exist', () => {
    const blocks = [makeBlock({ id: 'BLK001' })]
    render(<BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />)

    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument()
  })

  it('has no a11y violations with blocks', async () => {
    const blocks = [makeBlock({ id: 'BLK001', content: 'Accessible block' })]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations in empty state', async () => {
    const { container } = render(<BlockListRenderer {...makeProps()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── Semantic tree structure tests (UX-48) ───────────────────────────

  it('renders block tree as <ul> with aria-label', () => {
    const blocks = [makeBlock({ id: 'BLK001', content: 'First' })]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const tree = container.querySelector('.block-tree')
    expect(tree).toBeInTheDocument()
    expect(tree?.tagName).toBe('UL')
    expect(tree).toHaveAttribute('aria-label', 'Block tree')
  })

  it('renders each block as <li> with role="listitem"', () => {
    const blocks = [
      makeBlock({ id: 'BLK001', content: 'First' }),
      makeBlock({ id: 'BLK002', content: 'Second' }),
    ]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const items = container.querySelectorAll('li[data-block-id]')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('data-block-id', 'BLK001')
    expect(items[1]).toHaveAttribute('data-block-id', 'BLK002')
  })

  it('sets aria-level (1-based) on each treeitem', () => {
    const blocks = [
      makeBlock({ id: 'ROOT', content: 'Root', depth: 0 }),
      makeBlock({ id: 'CHILD', content: 'Child', depth: 1 }),
      makeBlock({ id: 'GRANDCHILD', content: 'Grandchild', depth: 2 }),
    ]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const items = container.querySelectorAll('li[data-block-id]')
    expect(items[0]).toHaveAttribute('aria-level', '1')
    expect(items[1]).toHaveAttribute('aria-level', '2')
    expect(items[2]).toHaveAttribute('aria-level', '3')
  })

  it('sets aria-setsize and aria-posinset for sibling groups', () => {
    const blocks = [
      makeBlock({ id: 'A', content: 'A', depth: 0 }),
      makeBlock({ id: 'B', content: 'B', depth: 1 }),
      makeBlock({ id: 'C', content: 'C', depth: 1 }),
      makeBlock({ id: 'D', content: 'D', depth: 0 }),
    ]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const items = container.querySelectorAll('li[data-block-id]')
    // A and D are root siblings (setsize=2)
    expect(items[0]).toHaveAttribute('aria-setsize', '2')
    expect(items[0]).toHaveAttribute('aria-posinset', '1')
    expect(items[3]).toHaveAttribute('aria-setsize', '2')
    expect(items[3]).toHaveAttribute('aria-posinset', '2')
    // B and C are children of A (setsize=2)
    expect(items[1]).toHaveAttribute('aria-setsize', '2')
    expect(items[1]).toHaveAttribute('aria-posinset', '1')
    expect(items[2]).toHaveAttribute('aria-setsize', '2')
    expect(items[2]).toHaveAttribute('aria-posinset', '2')
  })

  it('sets aria-expanded on blocks with children', () => {
    const blocks = [
      makeBlock({ id: 'PARENT', content: 'Parent', depth: 0 }),
      makeBlock({ id: 'CHILD', content: 'Child', depth: 1 }),
      makeBlock({ id: 'LEAF', content: 'Leaf', depth: 0 }),
    ]
    const { container } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: blocks,
          blocks,
          hasChildrenSet: new Set(['PARENT']),
          collapsedIds: new Set<string>(),
        })}
      />,
    )

    const items = container.querySelectorAll('li[data-block-id]')
    // Parent has children → aria-expanded="true" (not collapsed)
    expect(items[0]).toHaveAttribute('aria-expanded', 'true')
    // Child has no children → no aria-expanded
    expect(items[1]).not.toHaveAttribute('aria-expanded')
    // Leaf has no children → no aria-expanded
    expect(items[2]).not.toHaveAttribute('aria-expanded')
  })

  it('sets aria-expanded="false" on collapsed blocks', () => {
    const blocks = [makeBlock({ id: 'PARENT', content: 'Parent', depth: 0 })]
    const { container } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: blocks,
          blocks,
          hasChildrenSet: new Set(['PARENT']),
          collapsedIds: new Set(['PARENT']),
        })}
      />,
    )

    const item = container.querySelector('li[data-block-id]')
    expect(item).toHaveAttribute('aria-expanded', 'false')
  })

  it('applies list-style reset classes to ul and li', () => {
    const blocks = [makeBlock({ id: 'BLK001', content: 'Test' })]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    const tree = container.querySelector('.block-tree')
    expect(tree?.className).toContain('list-none')
    expect(tree?.className).toContain('m-0')
    expect(tree?.className).toContain('p-0')
  })

  it('has no a11y violations with nested tree structure', async () => {
    const blocks = [
      makeBlock({ id: 'PARENT', content: 'Parent block', depth: 0 }),
      makeBlock({ id: 'CHILD1', content: 'Child 1', depth: 1 }),
      makeBlock({ id: 'CHILD2', content: 'Child 2', depth: 1 }),
      makeBlock({ id: 'SIBLING', content: 'Sibling block', depth: 0 }),
    ]
    const { container } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: blocks,
          blocks,
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── Expand animation tests (UX-79) ─────────────────────────────────

  it('applies block-children-enter class to children of a just-expanded block', () => {
    const parent = makeBlock({ id: 'PARENT', content: 'Parent', depth: 0 })
    const child1 = makeBlock({ id: 'CHILD1', content: 'Child 1', depth: 1 })
    const child2 = makeBlock({ id: 'CHILD2', content: 'Child 2', depth: 1 })
    const allBlocks = [parent, child1, child2]

    // Initially collapsed — only parent visible
    const { rerender } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: [parent],
          blocks: allBlocks,
          collapsedIds: new Set(['PARENT']),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Expand — children become visible
    rerender(
      <BlockListRenderer
        {...makeProps({
          visibleItems: allBlocks,
          blocks: allBlocks,
          collapsedIds: new Set<string>(),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Children should have the animation class
    const child1Wrapper = screen.getByTestId('sortable-block-CHILD1').parentElement as HTMLElement
    const child2Wrapper = screen.getByTestId('sortable-block-CHILD2').parentElement as HTMLElement
    expect(child1Wrapper).toHaveClass('block-children-enter')
    expect(child2Wrapper).toHaveClass('block-children-enter')

    // Parent should NOT have the animation class
    const parentWrapper = screen.getByTestId('sortable-block-PARENT').parentElement as HTMLElement
    expect(parentWrapper).not.toHaveClass('block-children-enter')
  })

  it('does not apply animation class on initial render', () => {
    const blocks = [
      makeBlock({ id: 'BLK001', content: 'First', depth: 0 }),
      makeBlock({ id: 'BLK002', content: 'Second', depth: 1 }),
    ]
    render(<BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />)

    const wrapper = screen.getByTestId('sortable-block-BLK002').parentElement as HTMLElement
    expect(wrapper).not.toHaveClass('block-children-enter')
  })

  it('does not apply animation class when collapsing (only on expand)', () => {
    const parent = makeBlock({ id: 'PARENT', content: 'Parent', depth: 0 })
    const child = makeBlock({ id: 'CHILD', content: 'Child', depth: 1 })
    const allBlocks = [parent, child]

    // Start expanded
    const { rerender } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: allBlocks,
          blocks: allBlocks,
          collapsedIds: new Set<string>(),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Collapse — children removed
    rerender(
      <BlockListRenderer
        {...makeProps({
          visibleItems: [parent],
          blocks: allBlocks,
          collapsedIds: new Set(['PARENT']),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Parent should NOT have the animation class
    const parentWrapper = screen.getByTestId('sortable-block-PARENT').parentElement as HTMLElement
    expect(parentWrapper).not.toHaveClass('block-children-enter')
  })

  it('animates deeply nested descendants when expanding', () => {
    const parent = makeBlock({ id: 'PARENT', content: 'Parent', depth: 0 })
    const child = makeBlock({ id: 'CHILD', content: 'Child', depth: 1 })
    const grandchild = makeBlock({ id: 'GRANDCHILD', content: 'Grandchild', depth: 2 })
    const allBlocks = [parent, child, grandchild]

    // Initially collapsed
    const { rerender } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: [parent],
          blocks: allBlocks,
          collapsedIds: new Set(['PARENT']),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Expand
    rerender(
      <BlockListRenderer
        {...makeProps({
          visibleItems: allBlocks,
          blocks: allBlocks,
          collapsedIds: new Set<string>(),
          hasChildrenSet: new Set(['PARENT']),
        })}
      />,
    )

    // Both child and grandchild should animate
    expect(screen.getByTestId('sortable-block-CHILD').parentElement as HTMLElement).toHaveClass(
      'block-children-enter',
    )
    expect(
      screen.getByTestId('sortable-block-GRANDCHILD').parentElement as HTMLElement,
    ).toHaveClass('block-children-enter')
  })

  // ── Sentinel drop zone tests (UX-176) ─────────────────────────────

  it('renders sentinel droppable zone after last block when blocks exist', () => {
    const blocks = [
      makeBlock({ id: 'BLK001', content: 'First' }),
      makeBlock({ id: 'BLK002', content: 'Second' }),
    ]
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    // The sentinel is the last <li> inside the <ul>, with aria-hidden
    const tree = container.querySelector('.block-tree')
    const sentinelLi = tree?.querySelector('li[aria-hidden]')
    expect(sentinelLi).toBeInTheDocument()

    // The sentinel should contain a spacer div
    const spacer = sentinelLi?.querySelector('.min-h-\\[60px\\]')
    expect(spacer).toBeInTheDocument()
  })

  it('does not render sentinel when there are no blocks', () => {
    const { container } = render(
      <BlockListRenderer {...makeProps({ visibleItems: [], blocks: [], loading: false })} />,
    )

    // With no blocks, the empty state renders instead of the ul
    const sentinelLi = container.querySelector('li[aria-hidden]')
    expect(sentinelLi).not.toBeInTheDocument()
  })

  it('does not render sentinel during loading when no visible items', () => {
    const { container } = render(
      <BlockListRenderer
        {...makeProps({ visibleItems: [], blocks: [makeBlock()], loading: true })}
      />,
    )

    const sentinelLi = container.querySelector('li[aria-hidden]')
    expect(sentinelLi).not.toBeInTheDocument()
  })

  it('renders drop indicator in sentinel when overId matches sentinel', () => {
    const blocks = [makeBlock({ id: 'BLK001', content: 'First' })]
    const { container } = render(
      <BlockListRenderer
        {...makeProps({
          visibleItems: blocks,
          blocks,
          activeId: 'BLK001',
          overId: '__drop-after-last__',
          projected: { depth: 0, parentId: null, maxDepth: 0, minDepth: 0 },
        })}
      />,
    )

    const sentinelLi = container.querySelector('li[aria-hidden]')
    expect(sentinelLi).toBeInTheDocument()
    const dropIndicator = sentinelLi?.querySelector('.drop-indicator')
    expect(dropIndicator).toBeInTheDocument()
  })

  // ── PERF-22: O(N) sibling aria walk regression tests ──────────────

  describe('sibling aria walk — pathological structures (PERF-22)', () => {
    it('resets sibling groups when tree returns to a previously-seen depth', () => {
      // ROOT1
      //   CHILD_A (d=1 under ROOT1)
      //     GRAND (d=2 under CHILD_A)
      // ROOT2        ← back to depth 0
      //   CHILD_B  ← depth 1, must group with ROOT2 (not CHILD_A)
      //   CHILD_C  ← also under ROOT2
      const blocks = [
        makeBlock({ id: 'ROOT1', content: 'r1', depth: 0 }),
        makeBlock({ id: 'CHILD_A', content: 'ca', depth: 1 }),
        makeBlock({ id: 'GRAND', content: 'gc', depth: 2 }),
        makeBlock({ id: 'ROOT2', content: 'r2', depth: 0 }),
        makeBlock({ id: 'CHILD_B', content: 'cb', depth: 1 }),
        makeBlock({ id: 'CHILD_C', content: 'cc', depth: 1 }),
      ]
      const { container } = render(
        <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
      )

      const items = container.querySelectorAll('li[data-block-id]')
      // ROOT1 + ROOT2 are the two roots — setsize=2
      expect(items[0]).toHaveAttribute('aria-setsize', '2')
      expect(items[0]).toHaveAttribute('aria-posinset', '1')
      expect(items[3]).toHaveAttribute('aria-setsize', '2')
      expect(items[3]).toHaveAttribute('aria-posinset', '2')

      // CHILD_A is ROOT1's only child — setsize=1
      expect(items[1]).toHaveAttribute('aria-setsize', '1')
      expect(items[1]).toHaveAttribute('aria-posinset', '1')

      // GRAND is CHILD_A's only child — setsize=1
      expect(items[2]).toHaveAttribute('aria-setsize', '1')
      expect(items[2]).toHaveAttribute('aria-posinset', '1')

      // CHILD_B + CHILD_C are ROOT2's children — setsize=2, NOT grouped with CHILD_A
      expect(items[4]).toHaveAttribute('aria-setsize', '2')
      expect(items[4]).toHaveAttribute('aria-posinset', '1')
      expect(items[5]).toHaveAttribute('aria-setsize', '2')
      expect(items[5]).toHaveAttribute('aria-posinset', '2')
    })

    it('handles a deeply nested single chain correctly', () => {
      // A 15-level single-child chain — every block has setsize=1, posinset=1
      const blocks = Array.from({ length: 15 }, (_, i) =>
        makeBlock({ id: `LVL${i}`, content: `level ${i}`, depth: i }),
      )
      const { container } = render(
        <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
      )

      const items = container.querySelectorAll('li[data-block-id]')
      expect(items).toHaveLength(15)
      for (let i = 0; i < items.length; i++) {
        expect(items[i]).toHaveAttribute('aria-level', String(i + 1))
        expect(items[i]).toHaveAttribute('aria-setsize', '1')
        expect(items[i]).toHaveAttribute('aria-posinset', '1')
      }
    })

    it('handles wide sibling groups (20 root blocks) in a single pass', () => {
      const blocks = Array.from({ length: 20 }, (_, i) =>
        makeBlock({ id: `ROOT_${i}`, content: `r${i}`, depth: 0 }),
      )
      const { container } = render(
        <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
      )

      const items = container.querySelectorAll('li[data-block-id]')
      expect(items).toHaveLength(20)
      for (let i = 0; i < 20; i++) {
        expect(items[i]).toHaveAttribute('aria-setsize', '20')
        expect(items[i]).toHaveAttribute('aria-posinset', String(i + 1))
      }
    })

    it('performance smoke: 1000 blocks with varied depth produces correct aria', () => {
      // Alternating depth pattern: 0, 1, 2, 1, 0, 1, 2, 1, ... (repeating chunks of 4)
      // This is a stress test for the O(N) algorithm — it must never crash
      // or produce stale-parent links.
      const blocks: ReturnType<typeof makeBlock>[] = []
      const depths = [0, 1, 2, 1]
      for (let i = 0; i < 1000; i++) {
        const d = depths[i % 4]
        if (d == null) continue
        blocks.push(makeBlock({ id: `BLK_${i}`, content: `b${i}`, depth: d }))
      }

      const { container } = render(
        <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
      )

      const items = container.querySelectorAll('li[data-block-id]')
      expect(items).toHaveLength(1000)

      // Every item must have numeric aria-posinset and aria-setsize ≥ 1.
      for (const el of items) {
        const setsize = Number(el.getAttribute('aria-setsize'))
        const posinset = Number(el.getAttribute('aria-posinset'))
        expect(setsize).toBeGreaterThanOrEqual(1)
        expect(posinset).toBeGreaterThanOrEqual(1)
        expect(posinset).toBeLessThanOrEqual(setsize)
      }

      // Roots (depth 0) all share the same sibling group. With 250 chunks
      // of 4, there are 250 roots — every root's setsize must equal 250.
      const roots = Array.from(items).filter((el) => el.getAttribute('aria-level') === '1')
      expect(roots).toHaveLength(250)
      for (const root of roots) {
        expect(root.getAttribute('aria-setsize')).toBe('250')
      }
    })

    it('matches the documented semantics: nearest preceding block at parent depth', () => {
      // Corner case: orphan depth jump (d=2 with no immediate d=1 parent
      // in the same subtree). The algorithm uses the most recent block at
      // depth-1 seen globally — matching the previous backward-scan.
      //
      //   ROOT      d=0
      //     CHILD   d=1
      //       GC    d=2
      //   R2        d=0
      //     O_GC    d=2  ← orphan; parent resolves to CHILD (stale)
      const blocks = [
        makeBlock({ id: 'ROOT', content: 'r', depth: 0 }),
        makeBlock({ id: 'CHILD', content: 'c', depth: 1 }),
        makeBlock({ id: 'GC', content: 'g', depth: 2 }),
        makeBlock({ id: 'R2', content: 'r2', depth: 0 }),
        makeBlock({ id: 'O_GC', content: 'og', depth: 2 }),
      ]
      const { container } = render(
        <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
      )

      const items = container.querySelectorAll('li[data-block-id]')
      // Two roots (ROOT + R2)
      expect(items[0]).toHaveAttribute('aria-setsize', '2')
      expect(items[3]).toHaveAttribute('aria-setsize', '2')
      // GC and O_GC are both grouped under CHILD (last-seen d=1) — this
      // mirrors the backward-scan oracle and is documented in the code
      // comment; orphan depth jumps in real data never occur, but the
      // algorithm must be deterministic.
      expect(items[2]).toHaveAttribute('aria-setsize', '2')
      expect(items[4]).toHaveAttribute('aria-setsize', '2')
    })
  })
})
