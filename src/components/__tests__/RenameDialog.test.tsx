import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { RenameDialog } from '../RenameDialog'

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
})
