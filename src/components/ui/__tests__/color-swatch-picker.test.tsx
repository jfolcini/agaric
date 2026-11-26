/**
 * Tests for ColorSwatchPicker: picking a swatch, the picked swatch's state,
 * arrow-key roving that moves focus without picking, the "no colour" swatch,
 * the custom colour (its disclosure, hex field and picker), and axe audits.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { ColorSwatchPicker } from '@/components/ui/color-swatch-picker'

const SWATCHES = [
  { value: 'red', label: 'Red', color: '#ff0000' },
  { value: 'green', label: 'Green', color: '#00ff00' },
  { value: 'blue', label: 'Blue', color: '#0000ff' },
] as const

function renderPicker(value?: string) {
  const onValueChange = vi.fn()
  const onCustomColor = vi.fn()
  const onClear = vi.fn()
  const view = render(
    <ColorSwatchPicker
      aria-label="Palette"
      swatches={SWATCHES}
      value={value}
      onValueChange={onValueChange}
      onCustomColor={onCustomColor}
      onClear={onClear}
      clearLabel="Clear"
      customLabel="Custom"
      hexLabel="Hex"
      hexError="Not a hex colour"
    />,
  )
  return { ...view, onValueChange, onCustomColor, onClear }
}

describe('ColorSwatchPicker', () => {
  it('renders one radio per swatch, in order, painted in its colour', () => {
    renderPicker()

    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Red', 'Green', 'Blue'])
    const greenFill = screen.getByRole('radio', { name: 'Green' }).firstElementChild as HTMLElement
    expect(greenFill.style.backgroundColor).toBe('#00ff00')
    expect(screen.getByRole('radiogroup', { name: 'Palette' })).toBeInTheDocument()
  })

  it('checks the swatch holding the value', () => {
    renderPicker('green')

    expect(screen.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'false')
  })

  it('reports the swatch picked', async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker('red')

    await user.click(screen.getByRole('radio', { name: 'Blue' }))

    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('blue')
  })

  it('does not report pressing the picked swatch again', async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker('red')

    await user.click(screen.getByRole('radio', { name: 'Red' }))

    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('moves focus with the arrow keys without picking, and picks on Enter', async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker('red')

    await user.tab()
    expect(screen.getByRole('radio', { name: 'Red' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Green' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus()
    expect(onValueChange).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('blue')
  })

  it('clears through the "no colour" swatch', async () => {
    const user = userEvent.setup()
    const { onClear, onValueChange } = renderPicker('green')

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('disables the "no colour" swatch while no colour is set', () => {
    renderPicker()

    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
  })

  describe('custom colour', () => {
    it('stays collapsed for a swatch colour and opens on its toggle', async () => {
      const user = userEvent.setup()
      renderPicker('green')

      const toggle = screen.getByRole('button', { name: 'Custom' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('textbox', { name: 'Hex' })).not.toBeInTheDocument()

      await user.click(toggle)

      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#3b82f6')
    })

    it('opens on the custom colour the value holds', () => {
      renderPicker('#1e8a7a')

      expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#1e8a7a')
      expect(screen.getByTestId('custom-color-preview').style.backgroundColor).toBe('#1e8a7a')
    })

    it('commits a valid hex on Enter, as lowercase #rrggbb', async () => {
      const user = userEvent.setup()
      const { onCustomColor } = renderPicker('#1e8a7a')
      const field = screen.getByRole('textbox', { name: 'Hex' })

      await user.clear(field)
      await user.type(field, 'A1C{Enter}')

      expect(onCustomColor).toHaveBeenCalledTimes(1)
      expect(onCustomColor).toHaveBeenCalledWith('#aa11cc')
      expect(field).toHaveValue('#aa11cc')
      expect(field).toHaveAttribute('aria-invalid', 'false')
    })

    it('shows an invalid hex as an error and does not commit it', async () => {
      const user = userEvent.setup()
      const { onCustomColor } = renderPicker('#1e8a7a')
      const field = screen.getByRole('textbox', { name: 'Hex' })

      await user.clear(field)
      await user.type(field, '#12345{Enter}')

      expect(onCustomColor).not.toHaveBeenCalled()
      expect(field).toHaveAttribute('aria-invalid', 'true')
      expect(field).toHaveAccessibleDescription('Not a hex colour')
      expect(screen.getByText('Not a hex colour')).toBeVisible()
    })

    it('commits an edited hex on blur, and not a field only tabbed through', async () => {
      const user = userEvent.setup()
      // A swatch colour: the field shows the default custom colour, which no blur may commit.
      const { onCustomColor } = renderPicker('green')
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      const field = screen.getByRole('textbox', { name: 'Hex' })

      field.focus()
      fireEvent.blur(field)
      expect(onCustomColor).not.toHaveBeenCalled()

      await user.clear(field)
      await user.type(field, '00ff00')
      fireEvent.blur(field)
      expect(onCustomColor).toHaveBeenCalledTimes(1)
      expect(onCustomColor).toHaveBeenCalledWith('#00ff00')
    })

    it('moves the picker with a valid hex as it is typed', async () => {
      const user = userEvent.setup()
      renderPicker('#1e8a7a')
      const field = screen.getByRole('textbox', { name: 'Hex' })

      await user.clear(field)
      await user.type(field, '#00ff00')

      expect(screen.getByRole('slider', { name: 'Hue' })).toHaveAttribute('aria-valuenow', '120')
      expect(screen.getByTestId('custom-color-preview').style.backgroundColor).toBe('#00ff00')
    })

    // react-colorful reads the arrow from `keyCode`, which userEvent leaves unset.
    it('commits the picked colour when the key is released, not while it moves', () => {
      const { onCustomColor } = renderPicker('#ff0000')
      const hue = screen.getByRole('slider', { name: 'Hue' })
      const field = screen.getByRole('textbox', { name: 'Hex' })

      fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 })
      expect(hue).toHaveAttribute('aria-valuenow', '18')
      expect(field).toHaveValue('#ff4d00')
      expect(onCustomColor).not.toHaveBeenCalled()

      fireEvent.keyUp(hue, { key: 'ArrowRight', keyCode: 39 })
      expect(onCustomColor).toHaveBeenCalledTimes(1)
      expect(onCustomColor).toHaveBeenCalledWith('#ff4d00')
    })

    // A move that returns to the current colour before release, as a drag back to its start does.
    it('does not commit a move that ends on the current colour', () => {
      const { onCustomColor } = renderPicker('#ff0000')
      const hue = screen.getByRole('slider', { name: 'Hue' })

      fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 })
      expect(hue).toHaveAttribute('aria-valuenow', '18')
      fireEvent.keyDown(hue, { key: 'ArrowLeft', keyCode: 37 })
      expect(hue).toHaveAttribute('aria-valuenow', '0')
      fireEvent.keyUp(hue, { key: 'ArrowLeft', keyCode: 37 })

      expect(onCustomColor).not.toHaveBeenCalled()
    })

    it('has no a11y violations while open, with an error showing', async () => {
      const user = userEvent.setup()
      const { container } = renderPicker('#1e8a7a')
      const field = screen.getByRole('textbox', { name: 'Hex' })
      await user.clear(field)
      await user.type(field, 'nope{Enter}')

      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = renderPicker('green')

    expect(await axe(container)).toHaveNoViolations()
  })
})
