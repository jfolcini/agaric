/**
 * Tests for the Checkbox UI primitive (Radix Checkbox wrapper).
 *
 * Validates (per PEND-23 H4):
 *  - Renders unchecked by default
 *  - Renders checked when `checked={true}` (controlled) — `aria-checked`
 *    and `data-state` mirror the prop
 *  - Renders checked when `defaultChecked={true}` (uncontrolled)
 *  - Click toggles state in uncontrolled mode
 *  - Click fires `onCheckedChange` in controlled mode
 *  - Space key toggles when focused
 *  - `disabled` prop prevents interaction (clicking does not fire handler)
 *  - `aria-invalid` propagates from prop to DOM
 *  - Coarse-pointer touch sizing class is present
 *  - Focus-visible ring classes are present
 *  - `data-slot="checkbox"` and the indicator slot are present
 *  - a11y: `axe(container)` clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { Checkbox } from '../checkbox'

describe('Checkbox', () => {
  // -- Default rendering ------------------------------------------------------

  it('renders unchecked by default', () => {
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-checked', 'false')
    expect(cb).toHaveAttribute('data-state', 'unchecked')
    expect(cb).toHaveAttribute('data-slot', 'checkbox')
  })

  // -- Controlled rendering ---------------------------------------------------

  it('renders checked when checked={true} (controlled)', () => {
    render(<Checkbox checked={true} onCheckedChange={() => {}} aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-checked', 'true')
    expect(cb).toHaveAttribute('data-state', 'checked')
  })

  it('renders unchecked when checked={false} (controlled)', () => {
    render(<Checkbox checked={false} onCheckedChange={() => {}} aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-checked', 'false')
    expect(cb).toHaveAttribute('data-state', 'unchecked')
  })

  // -- Uncontrolled rendering -------------------------------------------------

  it('renders checked when defaultChecked={true} (uncontrolled)', () => {
    render(<Checkbox defaultChecked={true} aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-checked', 'true')
    expect(cb).toHaveAttribute('data-state', 'checked')
  })

  // -- Click interaction ------------------------------------------------------

  it('click toggles state in uncontrolled mode', async () => {
    const user = userEvent.setup()
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-checked', 'false')

    await user.click(cb)
    expect(cb).toHaveAttribute('aria-checked', 'true')
    expect(cb).toHaveAttribute('data-state', 'checked')

    await user.click(cb)
    expect(cb).toHaveAttribute('aria-checked', 'false')
    expect(cb).toHaveAttribute('data-state', 'unchecked')
  })

  it('click fires onCheckedChange(true) in controlled mode when unchecked', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} aria-label="Accept terms" />)

    await user.click(screen.getByRole('checkbox', { name: 'Accept terms' }))

    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('click fires onCheckedChange(false) in controlled mode when checked', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Checkbox checked={true} onCheckedChange={onCheckedChange} aria-label="Accept terms" />)

    await user.click(screen.getByRole('checkbox', { name: 'Accept terms' }))

    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it('Space key toggles the checkbox when focused', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    cb.focus()
    await user.keyboard(' ')

    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  // -- Disabled state ---------------------------------------------------------

  it('disabled prop prevents interaction (click does not fire onCheckedChange)', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <Checkbox
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        aria-label="Accept terms"
      />,
    )

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toBeDisabled()

    await user.click(cb)

    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('disabled adds disabled styling classes', () => {
    render(<Checkbox disabled aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb.className).toContain('disabled:cursor-not-allowed')
    expect(cb.className).toContain('disabled:opacity-50')
  })

  // -- aria-invalid propagation -----------------------------------------------

  it('propagates aria-invalid="true" from prop to DOM', () => {
    render(<Checkbox aria-invalid={true} aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).toHaveAttribute('aria-invalid', 'true')
  })

  it('omits aria-invalid by default', () => {
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb).not.toHaveAttribute('aria-invalid')
  })

  // -- Indicator visibility ---------------------------------------------------

  it('renders the checkbox-indicator slot when checked', () => {
    const { container } = render(
      <Checkbox checked={true} onCheckedChange={() => {}} aria-label="Accept terms" />,
    )

    const indicator = container.querySelector('[data-slot="checkbox-indicator"]')
    expect(indicator).toBeInTheDocument()
  })

  it('does not render the indicator when unchecked', () => {
    const { container } = render(
      <Checkbox checked={false} onCheckedChange={() => {}} aria-label="Accept terms" />,
    )

    // Radix only mounts the Indicator when state is checked / indeterminate.
    const indicator = container.querySelector('[data-slot="checkbox-indicator"]')
    expect(indicator).not.toBeInTheDocument()
  })

  // -- Touch-friendly sizing --------------------------------------------------

  it('declares coarse-pointer sizing class (size-5)', () => {
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb.className).toContain('[@media(pointer:coarse)]:size-5')
  })

  it('wraps checkbox in a 44 px coarse-pointer hitbox (MAINT-197)', () => {
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    const hitbox = cb.closest('[data-slot="checkbox-hitbox"]') as HTMLElement
    expect(hitbox).toBeInTheDocument()
    expect(hitbox.className).toContain('[@media(pointer:coarse)]:min-h-11')
    expect(hitbox.className).toContain('[@media(pointer:coarse)]:min-w-11')
  })

  // -- Focus-visible ring -----------------------------------------------------

  it('includes focus-visible ring classes', () => {
    render(<Checkbox aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb.className).toContain('focus-ring-visible')
  })

  // -- Class merging ----------------------------------------------------------

  it('merges custom className with defaults', () => {
    render(<Checkbox className="my-custom" aria-label="Accept terms" />)

    const cb = screen.getByRole('checkbox', { name: 'Accept terms' })
    expect(cb.className).toContain('my-custom')
    expect(cb.className).toContain('rounded-sm')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations when paired with a label', async () => {
    const { container } = render(
      <>
        <label htmlFor="agree">Accept terms</label>
        <Checkbox id="agree" />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when invalid (aria-invalid="true")', async () => {
    const { container } = render(
      <>
        <label htmlFor="agree-invalid">Accept terms</label>
        <Checkbox id="agree-invalid" aria-invalid={true} />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
