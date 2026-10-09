/**
 * Smoke tests for AppSidebar.
 *
 * Pins the basic rendering contract of the new component extracted
 * From App.tsx. Full integration scenarios remain
 * covered by App.test.tsx; these tests cover the new prop API in
 * isolation.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { AppSidebar, type AppSidebarProps } from '@/components/layout/AppSidebar'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { t } from '@/lib/i18n'
import { SETTINGS_NAV_ITEM, SIDEBAR_NAV_ITEMS } from '@/lib/nav-items'
import { useNavigationStore } from '@/stores/navigation'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
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
    onNewPage: vi.fn(),
    onSyncClick: vi.fn(),
    ...overrides,
  }
}

/**
 * `syncState`, `syncPeers`, `lastSyncedAt`, `availableSpaces` and
 * `currentSpaceId` are read directly from the zustand stores inside the
 * sidebar rather than forwarded as props.
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
  localStorage.clear()
  // #4713 — the embedded BookmarksSection reads this store; reset it so a
  // prior test's pins don't leak into the next sidebar render.
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {}, rawKeysMerged: true })

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

  // #5269 — the sidebar is cut down to the daily surfaces. Pin the whole row
  // list, in order, so a row that creeps back (or goes missing) reddens this.
  it('renders exactly New Page and the four daily views as rows, Sync and Settings as one footer row of icons (#5269)', () => {
    renderSidebar()

    const rows = [...document.querySelectorAll('[data-sidebar="menu-button"]')].map(
      (row) => row.textContent,
    )
    expect(rows).toEqual([
      t('sidebar.newPage'),
      ...SIDEBAR_NAV_ITEMS.map((item) => t(item.labelKey)),
    ])
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.id)).toEqual(['journal', 'pages', 'search', 'tags'])

    const footer = document.querySelector('[data-sidebar="footer"]') as HTMLElement
    const icons = within(footer).getAllByRole('button')
    expect(icons.map((button) => button.getAttribute('aria-label'))).toEqual([
      t('sidebar.sync'),
      t(SETTINGS_NAV_ITEM.labelKey),
    ])
    expect(icons.map((button) => button.textContent)).toEqual(['', ''])
  })

  it('reaches Sync and Settings in the footer by keyboard, after the nav', async () => {
    const user = userEvent.setup()
    renderSidebar()

    const reached: string[] = []
    for (let i = 0; i < 30 && reached.length < 2; i++) {
      await user.tab()
      const focused = document.activeElement
      if (focused?.closest('[data-sidebar="footer"]')) {
        reached.push(focused.getAttribute('aria-label') ?? '')
      }
    }

    expect(reached).toEqual([t('sidebar.sync'), t(SETTINGS_NAV_ITEM.labelKey)])
  })

  it('opens Settings from the footer and marks it as the current view', async () => {
    const onSelectView = vi.fn()
    const user = userEvent.setup()
    const { rerender, props } = renderSidebar({ onSelectView })

    const settings = screen.getByRole('button', { name: t(SETTINGS_NAV_ITEM.labelKey) })
    expect(settings).not.toHaveAttribute('aria-current')
    await user.click(settings)
    expect(onSelectView).toHaveBeenCalledWith('settings')

    rerender(
      <SidebarProvider>
        <AppSidebar {...props} currentView="settings" />
      </SidebarProvider>,
    )
    expect(screen.getByRole('button', { name: t(SETTINGS_NAV_ITEM.labelKey) })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('puts New Page and the collapse toggle in the header, Sync and Settings in the footer (#5269)', () => {
    renderSidebar()

    const header = document.querySelector('[data-sidebar="header"]') as HTMLElement
    const footer = document.querySelector('[data-sidebar="footer"]') as HTMLElement
    expect(within(header).getByRole('button', { name: t('sidebar.newPage') })).toBeInTheDocument()
    expect(
      within(header).getByRole('button', { name: t('sidebar.collapseSidebar') }),
    ).toBeInTheDocument()
    expect(within(footer).getByRole('button', { name: t('sidebar.sync') })).toBeInTheDocument()
    expect(within(footer).getByRole('button', { name: t('sidebar.settings') })).toBeInTheDocument()
  })

  it('collapses to the rail and expands back from the header toggle (#5269)', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const sidebar = document.querySelector('[data-slot="sidebar"]') as HTMLElement
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    await user.click(screen.getByRole('button', { name: t('sidebar.collapseSidebar') }))

    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    await user.click(screen.getByRole('button', { name: t('sidebar.expandSidebar') }))
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
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
    expect(pagesButton).toHaveAttribute('data-active', 'true')
  })

  it('calls onNewPage / onSyncClick from the New Page and Sync rows', async () => {
    const onNewPage = vi.fn()
    const onSyncClick = vi.fn()
    const user = userEvent.setup()
    renderSidebar({ onNewPage, onSyncClick })

    await user.click(screen.getByText(t('sidebar.newPage')))
    await user.click(screen.getByRole('button', { name: t('sidebar.sync') }))

    expect(onNewPage).toHaveBeenCalledTimes(1)
    expect(onSyncClick).toHaveBeenCalledTimes(1)
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

  // The footer is icons only, so the "last synced" line lives in the sync
  // button's tooltip and, for screen readers, its description.
  it('includes the last synced status in the sync button tooltip and description', async () => {
    const user = userEvent.setup()
    // `lastSyncedAt` lives in the store now; the default
    // reset in `beforeEach` already leaves it as `null`, so no extra
    // seed call is required.
    render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps()} />
      </SidebarProvider>,
    )

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton).toHaveAccessibleDescription(t('sidebar.lastSyncedNever'))

    await user.hover(syncButton)

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toContain(t('sidebar.syncTooltip'))
      expect(tooltip.textContent).toContain(t('sidebar.lastSyncedNever'))
      // Dimmed on the inverted tooltip surface; opacity-80 drops below 4.5:1 in
      // solarized-dark and one-dark-pro.
      expect(within(tooltip).getByText(t('sidebar.lastSyncedNever'))).toHaveClass('opacity-90')
    })
  })

  it('keeps an offline Sync focusable, so its tooltip can say why it does nothing', async () => {
    const user = userEvent.setup()
    const { props } = renderSidebar({ isOnline: false })

    const offline = screen.getByRole('button', { name: t('sidebar.offline') })
    expect(offline).toHaveAttribute('aria-disabled', 'true')
    act(() => offline.focus())

    expect(offline).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent(t('sidebar.offline'))
    expect(tooltip).toHaveTextContent(t('sidebar.lastSyncedNever'))
    await user.click(offline)
    expect(props.onSyncClick).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    const { container } = renderSidebar()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations collapsed to the icon rail', async () => {
    const { container } = render(
      <SidebarProvider defaultOpen={false}>
        <AppSidebar {...defaultProps()} />
      </SidebarProvider>,
    )
    expect(screen.getByRole('button', { name: t('sidebar.expandSidebar') })).toBeInTheDocument()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #4713 — the Bookmarks section is mounted in the sidebar's content, below
  // the nav list. Its own behaviour is covered by BookmarksSection.test.tsx;
  // this pins the wiring, which nothing else would catch.
  it('mounts the Bookmarks section listing the bookmarked pages (#4713)', () => {
    localStorage.setItem('starred-pages', JSON.stringify(['A']))
    useResolveStore.getState().batchSet([{ id: 'A', title: 'Alpha', deleted: false }])

    renderSidebar()

    const bookmarks = screen.getByRole('list', { name: t('bookmarks.title') })
    expect(within(bookmarks).getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
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

  async function openMobileSheet(
    overrides: Partial<AppSidebarProps> = {},
    { desktopOpen = true }: { desktopOpen?: boolean } = {},
  ) {
    const props = defaultProps(overrides)
    const user = userEvent.setup()
    render(
      <SidebarProvider defaultOpen={desktopOpen}>
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

  it('closes the Sheet when Settings is chosen from the footer', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    await user.click(screen.getByRole('button', { name: t('sidebar.settings') }))

    expect(props.onSelectView).toHaveBeenCalledWith('settings')
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
  })

  it('closes the Sheet when the space switcher opens Settings › Spaces', async () => {
    mockMobileViewport()
    useNavigationStore.setState({ currentView: 'journal', pendingSettingsTab: null })
    const { user } = await openMobileSheet()

    await user.selectOptions(screen.getByRole('combobox', { name: /Switch space/ }), '__manage__')

    expect(useNavigationStore.getState().pendingSettingsTab).toBe('spaces')
    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
  })

  it('keeps the Sheet open for the in-place sync action', async () => {
    mockMobileViewport()
    const { user, props } = await openMobileSheet()

    await user.click(screen.getByRole('button', { name: t('sidebar.sync') }))

    expect(props.onSyncClick).toHaveBeenCalled()
    // The sync result shows in the sidebar's own status dot.
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull()
  })

  // The desktop rail state means nothing in the Sheet: the toggle closes it.
  it('names the header toggle "Collapse" in the Sheet, even when the desktop rail is collapsed', async () => {
    mockMobileViewport()
    const { user } = await openMobileSheet({}, { desktopOpen: false })

    await user.click(screen.getByRole('button', { name: t('sidebar.collapseSidebar') }))

    await waitFor(() => {
      expect(document.querySelector('[data-mobile="true"]')).toBeNull()
    })
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
