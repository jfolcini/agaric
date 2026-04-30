/**
 * Tests for useGraphMainThreadSim (MAINT-127 split from useGraphSimulation).
 *
 * The hook returns a stable `runMainThread` callback that drives the d3-force
 * simulation on the main thread (used as the no-Worker fallback and the
 * post-failure recovery path). Tests focus on observable effects: simulation
 * forces are configured, the handle's lifecycle methods stop the simulation
 * cleanly, and reduced-motion preference uses a fixed-tick path.
 */

import { renderHook } from '@testing-library/react'
import { drag } from 'd3-drag'
import { forceCenter, forceSimulation, forceX, forceY } from 'd3-force'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, GraphNode } from '../../components/GraphView.helpers'
import type { SimulationCtx } from '../../lib/graph-sim-helpers'
import { useGraphMainThreadSim } from '../useGraphMainThreadSim'

// Capture the simulation mock so individual tests can assert on it.
// biome-ignore lint/suspicious/noExplicitAny: shared mock shape
let lastSim: any = null

vi.mock('d3-force', () => {
  const makeSim = (): unknown => {
    const sim = {
      force: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      stop: vi.fn(),
      alpha: vi.fn().mockReturnThis(),
      alphaDecay: vi.fn().mockReturnThis(),
      tick: vi.fn(),
      restart: vi.fn(),
      nodes: vi.fn(() => []),
    }
    lastSim = sim
    return sim
  }
  return {
    forceSimulation: vi.fn(makeSim),
    forceLink: vi.fn(() => ({ id: vi.fn().mockReturnThis(), distance: vi.fn().mockReturnThis() })),
    forceManyBody: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
    forceCenter: vi.fn(),
    forceCollide: vi.fn(),
    forceX: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
    forceY: vi.fn(() => ({ strength: vi.fn().mockReturnThis() })),
  }
})

vi.mock('d3-drag', () => ({
  drag: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
  })),
}))

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

function makeCtx(prefersReducedMotion = false): SimulationCtx {
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
    prefersReducedMotion,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  lastSim = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useGraphMainThreadSim', () => {
  it('returns a stable runMainThread callback across re-renders', () => {
    const { result, rerender } = renderHook(() => useGraphMainThreadSim())
    expect(typeof result.current).toBe('function')
    const before = result.current
    rerender()
    expect(result.current).toBe(before)
  })

  it('runMainThread builds a force simulation and attaches drag', () => {
    const { result } = renderHook(() => useGraphMainThreadSim())
    result.current(makeCtx())

    expect(forceSimulation).toHaveBeenCalledTimes(1)
    expect(drag).toHaveBeenCalled()
    expect(forceCenter).toHaveBeenCalledWith(400, 300)
  })

  it('handle.cleanup stops the simulation', () => {
    const { result } = renderHook(() => useGraphMainThreadSim())
    const handle = result.current(makeCtx())
    handle.cleanup()
    expect(lastSim?.stop).toHaveBeenCalledTimes(1)
  })

  it('reduced-motion path uses fixed ticks + alphaDecay = 1', () => {
    const { result } = renderHook(() => useGraphMainThreadSim())
    result.current(makeCtx(true))

    expect(lastSim?.alphaDecay).toHaveBeenCalledWith(1)
    expect(lastSim?.tick).toHaveBeenCalledWith(300)
    // Tick listener is NOT registered in reduced-motion mode (animations off).
    expect(lastSim?.on).not.toHaveBeenCalledWith('tick', expect.any(Function))
  })

  it('onResize re-anchors centering forces and re-energizes the simulation', () => {
    const { result } = renderHook(() => useGraphMainThreadSim())
    const handle = result.current(makeCtx())

    // Same dimensions: no-op.
    handle.onResize(800, 600)
    expect(forceCenter).toHaveBeenCalledTimes(1) // initial only

    // Changed dimensions: forceCenter / forceX / forceY rebuilt at new origin.
    handle.onResize(1024, 768)
    expect(forceCenter).toHaveBeenCalledWith(512, 384)
    expect(forceX).toHaveBeenCalledWith(512)
    expect(forceY).toHaveBeenCalledWith(384)
    expect(lastSim?.alpha).toHaveBeenCalledWith(0.3)
    expect(lastSim?.restart).toHaveBeenCalled()
  })
})
