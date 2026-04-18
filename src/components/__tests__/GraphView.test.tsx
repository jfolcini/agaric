/**
 * Tests for GraphView component (F-33 + PERF-9b).
 *
 * Validates:
 *  - Shows loading skeleton on mount
 *  - Shows empty state when no pages exist
 *  - Renders SVG when pages and links are loaded
 *  - Shows error state on fetch failure
 *  - Has no a11y violations
 *  - Calls navigateToPage from navigation store
 *  - WebWorker is spawned and terminated on cleanup
 *  - Falls back to main-thread simulation when Worker is unavailable
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { drag } from 'd3-drag'
import { forceSimulation } from 'd3-force'
import { select } from 'd3-selection'
import { zoom } from 'd3-zoom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    alphaDecay: vi.fn().mockReturnThis(),
    tick: vi.fn(),
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
      filter: vi.fn().mockReturnThis(),
      datum: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      node: vi.fn().mockReturnValue(null),
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

// Mock the Radix-based Select to render as native <select>/<option> for jsdom compatibility.
vi.mock('@/components/ui/select', () => {
  const React = require('react')
  const Ctx = React.createContext({})

  // biome-ignore lint/suspicious/noExplicitAny: lightweight mock — no real type needed
  function Select({ value, onValueChange, children }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: lightweight mock — no real type needed
  function SelectTrigger({ size, className, ...props }: any) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  // biome-ignore lint/suspicious/noExplicitAny: lightweight mock — no real type needed
  function SelectContent({ children }: any) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        // biome-ignore lint/suspicious/noExplicitAny: lightweight mock — no real type needed
        onChange: (e: any) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        className: tp.className,
        'data-size': tp.size,
        'data-testid': 'graph-tag-select',
      },
      children,
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: lightweight mock — no real type needed
  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

// ── MockWorker for WebWorker tests (PERF-9b) ──────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test mock
type MessageHandler = (event: { data: any }) => void

class MockWorker {
  static instances: MockWorker[] = []
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  postMessageCalls: any[] = []
  terminated = false
  private listeners: Map<string, MessageHandler[]> = new Map()

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  constructor(_url: any, _opts?: any) {
    MockWorker.instances.push(this)
  }

  addEventListener(type: string, handler: MessageHandler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: MessageHandler) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((h) => h !== handler),
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  postMessage(data: any) {
    this.postMessageCalls.push(data)

    // When receiving 'start', immediately respond with 'done' + positions
    if (data.type === 'start') {
      const positions = data.nodes.map((n: { id: string }) => ({
        id: n.id,
        x: 100,
        y: 100,
      }))
      // Deliver asynchronously (like a real worker)
      queueMicrotask(() => {
        if (!this.terminated) {
          this.emit('message', { data: { type: 'done', positions } })
        }
      })
    }
  }

  terminate() {
    this.terminated = true
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  private emit(type: string, event: any) {
    const list = this.listeners.get(type) ?? []
    for (const handler of list) {
      handler(event)
    }
  }
}

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

// Save original Worker so we can restore it
const OriginalWorker = globalThis['Worker'] as typeof Worker | undefined

beforeEach(() => {
  vi.clearAllMocks()
  clearGraphCache()
  MockWorker.instances = []
  // Stub the global Worker with our MockWorker by default
  vi.stubGlobal('Worker', MockWorker)
  useNavigationStore.setState({
    currentView: 'graph',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

afterEach(() => {
  // Restore the original Worker global
  if (OriginalWorker) {
    vi.stubGlobal('Worker', OriginalWorker)
  } else {
    // biome-ignore lint/performance/noDelete: test cleanup requires deleting global
    delete (globalThis as Record<string, unknown>)['Worker']
  }
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

  it('invokes d3 APIs to set up rendering, zoom, and drag (worker path)', async () => {
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

    // Worker path: forceSimulation is NOT called on the main thread
    expect(forceSimulation).not.toHaveBeenCalled()

    // Instead a Worker was spawned and received the start message
    expect(MockWorker.instances).toHaveLength(1)
    const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(worker.postMessageCalls).toContainEqual(
      expect.objectContaining({
        type: 'start',
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'page-1', label: 'Page One' }),
          expect.objectContaining({ id: 'page-2', label: 'Page Two' }),
        ]),
      }),
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
      MockWorker.instances = []
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

      // Worker was spawned and received nodes even though there are no edges
      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      expect(worker.postMessageCalls[0]).toMatchObject({
        type: 'start',
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'page-1' }),
          expect.objectContaining({ id: 'page-2' }),
        ]),
      })
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

    // BUG-18: rebinding graph zoom shortcuts via keyboard-config
    it('rebinding graphZoomIn: new keys fire, old + does not', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ graphZoomIn: 'Ctrl + Shift + Z' }),
      )
      try {
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

        // Old `+` should NOT fire zoom-in after rebinding
        fireEvent.keyDown(svg, { key: '+' })
        // biome-ignore lint/suspicious/noExplicitAny: d3 zoom mock access in test
        const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
        expect(zoomInstance.scaleBy).not.toHaveBeenCalled()

        // New Ctrl+Shift+Z fires zoom-in
        fireEvent.keyDown(svg, { key: 'z', ctrlKey: true, shiftKey: true })
        expect(zoomInstance.scaleBy).toHaveBeenCalledWith(expect.anything(), 1.3)
      } finally {
        localStorage.removeItem('agaric-keyboard-shortcuts')
      }
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
      expect(badge).toHaveTextContent('Showing 2 of many pages')
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

  describe('WebWorker (PERF-9b)', () => {
    it('spawns a Worker and posts start message with graph data', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
      }
      const linksResponse = [{ source_id: 'page-1', target_id: 'page-2', ref_count: 1 }]

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      const startMsg = worker.postMessageCalls.find(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (m: any) => m.type === 'start',
      )
      expect(startMsg).toBeDefined()
      expect(startMsg.nodes).toHaveLength(2)
      expect(startMsg.edges).toHaveLength(1)
      expect(startMsg.width).toBeGreaterThan(0)
      expect(startMsg.height).toBeGreaterThan(0)
    })

    it('terminates the Worker on component unmount', async () => {
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

      const { unmount } = render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      expect(worker.terminated).toBe(false)

      unmount()

      expect(worker.terminated).toBe(true)
    })

    it('falls back to main-thread simulation when Worker is unavailable', async () => {
      // Remove Worker global to simulate SSR / old environment
      // biome-ignore lint/performance/noDelete: test requires deleting global
      delete (globalThis as Record<string, unknown>)['Worker']

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

      // No worker was spawned
      expect(MockWorker.instances).toHaveLength(0)

      // Main-thread forceSimulation was used as fallback
      expect(forceSimulation).toHaveBeenCalledTimes(1)
      expect(forceSimulation).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'page-1', label: 'Page One' }),
          expect.objectContaining({ id: 'page-2', label: 'Page Two' }),
        ]),
      )
    })
  })

  describe('tag filter (PERF-9c)', () => {
    it('renders the tag filter dropdown', async () => {
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
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // The tag filter container is present
      expect(screen.getByTestId('graph-tag-filter')).toBeInTheDocument()
      // The native select (mocked Select) is rendered
      expect(screen.getByTestId('graph-tag-select')).toBeInTheDocument()
    })

    it('re-fetches with tagId when a tag is selected', async () => {
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
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Clear mocks to track new calls
      vi.mocked(invoke).mockClear()
      MockWorker.instances = []

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      // Select a tag
      const selectEl = screen.getByTestId('graph-tag-select')
      fireEvent.change(selectEl, { target: { value: 'tag-1' } })

      await waitFor(() => {
        // Verify listBlocks was called with tagId
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_blocks',
          expect.objectContaining({
            tagId: 'tag-1',
            blockType: null,
          }),
        )
      })
    })

    it('returns to all pages when filter is cleared', async () => {
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
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Select a tag first
      fireEvent.change(screen.getByTestId('graph-tag-select'), { target: { value: 'tag-1' } })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_blocks',
          expect.objectContaining({
            tagId: 'tag-1',
          }),
        )
      })

      // Wait for loading to finish and graph-view to re-appear
      await waitFor(() => {
        expect(screen.getByTestId('graph-tag-select')).toBeInTheDocument()
      })

      // Clear mocks
      vi.mocked(invoke).mockClear()
      MockWorker.instances = []
      // Clear graph cache so the __none__ key is not still fresh
      clearGraphCache()

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(pagesResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        return Promise.resolve(null)
      })

      // Re-query the select element (the old one was unmounted during loading)
      fireEvent.change(screen.getByTestId('graph-tag-select'), { target: { value: '__none__' } })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_blocks',
          expect.objectContaining({
            blockType: 'page',
            tagId: null,
          }),
        )
      })
    })

    it('filters tag results to only pages', async () => {
      // When filtering by tag, the API may return mixed block types
      const mixedResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'block-1', content: 'A heading block', block_type: 'heading' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
          { id: 'block-2', content: 'Some text', block_type: 'text' },
        ],
        next_cursor: null,
        has_more: false,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_blocks') return Promise.resolve(mixedResponse)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Select a tag to trigger filtered fetch
      const selectEl = screen.getByTestId('graph-tag-select')
      fireEvent.change(selectEl, { target: { value: 'tag-1' } })

      await waitFor(() => {
        // Verify the worker received only page nodes (non-page blocks filtered out)
        const latestWorker = MockWorker.instances[MockWorker.instances.length - 1] as InstanceType<
          typeof MockWorker
        >
        const startMsg = latestWorker?.postMessageCalls.find(
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          (m: any) => m.type === 'start',
        )
        expect(startMsg).toBeDefined()
        // Only 2 page nodes, not the heading or text blocks
        expect(startMsg.nodes).toHaveLength(2)
        expect(startMsg.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'page-1', label: 'Page One' }),
            expect.objectContaining({ id: 'page-2', label: 'Page Two' }),
          ]),
        )
      })
    })
  })
})
