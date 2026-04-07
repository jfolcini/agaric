/**
 * Tests for BlockPropertyDrawerSheet component.
 *
 * Validates:
 *  - Renders content when open=true and blockId is set
 *  - Does not render content when open=false
 *  - Does not render block-specific content when blockId is null
 *  - Calls onOpenChange when closed
 *  - Axe a11y audit passes
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../BlockPropertyDrawer', () => ({
  BlockPropertyDrawer: ({
    blockId,
    open,
    onOpenChange,
  }: {
    blockId: string | null
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div data-testid="property-drawer">
        {blockId && <span data-testid="property-block-id">{blockId}</span>}
        <button type="button" onClick={() => onOpenChange(false)}>
          Close
        </button>
      </div>
    ) : null,
}))

import { BlockPropertyDrawerSheet } from '../BlockPropertyDrawerSheet'

describe('BlockPropertyDrawerSheet', () => {
  it('renders content when open=true and blockId is set', () => {
    render(<BlockPropertyDrawerSheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('property-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('property-block-id')).toHaveTextContent('BLOCK_1')
  })

  it('does not render content when open=false', () => {
    render(<BlockPropertyDrawerSheet blockId="BLOCK_1" open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('property-drawer')).not.toBeInTheDocument()
  })

  it('does not render block ID when blockId is null', () => {
    render(<BlockPropertyDrawerSheet blockId={null} open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('property-drawer')).toBeInTheDocument()
    expect(screen.queryByTestId('property-block-id')).not.toBeInTheDocument()
  })

  it('calls onOpenChange(false) when close is triggered', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<BlockPropertyDrawerSheet blockId="BLOCK_1" open={true} onOpenChange={onOpenChange} />)

    await user.click(screen.getByRole('button', { name: /close/i }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(
      <BlockPropertyDrawerSheet blockId="BLOCK_1" open={true} onOpenChange={vi.fn()} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
