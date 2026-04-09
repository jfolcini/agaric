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

    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Editing')).toBeInTheDocument()
  })

  it('shows shortcut descriptions', () => {
    render(<KeyboardSettingsTab />)

    expect(screen.getByText('Move to previous block')).toBeInTheDocument()
    expect(screen.getByText('Move to next block')).toBeInTheDocument()
    expect(screen.getByText('Save block and close editor')).toBeInTheDocument()
    expect(screen.getByText('Indent block')).toBeInTheDocument()
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

    const saveButton = screen.getByRole('button', { name: 'Save' })
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

    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    await user.click(cancelButton)

    // Should not have called setCustomShortcut
    expect(mockSetCustomShortcut).not.toHaveBeenCalled()

    // Input should be gone
    expect(screen.queryByPlaceholderText('Type new key binding...')).not.toBeInTheDocument()
  })

  it('reset single shortcut calls resetShortcut', async () => {
    const user = userEvent.setup()
    render(<KeyboardSettingsTab />)

    // indentBlock is customized (isCustom: true), so "Reset to default" link should appear
    const resetButton = screen.getByText('Reset to default')
    await user.click(resetButton)

    expect(mockResetShortcut).toHaveBeenCalledWith('indentBlock')
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
    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()

    // Empty binding message should be visible
    expect(screen.getByText('Key binding cannot be empty')).toBeInTheDocument()
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
})
