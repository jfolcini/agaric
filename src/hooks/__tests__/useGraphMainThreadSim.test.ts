/**
 * Tests for useGraphMainThreadSim (split from useGraphSimulation).
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

import type { GraphEdge, GraphNode } from '@/components/graph/GraphView.helpers'
import { useGraphMainThreadSim } from '@/hooks/useGraphMainThreadSim'
import type { SimulationCtx, SimulationHandle } from '@/lib/graph-sim-helpers'

// Capture the simulation mock so individual tests can assert on it.
let lastSim: any = null

vi.mock('d3-force', () => {
  const makeSim = (): unknown => {
    const sim = {
      force: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      stop: vi.fn(),
      alpha: vi.fn().mockReturnThis(),
      alphaDecay: vi.fn().mockReturnThis(),
      alphaTarget: vi.fn().mockReturnThis(),
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
    forceManyBody: vi.fn(() => ({
      strength: vi.fn().mockReturnThis(),
      distanceMax: vi.fn().mockReturnThis(),
    })),
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
      is_journal: false,
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
    keptSettled: false,
    onSettled: vi.fn(),
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

  describe('start alpha from a kept layout (#5434)', () => {
    /** The alpha the simulation was started at, for nodes placed at `kept`. */
    function startAlpha(kept: Array<{ x: number; y: number } | null>, keptSettled: boolean) {
      const ctx = makeCtx()
      ctx.simNodes = kept.map((at, i) => ({ ...makeNodes()[0], id: `n${i}`, ...at }) as GraphNode)
      ctx.keptSettled = keptSettled
      renderHook(() => useGraphMainThreadSim()).result.current(ctx)
      expect(lastSim?.alpha).toHaveBeenCalledTimes(1)
      return lastSim?.alpha.mock.calls[0]?.[0]
    }

    it('starts cold with nothing kept', () => {
      expect(startAlpha([null], false)).toBe(1)
    })

    it('starts at rest from a settled layout with every node kept', () => {
      expect(
        startAlpha(
          [
            { x: 120, y: 80 },
            { x: 300, y: 210 },
          ],
          true,
        ),
      ).toBe(0)
    })

    it('starts warm from a layout that was still moving', () => {
      expect(
        startAlpha(
          [
            { x: 120, y: 80 },
            { x: 300, y: 210 },
          ],
          false,
        ),
      ).toBe(0.3)
    })

    it('starts warm from a settled layout with a new node', () => {
      expect(startAlpha([{ x: 120, y: 80 }, null], true)).toBe(0.3)
    })
  })

  describe('settled (#5434)', () => {
    /** A started simulation whose d3 `end` has fired. */
    function ended(): SimulationHandle {
      const handle = renderHook(() => useGraphMainThreadSim()).result.current(makeCtx())
      const calls = lastSim.on.mock.calls as Array<[string, () => void]>
      const fire = (event: string) => calls.find(([e]) => e === event)?.[1]()
      expect(handle.settled()).toBe(false)
      fire('end')
      fire('tick')
      return handle
    }

    it('is settled once the simulation ends, and a tick (a click reheat) keeps it so', () => {
      expect(ended().settled()).toBe(true)
    })

    it('a resize unsettles it', () => {
      const handle = ended()
      handle.onResize(1024, 768)
      expect(handle.settled()).toBe(false)
    })

    it('an update unsettles it', () => {
      const handle = ended()
      handle.onUpdate(makeCtx())
      expect(handle.settled()).toBe(false)
    })

    it('starts settled when a settled, fully kept layout starts at rest', () => {
      const ctx = makeCtx()
      Object.assign(ctx.simNodes[0] as GraphNode, { x: 120, y: 80 })
      ctx.keptSettled = true
      expect(
        renderHook(() => useGraphMainThreadSim())
          .result.current(ctx)
          .settled(),
      ).toBe(true)
    })
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

  it('reports the settled nodes once the simulation ends, so the view can fit them (#5432)', () => {
    const ctx = makeCtx()
    renderHook(() => useGraphMainThreadSim()).result.current(ctx)
    const settledNodes = makeNodes()
    lastSim.nodes.mockReturnValue(settledNodes)
    expect(ctx.onSettled).not.toHaveBeenCalled()

    const calls = lastSim.on.mock.calls as Array<[string, () => void]>
    calls.find(([e]) => e === 'end')?.[1]()

    expect(ctx.onSettled).toHaveBeenCalledTimes(1)
    expect(ctx.onSettled).toHaveBeenCalledWith(settledNodes)
  })

  it('the reduced-motion path reports its settled nodes as soon as it has ticked (#5432)', () => {
    const ctx = makeCtx(true)
    const settledNodes = makeNodes()
    vi.mocked(forceSimulation).mockImplementationOnce((...args) => {
      const sim = vi.mocked(forceSimulation).getMockImplementation()?.(...args)
      ;(sim as any).nodes.mockReturnValue(settledNodes)
      return sim as any
    })

    renderHook(() => useGraphMainThreadSim()).result.current(ctx)

    expect(ctx.onSettled).toHaveBeenCalledTimes(1)
    expect(ctx.onSettled).toHaveBeenCalledWith(settledNodes)
    expect(lastSim.tick.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.onSettled).mock.invocationCallOrder[0] as number,
    )
  })

  it('a drag warms the simulation toward a target, as the worker does, instead of jolting it (#5432)', () => {
    renderHook(() => useGraphMainThreadSim()).result.current(makeCtx())
    const behaviour = vi.mocked(drag).mock.results.at(-1)?.value as {
      on: { mock: { calls: Array<[string, (event: unknown, d: unknown) => void]> } }
    }
    const handler = (name: string) => behaviour.on.mock.calls.find(([e]) => e === name)?.[1]
    const node = { x: 1, y: 2 }
    lastSim.alpha.mockClear()

    handler('start')?.({ active: 0 }, node)
    expect(lastSim.alphaTarget).toHaveBeenLastCalledWith(0.3)
    expect(lastSim.restart).toHaveBeenCalledTimes(1)

    handler('end')?.({ active: 0 }, node)
    expect(lastSim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect(lastSim.alpha).not.toHaveBeenCalled()
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
