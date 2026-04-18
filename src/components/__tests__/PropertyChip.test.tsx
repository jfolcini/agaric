import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PropertyChip } from '../PropertyChip'

describe('PropertyChip', () => {
  it('renders key and value text', () => {
    render(<PropertyChip propKey="effort" value="2h" />)

    expect(screen.getByText('Effort:')).toBeInTheDocument()
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

  it('does not have mt-1 (alignment handled by parent container pt-1)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="1h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).not.toContain('mt-1')
  })

  it('key label has opacity-60 class', () => {
    render(<PropertyChip propKey="repeat" value="weekly" />)

    const keySpan = screen.getByText('Repeat:')
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
    const { container } = render(<PropertyChip propKey="effort" value="2h" onClick={() => {}} />)

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
    const { container: withoutClick } = render(<PropertyChip propKey="effort" value="2h" />)

    const chipWithClick = withClick.querySelector('.property-chip')
    const chipWithoutClick = withoutClick.querySelector('.property-chip')

    expect(chipWithClick?.className).toContain('cursor-pointer')
    expect(chipWithClick?.className).toContain('hover:bg-accent/50')
    expect(chipWithoutClick?.className).not.toContain('cursor-pointer')
    expect(chipWithoutClick?.className).not.toContain('hover:bg-accent/50')
  })

  it('key label calls onKeyClick when clicked', async () => {
    const user = userEvent.setup()
    const handleKeyClick = vi.fn()
    const handleClick = vi.fn()

    render(
      <PropertyChip
        propKey="effort"
        value="2h"
        onClick={handleClick}
        onKeyClick={handleKeyClick}
      />,
    )

    const keyLabel = screen.getByText('Effort:')
    await user.click(keyLabel)

    expect(handleKeyClick).toHaveBeenCalledOnce()
    // onClick should NOT be called because onKeyClick stops propagation
    expect(handleClick).not.toHaveBeenCalled()
  })

  it('key label has hover:underline class when onKeyClick is provided', () => {
    render(<PropertyChip propKey="effort" value="2h" onKeyClick={() => {}} />)

    const keyLabel = screen.getByText('Effort:')
    expect(keyLabel.className).toContain('hover:underline')
    expect(keyLabel.className).toContain('cursor-pointer')
  })

  it('key label does not have hover:underline class when onKeyClick is not provided', () => {
    render(<PropertyChip propKey="effort" value="2h" />)

    const keyLabel = screen.getByText('Effort:')
    expect(keyLabel.className).not.toContain('hover:underline')
  })

  it('renders built-in property with formatted name and icon', () => {
    const { container } = render(<PropertyChip propKey="due_date" value="2025-01-01" />)

    expect(screen.getByText('Due Date:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.querySelector('svg')).toBeInTheDocument()
  })

  it('renders custom property with formatted name and no icon', () => {
    const { container } = render(<PropertyChip propKey="my_prop" value="hello" />)

    expect(screen.getByText('My Prop:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.querySelector('svg')).toBeNull()
  })

  it('renders formatted name and icon for clickable built-in key', () => {
    const { container } = render(
      <PropertyChip propKey="due_date" value="2025-01-01" onKeyClick={() => {}} />,
    )

    expect(screen.getByText('Due Date:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.tagName.toLowerCase()).toBe('button')
    expect(keyLabel?.querySelector('svg')).toBeInTheDocument()
  })

  it('renders formatted name without icon for clickable custom key', () => {
    const { container } = render(
      <PropertyChip propKey="my_prop" value="hello" onKeyClick={() => {}} />,
    )

    expect(screen.getByText('My Prop:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.tagName.toLowerCase()).toBe('button')
    expect(keyLabel?.querySelector('svg')).toBeNull()
  })

  it('outer button has aria-label when onClick is provided (B-19)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" onClick={() => {}} />)

    const chip = container.querySelector('.property-chip')
    expect(chip).toHaveAttribute('aria-label', 'Effort: 2h')
  })

  it('outer button has no aria-label when onClick is not provided (B-19)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip).not.toHaveAttribute('aria-label')
  })

  it('outer button has normalized focus-visible ring classes (UX-209)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('focus-visible:ring-[3px]')
    expect(chip?.className).toContain('focus-visible:ring-ring/50')
    expect(chip?.className).toContain('focus-visible:outline-hidden')
  })

  it('key label button has normalized focus-visible ring classes (UX-209)', () => {
    render(<PropertyChip propKey="effort" value="2h" onKeyClick={() => {}} />)

    const keyLabel = screen.getByText('Effort:')
    expect(keyLabel.className).toContain('focus-visible:ring-[3px]')
    expect(keyLabel.className).toContain('focus-visible:ring-ring/50')
    expect(keyLabel.className).toContain('focus-visible:outline-hidden')
  })
})
