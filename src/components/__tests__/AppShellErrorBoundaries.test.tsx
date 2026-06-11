/**
 * #735 — feature error boundaries around the App-shell chrome.
 *
 * TabBar, QuickAccessBar, the overlay surfaces (palette, find, search
 * sheet), the five shell dialogs, and the Toaster previously rendered
 * bare: a render throw in any of them bubbled past the shell to the
 * ROOT boundary (main.tsx) and replaced the entire tree with the crash
 * screen, losing all visual editor state. These tests prove that:
 *
 *   - a thrown shell-chrome child no longer blanks its siblings (the
 *     sidebar, header, and active view stay mounted), and
 *   - the boundary's Retry control recovers the crashed section in
 *     place.
 *
 * The throwing components are swapped in via controllable module mocks;
 * everything else uses the same boot scaffolding as App.test.tsx.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { App } from '../../App'
import { t } from '../../lib/i18n'
import { useBootStore } from '../../stores/boot'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'

// -- Controllable crash flags (hoisted so the mock factories can close
//    over them safely) ---------------------------------------------------------

const crash = vi.hoisted(() => ({ tabBar: false, toaster: false }))

vi.mock('@/components/layout/TabBar', () => ({
  TabBar: () => {
    if (crash.tabBar) throw new Error('TabBar exploded')
    return <div data-testid="tab-bar-ok" />
  },
}))

vi.mock('../ui/sonner', () => ({
  Toaster: () => {
    if (crash.toaster) throw new Error('Toaster exploded')
    return <div data-testid="toaster-ok" />
  },
}))

// Heavy / IPC-bound children that are irrelevant to the boundary
// behaviour under test (same set App.test.tsx inert-mocks).
vi.mock('../../hooks/useSyncTrigger', () => ({
  useSyncTrigger: () => ({ syncing: false, syncAll: vi.fn() }),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

const { mockedInvoke } = vi.hoisted(() => ({ mockedInvoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockedInvoke(...args),
}))

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  crash.tabBar = false
  crash.toaster = false

  useBootStore.setState({ state: 'ready', error: null })
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
    pendingSettingsTab: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    isReady: true,
  })

  localStorage.removeItem('theme-preference')
  document.documentElement.classList.remove('dark')
  localStorage.setItem('agaric-onboarding-done', 'true')

  mockedInvoke.mockImplementation(async (cmd: unknown) => {
    if (cmd === 'list_spaces')
      return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
    return emptyPage
  })
})

async function renderAppAndWaitForShell() {
  const utils = render(<App />)
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
  })
  return utils
}

/** Scope queries to the sidebar (the view header also says "Journal"). */
function getSidebar() {
  const sidebarEl = document.querySelector('[data-slot="sidebar"]')
  if (!sidebarEl) throw new Error('Sidebar not found')
  return within(sidebarEl as HTMLElement)
}

describe('App shell error boundaries (#735)', () => {
  it('renders the shell chrome normally when nothing throws', async () => {
    await renderAppAndWaitForShell()

    expect(screen.getByTestId('tab-bar-ok')).toBeInTheDocument()
    expect(screen.getByTestId('toaster-ok')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a crashed TabBar shows a section fallback while the sidebar and view survive', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    crash.tabBar = true

    await renderAppAndWaitForShell()

    // The boundary caught the throw and rendered its inline fallback…
    const alert = screen.getByRole('alert')
    expect(
      within(alert).getByText(t('error.sectionCrashed', { section: 'Tab bar' })),
    ).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: t('action.retry') })).toBeInTheDocument()

    // …and the SIBLING chrome is still alive: sidebar nav, header, the
    // main content scroller, and the Toaster all stay mounted.
    const sidebar = getSidebar()
    expect(sidebar.getByText(t('sidebar.journal'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.pages'))).toBeInTheDocument()
    expect(document.getElementById('main-content')).not.toBeNull()
    expect(screen.getByTestId('toaster-ok')).toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })

  it('Retry recovers the crashed TabBar in place', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    crash.tabBar = true

    await renderAppAndWaitForShell()
    expect(screen.queryByTestId('tab-bar-ok')).not.toBeInTheDocument()

    // The underlying fault goes away (e.g. transient bad state)…
    crash.tabBar = false
    await user.click(screen.getByRole('button', { name: t('action.retry') }))

    // …and the section comes back without a reload, siblings untouched.
    expect(screen.getByTestId('tab-bar-ok')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getSidebar().getByText(t('sidebar.journal'))).toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })

  it('a crashed Toaster no longer blanks the app', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    crash.toaster = true

    await renderAppAndWaitForShell()

    const alert = screen.getByRole('alert')
    expect(
      within(alert).getByText(t('error.sectionCrashed', { section: 'Notifications' })),
    ).toBeInTheDocument()

    // Shell siblings survive.
    expect(screen.getByTestId('tab-bar-ok')).toBeInTheDocument()
    expect(getSidebar().getByText(t('sidebar.journal'))).toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })

  it('crashed-section fallback has no a11y violations in the shell context', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    crash.tabBar = true

    const { container } = await renderAppAndWaitForShell()
    expect(screen.getByRole('alert')).toBeInTheDocument()

    const results = await axe(container)
    expect(results).toHaveNoViolations()

    consoleErrorSpy.mockRestore()
  })
})
