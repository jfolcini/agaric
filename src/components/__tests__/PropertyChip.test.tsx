import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { PropertyChip } from '../PropertyChip'

describe('PropertyChip', () => {
  it('renders key and value text', () => {
    render(<PropertyChip propKey="effort" value="2h" />)

    expect(screen.getByText('effort:')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(
      <PropertyChip propKey="assignee" value="Alice" className="custom-class" />,
    )

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('custom-class')
  })

  it('has property-chip class on the root element', () => {
    const { container } = render(<PropertyChip propKey="location" value="Office" />)

    const chip = container.querySelector('.property-chip')
    expect(chip).toBeInTheDocument()
  })

  it('uses bg-muted and text-muted-foreground default styling', () => {
    const { container } = render(<PropertyChip propKey="effort" value="1h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('bg-muted')
    expect(chip?.className).toContain('text-muted-foreground')
  })

  it('has mt-1 for vertical alignment with other inline chips', () => {
    const { container } = render(<PropertyChip propKey="effort" value="1h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('mt-1')
  })

  it('key label has opacity-60 class', () => {
    render(<PropertyChip propKey="repeat" value="weekly" />)

    const keySpan = screen.getByText('repeat:')
    expect(keySpan.className).toContain('opacity-60')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
