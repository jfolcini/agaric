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

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SettingsView } from '@/components/pages/SettingsView'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'

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
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}))

// Mock child components to isolate SettingsView logic

vi.mock('@/components/agenda/DeadlineWarningSection', () => ({
  DeadlineWarningSection: () => <div data-testid="deadline-warning-section">Deadline Warning</div>,
}))

vi.mock('@/components/properties/PropertyDefinitionsList', () => ({
  PropertyDefinitionsList: () => (
    <div data-testid="property-definitions-list">Property Definitions</div>
  ),
}))

vi.mock('@/components/peers/DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management">Device Management</div>,
}))

vi.mock('@/components/KeyboardSettingsTab', () => ({
  KeyboardSettingsTab: () => (
    <div data-testid="keyboard-settings-tab">Keyboard Settings Content</div>
  ),
}))

vi.mock('@/components/DataSettingsTab', () => ({
  DataSettingsTab: () => <div data-testid="data-settings-tab">Data Settings Content</div>,
}))

// FEAT-4e: AgentAccessSettingsTab is rendered inside the "Agent access"
// tab panel. Mock it as an inert marker so the SettingsView tests stay
// focused on tab routing / theme / font-size behaviour.
vi.mock('@/components/AgentAccessSettingsTab', () => ({
  AgentAccessSettingsTab: () => <div data-testid="agent-access-settings-tab">Agent Access</div>,
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
  // #734: clear the pending-tab handoff slot so a value left by a prior
  // test can't flip the active tab here.
  useNavigationStore.setState({ pendingSettingsTab: null })
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
  // ── UX-381: breadcrumb naming the active tab ──────────────────────
  describe('breadcrumb (UX-381)', () => {
    it('renders a <nav> landmark labelled with the Settings section name', () => {
      render(<SettingsView />)

      const breadcrumb = screen.getByRole('navigation', { name: t('sidebar.settings') })
      expect(breadcrumb).toBeInTheDocument()
      expect(breadcrumb.tagName).toBe('NAV')
    })

    it('shows the current active tab name in the breadcrumb', () => {
      render(<SettingsView />)

      const breadcrumb = screen.getByRole('navigation', { name: t('sidebar.settings') })
      // The breadcrumb shows both the section ("Settings") and the active
      // tab label ("General" by default).
      expect(breadcrumb).toHaveTextContent(t('sidebar.settings'))
      expect(breadcrumb).toHaveTextContent(t('settings.tabGeneral'))
    })

    it('updates the breadcrumb active tab name when the user switches tabs', async () => {
      const user = userEvent.setup()
      render(<SettingsView />)

      const breadcrumb = screen.getByRole('navigation', { name: t('sidebar.settings') })
      expect(breadcrumb).toHaveTextContent(t('settings.tabGeneral'))

      await user.click(screen.getByRole('tab', { name: t('settings.tabKeyboard') }))
      expect(breadcrumb).toHaveTextContent(t('settings.tabKeyboard'))
      // The previously-active tab name is no longer in the breadcrumb.
      expect(breadcrumb).not.toHaveTextContent(t('settings.tabGeneral'))

      await user.click(screen.getByRole('tab', { name: t('settings.tabSync') }))
      expect(breadcrumb).toHaveTextContent(t('settings.tabSync'))
      expect(breadcrumb).not.toHaveTextContent(t('settings.tabKeyboard'))
    })
  })

  it('renders with 10 tabs', () => {
    render(<SettingsView />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(10)
    // Every tab is still present and reachable, regardless of which group
    // it now lives in.
    const labels = tabs.map((tab) => tab.textContent)
    expect(labels).toEqual(
      expect.arrayContaining([
        t('settings.tabGeneral'),
        t('settings.tabProperties'),
        t('settings.tabAppearance'),
        t('settings.tabEditor'),
        t('settings.tabKeyboard'),
        t('settings.tabData'),
        t('settings.tabSync'),
        t('settings.tabAgentAccess'),
        t('settings.tabNotifications'),
        t('settings.tabHelp'),
      ]),
    )
  })

  // ── #1108: grouped tab navigation ─────────────────────────────────────
  describe('grouped tab rail (#1108)', () => {
    it('renders a single vertical tablist labelled with the Settings section', () => {
      render(<SettingsView />)

      const tablists = screen.getAllByRole('tablist')
      expect(tablists).toHaveLength(1)
      const rail = tablists[0]
      expect(rail).toHaveAccessibleName(t('sidebar.settings'))
      expect(rail).toHaveAttribute('aria-orientation', 'vertical')
    })

    it('renders the four section headers', () => {
      render(<SettingsView />)

      // Headers are role="presentation" (a real heading can't live inside a
      // WAI-ARIA tablist), so assert on the known header element ids — the
      // "Help" group label collides with the "Help" tab label, so a plain
      // text query would be ambiguous.
      expect(document.getElementById('settings-group-workspace')).toHaveTextContent(
        t('settings.groupWorkspace'),
      )
      expect(document.getElementById('settings-group-integrations')).toHaveTextContent(
        t('settings.groupIntegrations'),
      )
      expect(document.getElementById('settings-group-data')).toHaveTextContent(
        t('settings.groupData'),
      )
      expect(document.getElementById('settings-group-help')).toHaveTextContent(
        t('settings.groupHelp'),
      )
    })

    it('groups each tab under its labeled section', () => {
      render(<SettingsView />)

      // Each section is a presentation wrapper whose header span has a known
      // id; the tabs it owns resolve within that wrapper and point back at
      // the header via aria-describedby.
      const expectations: ReadonlyArray<readonly [string, string, readonly string[]]> = [
        [
          'settings-group-workspace',
          t('settings.groupWorkspace'),
          [
            t('settings.tabGeneral'),
            t('settings.tabAppearance'),
            t('settings.tabEditor'),
            t('settings.tabKeyboard'),
            t('settings.tabProperties'),
          ],
        ],
        [
          'settings-group-integrations',
          t('settings.groupIntegrations'),
          [t('settings.tabNotifications'), t('settings.tabAgentAccess')],
        ],
        [
          'settings-group-data',
          t('settings.groupData'),
          [t('settings.tabData'), t('settings.tabSync')],
        ],
        ['settings-group-help', t('settings.groupHelp'), [t('settings.tabHelp')]],
      ]

      for (const [headerId, headerText, tabNames] of expectations) {
        const header = document.getElementById(headerId)
        expect(header).not.toBeNull()
        expect(header).toHaveTextContent(headerText)
        // The presentation wrapper holds the header + this group's tabs.
        const wrapper = header?.parentElement as HTMLElement
        const tabsInGroup = within(wrapper)
          .getAllByRole('tab')
          .map((tab) => tab.textContent)
        expect(tabsInGroup).toEqual([...tabNames])
        // Each tab in the group references the header for screen readers.
        for (const tab of within(wrapper).getAllByRole('tab')) {
          expect(tab).toHaveAttribute('aria-describedby', headerId)
        }
      }
    })

    it('every tab is reachable and selectable from its group', async () => {
      const user = userEvent.setup()
      render(<SettingsView />)

      const allTabNames = [
        t('settings.tabGeneral'),
        t('settings.tabProperties'),
        t('settings.tabAppearance'),
        t('settings.tabEditor'),
        t('settings.tabKeyboard'),
        t('settings.tabData'),
        t('settings.tabSync'),
        t('settings.tabAgentAccess'),
        t('settings.tabNotifications'),
        t('settings.tabHelp'),
      ]

      for (const name of allTabNames) {
        const tab = screen.getByRole('tab', { name })
        await user.click(tab)
        expect(tab).toHaveAttribute('aria-selected', 'true')
      }
    })

    it('does not render the old horizontal-overflow scroll viewport', () => {
      render(<SettingsView />)
      // The wheel-scroll workaround lived on a ScrollArea viewport; the
      // grouped rail wraps instead, so no such viewport should exist.
      expect(document.querySelector('[data-radix-scroll-area-viewport]')).toBeNull()
    })
  })

  it('Notifications tab renders the NotificationsTab panel', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const notificationsTab = screen.getByRole('tab', { name: t('settings.tabNotifications') })
    await user.click(notificationsTab)
    expect(notificationsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('notifications-enabled-switch')).toBeInTheDocument()
  })

  it('Help tab dispatches BUG_REPORT_EVENT on click', async () => {
    const user = userEvent.setup()
    const listener = vi.fn()
    window.addEventListener('agaric:report-bug', listener)
    try {
      render(<SettingsView />)

      const helpTab = screen.getByRole('tab', { name: t('settings.tabHelp') })
      await user.click(helpTab)
      expect(helpTab).toHaveAttribute('aria-selected', 'true')

      expect(listener).not.toHaveBeenCalled()

      const reportBtn = screen.getByRole('button', { name: t('help.reportBugButton') })
      await user.click(reportBtn)

      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('agaric:report-bug', listener)
    }
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

    // UX-329 — week-start change must produce a user-visible toast that
    // names the chosen day, otherwise the only cue is calendar grids
    // silently re-laying out.
    it('shows a success toast naming the chosen day on change', async () => {
      const user = await openAppearance()
      const select = screen.getByLabelText(t('settings.weekStartLabel'))

      await user.selectOptions(select, '0')
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          t('settings.weekStartUpdated', { day: t('settings.weekStartSunday') }),
        )
      })

      await user.selectOptions(select, '1')
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          t('settings.weekStartUpdated', { day: t('settings.weekStartMonday') }),
        )
      })
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

  // ── #734: pending-tab handoff slot ───────────────────────────────────
  // `agaric://settings/<tab>` (and the NoPeersDialog CTA) write
  // `useNavigationStore.pendingSettingsTab` BEFORE flipping the view. The
  // panel subscribes while mounted, so the request lands even when
  // Settings is already open — the localStorage / `?settings=` mechanisms
  // only run in the useState initializer and need a remount.

  describe('pending settings tab (deep link while already open, #734)', () => {
    it('switches the active tab when the slot is written while mounted', async () => {
      render(<SettingsView />)
      expect(screen.getByTestId('settings-panel-general')).toBeInTheDocument()

      useNavigationStore.getState().setPendingSettingsTab('sync')

      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-sync')).toBeInTheDocument()
      })
      expect(screen.getByTestId('device-management')).toBeInTheDocument()
      // One-shot: consumed and cleared.
      expect(useNavigationStore.getState().pendingSettingsTab).toBeNull()
    })

    it('two deep links in quick succession both land — the LAST one wins', async () => {
      // The consume effect clears the slot only when it still holds the
      // value that effect run consumed, so a second request written while
      // the first is in flight is processed by its own effect run instead
      // of being swallowed by an unconditional null write.
      render(<SettingsView />)

      useNavigationStore.getState().setPendingSettingsTab('sync')
      useNavigationStore.getState().setPendingSettingsTab('keyboard')

      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-keyboard')).toBeInTheDocument()
      })
      expect(useNavigationStore.getState().pendingSettingsTab).toBeNull()
    })

    it('consumes a slot written BEFORE mount, outranking a stale URL param', async () => {
      // A lingering `?settings=general` param (the open view mirrors its
      // own tab into the URL) must not swallow the deep-link request.
      window.history.replaceState(null, '', '/?settings=general')
      useNavigationStore.getState().setPendingSettingsTab('keyboard')

      render(<SettingsView />)

      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-keyboard')).toBeInTheDocument()
      })
      expect(useNavigationStore.getState().pendingSettingsTab).toBeNull()
    })

    it('drops unknown tab names but still clears the slot', async () => {
      render(<SettingsView />)

      useNavigationStore.getState().setPendingSettingsTab('not-a-tab')

      await waitFor(() => {
        expect(useNavigationStore.getState().pendingSettingsTab).toBeNull()
      })
      // Still on the default tab — no crash, no bogus panel.
      expect(screen.getByTestId('settings-panel-general')).toBeInTheDocument()
    })

    it('mirrors the consumed tab into localStorage + URL like a user click', async () => {
      render(<SettingsView />)

      useNavigationStore.getState().setPendingSettingsTab('sync')

      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-sync')).toBeInTheDocument()
      })
      expect(localStorage.getItem('agaric-settings-active-tab')).toBe('sync')
      expect(new URLSearchParams(window.location.search).get('settings')).toBe('sync')
    })

    it('has no a11y violations after a pending-tab switch', async () => {
      const { container } = render(<SettingsView />)

      useNavigationStore.getState().setPendingSettingsTab('sync')
      await waitFor(() => {
        expect(screen.getByTestId('settings-panel-sync')).toBeInTheDocument()
      })

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

    it('hides the entire row on a mobile platform (#742: capability gate, not width)', () => {
      // #742: visibility follows isMobilePlatform() (the UA capability check
      // registerGlobalShortcut uses), NOT the viewport-width useIsMobile hook.
      const originalUA = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () =>
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      })
      try {
        render(<SettingsView />)
        expect(screen.queryByTestId('quick-capture-settings-row')).not.toBeInTheDocument()
      } finally {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => originalUA })
      }
    })
  })
})
