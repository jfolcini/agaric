/**
 * Tests for the SectionTitle component.
 *
 * Validates:
 *  - Renders label and count
 *  - Applies color and className
 *  - Forwards ref to the h4 element
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { SectionTitle } from '../section-title'

describe('SectionTitle', () => {
  it('renders label text', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    expect(screen.getByText('Overdue')).toBeInTheDocument()
  })

  it('renders count in parentheses', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    expect(screen.getByText('(3)')).toBeInTheDocument()
  })

  it('renders as an h4 element', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading).toBeInTheDocument()
  })

  it('applies color class', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-red-500')
  })

  it('merges custom className', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} className="my-custom" />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('my-custom')
  })

  it('applies base layout classes', () => {
    render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading.className).toContain('text-xs')
    expect(heading.className).toContain('font-semibold')
    expect(heading.className).toContain('flex')
    expect(heading.className).toContain('items-center')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLHeadingElement>()
    render(<SectionTitle ref={ref} color="text-red-500" label="Overdue" count={3} />)
    expect(ref.current).toBeInstanceOf(HTMLHeadingElement)
  })

  it('a11y: no violations', async () => {
    const { container } = render(<SectionTitle color="text-red-500" label="Overdue" count={3} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
