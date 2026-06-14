/**
 * Tests for the graph force-simulation WebWorker dispatcher (#747 item 1).
 *
 * The worker registers a `message` listener on `self`. We import the module
 * (which attaches the listener), then drive it by dispatching `MessageEvent`s
 * and capturing `self.postMessage`. d3-force is mocked so we can assert the
 * dispatcher's behaviour precisely:
 *
 *  - `start` builds a fresh simulation (`forceSimulation` called).
 *  - `resize` updates the centering/bounds forces IN PLACE and nudges alpha,
 *    WITHOUT rebuilding the simulation (no second `forceSimulation` call) and
 *    WITHOUT touching the existing node objects' x/y (no re-seed).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ── d3-force mock ────────────────────────────────────────────────────
// A minimal chainable simulation stub. Each force(name, value?) acts as a
// getter/setter; `alpha`/`restart`/`stop`/`on` are chainable spies.

const forceSimulation = vi.fn()
const forceCenter = vi.fn((x: number, y: number) => ({ kind: 'center', x, y }))
const forceX = vi.fn((x: number) => ({ kind: 'x', x, strength: () => ({ kind: 'x', x }) }))
const forceY = vi.fn((y: number) => ({ kind: 'y', y, strength: () => ({ kind: 'y', y }) }))
const forceLink = vi.fn(() => ({ id: () => ({ distance: () => ({ kind: 'link' }) }) }))
const forceManyBody = vi.fn(() => ({ strength: () => ({ kind: 'charge' }) }))
const forceCollide = vi.fn(() => ({ kind: 'collide' }))

vi.mock('d3-force', () => ({
  forceSimulation,
  forceCenter,
  forceX,
  forceY,
  forceLink,
  forceManyBody,
  forceCollide,
}))

interface FakeSim {
  nodes: Array<{ id: string; label: string; x?: number; y?: number }>
  forces: Map<string, unknown>
  alphaValue: number
  restarted: number
  handlers: Map<string, () => void>
  force: (name: string, value?: unknown) => unknown
  alpha: (v?: number) => FakeSim
  restart: () => FakeSim
  stop: () => FakeSim
  alphaTarget: () => FakeSim
  on: (evt: string, fn: () => void) => FakeSim
}

function makeFakeSim(nodes: Array<{ id: string; label: string; x?: number; y?: number }>): FakeSim {
  const sim: FakeSim = {
    nodes,
    forces: new Map(),
    alphaValue: 1,
    restarted: 0,
    handlers: new Map(),
    force(name: string, value?: unknown) {
      if (value === undefined) return sim.forces.get(name)
      sim.forces.set(name, value)
      return sim
    },
    alpha(v?: number) {
      if (v !== undefined) sim.alphaValue = v
      return sim
    },
    restart() {
      sim.restarted++
      return sim
    },
    stop() {
      return sim
    },
    alphaTarget() {
      return sim
    },
    on(evt: string, fn: () => void) {
      sim.handlers.set(evt, fn)
      return sim
    },
  }
  return sim
}

describe('graph-worker dispatcher (#747 item 1: resize updates forces in place)', () => {
  let posted: Array<{ type: string; [k: string]: unknown }>
  let lastSim: FakeSim | null

  // Import the worker module exactly ONCE so only a single `message` listener
  // is attached to `self` (re-importing under resetModules would accumulate
  // listeners and double-dispatch every message).
  beforeAll(async () => {
    await import('../graph-worker')
  })

  beforeEach(() => {
    forceSimulation.mockReset()
    forceCenter.mockClear()
    forceX.mockClear()
    forceY.mockClear()
    posted = []
    lastSim = null

    // forceSimulation(nodes) returns a chainable fake that records nodes/forces.
    forceSimulation.mockImplementation(
      (nodes: Array<{ id: string; label: string; x?: number; y?: number }>) => {
        lastSim = makeFakeSim(nodes)
        return lastSim
      },
    )

    // Capture worker → main posts.
    vi.spyOn(self, 'postMessage').mockImplementation(((msg: unknown) => {
      posted.push(msg as { type: string })
    }) as typeof self.postMessage)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function send(data: unknown): void {
    self.dispatchEvent(new MessageEvent('message', { data }))
  }

  it('builds a fresh simulation on `start`', () => {
    send({
      type: 'start',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ source: 'a', target: 'b', ref_count: 1 }],
      width: 800,
      height: 600,
    })

    expect(forceSimulation).toHaveBeenCalledTimes(1)
    expect(forceCenter).toHaveBeenCalledWith(400, 300)
  })

  it('`resize` swaps center/x/y forces in place WITHOUT rebuilding the sim or re-seeding positions', () => {
    send({
      type: 'start',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [],
      width: 800,
      height: 600,
    })

    expect(forceSimulation).toHaveBeenCalledTimes(1)
    const sim = lastSim as unknown as FakeSim
    // Simulate the sim having converged to real positions.
    Object.assign(sim.nodes[0] as object, { x: 123, y: 456 })
    Object.assign(sim.nodes[1] as object, { x: 789, y: 12 })
    const before = sim.nodes.map((n) => ({ ...n }))

    forceCenter.mockClear()
    forceX.mockClear()
    forceY.mockClear()

    send({ type: 'resize', width: 1000, height: 400 })

    // No rebuild: forceSimulation still called exactly once total.
    expect(forceSimulation).toHaveBeenCalledTimes(1)
    // Centering/bounds forces recomputed for the new dimensions.
    expect(forceCenter).toHaveBeenCalledWith(500, 200)
    expect(forceX).toHaveBeenCalledWith(500)
    expect(forceY).toHaveBeenCalledWith(200)
    // The new force objects were swapped into the live simulation.
    expect((sim.forces.get('center') as { x: number }).x).toBe(500)
    // Alpha nudged + restarted so the existing layout re-settles (not re-scatter).
    expect(sim.alphaValue).toBe(0.3)
    expect(sim.restarted).toBeGreaterThan(0)
    // Positions preserved — resize did NOT touch node x/y.
    expect(sim.nodes).toEqual(before)
  })

  it('`resize` before any `start` is a no-op (does not throw, builds nothing)', () => {
    send({ type: 'resize', width: 1000, height: 400 })
    expect(forceSimulation).not.toHaveBeenCalled()
    // No error posted back.
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })
})
