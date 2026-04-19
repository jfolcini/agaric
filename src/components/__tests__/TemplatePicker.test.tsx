/**
 * Tests for TemplatePicker component.
 *
 * Validates:
 * - Renders template pages with content and preview
 * - Keyboard navigation (ArrowDown / ArrowUp) cycles focus
 * - Escape key calls onClose
 * - Click on a template calls onSelect with the page ID
 * - Click on backdrop calls onClose
 * - a11y compliance (axe audit)
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TemplatePicker } from '../block-tree/TemplatePicker'

const templatePages = [
  { id: 'T1', content: 'Meeting Notes', preview: 'Agenda, notes, action items' },
  { id: 'T2', content: 'Weekly Review', preview: null },
  { id: 'T3', content: '', preview: 'Empty title template' },
]

describe('TemplatePicker', () => {
  let onSelect: ReturnType<typeof vi.fn<(templatePageId: string) => void>>
  let onClose: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    onSelect = vi.fn<(templatePageId: string) => void>()
    onClose = vi.fn<() => void>()
  })

  it('renders all template pages', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    expect(screen.getByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.getByText('Weekly Review')).toBeInTheDocument()
    // Empty content falls back to t('block.untitled') = 'Untitled'
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('renders preview text when available', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    expect(screen.getByText('Agenda, notes, action items')).toBeInTheDocument()
    expect(screen.getByText('Empty title template')).toBeInTheDocument()
  })

  it('calls onSelect when a template is clicked', async () => {
    const user = userEvent.setup()

    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    await user.click(screen.getByText('Meeting Notes'))

    expect(onSelect).toHaveBeenCalledWith('T1')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape is pressed', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape is pressed while focus is outside the picker', () => {
    // Regression for TEST-1c-B: the TipTap editor installs a capture-phase
    // keydown listener on its container that calls stopPropagation on Escape.
    // The picker must intercept Escape on the document BEFORE the editor's
    // listener — otherwise Escape fails to close the picker when focus is
    // still in the editor (or anywhere outside the picker).
    const outside = document.createElement('div')
    // Capture-phase handler mimicking `useBlockKeyboard`: intercepts Escape
    // and stops propagation before it can bubble.
    outside.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      true,
    )
    document.body.appendChild(outside)
    try {
      render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)
      // Dispatch Escape with the "editor-owned" element as target so the
      // editor's capture listener would normally claim it.
      fireEvent.keyDown(outside, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      document.body.removeChild(outside)
    }
  })

  it('marks the dialog as an editor portal so TipTap stays mounted', () => {
    // Regression for TEST-1c-B: without `data-editor-portal`, the editor's
    // blur handler treats the picker as an unrelated element and unmounts
    // on button-focus, clearing `focusedBlockId` before the click-handler
    // can insert the template.
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-editor-portal')
  })

  it('navigates with ArrowDown and ArrowUp', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    const buttons = screen.getAllByRole('button')

    // First button should be auto-focused on mount
    expect(document.activeElement).toBe(buttons[0])

    // ArrowDown moves to second
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[1])

    // ArrowDown moves to third
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[2])

    // ArrowDown wraps around to first
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons[0])

    // ArrowUp wraps around to last
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(buttons[2])
  })

  it('auto-focuses the first button on mount', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    const buttons = screen.getAllByRole('button')
    expect(document.activeElement).toBe(buttons[0])
  })

  it('renders a dialog with correct aria attributes', () => {
    render(<TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-label')
  })

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup()

    const { container } = render(
      <TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />,
    )

    // The backdrop is the first child div with fixed inset-0
    const backdrop = container.querySelector('.fixed.inset-0')
    expect(backdrop).toBeInTheDocument()
    await user.click(backdrop as Element)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <TemplatePicker templatePages={templatePages} onSelect={onSelect} onClose={onClose} />,
    )

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
