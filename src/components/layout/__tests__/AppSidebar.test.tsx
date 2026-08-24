/**
 * Smoke tests for AppSidebar.
 *
 * Pins the basic rendering contract of the new component extracted
 * From App.tsx. Full integration scenarios remain
 * covered by App.test.tsx; these tests cover the new prop API in
 * isolation.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { AppSidebar, type AppSidebarProps } from '@/components/layout/AppSidebar'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { t } from '@/lib/i18n'
import { NAV_GROUPS, NAV_ITEMS } from '@/lib/nav-items'
import { useSpaceStore } from '@/stores/space'
import { type PeerInfo, type SyncState, useSyncStore } from '@/stores/sync'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

function defaultProps(overrides: Partial<AppSidebarProps> = {}): AppSidebarProps {
  return {
    currentView: 'journal',
    onSelectView: vi.fn(),
    syncing: false,
    isOnline: true,
    isDark: false,
    currentTheme: 'auto',
    onToggleTheme: vi.fn(),
    onNewPage: vi.fn(),
    onSyncClick: vi.fn(),
    onShowShortcuts: vi.fn(),
    ...overrides,
  }
}

/**
 * `syncState`, `syncPeers`, `lastSyncedAt`, `availableSpaces`,
 * `currentSpaceId`, and the `trashCount` badge are read directly from
 * the zustand stores inside the sidebar rather than forwarded as props.
 * Tests now seed those stores instead of injecting prop overrides.
 */
function seedSyncStore({
  state = 'idle' as SyncState,
  peers = [] as PeerInfo[],
  lastSyncedAt = null as string | null,
}: {
  state?: SyncState
  peers?: PeerInfo[]
  lastSyncedAt?: string | null
} = {}) {
  useSyncStore.setState({
    state,
    peers,
    lastSyncedAt,
  })
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
  // Active space. AppSidebar now reads `availableSpaces` /
  // `currentSpaceId` directly from the space store rather than via
  // props, so the seed here doubles as the prop equivalent.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    isReady: true,
  })

  // Reset the sync store so each test starts from a
  // deterministic `idle` / no-peers / never-synced state. Individual
  // tests override via `seedSyncStore({…})`.
  useSyncStore.getState().reset()

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

  // #1741 — the nav is grouped into labeled sections (Workspace / System)
  // instead of one flat 11-item list, with Settings moved to the footer.
  // Pin that every group label renders as a wired-up group label and that
  // each group's menu is announced via aria-labelledby.
  it('renders labeled nav groups wired to their menus (#1741)', () => {
    renderSidebar()

    for (const group of NAV_GROUPS) {
      const labelEl = screen.getByText(t(group.labelKey))
      expect(labelEl).toHaveAttribute('data-sidebar', 'group-label')

      const labelId = labelEl.getAttribute('id')
      expect(labelId).toBeTruthy()

      // The group's menu must reference its label via aria-labelledby so
      // assistive tech announces the section.
      const menu = document.querySelector(`[aria-labelledby="${labelId}"]`)
      expect(menu).not.toBeNull()
    }
  })

  // #1741 — grouping must not drop any destination: every NAV_ITEMS entry
  // (the grouped Workspace/System items plus the footer Settings item) must
  // still render exactly once.
  it('keeps all nav items present after grouping (#1741)', () => {
    renderSidebar()

    for (const item of NAV_ITEMS) {
      expect(screen.getByText(t(item.labelKey))).toBeInTheDocument()
    }

    // Settings specifically lives in the footer now, not the main nav.
    const settingsButton = screen
      .getByText(t('sidebar.settings'))
      .closest('[data-sidebar="menu-button"]')
    expect(settingsButton?.closest('[data-sidebar="footer"]')).not.toBeNull()
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

  // "offline" (network problem) and "no peers" (pairing
  // problem) used to share `bg-muted-foreground`, so users couldn't
  // tell whether to fix the network or pair a device. Pin the
  // distinction here so the two states keep diverging tokens.
  it('uses distinct sync dot colors for offline vs no-peers states', () => {
    // Sync state lives in the store now; seed instead of
    // passing as props.
    seedSyncStore({ state: 'offline', peers: [] })
    const { rerender, props } = renderSidebar()
    const offlineClass = screen.getByTestId('sync-button-status-dot').className
    expect(offlineClass).toContain('bg-muted-foreground')

    seedSyncStore({ state: 'idle', peers: [] })
    rerender(
      <SidebarProvider>
        <AppSidebar {...props} />
      </SidebarProvider>,
    )
    const noPeersClass = screen.getByTestId('sync-button-status-dot').className
    expect(noPeersClass).toContain('bg-status-pending')
    expect(noPeersClass).not.toBe(offlineClass)
  })

  // #1076 — the sidebar status dot is computed via
  // `syncDotClass(syncState, syncPeers.length > 0)`. Before the store
  // was wired to the backend, `syncPeers` was permanently `[]`, so the
  // dot was stuck on the no-peers token even when devices were paired.
  // Pin that paired (peers present) vs. unpaired now diverge.
  it('reflects hasPeers in the sync dot when paired vs unpaired (#1076)', () => {
    const peer: PeerInfo = { peerId: 'PEER1', lastSyncedAt: null, resetCount: 0 }

    // Paired + idle → the "idle, has peers" token (NOT the no-peers one).
    seedSyncStore({ state: 'idle', peers: [peer] })
    const { rerender, props } = renderSidebar()
    const pairedClass = screen.getByTestId('sync-button-status-dot').className
    expect(pairedClass).toContain('bg-sync-idle')
    expect(pairedClass).not.toContain('bg-status-pending')

    // No peers + idle → the no-peers token.
    seedSyncStore({ state: 'idle', peers: [] })
    rerender(
      <SidebarProvider>
        <AppSidebar {...props} />
      </SidebarProvider>,
    )
    const unpairedClass = screen.getByTestId('sync-button-status-dot').className
    expect(unpairedClass).toContain('bg-status-pending')
    expect(unpairedClass).not.toContain('bg-sync-idle')
  })

  // The visible "last synced" timestamp is hidden in
  // icon-collapsed mode (`group-data-[collapsible=icon]:hidden`).
  // Pin that the same text is folded into the sync button tooltip
  // so the affordance survives the collapse.
  it('includes the last synced status in the sync button tooltip', async () => {
    const user = userEvent.setup()
    // `lastSyncedAt` lives in the store now; the default
    // reset in `beforeEach` already leaves it as `null`, so no extra
    // seed call is required.
    render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps()} />
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

  // The theme-toggle button cycles auto → dark → light, but the
  // generic "Toggle theme" tooltip gave no signal of the current state.
  // The tooltip must now show the resolved theme name so the next click's
  // outcome is predictable.
  it('shows the current theme name in the theme-toggle tooltip', async () => {
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

  // The shortcuts button must surface the current keyboard
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

  // #3882 — `sidebar.trashCount` interpolated {{count}} with no _one/_other
  // plural forms, so a 1-item trash badge showed "1 items in trash".
  // Hardcoded literal (not re-derived via t()) so a regression in the
  // catalog's plural forms reddens this.
  it('uses singular wording in the trash badge accessible name when trashCount is 1', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces')
        return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
      if (cmd === 'count_trash') return 1 as unknown as never
      return emptyPage
    })
    renderSidebar()
    await waitFor(() => {
      expect(screen.getByLabelText('1 item in trash')).toBeInTheDocument()
    })
  })

  it('uses plural wording in the trash badge accessible name when trashCount is more than 1', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces')
        return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
      if (cmd === 'count_trash') return 5 as unknown as never
      return emptyPage
    })
    renderSidebar()
    await waitFor(() => {
      expect(screen.getByLabelText('5 items in trash')).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Mobile drawer dismissal
// ---------------------------------------------------------------------------
//
// On mobile the sidebar is a Sheet that covers the content (there is no
// persistent rail any more), so acting on an item has to close it. Before the
// hamburger change the rail was the nav surface and the Sheet was incidental,
// so nothing dismissed it — docs/UI-MAP.md claimed "Sheet auto-closes on
// nav-item tap" while the code never did it.
describe('AppSidebar — mobile Sheet dismissal', () => {
  /**
   * Pin `useIsMobile()` to true: viewport under the 768px breakpoint AND
   * `matchMedia` reporting a match (the hook reads both).
   */
  function mockMobileViewport() {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true })
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)
  }

  afterEach(() => {
    // `mockMobileViewport` spies on `matchMedia`; without an explicit restore
    // the spy leaks into the desktop test below and it silently measures a
    // mobile render.
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    })
  })

  async function openMobileSheet(overrides: Partial<AppSidebarProps> = {}) {
    const props = defaultProps(overrides)
    const user = userEvent.setup()
    render(
      <SidebarProvider>
        <AppSidebar {...props} />
        <SidebarTrigger />
      </SidebarProvider>,
    )
    await user.click(document.querySelector('[data-sidebar="trigger"]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).not.toBeNull()
    })
    return { user, props }
  }

  it('closes the Sheet when a nav destination is chosen', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    await user.click(screen.getByRole('button', { name: t('sidebar.pages') }))

    expect(props.onSelectView).toHaveBeenCalledWith('pages')
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
  })

  it('closes the Sheet when "New Page" is chosen', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    await user.click(screen.getByRole('button', { name: t('sidebar.newPage') }))

    expect(props.onNewPage).toHaveBeenCalled()
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
  })

  it('closes the Sheet when "Shortcuts" opens its dialog', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    // Otherwise the shortcuts dialog stacks on top of the still-open drawer.
    await user.click(screen.getByRole('button', { name: t('sidebar.shortcuts') }))

    expect(props.onShowShortcuts).toHaveBeenCalled()
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
  })

  it('keeps the Sheet open for in-place toggles (theme)', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    await user.click(screen.getByTestId('theme-toggle'))

    expect(props.onToggleTheme).toHaveBeenCalled()
    // The theme change is visible in the sidebar itself; dismissing would
    // throw the user out of the drawer for a setting they may cycle again.
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull()
  })

  it('does not close on desktop, where the sidebar is pinned beside the content', async () => {
    const user = userEvent.setup()
    const props = defaultProps()
    render(
      <SidebarProvider>
        <AppSidebar {...props} />
      </SidebarProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('sidebar.pages') }))

    expect(props.onSelectView).toHaveBeenCalledWith('pages')
    // Desktop renders the pinned sidebar, not a Sheet — nothing to dismiss.
    expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).toBeInTheDocument()
  })
})
