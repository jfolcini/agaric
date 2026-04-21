/**
 * Tests for SettingsView component (F-30).
 *
 * Validates:
 *  - Renders with 8 tabs
 *  - General tab shows deadline warning section (UX-202: TaskStatesSection removed)
 *  - Properties tab shows property definitions
 *  - Appearance tab shows theme toggle
 *  - Sync tab shows device management
 *  - Agent access tab (FEAT-4e)
 *  - Tab switching works
 *  - Theme toggle changes localStorage and document class
 *  - Font size selector updates localStorage and CSS variable
 *  - axe a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { SettingsView } from '../SettingsView'

// Mock child components to isolate SettingsView logic

vi.mock('../DeadlineWarningSection', () => ({
  DeadlineWarningSection: () => <div data-testid="deadline-warning-section">Deadline Warning</div>,
}))

vi.mock('../PropertyDefinitionsList', () => ({
  PropertyDefinitionsList: () => (
    <div data-testid="property-definitions-list">Property Definitions</div>
  ),
}))

vi.mock('../DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management">Device Management</div>,
}))

vi.mock('../KeyboardSettingsTab', () => ({
  KeyboardSettingsTab: () => (
    <div data-testid="keyboard-settings-tab">Keyboard Settings Content</div>
  ),
}))

vi.mock('../DataSettingsTab', () => ({
  DataSettingsTab: () => <div data-testid="data-settings-tab">Data Settings Content</div>,
}))

// FEAT-4e: AgentAccessSettingsTab is rendered inside the "Agent access"
// tab panel. Mock it as an inert marker so the SettingsView tests stay
// focused on tab routing / theme / font-size behaviour.
vi.mock('../AgentAccessSettingsTab', () => ({
  AgentAccessSettingsTab: () => (
    <div data-testid="agent-access-settings-tab">Agent Access</div>
  ),
}))

// FEAT-5: BugReportDialog is rendered by SettingsView but its heavy internal
// logic (IPC + logs) is orthogonal to the SettingsView tests here. Mock it
// as an inert marker so the original tab tests keep their existing scope.
vi.mock('../BugReportDialog', () => ({
  BugReportDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="bug-report-dialog">Bug Report Dialog</div> : null,
}))

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

const ALL_THEME_CLASSES = [
  'dark',
  'theme-solarized-light',
  'theme-solarized-dark',
  'theme-dracula',
  'theme-one-dark-pro',
]

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('theme-preference')
  localStorage.removeItem('agaric-font-size')
  for (const cls of ALL_THEME_CLASSES) document.documentElement.classList.remove(cls)
  document.documentElement.style.removeProperty('--agaric-font-size')
})

describe('SettingsView', () => {
  it('renders with 8 tabs', () => {
    render(<SettingsView />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(8)
    expect(tabs[0]).toHaveTextContent(t('settings.tabGeneral'))
    expect(tabs[1]).toHaveTextContent(t('settings.tabProperties'))
    expect(tabs[2]).toHaveTextContent(t('settings.tabAppearance'))
    expect(tabs[3]).toHaveTextContent(t('settings.tabKeyboard'))
    expect(tabs[4]).toHaveTextContent(t('settings.tabData'))
    expect(tabs[5]).toHaveTextContent(t('settings.tabSync'))
    expect(tabs[6]).toHaveTextContent(t('settings.tabAgentAccess'))
    expect(tabs[7]).toHaveTextContent(t('settings.tabHelp'))
  })

  it('Help tab opens the bug-report dialog on click', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const helpTab = screen.getByRole('tab', { name: t('settings.tabHelp') })
    await user.click(helpTab)
    expect(helpTab).toHaveAttribute('aria-selected', 'true')

    // Dialog is not open by default.
    expect(screen.queryByTestId('bug-report-dialog')).not.toBeInTheDocument()

    const reportBtn = screen.getByRole('button', { name: t('help.reportBugButton') })
    await user.click(reportBtn)

    expect(screen.getByTestId('bug-report-dialog')).toBeInTheDocument()
  })

  it('General tab shows deadline warning section by default (UX-202: no TaskStatesSection)', () => {
    render(<SettingsView />)

    expect(screen.queryByTestId('task-states-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('deadline-warning-section')).toBeInTheDocument()
  })

  it('Properties tab shows property definitions', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const propertiesTab = screen.getByRole('tab', { name: t('settings.tabProperties') })
    await user.click(propertiesTab)

    expect(screen.getByTestId('property-definitions-list')).toBeInTheDocument()
  })

  it('Appearance tab shows theme toggle', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
    await user.click(appearanceTab)

    // Theme select should be present
    const themeSelect = screen.getByLabelText(t('settings.themeLabel'))
    expect(themeSelect).toBeInTheDocument()

    // Font size select should be present
    const fontSizeSelect = screen.getByLabelText(t('settings.fontSizeLabel'))
    expect(fontSizeSelect).toBeInTheDocument()
  })

  it('Sync tab shows device management', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const syncTab = screen.getByRole('tab', { name: t('settings.tabSync') })
    await user.click(syncTab)

    expect(screen.getByTestId('device-management')).toBeInTheDocument()
  })

  it('tab switching works', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Default: General tab is active
    const generalTab = screen.getByRole('tab', { name: t('settings.tabGeneral') })
    expect(generalTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('deadline-warning-section')).toBeInTheDocument()

    // Switch to Properties
    const propertiesTab = screen.getByRole('tab', { name: t('settings.tabProperties') })
    await user.click(propertiesTab)
    expect(propertiesTab).toHaveAttribute('aria-selected', 'true')
    expect(generalTab).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('property-definitions-list')).toBeInTheDocument()
    expect(screen.queryByTestId('deadline-warning-section')).not.toBeInTheDocument()

    // Switch to Appearance
    const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
    await user.click(appearanceTab)
    expect(appearanceTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('property-definitions-list')).not.toBeInTheDocument()

    // Switch to Sync
    const syncTab = screen.getByRole('tab', { name: t('settings.tabSync') })
    await user.click(syncTab)
    expect(syncTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('device-management')).toBeInTheDocument()
  })

  it('theme toggle changes localStorage and document class', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Navigate to Appearance tab
    const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
    await user.click(appearanceTab)

    const themeSelect = screen.getByLabelText(t('settings.themeLabel'))

    // Default should be system/auto
    expect(themeSelect).toHaveValue('system')

    // Change to dark
    await user.selectOptions(themeSelect, 'dark')

    await waitFor(() => {
      expect(localStorage.getItem('theme-preference')).toBe('dark')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // Change to light
    await user.selectOptions(themeSelect, 'light')

    await waitFor(() => {
      expect(localStorage.getItem('theme-preference')).toBe('light')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  // ── UX-203: VSCode-inspired themes ─────────────────────────────────

  describe('VSCode-inspired theme options (UX-203)', () => {
    async function openAppearance() {
      const user = userEvent.setup()
      render(<SettingsView />)
      const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
      await user.click(appearanceTab)
      return { user, themeSelect: screen.getByLabelText(t('settings.themeLabel')) }
    }

    it('renders all 7 theme options', async () => {
      const { themeSelect } = await openAppearance()
      const options = Array.from((themeSelect as HTMLSelectElement).options).map((o) => o.value)
      expect(options).toEqual([
        'light',
        'dark',
        'system',
        'solarized-light',
        'solarized-dark',
        'dracula',
        'one-dark-pro',
      ])
    })

    it('shows translated labels for each new theme', async () => {
      await openAppearance()
      expect(
        screen.getByRole('option', { name: t('settings.themeSolarizedLight') }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('option', { name: t('settings.themeSolarizedDark') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('option', { name: t('settings.themeDracula') })).toBeInTheDocument()
      expect(
        screen.getByRole('option', { name: t('settings.themeOneDarkPro') }),
      ).toBeInTheDocument()
    })

    it('selecting solarized-light persists and applies only the theme class', async () => {
      const { user, themeSelect } = await openAppearance()
      await user.selectOptions(themeSelect, 'solarized-light')

      await waitFor(() => {
        expect(localStorage.getItem('theme-preference')).toBe('solarized-light')
      })
      const cls = document.documentElement.classList
      expect(cls.contains('theme-solarized-light')).toBe(true)
      expect(cls.contains('dark')).toBe(false)
      expect(themeSelect).toHaveValue('solarized-light')
    })

    it('selecting solarized-dark persists and applies .dark + theme-solarized-dark', async () => {
      const { user, themeSelect } = await openAppearance()
      await user.selectOptions(themeSelect, 'solarized-dark')

      await waitFor(() => {
        expect(localStorage.getItem('theme-preference')).toBe('solarized-dark')
      })
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-solarized-dark')).toBe(true)
      expect(cls.contains('theme-solarized-light')).toBe(false)
      expect(themeSelect).toHaveValue('solarized-dark')
    })

    it('selecting dracula persists and applies .dark + theme-dracula', async () => {
      const { user, themeSelect } = await openAppearance()
      await user.selectOptions(themeSelect, 'dracula')

      await waitFor(() => {
        expect(localStorage.getItem('theme-preference')).toBe('dracula')
      })
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-dracula')).toBe(true)
      expect(themeSelect).toHaveValue('dracula')
    })

    it('selecting one-dark-pro persists and applies .dark + theme-one-dark-pro', async () => {
      const { user, themeSelect } = await openAppearance()
      await user.selectOptions(themeSelect, 'one-dark-pro')

      await waitFor(() => {
        expect(localStorage.getItem('theme-preference')).toBe('one-dark-pro')
      })
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-one-dark-pro')).toBe(true)
      expect(themeSelect).toHaveValue('one-dark-pro')
    })

    it('switching from one custom theme to another removes the previous theme class', async () => {
      const { user, themeSelect } = await openAppearance()
      await user.selectOptions(themeSelect, 'dracula')
      await waitFor(() => {
        expect(document.documentElement.classList.contains('theme-dracula')).toBe(true)
      })

      await user.selectOptions(themeSelect, 'solarized-light')
      await waitFor(() => {
        expect(localStorage.getItem('theme-preference')).toBe('solarized-light')
      })
      const cls = document.documentElement.classList
      expect(cls.contains('theme-dracula')).toBe(false)
      expect(cls.contains('dark')).toBe(false)
      expect(cls.contains('theme-solarized-light')).toBe(true)
    })

    it('initialises the select value from a persisted custom theme', async () => {
      localStorage.setItem('theme-preference', 'dracula')
      const user = userEvent.setup()
      render(<SettingsView />)
      const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
      await user.click(appearanceTab)

      const themeSelect = screen.getByLabelText(t('settings.themeLabel'))
      expect(themeSelect).toHaveValue('dracula')
      expect(document.documentElement.classList.contains('theme-dracula')).toBe(true)
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })

  it('font size selector updates localStorage and CSS variable', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Navigate to Appearance tab
    const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
    await user.click(appearanceTab)

    const fontSizeSelect = screen.getByLabelText(t('settings.fontSizeLabel'))

    // Default should be medium
    expect(fontSizeSelect).toHaveValue('medium')

    // Change to large
    await user.selectOptions(fontSizeSelect, 'large')

    expect(localStorage.getItem('agaric-font-size')).toBe('large')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('18px')

    // Change to small
    await user.selectOptions(fontSizeSelect, 'small')

    expect(localStorage.getItem('agaric-font-size')).toBe('small')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('14px')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SettingsView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('renders Keyboard tab', () => {
    render(<SettingsView />)

    const keyboardTab = screen.getByRole('tab', { name: t('settings.tabKeyboard') })
    expect(keyboardTab).toBeInTheDocument()
  })

  it('shows KeyboardSettingsTab when keyboard tab is clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const keyboardTab = screen.getByRole('tab', { name: t('settings.tabKeyboard') })
    await user.click(keyboardTab)

    expect(keyboardTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('keyboard-settings-tab')).toBeInTheDocument()
    expect(screen.getByText('Keyboard Settings Content')).toBeInTheDocument()
  })
})
