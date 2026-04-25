/**
 * Tests for the Textarea UI primitive.
 *
 * Validates (per TEST-1 in REVIEW-LATER.md):
 *  - Renders with `value` (controlled)
 *  - Calls `onChange` with the typed value
 *  - `aria-invalid` propagates from prop to DOM
 *  - Focus-visible ring classes are present
 *  - Native textarea height: `min-h-[80px]` default + `min-h-[120px]` on
 *    coarse pointer (touch-friendly)
 *  - Forwards `ref` to the underlying `<textarea>`
 *  - a11y: `axe(container)` clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { Textarea } from '../textarea'

describe('Textarea', () => {
  // -- Controlled rendering ---------------------------------------------------

  it('renders with the provided value', () => {
    render(<Textarea value="hello world" onChange={() => {}} aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    expect(ta).toBeInTheDocument()
    expect(ta.value).toBe('hello world')
    expect(ta.tagName).toBe('TEXTAREA')
    expect(ta).toHaveAttribute('data-slot', 'textarea')
  })

  // -- onChange propagation ---------------------------------------------------

  it('calls onChange when the user types (controlled, with state)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    // Wrap in a stateful component so the controlled value reflects typing —
    // a controlled <textarea> with a static `value=""` would have its DOM
    // value reset by React before we could read `event.target.value`.
    function Wrapper() {
      const [value, setValue] = React.useState('')
      return (
        <Textarea
          value={value}
          aria-label="Notes"
          onChange={(e) => {
            onChange(e.target.value)
            setValue(e.target.value)
          }}
        />
      )
    }
    render(<Wrapper />)

    const ta = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    await user.type(ta, 'ab')

    // userEvent.type fires one onChange per character; final state is "ab".
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('ab')
    expect(ta.value).toBe('ab')
  })

  // -- aria-invalid propagation -----------------------------------------------

  it('propagates aria-invalid="true" from prop to DOM', () => {
    render(<Textarea aria-invalid={true} aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' })
    expect(ta).toHaveAttribute('aria-invalid', 'true')
  })

  it('omits aria-invalid by default', () => {
    render(<Textarea aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' })
    expect(ta).not.toHaveAttribute('aria-invalid')
  })

  // -- Focus-visible ring -----------------------------------------------------

  it('includes focus-visible ring classes', () => {
    render(<Textarea aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' })
    expect(ta.className).toContain('focus-visible:ring-[3px]')
    expect(ta.className).toContain('focus-visible:ring-ring/50')
    expect(ta.className).toContain('focus-visible:border-ring')
    expect(ta.className).toContain('focus-visible:outline-hidden')
  })

  // -- Touch-friendly native height ------------------------------------------

  it('declares a reasonable default min-height (80 px) and a taller coarse-pointer min-height (120 px)', () => {
    render(<Textarea aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' })
    expect(ta.className).toContain('min-h-[80px]')
    expect(ta.className).toContain('[@media(pointer:coarse)]:min-h-[120px]')
  })

  // -- Ref forwarding ---------------------------------------------------------

  it('forwards ref to the underlying <textarea>', () => {
    const ref = React.createRef<HTMLTextAreaElement>()
    render(<Textarea ref={ref} aria-label="Notes" />)

    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('textarea')
  })

  // -- Class merging ----------------------------------------------------------

  it('merges custom className with defaults', () => {
    render(<Textarea className="my-custom" aria-label="Notes" />)

    const ta = screen.getByRole('textbox', { name: 'Notes' })
    expect(ta.className).toContain('my-custom')
    expect(ta.className).toContain('rounded-md')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations when paired with a label', async () => {
    const { container } = render(
      <>
        <label htmlFor="notes">Notes</label>
        <Textarea id="notes" />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when invalid (aria-invalid="true")', async () => {
    const { container } = render(
      <>
        <label htmlFor="notes-invalid">Notes</label>
        <Textarea id="notes-invalid" aria-invalid={true} />
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
