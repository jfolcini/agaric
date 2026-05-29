/**
 * Tests for the Label UI primitive.
 *
 * Validates (per PEND-23 H4):
 *  - Renders children inside a `<label>` with `data-slot="label"`
 *  - Forwards `htmlFor` to the underlying `<label>` element (`for` attribute)
 *  - Click on the label associates with the linked input via `htmlFor`
 *    (focuses a text input, toggles a checkbox)
 *  - Size variants (`sm` default, `xs`) apply the right typography classes
 *  - `muted` variant (default true, false suppresses) applies the right colour
 *  - Custom className merges with the variant classes
 *  - Forwards `ref` to the underlying `<label>`
 *  - a11y: `axe(container)` clean
 *
 * Note: there is overlap with the Label coverage in `primitives.test.tsx`.
 * This file is the canonical, dedicated test file going forward — see
 * PEND-23 H4 for context. The existing coverage in `primitives.test.tsx`
 * is left untouched (per the task scope) and can be cleaned up later.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { Label } from '../label'

describe('Label', () => {
  // -- Default rendering ------------------------------------------------------

  it('renders children inside a <label> element', () => {
    render(<Label>Email address</Label>)

    const label = screen.getByText('Email address')
    expect(label).toBeInTheDocument()
    expect(label.tagName).toBe('LABEL')
  })

  it('has data-slot="label"', () => {
    render(<Label>Email address</Label>)

    const label = screen.getByText('Email address')
    expect(label).toHaveAttribute('data-slot', 'label')
  })

  // -- htmlFor forwarding -----------------------------------------------------

  it('forwards htmlFor to the underlying <label> as the for attribute', () => {
    render(<Label htmlFor="email-input">Email</Label>)

    const label = screen.getByText('Email')
    expect(label).toHaveAttribute('for', 'email-input')
  })

  // -- Click association via htmlFor ------------------------------------------

  it('clicking the label focuses a linked text input via htmlFor', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Label htmlFor="email-input">Email</Label>
        <input id="email-input" type="text" aria-label="Email" />
      </>,
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).not.toHaveFocus()

    await user.click(screen.getByText('Email'))

    expect(input).toHaveFocus()
  })

  it('clicking the label toggles a linked checkbox via htmlFor', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <>
        <Label htmlFor="agree">I agree</Label>
        <input id="agree" type="checkbox" onChange={onChange} aria-label="I agree" />
      </>,
    )

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await user.click(screen.getByText('I agree'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(checkbox.checked).toBe(true)
  })

  // -- Size variants ----------------------------------------------------------

  it('renders default size variant (text-sm)', () => {
    render(<Label>Default</Label>)

    const label = screen.getByText('Default')
    expect(label.className).toContain('text-sm')
    expect(label.className).toContain('font-medium')
  })

  it('renders size="xs" variant (text-xs)', () => {
    render(<Label size="xs">Tiny</Label>)

    const label = screen.getByText('Tiny')
    expect(label.className).toContain('text-xs')
    expect(label.className).toContain('font-medium')
  })

  // -- muted variant ----------------------------------------------------------

  it('applies text-muted-foreground by default (muted defaults to true)', () => {
    render(<Label>Muted</Label>)

    const label = screen.getByText('Muted')
    expect(label.className).toContain('text-muted-foreground')
  })

  it('omits text-muted-foreground when muted={false}', () => {
    render(<Label muted={false}>Bright</Label>)

    const label = screen.getByText('Bright')
    expect(label.className).not.toContain('text-muted-foreground')
  })

  // -- Class merging ----------------------------------------------------------

  it('merges custom className with variant classes', () => {
    render(<Label className="mb-2">Field</Label>)

    const label = screen.getByText('Field')
    expect(label.className).toContain('mb-2')
    expect(label.className).toContain('font-medium')
    expect(label.className).toContain('text-sm')
  })

  // -- Ref forwarding ---------------------------------------------------------

  it('forwards ref to the underlying <label>', () => {
    const ref = React.createRef<HTMLLabelElement>()
    render(<Label ref={ref}>Ref test</Label>)

    expect(ref.current).toBeInstanceOf(HTMLLabelElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('label')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations when associated with an input via htmlFor', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="a11y-input">Name</Label>
        <input id="a11y-input" type="text" aria-label="Name" />
      </div>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
