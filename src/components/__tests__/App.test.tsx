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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import App from '../../App'
import { announce } from '../../lib/announcer'
import { useBootStore } from '../../stores/boot'
import { useNavigationStore } from '../../stores/navigation'

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()

  // Reset the Zustand boot store between tests so each test starts fresh.
  useBootStore.setState({ state: 'booting', error: null })

  // Reset the navigation store so each test starts at the default view.
  useNavigationStore.setState({
    currentView: 'journal',
    pageStack: [],
    selectedBlockId: null,
  })

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

    // PageBrowser should render with its New Page button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
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
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
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
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
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
})
