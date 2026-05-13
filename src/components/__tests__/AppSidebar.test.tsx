/**
 * Smoke tests for AppSidebar.
 *
 * Pins the basic rendering contract of the new component extracted
 * from App.tsx (MAINT-124 step 2). Full integration scenarios remain
 * covered by App.test.tsx; these tests cover the new prop API in
 * isolation.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
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
    trashCount: 0,
    syncState: 'idle',
    syncPeers: [],
    syncing: false,
    isOnline: true,
    lastSyncedAt: null,
    isDark: false,
    currentTheme: 'auto',
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
  // SpaceSwitcher / SpaceAccentBadge render against a deterministic
  // active space.
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

  // UX-380 — "offline" (network problem) and "no peers" (pairing
  // problem) used to share `bg-muted-foreground`, so users couldn't
  // tell whether to fix the network or pair a device. Pin the
  // distinction here so the two states keep diverging tokens.
  it('uses distinct sync dot colors for offline vs no-peers states (UX-380)', () => {
    const { rerender, props } = renderSidebar({ syncState: 'offline', syncPeers: [] })
    const offlineClass = screen.getByTestId('sync-button-status-dot').className
    expect(offlineClass).toContain('bg-muted-foreground')

    rerender(
      <SidebarProvider>
        <AppSidebar {...props} syncState="idle" syncPeers={[]} />
      </SidebarProvider>,
    )
    const noPeersClass = screen.getByTestId('sync-button-status-dot').className
    expect(noPeersClass).toContain('bg-status-pending')
    expect(noPeersClass).not.toBe(offlineClass)
  })

  // UX-379 — the visible "last synced" timestamp is hidden in
  // icon-collapsed mode (`group-data-[collapsible=icon]:hidden`).
  // Pin that the same text is folded into the sync button tooltip
  // so the affordance survives the collapse.
  it('includes the last synced status in the sync button tooltip (UX-379)', async () => {
    const user = userEvent.setup()
    render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps({ lastSyncedAt: null })} />
      </SidebarProvider>,
    )

    const syncButton = screen
      .getByText(t('sidebar.sync'))
      .closest('[data-sidebar="menu-button"]') as HTMLElement
    expect(syncButton).not.toBeNull()

    await user.hover(syncButton)

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toContain(t('sidebar.syncTooltip'))
      expect(tooltip.textContent).toContain(t('sidebar.lastSyncedNever'))
    })
  })

  it('has no a11y violations', async () => {
    const { container } = renderSidebar()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-387 — the theme-toggle button cycles auto → dark → light, but the
  // generic "Toggle theme" tooltip gave no signal of the current state.
  // The tooltip must now show the resolved theme name so the next click's
  // outcome is predictable.
  it('shows the current theme name in the theme-toggle tooltip (UX-387)', async () => {
    const user = userEvent.setup()
    render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps({ currentTheme: 'dark', isDark: true })} />
      </SidebarProvider>,
    )

    const themeBtn = screen.getByTestId('theme-toggle')
    await user.hover(themeBtn)

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toContain(
        t('sidebar.toggleThemeWithCurrent', { current: t('sidebar.themeName.dark') }),
      )
      expect(tooltip.textContent).toContain(t('sidebar.themeName.dark'))
    })
  })

  // UX-396 — the shortcuts button must surface the current keyboard
  // binding in its tooltip so the affordance is discoverable without
  // first opening the cheatsheet. The default binding is `?`.
  it('shows the keyboard binding in the shortcuts button tooltip', async () => {
    const user = userEvent.setup()
    // Render with the sidebar collapsed so the SidebarMenuButton
    // tooltip is not `hidden` (it is suppressed in the expanded state).
    render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps()} />
      </SidebarProvider>,
    )

    const shortcutsButton = screen
      .getByText(t('sidebar.shortcuts'))
      .closest('[data-sidebar="menu-button"]') as HTMLElement
    expect(shortcutsButton).not.toBeNull()

    await user.hover(shortcutsButton)

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toMatch(/\?/)
      expect(tooltip.textContent).toContain(t('sidebar.shortcuts'))
    })
  })
})
