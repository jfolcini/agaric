/**
 * Tests for App component.
 *
 * Validates:
 *  - Renders with sidebar and default view (Journal)
 *  - Clicking nav items switches views
 *  - All 4 views render (Journal, Pages, Tags, Trash)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import App from '../../App'
import { useBootStore } from '../../stores/boot'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()

  // Reset the Zustand boot store between tests so each test starts fresh.
  useBootStore.setState({ state: 'booting', error: null })

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

    // Sidebar should have all 4 nav items
    const sidebar = getSidebar()
    expect(sidebar.getByText('Journal')).toBeInTheDocument()
    expect(sidebar.getByText('Pages')).toBeInTheDocument()
    expect(sidebar.getByText('Tags')).toBeInTheDocument()
    expect(sidebar.getByText('Trash')).toBeInTheDocument()
  })

  it('renders the app branding', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Agaric')).toBeInTheDocument()
    })
  })

  it('defaults to Journal view', async () => {
    render(<App />)

    // JournalPage renders date navigation buttons
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Prev/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Next/i })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Write something...')).toBeInTheDocument()
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
      expect(screen.getByText('Trash is empty.')).toBeInTheDocument()
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

    // Journal should render again
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Write something...')).toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<App />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
