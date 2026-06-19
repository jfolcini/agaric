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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { drag } from 'd3-drag'
import { forceSimulation } from 'd3-force'
import { select } from 'd3-selection'
import { zoom } from 'd3-zoom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  clearGraphCache,
  getGraphCacheEntry,
  GRAPH_CACHE_MAX_ENTRIES,
  GraphView,
  setGraphCacheEntry,
} from '@/components/graph/GraphView'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// BUG #746: a controllable mock of `applyGraphFilters` so a test can force
// the "filtered to zero" case deterministically without driving the full
// filter-popover UI. Defaults to the real implementation (pass-through), so
// every other test is unaffected; the #746 test flips `forceEmptyFilter`.
let forceEmptyFilter = false
vi.mock('@/lib/graph-filters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph-filters')>()
  return {
    ...actual,
    applyGraphFilters: (nodes: unknown[], filters: unknown) =>
      forceEmptyFilter ? [] : actual.applyGraphFilters(nodes as never, filters as never),
  }
})

// #1530: mock useBlockPropertyEvents so a test can drive `invalidationKey`.
// The mutable `mockInvalidationKey` lets a test bump the key and re-render to
// simulate a block/link mutation event firing. Defaults to 0 so unrelated
// tests behave as if no mutation has occurred.
let mockInvalidationKey = 0
vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: () => ({ invalidationKey: mockInvalidationKey }),
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
    // #1725 — applyRovingTabindex calls `selection.nodes()`.
    nodes: vi.fn(() => []),
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
      // #1725 — applyRovingTabindex calls `selection.nodes()`.
      nodes: vi.fn(() => []),
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

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx). Tests query the rendered native
// <select> by its aria-label ("Filter by tag"), which the trigger forwards.

// ── MockWorker for WebWorker tests (PERF-9b) ──────────────────────────

type MessageHandler = (event: { data: any }) => void

class MockWorker {
  static instances: MockWorker[] = []
  postMessageCalls: any[] = []
  terminated = false
  private listeners: Map<string, MessageHandler[]> = new Map()

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

  simulateError(type: 'error' | 'messageerror', event: any) {
    this.emit(type, event)
  }

  private emit(type: string, event: any) {
    const list = this.listeners.get(type) ?? []
    for (const handler of list) {
      handler(event)
    }
  }
}

const mockedInvoke = vi.mocked(invoke)

// Save original Worker so we can restore it
const OriginalWorker = globalThis['Worker'] as typeof Worker | undefined

beforeEach(() => {
  vi.clearAllMocks()
  clearGraphCache()
  forceEmptyFilter = false
  mockInvalidationKey = 0
  MockWorker.instances = []
  // Stub the global Worker with our MockWorker by default
  vi.stubGlobal('Worker', MockWorker)
  useNavigationStore.setState({
    currentView: 'graph',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
})

afterEach(() => {
  // Restore the original Worker global
  if (OriginalWorker) {
    vi.stubGlobal('Worker', OriginalWorker)
  } else {
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
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      total_count: null,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      const graphView = screen.getByTestId('graph-view')
      expect(graphView).toBeInTheDocument()
    })

    // UX-270: SVG no longer has role="img"; query by data-testid instead.
    const svg = screen.getByTestId('graph-svg')
    expect(svg).toBeInTheDocument()
    expect(svg.tagName).toBe('svg')
    expect(svg).toHaveAttribute('aria-label', 'Page Relationships')
    expect(svg).not.toHaveAttribute('role')
  })

  it('invokes d3 APIs to set up rendering, zoom, and drag (worker path)', async () => {
    const navigateToPage = vi.fn()
    useNavigationStore.setState({
      currentView: 'graph',
      selectedBlockId: null,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      navigateToPage,
    })

    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    // d3-selection: select() is called for the SVG container
    expect(select).toHaveBeenCalledWith(expect.any(Element))

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
    expect(useTabsStore.getState().navigateToPage).toBe(navigateToPage)
  })

  it('shows error state on fetch failure', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.reject(new Error('network failure'))
      if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    // PEND-23 M9: error is now rendered via the shared EmptyState primitive
    // (h2 heading), not a `role="alert"` div. Query by the localized message
    // to confirm the branch is taken.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Failed to load graph data' }),
    ).toBeInTheDocument()
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'GraphView',
      'failed to load graph data',
      undefined,
      expect.any(Error),
    )
  })

  // PEND-23 M9 regression: when the IPC fetch rejects, the EmptyState
  // primitive should render with the localized error message and the graph
  // SVG should NOT be in the DOM (the error branch returns early).
  it('renders the EmptyState fallback (not the SVG) on fetch failure', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.reject(new Error('network failure'))
      if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    // EmptyState renders an <h2> with the message — assert it's the
    // localized `graph.loadFailed` string.
    expect(
      await screen.findByRole('heading', { level: 2, name: t('graph.loadFailed') }),
    ).toBeInTheDocument()

    // The graph chrome (SVG, filter bar, zoom buttons) must NOT render.
    expect(screen.queryByTestId('graph-svg')).not.toBeInTheDocument()
    expect(screen.queryByTestId('graph-view')).not.toBeInTheDocument()
  })

  it('has no a11y violations with empty state', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      total_count: null,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      selectedBlockId: null,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      navigateToPage,
    })

    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    // Verify the graph renders (navigateToPage is wired via d3 click handler,
    // which is set up in the d3 effect — since d3 is mocked, we verify the
    // function is available in the store)
    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    expect(useTabsStore.getState().navigateToPage).toBe(navigateToPage)
  })

  it('filters edges where source or target nodes do not exist', async () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    // Link references a non-existent page — should be filtered out
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-nonexistent' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      total_count: null,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: /Zoom in/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Zoom out/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fit to view/ })).toBeInTheDocument()
  })

  // UX-356: zoom buttons must surface their keyboard shortcut binding via
  // the accessible name so users know the hotkey without opening settings.
  describe('zoom button shortcut bindings (UX-356)', () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    function mockGraphData() {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })
    }

    it('zoom-in button accessible name contains the shortcut binding', async () => {
      mockGraphData()
      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const button = screen.getByRole('button', { name: /Zoom in/ })
      expect(button).toHaveAccessibleName(`${t('graph.zoomIn')} (+ / =)`)
    })

    it('zoom-out button accessible name contains the shortcut binding', async () => {
      mockGraphData()
      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const button = screen.getByRole('button', { name: /Zoom out/ })
      expect(button).toHaveAccessibleName(`${t('graph.zoomOut')} (-)`)
    })

    it('reset (fit-to-view) button accessible name contains the shortcut binding', async () => {
      mockGraphData()
      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const button = screen.getByRole('button', { name: /Fit to view/ })
      expect(button).toHaveAccessibleName(`${t('graph.zoomReset')} (0)`)
    })

    it('respects user-customised binding via getShortcutKeys', async () => {
      localStorage.setItem(
        'agaric-keyboard-shortcuts',
        JSON.stringify({ graphZoomIn: 'Ctrl + Shift + Z' }),
      )
      try {
        mockGraphData()
        render(<GraphView />)

        await waitFor(() => {
          expect(screen.getByTestId('graph-view')).toBeInTheDocument()
        })

        const button = screen.getByRole('button', { name: /Zoom in/ })
        expect(button).toHaveAccessibleName(`${t('graph.zoomIn')} (Ctrl + Shift + Z)`)
      } finally {
        localStorage.removeItem('agaric-keyboard-shortcuts')
      }
    })
  })

  it('SVG has tabindex for keyboard focus', async () => {
    const pagesResponse = {
      items: [
        { id: 'page-1', content: 'Page One', block_type: 'page' },
        { id: 'page-2', content: 'Page Two', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    const linksResponse = [{ source_id: 'page-1', target_id: 'page-2' }]

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    const svg = screen.getByTestId('graph-svg')
    expect(svg).toHaveAttribute('tabindex', '0')
  })

  // UX-244: bare `h-full` on an inline SVG does not resolve against a
  // block-level flex-item parent in Chromium — it falls back to the SVG's
  // 150 px intrinsic height, which left graph nodes clustered in the top
  // 150 px of a much taller container. `absolute inset-0` positions the
  // SVG inside the `.graph-view` (relative) ancestor so it fills the full
  // available height regardless of the percentage-height resolution quirk.
  // Class-list regression — do not weaken.
  // UX-270: dropping `role="img"` from the SVG. The graph's nodes are
  // interactive (`role="button"` + Enter/Space activation in
  // useGraphSimulation), and `role="img"` on a container of interactive
  // elements is incorrect — ATs treat the whole region as one opaque
  // graphic. The accessible name remains via `aria-label`, but no wrapper
  // role is set so the descendants surface naturally.
  it('SVG has no wrapper role (UX-270 — interactive descendants)', async () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    const svg = screen.getByTestId('graph-svg')
    expect(svg).not.toHaveAttribute('role')
    expect(svg).toHaveAttribute('aria-label', 'Page Relationships')
  })

  // UX-355: keyboard users must discover that graph nodes are activatable.
  // The SVG's `aria-describedby` pairs with a visually-hidden hint paragraph
  // so ATs surface "Tab → Enter/Space" alongside the accessible name.
  it('SVG is described by the visually-hidden keyboard hint (UX-355)', async () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    const svg = screen.getByTestId('graph-svg')
    expect(svg).toHaveAttribute('aria-describedby', 'graph-keyboard-hint')

    const hint = document.getElementById('graph-keyboard-hint')
    expect(hint).not.toBeNull()
    expect(hint?.tagName).toBe('P')
    expect(hint).toHaveClass('sr-only')
    expect(hint).toHaveTextContent(t('graph.keyboardHint'))
  })

  it('SVG is absolutely positioned to fill the relative parent (UX-244)', async () => {
    const pagesResponse = {
      items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
      if (cmd === 'list_page_links') return Promise.resolve([])
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(<GraphView />)

    await waitFor(() => {
      expect(screen.getByTestId('graph-view')).toBeInTheDocument()
    })

    const container = screen.getByTestId('graph-view')
    expect(container).toHaveClass('relative')

    const svg = screen.getByTestId('graph-svg')
    expect(svg).toHaveClass('absolute')
    expect(svg).toHaveClass('inset-0')
    expect(svg).toHaveClass('h-full')
    expect(svg).toHaveClass('w-full')
  })

  describe('data fetch edge cases', () => {
    it('refetches when cache is stale', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      // Second render: stale cache → serves cached data but refetches in background
      render(<GraphView />)
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_all_pages_in_space',
          expect.objectContaining({ spaceId: expect.any(String) }),
        )
      })

      dateSpy.mockRestore()
    })

    // #1530: a block/link mutation bumps `invalidationKey`. The graph must
    // refetch (stale-while-revalidate) even though the cache is still fresh
    // — and conversely a remount within the TTL with NO bump must NOT refetch
    // (the existing TTL behavior is preserved).
    //
    // Without the `mutated` bypass in GraphView, the bumped-key re-render would
    // still hit the "fresh cache → return" early-exit and `fetchGraphData`
    // (here observed via the `list_all_pages_in_space` invoke) would be called
    // exactly once total — so the post-bump assertion (>= 2 calls) would fail.
    it('refetches on invalidationKey bump but not on a fresh remount (#1530)', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      const fetchCalls = () =>
        mockedInvoke.mock.calls.filter((c) => c[0] === 'list_all_pages_in_space').length

      // Initial render → exactly one fetch, cache populated (fresh).
      const first = render(<GraphView />)
      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })
      await waitFor(() => {
        expect(fetchCalls()).toBe(1)
      })

      // A fresh remount within the TTL with NO mutation must NOT refetch —
      // the existing cache/TTL behavior still holds. Unmount + remount the
      // same component; the module-level cache survives across mounts.
      // NOTE: this also characterises the KNOWN residual in #1818 — because
      // `invalidationKey` is per-instance and resets to 0 on remount, a
      // mutation that occurred while the graph was unmounted is NOT detected
      // here, so the stale entry is served until the TTL expires. Fixing that
      // needs module-level invalidation (#1818); this assertion documents the
      // current TTL-bounded behavior, not a resolution of that case.
      first.unmount()
      const { rerender } = render(<GraphView />)
      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })
      // Give any (incorrect) background fetch a chance to fire.
      await act(async () => {
        await Promise.resolve()
      })
      expect(fetchCalls()).toBe(1)

      // Now simulate a block/link mutation: bump invalidationKey and re-render
      // the mounted instance. Even though the cache is fresh, the graph must
      // refetch (stale-while-revalidate).
      mockInvalidationKey = 1
      await act(async () => {
        rerender(<GraphView />)
      })
      await waitFor(() => {
        expect(fetchCalls()).toBeGreaterThanOrEqual(2)
      })
    })

    it('handles partial failure (listBlocks succeeds, listPageLinks fails)', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return Promise.resolve([{ id: 'page-1', content: 'Page One', block_type: 'page' }])
        if (cmd === 'list_page_links') return Promise.reject(new Error('link fetch failed'))
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      // PEND-23 M9: error renders via the EmptyState primitive (h2), not
      // a `role="alert"` div.
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Failed to load graph data' }),
      ).toBeInTheDocument()
    })

    it('handles pages with no links', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return Promise.resolve([
            { id: 'page-1', content: 'Page One', block_type: 'page' },
            { id: 'page-2', content: 'Page Two', block_type: 'page' },
          ])
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
        selectedBlockId: null,
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        navigateToPage,
      })

      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Access the d3 mock chain to extract the keydown handler on node groups
      const svgSel = vi.mocked(select).mock.results[0]?.value as any
      const g = svgSel.append.mock.results[0]?.value as any
      const keydownCall = g.on.mock.calls.find((c: unknown[]) => c[0] === 'keydown')
      expect(keydownCall).toBeDefined()

      // Invoke the captured handler with an Enter key event and node data
      const handler = (keydownCall as unknown[])[1] as (event: unknown, d: unknown) => void
      const mockEvent = { key: 'Enter', preventDefault: vi.fn() }
      handler(mockEvent, { id: 'page-1', label: 'Page One' })

      expect(mockEvent.preventDefault).toHaveBeenCalled() // no-args by contract
      expect(navigateToPage).toHaveBeenCalledWith('page-1', 'Page One')
    })

    it('+ key zooms in', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByTestId('graph-svg')
      fireEvent.keyDown(svg, { key: '+' })

      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      expect(zoomInstance.scaleBy).toHaveBeenCalledWith(expect.anything(), 1.3)
    })

    it('- key zooms out', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByTestId('graph-svg')
      fireEvent.keyDown(svg, { key: '-' })

      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      expect(zoomInstance.scaleBy).toHaveBeenCalledWith(expect.anything(), 1 / 1.3)
    })

    it('0 key resets zoom', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const svg = screen.getByTestId('graph-svg')
      fireEvent.keyDown(svg, { key: '0' })

      const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
      // Production calls zoomBehavior.transform(svgSelection.transition()..., zoomIdentity).
      // zoomIdentity is mocked as { k: 1, x: 0, y: 0 } at module top.
      expect(zoomInstance.transform).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ k: 1, x: 0, y: 0 }),
      )
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
          total_count: null,
        }

        mockedInvoke.mockImplementation((cmd: string) => {
          if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
          if (cmd === 'list_page_links') return Promise.resolve([])
          if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
          return Promise.resolve(null)
        })

        render(<GraphView />)

        await waitFor(() => {
          expect(screen.getByTestId('graph-view')).toBeInTheDocument()
        })

        const svg = screen.getByTestId('graph-svg')

        // Old `+` should NOT fire zoom-in after rebinding
        fireEvent.keyDown(svg, { key: '+' })
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
        if (cmd === 'list_all_pages_in_space') return Promise.reject(new Error('network failure'))
        if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      // PEND-23 M9: wait for the EmptyState heading (h2) so we know the
      // error branch has been taken before asserting on logger.
      await screen.findByRole('heading', { level: 2, name: 'Failed to load graph data' })

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'GraphView',
        'failed to load graph data',
        undefined,
        expect.any(Error),
      )
    })

    it('does not crash on empty response', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve([])
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      expect(await screen.findByText('No pages to visualize')).toBeInTheDocument()
    })

    it('clears a stale error once a later refetch succeeds (sticky-error regression)', async () => {
      // First load fails → the error EmptyState is shown.
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.reject(new Error('network failure'))
        if (cmd === 'list_page_links') return Promise.reject(new Error('network failure'))
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      const prevSpaceId = useSpaceStore.getState().currentSpaceId
      try {
        render(<GraphView />)
        await screen.findByRole('heading', { level: 2, name: 'Failed to load graph data' })

        // A subsequent fetch (triggered by a space switch) succeeds.
        mockedInvoke.mockImplementation((cmd: string) => {
          if (cmd === 'list_all_pages_in_space')
            return Promise.resolve([{ id: 'page-1', content: 'Page One', block_type: 'page' }])
          if (cmd === 'list_page_links') return Promise.resolve([])
          if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
          return Promise.resolve(null)
        })
        await act(async () => {
          useSpaceStore.setState({ currentSpaceId: 'SPACE_RECOVER' })
        })

        // The graph renders and the stale "failed to load" screen is gone.
        await waitFor(() => {
          expect(screen.getByTestId('graph-view')).toBeInTheDocument()
        })
        expect(
          screen.queryByRole('heading', { level: 2, name: 'Failed to load graph data' }),
        ).not.toBeInTheDocument()
      } finally {
        act(() => {
          useSpaceStore.setState({ currentSpaceId: prevSpaceId })
        })
      }
    })
  })

  describe('cleanup', () => {
    it('cancels fetch on unmount', async () => {
      let resolveBlocks!: (v: unknown) => void
      let resolveLinks!: (v: unknown) => void

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return new Promise((resolve) => {
            resolveBlocks = resolve
          })
        if (cmd === 'list_page_links')
          return new Promise((resolve) => {
            resolveLinks = resolve
          })
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      const { unmount } = render(<GraphView />)

      // Wait until invoke has been called (fetch started)
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_all_pages_in_space',
          expect.objectContaining({ spaceId: expect.any(String) }),
        )
      })

      // Unmount before data resolves (triggers cleanup setting cancelled=true)
      unmount()

      // Resolve pending promises after unmount and let the cancellation
      // microtask chain settle inside an `act(async)` boundary, instead
      // of a bare 0 ms `setTimeout` flush which AGENTS.md flags as a
      // wall-clock wait that "the test cannot tell broken from slow"
      // (TEST-FE-1).
      await act(async () => {
        resolveBlocks({
          items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
          next_cursor: null,
          has_more: false,
          total_count: null,
        })
        resolveLinks([])
      })

      // No errors logged — cancelled flag prevented state updates and error handling
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
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
        total_count: null,
      }
      const linksResponse = [{ source_id: 'page-1', target_id: 'page-2', ref_count: 1 }]

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve(linksResponse)
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      const startMsg = worker.postMessageCalls.find((m: any) => m.type === 'start')
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
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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
      delete (globalThis as Record<string, unknown>)['Worker']

      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
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

  // BUG-45 regression — worker runtime failure must recover via main-thread fallback
  describe('WebWorker runtime failure (BUG-45)', () => {
    it('falls back to main-thread simulation when worker dispatches error event', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Worker was spawned initially
      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      expect(worker.terminated).toBe(false)

      // Main-thread simulation has NOT yet been used
      expect(forceSimulation).not.toHaveBeenCalled()

      // Simulate a runtime worker error (e.g. module-load failure inside worker).
      const fakeError = new Error('boom')
      worker.simulateError('error', {
        type: 'error',
        error: fakeError,
        message: 'boom',
      })

      // Worker was terminated and a warn was logged
      await waitFor(() => {
        expect(worker.terminated).toBe(true)
      })
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'GraphView',
        'worker failed',
        expect.objectContaining({ event: 'error' }),
        fakeError,
      )

      // Main-thread fallback kicks in — forceSimulation gets invoked on rerun
      await waitFor(() => {
        expect(forceSimulation).toHaveBeenCalledWith(expect.any(Array))
      })
      expect(forceSimulation).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'page-1', label: 'Page One' }),
          expect.objectContaining({ id: 'page-2', label: 'Page Two' }),
        ]),
      )
    })

    it('falls back when worker dispatches messageerror event', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      expect(MockWorker.instances).toHaveLength(1)
      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>

      // A messageerror (e.g. non-cloneable response) should trigger fallback too.
      worker.simulateError('messageerror', { type: 'messageerror' })

      await waitFor(() => {
        expect(worker.terminated).toBe(true)
      })
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'GraphView',
        'worker failed',
        expect.objectContaining({ event: 'messageerror' }),
        expect.anything(),
      )
      await waitFor(() => {
        expect(forceSimulation).toHaveBeenCalledWith(expect.any(Array))
      })
    })

    it('does not repeat the warn log or respawn the worker after failure', async () => {
      const pagesResponse = {
        items: [{ id: 'page-1', content: 'Page One', block_type: 'page' }],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)
      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
      worker.simulateError('error', { type: 'error', error: new Error('boom'), message: 'boom' })

      // Second error on the same worker must not produce duplicate warns.
      worker.simulateError('error', { type: 'error', error: new Error('boom'), message: 'boom' })

      await waitFor(() => {
        expect(forceSimulation).toHaveBeenCalledWith(expect.any(Array))
      })

      // Exactly one warn for worker failure (deduped).
      const warnCalls = vi.mocked(logger.warn).mock.calls.filter((c) => c[1] === 'worker failed')
      expect(warnCalls).toHaveLength(1)

      // After the effect reruns with workerFailed=true, no new worker is spawned.
      expect(MockWorker.instances).toHaveLength(1)
    })
  })

  describe('tag filter (PERF-9c / UX-205)', () => {
    it('renders the graph filter bar', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // The filter bar container is present and contains the filter bar
      expect(screen.getByTestId('graph-tag-filter')).toBeInTheDocument()
      expect(screen.getByTestId('graph-filter-bar')).toBeInTheDocument()
      // The "Add filter" button is rendered
      expect(screen.getByRole('button', { name: t('graph.filter.addFilter') })).toBeInTheDocument()
    })

    it('loads templates and pages on mount', async () => {
      const pagesResponse = {
        items: [
          { id: 'page-1', content: 'Page One', block_type: 'page' },
          { id: 'page-2', content: 'Page Two', block_type: 'page' },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesResponse.items)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Verify list_template_page_ids_in_space was called
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_template_page_ids_in_space',
        expect.objectContaining({ spaceId: '' }),
      )
      // Verify list_all_pages_in_space was called (no tag filter)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_all_pages_in_space',
        expect.objectContaining({ tagIds: null }),
      )
    })

    it('renders only pages from list_all_pages_in_space (backend already filters)', async () => {
      // The backend filters to `block_type = 'page'` server-side, so the
      // response only contains pages.  The mock returns the post-filter
      // shape: PageHeading rows.
      const pagesItems = [
        { id: 'page-1', content: 'Page One' },
        { id: 'page-2', content: 'Page Two' },
      ]

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space') return Promise.resolve(pagesItems)
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix')
          return Promise.resolve([
            { tag_id: 'tag-1', name: 'Work', usage_count: 5, updated_at: '' },
          ])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })

      // Non-page blocks are filtered out — the worker receives only the 2 pages.
      const latestWorker = MockWorker.instances[MockWorker.instances.length - 1] as InstanceType<
        typeof MockWorker
      >
      const startMsg = latestWorker?.postMessageCalls.find((m: any) => m.type === 'start')
      expect(startMsg).toBeDefined()
    })

    // BUG #746: a filter combination matching nothing previously left the
    // full graph painted with the simulation still running. Now the SVG
    // stays mounted (so the filter bar remains usable) but the empty-state
    // overlay surfaces, and the simulation is torn down by the hook.
    it('shows the no-matches overlay when filters exclude every page (#746)', async () => {
      forceEmptyFilter = true
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return Promise.resolve([
            { id: 'page-1', content: 'Page One' },
            { id: 'page-2', content: 'Page Two' },
          ])
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      // The graph chrome stays mounted (filter bar still usable to widen).
      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })
      // The no-matches overlay is shown with the localized message.
      expect(screen.getByTestId('graph-no-matches')).toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 2, name: t('graph.noMatches') }),
      ).toBeInTheDocument()
    })

    it('does not show the no-matches overlay when pages do match', async () => {
      forceEmptyFilter = false
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return Promise.resolve([{ id: 'page-1', content: 'Page One' }])
        if (cmd === 'list_page_links') return Promise.resolve([])
        if (cmd === 'list_tags_by_prefix') return Promise.resolve([])
        if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
        return Promise.resolve(null)
      })

      render(<GraphView />)

      await waitFor(() => {
        expect(screen.getByTestId('graph-view')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('graph-no-matches')).not.toBeInTheDocument()
    })
  })
})

// ── #758 item 4: graph cache LRU ─────────────────────────────────────
//
// The module-level cache is keyed by every distinct (spaceId, tagIds)
// combination the user tries, so without a bound it accumulated full
// node/edge arrays for the whole session. It is now a small LRU.
describe('graph cache LRU (#758 item 4)', () => {
  function makeEntry(timestamp: number) {
    return { nodes: [], edges: [], timestamp }
  }

  beforeEach(() => {
    clearGraphCache()
  })

  it('returns null for a missing key', () => {
    expect(getGraphCacheEntry('missing')).toBeNull()
  })

  it('stores and returns entries up to the cap', () => {
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES; i++) {
      setGraphCacheEntry(`k${i}`, makeEntry(i))
    }
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES; i++) {
      expect(getGraphCacheEntry(`k${i}`)).toEqual(makeEntry(i))
    }
  })

  it('evicts the least-recently-used entry beyond the cap', () => {
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES + 1; i++) {
      setGraphCacheEntry(`k${i}`, makeEntry(i))
    }
    // Oldest insertion is gone; the newest survives.
    expect(getGraphCacheEntry('k0')).toBeNull()
    expect(getGraphCacheEntry(`k${GRAPH_CACHE_MAX_ENTRIES}`)).toEqual(
      makeEntry(GRAPH_CACHE_MAX_ENTRIES),
    )
  })

  it('a read refreshes recency so the read entry survives the next eviction', () => {
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES; i++) {
      setGraphCacheEntry(`k${i}`, makeEntry(i))
    }
    // Touch the oldest entry, then insert one more (forcing an eviction).
    expect(getGraphCacheEntry('k0')).toEqual(makeEntry(0))
    setGraphCacheEntry('extra', makeEntry(99))

    // k0 was refreshed → k1 is now the LRU and gets evicted instead.
    expect(getGraphCacheEntry('k0')).toEqual(makeEntry(0))
    expect(getGraphCacheEntry('k1')).toBeNull()
    expect(getGraphCacheEntry('extra')).toEqual(makeEntry(99))
  })

  it('overwriting an existing key does not evict anything', () => {
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES; i++) {
      setGraphCacheEntry(`k${i}`, makeEntry(i))
    }
    setGraphCacheEntry('k0', makeEntry(100))
    for (let i = 1; i < GRAPH_CACHE_MAX_ENTRIES; i++) {
      expect(getGraphCacheEntry(`k${i}`)).toEqual(makeEntry(i))
    }
    expect(getGraphCacheEntry('k0')).toEqual(makeEntry(100))
  })
})
