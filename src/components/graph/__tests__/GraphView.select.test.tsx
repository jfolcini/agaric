/**
 * Walking the graph (#5435): a click or Space selects a node, a second click or
 * Enter opens it, a modifier or middle click opens a background tab, and in local mode
 * the selection re-centres the neighbourhood. Real d3 against the DOM; the
 * worker is a recorder whose `update` payload shows which nodes kept their
 * place.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { clearGraphCache, GraphView } from '@/components/graph/GraphView'
import { __resetAnnouncerForTests } from '@/lib/announcer'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import type { WorkerUpdateMessage } from '@/workers/graph-worker-types'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

let mobile = false
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile }))
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => mobile }))

class RecordingWorker {
  static last: RecordingWorker | null = null
  posted: Array<{ type: string }> = []
  private onMessage: ((event: { data: unknown }) => void) | null = null
  constructor() {
    RecordingWorker.last = this
  }
  postMessage(message: { type: string }): void {
    this.posted.push(message)
  }
  addEventListener(type: string, handler: (event: { data: unknown }) => void): void {
    if (type === 'message') this.onMessage = handler
  }
  removeEventListener(): void {}
  terminate(): void {}
  /** The worker settles the nodes it was last given at these points. */
  settle(at: Record<string, [number, number]>): void {
    const points = lastNodes().map((n) => at[n.id] ?? [0, 0])
    this.onMessage?.({
      data: { type: 'done', positions: new Float32Array(points.flat()), count: points.length },
    })
  }
}

function posted(): Array<{ type: string }> {
  return RecordingWorker.last?.posted ?? []
}

function lastNodes(): WorkerUpdateMessage['nodes'] {
  const last = posted().findLast((m) => m.type === 'update' || m.type === 'start')
  return (last as WorkerUpdateMessage | undefined)?.nodes ?? []
}

// hub — a — b — c, and an unlinked island.
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

const navigateToPage = vi.fn()
const openInBackgroundTab = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mobile = false
  clearGraphCache()
  localStorage.clear()
  __resetAnnouncerForTests()
  RecordingWorker.last = null
  vi.stubGlobal('Worker', RecordingWorker)
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  useNavigationStore.setState({ currentView: 'graph', selectedBlockId: null })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: 'hub', title: 'Hub' }], label: 'Hub' }],
    activeTabIndex: 0,
    navigateToPage,
    openInBackgroundTab,
  })
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === 'list_all_pages_in_space') return Promise.resolve(PAGES)
    if (cmd === 'list_page_links')
      return Promise.resolve({ edges: LINKS, total: LINKS.length, truncated: false })
    if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
    if (cmd === 'list_all_tags_in_space') return Promise.resolve([])
    return Promise.resolve(null)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function renderGraph(): Promise<HTMLElement> {
  const { container } = render(<GraphView />)
  await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(5))
  return container
}

const node = (container: HTMLElement, label: string): SVGGElement =>
  container.querySelector(`g.node[aria-label="${label}"]`) as SVGGElement

describe('GraphView — select, then open on purpose (#5435)', () => {
  it('a click selects and announces without navigating or re-running the layout', async () => {
    const container = await renderGraph()

    fireEvent.click(node(container, 'Alpha'))

    expect(navigateToPage).not.toHaveBeenCalled()
    expect(node(container, 'Alpha')).toHaveAttribute('aria-selected', 'true')
    expect(container.querySelectorAll('g.node[aria-selected="true"]')).toHaveLength(1)
    await waitFor(() =>
      expect(document.getElementById('sr-announcer')).toHaveTextContent('Selected "Alpha"'),
    )
    expect(posted().map((m) => m.type)).toEqual(['start'])
  })

  it('a second click on the selected node, or Enter, opens it in place', async () => {
    const container = await renderGraph()

    fireEvent.click(node(container, 'Alpha'))
    fireEvent.click(node(container, 'Alpha'))
    fireEvent.keyDown(node(container, 'Bravo'), { key: 'Enter' })

    expect(navigateToPage.mock.calls).toEqual([
      ['a', 'Alpha'],
      ['b', 'Bravo'],
    ])
    expect(openInBackgroundTab).not.toHaveBeenCalled()
  })

  it('Space selects the focused node', async () => {
    const container = await renderGraph()

    fireEvent.keyDown(node(container, 'Bravo'), { key: ' ' })

    expect(node(container, 'Bravo')).toHaveAttribute('aria-selected', 'true')
    expect(navigateToPage).not.toHaveBeenCalled()
  })

  it('Ctrl/Cmd-click and middle-click open a background tab', async () => {
    const container = await renderGraph()

    fireEvent.click(node(container, 'Alpha'), { ctrlKey: true })
    fireEvent.click(node(container, 'Bravo'), { metaKey: true })
    fireEvent(node(container, 'Charlie'), new MouseEvent('auxclick', { button: 1, bubbles: true }))

    expect(openInBackgroundTab.mock.calls).toEqual([
      ['a', 'Alpha', undefined],
      ['b', 'Bravo', undefined],
      ['c', 'Charlie', undefined],
    ])
    expect(navigateToPage).not.toHaveBeenCalled()
    expect(container.querySelectorAll('g.node[aria-selected="true"]')).toHaveLength(0)
  })

  it('on a touch phone, where the tab bar is hidden, a modifier click opens in place', async () => {
    mobile = true
    const container = await renderGraph()

    fireEvent.click(node(container, 'Alpha'), { ctrlKey: true })

    expect(navigateToPage.mock.calls).toEqual([['a', 'Alpha']])
    expect(openInBackgroundTab).not.toHaveBeenCalled()
  })

  it('has no axe violations with the nodes as options and one selected', async () => {
    const container = await renderGraph()
    fireEvent.click(node(container, 'Alpha'))

    expect(screen.getByTestId('graph-svg')).toHaveAttribute('role', 'listbox')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('GraphView — walking the local graph (#5435)', () => {
  it('selecting a node re-centres the neighbourhood on it, keeping where the staying nodes were', async () => {
    const container = await renderGraph()
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    fireEvent.click(screen.getByRole('radio', { name: '1 hop' }))
    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(2))
    act(() => {
      RecordingWorker.last?.settle({ hub: [120, 80], a: [300, 200] })
    })

    fireEvent.click(node(container, 'Alpha'))

    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(3))
    const update = posted().at(-1) as WorkerUpdateMessage
    expect(update.type).toBe('update')
    expect(
      Object.fromEntries(update.nodes.map((n) => [n.id, n.x === undefined ? null : [n.x, n.y]])),
    ).toEqual({ hub: [120, 80], a: [300, 200], b: expect.any(Array) })
    expect(screen.getByTestId('local-graph-seed-label')).toHaveTextContent(
      'Showing neighbors of "Alpha"',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back to "Hub"' }))

    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(2))
    expect(screen.getByTestId('local-graph-seed-label')).toHaveTextContent(
      'Showing neighbors of "Hub"',
    )
    expect(screen.queryByTestId('local-graph-back')).not.toBeInTheDocument()
  })
})

describe('GraphView — a selection the graph loses, and clearing it (#5435)', () => {
  const opacity = (container: HTMLElement, label: string): string =>
    node(container, label).style.opacity
  const fill = (container: HTMLElement, label: string): string | null | undefined =>
    node(container, label).querySelector('circle:nth-child(2)')?.getAttribute('fill')

  function refetch(pages: typeof PAGES, links: typeof LINKS): void {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return Promise.resolve(pages)
      if (cmd === 'list_page_links')
        return Promise.resolve({ edges: links, total: links.length, truncated: false })
      if (cmd === 'list_template_page_ids_in_space') return Promise.resolve([])
      if (cmd === 'list_all_tags_in_space') return Promise.resolve([])
      return Promise.resolve(null)
    })
    act(() => {
      recordGraphStructureChange()
    })
  }

  const deleteAlpha = (): void =>
    refetch(
      PAGES.filter((p) => p.id !== 'a'),
      LINKS.filter((l) => l.source_id !== 'a' && l.target_id !== 'a'),
    )

  it('a deleted selected page leaves no graph dimmed and gives the accent back to the current page', async () => {
    const container = await renderGraph()
    fireEvent.click(node(container, 'Alpha'))
    expect([opacity(container, 'Island'), fill(container, 'Hub')]).toEqual([
      '0.15',
      'var(--graph-node)',
    ])

    deleteAlpha()

    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(4))
    expect(['Hub', 'Bravo', 'Charlie', 'Island'].map((l) => opacity(container, l))).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(fill(container, 'Hub')).toBe('var(--graph-accent)')
  })

  it('a selected page the filters now hide leaves no graph dimmed', async () => {
    const container = await renderGraph()
    fireEvent.click(node(container, 'Alpha'))

    // Retitled as a date, the default "Exclude journal pages" filter hides it.
    refetch(
      PAGES.map((p) => (p.id === 'a' ? { id: 'a', content: '2026-10-08', block_type: 'page' } : p)),
      LINKS,
    )

    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(4))
    expect(['Hub', 'Bravo', 'Charlie', 'Island'].map((l) => opacity(container, l))).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(fill(container, 'Hub')).toBe('var(--graph-accent)')
  })

  it('a local walk whose page is deleted falls back to the starting page, not a dead toggle', async () => {
    const container = await renderGraph()
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    fireEvent.click(screen.getByRole('radio', { name: '1 hop' }))
    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(2))
    fireEvent.click(node(container, 'Alpha'))
    await waitFor(() => expect(container.querySelectorAll('g.node')).toHaveLength(3))

    deleteAlpha()

    await waitFor(() =>
      expect(screen.getByTestId('local-graph-seed-label')).toHaveTextContent(
        'Showing neighbors of "Hub"',
      ),
    )
    expect(screen.getByTestId('local-graph-toggle')).toBeEnabled()
  })

  it('Escape clears the selection, which gives the accent back and lights the whole graph', async () => {
    const container = await renderGraph()
    fireEvent.click(node(container, 'Alpha'))

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(node(container, 'Alpha'), escape)

    expect(container.querySelectorAll('g.node[aria-selected="true"]')).toHaveLength(0)
    expect([opacity(container, 'Island'), fill(container, 'Hub')]).toEqual([
      '',
      'var(--graph-accent)',
    ])
    expect(escape.defaultPrevented).toBe(true)
  })

  it('Escape with nothing selected leaves the key alone', async () => {
    const container = await renderGraph()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(node(container, 'Alpha'), escape)

    expect(escape.defaultPrevented).toBe(false)
  })
})
