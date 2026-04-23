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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, addMonths, addWeeks, subDays, subMonths, subWeeks } from 'date-fns'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from '../../App'
import { useIsMobile } from '../../hooks/use-mobile'
import { announce } from '../../lib/announcer'
import { t } from '../../lib/i18n'
import { logger } from '../../lib/logger'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../../lib/overlay-events'
import { __resetPriorityLevelsForTests, getPriorityLevels } from '../../lib/priority-levels'
import { useBootStore } from '../../stores/boot'
import { useJournalStore } from '../../stores/journal'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { useRecentPagesStore } from '../../stores/recent-pages'
import { useSpaceStore } from '../../stores/space'
import { useSyncStore } from '../../stores/sync'

// FEAT-9: controllable mobile mock so we can flip the breakpoint per-test
// without fiddling with window.innerWidth + matchMedia polyfills.
vi.mock('../../hooks/use-mobile', () => ({
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

// Mock useSyncTrigger to prevent automatic sync in tests
vi.mock('../../hooks/useSyncTrigger', () => ({
  useSyncTrigger: () => ({ syncing: false, syncAll: vi.fn() }),
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
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })

  // FEAT-9: reset the recent-pages MRU so RecentPagesStrip tests are isolated.
  useRecentPagesStore.setState({ recentPages: [] })

  // FEAT-3 Phase 1: reset the space store so SpaceSwitcher renders
  // deterministic state regardless of test ordering.
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
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
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_spaces') return []
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
    // Mock create_block to return a new page
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_block') {
        return {
          id: 'NEW_PAGE_ID_00000000000000',
          block_type: 'page',
          content: 'Untitled',
          parent_id: null,
          position: 0,
        }
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

    // Should call create_block and then navigate to the new page
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'page',
        content: 'Untitled',
        parentId: null,
        position: null,
      })
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
      if (cmd === 'create_block') {
        return {
          id: 'NEW_PAGE_ID_00000000000000',
          block_type: 'page',
          content: 'Untitled',
          parent_id: null,
          position: 0,
        }
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
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_block') {
          return {
            id: 'NEW_PAGE_1',
            block_type: 'page',
            content: 'Untitled',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
          }
        }
        return emptyPage
      })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /Switch space/ })).toBeInTheDocument()
      })

      // Old Ctrl+N does NOT fire create_block
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
      await Promise.resolve()
      expect(mockedInvoke).not.toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ blockType: 'page', content: 'Untitled' }),
      )

      // New Ctrl+Alt+M fires
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true, altKey: true })
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_block',
          expect.objectContaining({ blockType: 'page', content: 'Untitled' }),
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
        if (cmd === 'create_block') {
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
        if (cmd === 'create_block') {
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
})
