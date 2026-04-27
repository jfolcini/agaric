/**
 * Tests for the Select component.
 *
 * Validates:
 *  - Placeholder rendering
 *  - Dropdown open/close behaviour
 *  - Item selection and callback
 *  - Controlled value display
 *  - Disabled state
 *  - Size variants (default, sm)
 *  - a11y compliance via axe audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Override the global `@/components/ui/select` mock from `src/test-setup.ts`
// so this file tests the real Radix-based component. The global mock is for
// downstream component tests where the Radix portal/positioning chokes in jsdom.
vi.unmock('@/components/ui/select')

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../select'

// jsdom does not implement pointer-capture APIs that Radix Select requires.
// Stub them on Element.prototype so the trigger opens correctly.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  // Radix Select measures the content via scrollHeight which jsdom defaults to 0.
  // Provide a small positive value so the viewport renders children.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
})

/** Helper to render a basic select */
function renderSelect(
  props: {
    value?: string
    onValueChange?: (v: string) => void
    disabled?: boolean
    size?: 'default' | 'sm'
  } = {},
) {
  const selectProps: Record<string, unknown> = {}
  if (props.value !== undefined) selectProps['value'] = props.value
  if (props.onValueChange !== undefined) selectProps['onValueChange'] = props.onValueChange

  const triggerProps: Record<string, unknown> = { 'aria-label': 'Test select' }
  if (props.size !== undefined) triggerProps['size'] = props.size
  if (props.disabled !== undefined) triggerProps['disabled'] = props.disabled

  return render(
    <Select {...selectProps}>
      <SelectTrigger {...triggerProps}>
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
        <SelectItem value="b">Beta</SelectItem>
        <SelectItem value="c">Gamma</SelectItem>
      </SelectContent>
    </Select>,
  )
}

describe('Select', () => {
  // -- Basic rendering --------------------------------------------------------

  it('renders with placeholder', () => {
    renderSelect()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Pick one')).toBeInTheDocument()
  })

  // -- Dropdown interaction ---------------------------------------------------

  it('opens dropdown on click', async () => {
    const user = userEvent.setup()
    renderSelect()

    await user.click(screen.getByRole('combobox'))

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Gamma' })).toBeInTheDocument()
  })

  it('selects an item', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderSelect({ onValueChange: onChange })

    await user.click(screen.getByRole('combobox'))

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('option', { name: 'Beta' }))

    expect(onChange).toHaveBeenCalledWith('b')
  })

  // -- Controlled value -------------------------------------------------------

  it('displays selected value', () => {
    renderSelect({ value: 'a' })
    expect(screen.getByRole('combobox')).toHaveTextContent('Alpha')
  })

  // -- Disabled state ---------------------------------------------------------

  it('renders disabled state', () => {
    renderSelect({ disabled: true })
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  // -- Size variants ----------------------------------------------------------

  it('renders sm size variant', () => {
    renderSelect({ size: 'sm' })
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('h-7')
    expect(trigger.className).toContain('px-2')
    expect(trigger.className).toContain('text-xs')
  })

  // -- Coarse pointer media query overrides -----------------------------------

  it('default size includes coarse pointer height override', () => {
    renderSelect()
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  it('sm size includes coarse pointer height override', () => {
    renderSelect({ size: 'sm' })
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('[@media(pointer:coarse)]:h-11')
  })

  // -- Focus-visible ring classes ---------------------------------------------

  it('includes focus-visible ring classes', () => {
    renderSelect()
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('focus-visible:outline-hidden')
    expect(trigger.className).toContain('focus-visible:ring-[3px]')
    expect(trigger.className).toContain('focus-visible:ring-ring/50')
  })

  // -- endContent slot --------------------------------------------------------

  it('renders SelectItem `endContent` after ItemText so it is excluded from the auto-mirror', async () => {
    const user = userEvent.setup()
    render(
      <Select value="a">
        <SelectTrigger aria-label="Test select">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value="a"
            endContent={
              <span data-testid="end-chip" aria-hidden="true">
                CHIP
              </span>
            }
          >
            Alpha
          </SelectItem>
        </SelectContent>
      </Select>,
    )

    // Trigger label mirrors the matched ItemText (Radix auto-mirror) — the
    // `endContent` chip MUST stay out of the trigger so the docstring
    // contract holds.
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('Alpha')
    expect(trigger).not.toHaveTextContent('CHIP')

    // Open the dropdown — the chip is rendered alongside the row.
    await user.click(trigger)
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument()
    })
    const chip = screen.getByTestId('end-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('CHIP')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations', async () => {
    const { container } = renderSelect()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -- displayName ------------------------------------------------------------

  it.each([
    ['Select', Select],
    ['SelectGroup', SelectGroup],
    ['SelectValue', SelectValue],
    ['SelectTrigger', SelectTrigger],
    ['SelectScrollUpButton', SelectScrollUpButton],
    ['SelectScrollDownButton', SelectScrollDownButton],
    ['SelectContent', SelectContent],
    ['SelectItem', SelectItem],
    ['SelectLabel', SelectLabel],
    ['SelectSeparator', SelectSeparator],
  ])('%s has displayName', (name, Component) => {
    expect(Component.displayName).toBe(name)
  })
})
