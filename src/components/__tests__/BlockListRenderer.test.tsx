/**
 * Tests for BlockListRenderer component.
 *
 * Validates:
 *  - Smoke render with blocks
 *  - Renders empty state when blocks array is empty
 *  - Renders SortableBlock for each visible item
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
})
