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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import App from '../../App'
import { announce } from '../../lib/announcer'
import { logger } from '../../lib/logger'
import { useBootStore } from '../../stores/boot'
import { useJournalStore } from '../../stores/journal'
import { useNavigationStore } from '../../stores/navigation'
import { useSyncStore } from '../../stores/sync'

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
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

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()

  // Start with boot already completed so BootGate renders children immediately.
  // This avoids the async boot cycle on every test — boot logic is tested in boot.test.ts.
  useBootStore.setState({ state: 'ready', error: null })

  // Reset the navigation store so each test starts at the default view.
  useNavigationStore.setState({
    currentView: 'journal',
    pageStack: [],
    selectedBlockId: null,
  })

  // Reset the sync store so lastSyncedAt is null.
  useSyncStore.getState().reset()

  // Reset theme state.
  localStorage.removeItem('theme-preference')
  document.documentElement.classList.remove('dark')

  // Dismiss onboarding modal so it doesn't block interactions.
  localStorage.setItem('agaric-onboarding-done', 'true')

  // Default mock: all invoke calls return an empty page response.
  // This covers: boot store's list_blocks, JournalPage, PageBrowser, TagList, TrashView.
  mockedInvoke.mockResolvedValue(emptyPage)
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
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Sidebar should have all 6 nav items
    const sidebar = getSidebar()
    expect(sidebar.getByText('Journal')).toBeInTheDocument()
    expect(sidebar.getByText('Pages')).toBeInTheDocument()
    expect(sidebar.getByText('Tags')).toBeInTheDocument()
    expect(sidebar.getByText('Trash')).toBeInTheDocument()
    expect(sidebar.getByText('Status')).toBeInTheDocument()
    expect(sidebar.getByText('Conflicts')).toBeInTheDocument()
  })

  it('renders the app branding', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
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

  it('switches to Pages view', async () => {
    const user = userEvent.setup()
    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Click Pages in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText('Pages'))

    // PageBrowser should render with its new-page input
    await waitFor(() => {
      expect(screen.getByPlaceholderText('New page name...')).toBeInTheDocument()
    })
  })

  it('switches to Tags view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Click Tags in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText('Tags'))

    // TagList should render
    await waitFor(() => {
      expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Add Tag/i })).toBeInTheDocument()
  })

  it('switches to Trash view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Click Trash in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText('Trash'))

    // TrashView should render its empty state
    await waitFor(() => {
      expect(
        screen.getByText(/Nothing in trash\. Deleted items will appear here\./),
      ).toBeInTheDocument()
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
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Click Status in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText('Status'))

    // StatusPanel should render
    await waitFor(() => {
      expect(screen.getByText('Materializer Status')).toBeInTheDocument()
    })
  })

  it('switches to Conflicts view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // Click Conflicts in sidebar
    const sidebar = getSidebar()
    await user.click(sidebar.getByText('Conflicts'))

    // ConflictList should render its empty state
    await waitFor(() => {
      expect(
        screen.getByText(
          /No conflicts\. Conflicts appear when the same block is edited on multiple devices\./,
        ),
      ).toBeInTheDocument()
    })
  })

  it('switches back to Journal from another view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    const sidebar = getSidebar()

    // Go to Pages
    await user.click(sidebar.getByText('Pages'))
    await waitFor(() => {
      expect(screen.getByPlaceholderText('New page name...')).toBeInTheDocument()
    })

    // Go back to Journal
    await user.click(sidebar.getByText('Journal'))

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
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })
    const sidebar = getSidebar()
    const journalBtn = sidebar.getByText('Journal').closest('[data-sidebar="menu-button"]')
    expect(journalBtn).toHaveAttribute('data-active', 'true')
    const pagesBtn = sidebar.getByText('Pages').closest('[data-sidebar="menu-button"]')
    expect(pagesBtn).toHaveAttribute('data-active', 'false')
    await user.click(sidebar.getByText('Pages'))
    await waitFor(() => {
      expect(screen.getByPlaceholderText('New page name...')).toBeInTheDocument()
    })
    const journalBtnAfter = sidebar.getByText('Journal').closest('[data-sidebar="menu-button"]')
    const pagesBtnAfter = sidebar.getByText('Pages').closest('[data-sidebar="menu-button"]')
    expect(pagesBtnAfter).toHaveAttribute('data-active', 'true')
    expect(journalBtnAfter).toHaveAttribute('data-active', 'false')
  })

  it('shows empty header label for page-editor view (title is in PageEditor)', async () => {
    // Navigate to page-editor via the navigation store
    useNavigationStore.setState({
      currentView: 'page-editor',
      pageStack: [{ pageId: 'PAGE_1', title: 'My Test Page' }],
      selectedBlockId: null,
    })

    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    // The header should NOT show the page title (it's shown in PageEditor itself)
    const headerLabel = screen.getByTestId('header-label')
    expect(headerLabel.textContent).toBe('')
  })

  it('Ctrl+F switches to search view', async () => {
    render(<App />)

    // Wait for boot
    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
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
      expect(screen.getByText('Agaric')).toBeInTheDocument()
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
      expect(state.pageStack).toContainEqual(
        expect.objectContaining({ pageId: 'NEW_PAGE_ID_00000000000000', title: 'Untitled' }),
      )
    })
  })

  it('Ctrl+F announces "Search opened"', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('Search opened')
    })
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
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('New page created')
    })
  })

  // ── Journal navigation shortcuts (Alt+Arrow, Alt+T) ─────────────────

  describe('journal navigation shortcuts', () => {
    it('Alt+ArrowLeft navigates to previous day in daily mode', async () => {
      const startDate = new Date(2025, 5, 15) // Jun 15, 2025
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subDays(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to previous day')
    })

    it('Alt+ArrowRight navigates to next day in daily mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addDays(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to next day')
    })

    it('Alt+ArrowLeft navigates to previous week in weekly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'weekly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subWeeks(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to previous week')
    })

    it('Alt+ArrowRight navigates to next week in weekly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'weekly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addWeeks(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to next week')
    })

    it('Alt+ArrowLeft navigates to previous month in monthly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'monthly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(subMonths(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to previous month')
    })

    it('Alt+ArrowRight navigates to next month in monthly mode', async () => {
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'monthly', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        expect(state.currentDate.getTime()).toBe(addMonths(startDate, 1).getTime())
      })
      expect(announce).toHaveBeenCalledWith('Navigated to next month')
    })

    it('Alt+T jumps to today', async () => {
      const pastDate = new Date(2024, 0, 1)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      const beforePress = new Date()
      fireEvent.keyDown(document, { key: 't', altKey: true })

      await waitFor(() => {
        const state = useJournalStore.getState()
        // The date should be "today" — within a few seconds of now
        const diff = Math.abs(state.currentDate.getTime() - beforePress.getTime())
        expect(diff).toBeLessThan(5000)
      })
      expect(announce).toHaveBeenCalledWith('Jumped to today')
    })

    it('Alt+T (uppercase) also jumps to today', async () => {
      const pastDate = new Date(2024, 0, 1)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'T', altKey: true })

      await waitFor(() => {
        expect(announce).toHaveBeenCalledWith('Jumped to today')
      })
    })

    it('Alt+Arrow does nothing when not on journal view', async () => {
      useNavigationStore.setState({ currentView: 'pages', pageStack: [], selectedBlockId: null })
      const startDate = new Date(2025, 5, 15)
      useJournalStore.setState({ mode: 'daily', currentDate: startDate })

      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

      // Date should not change
      expect(useJournalStore.getState().currentDate.getTime()).toBe(startDate.getTime())
      expect(announce).not.toHaveBeenCalled()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByLabelText('2 unresolved conflicts')).toBeInTheDocument()
      })
    })

    it('hides conflict badge when getConflicts returns empty', async () => {
      // Default mock already returns emptyPage for all commands
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        if (cmd === 'list_blocks' && (args as Record<string, unknown>)?.showDeleted) {
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByLabelText('1 items in trash')).toBeInTheDocument()
      })
    })

    it('hides trash badge when no deleted items', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      expect(sidebar.getByText('Toggle theme')).toBeInTheDocument()
    })

    it('toggles theme on click', async () => {
      const user = userEvent.setup()
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      expect(screen.getByTestId('last-synced')).toHaveTextContent('Never synced')
    })

    it('shows last synced time when lastSyncedAt is set', async () => {
      useSyncStore.setState({ lastSyncedAt: new Date().toISOString() })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      expect(screen.getByTestId('last-synced')).toHaveTextContent(/Last synced/)
    })
  })

  // ── GlobalDateControls in non-journal views ──────────────────────────

  describe('GlobalDateControls in non-journal views', () => {
    it('shows Today button in pages view', async () => {
      useNavigationStore.setState({ currentView: 'pages', pageStack: [], selectedBlockId: null })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /today/i })).toBeInTheDocument()
      })
    })

    it('shows calendar button in pages view', async () => {
      useNavigationStore.setState({ currentView: 'pages', pageStack: [], selectedBlockId: null })
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /calendar/i })).toBeInTheDocument()
      })
    })

    it('clicking Today in non-journal view navigates to journal daily', async () => {
      useNavigationStore.setState({ currentView: 'pages', pageStack: [], selectedBlockId: null })
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
      useNavigationStore.setState({ currentView: 'trash', pageStack: [], selectedBlockId: null })
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: '?' })

      await waitFor(() => {
        expect(screen.getByText('Quick Reference')).toBeInTheDocument()
      })
    })

    it('shortcuts panel shows shortcut categories', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(document, { key: '?' })

      await waitFor(() => {
        expect(screen.getByText('Quick Reference')).toBeInTheDocument()
      })

      // Scope to the shortcuts table to avoid collisions with sidebar nav items
      const shortcutsTable = screen.getByTestId('shortcuts-table')
      expect(within(shortcutsTable).getByText('Navigation')).toBeInTheDocument()
      expect(within(shortcutsTable).getByText('Editing')).toBeInTheDocument()
      expect(within(shortcutsTable).getByText('Global')).toBeInTheDocument()
      expect(within(shortcutsTable).getByText('Journal')).toBeInTheDocument()
    })

    it('clicking sidebar Shortcuts button also opens the panel', async () => {
      const user = userEvent.setup()
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      await user.click(sidebar.getByText('Shortcuts'))

      await waitFor(() => {
        expect(screen.getByText('Quick Reference')).toBeInTheDocument()
      })
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
        expect(screen.getByText('Failed to start')).toBeInTheDocument()
      })
      expect(screen.getByText('Database corrupted')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to create page')
      })

      // Navigation should NOT have changed
      expect(useNavigationStore.getState().currentView).toBe('journal')
      expect(useNavigationStore.getState().pageStack).toHaveLength(0)
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })

      const sidebar = getSidebar()
      await user.click(sidebar.getByText('New Page'))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to create page')
      })

      // Navigation should NOT have changed
      expect(useNavigationStore.getState().currentView).toBe('journal')
      expect(useNavigationStore.getState().pageStack).toHaveLength(0)
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
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
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })
      const skipLink = screen.getByText('Skip to main content')
      expect(skipLink).toBeInTheDocument()
      expect(skipLink.tagName).toBe('A')
      expect(skipLink).toHaveAttribute('href', '#main-content')
    })

    it('skip link is sr-only by default', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })
      const skipLink = screen.getByText('Skip to main content')
      expect(skipLink).toHaveClass('sr-only')
    })

    it('main content has id="main-content"', async () => {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByText('Agaric')).toBeInTheDocument()
      })
      const main = document.getElementById('main-content')
      expect(main).toBeInTheDocument()
    })
  })
})
