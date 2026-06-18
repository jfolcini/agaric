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
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { CardButton } from '../card-button'
import { CloseButtonIcon, closeButtonClassName } from '../close-button'
import { FeaturePageHeader } from '../feature-page-header'
import { FormField } from '../form-field'
import { IconButton } from '../icon-button'
import { Input } from '../input'
import { Label } from '../label'
import { ListItem } from '../list-item'
import { MetricCard } from '../metric-card'
import { RecentPageChip } from '../recent-page-chip'
import { SectionGroupHeader } from '../section-group-header'
import { Spinner } from '../spinner'
import { ToggleGroup, ToggleGroupItem } from '../toggle-group'

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

  // #1753: decorative by default — silent to assistive tech so a caller that
  // supplies its own loading text isn't double-announced.
  it('is aria-hidden and exposes no role by default (decorative)', () => {
    const { container } = render(<Spinner />)
    const el = q(container, '[data-slot="spinner"]')
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).not.toHaveAttribute('role')
    expect(el).not.toHaveAttribute('aria-label')
  })

  // #1753: opt-in announced mode via `label` → role="status" + accessible name.
  it('exposes role="status" with the default loading label when label is true', () => {
    render(<Spinner label />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('data-slot', 'spinner')
    expect(status).toHaveAccessibleName('Loading…')
    expect(status).not.toHaveAttribute('aria-hidden')
  })

  // #1753: keep it a primitive — callers can override the label text.
  it('uses a custom label string as the accessible name', () => {
    render(<Spinner label="Saving changes" />)
    const status = screen.getByRole('status', { name: 'Saving changes' })
    expect(status).toBeInTheDocument()
    expect(status).not.toHaveAttribute('aria-hidden')
  })

  // Caller-supplied a11y props still win over the computed defaults.
  it('lets callers override role/aria props', () => {
    const { container } = render(<Spinner role="alert" aria-label="Custom" />)
    const el = q(container, '[data-slot="spinner"]')
    expect(el).toHaveAttribute('role', 'alert')
    expect(el).toHaveAttribute('aria-label', 'Custom')
  })

  it('has no a11y violations (decorative, default)', async () => {
    const { container } = render(
      <output aria-busy="true">
        <Spinner />
        <span className="sr-only">Loading</span>
      </output>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations (announced status mode)', async () => {
    const { container } = render(<Spinner label />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('forwards ref', () => {
    const ref = React.createRef<SVGSVGElement>()
    render(<Spinner ref={ref} />)
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })
})

// ---------------------------------------------------------------------------
// CloseButtonIcon
// ---------------------------------------------------------------------------

describe('CloseButtonIcon', () => {
  it('closeButtonClassName contains expected classes', () => {
    expect(closeButtonClassName).toContain('opacity-70')
    expect(closeButtonClassName).toContain('focus-ring-visible')
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

  // UX-2: the visible icon must scale up on coarse pointers so it fills
  // more of the 44 px button (visual–affordance mismatch fix).
  it('UX-2: inner icon scales to size-5 on coarse pointers', () => {
    const { container } = render(
      <button type="button">
        <CloseButtonIcon />
      </button>,
    )
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    const cls = svg?.getAttribute('class') ?? ''
    expect(cls).toContain('size-4')
    expect(cls).toContain('[@media(pointer:coarse)]:size-5')
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

  it('forwards ref', () => {
    const ref = React.createRef<HTMLSpanElement>()
    render(
      <button type="button">
        <CloseButtonIcon ref={ref} />
      </button>,
    )
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
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
    expect(btn.className).toContain('focus-ring-visible')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLButtonElement>()
    render(<CardButton ref={ref}>Ref test</CardButton>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CardButton>Accessible card</CardButton>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // asChild polymorphism (Radix Slot): consumers can render the card
  // chrome as an `<a>` / `<Link>` for navigable cards.
  it('renders as <a> when asChild is true with an anchor child', () => {
    render(
      <CardButton asChild className="my-card">
        <a href="/page/abc">Go to page</a>
      </CardButton>,
    )
    const link = screen.getByRole('link', { name: 'Go to page' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/page/abc')
    expect(link).toHaveAttribute('data-slot', 'card-button')
    // Base + caller classes are merged onto the anchor.
    expect(link.className).toContain('bg-card')
    expect(link.className).toContain('my-card')
    // `type="button"` must NOT leak onto the anchor (invalid HTML).
    expect(link).not.toHaveAttribute('type')
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

  it('forwards ref', () => {
    const ref = React.createRef<HTMLLabelElement>()
    render(<Label ref={ref}>Ref test</Label>)
    expect(ref.current).toBeInstanceOf(HTMLLabelElement)
  })

  it('has no a11y violations with htmlFor pointing to an input', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="test-input">Test field</Label>
        <input id="test-input" type="text" aria-label="Test field" />
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

  it('forwards ref', () => {
    const ref = React.createRef<HTMLLIElement>()
    render(
      <ul>
        <ListItem ref={ref}>Ref test</ListItem>
      </ul>,
    )
    expect(ref.current).toBeInstanceOf(HTMLLIElement)
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
    expect(li.className).toContain('focus-ring-visible')
  })

  // asChild polymorphism (Radix Slot): consumers can render the chrome
  // as an `<a>` for navigable lists while preserving merged className.
  it('renders as <a> when asChild is true with an anchor child', () => {
    render(
      <ul>
        <ListItem asChild className="my-list-class">
          <a href="/tag/abc">Tag link</a>
        </ListItem>
      </ul>,
    )
    const link = screen.getByRole('link', { name: 'Tag link' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/tag/abc')
    expect(link).toHaveAttribute('data-slot', 'list-item')
    expect(link.className).toContain('group')
    expect(link.className).toContain('hover:bg-accent/50')
    expect(link.className).toContain('my-list-class')
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
    expect(el.className).toContain('focus-ring-visible')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLInputElement>()
    render(<Input ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
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

// ---------------------------------------------------------------------------
// RecentPageChip
// ---------------------------------------------------------------------------

describe('RecentPageChip', () => {
  it('renders as a button with type="button" and data-slot', () => {
    render(<RecentPageChip>Home</RecentPageChip>)
    const btn = screen.getByRole('button', { name: 'Home' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn).toHaveAttribute('data-slot', 'recent-page-chip')
  })

  it('default classes include chip chrome (border, bg-secondary/40, shrink-0)', () => {
    render(<RecentPageChip>Styled</RecentPageChip>)
    const btn = screen.getByRole('button', { name: 'Styled' })
    expect(btn.className).toContain('border')
    expect(btn.className).toContain('bg-secondary/40')
    expect(btn.className).toContain('shrink-0')
    expect(btn.className).toContain('focus-ring-visible')
  })

  it('includes coarse pointer touch-target class', () => {
    render(<RecentPageChip>Touch</RecentPageChip>)
    const btn = screen.getByRole('button', { name: 'Touch' })
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  it('merges custom className', () => {
    render(<RecentPageChip className="my-chip">Custom</RecentPageChip>)
    const btn = screen.getByRole('button', { name: 'Custom' })
    expect(btn.className).toContain('my-chip')
    expect(btn.className).toContain('bg-secondary/40')
  })

  it('fires onClick when clicked', async () => {
    const handleClick = vi.fn()
    const user = userEvent.setup()
    render(<RecentPageChip onClick={handleClick}>Open</RecentPageChip>)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLButtonElement>()
    render(<RecentPageChip ref={ref}>Ref test</RecentPageChip>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<RecentPageChip>Accessible chip</RecentPageChip>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // asChild polymorphism (Radix Slot): chips should be renderable as
  // anchors so recent-page entries can be true navigable links.
  it('renders as <a> when asChild is true with an anchor child', () => {
    render(
      <RecentPageChip asChild className="my-chip">
        <a href="/page/recent">Recent page</a>
      </RecentPageChip>,
    )
    const link = screen.getByRole('link', { name: 'Recent page' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/page/recent')
    expect(link).toHaveAttribute('data-slot', 'recent-page-chip')
    expect(link.className).toContain('bg-secondary/40')
    expect(link.className).toContain('my-chip')
    // `type="button"` must NOT leak onto the anchor (invalid HTML).
    expect(link).not.toHaveAttribute('type')
  })
})

// ---------------------------------------------------------------------------
// ToggleGroup
// ---------------------------------------------------------------------------

describe('ToggleGroup', () => {
  it('renders the group with data-slot and items with role="radio"', () => {
    render(
      <ToggleGroup type="single" aria-label="Diff mode">
        <ToggleGroupItem value="just-change">Just this change</ToggleGroupItem>
        <ToggleGroupItem value="compared-current">Compared to current</ToggleGroupItem>
      </ToggleGroup>,
    )
    const group = screen.getByRole('group', { name: 'Diff mode' })
    expect(group).toBeInTheDocument()
    expect(group).toHaveAttribute('data-slot', 'toggle-group')
    const items = screen.getAllByRole('radio')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('data-slot', 'toggle-group-item')
  })

  it('group default classes include border and rounded-md', () => {
    render(
      <ToggleGroup type="single" aria-label="Modes">
        <ToggleGroupItem value="a">A</ToggleGroupItem>
      </ToggleGroup>,
    )
    const group = screen.getByRole('group', { name: 'Modes' })
    expect(group.className).toContain('rounded-md')
    expect(group.className).toContain('border-input')
  })

  it('item includes coarse pointer touch-target class', () => {
    render(
      <ToggleGroup type="single" aria-label="Modes">
        <ToggleGroupItem value="a">A</ToggleGroupItem>
      </ToggleGroup>,
    )
    const item = screen.getByRole('radio', { name: 'A' })
    expect(item.className).toContain('[@media(pointer:coarse)]:min-h-11')
  })

  it('merges custom className on group and item', () => {
    render(
      <ToggleGroup type="single" aria-label="Modes" className="my-group">
        <ToggleGroupItem value="a" className="my-item">
          A
        </ToggleGroupItem>
      </ToggleGroup>,
    )
    const group = screen.getByRole('group', { name: 'Modes' })
    const item = screen.getByRole('radio', { name: 'A' })
    expect(group.className).toContain('my-group')
    expect(group.className).toContain('rounded-md')
    expect(item.className).toContain('my-item')
  })

  it('toggles data-state="on" when an item is clicked (single select)', async () => {
    const handleChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ToggleGroup type="single" aria-label="Diff mode" onValueChange={handleChange}>
        <ToggleGroupItem value="just-change">Just this change</ToggleGroupItem>
        <ToggleGroupItem value="compared-current">Compared to current</ToggleGroupItem>
      </ToggleGroup>,
    )
    const first = screen.getByRole('radio', { name: 'Just this change' })
    const second = screen.getByRole('radio', { name: 'Compared to current' })
    expect(first).toHaveAttribute('data-state', 'off')
    await user.click(first)
    expect(handleChange).toHaveBeenCalledWith('just-change')
    expect(first).toHaveAttribute('data-state', 'on')
    expect(second).toHaveAttribute('data-state', 'off')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <ToggleGroup type="single" aria-label="Diff mode" defaultValue="a">
        <ToggleGroupItem value="a">A</ToggleGroupItem>
        <ToggleGroupItem value="b">B</ToggleGroupItem>
      </ToggleGroup>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// IconButton — docs/UX.md mandates a tooltip on every icon-only button. The
// `tooltip` + `ariaLabel` props are typed as mandatory `string`s so a
// consumer cannot omit either; these tests cover the runtime contract.
// ---------------------------------------------------------------------------

describe('IconButton', () => {
  it('renders as a button with data-slot="icon-button" and the supplied aria-label', () => {
    render(
      <IconButton tooltip="Star this page" ariaLabel="Star this page">
        <span aria-hidden="true">★</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Star this page' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('data-slot', 'icon-button')
    expect(btn).toHaveAttribute('aria-label', 'Star this page')
  })

  it('defaults to size="icon" (36 px square)', () => {
    render(
      <IconButton tooltip="Tip" ariaLabel="Tip">
        <span aria-hidden="true">i</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Tip' })
    expect(btn).toHaveAttribute('data-size', 'icon')
    expect(btn.className).toContain('size-9')
  })

  it('accepts the icon-sm size and emits the expected data-size', () => {
    render(
      <IconButton tooltip="Tip" ariaLabel="Tip" size="icon-sm">
        <span aria-hidden="true">i</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Tip' })
    expect(btn).toHaveAttribute('data-size', 'icon-sm')
    expect(btn.className).toContain('size-8')
  })

  it('forwards Button variant (ghost/outline/...) through to data-variant', () => {
    render(
      <IconButton tooltip="Tip" ariaLabel="Tip" variant="outline">
        <span aria-hidden="true">i</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Tip' })
    expect(btn).toHaveAttribute('data-variant', 'outline')
  })

  it('merges custom className without clobbering Button chrome', () => {
    render(
      <IconButton tooltip="Tip" ariaLabel="Tip" className="my-icon-btn shrink-0">
        <span aria-hidden="true">i</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Tip' })
    expect(btn.className).toContain('my-icon-btn')
    expect(btn.className).toContain('shrink-0')
    // size="icon" base class still present
    expect(btn.className).toContain('size-9')
  })

  it('fires onClick when clicked', async () => {
    const handleClick = vi.fn()
    const user = userEvent.setup()
    render(
      <IconButton tooltip="Add" ariaLabel="Add item" onClick={handleClick}>
        <span aria-hidden="true">+</span>
      </IconButton>,
    )
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('shows the tooltip content on focus (Radix Tooltip wiring)', async () => {
    const user = userEvent.setup()
    render(
      <IconButton tooltip="Zoom in" ariaLabel="Zoom in">
        <span aria-hidden="true">+</span>
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Zoom in' })
    await user.tab()
    expect(btn).toHaveFocus()
    // Radix portals the tooltip; look it up by role. Multiple nodes may
    // exist (visible + a11y description), so `getAllByRole` is safer.
    const tooltips = await screen.findAllByRole('tooltip')
    expect(tooltips.length).toBeGreaterThan(0)
    expect(tooltips[0]).toHaveTextContent('Zoom in')
  })

  it('forwards arbitrary DOM props (data-testid, data-starred)', () => {
    render(
      <IconButton tooltip="Star" ariaLabel="Star" data-testid="star-btn" data-starred={true}>
        <span aria-hidden="true">★</span>
      </IconButton>,
    )
    const btn = screen.getByTestId('star-btn')
    expect(btn).toHaveAttribute('data-starred', 'true')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <IconButton tooltip="Star this page" ariaLabel="Star this page">
        <span aria-hidden="true">★</span>
      </IconButton>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// MetricCard — `rounded-lg border bg-muted/30 p-4 text-center` tile used in
// StatusPanel for sync / queue / dispatch counters. Replaces 5+ inline copies.
// ---------------------------------------------------------------------------

describe('MetricCard', () => {
  it('renders the value', () => {
    render(<MetricCard label="Peers" value={3} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('renders the label as a <dt> when wrapped in a <dl> (default dl-item mode)', () => {
    render(
      <dl>
        <MetricCard label="Peers" value={3} />
      </dl>,
    )
    expect(screen.getByText('Peers').tagName).toBe('DT')
    expect(screen.getByText('3').tagName).toBe('DD')
  })

  it('renders plain <div>s when as="div"', () => {
    render(<MetricCard label="Peers" value={3} as="div" />)
    expect(screen.getByText('Peers').tagName).toBe('DIV')
    expect(screen.getByText('3').tagName).toBe('DIV')
  })

  it('renders the optional footer node', () => {
    render(<MetricCard label="Queue" value={5} footer="Peak: 12" />)
    expect(screen.getByText('Peak: 12')).toBeInTheDocument()
  })

  it('applies the success tone classes', () => {
    const { container } = render(<MetricCard label="Done" value={0} tone="success" />)
    const card = q(container, '[data-slot="metric-card"]')
    expect(getClasses(card)).toContain('border-status-done')
  })

  it('applies the warning tone classes', () => {
    const { container } = render(<MetricCard label="Queue" value={42} tone="warning" />)
    const card = q(container, '[data-slot="metric-card"]')
    expect(getClasses(card)).toContain('border-status-pending')
  })

  it('renders the labelSlot in place of the default label when provided', () => {
    render(
      <MetricCard
        value={3}
        labelSlot={
          <dt data-testid="custom-label">
            <button type="button">Peers</button>
          </dt>
        }
      />,
    )
    expect(screen.getByTestId('custom-label')).toBeInTheDocument()
  })

  it('applies the always-on chrome (rounded, border, bg-muted/30, p-4, text-center)', () => {
    const { container } = render(<MetricCard label="X" value={1} />)
    const card = q(container, '[data-slot="metric-card"]')
    expect(getClasses(card)).toContain('rounded-lg')
    expect(getClasses(card)).toContain('border')
    expect(getClasses(card)).toContain('bg-muted/30')
    expect(getClasses(card)).toContain('p-4')
    expect(getClasses(card)).toContain('text-center')
  })

  it('merges custom className', () => {
    const { container } = render(<MetricCard label="X" value={1} className="status-metric" />)
    const card = q(container, '[data-slot="metric-card"]')
    expect(getClasses(card)).toContain('status-metric')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<MetricCard ref={ref} label="X" value={1} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (dl-item mode)', async () => {
    const { container } = render(
      <dl>
        <MetricCard label="Peers" value={3} footer="updated 5m ago" />
      </dl>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// SectionGroupHeader — chip-style sub-section header used in DuePanel /
// DonePanel. Sibling to SectionTitle (kept separate; see component header).
// ---------------------------------------------------------------------------

describe('SectionGroupHeader', () => {
  it('renders its children inside a <div>', () => {
    render(<SectionGroupHeader>Doing</SectionGroupHeader>)
    const el = screen.getByText('Doing')
    expect(el).toBeInTheDocument()
    expect(el.tagName).toBe('DIV')
  })

  it('emits data-slot="section-group-header"', () => {
    const { container } = render(<SectionGroupHeader>Doing</SectionGroupHeader>)
    expect(container.querySelector('[data-slot="section-group-header"]')).toBeInTheDocument()
  })

  it('applies the chip chrome (uppercase, bg-muted/50, rounded, tracking-wide)', () => {
    const { container } = render(<SectionGroupHeader>Doing</SectionGroupHeader>)
    const el = q(container, '[data-slot="section-group-header"]')
    expect(getClasses(el)).toContain('uppercase')
    expect(getClasses(el)).toContain('tracking-wide')
    expect(getClasses(el)).toContain('bg-muted/50')
    expect(getClasses(el)).toContain('rounded')
    expect(getClasses(el)).toContain('font-semibold')
  })

  it('merges custom className', () => {
    const { container } = render(
      <SectionGroupHeader className="due-panel-group-header">Doing</SectionGroupHeader>,
    )
    const el = q(container, '[data-slot="section-group-header"]')
    expect(getClasses(el)).toContain('due-panel-group-header')
    expect(getClasses(el)).toContain('bg-muted/50')
  })

  it('renders the caller element when asChild is true', () => {
    render(
      <SectionGroupHeader asChild>
        <h3 data-testid="custom-heading">Doing</h3>
      </SectionGroupHeader>,
    )
    const el = screen.getByTestId('custom-heading')
    expect(el.tagName).toBe('H3')
    expect(el.className).toContain('bg-muted/50')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<SectionGroupHeader ref={ref}>Doing</SectionGroupHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SectionGroupHeader>Doing</SectionGroupHeader>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// FormField — label + control + description/error wrapper for settings tabs.
// Pairs with the shared `Label` primitive so typography stays consistent.
// ---------------------------------------------------------------------------

describe('FormField', () => {
  it('renders the label text', () => {
    render(
      <FormField label="Theme" htmlFor="theme-select">
        <input id="theme-select" aria-label="Theme" />
      </FormField>,
    )
    expect(screen.getByText('Theme')).toBeInTheDocument()
  })

  it('associates the label with the control via htmlFor', () => {
    render(
      <FormField label="Theme" htmlFor="theme-select">
        <input id="theme-select" data-testid="control" aria-label="Theme" />
      </FormField>,
    )
    const label = screen.getByText('Theme')
    expect(label).toHaveAttribute('for', 'theme-select')
    // getByLabelText resolves through the for/id association.
    expect(screen.getByLabelText('Theme')).toBe(screen.getByTestId('control'))
  })

  it('renders the children control', () => {
    render(
      <FormField label="Theme" htmlFor="t">
        <input id="t" data-testid="theme-input" aria-label="Theme" />
      </FormField>,
    )
    expect(screen.getByTestId('theme-input')).toBeInTheDocument()
  })

  it('renders the description when provided and no error', () => {
    render(
      <FormField label="Theme" description="Pick a UI theme" htmlFor="t">
        <input id="t" aria-label="Theme" />
      </FormField>,
    )
    expect(screen.getByText('Pick a UI theme')).toBeInTheDocument()
  })

  it('renders the error in place of the description when both are provided', () => {
    render(
      <FormField label="Theme" description="Pick one" error="Required" htmlFor="t">
        <input id="t" aria-label="Theme" />
      </FormField>,
    )
    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.queryByText('Pick one')).not.toBeInTheDocument()
  })

  it('marks the error message with role="alert"', () => {
    render(
      <FormField label="Theme" error="Required" htmlFor="t">
        <input id="t" aria-label="Theme" />
      </FormField>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Required')
  })

  it('emits data-slot="form-field"', () => {
    const { container } = render(
      <FormField label="Theme" htmlFor="t">
        <input id="t" aria-label="Theme" />
      </FormField>,
    )
    expect(container.querySelector('[data-slot="form-field"]')).toBeInTheDocument()
  })

  it('merges custom className on the wrapper', () => {
    const { container } = render(
      <FormField label="Theme" htmlFor="t" className="my-field">
        <input id="t" aria-label="Theme" />
      </FormField>,
    )
    const wrapper = q(container, '[data-slot="form-field"]')
    expect(getClasses(wrapper)).toContain('my-field')
    expect(getClasses(wrapper)).toContain('space-y-2')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <FormField label="Theme" description="Pick one" htmlFor="theme-select">
        <input id="theme-select" aria-label="Theme" />
      </FormField>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// FeaturePageHeader — shared title / breadcrumb / actions chrome wrapping
// the six top-level views previously without a uniform header
// (Trash, Settings, Status, Journal, Graph, Templates). See the
// component header for the slot contract and rationale.
// ---------------------------------------------------------------------------

describe('FeaturePageHeader', () => {
  it('renders the title as an <h1>', () => {
    render(<FeaturePageHeader title="Trash" />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Trash' })
    expect(heading).toBeInTheDocument()
    expect(heading.tagName).toBe('H1')
  })

  it('wraps the title in a <header> landmark', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    const header = q(container, '[data-slot="feature-page-header"]')
    expect(header.tagName).toBe('HEADER')
  })

  it('emits the documented data-slot attributes', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    expect(container.querySelector('[data-slot="feature-page-header"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="feature-page-header-title"]')).toBeInTheDocument()
  })

  it('renders the breadcrumb slot when provided', () => {
    render(
      <FeaturePageHeader
        title="Settings"
        breadcrumb={
          <nav aria-label="Settings">
            <span>Settings / General</span>
          </nav>
        }
      />,
    )
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText('Settings / General')).toBeInTheDocument()
  })

  it('omits the breadcrumb slot when not provided', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    expect(
      container.querySelector('[data-slot="feature-page-header-breadcrumb"]'),
    ).not.toBeInTheDocument()
  })

  it('renders the actions slot when provided', () => {
    render(
      <FeaturePageHeader
        title="Trash"
        actions={
          <button type="button" data-testid="empty-trash">
            Empty
          </button>
        }
      />,
    )
    expect(screen.getByTestId('empty-trash')).toBeInTheDocument()
  })

  it('omits the actions slot when not provided', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    expect(
      container.querySelector('[data-slot="feature-page-header-actions"]'),
    ).not.toBeInTheDocument()
  })

  it('renders the kebab slot when provided', () => {
    render(
      <FeaturePageHeader
        title="Journal"
        kebab={
          <button type="button" data-testid="overflow">
            ⋯
          </button>
        }
      />,
    )
    expect(screen.getByTestId('overflow')).toBeInTheDocument()
  })

  it('omits the kebab slot when not provided', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    expect(
      container.querySelector('[data-slot="feature-page-header-kebab"]'),
    ).not.toBeInTheDocument()
  })

  it('renders all four slots together', () => {
    render(
      <FeaturePageHeader
        title="Settings"
        breadcrumb={
          <nav aria-label="Settings">
            <span>Settings / General</span>
          </nav>
        }
        actions={
          <button type="button" data-testid="action">
            Save
          </button>
        }
        kebab={
          <button type="button" data-testid="more">
            ⋯
          </button>
        }
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByTestId('action')).toBeInTheDocument()
    expect(screen.getByTestId('more')).toBeInTheDocument()
  })

  it('truncates the title via flex-1 + truncate utilities', () => {
    const { container } = render(<FeaturePageHeader title="Trash" />)
    const title = q(container, '[data-slot="feature-page-header-title"]')
    expect(getClasses(title)).toContain('flex-1')
    expect(getClasses(title)).toContain('truncate')
    expect(getClasses(title)).toContain('font-semibold')
  })

  it('merges custom className onto the outer <header>', () => {
    const { container } = render(<FeaturePageHeader title="Trash" className="trash-view-header" />)
    const header = q(container, '[data-slot="feature-page-header"]')
    expect(getClasses(header)).toContain('trash-view-header')
    expect(getClasses(header)).toContain('feature-page-header')
  })

  it('forwards ref to the <header> element', () => {
    const ref = React.createRef<HTMLElement>()
    render(<FeaturePageHeader title="Trash" ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLElement)
    expect(ref.current?.tagName).toBe('HEADER')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <FeaturePageHeader
        title="Settings"
        breadcrumb={
          <nav aria-label="Settings breadcrumb">
            <span>Settings / General</span>
          </nav>
        }
        actions={
          <button type="button" aria-label="Save settings">
            Save
          </button>
        }
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
