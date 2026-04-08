/**
 * Tests for the ChevronToggle component.
 *
 * Validates:
 *  - Renders ChevronRight icon when collapsed
 *  - Applies rotate-90 when expanded
 *  - Renders Loader2 spinner when loading=true
 *  - Supports sm and md size variants
 *  - Has no a11y violations
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { ChevronToggle } from '../chevron-toggle'

describe('ChevronToggle', () => {
  it('renders ChevronRight icon when collapsed', () => {
    const { container } = render(<ChevronToggle isExpanded={false} />)

    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    // ChevronRight renders a <polyline> or <path> — just verify it's an SVG
    expect(svg?.tagName).toBe('svg')
    // Should NOT have rotate-90
    expect(svg?.className.baseVal ?? svg?.getAttribute('class') ?? '').not.toContain('rotate-90')
  })

  it('applies rotate-90 when expanded', () => {
    const { container } = render(<ChevronToggle isExpanded={true} />)

    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('rotate-90')
  })

  it('renders Loader2 spinner when loading is true', () => {
    const { container } = render(<ChevronToggle isExpanded={false} loading={true} />)

    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('animate-spin')
    // Should NOT have rotate-90 since it's a spinner
    expect(classes).not.toContain('rotate-90')
  })

  it('renders spinner instead of chevron when loading, even if expanded', () => {
    const { container } = render(<ChevronToggle isExpanded={true} loading={true} />)

    const svg = container.querySelector('svg')
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('animate-spin')
    expect(classes).not.toContain('rotate-90')
  })

  it('supports sm size variant (default)', () => {
    const { container } = render(<ChevronToggle isExpanded={false} size="sm" />)

    const svg = container.querySelector('svg')
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('h-3')
    expect(classes).toContain('w-3')
  })

  it('supports md size variant', () => {
    const { container } = render(<ChevronToggle isExpanded={false} size="md" />)

    const svg = container.querySelector('svg')
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('h-3.5')
    expect(classes).toContain('w-3.5')
  })

  it('defaults to sm size when no size prop provided', () => {
    const { container } = render(<ChevronToggle isExpanded={false} />)

    const svg = container.querySelector('svg')
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('h-3')
    expect(classes).toContain('w-3')
  })

  it('merges custom className', () => {
    const { container } = render(<ChevronToggle isExpanded={false} className="my-custom" />)

    const svg = container.querySelector('svg')
    const classes = svg?.getAttribute('class') ?? ''
    expect(classes).toContain('my-custom')
  })

  it('has no a11y violations when collapsed', async () => {
    const { container } = render(
      <button type="button" aria-label="Toggle">
        <ChevronToggle isExpanded={false} />
      </button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when expanded', async () => {
    const { container } = render(
      <button type="button" aria-label="Toggle">
        <ChevronToggle isExpanded={true} />
      </button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when loading', async () => {
    const { container } = render(
      <button type="button" aria-label="Toggle">
        <ChevronToggle isExpanded={false} loading={true} />
      </button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
