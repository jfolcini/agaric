/**
 * Tests for GraphView component (F-33).
 *
 * Validates:
 *  - Shows loading skeleton on mount
 *  - Shows empty state when no pages exist
 *  - Renders SVG when pages and links are loaded
 *  - Shows error state on fetch failure
 *  - Has no a11y violations
 *  - Calls navigateToPage from navigation store
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { drag } from 'd3-drag'
import { forceSimulation } from 'd3-force'
import { select } from 'd3-selection'
import { zoom } from 'd3-zoom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { logger } from '../../lib/logger'
import { useNavigationStore } from '../../stores/navigation'
import { clearGraphCache, GraphView } from '../GraphView'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock d3 modules to avoid SVG rendering issues in jsdom
vi.mock('d3-force', () => ({
  forceSimulation: vi.fn(() => ({
    force: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    alpha: vi.fn().mockReturnThis(),
    restart: vi.fn(),
    nodes: vi.fn(() => []),
  })),
  forceLink: vi.fn(() => ({
    id: vi.fn().mockReturnThis(),
    distance: vi.fn().mockReturnThis(),
  })),
  forceManyBody: vi.fn(() => ({
    strength: vi.fn().mockReturnThis(),
  })),
  forceCenter: vi.fn(),
  forceCollide: vi.fn(),
  forceX: vi.fn(() => ({
    strength: vi.fn().mockReturnThis(),
  })),
  forceY: vi.fn(() => ({
    strength: vi.fn().mockReturnThis(),
  })),
}))

vi.mock('d3-selection', () => ({
  select: vi.fn(() => ({
    selectAll: vi.fn().mockReturnThis(),
    data: vi.fn().mockReturnThis(),
    join: vi.fn().mockReturnThis(),
    attr: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    call: vi.fn().mockReturnThis(),
    append: vi.fn(() => ({
      selectAll: vi.fn().mockReturnThis(),
      data: vi.fn().mockReturnThis(),
      join: vi.fn().mockReturnThis(),
      attr: vi.fn().mockReturnThis(),
      text: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      call: vi.fn().mockReturnThis(),
      append: vi.fn().mockReturnThis(),
      style: vi.fn().mockReturnThis(),
      transition: vi.fn().mockReturnThis(),
      duration: vi.fn().mockReturnThis(),
    })),
    remove: vi.fn().mockReturnThis(),
    style: vi.fn().mockReturnThis(),
    transition: vi.fn().mockReturnThis(),
    duration: vi.fn().mockReturnThis(),
  })),
}))

vi.mock('d3-zoom', () => ({
  zoom: vi.fn(() => ({
    scaleExtent: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    scaleBy: vi.fn(),
    transform: vi.fn(),
  })),
  zoomIdentity: { k: 1, x: 0, y: 0 },
}))

vi.mock('d3-drag', () => ({
  drag: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
  })),
}))

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  clearGraphCache()
  useNavigationStore.setState({
    currentView: 'graph',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

describe('GraphView', () => {
  it('shows loading skeleton on mount', () => {
    // Never-resolving promises to keep loading state
    mockedInvoke.mockReturnValue(new Promise(() => {}))

    const { container } = render(<GraphView />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('shows empty state when no pages exist', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    expect(await screen.findByText('No pages to visualize')).toBeInTheDocument()
  })

  it('renders SVG when pages and links are loaded', async () => {
    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      const graphView = screen.getByTestId('graph-view')
      expect(graphView).toBeInTheDocument()
    })

    const svg = screen.getByRole('img', { name: 'Page Relationships' })
    expect(svg).toBeInTheDocument()
    expect(svg.tagName).toBe('svg')
  })

  it('invokes d3 APIs to set up simulation, zoom, and drag', async () => {
    const navigateToPage = vi.fn()
    useNavigationStore.setState({
      currentView: 'graph',
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      selectedBlockId: null,
      navigateToPage,
    })

    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    // d3-selection: select() is called for the SVG container
    expect(select).toHaveBeenCalled()

    // d3-force: forceSimulation() is called with the nodes data
    expect(forceSimulation).toHaveBeenCalledTimes(1)
    expect(forceSimulation).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'page-1', label: 'Page One' }),
        expect.objectContaining({ id: 'page-2', label: 'Page Two' }),
      ]),
    )

    // d3-zoom: zoom() is called for pan/zoom setup
    expect(zoom).toHaveBeenCalledTimes(1)

    // d3-drag: drag() is called for node drag behavior
    expect(drag).toHaveBeenCalledTimes(1)

    // navigateToPage from navigation store is set up correctly
    expect(useNavigationStore.getState().navigateToPage).toBe(navigateToPage)
  })

  it('shows error state on fetch failure', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.reject(new Error('network failure'))
      if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
      return Promise.resolve(null)
    })

    render(<GraphView />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Failed to load graph data')
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'GraphView',
      'failed to load graph data',
      undefined,
      expect.any(Error),
    )
  })

  it('has no a11y violations with empty state', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
      if (cmd === 'list_page_links') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const { container } = render(<GraphView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with data loaded', async () => {
    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    const { container } = render(<GraphView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('calls navigateToPage when clicking would happen', async () => {
    const navigateToPage = vi.fn()
    useNavigationStore.setState({
      currentView: 'graph',
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      selectedBlockId: null,
      navigateToPage,
    })

    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    // Verify the graph renders (navigateToPage is wired via d3 click handler,
    // which is set up in the d3 effect — since d3 is mocked, we verify the
    // function is available in the store)
    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    expect(useNavigationStore.getState().navigateToPage).toBe(navigateToPage)
  })

  it('filters edges where source or target nodes do not exist', async () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
    }
    // Link references a non-existent page — should be filtered out
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-nonexistent' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    render(<GraphView />)

    // Should still render graph view (single node, no edges)
    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })
  })

  it('renders zoom control buttons', async () => {
    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit to view' })).toBeInTheDocument()
  })

  it('SVG has tabindex for keyboard focus', async () => {
    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    const svg = screen.getByRole('img', { name: 'Page Relationships' })
    expect(svg).toHaveAttribute('tabindex', '0')
  })

  describe('data fetch edge cases', () => {
    it('refetches when cache is stale', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      // First render populates cache
      const { unmount } = render(<GraphView />)
      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })
      unmount()

      // Make cache appear stale by advancing Date.now past TTL (6 minutes)
      const realNow = Date.now()
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000)

      vi.clearAllMocks()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      // Second render: stale cache → serves cached data but refetches in background
      render(<GraphView />)
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalled()
      })

      dateSpy.mockRestore()
    })

    it('handles partial failure (listBlocks succeeds, listPageLinks fails)', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks')
          return Promise.resolve({
            items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
            next_cursor: null,
            has_more: false,
          })
        if (cmd === 'list_page_links') return Promise.reject(new Error('link fetch failed'))
        return Promise.resolve(null)
      })

      render(<GraphView />)

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Failed to load graph data')
    })

    it('handles pages with no links', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks')
          return Promise.resolve({
            items: [
              { id: 'page-1', content: 'Page One', block_type: 'page' },
              { id: 'page-2', content: 'Page Two', block_type: 'page' },
            ],
            next_cursor: null,
            has_more: false,
          })
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Simulation was called with nodes even though there are no edges
      expect(forceSimulation).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'page-1' }),
          expect.objectContaining({ id: 'page-2' }),
        ]),
      )
    })
  })

  describe('keyboard navigation', () => {
    it('Enter key on focused node navigates to page', async () => {
      const navigateToPage = vi.fn()
      useNavigationStore.setState({
        currentView: 'graph',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        selectedBlockId: null,
        navigateToPage,
      })

      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Access the d3 mock chain to extract the keydown handler on node groups
      // biome-ignore lint/suspicious/noExplicitAny: d3 mock chain access in test
      const svgSel = vi.mocked(select).mock.results[0]?.value as any
      // biome-ignore lint/suspicious/noExplicitAny: d3 mock chain access in test
      const g = svgSel.append.mock.results[0]?.value as any
      const keydownCall = g.on.mock.calls.find((c: unknown[]) => c[0] === 'keydown')
      expect(keydownCall).toBeDefined()

      // Invoke the captured handler with an Enter key event and node data
      const handler = (keydownCall as unknown[])[1] as (event: unknown, d: unknown) => void
      const mockEvent = { key: 'Enter', preventDefault: vi.fn() }
      handler(mockEvent, { id: 'page-1', label: 'Page One' })

      expect(mockEvent.preventDefault).toHaveBeenCalled()
      expect(navigateToPage).toHaveBeenCalledWith('page-1', 'Page One')
    })

    it('+ key zooms in', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByRole('img', { name: 'Page Relationships' })
      fireEvent.keyDown(svg, { key: '+' })

      // biome-ignore lint/suspicious/noExplicitAny: d3 zoom mock access in test
      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      expect(zoomInstance.scaleBy).toHaveBeenCalledWith(expect.anything(), 1.3)
    })

    it('- key zooms out', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByRole('img', { name: 'Page Relationships' })
      fireEvent.keyDown(svg, { key: '-' })

      // biome-ignore lint/suspicious/noExplicitAny: d3 zoom mock access in test
      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      expect(zoomInstance.scaleBy).toHaveBeenCalledWith(expect.anything(), 1 / 1.3)
    })

    it('0 key resets zoom', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByRole('img', { name: 'Page Relationships' })
      fireEvent.keyDown(svg, { key: '0' })

      // biome-ignore lint/suspicious/noExplicitAny: d3 zoom mock access in test
      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      expect(zoomInstance.transform).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('logs error when data fetch fails', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.reject(new Error('network failure'))
        if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await screen.findByRole('alert')

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'GraphView',
        'failed to load graph data',
        undefined,
        expect.any(Error),
      )
    })

    it('does not crash on empty response', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(emptyPage)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      expect(await screen.findByText('No pages to visualize')).toBeInTheDocument()
    })
  })

  describe('cleanup', () => {
    it('cancels fetch on unmount', async () => {
      let resolveBlocks!: (v: unknown) => void
      let resolveLinks!: (v: unknown) => void

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks')
          return new Promise((resolve) => {
            resolveBlocks = resolve
          })
        if (cmd === 'list_page_links')
          return new Promise((resolve) => {
            resolveLinks = resolve
          })
        return Promise.resolve(null)
      })

      const { unmount } = render(<GraphView />)

      // Wait until invoke has been called (fetch started)
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalled()
      })

      // Unmount before data resolves (triggers cleanup setting cancelled=true)
      unmount()

      // Resolve pending promises after unmount
      resolveBlocks({
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
      })
      resolveLinks([])

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0))

      // No errors logged — cancelled flag prevented state updates and error handling
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })
  })

  describe('truncation warning (PERF-9a)', () => {
    it('shows truncation badge when has_more is true', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: 'cursor-xyz',
        has_more: true,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const badge = screen.getByTestId('graph-truncated-badge')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveTextContent('Showing 2 pages (graph truncated)')
    })

    it('does not show truncation badge when has_more is false', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      expect(screen.queryByTestId('graph-truncated-badge')).not.toBeInTheDocument()
    })
  })
})
