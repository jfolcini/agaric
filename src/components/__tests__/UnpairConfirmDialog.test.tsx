/**
 * Tests for UnpairConfirmDialog — shared confirmation dialog (#301).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { UnpairConfirmDialog } from '../UnpairConfirmDialog'

describe('UnpairConfirmDialog', () => {
  it('renders nothing when not open', () => {
    render(<UnpairConfirmDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.queryByText('Unpair device?')).not.toBeInTheDocument()
  })

  it('renders title and description when open', () => {
    render(<UnpairConfirmDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will remove the pairing with the paired device. You will need to pair again to sync.',
      ),
    ).toBeInTheDocument()
  })

  it('calls onConfirm when "Yes, unpair" is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<UnpairConfirmDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: /Yes, unpair/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<UnpairConfirmDialog open={true} onOpenChange={onOpenChange} onConfirm={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has no a11y violations', async () => {
    render(<UnpairConfirmDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })
})
