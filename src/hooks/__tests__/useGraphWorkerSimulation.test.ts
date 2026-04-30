/**
 * Tests for useGraphWorkerSimulation (MAINT-127 split from useGraphSimulation).
 *
 * Owns the `workerFailed` flag (BUG-45) and exposes a stable `runWorker`
 * callback that wraps `runWorkerSimulation` with the failure handler. The
 * orchestrator re-runs its effect when `workerFailed` flips to true and
 * falls back to the main-thread path.
 *
 * React 19 timing note: a worker-dispatched error event triggers a state
 * update from outside the React event loop, so the test wraps the wait
 * in `act(async)` per `src/__tests__/AGENTS.md`.
 */

import { act, renderHook } from '@testing-library/react'
import { drag } from 'd3-drag'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, GraphNode } from '../../components/GraphView.helpers'
import type { SimulationCtx } from '../../lib/graph-sim-helpers'
import { useGraphWorkerSimulation } from '../useGraphWorkerSimulation'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

  addEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((h) => h !== handler),
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  postMessage(data: any): void {
    this.postMessageCalls.push(data)
  }

  terminate(): void {
    this.terminated = true
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  dispatch(type: string, event: any): void {
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
  ]
}

function makeEdges(): GraphEdge[] {
  return [{ source: 'a', target: 'a', ref_count: 1 }]
}

function makeCtx(): SimulationCtx {
  const nodes = makeNodes()
  const edges = makeEdges()
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  // biome-ignore lint/suspicious/noExplicitAny: NodeSel chain — test stub
  const node = { call: vi.fn().mockReturnThis() } as any
  return {
    simNodes: nodes,
    simEdges: edges,
    nodeById,
    node,
    applyPositions: vi.fn(),
    width: 800,
    height: 600,
    prefersReducedMotion: false,
  }
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
  vi.restoreAllMocks()
})

describe('useGraphWorkerSimulation', () => {
  it('starts with workerFailed: false and exposes a stable runWorker callback', () => {
    const { result, rerender } = renderHook(() => useGraphWorkerSimulation())
    expect(result.current.workerFailed).toBe(false)
    expect(typeof result.current.runWorker).toBe('function')
    const before = result.current.runWorker
    rerender()
    expect(result.current.runWorker).toBe(before)
  })

  it('runWorker spawns a worker and posts a start message', () => {
    const { result } = renderHook(() => useGraphWorkerSimulation())
    result.current.runWorker(makeCtx())

    expect(MockWorker.instances).toHaveLength(1)
    const w = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(w.postMessageCalls[0]).toMatchObject({ type: 'start', width: 800, height: 600 })
    expect(drag).toHaveBeenCalled()
  })

  it('runWorker returns a handle whose cleanup terminates the worker', () => {
    const { result } = renderHook(() => useGraphWorkerSimulation())
    const handle = result.current.runWorker(makeCtx())
    const w = MockWorker.instances[0] as InstanceType<typeof MockWorker>
    expect(w.terminated).toBe(false)
    handle.cleanup()
    expect(w.terminated).toBe(true)
  })

  it('flips workerFailed to true when the worker dispatches an error event', async () => {
    const { result } = renderHook(() => useGraphWorkerSimulation())
    result.current.runWorker(makeCtx())
    const w = MockWorker.instances[0] as InstanceType<typeof MockWorker>

    w.dispatch('error', { type: 'error', error: new Error('boom'), message: 'boom' })

    // React 19: state updates from non-React events need act() to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.workerFailed).toBe(true)
    expect(w.terminated).toBe(true)
  })

  it('onResize re-posts start with new dimensions when they change', () => {
    const { result } = renderHook(() => useGraphWorkerSimulation())
    const handle = result.current.runWorker(makeCtx())
    const w = MockWorker.instances[0] as InstanceType<typeof MockWorker>

    // Same dimensions: no re-post.
    handle.onResize(800, 600)
    let starts = w.postMessageCalls.filter((m: { type?: string }) => m.type === 'start')
    expect(starts).toHaveLength(1)

    // Changed dimensions: re-post with updated width/height.
    handle.onResize(1024, 768)
    starts = w.postMessageCalls.filter((m: { type?: string }) => m.type === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ width: 1024, height: 768 })
  })
})
