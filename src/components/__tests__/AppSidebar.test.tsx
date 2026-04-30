/**
 * Smoke tests for AppSidebar.
 *
 * Pins the basic rendering contract of the new component extracted
 * from App.tsx (MAINT-124 step 2). Full integration scenarios remain
 * covered by App.test.tsx; these tests cover the new prop API in
 * isolation.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { useSpaceStore } from '../../stores/space'
import { AppSidebar, type AppSidebarProps } from '../AppSidebar'
import { SidebarProvider } from '../ui/sidebar'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

function defaultProps(overrides: Partial<AppSidebarProps> = {}): AppSidebarProps {
  return {
    currentView: 'journal',
    onSelectView: vi.fn(),
    conflictCount: 0,
    trashCount: 0,
    syncState: 'idle',
    syncPeers: [],
    syncing: false,
    isOnline: true,
    lastSyncedAt: null,
    isDark: false,
    onToggleTheme: vi.fn(),
    onNewPage: vi.fn(),
    onSyncClick: vi.fn(),
    onShowShortcuts: vi.fn(),
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    currentSpaceId: 'SPACE_PERSONAL',
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<AppSidebarProps> = {}) {
  const props = defaultProps(overrides)
  const utils = render(
    <SidebarProvider>
      <AppSidebar {...props} />
    </SidebarProvider>,
  )
  return { ...utils, props }
}

beforeEach(() => {
  vi.clearAllMocks()

  // Seed the space store the same way App.test.tsx does so the embedded
  // SpaceSwitcher / SpaceStatusChip / SpaceAccentBadge render against a
  // deterministic active space.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    isReady: true,
  })

  // SpaceSwitcher fires `list_spaces` on mount; return the same single
  // seed entry. Other commands fall back to an empty page so any stray
  // IPC call from a child does not throw.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_spaces')
      return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
    return emptyPage
  })
})

describe('AppSidebar', () => {
  it('renders without crashing', () => {
    renderSidebar()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeInTheDocument()
  })

  it('shows the sidebar branding (space switcher trigger)', () => {
    renderSidebar()
    expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
  })

  it('calls onSelectView when a menu item is clicked', async () => {
    const onSelectView = vi.fn()
    const user = userEvent.setup()
    renderSidebar({ onSelectView })

    await user.click(screen.getByText(t('sidebar.pages')))

    expect(onSelectView).toHaveBeenCalledWith('pages')
  })

  it('reflects the current view via aria-current="page" on the active item', () => {
    renderSidebar({ currentView: 'pages' })

    const pagesButton = screen.getByText(t('sidebar.pages')).closest('[data-sidebar="menu-button"]')
    const journalButton = screen
      .getByText(t('sidebar.journal'))
      .closest('[data-sidebar="menu-button"]')

    expect(pagesButton).toHaveAttribute('aria-current', 'page')
    expect(journalButton).not.toHaveAttribute('aria-current', 'page')
  })

  it('renders the conflicts badge only when conflictCount > 0', () => {
    const { rerender, props } = renderSidebar({ conflictCount: 0 })
    expect(
      screen.queryByLabelText(t('sidebar.conflictCount', { count: 3 })),
    ).not.toBeInTheDocument()

    rerender(
      <SidebarProvider>
        <AppSidebar {...props} conflictCount={3} />
      </SidebarProvider>,
    )
    expect(screen.getByLabelText(t('sidebar.conflictCount', { count: 3 }))).toBeInTheDocument()
  })

  it('calls onNewPage / onSyncClick / onShowShortcuts from the footer actions', async () => {
    const onNewPage = vi.fn()
    const onSyncClick = vi.fn()
    const onShowShortcuts = vi.fn()
    const user = userEvent.setup()
    renderSidebar({ onNewPage, onSyncClick, onShowShortcuts })

    await user.click(screen.getByText(t('sidebar.newPage')))
    await user.click(screen.getByText(t('sidebar.sync')))
    await user.click(screen.getByText(t('sidebar.shortcuts')))

    expect(onNewPage).toHaveBeenCalledTimes(1)
    expect(onSyncClick).toHaveBeenCalledTimes(1)
    expect(onShowShortcuts).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = renderSidebar()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
