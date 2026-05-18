/**
 * Tests for BlockDndOverlay component.
 *
 * Validates:
 *  - Renders the tiny cursor-following marker when activeBlock is provided
 *  - Marker is empty (no content) so list reflow is visible underneath
 *  - Renders nothing inside DragOverlay when activeBlock is null
 *  - Renders SR live region when activeId + projected are set
 *  - Does not render SR live region when activeId is null
 *  - Axe a11y audit passes
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock @dnd-kit/core DragOverlay as a transparent wrapper
vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
}))

import { BlockDndOverlay } from '../block-tree/BlockDndOverlay'

describe('BlockDndOverlay', () => {
  it('renders the marker when activeBlock is provided', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 1 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay')).toBeInTheDocument()
  })

  it('marker has no text content (so list reflow stays visible)', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 1 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay').textContent).toBe('')
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
