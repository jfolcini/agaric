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
import { setCustomShortcut } from '@/lib/keyboard-config/storage'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
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

    // Verify conditions are rendered separately from keys. FEAT-7 moved the
    // 4 tab shortcuts (openInNewTab, closeActiveTab, nextTab, previousTab)
    // from the `inEditor` condition to `desktopOnly` so they fire shell-wide
    // on desktop. inEditor count dropped 8 → 4; desktopOnly count is now 4.
    expect(screen.getAllByText(t('keyboard.condition.inEditor')).length).toBe(4)
    expect(screen.getAllByText(t('keyboard.condition.desktopOnly')).length).toBe(4)
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
    expect(codeElements.length).toBe(14)

    const codeTexts = Array.from(codeElements).map((el) => el.textContent)
    expect(codeTexts).toContain('**text**')
    expect(codeTexts).toContain('*text*')
    expect(codeTexts).toContain('`text`')
    expect(codeTexts).toContain('[[page]]')
    expect(codeTexts).toContain('@tag')
  })

  // UX-310: the syntax cheat-sheet must document the `((` block-reference
  // picker trigger alongside the other 3 user-typed picker triggers
  // (`@tag`, `[[page]]`, `/command`).
  it('renders the ((block)) block-reference syntax entry (UX-310)', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const syntaxTable = screen.getByTestId('syntax-table')
    const codeTexts = Array.from(syntaxTable.querySelectorAll('code')).map((el) => el.textContent)
    expect(codeTexts).toContain('((block))')

    expect(screen.getByText(t('keyboard.syntax.blockReference'))).toBeInTheDocument()
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
        <input aria-label="Test input" data-testid="test-input" />
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
        <textarea aria-label="Test textarea" data-testid="test-textarea" />
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

  // UX-389: category headers stick to the top of the scroll viewport so the
  // user keeps category context mid-list. Pin the Tailwind classes that
  // implement the sticky behavior + opaque background + layering.
  it('category headers are sticky to keep context while scrolling (UX-389)', () => {
    render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

    const categoryLabel = screen.getByText(t('keyboard.category.navigation'))
    const cell = categoryLabel.closest('td') as HTMLElement
    expect(cell).toBeTruthy()
    expect(cell.className).toContain('sticky')
    expect(cell.className).toContain('top-0')
    expect(cell.className).toContain('z-10')
    expect(cell.className).toContain('bg-background')
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
      expect(text).not.toContain(t('keyboard.condition.desktopOnly'))
    }

    expect(screen.getByText(t('keyboard.condition.atStart'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.condition.atEnd'))).toBeInTheDocument()
    // FEAT-7: inEditor 8 → 4, desktopOnly 0 → 4 (see "shows all shortcut
    // entries" above for the rationale).
    expect(screen.getAllByText(t('keyboard.condition.inEditor'))).toHaveLength(4)
    expect(screen.getAllByText(t('keyboard.condition.desktopOnly'))).toHaveLength(4)
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

  // UX-228: closeOverlays shortcut dispatches a window CustomEvent;
  // KeyboardShortcuts listens and calls onOpenChange(false). Verified
  // here without the full App so we catch regressions even when the
  // component is rendered standalone (e.g. from a future settings tab).
  describe('closeOverlays event (UX-228)', () => {
    it('dispatching agaric:closeAllOverlays while open calls onOpenChange(false)', () => {
      const onOpenChange = vi.fn()
      render(<KeyboardShortcuts open={true} onOpenChange={onOpenChange} />)

      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('dispatching agaric:closeAllOverlays while closed still calls onOpenChange(false) idempotently', () => {
      const onOpenChange = vi.fn()
      render(<KeyboardShortcuts open={false} onOpenChange={onOpenChange} />)

      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      // The listener is unconditional (setOpen(false) is idempotent).
      // What we care about is that the handler ran without throwing.
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('unsubscribes on unmount', () => {
      const onOpenChange = vi.fn()
      const { unmount } = render(<KeyboardShortcuts open={true} onOpenChange={onOpenChange} />)

      unmount()
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      expect(onOpenChange).not.toHaveBeenCalled()
    })
  })

  // UX-395: the footer "Customize" button navigates away to Settings → Keyboard.
  // Make the label say "Customize in Settings" and add a ChevronRight glyph
  // after the text to telegraph the navigation.
  describe('customize footer button (UX-395)', () => {
    it('button label reads "Customize in Settings"', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const button = screen.getByTestId('keyboard-customize-button')
      expect(button).toHaveTextContent('Customize in Settings')
    })

    it('button renders a ChevronRight icon after the label', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const button = screen.getByTestId('keyboard-customize-button')
      // lucide-react renders SVGs with a `lucide-chevron-right` class.
      const chevron = button.querySelector('svg.lucide-chevron-right')
      expect(chevron).not.toBeNull()
    })
  })

  // UX-388: filter input narrows the visible shortcuts by description, key
  // text, or category so users don't have to eyeball-scan the full list.
  describe('shortcut filter (UX-388)', () => {
    it('renders the filter input above the table', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const filterInput = screen.getByTestId('shortcuts-filter')
      expect(filterInput).toBeInTheDocument()
      expect(filterInput).toHaveAttribute('placeholder', t('keyboard.filterPlaceholder'))
      expect(filterInput).toHaveAttribute('aria-label', t('keyboard.filterLabel'))
    })

    it('typing into the filter narrows the visible shortcuts', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      // Sanity: an unrelated shortcut is visible before filtering.
      expect(screen.getByText(t('keyboard.focusSearch'))).toBeInTheDocument()
      expect(screen.getByText(t('keyboard.indentBlock'))).toBeInTheDocument()

      const filterInput = screen.getByTestId('shortcuts-filter')
      fireEvent.change(filterInput, { target: { value: 'indent' } })

      // The matching shortcut stays visible…
      expect(screen.getByText(t('keyboard.indentBlock'))).toBeInTheDocument()
      // …and unrelated ones disappear.
      expect(screen.queryByText(t('keyboard.focusSearch'))).not.toBeInTheDocument()
    })

    it('shows the empty-state message when no shortcuts match', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const filterInput = screen.getByTestId('shortcuts-filter')
      fireEvent.change(filterInput, { target: { value: 'zzznomatchzzz' } })

      expect(screen.getByTestId('shortcuts-filter-empty')).toHaveTextContent(
        t('keyboard.filterEmpty'),
      )
      // The shortcuts table should no longer show any rows.
      expect(screen.queryByText(t('keyboard.focusSearch'))).not.toBeInTheDocument()
    })

    it('clearing the filter restores the full list', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const filterInput = screen.getByTestId('shortcuts-filter')
      fireEvent.change(filterInput, { target: { value: 'indent' } })
      expect(screen.queryByText(t('keyboard.focusSearch'))).not.toBeInTheDocument()

      fireEvent.change(filterInput, { target: { value: '' } })

      expect(screen.getByText(t('keyboard.focusSearch'))).toBeInTheDocument()
      expect(screen.getByText(t('keyboard.indentBlock'))).toBeInTheDocument()
      expect(screen.queryByTestId('shortcuts-filter-empty')).not.toBeInTheDocument()
    })
  })

  // Discoverability: the quick-capture global hotkey is OS-wide but was
  // never announced inside the app. Surface it in the help panel under
  // its own "Quick Capture" category, sourced from the same storage helper
  // SettingsView reads (so customisation flows through).
  describe('quick-capture hotkey announcement', () => {
    it('renders a Quick Capture category with the platform default chord', () => {
      setPlatform('Linux x86_64')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      expect(screen.getByText(t('keyboard.category.quickCapture'))).toBeInTheDocument()
      const actionLabel = screen.getByText(t('keyboard.quickCapture.openDialog'))
      const row = actionLabel.closest('tr') as HTMLElement
      expect(row).toBeTruthy()

      // Linux/Windows default: Ctrl+Alt+N → rendered as three <kbd>s.
      const kbdTexts = Array.from(row.querySelectorAll('kbd')).map((el) => el.textContent)
      expect(kbdTexts).toEqual(['Ctrl', 'Alt', 'N'])
    })

    it('renders the macOS default chord with the ⌘ glyph on macOS', () => {
      setPlatform('MacIntel')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const actionLabel = screen.getByText(t('keyboard.quickCapture.openDialog'))
      const row = actionLabel.closest('tr') as HTMLElement
      const kbdTexts = Array.from(row.querySelectorAll('kbd')).map((el) => el.textContent)
      // `loadQuickCaptureShortcut()` returns `Cmd+Alt+N` on mac and
      // `normaliseAccelerator` rewrites `Cmd` → `Ctrl` so `renderKeys`
      // substitutes the platform mod glyph.
      expect(kbdTexts).toEqual(['⌘', 'Alt', 'N'])
    })

    it('reflects the user-customised chord persisted in localStorage', () => {
      setPlatform('Linux x86_64')
      localStorage.setItem('agaric:quickCaptureShortcut', 'Ctrl+Shift+J')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const actionLabel = screen.getByText(t('keyboard.quickCapture.openDialog'))
      const row = actionLabel.closest('tr') as HTMLElement
      const kbdTexts = Array.from(row.querySelectorAll('kbd')).map((el) => el.textContent)
      expect(kbdTexts).toEqual(['Ctrl', 'Shift', 'J'])
    })
  })

  // Discoverability: `agaric://…` deep links work but were undocumented.
  // List the three routes the Rust router (`parse_deep_link`) accepts.
  describe('deep links section', () => {
    it('renders the section header and description', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      expect(screen.getByTestId('deep-links-section-title')).toHaveTextContent(
        t('keyboard.section.deepLinks'),
      )
      expect(screen.getByText(t('keyboard.deepLinks.description'))).toBeInTheDocument()
    })

    it('lists exactly the three documented deep-link routes', () => {
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const table = screen.getByTestId('deep-links-table')
      const codeTexts = Array.from(table.querySelectorAll('code')).map((el) => el.textContent)
      expect(codeTexts).toEqual([
        'agaric://block/<ULID>',
        'agaric://page/<ULID>',
        'agaric://settings/<tab>',
      ])

      expect(screen.getByText(t('keyboard.deepLinks.block'))).toBeInTheDocument()
      expect(screen.getByText(t('keyboard.deepLinks.page'))).toBeInTheDocument()
      expect(screen.getByText(t('keyboard.deepLinks.settings'))).toBeInTheDocument()
    })

    it('has no a11y violations with the new sections rendered', async () => {
      const { container } = render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // UX-397: customised shortcuts in the help panel are flagged with a
  // "Customized" badge so users can tell which rows reflect their own
  // bindings vs. defaults.
  describe('customized badge (UX-397)', () => {
    it('renders a "Customized" badge in the row of an overridden shortcut', () => {
      setCustomShortcut('focusSearch', 'Ctrl + G')
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const focusSearchLabel = screen.getByText(t('keyboard.focusSearch'))
      const row = focusSearchLabel.closest('tr') as HTMLElement
      expect(row).toBeTruthy()
      expect(row.textContent).toContain(t('keyboard.settings.customized'))
    })

    it('does not render a "Customized" badge for default (un-overridden) shortcuts', () => {
      // No overrides set in localStorage.
      render(<KeyboardShortcuts open={true} onOpenChange={vi.fn()} />)

      const focusSearchLabel = screen.getByText(t('keyboard.focusSearch'))
      const row = focusSearchLabel.closest('tr') as HTMLElement
      expect(row).toBeTruthy()
      expect(row.textContent).not.toContain(t('keyboard.settings.customized'))
    })
  })
})
