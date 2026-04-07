/**
 * Tests for the Badge component.
 *
 * Validates:
 *  - Renders with default variant
 *  - Ref forwarding
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Badge } from '../badge'

describe('Badge', () => {
  it('renders with default variant', () => {
    render(<Badge>Status</Badge>)
    const badge = screen.getByText('Status')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('data-slot', 'badge')
    expect(badge).toHaveAttribute('data-variant', 'default')
  })

  it('renders with secondary variant', () => {
    render(<Badge variant="secondary">Tag</Badge>)
    const badge = screen.getByText('Tag')
    expect(badge.className).toContain('bg-secondary')
  })

  it('merges custom className', () => {
    render(<Badge className="my-class">Custom</Badge>)
    const badge = screen.getByText('Custom')
    expect(badge.className).toContain('my-class')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLSpanElement>()
    render(<Badge ref={ref}>Ref test</Badge>)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Badge>Accessible badge</Badge>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
