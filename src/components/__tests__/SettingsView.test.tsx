/**
 * Tests for SettingsView component (F-30).
 *
 * Validates:
 *  - Renders with 9 tabs
 *  - General tab shows deadline warning section (UX-202: TaskStatesSection removed)
 *  - Properties tab shows property definitions
 *  - Appearance tab shows theme toggle
 *  - Sync tab shows device management
 *  - Agent access tab (FEAT-4e)
 *  - Google Calendar tab (FEAT-5f, experimental)
 *  - Tab switching works
 *  - Theme toggle changes localStorage and document class
 *  - Font size selector updates localStorage and CSS variable
 *  - axe a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { SettingsView } from '../SettingsView'

// FEAT-13: mock @tauri-apps/plugin-autostart so the AutostartRow's
// dynamic import (via @/lib/tauri's wrappers) hits a controllable stub.
// Per-test `mockResolvedValueOnce` / `mockRejectedValueOnce` overrides
// drive the desktop-available / mobile-unavailable / IPC-error paths.
const mockEnable = vi.fn()
const mockDisable = vi.fn()
const mockIsEnabled = vi.fn()
vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: mockEnable,
  disable: mockDisable,
  isEnabled: mockIsEnabled,
}))

// FEAT-12: mock @tauri-apps/plugin-global-shortcut for the
// QuickCaptureRow tests. Per-test overrides drive the success / failure
// paths.
const mockShortcutRegister = vi.fn()
const mockShortcutUnregister = vi.fn()
const mockShortcutIsRegistered = vi.fn()
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: mockShortcutRegister,
  unregister: mockShortcutUnregister,
  isRegistered: mockShortcutIsRegistered,
}))

// FEAT-12: mock the useIsMobile hook so the desktop / mobile branches
// of the QuickCaptureRow are deterministic in jsdom.
const mockUseIsMobile = vi.fn(() => false)
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}))

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
  AgentAccessSettingsTab: () => <div data-testid="agent-access-settings-tab">Agent Access</div>,
}))

// FEAT-5f: GoogleCalendarSettingsTab is rendered inside the "Google
// Calendar" tab panel. Mock it as an inert marker so the SettingsView
// tests stay focused on tab routing and do not need to stub the
// `get_gcal_status` IPC + event listeners.
vi.mock('../GoogleCalendarSettingsTab', () => ({
  GoogleCalendarSettingsTab: () => (
    <div data-testid="google-calendar-settings-tab">Google Calendar</div>
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
  localStorage.removeItem('agaric-settings-active-tab')
  for (const cls of ALL_THEME_CLASSES) document.documentElement.classList.remove(cls)
  document.documentElement.style.removeProperty('--agaric-font-size')
  // UX-276: ensure URL state from a previous test doesn't leak in via the
  // `?settings=…` deep-link param (each test that needs a specific URL
  // sets it explicitly).
  window.history.replaceState(null, '', '/')
  // FEAT-13: default the autostart plugin to "unavailable" so tests
  // that don't care about the launch-on-login row don't have to mock
  // it explicitly. Tests that exercise the row override per-call with
  // `mockResolvedValueOnce(...)` / `mockRejectedValueOnce(...)`.
  mockEnable.mockReset()
  mockDisable.mockReset()
  mockIsEnabled.mockReset()
  mockIsEnabled.mockRejectedValue(new Error('autostart unavailable'))
  // FEAT-12: reset global-shortcut + isMobile mocks each test.
  mockShortcutRegister.mockReset()
  mockShortcutUnregister.mockReset()
  mockShortcutIsRegistered.mockReset()
  mockShortcutRegister.mockResolvedValue(undefined)
  mockShortcutUnregister.mockResolvedValue(undefined)
  mockUseIsMobile.mockReset()
  mockUseIsMobile.mockReturnValue(false)
  localStorage.removeItem('agaric:quickCaptureShortcut')
})

describe('SettingsView', () => {
  it('renders with 9 tabs', () => {
    render(<SettingsView />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(9)
    expect(tabs[0]).toHaveTextContent(t('settings.tabGeneral'))
    expect(tabs[1]).toHaveTextContent(t('settings.tabProperties'))
    expect(tabs[2]).toHaveTextContent(t('settings.tabAppearance'))
    expect(tabs[3]).toHaveTextContent(t('settings.tabKeyboard'))
    expect(tabs[4]).toHaveTextContent(t('settings.tabData'))
    expect(tabs[5]).toHaveTextContent(t('settings.tabSync'))
    expect(tabs[6]).toHaveTextContent(t('settings.tabAgentAccess'))
    expect(tabs[7]).toHaveTextContent(t('settings.tabGoogleCalendar'))
    expect(tabs[8]).toHaveTextContent(t('settings.tabHelp'))
  })

  it('Google Calendar tab renders the GoogleCalendarSettingsTab panel', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const gcalTab = screen.getByRole('tab', { name: t('settings.tabGoogleCalendar') })
    await user.click(gcalTab)
    expect(gcalTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('google-calendar-settings-tab')).toBeInTheDocument()
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

  // ── UX-9: week-start preference Select ─────────────────────────────
  describe('week-start preference (UX-9)', () => {
    beforeEach(() => {
      localStorage.removeItem('week-start-preference')
    })

    async function openAppearance() {
      const user = userEvent.setup()
      render(<SettingsView />)
      const appearanceTab = screen.getByRole('tab', { name: t('settings.tabAppearance') })
      await user.click(appearanceTab)
      return user
    }

    it('renders a week-start Select labelled and defaulting to Monday', async () => {
      await openAppearance()

      const select = screen.getByLabelText(t('settings.weekStartLabel'))
      expect(select).toBeInTheDocument()
      // Hook default is 1 (Monday). Coerced to '1' for the Select.
      expect(select).toHaveValue('1')
    })

    it('renders both Monday and Sunday options', async () => {
      await openAppearance()
      expect(
        screen.getByRole('option', { name: t('settings.weekStartMonday') }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('option', { name: t('settings.weekStartSunday') }),
      ).toBeInTheDocument()
    })

    it('changing the value writes "0" to localStorage when Sunday is picked', async () => {
      const user = await openAppearance()
      const select = screen.getByLabelText(t('settings.weekStartLabel'))

      await user.selectOptions(select, '0')

      await waitFor(() => {
        expect(localStorage.getItem('week-start-preference')).toBe('0')
      })
      // Hook re-reads via the synthetic storage event — the select
      // reflects the new value.
      expect(select).toHaveValue('0')
    })

    it('changing the value writes "1" to localStorage when Monday is picked', async () => {
      // Pre-seed Sunday so we can assert the round-trip back to Monday.
      localStorage.setItem('week-start-preference', '0')
      const user = await openAppearance()
      const select = screen.getByLabelText(t('settings.weekStartLabel'))
      expect(select).toHaveValue('0')

      await user.selectOptions(select, '1')

      await waitFor(() => {
        expect(localStorage.getItem('week-start-preference')).toBe('1')
      })
      expect(select).toHaveValue('1')
    })

    it('initialises the select value from a persisted Sunday preference', async () => {
      localStorage.setItem('week-start-preference', '0')
      await openAppearance()
      expect(screen.getByLabelText(t('settings.weekStartLabel'))).toHaveValue('0')
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

  // ── UX-276: active tab persistence ─────────────────────────────────

  describe('active tab persistence (UX-276)', () => {
    it('renders with the persisted active tab on first render', () => {
      localStorage.setItem('agaric-settings-active-tab', 'keyboard')
      render(<SettingsView />)

      const keyboardTab = screen.getByRole('tab', { name: t('settings.tabKeyboard') })
      expect(keyboardTab).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('keyboard-settings-tab')).toBeInTheDocument()

      const generalTab = screen.getByRole('tab', { name: t('settings.tabGeneral') })
      expect(generalTab).toHaveAttribute('aria-selected', 'false')
    })

    it('switching tab writes the new value to localStorage', async () => {
      const user = userEvent.setup()
      render(<SettingsView />)

      // Initial render persists the default tab.
      await waitFor(() => {
        expect(localStorage.getItem('agaric-settings-active-tab')).toBe('general')
      })

      const propertiesTab = screen.getByRole('tab', { name: t('settings.tabProperties') })
      await user.click(propertiesTab)

      await waitFor(() => {
        expect(localStorage.getItem('agaric-settings-active-tab')).toBe('properties')
      })

      const syncTab = screen.getByRole('tab', { name: t('settings.tabSync') })
      await user.click(syncTab)

      await waitFor(() => {
        expect(localStorage.getItem('agaric-settings-active-tab')).toBe('sync')
      })
    })

    it('falls back to general when the persisted value is not a known tab', () => {
      localStorage.setItem('agaric-settings-active-tab', 'not-a-real-tab')
      render(<SettingsView />)

      const generalTab = screen.getByRole('tab', { name: t('settings.tabGeneral') })
      expect(generalTab).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('deadline-warning-section')).toBeInTheDocument()
    })
  })

  // ── UX-276: URL deep-link support ─────────────────────────────────

  describe('URL deep-link support (UX-276)', () => {
    it('initialises the active tab from the ?settings= query param', async () => {
      window.history.replaceState(null, '', '/?settings=keyboard')
      render(<SettingsView />)

      const keyboardTab = screen.getByRole('tab', { name: t('settings.tabKeyboard') })
      expect(keyboardTab).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('keyboard-settings-tab')).toBeInTheDocument()
    })

    it('URL value takes precedence over localStorage', () => {
      localStorage.setItem('agaric-settings-active-tab', 'sync')
      window.history.replaceState(null, '', '/?settings=keyboard')
      render(<SettingsView />)

      const keyboardTab = screen.getByRole('tab', { name: t('settings.tabKeyboard') })
      expect(keyboardTab).toHaveAttribute('aria-selected', 'true')
    })

    it('falls back to localStorage when the URL value is invalid', () => {
      localStorage.setItem('agaric-settings-active-tab', 'sync')
      window.history.replaceState(null, '', '/?settings=not-a-real-tab')
      render(<SettingsView />)

      const syncTab = screen.getByRole('tab', { name: t('settings.tabSync') })
      expect(syncTab).toHaveAttribute('aria-selected', 'true')
    })

    it('falls back to general when both URL and localStorage are invalid', () => {
      localStorage.setItem('agaric-settings-active-tab', 'still-not-real')
      window.history.replaceState(null, '', '/?settings=garbage')
      render(<SettingsView />)

      const generalTab = screen.getByRole('tab', { name: t('settings.tabGeneral') })
      expect(generalTab).toHaveAttribute('aria-selected', 'true')
    })

    it('switching tabs writes the new value into the URL via replaceState', async () => {
      const user = userEvent.setup()
      const initialHistoryLength = window.history.length
      render(<SettingsView />)

      // Initial render mirrors the default tab into the URL.
      await waitFor(() => {
        expect(window.location.search).toBe('?settings=general')
      })

      const propertiesTab = screen.getByRole('tab', { name: t('settings.tabProperties') })
      await user.click(propertiesTab)

      await waitFor(() => {
        expect(window.location.search).toBe('?settings=properties')
      })

      const syncTab = screen.getByRole('tab', { name: t('settings.tabSync') })
      await user.click(syncTab)

      await waitFor(() => {
        expect(window.location.search).toBe('?settings=sync')
      })

      // History length should not grow — every tab click is a replaceState,
      // never a pushState. Otherwise the user has to mash Back N times to
      // escape Settings.
      expect(window.history.length).toBe(initialHistoryLength)
    })

    it('removes the ?settings= query param on unmount', () => {
      window.history.replaceState(null, '', '/?settings=keyboard&foo=bar')
      const { unmount } = render(<SettingsView />)

      // While mounted the param is still there.
      expect(new URLSearchParams(window.location.search).get('settings')).toBe('keyboard')

      unmount()

      const params = new URLSearchParams(window.location.search)
      expect(params.has('settings')).toBe(false)
      // Other params are preserved.
      expect(params.get('foo')).toBe('bar')
    })

    it('has no a11y violations when initialised from a URL deep link', async () => {
      window.history.replaceState(null, '', '/?settings=keyboard')
      const { container } = render(<SettingsView />)

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
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

  // ── FEAT-13: Launch-on-login toggle (General tab) ──────────────────

  describe('Launch-on-login toggle (FEAT-13)', () => {
    it('hides the toggle on mobile / browser-dev when the plugin rejects', async () => {
      // Default `beforeEach` already rejects `isEnabled()` with
      // "autostart unavailable", simulating Android / iOS where the
      // plugin is `#[cfg(desktop)]`-gated out of the build, or browser
      // dev with no `__TAURI_INTERNALS__`.
      render(<SettingsView />)

      // The General tab is the default — no click required.
      await waitFor(() => {
        expect(mockIsEnabled).toHaveBeenCalled()
      })
      // Toggle row must not render — the user can't talk to the plugin.
      expect(
        screen.queryByRole('switch', { name: t('settings.autostart.label') }),
      ).not.toBeInTheDocument()
      // The DeadlineWarningSection sibling stays visible — only the
      // autostart row is conditionally hidden.
      expect(screen.getByTestId('deadline-warning-section')).toBeInTheDocument()
    })

    it('renders the toggle on desktop and reads the initial state (disabled)', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(false)
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      expect(toggle).toBeInTheDocument()
      // Radix Switch surfaces state via aria-checked.
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      // The description copy lands alongside the label.
      expect(screen.getByText(t('settings.autostart.description'))).toBeInTheDocument()
    })

    it('renders the toggle on desktop and reads the initial state (enabled)', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(true)
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    it('calls enable() when the user flips the toggle on', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(false)
      mockEnable.mockResolvedValue(undefined)
      const user = userEvent.setup()
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      await user.click(toggle)

      await waitFor(() => {
        expect(mockEnable).toHaveBeenCalledOnce()
      })
      expect(mockDisable).not.toHaveBeenCalled()
      // Optimistic update — the toggle reflects the new state.
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    it('calls disable() when the user flips the toggle off', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(true)
      mockDisable.mockResolvedValue(undefined)
      const user = userEvent.setup()
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      await user.click(toggle)

      await waitFor(() => {
        expect(mockDisable).toHaveBeenCalledOnce()
      })
      expect(mockEnable).not.toHaveBeenCalled()
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('reverts the optimistic update and toasts the failure when enable() rejects', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(false)
      // MAINT-99 ipc-error-path-coverage: the new component test must
      // include at least one mockRejectedValue* path.
      mockEnable.mockRejectedValueOnce(new Error('IPC denied'))
      const user = userEvent.setup()
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      await user.click(toggle)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('settings.autostart.toggleFailed'))
      })
      // Toggle must revert to the previous state — never lie about
      // the underlying setting.
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('reverts and toasts the failure when disable() rejects', async () => {
      mockIsEnabled.mockReset()
      mockIsEnabled.mockResolvedValue(true)
      mockDisable.mockRejectedValueOnce(new Error('IPC denied'))
      const user = userEvent.setup()
      render(<SettingsView />)

      const toggle = await screen.findByRole('switch', {
        name: t('settings.autostart.label'),
      })
      await user.click(toggle)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('settings.autostart.toggleFailed'))
      })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })
  })

  // ── FEAT-12: Quick-capture shortcut row (General tab) ─────────────
  describe('Quick capture shortcut (FEAT-12)', () => {
    it('renders with the default chord on first paint and exposes an Edit button', () => {
      render(<SettingsView />)

      const row = screen.getByTestId('quick-capture-settings-row')
      expect(row).toBeInTheDocument()

      // Default chord on Linux jsdom (isMac() returns false): Ctrl+Alt+N
      const binding = screen.getByTestId('quick-capture-shortcut-binding')
      expect(binding).toHaveTextContent('Ctrl+Alt+N')
      expect(
        screen.getByRole('button', { name: t('settings.quickCapture.editButton') }),
      ).toBeInTheDocument()
    })

    it('reads the persisted chord from localStorage on mount', () => {
      localStorage.setItem('agaric:quickCaptureShortcut', 'Ctrl+Shift+J')
      render(<SettingsView />)

      expect(screen.getByTestId('quick-capture-shortcut-binding')).toHaveTextContent('Ctrl+Shift+J')
    })

    it('Edit button reveals the inline input + Save / Cancel buttons', async () => {
      const user = userEvent.setup()
      render(<SettingsView />)

      await user.click(screen.getByTestId('quick-capture-shortcut-edit'))

      expect(screen.getByTestId('quick-capture-shortcut-input')).toBeInTheDocument()
      expect(screen.getByTestId('quick-capture-shortcut-save')).toBeInTheDocument()
      expect(screen.getByTestId('quick-capture-shortcut-cancel')).toBeInTheDocument()
    })

    it('Cancel restores the previous binding without touching the plugin or storage', async () => {
      const user = userEvent.setup()
      render(<SettingsView />)

      await user.click(screen.getByTestId('quick-capture-shortcut-edit'))
      const input = screen.getByTestId('quick-capture-shortcut-input')
      await user.clear(input)
      await user.type(input, 'Ctrl+Shift+J')
      await user.click(screen.getByTestId('quick-capture-shortcut-cancel'))

      expect(mockShortcutRegister).not.toHaveBeenCalled()
      expect(mockShortcutUnregister).not.toHaveBeenCalled()
      expect(localStorage.getItem('agaric:quickCaptureShortcut')).toBe(null)
      // The view returns to read-only mode with the prior binding.
      expect(screen.getByTestId('quick-capture-shortcut-binding')).toHaveTextContent('Ctrl+Alt+N')
    })

    it('Save persists the new chord to localStorage after a probe register/unregister', async () => {
      const user = userEvent.setup()
      mockShortcutRegister.mockResolvedValueOnce(undefined)
      mockShortcutUnregister.mockResolvedValueOnce(undefined)

      render(<SettingsView />)

      await user.click(screen.getByTestId('quick-capture-shortcut-edit'))
      const input = screen.getByTestId('quick-capture-shortcut-input')
      await user.clear(input)
      await user.type(input, 'Ctrl+Shift+J')
      await user.click(screen.getByTestId('quick-capture-shortcut-save'))

      await waitFor(() => {
        expect(localStorage.getItem('agaric:quickCaptureShortcut')).toBe('Ctrl+Shift+J')
      })
      // The probe registers and then unregisters the new chord; App.tsx
      // is the one that re-binds it with the live handler via the
      // synthetic storage event.
      expect(mockShortcutRegister).toHaveBeenCalledWith('Ctrl+Shift+J', expect.any(Function))
      expect(mockShortcutUnregister).toHaveBeenCalledWith('Ctrl+Shift+J')
      expect(screen.getByTestId('quick-capture-shortcut-binding')).toHaveTextContent('Ctrl+Shift+J')
    })

    // MAINT-99: every component that calls IPC must have a mockRejectedValue path.
    it('shows a toast and does NOT persist the new chord when probe register() rejects', async () => {
      const user = userEvent.setup()
      mockShortcutUnregister.mockResolvedValue(undefined)
      // The probe register rejects; we should toast and leave
      // localStorage untouched. App.tsx still owns the previous
      // binding so the user is not left without a working chord.
      mockShortcutRegister.mockRejectedValueOnce(new Error('shortcut conflict'))

      render(<SettingsView />)
      await user.click(screen.getByTestId('quick-capture-shortcut-edit'))
      const input = screen.getByTestId('quick-capture-shortcut-input')
      await user.clear(input)
      await user.type(input, 'Ctrl+Shift+J')
      await user.click(screen.getByTestId('quick-capture-shortcut-save'))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('settings.quickCapture.saveFailed'))
      })
      // The localStorage write only happens on success, so the saved
      // chord must still be the default.
      expect(localStorage.getItem('agaric:quickCaptureShortcut')).toBe(null)
    })

    it('hides the entire row on mobile', () => {
      mockUseIsMobile.mockReturnValue(true)
      render(<SettingsView />)

      expect(screen.queryByTestId('quick-capture-settings-row')).not.toBeInTheDocument()
    })
  })
})
