/**
 * Tests for KeyboardSettingsTab component (UX-86).
 *
 * Validates:
 *  - Renders all categories
 *  - Shows shortcut descriptions
 *  - Edit button opens input
 *  - Save persists changes
 *  - Cancel discards changes
 *  - Reset single shortcut
 *  - Reset all with confirmation dialog
 *  - Conflict warning displayed
 *  - Empty binding rejected
 *  - axe a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import type { ShortcutBinding } from '@/lib/keyboard-config'
import { KeyboardSettingsTab } from '../KeyboardSettingsTab'

const mockGetCurrentShortcuts = vi.fn()
const mockSetCustomShortcut = vi.fn()
const mockResetShortcut = vi.fn()
const mockResetAllShortcuts = vi.fn()
const mockFindConflicts = vi.fn()

vi.mock('@/lib/keyboard-config', () => ({
  getCurrentShortcuts: (...args: unknown[]) => mockGetCurrentShortcuts(...args),
  setCustomShortcut: (...args: unknown[]) => mockSetCustomShortcut(...args),
  resetShortcut: (...args: unknown[]) => mockResetShortcut(...args),
  resetAllShortcuts: (...args: unknown[]) => mockResetAllShortcuts(...args),
  findConflicts: (...args: unknown[]) => mockFindConflicts(...args),
}))

const MOCK_SHORTCUTS: (ShortcutBinding & { isCustom: boolean })[] = [
  {
    id: 'prevBlock',
    keys: 'Arrow Up / Left',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToPreviousBlock',
    condition: 'keyboard.condition.atStart',
    isCustom: false,
  },
  {
    id: 'nextBlock',
    keys: 'Arrow Down / Right',
    category: 'keyboard.category.navigation',
    description: 'keyboard.moveToNextBlock',
    condition: 'keyboard.condition.atEnd',
    isCustom: false,
  },
  {
    id: 'saveBlock',
    keys: 'Enter',
    category: 'keyboard.category.editing',
    description: 'keyboard.saveBlockAndClose',
    isCustom: false,
  },
  {
    id: 'indentBlock',
    keys: 'Ctrl + Shift + Arrow Right',
    category: 'keyboard.category.editing',
    description: 'keyboard.indentBlock',
    isCustom: true,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentShortcuts.mockReturnValue(MOCK_SHORTCUTS)
  mockFindConflicts.mockReturnValue([])
})

describe('KeyboardSettingsTab', () => {
  it('renders all categories', () => {
    render(<KeyboardSettingsTab />)

    expect(screen.getByText(t('keyboard.category.navigation'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.category.editing'))).toBeInTheDocument()
  })

  it('shows shortcut descriptions', () => {
    render(<KeyboardSettingsTab />)

    expect(screen.getByText(t('keyboard.moveToPreviousBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.moveToNextBlock'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.saveBlockAndClose'))).toBeInTheDocument()
    expect(screen.getByText(t('keyboard.indentBlock'))).toBeInTheDocument()
  })

  it('shows kbd elements for shortcut keys', () => {
    render(<KeyboardSettingsTab />)

    // Check for kbd elements
    const kbdElements = screen.getAllByText((_, element) => element?.tagName === 'KBD')
    expect(kbdElements.length).toBeGreaterThan(0)
  })

  it('edit button opens input', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    expect(editButtons.length).toBeGreaterThan(0)

    await user.click(editButtons[0] as HTMLElement)

    // Input field should be visible
    const input = screen.getByPlaceholderText('Type new key binding...')
    expect(input).toBeInTheDocument()
  })

  it('save persists changes', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    await user.click(editButtons[0] as HTMLElement)

    const input = screen.getByPlaceholderText('Type new key binding...')
    await user.clear(input)
    await user.type(input, 'Ctrl + P')

    const saveButton = screen.getByRole('button', { name: t('keyboard.settings.saveButton') })
    await user.click(saveButton)

    expect(mockSetCustomShortcut).toHaveBeenCalledWith('prevBlock', 'Ctrl + P')
  })

  it('cancel discards changes', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    await user.click(editButtons[0] as HTMLElement)

    const input = screen.getByPlaceholderText('Type new key binding...')
    await user.clear(input)
    await user.type(input, 'Ctrl + P')

    const cancelButton = screen.getByRole('button', { name: t('keyboard.settings.cancelButton') })
    await user.click(cancelButton)

    // Should not have called setCustomShortcut
    expect(mockSetCustomShortcut).not.toHaveBeenCalled()

    // Input should be gone
    expect(screen.queryByPlaceholderText('Type new key binding...')).not.toBeInTheDocument()
  })

  it('reset single shortcut calls resetShortcut and updates UI', async () => {
    const user = userEvent.setup()

    // After resetShortcut is called, getCurrentShortcuts should return the default (non-custom) binding
    const shortcutsAfterReset = MOCK_SHORTCUTS.map((s) =>
      s.id === 'indentBlock' ? { ...s, keys: 'Tab', isCustom: false } : s,
    )
    mockResetShortcut.mockImplementation(() => {
      mockGetCurrentShortcuts.mockReturnValue(shortcutsAfterReset)
    })

    render(<KeyboardSettingsTab />)

    // Before reset: "Customized" badge should be visible
    expect(screen.getByText('Customized')).toBeInTheDocument()
    // Before reset: "Reset to default" link should be visible
    expect(screen.getByText('Reset to default')).toBeInTheDocument()

    // Click reset
    await user.click(screen.getByText('Reset to default'))

    expect(mockResetShortcut).toHaveBeenCalledWith('indentBlock')

    // After reset: "Customized" badge should disappear
    await waitFor(() => {
      expect(screen.queryByText('Customized')).not.toBeInTheDocument()
    })

    // After reset: "Reset to default" link should also disappear
    expect(screen.queryByText('Reset to default')).not.toBeInTheDocument()

    // After reset: shortcut key display should revert to the default value
    expect(screen.getByText('Tab')).toBeInTheDocument()
  })

  it('reset all with confirmation dialog', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const resetAllButton = screen.getByRole('button', { name: 'Reset All to Defaults' })
    await user.click(resetAllButton)

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(
        screen.getByText('Reset all keyboard shortcuts to their default bindings?'),
      ).toBeInTheDocument()
    })

    // Click the action button in the dialog
    const confirmButton = screen.getAllByRole('button', { name: 'Reset All to Defaults' })
    // The last one is the dialog action button
    await user.click(confirmButton[confirmButton.length - 1] as HTMLElement)

    expect(mockResetAllShortcuts).toHaveBeenCalled()
  })

  it('conflict warning displayed', () => {
    mockFindConflicts.mockReturnValue([
      {
        ids: ['prevBlock', 'nextBlock'],
        keys: 'Arrow Up / Left',
        category: 'keyboard.category.navigation',
      },
    ])

    render(<KeyboardSettingsTab />)

    // Should show conflict warning with the description of the conflicting shortcut
    expect(screen.getAllByText(/Conflicts with:/i).length).toBeGreaterThan(0)
  })

  it('empty binding rejected (save disabled)', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    await user.click(editButtons[0] as HTMLElement)

    const input = screen.getByPlaceholderText('Type new key binding...')
    await user.clear(input)

    // The save button should be disabled
    const saveButton = screen.getByRole('button', { name: t('keyboard.settings.saveButton') })
    expect(saveButton).toBeDisabled()

    // Empty binding message should be visible
    expect(screen.getByText('Key binding cannot be empty')).toBeInTheDocument()
  })

  it('UX-8: empty-binding error is wired to the input via aria-describedby + aria-invalid', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    await user.click(editButtons[0] as HTMLElement)

    const input = screen.getByPlaceholderText('Type new key binding...')
    await user.clear(input)

    // While the binding is empty, the input must point at the error <p>
    expect(input.getAttribute('aria-describedby')).toBe('kbd-empty-binding-error')
    expect(input.getAttribute('aria-invalid')).toBe('true')

    // The error <p> must own that id.
    const errorP = screen.getByText('Key binding cannot be empty')
    expect(errorP.getAttribute('id')).toBe('kbd-empty-binding-error')

    // Once the user types something, the error and the wiring must clear.
    await user.type(input, 'Ctrl + P')
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('Key binding cannot be empty')).not.toBeInTheDocument()
  })

  it('shows "Customized" badge for custom shortcuts', () => {
    render(<KeyboardSettingsTab />)

    expect(screen.getByText('Customized')).toBeInTheDocument()
  })

  it('save via Enter key', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    const editButtons = screen.getAllByRole('button', { name: /Edit shortcut for/i })
    await user.click(editButtons[0] as HTMLElement)

    const input = screen.getByPlaceholderText('Type new key binding...')
    await user.clear(input)
    await user.type(input, 'Ctrl + P{Enter}')

    expect(mockSetCustomShortcut).toHaveBeenCalledWith('prevBlock', 'Ctrl + P')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<KeyboardSettingsTab />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('UX-223: renders the Ctrl token as ⌘ on macOS', async () => {
    vi.resetModules()
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test-only helper
    ;(navigator as any).userAgentData = undefined

    try {
      const { __resetPlatformCacheForTests } = await import('../../lib/platform')
      __resetPlatformCacheForTests()
      const { KeyboardSettingsTab: MacTab } = await import('../KeyboardSettingsTab')

      render(<MacTab />)

      // The indentBlock row has keys "Ctrl + Shift + Arrow Right" — on macOS the
      // Ctrl kbd must be rendered as ⌘, not the literal "Ctrl".
      const cmdKeys = screen.getAllByText('⌘')
      expect(cmdKeys.length).toBeGreaterThan(0)
      expect(screen.queryByText('Ctrl')).toBeNull()
    } finally {
      if (original) Object.defineProperty(navigator, 'platform', original)
    }
  })

  it('UX-223: renders the Ctrl token verbatim on non-macOS', async () => {
    vi.resetModules()
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test-only helper
    ;(navigator as any).userAgentData = undefined

    try {
      const { __resetPlatformCacheForTests } = await import('../../lib/platform')
      __resetPlatformCacheForTests()
      const { KeyboardSettingsTab: LinuxTab } = await import('../KeyboardSettingsTab')

      render(<LinuxTab />)

      // On Linux, Ctrl renders literally and no ⌘ appears.
      const ctrlKeys = screen.getAllByText('Ctrl')
      expect(ctrlKeys.length).toBeGreaterThan(0)
      expect(screen.queryByText('⌘')).toBeNull()
    } finally {
      if (original) Object.defineProperty(navigator, 'platform', original)
    }
  })
})
