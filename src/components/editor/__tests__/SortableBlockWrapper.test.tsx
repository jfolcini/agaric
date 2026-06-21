// @vitest-environment jsdom
// Drop-indicator assertion reads `style.marginLeft` which contains
// `calc(var(--indent-width) * N)`. happy-dom's CSS parser rejects `var()` and
// `calc()` so the property never lands. Pin to jsdom.

/**
 * Tests for SortableBlockWrapper component.
 *
 * Validates the per-row branching that was extracted from
 * BlockListRenderer:
 *  - Virtualized placeholder when offscreen and not focused
 *  - Full render (with SortableBlock) when focused, even if offscreen
 *  - Full render when onscreen
 *  - aria-level / aria-setsize / aria-posinset / aria-expanded
 *  - Drop indicator visibility (projected + overId + activeId)
 *  - Animation class gating on isAnimating
 *  - axe a11y
 *
 * Per-block action callbacks and reference resolvers no longer flow
 * Through SortableBlockWrapper as props — they're published
 * via `BlockActionsProvider` / `BlockResolversProvider`. The tests
 * covering callback gating live with SortableBlock now.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'

// Mock SortableBlock — record props so we can assert on them
const sortableBlockProps: Array<Record<string, unknown>> = []

vi.mock('../SortableBlock', () => ({
  SortableBlock: (props: Record<string, unknown>) => {
    sortableBlockProps.push(props)
    return (
      <button
        type="button"
        data-testid={`sortable-block-${props['blockId']}`}
        data-depth={String(props['depth'])}
        data-is-selected={String(props['isSelected'])}
      >
        SortableBlock {String(props['blockId'])}
      </button>
    )
  },
  INDENT_WIDTH: 24,
}))

import { SortableBlockWrapper } from '@/components/editor/SortableBlockWrapper'

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
    dropAfter: false,
    viewport: {
      isOffscreen: () => false,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
      // #1067 — wrappers read offscreen state via useSyncExternalStore; these
      // static mocks never flip, so subscribe is a no-op returning unsubscribe.
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
    hasChildren: false,
    isCollapsed: false,
    isAnimating: false,
    siblingSetsize: 1,
    siblingPosinset: 1,
    properties: undefined,
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
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
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
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
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
        siblingSetsize: 5,
        siblingPosinset: 3,
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li).toHaveAttribute('aria-level', '3') // depth 2 → level 3
    expect(li).toHaveAttribute('aria-setsize', '5')
    expect(li).toHaveAttribute('aria-posinset', '3')
  })

  it('omits aria-setsize / aria-posinset when sibling props are undefined', () => {
    const { container } = renderInList(
      makeProps({ siblingSetsize: undefined, siblingPosinset: undefined }),
    )

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
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
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

  it('renders the drop indicator ABOVE the row when dropAfter is false (#923)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK001',
        dropAfter: false,
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    const indicatorEl = li?.querySelector('.drop-indicator')
    const blockEl = container.querySelector('[data-testid="sortable-block-BLK001"]')
    expect(indicatorEl).toBeInTheDocument()
    expect(blockEl).toBeInTheDocument()
    // DOCUMENT_POSITION_FOLLOWING (4) means blockEl comes after indicatorEl.
    expect(indicatorEl?.compareDocumentPosition(blockEl as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('renders the drop indicator BELOW the row when dropAfter is true (#923)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK001',
        dropAfter: true,
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    const indicatorEl = li?.querySelector('.drop-indicator')
    const blockEl = container.querySelector('[data-testid="sortable-block-BLK001"]')
    expect(indicatorEl).toBeInTheDocument()
    expect(blockEl).toBeInTheDocument()
    // DOCUMENT_POSITION_PRECEDING (2) means blockEl comes before indicatorEl.
    expect(indicatorEl?.compareDocumentPosition(blockEl as Node)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    )
  })

  it('keeps the projected indent on the indicator regardless of placement (#923)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK001',
        dropAfter: true,
        projected: { depth: 2, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const indicator = container.querySelector('.drop-indicator') as HTMLElement
    expect(indicator.style.marginLeft).toBe('calc(var(--indent-width) * 2)')
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

  // ── #991 — committed row-level drop-over tint ──────────────────────

  it('tints the over-row with bg-primary/8 when showDropIndicator is true (#991)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK001',
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.className).toContain('bg-primary/8')
    // Must NOT add a left border that would collide with the focused block's
    // inset-shadow accent.
    expect(li?.className).not.toContain('border-l')
  })

  it('tints the over-row independent of focus state (#991)', () => {
    const { container } = renderInList(
      makeProps({
        focusedBlockId: 'BLK001',
        activeId: 'BLK999',
        overId: 'BLK001',
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.className).toContain('bg-primary/8')
  })

  it('does not tint the row when it is the active drag target (#991)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK001',
        overId: 'BLK001',
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.className).not.toContain('bg-primary/8')
  })

  it('does not tint the row when it is not the over-target (#991)', () => {
    const { container } = renderInList(
      makeProps({
        activeId: 'BLK999',
        overId: 'BLK_OTHER',
        projected: { depth: 0, parentId: null, maxDepth: 3, minDepth: 0 },
      }),
    )

    const li = container.querySelector('li[data-block-id="BLK001"]')
    expect(li?.className).not.toContain('bg-primary/8')
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

  it('previews projected depth on the dragged row even when hovering a DIFFERENT block (B3, #217)', () => {
    // The active drag row used to keep its original depth while the cursor was
    // over another block — only the drop indicator hinted at the landing depth.
    // B3 makes the lifted row itself reflect `projected.depth` so the indent is
    // legible during the drag, regardless of which block is the over-target.
    const block = makeBlock({ id: 'BLK001', depth: 0 })
    renderInList(
      makeProps({
        block,
        activeId: 'BLK001',
        overId: 'BLK_OTHER', // hovering a different row
        projected: { depth: 2, parentId: null, maxDepth: 5, minDepth: 0 },
      }),
    )

    expect(sortableBlockProps).toHaveLength(1)
    expect(sortableBlockProps[0]?.['depth']).toBe(2)
  })

  it('keeps block.depth on the dragged row when there is no projection', () => {
    const block = makeBlock({ id: 'BLK001', depth: 1 })
    renderInList(
      makeProps({
        block,
        activeId: 'BLK001',
        overId: 'BLK_OTHER',
        projected: null,
      }),
    )

    expect(sortableBlockProps).toHaveLength(1)
    expect(sortableBlockProps[0]?.['depth']).toBe(1)
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

  it('has no a11y violations in the full render path', async () => {
    const { container } = renderInList(
      makeProps({
        hasChildren: true,
        siblingSetsize: 2,
        siblingPosinset: 1,
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
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
    }
    const { container } = renderInList(
      makeProps({
        viewport,
        hasChildren: true,
        isCollapsed: false,
        siblingSetsize: 1,
        siblingPosinset: 1,
      }),
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
