/**
 * Tests for the Input UI primitive.
 *
 * Validates (per PEND-23 H4):
 *  - Renders an `<input>` with `data-slot="input"` and the default classes
 *  - Accepts `type` variants (text, email, password, number, search)
 *  - `disabled` prop disables the element and prevents typing
 *  - `placeholder` renders
 *  - Controlled value updates via `onChange`
 *  - Uncontrolled value updates via `defaultValue` + native typing
 *  - `aria-invalid` propagates from prop to DOM and styling classes are present
 *  - Coarse-pointer touch-target class (`[@media(pointer:coarse)]:h-11`) is present
 *  - Focus-visible ring classes are present
 *  - Forwards `ref` to the underlying `<input>`
 *  - a11y: `axe(container)` clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { Input } from '../input'

describe('Input', () => {
  // -- Default rendering ------------------------------------------------------

  it('renders an <input> with data-slot="input"', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el).toBeInTheDocument()
    expect(el.tagName).toBe('INPUT')
    expect(el).toHaveAttribute('data-slot', 'input')
  })

  it('renders with default classes', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('h-9')
    expect(el.className).toContain('rounded-md')
    expect(el.className).toContain('border')
    expect(el.className).toContain('px-3')
    expect(el.className).toContain('text-sm')
  })

  // -- Type variants ----------------------------------------------------------

  it('accepts type="text"', () => {
    render(<Input type="text" aria-label="Field" />)
    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el).toHaveAttribute('type', 'text')
  })

  it('accepts type="email"', () => {
    render(<Input type="email" aria-label="Email" />)
    const el = screen.getByRole('textbox', { name: 'Email' })
    expect(el).toHaveAttribute('type', 'email')
  })

  it('accepts type="password"', () => {
    // type=password inputs have no implicit ARIA role, so query by data-slot.
    const { container } = render(<Input type="password" aria-label="Password" />)
    const el = container.querySelector('[data-slot="input"]') as HTMLInputElement
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('type', 'password')
  })

  it('accepts type="number"', () => {
    render(<Input type="number" aria-label="Count" />)
    const el = screen.getByRole('spinbutton', { name: 'Count' })
    expect(el).toHaveAttribute('type', 'number')
  })

  // -- Disabled state ---------------------------------------------------------

  it('disabled prop disables the input and prevents typing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Input disabled onChange={onChange} aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
    expect(el).toBeDisabled()

    await user.type(el, 'hello')

    expect(onChange).not.toHaveBeenCalled()
    expect(el.value).toBe('')
  })

  it('disabled adds disabled styling classes', () => {
    render(<Input disabled aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('disabled:pointer-events-none')
    expect(el.className).toContain('disabled:cursor-not-allowed')
    expect(el.className).toContain('disabled:opacity-50')
  })

  // -- Placeholder ------------------------------------------------------------

  it('renders the placeholder', () => {
    render(<Input placeholder="Type here..." aria-label="Field" />)

    const el = screen.getByPlaceholderText('Type here...')
    expect(el).toBeInTheDocument()
  })

  // -- Controlled value -------------------------------------------------------

  it('renders with the provided controlled value', () => {
    render(<Input value="initial" onChange={() => {}} aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
    expect(el.value).toBe('initial')
  })

  it('calls onChange when the user types (controlled, with state)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    // Wrap in a stateful component so the controlled value reflects typing —
    // a controlled <input> with a static `value=""` would have its DOM value
    // reset by React before we could read `event.target.value`.
    function Wrapper() {
      const [value, setValue] = React.useState('')
      return (
        <Input
          value={value}
          aria-label="Field"
          onChange={(e) => {
            onChange(e.target.value)
            setValue(e.target.value)
          }}
        />
      )
    }
    render(<Wrapper />)

    const el = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
    await user.type(el, 'ab')

    // userEvent.type fires one onChange per character; final state is "ab".
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('ab')
    expect(el.value).toBe('ab')
  })

  // -- Uncontrolled value -----------------------------------------------------

  it('supports uncontrolled mode via defaultValue + native typing', async () => {
    const user = userEvent.setup()
    render(<Input defaultValue="seed" aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
    expect(el.value).toBe('seed')

    await user.type(el, '!')
    expect(el.value).toBe('seed!')
  })

  // -- aria-invalid propagation -----------------------------------------------

  it('propagates aria-invalid="true" from prop to DOM', () => {
    render(<Input aria-invalid={true} aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el).toHaveAttribute('aria-invalid', 'true')
  })

  it('omits aria-invalid by default', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el).not.toHaveAttribute('aria-invalid')
  })

  it('declares aria-invalid styling classes', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('aria-invalid:border-destructive')
    expect(el.className).toContain('aria-invalid:ring-destructive/20')
  })

  // -- Touch-friendly sizing (AGENTS.md mandatory) ----------------------------

  it('declares coarse-pointer touch-target class (h-11)', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  // PEND-23 M8: bumps font-size to `text-base` on coarse pointers so iOS
  // doesn't auto-zoom when focusing the field. Default `text-sm` (≈14 px)
  // triggers Safari's auto-zoom; `text-base` (≈16 px) suppresses it.
  it('declares coarse-pointer font-size class (text-base)', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('[@media(pointer:coarse)]:text-base')
  })

  // -- Focus-visible ring -----------------------------------------------------

  it('includes focus-visible ring classes', () => {
    render(<Input aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('focus-visible:border-ring')
    expect(el.className).toContain('focus-ring-visible')
  })

  // -- Ref forwarding ---------------------------------------------------------

  it('forwards ref to the underlying <input>', () => {
    const ref = React.createRef<HTMLInputElement>()
    render(<Input ref={ref} aria-label="Field" />)

    expect(ref.current).toBeInstanceOf(HTMLInputElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('input')
  })

  // -- Class merging ----------------------------------------------------------

  it('merges custom className with defaults', () => {
    render(<Input className="my-custom" aria-label="Field" />)

    const el = screen.getByRole('textbox', { name: 'Field' })
    expect(el.className).toContain('my-custom')
    expect(el.className).toContain('rounded-md')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations when paired with a label', async () => {
    const { container } = render(
      <>
        <label htmlFor="field">Field</label>
        <Input id="field" />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when invalid (aria-invalid="true")', async () => {
    const { container } = render(
      <>
        <label htmlFor="field-invalid">Field</label>
        <Input id="field-invalid" aria-invalid={true} />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
