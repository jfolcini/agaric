/**
 * Tests for GraphView local-graph mode (#1429).
 *
 * Validates the "focus on this page" toggle:
 *  - The toggle renders and is disabled when no page is open.
 *  - Enabling it filters the graph to the current page's N-hop neighborhood,
 *    using the data the global graph already fetched (client-side filter; no
 *    extra IPC).
 *  - A page with no links shows just the seed node.
 *  - No a11y violations with the control present.
 *
 * `useGraphSimulation` is mocked so the test can capture the exact node/edge
 * set GraphView hands to the renderer — that captured set IS the local graph.
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { clearGraphCache, GraphView } from '@/components/graph/GraphView'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Capture the node/edge set GraphView passes to the simulation. This is the
// observable output of the local-graph filtering.
let captured: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] }
vi.mock('@/hooks/useGraphSimulation', () => ({
  useGraphSimulation: (args: { nodes: GraphNode[]; edges: GraphEdge[] }) => {
    captured = { nodes: args.nodes, edges: args.edges }
    return { zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn() }
  },
}))

const mockedInvoke = vi.mocked(invoke)

// Chain: hub — a — b — c.  hub also links `solo`-free; `island` is isolated.
//   hub → a, a → b, b → c, hub → island? no — island has no links.
const PAGES = [
  { id: 'hub', content: 'Hub', block_type: 'page' },
  { id: 'a', content: 'Alpha', block_type: 'page' },
  { id: 'b', content: 'Bravo', block_type: 'page' },
  { id: 'c', content: 'Charlie', block_type: 'page' },
  { id: 'island', content: 'Island', block_type: 'page' },
]
const LINKS = [
  { source_id: 'hub', target_id: 'a' },
  { source_id: 'a', target_id: 'b' },
  { source_id: 'b', target_id: 'c' },
]

function seedTab(pageId: string | null): void {
  useTabsStore.setState({
    tabs: [
      {
        id: '0',
        pageStack: pageId ? [{ pageId, title: pageId }] : [],
        label: '',
      },
    ],
    activeTabIndex: 0,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearGraphCache()
  captured = { nodes: [], edges: [] }
  useSpaceStore.setState({ currentSpaceId: null })
  useNavigationStore.setState({ currentView: 'graph', selectedBlockId: null })
  seedTab('hub')
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_all_pages_in_space') return Promise.resolve(PAGES)
    if (cmd === 'list_page_links') return Promise.resolve(LINKS)
    if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
    return Promise.resolve(null)
  })
})

afterEach(() => {
  seedTab(null)
})

async function renderGraph() {
  render(<GraphView />)
  await waitFor(() => expect(screen.getByTestId('graph-view')).toBeInTheDocument())
}

describe('GraphView local-graph mode (#1429)', () => {
  it('renders the focus toggle and defaults to the global graph (all nodes)', async () => {
    await renderGraph()
    expect(screen.getByTestId('local-graph-toggle')).toBeInTheDocument()
    // Default: every page is shown (no local filtering until toggled).
    expect(captured.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'hub', 'island'])
  })

  it('disables the toggle when the active tab has no page open', async () => {
    seedTab(null)
    await renderGraph()
    expect(screen.getByTestId('local-graph-toggle')).toBeDisabled()
  })

  it('filters to the 2-hop neighborhood of the current page when activated', async () => {
    await renderGraph()
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    // hub(0) → a(1) → b(2); c is 3 hops, island is unrelated → both excluded.
    await waitFor(() => expect(captured.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'hub']))
    const edgeKeys = captured.edges.map((e) => `${e.source as string}-${e.target as string}`).sort()
    expect(edgeKeys).toEqual(['a-b', 'hub-a'])
  })

  it('narrows to the 1-hop neighborhood via the hop control', async () => {
    await renderGraph()
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    fireEvent.click(screen.getByRole('radio', { name: '1 hop' }))
    // hub(0) → a(1); b is 2 hops → excluded.
    await waitFor(() => expect(captured.nodes.map((n) => n.id).sort()).toEqual(['a', 'hub']))
  })

  it('shows just the seed node for a page with no links', async () => {
    seedTab('island')
    await renderGraph()
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    await waitFor(() => expect(captured.nodes.map((n) => n.id)).toEqual(['island']))
    expect(captured.edges).toEqual([])
    // Seed-only renders gracefully (no "no matches" overlay).
    expect(screen.queryByTestId('graph-no-matches')).not.toBeInTheDocument()
  })

  it('restores the full graph when focus mode is turned off', async () => {
    await renderGraph()
    const toggle = screen.getByTestId('local-graph-toggle')
    fireEvent.click(toggle)
    await waitFor(() => expect(captured.nodes.length).toBe(3))
    fireEvent.click(toggle)
    await waitFor(() => expect(captured.nodes.length).toBe(5))
  })

  it('does not issue extra IPC calls when entering local mode', async () => {
    await renderGraph()
    const callsBefore = mockedInvoke.mock.calls.length
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    await waitFor(() => expect(captured.nodes.length).toBe(3))
    // Client-side filter only — no new backend query.
    expect(mockedInvoke.mock.calls.length).toBe(callsBefore)
  })

  it('has no a11y violations with the local-graph control present', async () => {
    const { container } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId('graph-view')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
