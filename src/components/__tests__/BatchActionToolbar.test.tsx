/**
 * Tests for BatchActionToolbar component.
 *
 * Validates:
 *  - Renders selection count badge
 *  - Renders children (action buttons)
 *  - Applies custom className
 *  - Updates count on prop change
 *  - Has toolbar role with accessible label
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BatchActionToolbar } from '../BatchActionToolbar'

describe('BatchActionToolbar', () => {
  it('renders selection count badge', () => {
    render(
      <BatchActionToolbar selectedCount={3}>
        <button type="button">Action</button>
      </BatchActionToolbar>,
    )

    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  it('renders children', () => {
    render(
      <BatchActionToolbar selectedCount={1}>
        <button type="button">Revert</button>
        <button type="button">Clear</button>
      </BatchActionToolbar>,
    )

    expect(screen.getByRole('button', { name: 'Revert' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  })

  it('applies custom className', () => {
    render(
      <BatchActionToolbar selectedCount={1} className="my-custom-class gap-3 p-3">
        <button type="button">Action</button>
      </BatchActionToolbar>,
    )

    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).toHaveClass('my-custom-class')
  })

  it('updates selection count when prop changes', () => {
    const { rerender } = render(
      <BatchActionToolbar selectedCount={2}>
        <button type="button">Action</button>
      </BatchActionToolbar>,
    )

    expect(screen.getByText('2 selected')).toBeInTheDocument()

    rerender(
      <BatchActionToolbar selectedCount={7}>
        <button type="button">Action</button>
      </BatchActionToolbar>,
    )

    expect(screen.getByText('7 selected')).toBeInTheDocument()
  })

  it('has toolbar role with accessible label', () => {
    render(
      <BatchActionToolbar selectedCount={4}>
        <button type="button">Action</button>
      </BatchActionToolbar>,
    )

    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).toHaveAccessibleName('4 selected')
  })

  it('forwards click events on child buttons', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <BatchActionToolbar selectedCount={1}>
        <button type="button" onClick={onClick}>
          Do something
        </button>
      </BatchActionToolbar>,
    )

    await user.click(screen.getByRole('button', { name: 'Do something' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  describe('a11y', () => {
    it('has no a11y violations', async () => {
      const { container } = render(
        <BatchActionToolbar selectedCount={3}>
          <button type="button">Revert</button>
          <button type="button">Clear</button>
        </BatchActionToolbar>,
      )

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with custom className', async () => {
      const { container } = render(
        <BatchActionToolbar selectedCount={1} className="extra-class">
          <button type="button">Action</button>
        </BatchActionToolbar>,
      )

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
