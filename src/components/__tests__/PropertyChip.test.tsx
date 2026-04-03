import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

  it('renders as button when onClick is provided', () => {
    const { container } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} />,
    )

    const chip = container.querySelector('.property-chip')
    expect(chip).toBeInTheDocument()
    expect(chip?.tagName.toLowerCase()).toBe('button')
  })

  it('renders as button even without onClick', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.tagName.toLowerCase()).toBe('button')
  })

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()

    render(<PropertyChip propKey="effort" value="2h" onClick={handleClick} />)

    const chip = screen.getByRole('button')
    await user.click(chip)

    expect(handleClick).toHaveBeenCalledOnce()
  })

  it('adds hover styles only when onClick is provided', () => {
    const { container: withClick } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} />,
    )
    const { container: withoutClick } = render(
      <PropertyChip propKey="effort" value="2h" />,
    )

    const chipWithClick = withClick.querySelector('.property-chip')
    const chipWithoutClick = withoutClick.querySelector('.property-chip')

    expect(chipWithClick?.className).toContain('cursor-pointer')
    expect(chipWithClick?.className).toContain('hover:bg-accent/50')
    expect(chipWithoutClick?.className).not.toContain('cursor-pointer')
    expect(chipWithoutClick?.className).not.toContain('hover:bg-accent/50')
  })
})
