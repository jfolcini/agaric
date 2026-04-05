/**
 * Tests for AddBlockButton component.
 *
 * Validates:
 *  - Renders a button with Plus icon and default "Add block" label
 *  - Fires onClick when clicked
 *  - Supports custom label override
 *  - Supports custom className override
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { AddBlockButton } from '../AddBlockButton'

describe('AddBlockButton', () => {
  it('renders a button with the default "Add block" label', () => {
    render(<AddBlockButton onClick={() => {}} />)

    const btn = screen.getByRole('button', { name: /add block/i })
    expect(btn).toBeInTheDocument()
  })

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(<AddBlockButton onClick={onClick} />)

    const btn = screen.getByRole('button', { name: /add block/i })
    await user.click(btn)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders with a custom label when provided', () => {
    render(<AddBlockButton onClick={() => {}} label="Add first block" />)

    const btn = screen.getByRole('button', { name: /add first block/i })
    expect(btn).toBeInTheDocument()
  })

  it('applies default muted-foreground className', () => {
    render(<AddBlockButton onClick={() => {}} />)

    const btn = screen.getByRole('button', { name: /add block/i })
    expect(btn.className).toContain('text-muted-foreground')
  })

  it('applies custom className when provided', () => {
    render(<AddBlockButton onClick={() => {}} className="custom-class" />)

    const btn = screen.getByRole('button', { name: /add block/i })
    expect(btn.className).toContain('custom-class')
    expect(btn.className).not.toContain('text-muted-foreground')
  })

  it('does not fire onClick when button is not clicked', () => {
    const onClick = vi.fn()
    render(<AddBlockButton onClick={onClick} />)

    expect(onClick).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<AddBlockButton onClick={() => {}} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with custom label', async () => {
    const { container } = render(<AddBlockButton onClick={() => {}} label="Add your first block" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
