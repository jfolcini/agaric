/**
 * Tests for the PopoverMenuItem component.
 *
 * Validates:
 *  - Renders children
 *  - Applies active styling when active=true
 *  - Applies disabled styling when disabled=true
 *  - Calls onClick handler
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PopoverMenuItem } from '../popover-menu-item'

describe('PopoverMenuItem', () => {
  it('renders children', () => {
    render(<PopoverMenuItem>Status</PopoverMenuItem>)
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument()
  })

  it('applies active styling when active=true', () => {
    render(<PopoverMenuItem active>Active item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Active item' })
    expect(btn.className).toContain('bg-accent')
    expect(btn.className).toContain('font-medium')
  })

  it('applies disabled styling when disabled=true', () => {
    render(<PopoverMenuItem disabled>Disabled item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Disabled item' })
    expect(btn).toBeDisabled()
    expect(btn.className).toContain('opacity-50')
    expect(btn.className).toContain('cursor-not-allowed')
  })

  it('calls onClick handler', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    render(<PopoverMenuItem onClick={handleClick}>Click me</PopoverMenuItem>)
    await user.click(screen.getByRole('button', { name: 'Click me' }))
    expect(handleClick).toHaveBeenCalledOnce()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PopoverMenuItem>Accessible item</PopoverMenuItem>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes coarse pointer touch-target class', () => {
    render(<PopoverMenuItem>Touch item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Touch item' })
    expect(btn.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('includes focus-visible ring classes', () => {
    render(<PopoverMenuItem>Focus item</PopoverMenuItem>)
    const btn = screen.getByRole('button', { name: 'Focus item' })
    expect(btn.className).toContain('focus-visible:outline-none')
    expect(btn.className).toContain('focus-visible:ring-[3px]')
    expect(btn.className).toContain('focus-visible:ring-ring/50')
  })
})
