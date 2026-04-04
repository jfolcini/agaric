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

    expect(screen.getByText('Quick Reference')).toBeInTheDocument()
    expect(
      screen.getByText('Available keyboard shortcuts and syntax reference for the editor.'),
    ).toBeInTheDocument()
  })

  it('does not render sheet content when closed', () => {
    render(<KeyboardShortcuts open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText('Quick Reference')).not.toBeInTheDocument()
  })

  it('shows all shortcut entries', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Verify category headers
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Editing')).toBeInTheDocument()
    expect(screen.getByText('Pickers')).toBeInTheDocument()
    expect(screen.getByText('Undo / Redo')).toBeInTheDocument()
    expect(screen.getByText('History View')).toBeInTheDocument()
    expect(screen.getByText('Global')).toBeInTheDocument()

    // Verify all shortcuts are present
    expect(screen.getByText('Move to previous block')).toBeInTheDocument()
    expect(screen.getByText('Move to next block')).toBeInTheDocument()
    expect(screen.getByText('Save block and close editor')).toBeInTheDocument()
    expect(screen.getByText('Delete block')).toBeInTheDocument()
    expect(screen.getByText('Merge with previous')).toBeInTheDocument()
    expect(screen.getByText('Indent block')).toBeInTheDocument()
    expect(screen.getByText('Dedent block')).toBeInTheDocument()
    expect(screen.getByText('Tag picker')).toBeInTheDocument()
    expect(screen.getByText('Block link picker')).toBeInTheDocument()
    expect(screen.getAllByText('Slash command menu').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Close dialog / cancel editing')).toBeInTheDocument()
    expect(screen.getByText('Toggle code block')).toBeInTheDocument()
    expect(screen.getByText('Move block up')).toBeInTheDocument()
    expect(screen.getByText('Move block down')).toBeInTheDocument()
    expect(screen.getByText('Focus search')).toBeInTheDocument()
    expect(screen.getByText('Create new page')).toBeInTheDocument()
    expect(screen.getByText('Collapse / expand children')).toBeInTheDocument()

    // Verify key labels (keys are now split into individual <kbd> elements)
    expect(screen.getAllByText('Enter').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Tab').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Shift').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('@')).toBeInTheDocument()
    expect(screen.getByText('[[')).toBeInTheDocument()
    expect(screen.getAllByText('Escape').length).toBeGreaterThanOrEqual(1)

    // Verify conditions are rendered separately from keys
    expect(screen.getAllByText('in editor').length).toBe(4)
    expect(screen.getByText('at start')).toBeInTheDocument()
    expect(screen.getByText('at end')).toBeInTheDocument()
  })

  it('renders syntax section with formatting entries', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Verify the syntax section header
    expect(screen.getByText('Syntax')).toBeInTheDocument()

    // Verify syntax descriptions
    expect(screen.getByText('Bold')).toBeInTheDocument()
    expect(screen.getByText('Italic')).toBeInTheDocument()
    expect(screen.getByText('Inline code')).toBeInTheDocument()
    expect(screen.getByText('Strikethrough')).toBeInTheDocument()
    expect(screen.getByText('Highlight')).toBeInTheDocument()
    expect(screen.getByText('Heading (1-6 levels)')).toBeInTheDocument()
    expect(screen.getByText('Blockquote')).toBeInTheDocument()
    expect(screen.getByText('Code block')).toBeInTheDocument()
    expect(screen.getByText('TODO checkbox')).toBeInTheDocument()
    expect(screen.getByText('DONE checkbox')).toBeInTheDocument()
    expect(screen.getByText('Tag reference')).toBeInTheDocument()
    expect(screen.getByText('Page link')).toBeInTheDocument()

    // Verify syntax entries are rendered in monospace code elements
    const syntaxTable = screen.getByTestId('syntax-table')
    const codeElements = syntaxTable.querySelectorAll('code')
    expect(codeElements.length).toBe(13)

    const codeTexts = Array.from(codeElements).map((el) => el.textContent)
    expect(codeTexts).toContain('**text**')
    expect(codeTexts).toContain('*text*')
    expect(codeTexts).toContain('`text`')
    expect(codeTexts).toContain('[[page]]')
    expect(codeTexts).toContain('@tag')
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

  it('shortcuts table container is scrollable', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const table = screen.getByTestId('shortcuts-table')
    expect(table.className).toContain('overflow-y-auto')
  })

  it('individual keys are rendered as separate kbd elements', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const kbds = screen.getByTestId('shortcuts-table').querySelectorAll('kbd')
    expect(kbds.length).toBeGreaterThanOrEqual(15)

    const kbdTexts = Array.from(kbds).map((el) => el.textContent)
    expect(kbdTexts).toContain('Shift')
    expect(kbdTexts).toContain('Tab')
    expect(kbdTexts).toContain('Ctrl')
    expect(kbdTexts).toContain('Enter')
  })

  it('conditions are rendered as normal text, not inside kbd elements', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const kbds = screen.getByTestId('shortcuts-table').querySelectorAll('kbd')
    const kbdTexts = Array.from(kbds).map((el) => el.textContent)

    for (const text of kbdTexts) {
      expect(text).not.toContain('at start')
      expect(text).not.toContain('at end')
      expect(text).not.toContain('on empty block')
      expect(text).not.toContain('in editor')
    }

    expect(screen.getByText('at start')).toBeInTheDocument()
    expect(screen.getByText('at end')).toBeInTheDocument()
    expect(screen.getAllByText('in editor')).toHaveLength(4)
  })
})
