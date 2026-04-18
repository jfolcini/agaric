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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { __resetPlatformCacheForTests } from '@/lib/platform'
import { KeyboardShortcuts } from '../KeyboardShortcuts'

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')

function setPlatform(value: string): void {
  Object.defineProperty(navigator, 'platform', {
    value,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(navigator, 'userAgentData', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  __resetPlatformCacheForTests()
}

function restorePlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(navigator, 'platform', originalPlatform)
  }
  __resetPlatformCacheForTests()
}

describe('KeyboardShortcuts', () => {
  beforeEach(() => {
    localStorage.clear()
    // Default tests to non-mac unless overridden.
    setPlatform('Linux x86_64')
  })

  afterEach(() => {
    restorePlatform()
  })

  it('renders sheet content when open', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByText(t('shortcuts.title'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.sheetDescription'))).toBeInTheDocument()
  })

  it('does not render sheet content when closed', () => {
    render(<KeyboardShortcuts open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText(t('shortcuts.title'))).not.toBeInTheDocument()
  })

  it('shows all shortcut entries', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Verify category headers
    expect(screen.getByText(t('keyboard.category.navigation'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.editing'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.pickers'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.undoRedo'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.historyView'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.global'))).toBeInTheDocument()

    // Verify all shortcuts are present
    expect(screen.getByText(t('keyboard.moveToPreviousBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.moveToNextBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.saveBlockAndClose'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.deleteBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.mergeWithPrevious'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.indentBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.dedentBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.tagPicker'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.blockLinkPicker'))).toBeInTheDocument()
    expect(screen.getAllByText(t('keyboard.slashCommandMenu')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(t('keyboard.showKeyboardShortcuts'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.closeOverlays'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.toggleCodeBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.moveBlockUp'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.moveBlockDown'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.focusSearch'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.createNewPage'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.collapseExpandChildren'))).toBeInTheDocument()

    // Verify key labels (keys are now split into individual <kbd> elements)
    expect(screen.getAllByText('Enter').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Arrow Right').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Shift').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('@')).toBeInTheDocument()
    expect(screen.getByText('[[')).toBeInTheDocument()
    expect(screen.getAllByText('Escape').length).toBeGreaterThanOrEqual(1)

    // Verify conditions are rendered separately from keys
    expect(screen.getAllByText(t('keyboard.condition.inEditor')).length).toBe(8)
    expect(screen.getByText(t('keyboard.condition.atStart'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.condition.atEnd'))).toBeInTheDocument()
  })

  it('renders syntax section with formatting entries', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Verify the syntax section header
    expect(screen.getByText(t('shortcuts.syntaxSection'))).toBeInTheDocument()

    // Verify syntax descriptions
    expect(screen.getByText(t('keyboard.syntax.bold'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.italic'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.inlineCode'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.strikethrough'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.highlight'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.heading'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.blockquote'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.codeBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.todoCheckbox'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.doneCheckbox'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.tagReference'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.syntax.pageLink'))).toBeInTheDocument()

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
    expect(table.dataset['slot']).toBe('scroll-area')
  })

  it('individual keys are rendered as separate kbd elements', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const kbds = screen.getByTestId('shortcuts-table').querySelectorAll('kbd')
    expect(kbds.length).toBeGreaterThanOrEqual(15)

    const kbdTexts = Array.from(kbds).map((el) => el.textContent)
    expect(kbdTexts).toContain('Shift')
    expect(kbdTexts).toContain('Arrow Right')
    expect(kbdTexts).toContain('Ctrl')
    expect(kbdTexts).toContain('Enter')
  })

  it('conditions are rendered as normal text, not inside kbd elements', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const kbds = screen.getByTestId('shortcuts-table').querySelectorAll('kbd')
    const kbdTexts = Array.from(kbds).map((el) => el.textContent)

    for (const text of kbdTexts) {
      expect(text).not.toContain(t('keyboard.condition.atStart'))
      expect(text).not.toContain(t('keyboard.condition.atEnd'))
      expect(text).not.toContain(t('keyboard.condition.onEmptyBlock'))
      expect(text).not.toContain(t('keyboard.condition.inEditor'))
    }

    expect(screen.getByText(t('keyboard.condition.atStart'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.condition.atEnd'))).toBeInTheDocument()
    expect(screen.getAllByText(t('keyboard.condition.inEditor'))).toHaveLength(8)
  })

  it('shows customized shortcuts when localStorage has overrides', () => {
    localStorage.setItem('agaric-keyboard-shortcuts', JSON.stringify({ focusSearch: 'Ctrl + G' }))
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    // Find the row containing the "Focus search" description
    const focusSearchLabel = screen.getByText(t('keyboard.focusSearch'))
    const row = focusSearchLabel.closest('tr') as HTMLElement
    expect(row).toBeTruthy()

    // Within that row, verify the custom keybinding keys are shown
    const kbdTexts = Array.from(row.querySelectorAll('kbd')).map((el) => el.textContent)
    expect(kbdTexts).toContain('Ctrl')
    expect(kbdTexts).toContain('G')

    // The original default key 'F' should NOT appear in that row
    expect(kbdTexts).not.toContain('F')
  })

  // UX-223 + BUG-31 bundled: macOS users see ⌘ (Cmd) instead of Ctrl in the help UI.
  describe('macOS platform display (UX-223)', () => {
    it('renders "⌘" instead of "Ctrl" on macOS', () => {
      setPlatform('MacIntel')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const kbdTexts = Array.from(
        screen.getByTestId('shortcuts-table').querySelectorAll('kbd'),
      ).map((el) => el.textContent)

      expect(kbdTexts).toContain('\u2318')
      // "Ctrl" should not appear anywhere in the rendered kbd labels.
      expect(kbdTexts).not.toContain('Ctrl')
    })

    it('still shows "Ctrl" on non-mac platforms', () => {
      setPlatform('Linux x86_64')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const kbdTexts = Array.from(
        screen.getByTestId('shortcuts-table').querySelectorAll('kbd'),
      ).map((el) => el.textContent)

      expect(kbdTexts).toContain('Ctrl')
      expect(kbdTexts).not.toContain('\u2318')
    })
  })

  // BUG-31: strikethrough binding had drifted between keyboard-config,
  // tooltip, and docs. Lock the resolved binding in at the display path.
  it('renders strikethrough as Ctrl + Shift + X (BUG-31)', () => {
    setPlatform('Linux x86_64')
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const strikethroughLabel = screen.getByText(t('keyboard.strikethrough'))
    const row = strikethroughLabel.closest('tr') as HTMLElement
    const kbdTexts = Array.from(row.querySelectorAll('kbd')).map((el) => el.textContent)
    expect(kbdTexts).toEqual(['Ctrl', 'Shift', 'X'])
  })
})
