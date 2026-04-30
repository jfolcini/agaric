/**
 * Tests for App component.
 *
 * Validates:
 *  - Renders with sidebar and default view (Journal)
 *  - Clicking nav items switches views
 *  - All 6 views render (Journal, Pages, Tags, Trash, Status, Conflicts)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import { useIsMobile } from '../../hooks/useIsMobile'
import { announce } from '../../lib/announcer'
import { t } from '../../lib/i18n'
import { logger } from '../../lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../../lib/overlay-events'
import { __resetPriorityLevelsForTests, getPriorityLevels } from '../../lib/priority-levels'
import { setWindowTitle } from '../../lib/tauri'
import { useBootStore } from '../../stores/boot'
import { useJournalStore } from '../../stores/journal'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { useRecentPagesStore } from '../../stores/recent-pages'
import { keyFor, useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useSyncStore } from '../../stores/sync'

// FEAT-3p10 — partial mock: replace `setWindowTitle` with a vitest spy
// so we can assert the App-level effect calls it with
// `"<SpaceName> · Agaric"`. Every other lib/tauri export passes
// through unchanged via `importActual`.
vi.mock('../../lib/tauri', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    setWindowTitle: vi.fn().mockResolvedValue(undefined),
  }
})

// FEAT-9: controllable mobile mock so we can flip the breakpoint per-test
// without fiddling with window.innerWidth + matchMedia polyfills.
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

// Mock DeviceManagement to prevent its own IPC calls from interfering
vi.mock('../DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management">Device ID: mock-device</div>,
}))

// Mock LinkedReferences to prevent list_backlinks_grouped IPC calls
vi.mock('../LinkedReferences', () => ({
  LinkedReferences: () => <div data-testid="linked-references" />,
}))

// Mock PagePropertyTable to prevent get_properties/list_property_defs IPC calls
vi.mock('../PagePropertyTable', () => ({
  PagePropertyTable: () => <div data-testid="page-property-table" />,
}))

// Mock useSyncTrigger to prevent automatic sync in tests. The `syncAll`
// spy is hoisted so individual tests can assert on it (BUG-2 — verifies
// the non-empty-peers branch still forwards to `syncAll()` after the
// no-peers guard short-circuits the empty branch).
const { mockSyncAll } = vi.hoisted(() => ({ mockSyncAll: vi.fn() }))
vi.mock('../../hooks/useSyncTrigger', () => ({
  useSyncTrigger: () => ({ syncing: false, syncAll: mockSyncAll }),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedUseIsMobile = vi.mocked(useIsMobile)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()

  // FEAT-9: desktop-by-default so the TabBar + RecentPagesStrip render the
  // same way they do in the app. Individual tests flip this via mockedUseIsMobile.
  mockedUseIsMobile.mockReturnValue(false)

  // Start with boot already completed so BootGate renders children immediately.
  // This avoids the async boot cycle on every test — boot logic is tested in boot.test.ts.
  useBootStore.setState({ state: 'ready', error: null })

  // Reset the navigation store so each test starts at the default view.
  // FEAT-3 Phase 3 — also clear the per-space slices so tabs from a
  // previous test don't leak into the current test's active space via
  // the per-space selector fall-back.
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
    selectedBlockId: null,
  })

  // FEAT-9: reset the recent-pages MRU so RecentPagesStrip tests are isolated.
  // FEAT-3 Phase 3 — clear the per-space MRU slices for the same reason.
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })

  // FEAT-3 Phase 1: reset the space store so SpaceSwitcher renders
  // deterministic state regardless of test ordering.
  //
  // FEAT-3 Phase 2 — seed a "Personal" space so the new-page flow (which
  // now routes through `createPageInSpace` and refuses to fire when
  // `currentSpaceId == null`) has a valid space to attach to. Tests
  // that need to exercise the unhydrated branch can override this
  // locally in their own `beforeEach`.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    isReady: true,
  })

  // FEAT-3 Phase 2 — reset the resolve store so the `pagesList` /
  // `cache` state doesn't leak between tests (and so the
  // space-switch clear-cache test can observe a deterministic
  // starting state).
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })

  // Reset the sync store so lastSyncedAt is null.
  useSyncStore.getState().reset()

  // Reset theme state.
  localStorage.removeItem('theme-preference')
  document.documentElement.classList.remove('dark')

  // Dismiss onboarding modal so it doesn't block interactions.
  localStorage.setItem('agaric-onboarding-done', 'true')

  // Reset UX-201b priority levels cache between tests.
  __resetPriorityLevelsForTests()

  // Default mock: all invoke calls return an empty page response.
  // This covers: boot store's list_blocks, JournalPage, PageBrowser, TagList, TrashView.
  //
  // FEAT-3 Phase 1 — `list_spaces` returns a flat `SpaceRow[]` rather
  // than the paginated `{items,next_cursor,has_more}` shape, so dispatch
  // by command name. Every other command keeps the empty-page default.
  //
  // FEAT-3 Phase 2 — return the same seeded "Personal" space so the
  // boot-time `refreshAvailableSpaces()` call reconciles against a
  // non-empty list and leaves `currentSpaceId` intact.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_spaces')
      return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }]
    return emptyPage
  })
})

/** Helper to find the sidebar element and scope queries within it. */
function getSidebar() {
  const sidebarEl = document.querySelector('[data-slot="sidebar"]')
  if (!sidebarEl) throw new Error('Sidebar not found')
  return within(sidebarEl as HTMLElement)
}

describe('App', () => {
  it('renders with sidebar navigation items', async () => {
    render(<App />)

    // Wait for boot to complete and UI to render
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Sidebar should have all 6 nav items
    const sidebar = getSidebar()
    expect(sidebar.getByText(t('sidebar.journal'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.pages'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.tags'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.trash'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.status'))).toBeInTheDocument()
    expect(sidebar.getByText(t('sidebar.conflicts'))).toBeInTheDocument()
  })

  it('renders the app branding', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })
  })

  it('defaults to Journal view', async () => {
    render(<App />)

    // JournalPage renders tri-mode view with Day/Week/Month tabs and Add block
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
    })
    expect(screen.getAllByRole('button', { name: /add.*block/i }).length).toBeGreaterThanOrEqual(1)
  })

  // UX-238: view-transition-wrapper must be a flex column with height
  // propagation so the height chain (SidebarInset → ScrollArea viewport →
  // wrapper → GraphView) resolves correctly. jsdom can't verify the
  // computed height, so this is a class-list regression guard matching
  // the pattern used in UX-237's PageBrowser tests.
  it('view-transition-wrapper is a flex column with height propagation (UX-238)', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    const wrapper = screen.getByTestId('view-transition-wrapper')
    expect(wrapper).toHaveClass('flex')
    expect(wrapper).toHaveClass('flex-1')
    expect(wrapper).toHaveClass('min-h-0')
    expect(wrapper).toHaveClass('flex-col')
  })

  it('switches to Pages view', async () => {
    const user = userEvent.setup()
    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Click Pages in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText(t('sidebar.pages')))

    // PageBrowser should render with its new-page input
    await waitFor(() => {
      expect(screen.getByPlaceholderText(t('pageBrowser.newPagePlaceholder'))).toBeInTheDocument()
    })
  })

  it('switches to Tags view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Click Tags in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText(t('sidebar.tags')))

    // TagList should render
    await waitFor(() => {
      expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: t('tag.addTag') })).toBeInTheDocument()
  })

  it('switches to Trash view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Click Trash in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText(t('sidebar.trash')))

    // TrashView should render its empty state
    await waitFor(() => {
      expect(screen.getByText(t('trash.emptyMessage'))).toBeInTheDocument()
    })
  })

  it('switches to Status view', async () => {
    const user = userEvent.setup()

    // Use mockImplementation to return appropriate data based on command
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_status') {
        return {
          foreground_queue_depth: 0,
          background_queue_depth: 0,
          total_ops_dispatched: 0,
          total_background_dispatched: 0,
        }
      }
      return emptyPage
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Click Status in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText(t('sidebar.status')))

    // StatusPanel should render
    await waitFor(() => {
      expect(screen.getByText(t('status.materializerStatusTitle'))).toBeInTheDocument()
    })
  })

  it('switches to Conflicts view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Click Conflicts in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText(t('sidebar.conflicts')))

    // ConflictList should render its empty state
    await waitFor(() => {
      expect(screen.getByText(t('conflict.noConflicts'))).toBeInTheDocument()
    })
  })

  it('switches back to Journal from another view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    const sidebar = getSidebar()

    // Go to Pages
    await user.click(sidebar.getByText(t('sidebar.pages')))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(t('pageBrowser.newPagePlaceholder'))).toBeInTheDocument()
    })

    // Go back to Journal
    await user.click(sidebar.getByText(t('sidebar.journal')))

    // Journal should render again with tri-mode tabs
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<App />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('active sidebar item has data-active=true attribute', async () => {
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })
    const sidebar = getSidebar()
    const journalBtn = sidebar
      .getByText(t('sidebar.journal'))
      .closest('[data-sidebar="menu-button"]')
    expect(journalBtn).toHaveAttribute('data-active', 'true')
    const pagesBtn = sidebar.getByText(t('sidebar.pages')).closest('[data-sidebar="menu-button"]')
    expect(pagesBtn).toHaveAttribute('data-active', 'false')
    await user.click(sidebar.getByText(t('sidebar.pages')))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(t('pageBrowser.newPagePlaceholder'))).toBeInTheDocument()
    })
    const journalBtnAfter = sidebar
      .getByText(t('sidebar.journal'))
      .closest('[data-sidebar="menu-button"]')
    const pagesBtnAfter = sidebar
      .getByText(t('sidebar.pages'))
      .closest('[data-sidebar="menu-button"]')
    expect(pagesBtnAfter).toHaveAttribute('data-active', 'true')
    expect(journalBtnAfter).toHaveAttribute('data-active', 'false')
  })

  it('shows empty header label for page-editor view (title is in PageEditor)', async () => {
    // Navigate to page-editor via the navigation store
    useNavigationStore.setState({
      currentView: 'page-editor',
      tabs: [
        {
          id: '0',
          pageStack: [{ pageId: 'PAGE_1', title: 'My Test Page' }],
          label: 'My Test Page',
        },
      ],
      activeTabIndex: 0,
      selectedBlockId: null,
    })

    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // The header should NOT show the page title (it's shown in PageEditor itself)
    const headerLabel = screen.getByTestId('header-label')
    expect(headerLabel.textContent).toBe('')
  })

  it('Ctrl+F switches to search view', async () => {
    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Fire Ctrl+F on window
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    // Should switch to search view
    await waitFor(() => {
      expect(useNavigationStore.getState().currentView).toBe('search')
    })
  })

  it('Ctrl+N creates a new page and navigates to it', async () => {
    // Mock create_page_in_space to return the new page's ULID (FEAT-3 Phase 2).
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces')
        return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
      if (cmd === 'create_page_in_space') {
        return 'NEW_PAGE_ID_00000000000000'
      }
      return emptyPage
    })

    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    // Fire Ctrl+N on window
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    // Should call the atomic `create_page_in_space` command and then
    // navigate to the new page.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_page_in_space',
        expect.objectContaining({ content: 'Untitled', parentId: null }),
      )
    })

    await waitFor(() => {
      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(state)).toContainEqual(
        expect.objectContaining({ pageId: 'NEW_PAGE_ID_00000000000000', title: 'Untitled' }),
      )
    })
  })

  it('Ctrl+F announces "Search opened"', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('announce.searchOpened'))
    })
  })

  it('Alt+C switches to conflicts view (UX-216)', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'c', altKey: true })

    await waitFor(() => {
      expect(useNavigationStore.getState().currentView).toBe('conflicts')
    })
  })

  it('Alt+C announces "Conflicts view opened" (UX-216)', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'c', altKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('announce.conflictsOpened'))
    })
  })

  it('Alt+C does not fire when focus is in an input field (UX-216)', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    useNavigationStore.setState({ currentView: 'journal' })

    // Create an input and simulate Alt+C from it
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      fireEvent.keyDown(input, { key: 'c', altKey: true })
      // Allow any event loop to settle
      await Promise.resolve()
      expect(useNavigationStore.getState().currentView).toBe('journal')
    } finally {
      document.body.removeChild(input)
    }
  })

  it('plain "c" does NOT switch to conflicts view (UX-216)', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    useNavigationStore.setState({ currentView: 'journal' })

    fireEvent.keyDown(window, { key: 'c' })

    // Must stay on journal
    expect(useNavigationStore.getState().currentView).toBe('journal')
  })

  it('Ctrl+N announces "New page created"', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces')
        return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
      if (cmd === 'create_page_in_space') {
        return 'NEW_PAGE_ID_00000000000000'
      }
      return emptyPage
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('announce.newPageCreated'))
    })
  })

  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ─────────────────

  describe('journal navigation shortcuts', () => {
    it('Alt+ArrowLeft navigates to previous day in daily mode', async () => {
      const startDate = new Date(2025, 5, 15) // Jun 15, 2025
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subDays(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToPrevious'))
    })

    it('Alt+ArrowRight navigates to next day in daily mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addDays(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToNext'))
    })

    it('Alt+ArrowLeft navigates to previous week in weekly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'weekly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subWeeks(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToPrevious'))
    })

    it('Alt+ArrowRight navigates to next week in weekly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'weekly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addWeeks(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToNext'))
    })

    it('Alt+ArrowLeft navigates to previous month in monthly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'monthly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subMonths(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToPrevious'))
    })

    it('Alt+ArrowRight navigates to next month in monthly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'monthly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addMonths(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith(t('announce.navigatedToNext'))
    })

    it('Alt+T jumps to today', async () => {
      const pastDate = new Date(2024, 0, 1)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const beforePress = new Date()
      fireEvent.keyDown(document, { key: 't', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        // The date should be "today" — within a few seconds of now
        const diff = Math.abs(state.currentDate.getTime() - beforePress.getTime())
        expect(diff).toBeLessThan(5000)
      })
      expect(announce).toHaveBeenCalledWith(t('announce.jumpedToToday'))
    })

    it('Alt+T (uppercase) also jumps to today', async () => {
      const pastDate = new Date(2024, 0, 1)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'T', altKey: true })

      await waitFor(() => {
        expect(announce).toHaveBeenCalledWith(t('announce.jumpedToToday'))
      })
    })

    it('Alt+Arrow does nothing when not on journal view', async () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      // Date should not change
      expect(useJournalStore.getState().currentDate.getTime()).toBe(startDate.getTime())
      expect(announce).not.toHaveBeenCalled()
    })

    // MAINT-105: holding Alt+Arrow generates repeat=true keydown events
    // every ~30ms — without the e.repeat guard each one would shift
    // setCurrentDate and emit a SR announcement. Verify the guard skips
    // them.
    it('ignores auto-repeat keydown events (e.repeat=true)', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true, repeat: true })
      // Allow any microtasks to flush.
      await Promise.resolve()

      expect(useJournalStore.getState().currentDate.getTime()).toBe(startDate.getTime())
      expect(announce).not.toHaveBeenCalled()
    })
  })

  // ── BUG-18: shortcut rebinding (keyboard-config integration) ──────

  describe('shortcut rebinding (BUG-18)', () => {
    // localStorage is cleared here because `useUndoShortcuts` and other
    // stores share state; the outer beforeEach clears mocks but not this
    // key specifically.
    beforeEach(() => {
      localStorage.removeItem('agaric-keyboard-shortcuts')
    })

    afterEach(() => {
      localStorage.removeItem('agaric-keyboard-shortcuts')
    })

    it('rebinding focusSearch: new keys fire, old Ctrl+F does not', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ focusSearch: 'Ctrl + Shift + Q' }),
      )
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Old Ctrl+F does NOT fire
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      await Promise.resolve()
      expect(useNavigationStore.getState().currentView).toBe('journal')

      // New Ctrl+Shift+Q fires
      fireEvent.keyDown(window, { key: 'q', ctrlKey: true, shiftKey: true })
      await waitFor(() => {
        expect(useNavigationStore.getState().currentView).toBe('search')
      })
    })

    it('rebinding createNewPage: new keys fire, old Ctrl+N does not', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ createNewPage: 'Ctrl + Alt + M' }),
      )
      // FEAT-3 Phase 2 — the atomic create_page_in_space command is
      // now used instead of create_block for top-level pages. The IPC
      // returns the new page's ULID (a string), not a BlockRow.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces')
          return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
        if (cmd === 'create_page_in_space') {
          return 'NEW_PAGE_1'
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Old Ctrl+N does NOT fire the page-creation IPC
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      await Promise.resolve()
      expect(mockedInvoke).not.toHaveBeenCalledWith(
        'create_page_in_space',
        expect.objectContaining({ content: 'Untitled' }),
      )

      // New Ctrl+Alt+M fires
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true, altKey: true })
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_page_in_space',
          expect.objectContaining({ content: 'Untitled' }),
        )
      })
    })

    it('rebinding goToToday: new keys fire, old Alt+T does not', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ goToToday: 'Ctrl + Home' }),
      )
      const pastDate = new Date(2024, 0, 1)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Old Alt+T does NOT fire
      fireEvent.keyDown(document, { key: 't', altKey: true })
      await Promise.resolve()
      expect(useJournalStore.getState().currentDate.getTime()).toBe(pastDate.getTime())

      // New Ctrl+Home fires
      const beforePress = new Date()
      fireEvent.keyDown(document, { key: 'Home', ctrlKey: true })
      await waitFor(() => {
        const state = useJournalStore.getState()
        const diff = Math.abs(state.currentDate.getTime() - beforePress.getTime())
        expect(diff).toBeLessThan(5000)
      })
    })

    it('rebinding prevDayWeekMonth: new keys fire, old Alt+← does not', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ prevDayWeekMonth: 'Ctrl + PageUp' }),
      )
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Old Alt+← does NOT fire
      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })
      await Promise.resolve()
      expect(useJournalStore.getState().currentDate.getTime()).toBe(startDate.getTime())

      // New Ctrl+PageUp fires
      fireEvent.keyDown(document, { key: 'PageUp', ctrlKey: true })
      await waitFor(() => {
        expect(useJournalStore.getState().currentDate.getTime()).toBe(
          subDays(startDate, 1).getTime(),
        )
      })
    })

    it('default bindings still fire when no custom overrides are set', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Ctrl+F switches to search
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      await waitFor(() => {
        expect(useNavigationStore.getState().currentView).toBe('search')
      })
    })
  })

  // ── Conflict badge indicator ────────────────────────────────────────────

  describe('conflict badge indicator', () => {
    it('shows conflict badge with count when getConflicts returns items', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_conflicts') {
          return {
            items: [
              {
                id: 'CONFLICT_1',
                block_type: 'paragraph',
                content: 'x',
                parent_id: null,
                position: 0,
              },
              {
                id: 'CONFLICT_2',
                block_type: 'paragraph',
                content: 'y',
                parent_id: null,
                position: 1,
              },
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByLabelText('2 unresolved conflicts')).toBeInTheDocument()
      })
    })

    it('hides conflict badge when getConflicts returns empty', async () => {
      // Default mock already returns emptyPage for all commands
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Give the hook time to resolve
      await waitFor(() => {
        expect(screen.queryByLabelText(/unresolved conflicts/)).not.toBeInTheDocument()
      })
    })

    it('re-polls conflicts on window focus event (#293)', async () => {
      // Initially no conflicts
      let conflictResponse: {
        items: Record<string, unknown>[]
        next_cursor: null
        has_more: boolean
      } = emptyPage
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_conflicts') return conflictResponse
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Initially no conflict badge
      await waitFor(() => {
        expect(screen.queryByLabelText(/unresolved conflicts/)).not.toBeInTheDocument()
      })

      // Now conflicts appear on the backend
      conflictResponse = {
        items: [
          {
            id: 'CONFLICT_2',
            block_type: 'paragraph',
            content: 'y',
            parent_id: null,
            position: 0,
            deleted_at: null,
            is_conflict: true,
          },
        ],
        next_cursor: null,
        has_more: false,
      }

      // Dispatch focus event to trigger re-poll
      fireEvent(window, new Event('focus'))

      // The conflict badge should appear after the focus-triggered poll
      await waitFor(() => {
        expect(screen.getByLabelText('1 unresolved conflicts')).toBeInTheDocument()
      })
    })
  })

  // ── Trash badge ─────────────────────────────────────────────────────────

  describe('trash badge', () => {
    it('shows trash badge with count when listBlocks (showDeleted) returns items', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks' && (args as Record<string, unknown>)?.['showDeleted']) {
          return {
            items: [
              {
                id: 'DELETED_1',
                block_type: 'page',
                content: 'deleted page',
                parent_id: null,
                position: 0,
              },
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByLabelText('1 items in trash')).toBeInTheDocument()
      })
    })

    it('hides trash badge when no deleted items', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.queryByLabelText(/items in trash/)).not.toBeInTheDocument()
      })
    })
  })

  // ── Theme toggle ────────────────────────────────────────────────────────

  describe('theme toggle', () => {
    it('renders theme toggle button in sidebar footer', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      expect(sidebar.getByText(t('sidebar.toggleTheme'))).toBeInTheDocument()
    })

    it('toggles theme on click', async () => {
      const user = userEvent.setup()
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      const themeBtn = sidebar.getByTestId('theme-toggle')
      await user.click(themeBtn)

      // After first click: auto → dark
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })

  // ── Sync status display ─────────────────────────────────────────────────

  describe('sync status display', () => {
    it('shows "Never synced" when lastSyncedAt is null', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      expect(screen.getByTestId('last-synced')).toHaveTextContent(t('sidebar.lastSyncedNever'))
    })

    it('shows last synced time when lastSyncedAt is set', async () => {
      useSyncStore.setState({ lastSyncedAt: new Date().toISOString() })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      expect(screen.getByTestId('last-synced')).toHaveTextContent(/Last synced/)
    })

    // UX-266 — sub-fix 1: the sidebar-footer Sync button surfaces a
    // glanceable colored dot so the user has a sync signal regardless
    // of whether the StatusPanel view is open.
    describe('sidebar Sync button status dot (UX-266)', () => {
      it('renders the dot with the muted color when there are no peers', async () => {
        useSyncStore.setState({ state: 'idle', peers: [] })
        render(<App />)
        const dot = await screen.findByTestId('sync-button-status-dot')
        expect(dot).toBeInTheDocument()
        expect(dot.className).toContain('bg-muted-foreground')
        // Decorative — text label carries semantics.
        expect(dot).toHaveAttribute('aria-hidden', 'true')
      })

      it('renders the dot with the active color while syncing with peers', async () => {
        useSyncStore.setState({
          state: 'syncing',
          peers: [{ peerId: 'P1', lastSyncedAt: null, resetCount: 0 }],
        })
        render(<App />)
        const dot = await screen.findByTestId('sync-button-status-dot')
        expect(dot.className).toContain('bg-sync-active')
        expect(dot).toHaveAttribute('data-sync-state', 'syncing')
      })

      it('renders the dot with the destructive color on sync error', async () => {
        useSyncStore.setState({
          state: 'error',
          error: 'connection lost',
          peers: [{ peerId: 'P1', lastSyncedAt: null, resetCount: 0 }],
        })
        render(<App />)
        const dot = await screen.findByTestId('sync-button-status-dot')
        expect(dot.className).toContain('bg-destructive')
      })
    })

    // BUG-2: clicking the sidebar Sync button when no devices are paired
    // used to silently no-op (the hook's `peers.length === 0` short-circuit
    // returned `'idle'` with no toast / dialog / log). The shell now
    // wraps the click in `handleSyncClick` — if `listPeerRefs()` is empty
    // we open `NoPeersDialog` instead of forwarding to `syncAll()`. The
    // hook itself is unchanged.
    describe('sidebar Sync button — no-peers guard (BUG-2)', () => {
      // Reset the `?settings=...` query param + the persisted Settings
      // tab so each test starts on a known surface — the no-peers CTA
      // pre-selects the Sync tab via the URL param mechanism (UX-276)
      // and we don't want a leftover param from another test polluting
      // the assertion.
      beforeEach(() => {
        window.history.replaceState(window.history.state, '', window.location.pathname)
        localStorage.removeItem('agaric-settings-active-tab')
      })

      it('opens NoPeersDialog when sidebar Sync is clicked with zero peers', async () => {
        const user = userEvent.setup()
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'list_spaces')
            return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
          if (cmd === 'list_peer_refs') return []
          return emptyPage
        })

        render(<App />)
        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        // Click the sidebar Sync button (the one with text "Sync" inside
        // the sidebar — there's also a tooltip; scope to the sidebar to
        // avoid grabbing the tooltip text).
        const sidebar = getSidebar()
        await user.click(sidebar.getByText(t('sidebar.sync')))

        // Dialog opens with the i18n-keyed title + body + actions.
        const dialog = await screen.findByRole('alertdialog')
        expect(within(dialog).getByText(t('sync.noPeersTitle'))).toBeInTheDocument()
        expect(within(dialog).getByText(t('sync.noPeersBody'))).toBeInTheDocument()
        expect(
          within(dialog).getByRole('button', { name: t('sync.noPeersCta') }),
        ).toBeInTheDocument()
        expect(
          within(dialog).getByRole('button', { name: t('sync.noPeersCancel') }),
        ).toBeInTheDocument()
      })

      it('does NOT open NoPeersDialog when at least one peer is paired', async () => {
        const user = userEvent.setup()
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'list_spaces')
            return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
          if (cmd === 'list_peer_refs') {
            return [
              {
                peer_id: 'PEER_1',
                last_hash: null,
                last_sent_hash: null,
                synced_at: null,
                reset_count: 0,
                last_reset_at: null,
                cert_hash: null,
                device_name: 'Laptop',
                last_address: null,
              },
            ]
          }
          return emptyPage
        })

        render(<App />)
        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        const sidebar = getSidebar()
        await user.click(sidebar.getByText(t('sidebar.sync')))

        // Give the async listPeerRefs round-trip a tick to settle, then
        // assert the dialog never mounted. We check the title text rather
        // than `queryByRole('alertdialog')` because Radix may briefly
        // mount-then-unmount; `findByRole`-with-timeout would mask a
        // genuine regression here, so we use a microtask flush + assert
        // absence.
        await waitFor(() => {
          // listPeerRefs invocation completed.
          expect(mockedInvoke).toHaveBeenCalledWith('list_peer_refs')
        })
        expect(screen.queryByText(t('sync.noPeersTitle'))).not.toBeInTheDocument()
        // The original sync flow still fires when peers are paired —
        // i.e. the no-peers guard didn't accidentally suppress the
        // happy path.
        await waitFor(() => {
          expect(mockSyncAll).toHaveBeenCalled()
        })
      })

      it('falls through to syncAll() when listPeerRefs() rejects', async () => {
        const user = userEvent.setup()
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'list_spaces')
            return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
          if (cmd === 'list_peer_refs') throw new Error('IPC unavailable')
          return emptyPage
        })

        render(<App />)
        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        const sidebar = getSidebar()
        await user.click(sidebar.getByText(t('sidebar.sync')))

        // The listPeerRefs IPC was attempted, so the guard ran. Failure
        // falls through to syncAll() — the user still gets a sync
        // attempt rather than a silent no-op.
        await waitFor(() => {
          expect(mockedInvoke).toHaveBeenCalledWith('list_peer_refs')
        })
        await waitFor(() => {
          expect(mockSyncAll).toHaveBeenCalled()
        })
        // No dialog appeared — the rejection branch must NOT spuriously
        // open the no-peers dialog.
        expect(screen.queryByText(t('sync.noPeersTitle'))).not.toBeInTheDocument()
      })

      it('navigates to Settings with the Sync tab pre-selected when CTA is clicked', async () => {
        const user = userEvent.setup()
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'list_spaces')
            return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
          if (cmd === 'list_peer_refs') return []
          return emptyPage
        })

        render(<App />)
        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        const sidebar = getSidebar()
        await user.click(sidebar.getByText(t('sidebar.sync')))

        const dialog = await screen.findByRole('alertdialog')
        await user.click(within(dialog).getByRole('button', { name: t('sync.noPeersCta') }))

        // Dialog closes, view switches to Settings, and the URL deep-link
        // (`?settings=sync`) is set so SettingsView reads it on mount and
        // lands the user directly on the Sync tab (UX-276).
        await waitFor(() => {
          expect(useNavigationStore.getState().currentView).toBe('settings')
        })
        expect(window.location.search).toContain('settings=sync')
        expect(screen.queryByText(t('sync.noPeersTitle'))).not.toBeInTheDocument()
      })

      it('closes the dialog and stays on the current view when Cancel is clicked', async () => {
        const user = userEvent.setup()
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'list_spaces')
            return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
          if (cmd === 'list_peer_refs') return []
          return emptyPage
        })

        render(<App />)
        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        const sidebar = getSidebar()
        await user.click(sidebar.getByText(t('sidebar.sync')))

        const dialog = await screen.findByRole('alertdialog')
        await user.click(within(dialog).getByRole('button', { name: t('sync.noPeersCancel') }))

        // Dialog tears down, navigation stays on journal, the URL stays
        // clean (no `settings=sync` was set on the cancel path).
        await waitFor(() => {
          expect(screen.queryByText(t('sync.noPeersTitle'))).not.toBeInTheDocument()
        })
        expect(useNavigationStore.getState().currentView).toBe('journal')
        expect(window.location.search).not.toContain('settings=sync')
      })
    })
  })

  // ── GlobalDateControls in non-journal views ──────────────────────────

  describe('GlobalDateControls in non-journal views', () => {
    it('shows Today button in pages view', async () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
      })
    })

    it('shows calendar button in pages view', async () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /calendar/i })).toBeInTheDocument()
      })
    })

    it('clicking Today in non-journal view navigates to journal daily', async () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      const user = userEvent.setup()
      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /today/i }))

      await waitFor(() => {
        expect(useNavigationStore.getState().currentView).toBe('journal')
        expect(useJournalStore.getState().mode).toBe('daily')
      })
    })

    it('shows Today button in trash view', async () => {
      useNavigationStore.setState({
        currentView: 'trash',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
      })
    })
  })

  // ── Keyboard shortcuts modal ─────────────────────────────────────────

  describe('keyboard shortcuts modal', () => {
    it('pressing "?" opens the shortcuts panel', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: '?' })

      await waitFor(() => {
        expect(screen.getByText(t('shortcuts.title'))).toBeInTheDocument()
      })
    })

    it('shortcuts panel shows shortcut categories', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: '?' })

      await waitFor(() => {
        expect(screen.getByText(t('shortcuts.title'))).toBeInTheDocument()
      })

      // Scope to the shortcuts table to avoid collisions with sidebar nav items
      const shortcutsTable = screen.getByTestId('shortcuts-table')
      expect(
        within(shortcutsTable).getByText(t('keyboard.category.navigation')),
      ).toBeInTheDocument()
      expect(within(shortcutsTable).getByText(t('keyboard.category.editing'))).toBeInTheDocument()
      expect(within(shortcutsTable).getByText(t('keyboard.category.global'))).toBeInTheDocument()
      expect(within(shortcutsTable).getByText(t('keyboard.category.journal'))).toBeInTheDocument()
    })

    it('clicking sidebar Shortcuts button also opens the panel', async () => {
      const user = userEvent.setup()
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      await user.click(sidebar.getByText(t('sidebar.shortcuts')))

      await waitFor(() => {
        expect(screen.getByText(t('shortcuts.title'))).toBeInTheDocument()
      })
    })
  })

  // ── UX-228: close-all-overlays shortcut ─────────────────────────────

  describe('closeOverlays shortcut (UX-228)', () => {
    it('Escape on window dispatches agaric:closeAllOverlays event', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      try {
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(spy).toHaveBeenCalledTimes(1)
      } finally {
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })

    it('Escape announces "Overlays closed"', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 'Escape' })

      await waitFor(() => {
        expect(announce).toHaveBeenCalledWith(t('announce.overlaysClosed'))
      })
    })

    it('Escape inside an <input> does NOT dispatch the event', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      const input = document.createElement('input')
      document.body.appendChild(input)
      try {
        fireEvent.keyDown(input, { key: 'Escape' })
        await Promise.resolve()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        document.body.removeChild(input)
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })

    it('Escape inside a <textarea> does NOT dispatch the event', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      try {
        fireEvent.keyDown(textarea, { key: 'Escape' })
        await Promise.resolve()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        document.body.removeChild(textarea)
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })

    it('Escape inside a [contenteditable] element does NOT dispatch the event', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      const editable = document.createElement('div')
      editable.setAttribute('contenteditable', 'true')
      document.body.appendChild(editable)
      try {
        fireEvent.keyDown(editable, { key: 'Escape' })
        await Promise.resolve()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        document.body.removeChild(editable)
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })

    it('Escape closes the shortcuts sheet when it is open', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Open the sheet
      fireEvent.keyDown(document, { key: '?' })
      await waitFor(() => {
        expect(screen.getByText(t('shortcuts.title'))).toBeInTheDocument()
      })

      // Dispatch the global close event directly to avoid depending on
      // Radix's internal Escape handling (which fires regardless).
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      await waitFor(() => {
        expect(screen.queryByText(t('shortcuts.title'))).not.toBeInTheDocument()
      })
    })

    it('plain "a" key does NOT dispatch closeAllOverlays', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      try {
        fireEvent.keyDown(window, { key: 'a' })
        await Promise.resolve()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })

    // MAINT-105: holding Escape generates auto-repeat keydown events
    // (e.repeat=true). Without the guard each one would dispatch the
    // closeAllOverlays event + announce, spamming SR users.
    it('ignores auto-repeat Escape (e.repeat=true)', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const spy = vi.fn()
      window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      try {
        fireEvent.keyDown(window, { key: 'Escape', repeat: true })
        await Promise.resolve()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, spy)
      }
    })
  })

  // ── Error paths ─────────────────────────────────────────────────────────

  describe('error paths', () => {
    it('renders error screen when boot status check fails', async () => {
      // Reset boot store to initial state so BootGate triggers boot()
      useBootStore.setState({ state: 'booting', error: null })

      // Make the list_blocks health-check reject
      mockedInvoke.mockRejectedValue(new Error('Database corrupted'))

      render(<App />)

      // BootGate should show the error screen
      await waitFor(() => {
        expect(screen.getByText(t('boot.failedToStart'))).toBeInTheDocument()
      })
      expect(screen.getByText('Database corrupted')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('action.retry') })).toBeInTheDocument()
    })

    it('Ctrl+N shows error toast when page creation fails', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces')
          return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
        if (cmd === 'create_page_in_space') {
          throw new Error('Disk full')
        }
        return emptyPage
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.createPageFailed'))
      })

      // Navigation should NOT have changed
      expect(useNavigationStore.getState().currentView).toBe('journal')
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(0)
    })

    it('New Page sidebar button shows error toast when creation fails', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces')
          return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
        if (cmd === 'create_page_in_space') {
          throw new Error('Disk full')
        }
        return emptyPage
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      await user.click(sidebar.getByText(t('sidebar.newPage')))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.createPageFailed'))
      })

      // Navigation should NOT have changed
      expect(useNavigationStore.getState().currentView).toBe('journal')
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(0)
    })

    it('logs warning when listDrafts fails during boot recovery', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_drafts') {
          throw new Error('Draft table locked')
        }
        return emptyPage
      })

      render(<App />)

      // App should still render normally
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'App',
          'Failed to list drafts during boot recovery',
          undefined,
          expect.any(Error),
        )
      })
    })

    it('logs warning when flushDraft fails during boot recovery', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_drafts') {
          return [{ block_id: 'DRAFT_BLOCK_1', content: 'unsaved text', updated_at: '2025-01-01' }]
        }
        if (cmd === 'flush_draft') {
          throw new Error('Write failed')
        }
        return emptyPage
      })

      render(<App />)

      // App should still render normally
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'App',
          'Failed to flush orphaned draft during boot recovery',
          expect.objectContaining({
            blockId: 'DRAFT_BLOCK_1',
          }),
          expect.any(Error),
        )
      })
    })
  })

  describe('skip-to-main link', () => {
    it('renders a skip-to-main link', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      const skipLink = screen.getByText(t('accessibility.skipToMain'))
      expect(skipLink).toBeInTheDocument()
      expect(skipLink.tagName).toBe('A')
      expect(skipLink).toHaveAttribute('href', '#main-content')
    })

    it('skip link is sr-only by default', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      const skipLink = screen.getByText(t('accessibility.skipToMain'))
      expect(skipLink).toHaveClass('sr-only')
    })

    it('main content has id="main-content"', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      const main = document.getElementById('main-content')
      expect(main).toBeInTheDocument()
    })

    // UX-226: the main content scroller uses ScrollArea (no bare overflow).
    // `id="main-content"` + `tabIndex=-1` land on the scroll viewport so the
    // skip link focuses the real scrollable element and BlockTree's
    // drag-to-auto-scroll (`document.getElementById('main-content')` +
    // `.scrollTop +=`) still drives actual scrolling.
    it('main content scroller is a ScrollArea viewport (UX-226)', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      const main = document.getElementById('main-content')
      expect(main).toBeInTheDocument()
      expect(main?.getAttribute('data-slot')).toBe('scroll-area-viewport')
      expect(main?.getAttribute('tabindex')).toBe('-1')
    })

    // UX-225: the main content scroller re-applies the bottom safe-area
    // inset so the last block of a long scroll doesn't sit under the
    // iPhone home indicator / Android gesture bar. Body-level padding is
    // not enough because the `overflow-y-auto` scroller *contains* the
    // scrollable content — the inset must live on the viewport itself.
    it('main content viewport applies env(safe-area-inset-bottom) padding (UX-225)', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      const main = document.getElementById('main-content')
      expect(main).toBeInTheDocument()
      // The class is rendered statically; check the className string so
      // the test does not depend on runtime CSS resolution (jsdom does
      // not compute `env()` values).
      const cls = main?.getAttribute('class') ?? ''
      expect(cls).toContain('env(safe-area-inset-bottom)')
      expect(cls).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]')
    })
  })

  // FEAT-7: TabBar is now mounted at the app-shell level, so multi-tab state
  // makes the tablist visible across every sidebar destination — not just
  // inside page-editor.
  describe('FEAT-7 shell-level TabBar hoist', () => {
    const shellViews: Array<Exclude<import('../../stores/navigation').View, 'properties'>> = [
      'journal',
      'pages',
      'tags',
      'search',
      'graph',
      'trash',
      'status',
      'conflicts',
      'history',
      'templates',
      'settings',
    ]

    for (const view of shellViews) {
      it(`TabBar is visible at shell level while currentView === "${view}"`, async () => {
        useNavigationStore.setState({
          currentView: view,
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
            { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
          ],
          activeTabIndex: 0,
          selectedBlockId: null,
        })

        render(<App />)

        await waitFor(() => {
          expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
        })

        const tablist = screen.getByRole('tablist', { name: t('tabs.tabList') })
        expect(tablist).toBeInTheDocument()
        expect(within(tablist).getAllByRole('tab')).toHaveLength(3)
      })
    }

    it('TabBar is visible at shell level while currentView === "page-editor"', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          {
            id: '0',
            pageStack: [{ pageId: 'PAGE_1', title: 'Page One' }],
            label: 'Page One',
          },
          {
            id: '1',
            pageStack: [{ pageId: 'PAGE_2', title: 'Page Two' }],
            label: 'Page Two',
          },
        ],
        activeTabIndex: 0,
        selectedBlockId: null,
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const tablist = screen.getByRole('tablist', { name: t('tabs.tabList') })
      expect(tablist).toBeInTheDocument()
    })

    // FEAT-7 UX follow-up (session 467): before this fix, pressing Ctrl+T
    // from a fresh tab with an empty pageStack silently did nothing. The
    // handler now surfaces a toast so the user gets explicit feedback.
    it('Ctrl+T with an empty pageStack toasts "No page to open in a new tab"', async () => {
      const mockedToastError = vi.mocked(toast.error)
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 't', ctrlKey: true })

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(t('tabs.openInNewTabEmpty'))
      })
    })

    it('Ctrl+T with a populated pageStack calls openInNewTab (no toast)', async () => {
      const mockedToastError = vi.mocked(toast.error)
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [
          {
            id: '0',
            pageStack: [{ pageId: 'PAGE_A', title: 'Page A' }],
            label: 'Page A',
          },
        ],
        activeTabIndex: 0,
        selectedBlockId: null,
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 't', ctrlKey: true })

      await waitFor(() => {
        // A new tab was opened (original + new = 2).
        expect(useNavigationStore.getState().tabs).toHaveLength(2)
      })
      expect(mockedToastError).not.toHaveBeenCalledWith(t('tabs.openInNewTabEmpty'))
    })
  })

  // FEAT-9: the RecentPagesStrip mounts between the hoisted TabBar and the
  // ViewHeaderOutletSlot. Auto-hidden on mobile and when the visible list
  // (minus the currently-open page) is empty.
  describe('FEAT-9 recent-pages strip', () => {
    it('mounts between TabBar and ViewHeaderOutletSlot in the shell', async () => {
      // Seed two recent pages and render from a non-editor view so the
      // currently-open page filter doesn't hide every chip.
      useRecentPagesStore.setState({
        recentPages: [
          { pageId: 'A', title: 'Alpha' },
          { pageId: 'B', title: 'Bravo' },
        ],
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const strip = screen.getByTestId('recent-pages-strip')
      expect(strip).toBeInTheDocument()

      // DOM-tree ordering: TabBar is not rendered with 1 tab, but the strip
      // must still be a descendant of the SidebarInset and appear BEFORE the
      // view-header outlet so it sits above the scroll area.
      const outlet = screen.getByTestId('view-header-outlet')
      const position = strip.compareDocumentPosition(outlet)
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('mounts after TabBar when both are visible', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'A', title: 'Alpha' }], label: 'Alpha' },
          { id: '1', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' },
        ],
        activeTabIndex: 0,
        selectedBlockId: null,
      })
      useRecentPagesStore.setState({
        recentPages: [
          { pageId: 'C', title: 'Charlie' },
          { pageId: 'D', title: 'Delta' },
        ],
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const tablist = screen.getByRole('tablist', { name: t('tabs.tabList') })
      const strip = screen.getByTestId('recent-pages-strip')
      const outlet = screen.getByTestId('view-header-outlet')

      // TabBar → RecentPagesStrip → ViewHeaderOutletSlot document order.
      const tablistToStrip = tablist.compareDocumentPosition(strip)
      expect(tablistToStrip & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const stripToOutlet = strip.compareDocumentPosition(outlet)
      expect(stripToOutlet & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('is hidden on mobile', async () => {
      mockedUseIsMobile.mockReturnValue(true)

      useRecentPagesStore.setState({
        recentPages: [
          { pageId: 'A', title: 'Alpha' },
          { pageId: 'B', title: 'Bravo' },
        ],
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      expect(screen.queryByTestId('recent-pages-strip')).toBeNull()
    })

    it('is hidden when recentPages is empty', async () => {
      useRecentPagesStore.setState({ recentPages: [] })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      expect(screen.queryByTestId('recent-pages-strip')).toBeNull()
    })
  })

  // UX-198: view-level sticky headers didn't stick because the nearest
  // scroll ancestor was the ScrollArea viewport, not the view component.
  // The fix hoists headers into a <ViewHeaderOutletSlot /> rendered
  // between App's fixed app-shell <header> and the main <ScrollArea>, so
  // portaled headers live outside the scroll container entirely.
  describe('ViewHeaderOutlet (UX-198)', () => {
    it('renders the view-header outlet above the main scroll area', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      const outlet = screen.getByTestId('view-header-outlet')
      const scrollAreaRoot = document.querySelector('[data-slot="main-content"]')
      expect(outlet).toBeInTheDocument()
      expect(scrollAreaRoot).not.toBeNull()

      // The slot must be a *preceding* sibling of the scroll-area root
      // (both live inside the SidebarInset). Using compareDocumentPosition
      // gives a deterministic ordering check that doesn't depend on the
      // exact wrapper structure.
      const position = outlet.compareDocumentPosition(scrollAreaRoot as Node)
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  // UX-201b: on boot, App reads the `priority` property definition's
  // options JSON and hydrates the shared priority-levels cache so badge
  // colours / sort / filter choices reflect the user's configured set.
  describe('priority levels boot load (UX-201b)', () => {
    it('hydrates getPriorityLevels() from listPropertyDefs on mount', async () => {
      __resetPriorityLevelsForTests()

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [
            {
              key: 'priority',
              value_type: 'select',
              options: '["1","2","3","4"]',
              created_at: '2025-01-01T00:00:00Z',
            },
          ]
        }
        return emptyPage
      })

      render(<App />)

      await waitFor(() => {
        expect(getPriorityLevels()).toEqual(['1', '2', '3', '4'])
      })
    })

    it('keeps defaults when priority definition is missing', async () => {
      __resetPriorityLevelsForTests()

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') return []
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      expect(getPriorityLevels()).toEqual(['1', '2', '3'])
    })

    it('keeps defaults and logs warn on invalid JSON options', async () => {
      __resetPriorityLevelsForTests()

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [
            {
              key: 'priority',
              value_type: 'select',
              options: 'not-json',
              created_at: '2025-01-01T00:00:00Z',
            },
          ]
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'App',
          'priority property definition has invalid JSON options',
          expect.any(Object),
          expect.any(Error),
        )
      })
      expect(getPriorityLevels()).toEqual(['1', '2', '3'])
    })

    it('keeps defaults and logs warn when options is not an array', async () => {
      __resetPriorityLevelsForTests()

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_property_defs') {
          return [
            {
              key: 'priority',
              value_type: 'select',
              options: '{"x":"y"}',
              created_at: '2025-01-01T00:00:00Z',
            },
          ]
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'App',
          'priority property options is not an array',
          expect.any(Object),
        )
      })
      expect(getPriorityLevels()).toEqual(['1', '2', '3'])
    })
  })

  // FEAT-3p7 — Cross-space link enforcement. When the active space
  // changes, the App-level subscriber must:
  //   1. Wipe the `pagesList` short-query cache (so the link picker
  //      cannot surface previous-space pages).
  //   2. Flush every cache entry keyed under the previous space (so
  //      a stale chip resolution can't leak across the boundary —
  //      foreign chips fall through to the broken-link UX instead).
  //
  // The previous Phase 2 behaviour kept the cache intact and relied
  // on the chip resolver to render foreign titles "for continuity";
  // the locked-in policy (FEAT-3p7) inverts this — no live links
  // between spaces, ever.
  describe('FEAT-3p7 — cross-space cache flush on space switch', () => {
    it('flushes both pagesList and the previous space cache when currentSpaceId changes', async () => {
      // Override the default mock so `preload()` populates
      // `useResolveStore.pagesList` with a deterministic entry, and
      // the ULID→title `cache` lands keyed under SPACE_A.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces') {
          return [
            { id: 'SPACE_A', name: 'A', accent_color: null },
            { id: 'SPACE_B', name: 'B', accent_color: null },
          ]
        }
        if (cmd === 'list_blocks') {
          return {
            items: [{ id: 'PAGE_A1', content: 'Page A1', deleted_at: null }],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'list_tags_by_prefix') return []
        return emptyPage
      })
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_A',
        availableSpaces: [
          { id: 'SPACE_A', name: 'A', accent_color: null },
          { id: 'SPACE_B', name: 'B', accent_color: null },
        ],
        isReady: true,
      })

      render(<App />)

      // Wait for `preload()` to resolve and populate the cache + pagesList
      // for SPACE_A. The clear-on-mount effect runs synchronously first
      // (against an empty list); `preload()` is async and fills in next.
      await waitFor(() => {
        expect(useResolveStore.getState().pagesList.length).toBeGreaterThan(0)
      })
      // FEAT-3p7 — composite keys: SPACE_A's preload writes
      // `${SPACE_A}::PAGE_A1`.
      expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_A1'))).toEqual({
        title: 'Page A1',
        deleted: false,
      })

      act(() => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
      })

      await waitFor(() => {
        expect(useResolveStore.getState().pagesList.length).toBe(0)
      })
      // FEAT-3p7 — `clearAllForSpace('SPACE_A')` flushes every
      // `${SPACE_A}::*` entry so a foreign-space chip doesn't
      // continue resolving to its old title from a stale cache hit.
      await waitFor(() => {
        expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_A1'))).toBeUndefined()
      })
    })

    it('invokes clearAllForSpace with the OUTGOING space id on switch', async () => {
      // Spy on the resolve store action so we can assert exactly which
      // space id the App-level subscriber forwarded. The spy must be
      // installed BEFORE `render(<App />)` because the subscriber
      // captures `clearAllForSpace` via `useResolveStore.getState()`
      // and we want every call (including the boot pass) observable.
      const clearAllForSpaceSpy = vi.spyOn(useResolveStore.getState(), 'clearAllForSpace')

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces') {
          return [
            { id: 'SPACE_A', name: 'A', accent_color: null },
            { id: 'SPACE_B', name: 'B', accent_color: null },
          ]
        }
        if (cmd === 'list_blocks') {
          return { items: [], next_cursor: null, has_more: false }
        }
        if (cmd === 'list_tags_by_prefix') return []
        return emptyPage
      })
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_A',
        availableSpaces: [
          { id: 'SPACE_A', name: 'A', accent_color: null },
          { id: 'SPACE_B', name: 'B', accent_color: null },
        ],
        isReady: true,
      })

      render(<App />)

      // First pass (App mount with currentSpaceId === SPACE_A): no
      // outgoing space yet, so `clearAllForSpace` should NOT have been
      // called. Wait for the App tree to settle.
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })
      expect(clearAllForSpaceSpy).not.toHaveBeenCalled()

      // Switch to SPACE_B — the subscriber must fire
      // `clearAllForSpace('SPACE_A')` with the OUTGOING id.
      act(() => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
      })

      await waitFor(() => {
        expect(clearAllForSpaceSpy).toHaveBeenCalledWith('SPACE_A')
      })

      clearAllForSpaceSpy.mockRestore()
    })
  })

  // UX-279: shell-level BugReportDialog mount that listens for the
  // `BUG_REPORT_EVENT` global event from FeatureErrorBoundary's "Report
  // bug" button. The dialog must open with the supplied detail
  // (message → initialTitle, stack → initialDescription) pre-filled.
  describe('UX-279 — bug-report event listener', () => {
    const sampleMetadata = {
      app_version: '0.1.0',
      os: 'linux',
      arch: 'x86_64',
      device_id: 'DEV-XYZ',
      recent_errors: [],
    }

    beforeEach(() => {
      // Override the default mock so `collect_bug_report_metadata`
      // resolves with a stable payload (otherwise BugReportDialog logs
      // a warning and keeps the form blank, which obscures the prefill
      // assertion below). Everything else keeps the empty-page default.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces')
          return [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }]
        if (cmd === 'collect_bug_report_metadata') return sampleMetadata
        if (cmd === 'read_logs_for_report') return []
        return emptyPage
      })
    })

    it('does not render the BugReportDialog by default', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // The shell-level dialog stays closed until the event fires.
      expect(screen.queryByRole('dialog', { name: t('bugReport.title') })).not.toBeInTheDocument()
    })

    it('opens the BugReportDialog with prefilled message + stack on agaric:report-bug', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      act(() => {
        window.dispatchEvent(
          new CustomEvent('agaric:report-bug', {
            detail: { message: 'view crashed', stack: 'at Bomb (file.tsx:1:1)' },
          }),
        )
      })

      // Dialog opens with the prefilled values applied to the form.
      const titleInput = (await screen.findByLabelText(
        t('bugReport.fieldTitleLabel'),
      )) as HTMLInputElement
      expect(titleInput.value).toBe('view crashed')

      const descInput = screen.getByLabelText(
        t('bugReport.fieldDescriptionLabel'),
      ) as HTMLTextAreaElement
      expect(descInput.value).toBe('at Bomb (file.tsx:1:1)')
    })

    it('opens with empty description when the event detail has no stack', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      act(() => {
        window.dispatchEvent(
          new CustomEvent('agaric:report-bug', {
            detail: { message: 'no-stack crash' },
          }),
        )
      })

      const titleInput = (await screen.findByLabelText(
        t('bugReport.fieldTitleLabel'),
      )) as HTMLInputElement
      expect(titleInput.value).toBe('no-stack crash')

      const descInput = screen.getByLabelText(
        t('bugReport.fieldDescriptionLabel'),
      ) as HTMLTextAreaElement
      expect(descInput.value).toBe('')
    })
  })

  // ── FEAT-3p11 — digit hotkeys for instant space switching ──────────────
  //
  // `Ctrl+1` … `Ctrl+9` (`Cmd+1` … `Cmd+9` on macOS — `matchesShortcutBinding`
  // already accepts `metaKey`) jump directly to the Nth space in the
  // alphabetical `availableSpaces` order. Out-of-range digits are silent
  // no-ops, and the handler is suppressed while the user is typing in an
  // input/textarea/contenteditable so it never steals keystrokes.
  describe('FEAT-3p11 — space digit hotkeys', () => {
    const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }
    const WORK = { id: 'SPACE_WORK', name: 'Work', accent_color: null }

    beforeEach(() => {
      // Two seeded spaces in alphabetical order matches the v1 onboarding
      // shape: `Personal` first, `Work` second. Default
      // `currentSpaceId === Personal` means `Ctrl+2` is the observable
      // change for "first switch", and `Ctrl+5` is unambiguously
      // out-of-range without depending on test ordering.
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, WORK],
        isReady: true,
      })
    })

    it('Ctrl+1 switches to first space alphabetically', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Start on the second space so the Ctrl+1 chord causes an
      // observable change to the first alphabetical entry.
      useSpaceStore.getState().setCurrentSpace(WORK.id)
      expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)

      fireEvent.keyDown(window, { key: '1', ctrlKey: true })

      await waitFor(() => {
        expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
      })
    })

    it('Ctrl+5 with only 2 spaces is a silent no-op (no toast, no error)', async () => {
      const mockedToastError = vi.mocked(toast.error)
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Clear any toast.error / logger.error calls fired during the
      // App's mount-time effects (e.g. JournalPage auto-create using
      // a default-mocked `create_page_in_space` result) so the
      // assertions below scope cleanly to the Ctrl+5 keydown alone.
      // FEAT-3p11's intent is "Ctrl+5 is a silent no-op" — not "the
      // App shell never fires any toast at any point during its
      // boot-time auto-create wiring".
      mockedToastError.mockClear()
      vi.mocked(logger.error).mockClear()

      // Capture the active id so we can assert it never moved.
      const before = useSpaceStore.getState().currentSpaceId

      fireEvent.keyDown(window, { key: '5', ctrlKey: true })
      // Let the synchronous handler + any microtasks settle.
      await Promise.resolve()

      expect(useSpaceStore.getState().currentSpaceId).toBe(before)
      expect(mockedToastError).not.toHaveBeenCalled()
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('Ctrl+1 inside a textarea does NOT switch space (typing is preserved)', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Pin the active space to Work so the would-be Ctrl+1 fallback to
      // Personal is the observable signal that the handler fired
      // erroneously.
      useSpaceStore.getState().setCurrentSpace(WORK.id)

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      try {
        fireEvent.keyDown(textarea, { key: '1', ctrlKey: true })
        await Promise.resolve()
        expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
      } finally {
        document.body.removeChild(textarea)
      }
    })
  })

  // FEAT-3p10 — visual identity. On every space change:
  //   1. The `--accent-current` CSS variable on
  //      `document.documentElement` is rebound to the active space's
  //      accent token.
  //   2. The OS window title is updated to `"<SpaceName> · Agaric"`
  //      via the `setWindowTitle` wrapper (mocked at file scope).
  //
  // Falls back to plain `Agaric` when no space is active.
  describe('FEAT-3p10 — visual identity (accent + window title)', () => {
    const PERSONAL = { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }
    const WORK = { id: 'SPACE_WORK', name: 'Work', accent_color: 'accent-blue' }

    beforeEach(() => {
      // Hand the store a deterministic starting set so the assertions
      // don't race the boot-time `refreshAvailableSpaces()`.
      useSpaceStore.setState({
        currentSpaceId: PERSONAL.id,
        availableSpaces: [PERSONAL, WORK],
        isReady: true,
      })
      // Override the mocked `list_spaces` so the boot-time refresh
      // returns BOTH spaces (the outer beforeEach only seeds Personal).
      // Without this, switching to Work would leave `availableSpaces`
      // missing the row and `find()` would return undefined.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces') return [PERSONAL, WORK]
        return emptyPage
      })
      // Reset any stray inline style left over from prior tests so the
      // assertion that runs immediately after mount is meaningful.
      document.documentElement.style.removeProperty('--accent-current')
      vi.mocked(setWindowTitle).mockClear()
    })

    it('sets --accent-current to the active space accent on initial mount', async () => {
      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // The effect runs synchronously on mount; the inline-style
      // setter pushes `var(--<token>)` onto the documentElement.
      expect(document.documentElement.style.getPropertyValue('--accent-current')).toBe(
        'var(--accent-emerald)',
      )
    })

    it('calls setWindowTitle("Personal · Agaric") on initial mount', async () => {
      render(<App />)

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Personal \u00b7 Agaric')
      })
    })

    it('rebinds --accent-current and re-stamps the title when the active space changes', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Initial assert so we know the baseline call landed.
      await waitFor(() => {
        expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Personal \u00b7 Agaric')
      })
      vi.mocked(setWindowTitle).mockClear()

      // Switch to Work — the effect re-runs because currentSpaceId is
      // a useSpaceStore subscription dep.
      act(() => {
        useSpaceStore.getState().setCurrentSpace(WORK.id)
      })

      await waitFor(() => {
        expect(document.documentElement.style.getPropertyValue('--accent-current')).toBe(
          'var(--accent-blue)',
        )
      })
      await waitFor(() => {
        expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Work \u00b7 Agaric')
      })
    })

    it('falls back to plain "Agaric" when no space is active', async () => {
      // Override the boot mock so list_spaces returns an empty array;
      // that pushes the store into the unhydrated state.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_spaces') return []
        return emptyPage
      })
      useSpaceStore.setState({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: true,
      })

      render(<App />)
      await waitFor(() => {
        expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Agaric')
      })
    })
  })
})
