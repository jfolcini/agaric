/**
 * Tests for SettingsView component (F-30).
 *
 * Validates:
 *  - Renders with 4 tabs
 *  - General tab shows task states section
 *  - Properties tab shows property definitions
 *  - Appearance tab shows theme toggle
 *  - Sync tab shows device management
 *  - Tab switching works
 *  - Theme toggle changes localStorage and document class
 *  - Font size selector updates localStorage and CSS variable
 *  - axe a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { SettingsView } from '../SettingsView'

// Mock child components to isolate SettingsView logic
vi.mock('../TaskStatesSection', () => ({
  TaskStatesSection: () => <div data-testid="task-states-section">Task States</div>,
}))

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

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// Mock the Select component (same pattern as PropertiesView tests)
vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({ value, onValueChange, children }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: any) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: any) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: any) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        id: tp.id,
      },
      children,
    )
  }

  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('theme-preference')
  localStorage.removeItem('agaric-font-size')
  document.documentElement.classList.remove('dark')
  document.documentElement.style.removeProperty('--agaric-font-size')
})

describe('SettingsView', () => {
  it('renders with 4 tabs', () => {
    render(<SettingsView />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toHaveTextContent('General')
    expect(tabs[1]).toHaveTextContent('Properties')
    expect(tabs[2]).toHaveTextContent('Appearance')
    expect(tabs[3]).toHaveTextContent('Sync & Devices')
  })

  it('General tab shows task states section by default', () => {
    render(<SettingsView />)

    expect(screen.getByTestId('task-states-section')).toBeInTheDocument()
    expect(screen.getByTestId('deadline-warning-section')).toBeInTheDocument()
  })

  it('Properties tab shows property definitions', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const propertiesTab = screen.getByRole('tab', { name: 'Properties' })
    await user.click(propertiesTab)

    expect(screen.getByTestId('property-definitions-list')).toBeInTheDocument()
  })

  it('Appearance tab shows theme toggle', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    await user.click(appearanceTab)

    // Theme select should be present
    const themeSelect = screen.getByLabelText('Theme')
    expect(themeSelect).toBeInTheDocument()

    // Font size select should be present
    const fontSizeSelect = screen.getByLabelText('Font Size')
    expect(fontSizeSelect).toBeInTheDocument()
  })

  it('Sync tab shows device management', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const syncTab = screen.getByRole('tab', { name: 'Sync & Devices' })
    await user.click(syncTab)

    expect(screen.getByTestId('device-management')).toBeInTheDocument()
  })

  it('tab switching works', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Default: General tab is active
    const generalTab = screen.getByRole('tab', { name: 'General' })
    expect(generalTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('task-states-section')).toBeInTheDocument()

    // Switch to Properties
    const propertiesTab = screen.getByRole('tab', { name: 'Properties' })
    await user.click(propertiesTab)
    expect(propertiesTab).toHaveAttribute('aria-selected', 'true')
    expect(generalTab).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('property-definitions-list')).toBeInTheDocument()
    expect(screen.queryByTestId('task-states-section')).not.toBeInTheDocument()

    // Switch to Appearance
    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    await user.click(appearanceTab)
    expect(appearanceTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('property-definitions-list')).not.toBeInTheDocument()

    // Switch to Sync
    const syncTab = screen.getByRole('tab', { name: 'Sync & Devices' })
    await user.click(syncTab)
    expect(syncTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('device-management')).toBeInTheDocument()
  })

  it('theme toggle changes localStorage and document class', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Navigate to Appearance tab
    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    await user.click(appearanceTab)

    const themeSelect = screen.getByLabelText('Theme')

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

  it('font size selector updates localStorage and CSS variable', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    // Navigate to Appearance tab
    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    await user.click(appearanceTab)

    const fontSizeSelect = screen.getByLabelText('Font Size')

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
})
