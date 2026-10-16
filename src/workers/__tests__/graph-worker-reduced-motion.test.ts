/**
 * Under reduced motion the worker lays the graph out at once, as the
 * main-thread fallback does, instead of posting every tick of an animated
 * settle. Runs the real d3-force, so the posted layout is compared with the
 * main-thread path's, and each path's layout is checked for having settled.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { LINK_DISTANCE } from '@/lib/graph-forces'
import {
  type NodeActions,
  renderGraphElements,
  runMainThreadSimulation,
} from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import type { WorkerInboundMessage, WorkerOutboundMessage } from '@/workers/graph-worker-types'

const NO_ACTIONS: NodeActions = { select() {}, open() {}, openInNewTab() {}, reveal() {} }

function makeNode(id: string): GraphNode {
  return {
    id,
    label: id,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    is_template: false,
    is_journal: false,
    backlink_count: 0,
  }
}

const NODES = ['hub', 'a', 'b', 'c', 'loose'].map(makeNode)
const EDGES: GraphEdge[] = ['a', 'b', 'c'].map((id) => ({
  source: 'hub',
  target: id,
  ref_count: 1,
}))

function rendered(nodes = NODES, edges = EDGES) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  return renderGraphElements(svg, nodes, edges, NO_ACTIONS)
}

/** `NODES` plus a page `d` that newly links to the hub. */
const GROWN_NODES = [...NODES, makeNode('d')]
const GROWN_EDGES: GraphEdge[] = [...EDGES, { source: 'hub', target: 'd', ref_count: 1 }]

/**
 * At rest the link spring balances charge and collision, which stretch each
 * link a few px past its rest length. A layout the link force never acted on
 * keeps d3's seed spacing, tens of px short of it.
 */
const SETTLED_LINK_SLACK = 5

/** Every hub link of a layout, given as `[x0,y0,x1,y1,…]` in `ids` order, is at rest length. */
function expectLinksSettled(positions: ArrayLike<number>, ids: readonly string[]): void {
  const at = (id: string) => {
    const i = ids.indexOf(id)
    return { x: positions[i * 2] as number, y: positions[i * 2 + 1] as number }
  }
  const hub = at('hub')
  for (const id of ids.filter((i) => i !== 'hub' && i !== 'loose')) {
    const leaf = at(id)
    const length = Math.hypot(leaf.x - hub.x, leaf.y - hub.y)
    expect(Math.abs(length - LINK_DISTANCE), `hub-${id} link length ${length}`).toBeLessThan(
      SETTLED_LINK_SLACK,
    )
  }
}

function positionsOf(nodes: readonly GraphNode[]): number[] {
  return nodes.flatMap((n) => [n.x ?? 0, n.y ?? 0])
}

/** The layout the main-thread fallback shows a reduced-motion user. */
function mainThreadLayout(): Float32Array {
  const r = rendered()
  runMainThreadSimulation({
    ...r,
    applyPositions: () => {},
    prefersReducedMotion: true,
    keptSettled: false,
    onSettled: () => {},
  }).cleanup()
  return Float32Array.from(positionsOf(r.simNodes))
}

/** Long enough for d3's timer to run several animated ticks. */
const afewFrames = () => new Promise((resolve) => setTimeout(resolve, 100))

const IDS = NODES.map((n) => n.id)

function mouse(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }),
  )
}

describe('main-thread layout under reduced motion', () => {
  /** A reduced-motion main-thread layout, ready for its hub to be pressed. */
  function mountForDrag() {
    const r = rendered()
    const counts = { applied: 0 }
    const handle = runMainThreadSimulation({
      ...r,
      applyPositions: () => {
        counts.applied++
      },
      prefersReducedMotion: true,
      keptSettled: false,
      onSettled: () => {},
    })
    const hub = r.node.nodes()[IDS.indexOf('hub')] as SVGGElement
    // happy-dom gives SVG no screen geometry (no `matrixTransform`, no
    // `clientLeft`), so let d3's pointer read client coordinates as they are.
    Object.defineProperty(hub.ownerSVGElement, 'createSVGPoint', { value: undefined })
    Object.defineProperties(hub.parentNode, { clientLeft: { value: 0 }, clientTop: { value: 0 } })
    counts.applied = 0
    return { r, counts, handle, hub, hubNode: r.simNodes[IDS.indexOf('hub')] as GraphNode }
  }

  it('settles at once when a dragged node is let go, then stays still', async () => {
    const { r, counts, handle, hub, hubNode } = mountForDrag()
    const { x = 0, y = 0 } = hubNode
    mouse(hub, 'mousedown', 0, 0)
    mouse(window, 'mousemove', 80, 40)
    expect([hubNode.fx, hubNode.fy]).toEqual([x + 80, y + 40])
    await afewFrames()

    counts.applied = 0
    mouse(window, 'mouseup', 80, 40)
    expect(counts.applied).toBe(1)
    const released = positionsOf(r.simNodes)
    expectLinksSettled(released, IDS)

    await afewFrames()
    expect(counts.applied).toBe(1)
    expect(positionsOf(r.simNodes)).toEqual(released)
    handle.cleanup()
  })

  it('leaves the layout exactly as it was when a node is only clicked', async () => {
    const { r, counts, handle, hub } = mountForDrag()
    const before = positionsOf(r.simNodes)
    mouse(hub, 'mousedown', 0, 0)
    await afewFrames()
    mouse(window, 'mouseup', 0, 0)
    await afewFrames()

    expect(positionsOf(r.simNodes)).toEqual(before)
    expect(counts.applied).toBe(0)
    handle.cleanup()
  })

  it('settles at mount, after an update and after a resize', () => {
    const first = rendered()
    const handle = runMainThreadSimulation({
      ...first,
      applyPositions: () => {},
      prefersReducedMotion: true,
      keptSettled: false,
      onSettled: () => {},
    })
    expectLinksSettled(
      positionsOf(first.simNodes),
      NODES.map((n) => n.id),
    )

    const next = rendered(GROWN_NODES, GROWN_EDGES)
    for (const n of next.simNodes) {
      const kept = first.simNodes.find((k) => k.id === n.id)
      if (kept) Object.assign(n, { x: kept.x, y: kept.y, vx: kept.vx, vy: kept.vy })
    }
    handle.onUpdate({
      ...next,
      applyPositions: () => {},
      prefersReducedMotion: true,
      keptSettled: false,
      onSettled: () => {},
    })
    expectLinksSettled(
      positionsOf(next.simNodes),
      GROWN_NODES.map((n) => n.id),
    )

    handle.onResize(400, 300)
    expectLinksSettled(
      positionsOf(next.simNodes),
      GROWN_NODES.map((n) => n.id),
    )
    handle.cleanup()
  })
})

describe('graph worker under reduced motion', () => {
  let posted: WorkerOutboundMessage[]

  beforeAll(async () => {
    await import('@/workers/graph-worker')
  })

  beforeEach(() => {
    posted = []
    vi.spyOn(self, 'postMessage').mockImplementation(((msg: WorkerOutboundMessage) => {
      posted.push(msg)
    }) as typeof self.postMessage)
  })

  afterEach(() => {
    send({ type: 'stop' })
    vi.restoreAllMocks()
  })

  function send(data: WorkerInboundMessage): void {
    self.dispatchEvent(new MessageEvent('message', { data }))
  }

  function start(): void {
    const r = rendered()
    send({
      type: 'start',
      nodes: r.simNodes.map((n) => ({ id: n.id, label: n.label, degree: n.degree ?? 0 })),
      edges: EDGES.map((e) => ({ source: 'hub', target: e.target as string, ref_count: 1 })),
      width: r.width,
      height: r.height,
      keptSettled: false,
      reducedMotion: true,
    })
  }

  it('posts only the settled layout, the one the main-thread path shows', async () => {
    start()

    expect(posted.map((m) => m.type)).toEqual(['done'])
    const done = posted[0] as Extract<WorkerOutboundMessage, { type: 'done' }>
    expect(done.positions).toEqual(mainThreadLayout())

    await afewFrames()
    expect(posted.map((m) => m.type)).toEqual(['done'])
  })

  it('lays out an update and a resize at once too', async () => {
    start()
    posted = []

    const moved = rendered().simNodes.slice(0, 3)
    send({
      type: 'update',
      nodes: moved.map((n) => ({ id: n.id, label: n.label, degree: 1, x: 10, y: 20 })),
      edges: [{ source: 'hub', target: 'a', ref_count: 1 }],
    })
    expect(posted.map((m) => m.type)).toEqual(['done'])

    send({ type: 'resize', width: 400, height: 300 })
    expect(posted.map((m) => m.type)).toEqual(['done', 'done'])

    await afewFrames()
    expect(posted.map((m) => m.type)).toEqual(['done', 'done'])
  })

  it('lays out at once when a dragged node is let go, then posts nothing', async () => {
    start()
    send({ type: 'drag', phase: 'start', nodeId: 'hub', x: 400, y: 300 })
    send({ type: 'drag', phase: 'drag', nodeId: 'hub', x: 480, y: 340 })
    await afewFrames()

    posted = []
    send({ type: 'drag', phase: 'end', nodeId: 'hub', x: 480, y: 340 })
    expect(posted.map((m) => m.type)).toEqual(['done'])
    expectLinksSettled(
      (posted[0] as Extract<WorkerOutboundMessage, { type: 'done' }>).positions,
      IDS,
    )

    await afewFrames()
    expect(posted.map((m) => m.type)).toEqual(['done'])
  })

  it('posts nothing when a node is only clicked', async () => {
    start()
    posted = []
    send({ type: 'drag', phase: 'start', nodeId: 'hub', x: 400, y: 300 })
    await afewFrames()
    send({ type: 'drag', phase: 'end', nodeId: 'hub', x: 400, y: 300 })
    await afewFrames()

    expect(posted).toEqual([])
  })

  it('posts a settled layout at start, after an update and after a resize', () => {
    const lastDone = () =>
      (posted.at(-1) as Extract<WorkerOutboundMessage, { type: 'done' }>).positions
    start()
    const first = lastDone()
    expectLinksSettled(
      first,
      NODES.map((n) => n.id),
    )

    const grown = rendered(GROWN_NODES, GROWN_EDGES).simNodes
    send({
      type: 'update',
      nodes: grown.map((n, i) =>
        Object.assign(
          { id: n.id, label: n.label, degree: n.degree ?? 0 },
          i < NODES.length ? { x: first[i * 2] ?? 0, y: first[i * 2 + 1] ?? 0 } : {},
        ),
      ),
      edges: GROWN_EDGES.map((e) => ({ source: 'hub', target: e.target as string, ref_count: 1 })),
    })
    expectLinksSettled(
      lastDone(),
      GROWN_NODES.map((n) => n.id),
    )

    send({ type: 'resize', width: 400, height: 300 })
    expectLinksSettled(
      lastDone(),
      GROWN_NODES.map((n) => n.id),
    )
  })
})
