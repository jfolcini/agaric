/**
 * Tests for KeyboardShortcuts component (UX #9).
 *
 * Validates:
 *  - Renders the sheet content when open
 *  - Shows all shortcut entries
 *  - Global `?` key listener opens the sheet
 *  - Does NOT open when typing in an input
 *  - a11y compliance
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { KeyboardShortcuts } from '../KeyboardShortcuts'

describe('KeyboardShortcuts', () => {
  it('renders sheet content when open', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Available keyboard shortcuts for the editor.')).toBeInTheDocument()
  })

  it('does not render sheet content when closed', () => {
    render(<KeyboardShortcuts open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('shows all shortcut entries', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Verify all shortcuts are present
    expect(screen.getByText('Move to previous block')).toBeInTheDocument()
    expect(screen.getByText('Move to next block')).toBeInTheDocument()
    expect(screen.getByText('Delete block')).toBeInTheDocument()
    expect(screen.getByText('Merge with previous')).toBeInTheDocument()
    expect(screen.getByText('Indent block')).toBeInTheDocument()
    expect(screen.getByText('Dedent block')).toBeInTheDocument()
    expect(screen.getByText('Tag picker')).toBeInTheDocument()
    expect(screen.getByText('Block link picker')).toBeInTheDocument()
    expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument()

    // Verify key labels
    expect(screen.getByText('Tab')).toBeInTheDocument()
    expect(screen.getByText('Shift + Tab')).toBeInTheDocument()
    expect(screen.getByText('# in editor')).toBeInTheDocument()
    expect(screen.getByText('[[ in editor')).toBeInTheDocument()
  })

  it('opens sheet when ? key is pressed on document', () => {
    const onOpenChange = vi.fn()
    render(<KeyboardShortcuts open={false} onOpenChange={onOpenChange} />)

    fireEvent.keyDown(document, { key: '?' })

    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('does NOT open when ? is pressed inside an input', () => {
    const onOpenChange = vi.fn()
    const { container } = render(
      <div>
        <input data-testid="test-input" />
        <KeyboardShortcuts open={false} onOpenChange={onOpenChange} />
      </div>,
    )

    const input = container.querySelector('input') as HTMLInputElement
    fireEvent.keyDown(input, { key: '?' })

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does NOT open when ? is pressed inside a textarea', () => {
    const onOpenChange = vi.fn()
    const { container } = render(
      <div>
        <textarea data-testid="test-textarea" />
        <KeyboardShortcuts open={false} onOpenChange={onOpenChange} />
      </div>,
    )

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: '?' })

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does NOT open when ? is pressed inside a contenteditable', () => {
    const onOpenChange = vi.fn()
    const { container } = render(
      <div>
        <div contentEditable="true" data-testid="test-editable" />
        <KeyboardShortcuts open={false} onOpenChange={onOpenChange} />
      </div>,
    )

    const editable = container.querySelector('[contenteditable]') as HTMLElement
    fireEvent.keyDown(editable, { key: '?' })

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not react to non-? keys', () => {
    const onOpenChange = vi.fn()
    render(<KeyboardShortcuts open={false} onOpenChange={onOpenChange} />)

    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
