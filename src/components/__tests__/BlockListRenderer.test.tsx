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

import { BlockListRenderer } from '../BlockListRenderer'

const noop = () => {}
const resolveActive = () => 'active' as const

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
      observeRef: vi.fn(),
      getHeight: () => 40,
    },
    rovingEditor: {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    } as never,
    onNavigate: noop,
    onDelete: noop,
    onIndent: noop,
    onDedent: noop,
    onMoveUp: noop,
    onMoveDown: noop,
    onMerge: noop,
    onToggleTodo: noop,
    onTogglePriority: noop,
    onToggleCollapse: noop,
    onShowHistory: noop,
    onShowProperties: noop,
    onZoomIn: noop,
    onSelect: noop,
    onContainerPointerDown: noop,
    resolveBlockTitle: (id: string) => id,
    resolveTagName: (id: string) => id,
    resolveBlockStatus: resolveActive,
    resolveTagStatus: resolveActive,
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
})
