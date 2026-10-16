/**
 * Under reduced motion the worker lays the graph out at once, as the
 * main-thread fallback does, instead of posting every tick of an animated
 * settle. Runs the real d3-force, so the posted layout is compared with the
 * main-thread path's.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

function rendered() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  return renderGraphElements(svg, NODES, EDGES, NO_ACTIONS)
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
  return Float32Array.from(r.simNodes.flatMap((n) => [n.x ?? 0, n.y ?? 0]))
}

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

  /** Long enough for d3's timer to run several animated ticks. */
  const afewFrames = () => new Promise((resolve) => setTimeout(resolve, 100))

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
})
