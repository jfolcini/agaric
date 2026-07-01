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
// The link force stub exposes a chainable `.links(edges)` setter so the
// `update` handler (#2194) can re-bind edges on the existing force. We record
// the last edges passed so the test can assert the swap happened.
interface FakeLinkForce {
  kind: 'link'
  linkedEdges: unknown
  links: (edges?: unknown) => FakeLinkForce
}
let lastLinkForce: FakeLinkForce | null = null
function makeFakeLinkForce(): FakeLinkForce {
  const lf: FakeLinkForce = {
    kind: 'link',
    linkedEdges: undefined,
    links(edges?: unknown) {
      if (edges !== undefined) lf.linkedEdges = edges
      return lf
    },
  }
  lastLinkForce = lf
  return lf
}
const forceLink = vi.fn(() => ({ id: () => ({ distance: () => makeFakeLinkForce() }) }))
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

interface FakeSimNode {
  id: string
  label: string
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

interface FakeSim {
  /**
   * The live node array. Read directly by tests; also swapped in place by
   * the `update` handler via the `nodes(newArray)` d3-style setter below
   * (#2194). Reads use `sim.nodeList`; the worker calls `sim.nodes(...)`.
   */
  nodeList: FakeSimNode[]
  forces: Map<string, unknown>
  alphaValue: number
  /** Last value passed to `alphaTarget(v)` (#1687: drag lifecycle). */
  alphaTargetValue: number | null
  restarted: number
  /** Number of times `stop()` was called (#1687: stop teardown). */
  stopped: number
  handlers: Map<string, () => void>
  force: (name: string, value?: unknown) => unknown
  /** d3-style getter/setter: `nodes()` reads, `nodes(arr)` swaps in place. */
  nodes: (v?: FakeSimNode[]) => FakeSim | FakeSimNode[]
  alpha: (v?: number) => FakeSim
  restart: () => FakeSim
  stop: () => FakeSim
  alphaTarget: (v?: number) => FakeSim
  on: (evt: string, fn: () => void) => FakeSim
}

function makeFakeSim(nodes: FakeSimNode[]): FakeSim {
  const sim: FakeSim = {
    nodeList: nodes,
    forces: new Map(),
    alphaValue: 1,
    alphaTargetValue: null,
    restarted: 0,
    stopped: 0,
    handlers: new Map(),
    force(name: string, value?: unknown) {
      if (value === undefined) return sim.forces.get(name)
      sim.forces.set(name, value)
      return sim
    },
    nodes(v?: FakeSimNode[]) {
      if (v !== undefined) {
        sim.nodeList = v
        return sim
      }
      return sim.nodeList
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
      sim.stopped++
      return sim
    },
    alphaTarget(v?: number) {
      if (v !== undefined) sim.alphaTargetValue = v
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
  // #2194: the transfer list passed alongside each post (2nd postMessage arg).
  let transfers: Array<Transferable[] | undefined>
  let lastSim: FakeSim | null

  // Import the worker module exactly ONCE so only a single `message` listener
  // is attached to `self` (re-importing under resetModules would accumulate
  // listeners and double-dispatch every message). Captured here (not a static
  // top-level import) so the `vi.mock('d3-force')` factory's hoisted spies are
  // initialized before the worker module evaluates — #2273 reads its exported
  // pure `shouldEmitTick`/`TICK_THROTTLE_MS` off this handle.
  let workerModule: typeof import('../graph-worker')
  beforeAll(async () => {
    workerModule = await import('../graph-worker')
  })

  beforeEach(() => {
    forceSimulation.mockReset()
    forceCenter.mockClear()
    forceX.mockClear()
    forceY.mockClear()
    posted = []
    transfers = []
    lastSim = null
    lastLinkForce = null

    // forceSimulation(nodes) returns a chainable fake that records nodes/forces.
    forceSimulation.mockImplementation((nodes: FakeSimNode[]) => {
      lastSim = makeFakeSim(nodes)
      return lastSim
    })

    // Capture worker → main posts (message + optional transfer list).
    vi.spyOn(self, 'postMessage').mockImplementation(((msg: unknown, transfer?: Transferable[]) => {
      posted.push(msg as { type: string })
      transfers.push(transfer)
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
    Object.assign(sim.nodeList[0] as object, { x: 123, y: 456 })
    Object.assign(sim.nodeList[1] as object, { x: 789, y: 12 })
    const before = sim.nodeList.map((n) => ({ ...n }))

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
    expect(sim.nodeList).toEqual(before)
  })

  // -------------------------------------------------------------------------
  // Primary output path: the `tick` / `end` handlers registered on the sim post
  // node positions back to the main thread. #2194: positions are packed into a
  // `Float32Array` ([x0,y0,x1,y1,…]) in `simNodes` order and posted as a
  // transferable (`postMessage(msg, [buffer])`) instead of an {id,x,y}[]
  // structured clone. The message carries `count` = number of nodes.
  // -------------------------------------------------------------------------

  it('the `tick` handler posts a packed Float32Array (+count) with the live node x/y', () => {
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
    const sim = lastSim as unknown as FakeSim

    // d3 mutates node x/y in place each tick; simulate a settled frame.
    Object.assign(sim.nodeList[0] as object, { x: 11, y: 22 })
    Object.assign(sim.nodeList[1] as object, { x: 33, y: 44 })

    posted.length = 0
    const tick = sim.handlers.get('tick')
    expect(tick).toBeTypeOf('function')
    tick?.()

    expect(posted).toHaveLength(1)
    const msg = posted[0] as { type: string; positions: Float32Array; count: number }
    expect(msg.type).toBe('tick')
    expect(msg.count).toBe(2)
    expect(Array.from(msg.positions)).toEqual([11, 22, 33, 44])
    // Posted as a transferable (buffer handed off zero-copy).
    expect(transfers[0]).toEqual([msg.positions.buffer])
  })

  it('the `end` handler posts {type:"done"} with a packed Float32Array of final x/y', () => {
    send({
      type: 'start',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
      width: 800,
      height: 600,
    })
    const sim = lastSim as unknown as FakeSim
    Object.assign(sim.nodeList[0] as object, { x: 7, y: 9 })

    posted.length = 0
    const end = sim.handlers.get('end')
    expect(end).toBeTypeOf('function')
    end?.()

    expect(posted).toHaveLength(1)
    const msg = posted[0] as { type: string; positions: Float32Array; count: number }
    expect(msg.type).toBe('done')
    expect(msg.count).toBe(1)
    expect(Array.from(msg.positions)).toEqual([7, 9])
  })

  it('packs missing x/y as 0 in the posted Float32Array', () => {
    // A node d3 has not yet placed has undefined x/y; packing coalesces to 0
    // so the main thread always receives numeric coordinates.
    send({
      type: 'start',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
      width: 800,
      height: 600,
    })
    const sim = lastSim as unknown as FakeSim
    // Leave node.x / node.y undefined (no Object.assign).

    posted.length = 0
    sim.handlers.get('tick')?.()

    const msg = posted[0] as { type: string; positions: Float32Array; count: number }
    expect(msg.type).toBe('tick')
    expect(Array.from(msg.positions)).toEqual([0, 0])
  })

  it('`resize` before any `start` is a no-op (does not throw, builds nothing)', () => {
    send({ type: 'resize', width: 1000, height: 400 })
    expect(forceSimulation).not.toHaveBeenCalled()
    // No error posted back.
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // #2273 — tick emission is throttled to ~one per animation-frame interval so
  // the worker doesn't structured-transfer a fresh buffer on every one of the
  // ~300 convergence ticks (the main thread coalesces to one rAF/frame anyway,
  // discarding most posts). The `done`/settle post ALWAYS fires, bypassing the
  // throttle, so the converged layout is sent exactly.
  // -------------------------------------------------------------------------

  it('shouldEmitTick emits only after the min interval has elapsed (pure)', () => {
    const { shouldEmitTick, TICK_THROTTLE_MS } = workerModule
    // The session-reset sentinel (-Infinity) always emits (first tick of a run).
    expect(shouldEmitTick(0, Number.NEGATIVE_INFINITY, TICK_THROTTLE_MS)).toBe(true)
    // Exactly one interval elapsed → emit; just under → skip.
    expect(shouldEmitTick(TICK_THROTTLE_MS, 0, TICK_THROTTLE_MS)).toBe(true)
    expect(shouldEmitTick(TICK_THROTTLE_MS - 1, 0, TICK_THROTTLE_MS)).toBe(false)
    expect(shouldEmitTick(32, 16, TICK_THROTTLE_MS)).toBe(true)
    expect(shouldEmitTick(31, 16, TICK_THROTTLE_MS)).toBe(false)
  })

  it('throttles multiple synchronous ticks to one post, but always posts the final `done`', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    // First tick after `start` always posts: the session resets lastTickEmit to
    // -Infinity, so it is not throttled regardless of the clock.
    nowSpy.mockReturnValue(1000)
    send({ type: 'start', nodes: [{ id: 'a', label: 'A' }], edges: [], width: 800, height: 600 })
    const sim = lastSim as unknown as FakeSim
    Object.assign(sim.nodeList[0] as object, { x: 1, y: 1 })

    posted.length = 0
    const tick = sim.handlers.get('tick')
    expect(tick).toBeTypeOf('function')

    // t=1000: first tick posts.
    tick?.()
    // t=1005, t=1010: within one throttle interval of the last emit → skipped.
    nowSpy.mockReturnValue(1005)
    tick?.()
    nowSpy.mockReturnValue(1010)
    tick?.()
    expect(posted.filter((m) => m.type === 'tick')).toHaveLength(1)

    // t=1020: >= 16ms since the last emit → posts again.
    nowSpy.mockReturnValue(1020)
    tick?.()
    expect(posted.filter((m) => m.type === 'tick')).toHaveLength(2)

    // `end` fires 1ms later (well inside the throttle window) — the final
    // settled layout must STILL post so convergence is exact.
    nowSpy.mockReturnValue(1021)
    sim.handlers.get('end')?.()
    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1)

    nowSpy.mockRestore()
  })

  it('resets the throttle on `update` so the first drift tick posts immediately', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValue(2000)
    send({ type: 'start', nodes: [{ id: 'a', label: 'A' }], edges: [], width: 800, height: 600 })
    const sim = lastSim as unknown as FakeSim
    const tick = sim.handlers.get('tick')

    tick?.() // first post at t=2000
    nowSpy.mockReturnValue(2005)
    tick?.() // throttled (within the interval)

    posted.length = 0
    // A filter toggle arrives at t=2005 — still inside the throttle window of
    // the last emit. `update` must reset the gate so the next tick posts.
    send({
      type: 'update',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'c', label: 'C' },
      ],
      edges: [],
    })
    tick?.() // still t=2005, but the reset lets it through
    expect(posted.filter((m) => m.type === 'tick')).toHaveLength(1)

    nowSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // #1687 — drag lifecycle (graph-worker.ts:120-143)
  // -------------------------------------------------------------------------

  function startTwoNodes(): FakeSim {
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
    return lastSim as unknown as FakeSim
  }

  it('`drag` start reheats the simulation (alphaTarget 0.3 + restart) and pins the node', () => {
    const sim = startTwoNodes()
    const restartsBefore = sim.restarted

    send({ type: 'drag', nodeId: 'a', x: 10, y: 20, phase: 'start' })

    // Reheat: alphaTarget bumped to 0.3 and the sim restarted so it keeps
    // ticking while the user drags.
    expect(sim.alphaTargetValue).toBe(0.3)
    expect(sim.restarted).toBe(restartsBefore + 1)
    // Node pinned to the pointer via fx/fy.
    const node = sim.nodeList.find((n) => n.id === 'a')
    expect(node?.fx).toBe(10)
    expect(node?.fy).toBe(20)
    // No error posted.
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  it('`drag` move updates fx/fy WITHOUT re-reheating (no extra alphaTarget/restart)', () => {
    const sim = startTwoNodes()
    send({ type: 'drag', nodeId: 'a', x: 10, y: 20, phase: 'start' })
    const restartsAfterStart = sim.restarted

    send({ type: 'drag', nodeId: 'a', x: 55, y: 66, phase: 'drag' })

    const node = sim.nodeList.find((n) => n.id === 'a')
    expect(node?.fx).toBe(55)
    expect(node?.fy).toBe(66)
    // The `drag` phase only repositions — it must NOT restart the sim again
    // or touch alphaTarget (still 0.3 from the start phase).
    expect(sim.restarted).toBe(restartsAfterStart)
    expect(sim.alphaTargetValue).toBe(0.3)
  })

  it('`drag` end cools the simulation (alphaTarget 0) and releases the pin (fx/fy null)', () => {
    const sim = startTwoNodes()
    send({ type: 'drag', nodeId: 'a', x: 10, y: 20, phase: 'start' })

    send({ type: 'drag', nodeId: 'a', x: 10, y: 20, phase: 'end' })

    expect(sim.alphaTargetValue).toBe(0)
    const node = sim.nodeList.find((n) => n.id === 'a')
    expect(node?.fx).toBeNull()
    expect(node?.fy).toBeNull()
  })

  it('`drag` for an unknown nodeId is a no-op (no reheat, no error)', () => {
    const sim = startTwoNodes()
    const restartsBefore = sim.restarted

    send({ type: 'drag', nodeId: 'ghost', x: 5, y: 5, phase: 'start' })

    // Unknown id guard (graph-worker.ts:123-124): nothing pinned, sim untouched.
    expect(sim.restarted).toBe(restartsBefore)
    expect(sim.alphaTargetValue).toBeNull()
    expect(sim.nodeList.every((n) => n.fx == null && n.fy == null)).toBe(true)
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  it('`drag` before any `start` is a no-op (does not throw, posts nothing)', () => {
    send({ type: 'drag', nodeId: 'a', x: 1, y: 2, phase: 'start' })
    expect(forceSimulation).not.toHaveBeenCalled()
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // #2194 — `update`: swap the node/edge set on the LIVE simulation in place
  // instead of tearing the worker down and re-posting `start`.
  // -------------------------------------------------------------------------

  it('`update` swaps nodes/links in place WITHOUT rebuilding the sim, preserving carried positions', () => {
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
    const sim = lastSim as unknown as FakeSim

    // A filter toggle: drop 'b', keep 'a' (carrying its position), add 'c' new.
    send({
      type: 'update',
      nodes: [
        { id: 'a', label: 'A', x: 111, y: 222, vx: 1, vy: 2 },
        { id: 'c', label: 'C' },
      ],
      edges: [{ source: 'a', target: 'c', ref_count: 3 }],
    })

    // No rebuild: forceSimulation NOT called a second time.
    expect(forceSimulation).toHaveBeenCalledTimes(1)

    // The sim's node array was swapped to the new set (via sim.nodes(newArray)).
    expect(sim.nodeList.map((n) => n.id)).toEqual(['a', 'c'])
    // Persisting node 'a' keeps its carried position; brand-new 'c' is left
    // for d3 to seed (x/y undefined).
    const a = sim.nodeList.find((n) => n.id === 'a')
    expect(a).toMatchObject({ x: 111, y: 222, vx: 1, vy: 2 })
    const c = sim.nodeList.find((n) => n.id === 'c')
    expect(c?.x).toBeUndefined()
    expect(c?.y).toBeUndefined()

    // Link force re-bound to the new edges.
    expect(lastLinkForce?.linkedEdges).toEqual([{ source: 'a', target: 'c', ref_count: 3 }])

    // Alpha nudged + restarted so the layout DRIFTS (not re-scatter).
    expect(sim.alphaValue).toBe(0.3)
    expect(sim.restarted).toBeGreaterThan(0)
    // No error posted.
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  it('`update` before any `start` is a no-op (does not throw, builds nothing)', () => {
    send({ type: 'update', nodes: [{ id: 'a', label: 'A' }], edges: [] })
    expect(forceSimulation).not.toHaveBeenCalled()
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // #1687 — stop teardown (graph-worker.ts:112-118)
  // -------------------------------------------------------------------------

  it('`stop` tears down the running simulation (stop() called) and a later resize is a no-op', () => {
    const sim = startTwoNodes()

    send({ type: 'stop' })
    expect(sim.stopped).toBe(1)

    // State was torn down (simulation = null): a follow-up resize must no-op
    // rather than mutating the dead sim.
    forceCenter.mockClear()
    send({ type: 'resize', width: 1000, height: 400 })
    expect(forceCenter).not.toHaveBeenCalled()
    // And a subsequent drag is likewise a no-op (guarded by `if (!simulation)`).
    send({ type: 'drag', nodeId: 'a', x: 1, y: 2, phase: 'start' })
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  it('`stop` before any `start` is a no-op (does not throw)', () => {
    expect(() => send({ type: 'stop' })).not.toThrow()
    expect(posted.some((m) => m.type === 'error')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // #1614 — single structured error channel (graph-worker.ts message-handler
  // catch). The handler posts exactly ONE structured {type:'error'} and does
  // NOT re-throw: re-throwing previously surfaced at the worker boundary as a
  // global `error` event, which posted a SECOND error and fanned one failure
  // into multiple signals. The global error/unhandledrejection listeners
  // remain only as the fallback for errors that genuinely escape the handler.
  // -------------------------------------------------------------------------

  it('posts exactly one structured {type:"error"} and does NOT re-throw when the dispatcher throws', () => {
    // Force forceSimulation to throw inside the `start` handler so the
    // try/catch fires. The handler must post a single structured error back to
    // the main thread and swallow the throw — the main thread already routes
    // this post through the same `reportFailure` fallback as a boundary error,
    // so re-throwing would only produce a redundant second error post.
    forceSimulation.mockImplementationOnce(() => {
      throw new Error('boom in sim')
    })

    // No re-throw: dispatching the event must NOT surface the listener
    // exception (which dispatchEvent would otherwise route to the global
    // onerror and vitest would turn into an unhandled error).
    expect(() =>
      send({
        type: 'start',
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
        width: 800,
        height: 600,
      }),
    ).not.toThrow()

    const errs = posted.filter((m) => m.type === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ type: 'error', message: 'boom in sim' })
  })

  it('stringifies a non-Error throw value in the single structured error message', () => {
    forceSimulation.mockImplementationOnce(() => {
      // biome-ignore lint/style/useThrowOnlyError: exercising the non-Error branch
      throw 'plain string failure'
    })

    expect(() =>
      send({
        type: 'start',
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
        width: 800,
        height: 600,
      }),
    ).not.toThrow()

    const errs = posted.filter((m) => m.type === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]?.['message']).toBe('plain string failure')
  })

  it('the global `error` listener remains a fallback for errors that genuinely escape the handler', () => {
    // A failure that never reaches the dispatcher try/catch (e.g. a future
    // async path, or an error thrown outside a `message` event) must still be
    // reported via the worker's global `error` listener — the catch above does
    // not weaken genuine-crash reporting.
    self.dispatchEvent(new ErrorEvent('error', { message: 'uncaught worker crash' }))

    const errs = posted.filter((m) => m.type === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ type: 'error', message: 'uncaught worker crash' })
  })

  it('a normal handler failure does NOT trigger the global `error` fallback (no double-post)', () => {
    // End-to-end guard for #1614: when the dispatcher throws, the catch posts a
    // single structured error and swallows the throw, so the global `error`
    // listener never fires. Exactly one error post results.
    forceSimulation.mockImplementationOnce(() => {
      throw new Error('handler failure')
    })

    send({
      type: 'start',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
      width: 800,
      height: 600,
    })

    const errs = posted.filter((m) => m.type === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ type: 'error', message: 'handler failure' })
  })
})
