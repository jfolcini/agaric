import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  MAX_RENAME_LENGTH,
  RenameDialog,
  sanitizeRenameInput,
  validateRenameInput,
} from '../RenameDialog'

describe('RenameDialog', () => {
  it('renders nothing when not open', () => {
    render(
      <RenameDialog
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        currentName="My Device"
      />,
    )
    expect(screen.queryByText('Rename device')).not.toBeInTheDocument()
  })

  it('renders title, description, input and buttons when open', () => {
    render(
      <RenameDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        currentName="My Device"
      />,
    )
    expect(screen.getByText('Rename device')).toBeInTheDocument()
    expect(screen.getByText('Enter a name for this device.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /device name/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('initializes input with currentName', () => {
    render(
      <RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} currentName="Laptop" />,
    )
    expect(screen.getByRole('textbox', { name: /device name/i })).toHaveValue('Laptop')
  })

  it('calls onConfirm with trimmed value when Save is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} currentName="" />)
    const input = screen.getByRole('textbox', { name: /device name/i })
    await user.clear(input)
    await user.type(input, '  New Name  ')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onConfirm).toHaveBeenCalledWith('New Name')
  })

  it('calls onConfirm with trimmed value on Enter key', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} currentName="Old" />,
    )
    const input = screen.getByRole('textbox', { name: /device name/i })
    await user.clear(input)
    await user.type(input, ' Updated ')
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledWith('Updated')
  })

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <RenameDialog
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        currentName="Test"
      />,
    )
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has no a11y violations', async () => {
    render(
      <RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} currentName="Device" />,
    )
    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })

  // ----------------------------------------------------------------------
  // UX-263: input validation (trim, empty, length cap, control chars)
  // ----------------------------------------------------------------------

  describe('validateRenameInput / sanitizeRenameInput (UX-263)', () => {
    it('reports empty for whitespace-only input', () => {
      expect(validateRenameInput('')).toBe('empty')
      expect(validateRenameInput('   ')).toBe('empty')
      expect(validateRenameInput('\t\n')).toBe('empty')
    })

    it('reports tooLong above MAX_RENAME_LENGTH', () => {
      const tooLong = 'a'.repeat(MAX_RENAME_LENGTH + 1)
      expect(validateRenameInput(tooLong)).toBe('tooLong')
    })

    it('accepts a name exactly at the length cap', () => {
      expect(validateRenameInput('a'.repeat(MAX_RENAME_LENGTH))).toBeNull()
    })

    it('accepts trimmed names that fit within the cap', () => {
      expect(validateRenameInput('  Living Room Mac  ')).toBeNull()
    })

    it('strips ASCII control characters before measuring length', () => {
      const noisy = `Lap\u0000top\u001Fname\u007F`
      expect(sanitizeRenameInput(noisy)).toBe('Laptopname')
      expect(validateRenameInput(noisy)).toBeNull()
    })

    it('treats input that becomes empty after stripping control chars as empty', () => {
      expect(validateRenameInput('\u0000\u001F\u007F')).toBe('empty')
    })
  })

  it('disables Save when the input is empty (UX-263)', () => {
    render(<RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} currentName="" />)
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()
  })

  it('shows inline error after the user clears the field (UX-263)', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <RenameDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        currentName="Laptop"
      />,
    )
    const input = screen.getByRole('textbox', { name: /device name/i }) as HTMLInputElement
    await user.clear(input)

    // aria-invalid is set on the input once the user has touched it.
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toMatch(/empty/i)
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('blocks Save and shows tooLong error when the name exceeds the cap (UX-263)', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} currentName="" />)
    const input = screen.getByRole('textbox', { name: /device name/i }) as HTMLInputElement
    // Type one character past the cap. We type the full string so the touched
    // flag is set via the onChange handler.
    await user.type(input, 'a'.repeat(MAX_RENAME_LENGTH + 1))

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toMatch(/64 characters or fewer/i)
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('strips control characters from pasted input before persisting (UX-263)', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<RenameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} currentName="" />)
    const input = screen.getByRole('textbox', { name: /device name/i }) as HTMLInputElement
    await user.click(input)
    // Paste a name with embedded control characters and surrounding whitespace.
    await user.paste('  Living\u0000Room\u001FMac  ')

    // Control chars are stripped on input; trim happens on submit.
    expect(input.value).toBe('  LivingRoomMac  ')

    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onConfirm).toHaveBeenCalledWith('LivingRoomMac')
  })
})
