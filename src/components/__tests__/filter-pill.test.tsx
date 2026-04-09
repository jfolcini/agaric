/**
 * Tests for the FilterPill UI component.
 *
 * Validates:
 *  - Renders label text
 *  - Renders remove button with correct aria-label
 *  - Click remove button calls onRemove
 *  - Delete key on remove button calls onRemove
 *  - Backspace key on remove button calls onRemove
 *  - Passes className to Badge
 *  - Passes title to Badge when provided
 *  - groupAriaLabel overrides default aria-label
 *  - axe accessibility audit
 *  - Touch target (remove button has touch-target class)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { FilterPill } from '../ui/filter-pill'

const defaultProps = {
  label: 'status = TODO',
  onRemove: vi.fn(),
  removeAriaLabel: 'Remove filter status = TODO',
}

describe('FilterPill', () => {
  it('renders label text', () => {
    render(<FilterPill {...defaultProps} />)

    expect(screen.getByText('status = TODO')).toBeInTheDocument()
  })

  it('renders remove button with correct aria-label', () => {
    render(<FilterPill {...defaultProps} />)

    expect(screen.getByLabelText('Remove filter status = TODO')).toBeInTheDocument()
  })

  it('renders a group with aria-label defaulting to label', () => {
    render(<FilterPill {...defaultProps} />)

    expect(screen.getByRole('group', { name: 'status = TODO' })).toBeInTheDocument()
  })

  it('calls onRemove when remove button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    await user.click(screen.getByLabelText('Remove filter status = TODO'))

    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('calls onRemove on Delete key press on remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByLabelText('Remove filter status = TODO')
    removeBtn.focus()
    await user.keyboard('{Delete}')

    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('calls onRemove on Backspace key press on remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByLabelText('Remove filter status = TODO')
    removeBtn.focus()
    await user.keyboard('{Backspace}')

    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('does not call onRemove for other keys', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByLabelText('Remove filter status = TODO')
    removeBtn.focus()
    await user.keyboard('{Enter}')

    // Enter fires a click on buttons, so onRemove is called via click handler
    // But other keys like 'a' should not call onRemove via keydown
    onRemove.mockClear()
    await user.keyboard('a')

    expect(onRemove).not.toHaveBeenCalled()
  })

  it('passes className to Badge', () => {
    render(<FilterPill {...defaultProps} className="my-custom-class" />)

    const group = screen.getByRole('group', { name: 'status = TODO' })
    expect(group.className).toContain('my-custom-class')
  })

  it('passes title to Badge when provided', () => {
    render(<FilterPill {...defaultProps} title="Full tooltip text" />)

    const group = screen.getByRole('group', { name: 'status = TODO' })
    expect(group).toHaveAttribute('title', 'Full tooltip text')
  })

  it('does not render title attribute when not provided', () => {
    render(<FilterPill {...defaultProps} />)

    const group = screen.getByRole('group', { name: 'status = TODO' })
    expect(group).not.toHaveAttribute('title')
  })

  it('uses groupAriaLabel when provided', () => {
    render(<FilterPill {...defaultProps} groupAriaLabel="Filter: status = TODO" />)

    expect(screen.getByRole('group', { name: 'Filter: status = TODO' })).toBeInTheDocument()
  })

  it('has filter-pill class on the badge', () => {
    render(<FilterPill {...defaultProps} />)

    const group = screen.getByRole('group', { name: 'status = TODO' })
    expect(group.className).toContain('filter-pill')
  })

  it('remove button has touch-target class for coarse pointer support', () => {
    render(<FilterPill {...defaultProps} />)

    const removeBtn = screen.getByLabelText('Remove filter status = TODO')
    expect(removeBtn.className).toContain('touch-target')
  })

  describe('a11y', () => {
    it('has no a11y violations', async () => {
      const { container } = render(<FilterPill {...defaultProps} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with title', async () => {
      const { container } = render(<FilterPill {...defaultProps} title="status = TODO" />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
