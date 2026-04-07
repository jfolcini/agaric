/**
 * Tests for primitive UI components: Spinner, CloseButtonIcon,
 * CardButton, Label, and ListItem.
 *
 * Validates:
 *  - Render output, variant classes, and prop forwarding
 *  - Interaction (onClick) where applicable
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { CardButton } from '../card-button'
import { CloseButtonIcon, closeButtonClassName } from '../close-button'
import { Input } from '../input'
import { Label } from '../label'
import { ListItem } from '../list-item'
import { Spinner } from '../spinner'

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

/** Helper: get class string from an SVG element (className is SVGAnimatedString). */
function getClasses(el: Element): string {
  return el.getAttribute('class') ?? ''
}

/** Helper: querySelector that throws on null (avoids non-null assertions). */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

describe('Spinner', () => {
  it('renders with default md size', () => {
    const { container } = render(<Spinner data-testid="spinner" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(el).toBeInTheDocument()
    expect(getClasses(el)).toContain('h-4')
    expect(getClasses(el)).toContain('w-4')
    expect(getClasses(el)).toContain('animate-spin')
  })

  it('renders sm size variant', () => {
    const { container } = render(<Spinner size="sm" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(getClasses(el)).toContain('h-3.5')
    expect(getClasses(el)).toContain('w-3.5')
  })

  it('renders lg size variant', () => {
    const { container } = render(<Spinner size="lg" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(getClasses(el)).toContain('h-5')
    expect(getClasses(el)).toContain('w-5')
  })

  it('renders xl size variant', () => {
    const { container } = render(<Spinner size="xl" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(getClasses(el)).toContain('h-6')
    expect(getClasses(el)).toContain('w-6')
  })

  it('merges custom className', () => {
    const { container } = render(<Spinner className="text-red-500" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(getClasses(el)).toContain('text-red-500')
    expect(getClasses(el)).toContain('animate-spin')
  })

  it('renders data-slot="spinner"', () => {
    const { container } = render(<Spinner />)
    expect(container.querySelector('[data-slot="spinner"]')).toBeInTheDocument()
  })

  it('accepts data-testid', () => {
    render(<Spinner data-testid="my-spinner" />)
    expect(screen.getByTestId('my-spinner')).toBeInTheDocument()
  })

  it('accepts aria-hidden', () => {
    const { container } = render(<Spinner aria-hidden="true" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(el).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <div role="status" aria-busy="true">
        <Spinner aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// CloseButtonIcon
// ---------------------------------------------------------------------------

describe('CloseButtonIcon', () => {
  it('closeButtonClassName contains expected classes', () => {
    expect(closeButtonClassName).toContain('opacity-70')
    expect(closeButtonClassName).toContain('ring-offset-background')
    expect(closeButtonClassName).toContain('[@media(pointer:coarse)]')
  })

  it('renders sr-only "Close" text', () => {
    render(
      <button type="button">
        <CloseButtonIcon />
      </button>,
    )
    expect(screen.getByText('Close')).toBeInTheDocument()
    expect(screen.getByText('Close')).toHaveClass('sr-only')
  })

  it('renders an SVG icon', () => {
    const { container } = render(
      <button type="button">
        <CloseButtonIcon />
      </button>,
    )
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('has no a11y violations when wrapped in a button', async () => {
    const { container } = render(
      <button type="button">
        <CloseButtonIcon />
      </button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// CardButton
// ---------------------------------------------------------------------------

describe('CardButton', () => {
  it('renders as button with type="button"', () => {
    render(<CardButton>Click me</CardButton>)
    const btn = screen.getByRole('button', { name: 'Click me' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('type', 'button')
  })

  it('has data-slot="card-button"', () => {
    render(<CardButton>Test</CardButton>)
    const btn = screen.getByRole('button', { name: 'Test' })
    expect(btn).toHaveAttribute('data-slot', 'card-button')
  })

  it('default classes include bg-card and hover:bg-accent/50', () => {
    render(<CardButton>Styled</CardButton>)
    const btn = screen.getByRole('button', { name: 'Styled' })
    expect(btn.className).toContain('bg-card')
    expect(btn.className).toContain('hover:bg-accent/50')
  })

  it('accepts onClick handler', async () => {
    const handleClick = vi.fn()
    const user = userEvent.setup()
    render(<CardButton onClick={handleClick}>Press</CardButton>)
    await user.click(screen.getByRole('button', { name: 'Press' }))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('merges custom className', () => {
    render(<CardButton className="my-custom">Custom</CardButton>)
    const btn = screen.getByRole('button', { name: 'Custom' })
    expect(btn.className).toContain('my-custom')
    expect(btn.className).toContain('bg-card')
  })

  it('renders children', () => {
    render(
      <CardButton>
        <span>Child content</span>
      </CardButton>,
    )
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('includes coarse pointer touch-target class', () => {
    render(<CardButton>Touch</CardButton>)
    const btn = screen.getByRole('button', { name: 'Touch' })
    expect(btn.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('includes focus-visible ring classes', () => {
    render(<CardButton>Focus</CardButton>)
    const btn = screen.getByRole('button', { name: 'Focus' })
    expect(btn.className).toContain('focus-visible:outline-none')
    expect(btn.className).toContain('focus-visible:ring-[3px]')
    expect(btn.className).toContain('focus-visible:ring-ring/50')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CardButton>Accessible card</CardButton>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

describe('Label', () => {
  it('renders with default classes (text-sm, font-medium, text-muted-foreground)', () => {
    render(<Label>Name</Label>)
    const label = screen.getByText('Name')
    expect(label.tagName).toBe('LABEL')
    expect(label.className).toContain('text-sm')
    expect(label.className).toContain('font-medium')
    expect(label.className).toContain('text-muted-foreground')
  })

  it('renders text-xs with size="xs"', () => {
    render(<Label size="xs">Small</Label>)
    const label = screen.getByText('Small')
    expect(label.className).toContain('text-xs')
  })

  it('does NOT have text-muted-foreground when muted={false}', () => {
    render(<Label muted={false}>Bright</Label>)
    const label = screen.getByText('Bright')
    expect(label.className).not.toContain('text-muted-foreground')
  })

  it('passes htmlFor through to the label element', () => {
    render(<Label htmlFor="email-input">Email</Label>)
    const label = screen.getByText('Email')
    expect(label).toHaveAttribute('for', 'email-input')
  })

  it('merges custom className', () => {
    render(<Label className="mb-2">Field</Label>)
    const label = screen.getByText('Field')
    expect(label.className).toContain('mb-2')
    expect(label.className).toContain('font-medium')
  })

  it('has no a11y violations with htmlFor pointing to an input', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="test-input">Test field</Label>
        <input id="test-input" type="text" />
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// ListItem
// ---------------------------------------------------------------------------

describe('ListItem', () => {
  it('renders as li element', () => {
    const { container } = render(
      <ul>
        <ListItem>Item</ListItem>
      </ul>,
    )
    const li = container.querySelector('li')
    expect(li).toBeInTheDocument()
  })

  it('has data-slot="list-item"', () => {
    const { container } = render(
      <ul>
        <ListItem>Item</ListItem>
      </ul>,
    )
    const li = container.querySelector('[data-slot="list-item"]')
    expect(li).toBeInTheDocument()
  })

  it('default classes include group, flex, and hover:bg-accent/50', () => {
    const { container } = render(
      <ul>
        <ListItem>Styled item</ListItem>
      </ul>,
    )
    const li = q(container, 'li')
    expect(li.className).toContain('group')
    expect(li.className).toContain('flex')
    expect(li.className).toContain('hover:bg-accent/50')
  })

  it('merges custom className', () => {
    const { container } = render(
      <ul>
        <ListItem className="my-list-class">Custom</ListItem>
      </ul>,
    )
    const li = q(container, 'li')
    expect(li.className).toContain('my-list-class')
    expect(li.className).toContain('group')
  })

  it('renders children', () => {
    render(
      <ul>
        <ListItem>
          <span>Child node</span>
        </ListItem>
      </ul>,
    )
    expect(screen.getByText('Child node')).toBeInTheDocument()
  })

  it('has no a11y violations inside a ul', async () => {
    const { container } = render(
      <ul>
        <ListItem>Accessible item</ListItem>
      </ul>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes coarse pointer touch-target class', () => {
    const { container } = render(
      <ul>
        <ListItem>Touch item</ListItem>
      </ul>,
    )
    const li = q(container, 'li')
    expect(li.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('includes focus-visible ring classes', () => {
    const { container } = render(
      <ul>
        <ListItem>Focus item</ListItem>
      </ul>,
    )
    const li = q(container, 'li')
    expect(li.className).toContain('focus-visible:outline-none')
    expect(li.className).toContain('focus-visible:ring-[3px]')
    expect(li.className).toContain('focus-visible:ring-ring/50')
  })
})

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input data-testid="test-input" />)
    expect(screen.getByTestId('test-input')).toBeInTheDocument()
    expect(screen.getByTestId('test-input').tagName).toBe('INPUT')
  })

  it('includes coarse pointer touch-target class', () => {
    render(<Input data-testid="test-input" />)
    const el = screen.getByTestId('test-input')
    expect(el.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  it('includes focus-visible ring classes', () => {
    render(<Input data-testid="test-input" />)
    const el = screen.getByTestId('test-input')
    expect(el.className).toContain('focus-visible:ring-[3px]')
    expect(el.className).toContain('focus-visible:ring-ring/50')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <div>
        <label htmlFor="a11y-input">Field</label>
        <Input id="a11y-input" />
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
