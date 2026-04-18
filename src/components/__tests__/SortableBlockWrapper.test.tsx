/**
 * Tests for SortableBlockWrapper component (MAINT-55).
 *
 * Validates the per-row branching that was extracted from
 * BlockListRenderer:
 *  - Virtualized placeholder when offscreen and not focused
 *  - Full render (with SortableBlock) when focused, even if offscreen
 *  - Full render when onscreen
 *  - aria-level / aria-setsize / aria-posinset / aria-expanded
 *  - Drop indicator visibility (projected + overId + activeId)
 *  - Animation class gating on isAnimating
 *  - onZoomIn passed through only when hasChildren is true
 *  - axe a11y
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'

// Mock SortableBlock — record props so we can assert on them
const sortableBlockProps: Array<Record<string, unknown>> = []

vi.mock('../SortableBlock', () => ({
  SortableBlock: (props: Record<string, unknown>) => {
    sortableBlockProps.push(props)
    return (
      <button
        type="button"
        data-testid={`sortable-block-${props['blockId']}`}
        data-has-zoom-in={props['onZoomIn'] != null ? 'yes' : 'no'}
        data-depth={String(props['depth'])}
        data-is-selected={String(props['isSelected'])}
      >
        SortableBlock {String(props['blockId'])}
      </button>
    )
  },
  INDENT_WIDTH: 24,
}))

import { SortableBlockWrapper } from '../SortableBlockWrapper'

const noop = () => {}
const resolveActive = () => 'active' as const

/** Minimal props for SortableBlockWrapper — overrides merge on top. */
function makeProps(
  overrides: Partial<React.ComponentProps<typeof SortableBlockWrapper>> = {},
): React.ComponentProps<typeof SortableBlockWrapper> {
  return {
    block: makeBlock({ id: 'BLK001', content: 'Hello', depth: 0 }),
    focusedBlockId: null,
    isSelected: false,
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
    hasChildren: false,
    anyBlockHasChildren: false,
    isCollapsed: false,
    isAnimating: false,
    siblingAria: { setsize: 1, posinset: 1 },
    properties: undefined,
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
    resolveBlockTitle: (id: string) => id,
    resolveTagName: (id: string) => id,
    resolveBlockStatus: resolveActive,
    resolveTagStatus: resolveActive,
    ...overrides,
  }
}

/** Each test must wrap the <li> in a <ul> to satisfy DOM semantics. */
function renderInList(
  props: React.ComponentProps<typeof SortableBlockWrapper>,
): ReturnType<typeof render> {
  return render(
    <ul>
      <SortableBlockWrapper {...props} />
    </ul>,
  )
}

describe('SortableBlockWrapper', () => {
  beforeEach(() => {
    sortableBlockProps.length = 0
  })

  it('renders full SortableBlock when onscreen', () => {
    const { container } = renderInList(makeProps())

    expect(screen.getByTestId('sortable-block-BLK001')).toBeInTheDocument()
    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toBeInTheDocument()
    expect(li?.classList.contains('block-placeholder')).toBe(false)
  })

  it('renders virtualized placeholder when offscreen and not focused', () => {
    const viewport = {
      isOffscreen: (id: string) => id === 'BLK001',
      createObserveRef: () => vi.fn(),
      getHeight: () => 120,
    }
    const { container } = renderInList(makeProps({ viewport }))

    expect(screen.queryByTestId('sortable-block-BLK001')).not.toBeInTheDocument()
    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toBeInTheDocument()
    expect(li?.classList.contains('block-placeholder')).toBe(true)
    expect((li as HTMLElement).style.minHeight).toBe('120px')
  })

  it('renders full SortableBlock when focused, even if reported offscreen', () => {
    const viewport = {
      isOffscreen: () => true,
      createObserveRef: () => vi.fn(),
      getHeight: () => 120,
    }
    const { container } = renderInList(makeProps({ viewport, focusedBlockId: 'BLK001' }))

    // Focused block is never virtualized
    expect(screen.getByTestId('sortable-block-BLK001')).toBeInTheDocument()
    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.classList.contains('block-placeholder')).toBe(false)
  })

  it('sets aria-level, aria-setsize, and aria-posinset from props', () => {
    const block = makeBlock({ id: 'BLK001', depth: 2 })
    const { container } = renderInList(
      makeProps({
        block,
        siblingAria: { setsize: 5, posinset: 3 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toHaveAttribute('aria-level', '3') // depth 2 → level 3
    expect(li).toHaveAttribute('aria-setsize', '5')
    expect(li).toHaveAttribute('aria-posinset', '3')
  })

  it('omits aria-setsize / aria-posinset when siblingAria is undefined', () => {
    const { container } = renderInList(makeProps({ siblingAria: undefined }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).not.toHaveAttribute('aria-setsize')
    expect(li).not.toHaveAttribute('aria-posinset')
  })

  it('sets aria-expanded="true" when hasChildren and not collapsed', () => {
    const { container } = renderInList(makeProps({ hasChildren: true, isCollapsed: false }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toHaveAttribute('aria-expanded', 'true')
  })

  it('sets aria-expanded="false" when hasChildren and collapsed', () => {
    const { container } = renderInList(makeProps({ hasChildren: true, isCollapsed: true }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toHaveAttribute('aria-expanded', 'false')
  })

  it('omits aria-expanded when hasChildren is false', () => {
    const { container } = renderInList(makeProps({ hasChildren: false }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).not.toHaveAttribute('aria-expanded')
  })

  it('sets aria-expanded on placeholder as well when offscreen', () => {
    const viewport = {
      isOffscreen: () => true,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
    }
    const { container } = renderInList(
      makeProps({ viewport, hasChildren: true, isCollapsed: true }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.classList.contains('block-placeholder')).toBe(true)
    expect(li).toHaveAttribute('aria-expanded', 'false')
  })

  it('applies block-children-enter class when isAnimating', () => {
    const { container } = renderInList(makeProps({ isAnimating: true }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toHaveClass('block-children-enter')
  })

  it('does not apply animation class when not animating', () => {
    const { container } = renderInList(makeProps({ isAnimating: false }))

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).not.toHaveClass('block-children-enter')
  })

  it('renders drop indicator when over-this-block and not the active drag target', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK001',
        projected: { depth: 2, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const indicators = container.querySelectorAll('.drop-indicator')
    expect(indicators).toHaveLength(1)
    expect((indicators[0] as HTMLElement).style.marginLeft).toBe('calc(var(--indent-width) * 2)')
  })

  it('does not render drop indicator when this block is the active drag target', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK001',
        overId: 'BLK001',
        projected: { depth: 1, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    expect(container.querySelectorAll('.drop-indicator')).toHaveLength(0)
  })

  it('does not render drop indicator when overId does not match this block', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK002',
        overId: 'BLK003',
        projected: { depth: 1, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    expect(container.querySelectorAll('.drop-indicator')).toHaveLength(0)
  })

  it('does not render drop indicator when projected is null', () => {
    const { container } = renderInList(
      makeProps({ activeId: 'BLK999', overId: 'BLK001', projected: null }),
    )

    expect(container.querySelectorAll('.drop-indicator')).toHaveLength(0)
  })

  it('passes onZoomIn to SortableBlock only when hasChildren is true', () => {
    renderInList(makeProps({ hasChildren: true }))

    expect(sortableBlockProps).toHaveLength(1)
    const lastProps = sortableBlockProps[0]
    expect(lastProps).toBeDefined()
    expect(lastProps?.['onZoomIn']).toBeTypeOf('function')
  })

  it('does not pass onZoomIn when hasChildren is false', () => {
    renderInList(makeProps({ hasChildren: false }))

    expect(sortableBlockProps).toHaveLength(1)
    const lastProps = sortableBlockProps[0]
    expect(lastProps).toBeDefined()
    expect(lastProps?.['onZoomIn']).toBeUndefined()
  })

  it('uses projected depth for the active drag target', () => {
    const block = makeBlock({ id: 'BLK001', depth: 0 })
    renderInList(
      makeProps({
        block,
        activeId: 'BLK001',
        overId: 'BLK001',
        projected: { depth: 3, parentId: null, maxDepth: 5, minDepth: 0 },
      }),
    )

    expect(sortableBlockProps).toHaveLength(1)
    const lastProps = sortableBlockProps[0]
    expect(lastProps).toBeDefined()
    expect(lastProps?.['depth']).toBe(3)
  })

  it('uses block.depth when this block is not being dragged', () => {
    const block = makeBlock({ id: 'BLK001', depth: 1 })
    renderInList(
      makeProps({
        block,
        activeId: 'BLK_OTHER',
        overId: 'BLK_OTHER',
        projected: { depth: 3, parentId: null, maxDepth: 5, minDepth: 0 },
      }),
    )

    expect(sortableBlockProps).toHaveLength(1)
    const lastProps = sortableBlockProps[0]
    expect(lastProps).toBeDefined()
    expect(lastProps?.['depth']).toBe(1)
  })

  it('forwards isSelected as a pass-through prop', () => {
    renderInList(makeProps({ isSelected: true }))

    expect(sortableBlockProps).toHaveLength(1)
    const lastProps = sortableBlockProps[0]
    expect(lastProps).toBeDefined()
    expect(lastProps?.['isSelected']).toBe(true)
  })

  it('forwards properties array to SortableBlock', () => {
    const props = [{ key: 'effort', value: '3h' }]
    renderInList(makeProps({ properties: props }))

    expect(sortableBlockProps).toHaveLength(1)
    expect(sortableBlockProps[0]?.['properties']).toEqual(props)
  })

  it('forwards onNavigate callback invocation via SortableBlock prop', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderInList(makeProps({ onNavigate }))

    // The mock SortableBlock exposes onNavigate as a prop; invoke it directly
    expect(sortableBlockProps).toHaveLength(1)
    const invokedNavigate = sortableBlockProps[0]?.['onNavigate'] as (id: string) => void
    expect(invokedNavigate).toBeTypeOf('function')
    invokedNavigate('BLK001')
    expect(onNavigate).toHaveBeenCalledWith('BLK001')

    // Click the rendered button too to ensure the DOM is interactive
    await user.click(screen.getByTestId('sortable-block-BLK001'))
  })

  it('has no a11y violations in the full render path', async () => {
    const { container } = renderInList(
      makeProps({
        hasChildren: true,
        siblingAria: { setsize: 2, posinset: 1 },
      }),
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations in the virtualized placeholder path', async () => {
    const viewport = {
      isOffscreen: () => true,
      createObserveRef: () => vi.fn(),
      getHeight: () => 80,
    }
    const { container } = renderInList(
      makeProps({
        viewport,
        hasChildren: true,
        isCollapsed: false,
        siblingAria: { setsize: 1, posinset: 1 },
      }),
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
