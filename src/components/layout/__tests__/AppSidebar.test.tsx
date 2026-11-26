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

import { seedBookmarks } from '@/__tests__/helpers/bookmarks'
import { AppSidebar, type AppSidebarProps } from '@/components/layout/AppSidebar'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { t } from '@/lib/i18n'
import { SETTINGS_NAV_ITEM, SIDEBAR_NAV_ITEMS } from '@/lib/nav-items'
import { useJournalStore } from '@/stores/journal'
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
  useJournalStore.getState().setMode('daily')

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
  // #6532 — Agenda, the journal's agenda mode, follows Journal. #7040 D2 —
  // Graph, Templates and Trash follow in the lower group.
  it('renders exactly New Page, the four daily views, Agenda and the lower group as rows, Sync and Settings as labelled footer rows (#5269, #7040 P11)', () => {
    renderSidebar()

    const rows = [...document.querySelectorAll('[data-sidebar="menu-button"]')]
      .filter((row) => !row.closest('[data-sidebar="footer"]'))
      .map((row) => row.textContent)
    expect(rows).toEqual([
      t('sidebar.newPage'),
      t('sidebar.journal'),
      t('journal.agendaTab'),
      t('sidebar.pages'),
      t('sidebar.search'),
      t('sidebar.tags'),
      t('sidebar.graph'),
      t('sidebar.templates'),
      t('sidebar.trash'),
    ])
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.id)).toEqual(['journal', 'pages', 'search', 'tags'])

    // The footer's rows are the nav rows' own kind, labelled; the sync row adds its state.
    const footer = document.querySelector('[data-sidebar="footer"]') as HTMLElement
    const footerRows = within(footer).getAllByRole('button')
    expect(footerRows.map((row) => row.getAttribute('data-sidebar'))).toEqual([
      'menu-button',
      'menu-button',
    ])
    expect(footerRows.map((row) => row.textContent)).toEqual([
      `${t('sidebar.sync')}${t('sync.noPeersTitle')}`,
      t(SETTINGS_NAV_ITEM.labelKey),
    ])
  })

  it('reaches Sync and Settings in the footer by keyboard, after the nav', async () => {
    const user = userEvent.setup()
    renderSidebar()

    const reached: string[] = []
    for (let i = 0; i < 30 && reached.length < 2; i++) {
      await user.tab()
      const focused = document.activeElement
      if (focused?.closest('[data-sidebar="footer"]')) {
        reached.push(focused.getAttribute('aria-label') ?? focused.textContent ?? '')
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

  describe('the lower group (#7040 D2)', () => {
    const LOWER_VIEWS = [
      ['sidebar.graph', 'graph'],
      ['sidebar.templates', 'templates'],
      ['sidebar.trash', 'trash'],
    ] as const

    /** The menu buttons of the sidebar group after the main nav, in order. */
    function lowerGroupRows(): string[] {
      const groups = document.querySelectorAll('[data-sidebar="group"]')
      const lower = groups[1] as HTMLElement
      return [...lower.querySelectorAll('[data-sidebar="menu-button"]')].map(
        (row) => row.textContent ?? '',
      )
    }

    function mockTrashCount(count: () => number) {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces')
          return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
        if (cmd === 'count_trash') return count()
        return emptyPage
      })
    }

    it('holds Graph, Templates and Trash in a group of their own, after the main nav', () => {
      renderSidebar()
      expect(lowerGroupRows()).toEqual([
        t('sidebar.graph'),
        t('sidebar.templates'),
        t('sidebar.trash'),
      ])
    })

    it.each(LOWER_VIEWS)('%s opens the %s view and marks it current', async (labelKey, view) => {
      const onSelectView = vi.fn()
      const user = userEvent.setup()
      const { rerender, props } = renderSidebar({ onSelectView })

      await user.click(screen.getByRole('button', { name: t(labelKey) }))
      expect(onSelectView).toHaveBeenCalledWith(view)

      rerender(
        <SidebarProvider>
          <AppSidebar {...props} currentView={view} />
        </SidebarProvider>,
      )
      expect(screen.getByRole('button', { name: t(labelKey) })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    it('Trash shows the trash count as a menu badge, and names it', async () => {
      mockTrashCount(() => 3)
      renderSidebar()
      const trash = await screen.findByRole('button', {
        name: t('sidebar.trashWithCount', { count: 3 }),
      })
      const badge = trash.parentElement?.querySelector('[data-sidebar="menu-badge"]')
      expect(badge).toHaveTextContent(/^3$/u)
    })

    it('Trash shows no badge when the trash is empty, or when count_trash fails', async () => {
      mockTrashCount(() => 0)
      const { unmount } = renderSidebar()
      await waitFor(() => {
        expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'count_trash')).toBe(true)
      })
      expect(screen.getByRole('button', { name: t('sidebar.trash') })).toBeInTheDocument()
      expect(document.querySelector('[data-sidebar="menu-badge"]')).toBeNull()
      unmount()

      mockTrashCount(() => {
        throw new Error('boom')
      })
      renderSidebar()
      await waitFor(() => {
        expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'count_trash')).toHaveLength(2)
      })
      expect(screen.getByRole('button', { name: t('sidebar.trash') })).toBeInTheDocument()
      expect(document.querySelector('[data-sidebar="menu-badge"]')).toBeNull()
    })

    // The sidebar stays mounted, so the count must not wait for its poll to
    // catch up after the user trashed or restored something elsewhere.
    it('recounts the trash when the view changes', async () => {
      let count = 1
      mockTrashCount(() => count)
      const { rerender, props } = renderSidebar({ currentView: 'trash' })
      expect(
        await screen.findByRole('button', { name: t('sidebar.trashWithCount', { count: 1 }) }),
      ).toBeInTheDocument()

      count = 2
      rerender(
        <SidebarProvider>
          <AppSidebar {...props} currentView="pages" />
        </SidebarProvider>,
      )
      expect(
        await screen.findByRole('button', { name: t('sidebar.trashWithCount', { count: 2 }) }),
      ).toBeInTheDocument()
    })

    it('has no a11y violations with the trash badge present', async () => {
      mockTrashCount(() => 3)
      const { container } = renderSidebar()
      await screen.findByRole('button', { name: t('sidebar.trashWithCount', { count: 3 }) })
      expect(await axe(container)).toHaveNoViolations()
    })
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

  // #6532
  it('opens the journal in agenda mode from Agenda, and marks Agenda, not Journal, current', async () => {
    const onSelectView = vi.fn()
    const user = userEvent.setup()
    const { rerender, props } = renderSidebar({ onSelectView, currentView: 'pages' })

    await user.click(screen.getByRole('button', { name: t('journal.agendaTab') }))

    expect(onSelectView).toHaveBeenCalledWith('journal')
    expect(useJournalStore.getState().mode).toBe('agenda')
    rerender(
      <SidebarProvider>
        <AppSidebar {...props} currentView="journal" />
      </SidebarProvider>,
    )
    const agenda = screen.getByRole('button', { name: t('journal.agendaTab') })
    const journal = screen.getByRole('button', { name: t('sidebar.journal') })
    expect(agenda).toHaveAttribute('aria-current', 'page')
    expect(journal).not.toHaveAttribute('aria-current')

    await user.click(journal)

    expect(useJournalStore.getState().mode).toBe('daily')
    expect(journal).toHaveAttribute('aria-current', 'page')
    expect(agenda).not.toHaveAttribute('aria-current')
  })

  it('keeps a dated journal mode when Journal is chosen', async () => {
    useJournalStore.getState().setMode('weekly')
    const user = userEvent.setup()
    renderSidebar({ currentView: 'pages' })

    await user.click(screen.getByRole('button', { name: t('sidebar.journal') }))

    expect(useJournalStore.getState().mode).toBe('weekly')
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

  // "offline" (network problem) and "no peers" (pairing problem) must read
  // apart, so users can tell whether to fix the network or pair a device. The
  // sync row says which in words (#7040 P11).
  it('names offline and no-peers apart in the sync row', () => {
    const { rerender, props } = renderSidebar({ isOnline: false })
    expect(screen.getByTestId('sync-state')).toHaveTextContent(t('sidebar.offline'))

    rerender(
      <SidebarProvider>
        <AppSidebar {...props} isOnline />
      </SidebarProvider>,
    )
    expect(screen.getByTestId('sync-state')).toHaveTextContent(t('sync.noPeersTitle'))
  })

  // #1076 — the sync state follows `syncPeers.length > 0`. Before the store was
  // wired to the backend, `syncPeers` was permanently `[]`, so the state was
  // stuck on no-peers even when devices were paired.
  it('reflects hasPeers in the sync row when paired vs unpaired (#1076)', () => {
    const peer: PeerInfo = { peerId: 'PEER1', lastSyncedAt: null, resetCount: 0, name: null }

    // Paired + idle → the last-synced line, not the no-peers word.
    seedSyncStore({ state: 'idle', peers: [peer] })
    const { rerender, props } = renderSidebar()
    expect(screen.getByTestId('sync-state')).toHaveTextContent(t('sidebar.lastSyncedNever'))

    seedSyncStore({ state: 'idle', peers: [] })
    rerender(
      <SidebarProvider>
        <AppSidebar {...props} />
      </SidebarProvider>,
    )
    expect(screen.getByTestId('sync-state')).toHaveTextContent(t('sync.noPeersTitle'))
  })

  // The "last synced" line lives in the sync
  // button's tooltip and, for screen readers, its description. A fresh install
  // has no paired device, and says so in both (#6528).
  it('includes the pairing and last synced status in the sync button tooltip and description', async () => {
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
    expect(syncButton).toHaveAccessibleDescription(
      `${t('sync.noPeersTitle')} ${t('sidebar.lastSyncedNever')}`,
    )

    await user.hover(syncButton)

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toContain(t('sync.noPeersTitle'))
      expect(tooltip.textContent).toContain(t('sidebar.lastSyncedNever'))
      // Dimmed on the inverted tooltip surface; opacity-80 drops below 4.5:1 in
      // solarized-dark and one-dark-pro.
      expect(within(tooltip).getByText(t('sidebar.lastSyncedNever'))).toHaveClass('opacity-90')
    })
  })

  describe('with a fake clock', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('ages the last synced line as time passes', () => {
      seedSyncStore({ lastSyncedAt: new Date().toISOString() })
      renderSidebar()

      const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
      expect(syncButton).toHaveAccessibleDescription(
        `${t('sync.noPeersTitle')} ${t('sidebar.lastSynced', { time: t('sidebar.justNow') })}`,
      )

      act(() => {
        vi.advanceTimersByTime(5 * 60_000)
      })
      expect(syncButton).toHaveAccessibleDescription(
        `${t('sync.noPeersTitle')} ${t('sidebar.lastSynced', { time: t('sidebar.minutesAgo', { count: 5 }) })}`,
      )
    })
  })

  it('keeps an offline Sync focusable, so its tooltip can say why it does nothing', async () => {
    const user = userEvent.setup()
    const { props } = renderSidebar({ isOnline: false })

    // Its name holds the words it shows (WCAG 2.5.3, label in name).
    const offline = screen.getByRole('button', {
      name: `${t('sidebar.sync')} ${t('sidebar.offline')}`,
    })
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
    seedBookmarks('SPACE_PERSONAL', new Map([['A', 1]]))
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

    // On a phone the switcher is a bottom-sheet menu, not a Select.
    await user.click(screen.getByRole('button', { name: t('space.switch') }))
    await user.click(await screen.findByRole('button', { name: t('space.manage') }))

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
    // The sync result shows in the sidebar's own Sync row.
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

// A sync error is toasted when it happens; afterwards the button itself must
// say so, in its glyph, its row, its tooltip and its description (#6528).
describe('a standing sync error is not colour-only (#6528)', () => {
  const peer: PeerInfo = { peerId: 'PEER1', lastSyncedAt: null, resetCount: 0, name: null }
  const failed = t('sync.failed', { message: 'Connection refused' })

  beforeEach(() => {
    useSyncStore.setState({ state: 'error', error: 'Connection refused', peers: [peer] })
  })

  it('names the failure in the sync row', () => {
    renderSidebar()

    expect(screen.getByTestId('sync-state')).toHaveTextContent(t('sidebar.syncStateFailed'))
  })

  it('names the stored error in the Sync button description and tooltip', async () => {
    const user = userEvent.setup()
    renderSidebar()

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton).toHaveAccessibleDescription(`${failed} ${t('sidebar.lastSyncedNever')}`)

    await user.hover(syncButton)
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain(failed)
    })
  })

  it('swaps the sync glyph for an alert, as offline swaps it for WifiOff', () => {
    renderSidebar()

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton.querySelector('.lucide-refresh-cw')).toBeNull()
    expect(syncButton.querySelector('.lucide-circle-alert')).toBeInTheDocument()
  })

  it('drops the error once a sync succeeds', () => {
    renderSidebar()
    act(() => {
      useSyncStore.getState().setState('idle')
    })

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton).toHaveAccessibleDescription(t('sidebar.lastSyncedNever'))
    expect(syncButton.querySelector('.lucide-refresh-cw')).toBeInTheDocument()
  })
})

// #6523 — a paired device that is away reads as waiting: the button names the
// device and its own last sync, in a neutral tone and glyph, never as an error.
describe('an away device reads as waiting, not as a failure (#6523)', () => {
  const lastSyncedAt = new Date(Date.now() - 5 * 60_000).toISOString()
  const peer: PeerInfo = { peerId: 'PEER1', lastSyncedAt, resetCount: 0, name: 'Pixel 8' }
  const waiting = t('sync.waitingForPeer', {
    peer: 'Pixel 8',
    time: t('sidebar.minutesAgo', { count: 5 }),
  })

  beforeEach(() => {
    useSyncStore.setState({ peers: [peer] })
    useSyncStore.getState().setWaiting('PEER1')
  })

  it('names the device and its last sync in the Sync button description and tooltip', async () => {
    const user = userEvent.setup()
    renderSidebar()

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton).toHaveAccessibleDescription(waiting)

    await user.hover(syncButton)
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toContain(waiting)
      expect(tooltip.textContent).not.toContain(t('sidebar.lastSyncedNever'))
    })
  })

  it('keeps the sync glyph and names the wait in the row, not as an error', () => {
    renderSidebar()

    const syncButton = screen.getByRole('button', { name: t('sidebar.sync') })
    expect(syncButton.querySelector('.lucide-refresh-cw')).toBeInTheDocument()
    expect(syncButton.querySelector('.lucide-circle-alert')).toBeNull()
    const state = screen.getByTestId('sync-state')
    expect(state).toHaveTextContent(waiting)
    expect(state).not.toHaveClass('text-destructive')
  })

  it('has no a11y violations', async () => {
    const { container } = renderSidebar()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
