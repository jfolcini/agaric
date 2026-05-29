/**
 * Tests for the FilterPill UI primitive.
 *
 * Validates (per TEST-1 in REVIEW-LATER.md):
 *  - Renders with label + group role
 *  - Calls `onRemove` when the remove button is clicked
 *  - Keyboard: Delete and Backspace on the remove button trigger `onRemove`
 *  - Remove button has an accessible `aria-label` (icon-only button)
 *  - Touch sizing: `[@media(pointer:coarse)]:min-h-[44px]` and `min-w-[44px]`
 *    on the remove button (44 px coarse-pointer minimum)
 *  - a11y: `axe(container)` clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { FilterPill } from '../filter-pill'

const defaultProps = {
  label: 'status = TODO',
  onRemove: vi.fn(),
  removeAriaLabel: 'Remove filter status = TODO',
}

describe('FilterPill', () => {
  // -- Rendering --------------------------------------------------------------

  it('renders the label and a group with default aria-label', () => {
    render(<FilterPill {...defaultProps} />)

    expect(screen.getByText('status = TODO')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'status = TODO' })).toBeInTheDocument()
  })

  it('uses groupAriaLabel when provided (overrides label)', () => {
    render(<FilterPill {...defaultProps} groupAriaLabel="Filter: status = TODO" />)

    expect(screen.getByRole('group', { name: 'Filter: status = TODO' })).toBeInTheDocument()
  })

  // -- Remove button accessibility --------------------------------------------

  it('renders the remove button with a non-empty aria-label (icon-only)', () => {
    render(<FilterPill {...defaultProps} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    // The button only contains an icon — its accessible name comes from aria-label.
    expect(removeBtn).toHaveAttribute('aria-label', 'Remove filter status = TODO')
    expect(removeBtn.textContent?.trim()).toBe('')
  })

  // -- Click + keyboard handling ----------------------------------------------

  it('calls onRemove when the remove button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    await user.click(screen.getByRole('button', { name: 'Remove filter status = TODO' }))

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('calls onRemove on Delete key on the remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    removeBtn.focus()
    await user.keyboard('{Delete}')

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('calls onRemove on Backspace key on the remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    removeBtn.focus()
    await user.keyboard('{Backspace}')

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onRemove on unrelated keys (e.g. ArrowLeft)', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPill {...defaultProps} onRemove={onRemove} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    removeBtn.focus()
    await user.keyboard('{ArrowLeft}')

    expect(onRemove).not.toHaveBeenCalled()
  })

  // -- E6: long-value truncation ----------------------------------------------

  it('E6: caps the pill width and truncates a long label', () => {
    const longLabel = `path: ${'Projects/Sub'.repeat(20)}`
    const { container } = render(<FilterPill {...defaultProps} label={longLabel} />)

    // The badge wrapper is width-capped and can shrink inside a flex-wrap row.
    const badge = container.querySelector('[data-slot="filter-pill"]') as HTMLElement
    expect(badge.className).toContain('max-w-[16rem]')
    expect(badge.className).toContain('min-w-0')

    // The label text lives in a truncating span (not raw badge text), so the
    // long value clips with an ellipsis instead of stretching the pill.
    const labelSpan = screen.getByText(longLabel)
    expect(labelSpan.tagName).toBe('SPAN')
    expect(labelSpan.className).toContain('truncate')
  })

  it('E6: falls back the title tooltip to the label so the truncated value is recoverable', () => {
    const longLabel = `tag: ${'verylongtag'.repeat(8)}`
    const { container } = render(<FilterPill {...defaultProps} label={longLabel} />)

    const badge = container.querySelector('[data-slot="filter-pill"]') as HTMLElement
    expect(badge).toHaveAttribute('title', longLabel)
  })

  it('E6: an explicit title overrides the label fallback', () => {
    const { container } = render(
      <FilterPill {...defaultProps} label="Orphan" title="Fully isolated page" />,
    )

    const badge = container.querySelector('[data-slot="filter-pill"]') as HTMLElement
    expect(badge).toHaveAttribute('title', 'Fully isolated page')
  })

  it('E6: the remove button stays shrink-0 so only the label clips', () => {
    render(<FilterPill {...defaultProps} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    expect(removeBtn.className).toContain('shrink-0')
  })

  // -- Touch-target sizing (44 px coarse-pointer minimum) ---------------------

  it('remove button declares 44 px coarse-pointer minimum on both axes', () => {
    render(<FilterPill {...defaultProps} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]')
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]')
  })

  it('remove button uses normalized focus-visible ring classes', () => {
    render(<FilterPill {...defaultProps} />)

    const removeBtn = screen.getByRole('button', { name: 'Remove filter status = TODO' })
    expect(removeBtn.className).toContain('focus-ring-visible')
  })

  // UX-2: the visible X icon scales up on coarse pointers so the tap area
  // matches the 44 px button (visual–affordance mismatch fix).
  it('UX-2: inner X icon scales to size-5 on coarse pointers', () => {
    const { container } = render(<FilterPill {...defaultProps} />)

    const svg = container.querySelector('button svg')
    expect(svg).toBeInTheDocument()
    const cls = svg?.getAttribute('class') ?? ''
    expect(cls).toContain('[@media(pointer:coarse)]:size-5')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations', async () => {
    const { container } = render(<FilterPill {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
