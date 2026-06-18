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

import { BlockDndOverlay } from '../block-tree/BlockDndOverlay'

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

    const anim = dropAnimationCalls[dropAnimationCalls.length - 1] as {
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
