// @vitest-environment jsdom
// #923: the ghost's `paddingLeft` is `calc(var(--indent-width) * N)`. happy-dom's
// CSS parser rejects `var()`/`calc()` so the property never lands — pin to jsdom
// (same rationale as SortableBlockWrapper.test.tsx).

/**
 * Tests for BlockDndOverlay component.
 *
 * Validates:
 *  - Renders the translucent ghost of the dragged row when activeBlock is provided (#923)
 *  - Ghost shows the dragged block's content text at the projected indent
 *  - Ghost renders rich content, so a [[ULID]] page link is a titled pill and
 *    never a raw ULID, and the chip stays inert inside the aria-hidden ghost
 *    (#4706)
 *  - Ghost stays non-collapsing for an empty block (#4706)
 *  - Subtree drag shows the count badge
 *  - Forwards a drop-settle animation to DragOverlay (not null) (#923)
 *  - Renders nothing inside DragOverlay when activeBlock is null
 *  - Renders SR live region when activeId + projected are set
 *  - Does not render SR live region when activeId is null
 *  - Axe a11y audit passes
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock @dnd-kit/core DragOverlay as a transparent wrapper that records the
// dropAnimation prop so we can assert the ghost gets a settle animation (#923).
const dropAnimationCalls: Array<unknown> = []
vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({
    children,
    dropAnimation,
  }: {
    children: React.ReactNode
    dropAnimation?: unknown
  }) => {
    dropAnimationCalls.push(dropAnimation)
    return <div data-testid="drag-overlay">{children}</div>
  },
}))

const LINKED_PAGE_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) =>
      id === LINKED_PAGE_ID ? 'Quarterly Plan' : undefined,
    ),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

import { BlockDndOverlay } from '@/components/block-tree/BlockDndOverlay'

describe('BlockDndOverlay', () => {
  it('renders the ghost when activeBlock is provided', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 1 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay')).toBeInTheDocument()
  })

  it('ghost renders the dragged block content text (#923)', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 1 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay')).toHaveTextContent('Hello world')
  })

  // #4706 — the ghost used to print `activeBlock.content` verbatim, so a block
  // holding a page link dragged as a raw `[[ULID]]` token.
  it('ghost renders a [[ULID]] page link as a resolved pill, not a raw ULID', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: `follow up on [[${LINKED_PAGE_ID}]]` }}
        projected={{ depth: 0 }}
        activeId="BLK001"
      />,
    )

    const ghost = screen.getByTestId('sortable-block-overlay')
    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toHaveTextContent('Quarterly Plan')
    expect(ghost.textContent).not.toContain(LINKED_PAGE_ID)
    // `interactive: false` — the ghost is `aria-hidden`, so a chip that took
    // `tabIndex=0` would be a focusable node inside hidden content (axe
    // `aria-hidden-focus`), on top of duplicating the row's own tab stop.
    expect(chip).not.toHaveAttribute('tabindex')
  })

  it('ghost keeps a non-collapsing box for an empty block', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: '   ' }}
        projected={{ depth: 0 }}
        activeId="BLK001"
      />,
    )

    // A non-breaking space, so the translucent box keeps its line height.
    expect(screen.getByTestId('sortable-block-overlay').textContent).toBe('\u00A0')
  })

  it('ghost indents by the projected depth via --indent-width (#923)', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Nested' }}
        projected={{ depth: 2 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay').style.paddingLeft).toBe(
      'calc(var(--indent-width) * 2)',
    )
  })

  it('forwards a drop-settle animation (not null) to DragOverlay (#923)', () => {
    dropAnimationCalls.length = 0
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 0 }}
        activeId="BLK001"
      />,
    )

    const anim = dropAnimationCalls.at(-1) as {
      duration?: number
    } | null
    expect(anim).not.toBeNull()
    expect(typeof anim?.duration).toBe('number')
  })

  it('renders nothing inside DragOverlay when activeBlock is null', () => {
    render(<BlockDndOverlay activeBlock={null} projected={null} activeId={null} />)

    expect(screen.queryByTestId('sortable-block-overlay')).not.toBeInTheDocument()
  })

  it('renders SR live region when activeId and projected are set', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Block' }}
        projected={{ depth: 2 }}
        activeId="BLK001"
      />,
    )

    const srRegion = screen.getByRole('status')
    expect(srRegion).toHaveTextContent('Moving to depth 2')
    expect(srRegion).toHaveClass('sr-only')
  })

  it('announces a subtree drag via i18n (pluralised) — #1727', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Parent' }}
        projected={{ depth: 3 }}
        activeId="BLK001"
        count={4}
      />,
    )

    // Routed through t('blockTree.dnd.movingSubtree', { count, depth }); the
    // en plural form is "Moving {{count}} blocks to depth {{depth}}".
    expect(screen.getByRole('status')).toHaveTextContent('Moving 4 blocks to depth 3')
  })

  it('shows the count badge for a subtree drag (count > 1)', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Parent' }}
        projected={{ depth: 0 }}
        activeId="BLK001"
        count={3}
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay-count')).toHaveTextContent('3')
  })

  it('omits the count badge for a single-block drag (count = 1)', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Leaf' }}
        projected={{ depth: 0 }}
        activeId="BLK001"
        count={1}
      />,
    )

    expect(screen.queryByTestId('sortable-block-overlay-count')).not.toBeInTheDocument()
  })

  it('does not render SR live region when activeId is null', () => {
    render(<BlockDndOverlay activeBlock={null} projected={null} activeId={null} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <BlockDndOverlay
        activeBlock={{ content: 'Test block' }}
        projected={{ depth: 0 }}
        activeId="BLK001"
      />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when inactive', async () => {
    const { container } = render(
      <BlockDndOverlay activeBlock={null} projected={null} activeId={null} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
