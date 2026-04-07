/**
 * Tests for BlockDndOverlay component.
 *
 * Validates:
 *  - Renders drag overlay when activeBlock is provided
 *  - Renders nothing inside DragOverlay when activeBlock is null
 *  - Renders SR live region when activeId + projected are set
 *  - Does not render SR live region when activeId is null
 *  - Truncates long content to 80 chars
 *  - Shows "Empty block" for blocks with empty content
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
  it('renders the overlay preview when activeBlock is provided', () => {
    render(
      <BlockDndOverlay
        activeBlock={{ content: 'Hello world' }}
        projected={{ depth: 1 }}
        activeId="BLK001"
      />,
    )

    expect(screen.getByTestId('sortable-block-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-overlay')).toHaveTextContent('Hello world')
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

  it('truncates content longer than 80 chars', () => {
    const longContent = 'A'.repeat(120)
    render(
      <BlockDndOverlay activeBlock={{ content: longContent }} projected={null} activeId="BLK001" />,
    )

    const overlay = screen.getByTestId('sortable-block-overlay')
    expect(overlay.textContent).toHaveLength(80)
  })

  it('shows "Empty block" for blocks with empty content', () => {
    render(<BlockDndOverlay activeBlock={{ content: '' }} projected={null} activeId="BLK001" />)

    expect(screen.getByTestId('sortable-block-overlay')).toHaveTextContent('Empty block')
  })

  it('shows "Empty block" for blocks with null content', () => {
    render(<BlockDndOverlay activeBlock={{ content: null }} projected={null} activeId="BLK001" />)

    expect(screen.getByTestId('sortable-block-overlay')).toHaveTextContent('Empty block')
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
