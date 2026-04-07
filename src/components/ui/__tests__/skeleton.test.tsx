/**
 * Tests for the Skeleton component.
 *
 * Validates:
 *  - Renders with correct classes
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Skeleton } from '../skeleton'

describe('Skeleton', () => {
  it('renders with data-slot="skeleton"', () => {
    render(<Skeleton data-testid="skeleton" />)
    const el = screen.getByTestId('skeleton')
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('data-slot', 'skeleton')
  })

  it('includes animate-pulse class', () => {
    render(<Skeleton data-testid="skeleton" />)
    const el = screen.getByTestId('skeleton')
    expect(el.className).toContain('motion-safe:animate-pulse')
  })

  it('merges custom className', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-full" />)
    const el = screen.getByTestId('skeleton')
    expect(el.className).toContain('h-4')
    expect(el.className).toContain('w-full')
    expect(el.className).toContain('motion-safe:animate-pulse')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<Skeleton ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Skeleton />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
