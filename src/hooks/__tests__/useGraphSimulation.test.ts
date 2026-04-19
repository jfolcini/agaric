/**
 * Tests for useGraphSimulation (MAINT-57 + BUG-45).
 *
 * The hook owns the d3-force simulation lifecycle, worker/main-thread
 * fallback, drag handlers, zoom behavior, and error recovery. Because the
 * hook drives a side-effect pipeline (SVG setup → worker creation → drag)
 * tests focus on observable effects: which code path runs, what gets
 * logged on failure, and whether zoom callbacks invoke the d3 zoom API.
 */

import { act, render } from '@testing-library/react'
import { forceSimulation } from 'd3-force'
import { zoom } from 'd3-zoom'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, GraphNode } from '../../components/GraphView.helpers'
import { useGraphSimulation } from '../useGraphSimulation'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

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
  forceLink: vi.fn(() => ({ id: vi.fn().mockReturnThis(), distance: vi.fn().mockReturnThis() })),
  forceManyBody: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
  forceCenter: vi.fn(),
  forceCollide: vi.fn(),
  forceX: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
  forceY: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
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

// ── MockWorker ───────────────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: test mock
type Handler = (evt: { data?: any; type?: string; error?: any; message?: any }) => void

class MockWorker {
  static instances: MockWorker[] = []
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  postMessageCalls: any[] = []
  terminated = false
  private listeners = new Map<string, Handler[]>()

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  constructor(_url: any, _opts?: any) {
    MockWorker.instances.push(this)
  }

  addEventListener(type: string, handler: Handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: Handler) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((h) => h !== handler),
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  postMessage(data: any) {
    this.postMessageCalls.push(data)
  }

  terminate() {
    this.terminated = true
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  dispatch(type: string, event: any) {
    const list = this.listeners.get(type) ?? []
    for (const handler of list) handler(event)
  }
}

const OriginalWorker = globalThis['Worker'] as typeof Worker | undefined

function makeNodes(): GraphNode[] {
  return [
    {
      id: 'a',
      label: 'A',
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      is_template: false,
      backlink_count: 0,
    },
    {
      id: 'b',
      label: 'B',
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      is_template: false,
      backlink_count: 0,
    },
  ]
}

function makeEdges(): GraphEdge[] {
  return [{ source: 'a', target: 'b', ref_count: 1 }]
}

interface HarnessProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  // biome-ignore lint/suspicious/noExplicitAny: test harness
  onResult: (result: any) => void
  navigateToPage?: (id: string, label: string) => void
}

function Harness({ nodes, edges, onResult, navigateToPage }: HarnessProps): React.ReactElement {
  const svgRef = React.useRef<SVGSVGElement>(null)
  const result = useGraphSimulation({
    svgRef,
    nodes,
    edges,
    navigateToPage: navigateToPage ?? ((): void => {}),
  })
  React.useEffect(() => {
    onResult(result)
  })
  return React.createElement('svg', { ref: svgRef, role: 'img' })
}

beforeEach(() => {
  vi.clearAllMocks()
  MockWorker.instances = []
  vi.stubGlobal('Worker', MockWorker)
})

afterEach(() => {
  if (OriginalWorker) {
    vi.stubGlobal('Worker', OriginalWorker)
  } else {
    delete (globalThis as Record<string, unknown>)['Worker']
  }
})

describe('useGraphSimulation', () => {
  it('does nothing when nodes is empty', () => {
    render(
      React.createElement(Harness, {
        nodes: [],
        edges: [],
        onResult: () => {},
      }),
    )
    expect(MockWorker.instances).toHaveLength(0)
    expect(forceSimulation).not.toHaveBeenCalled()
  })

  it('spawns a worker and posts start on the worker path', () => {
    render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: () => {},
      }),
    )
    expect(MockWorker.instances).toHaveLength(1)
    const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(worker.postMessageCalls[0]).toMatchObject({ type: 'start' })
    expect(forceSimulation).not.toHaveBeenCalled()
  })

  it('uses main-thread simulation when Worker is unavailable', () => {
    delete (globalThis as Record<string, unknown>)['Worker']
    render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: () => {},
      }),
    )
    expect(MockWorker.instances).toHaveLength(0)
    expect(forceSimulation).toHaveBeenCalledTimes(1)
  })

  it('terminates the worker on unmount', () => {
    const { unmount } = render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: () => {},
      }),
    )
    const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(worker.terminated).toBe(false)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('exposes zoom handlers that call d3-zoom scaleBy / transform', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test harness receives any shape
    let latest: any
    render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: (r) => {
          latest = r
        },
      }),
    )

    latest.zoomIn()
    latest.zoomOut()
    latest.zoomReset()

    // biome-ignore lint/suspicious/noExplicitAny: d3 zoom mock access in test
    const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
    expect(zoomInstance.scaleBy).toHaveBeenCalledTimes(2)
    expect(zoomInstance.transform).toHaveBeenCalledTimes(1)
  })

  it('falls back to main-thread simulation on worker error', async () => {
    render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: () => {},
      }),
    )
    expect(MockWorker.instances).toHaveLength(1)
    const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(forceSimulation).not.toHaveBeenCalled()

    worker.dispatch('error', {
      type: 'error',
      error: new Error('boom'),
      message: 'boom',
    })

    // React 19: state updates from non-React events (worker dispatch) need
    // `act` to flush the re-render + effect rerun before assertions.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(worker.terminated).toBe(true)
    expect(forceSimulation).toHaveBeenCalledTimes(1)
  })

  it('falls back to main-thread simulation on messageerror', async () => {
    render(
      React.createElement(Harness, {
        nodes: makeNodes(),
        edges: makeEdges(),
        onResult: () => {},
      }),
    )
    const worker = MockWorker.instances[0] as InstanceType<typeof MockWorker>

    worker.dispatch('messageerror', { type: 'messageerror' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(worker.terminated).toBe(true)
    expect(forceSimulation).toHaveBeenCalled()
  })
})
