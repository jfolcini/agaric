/**
 * Tests for `runWorkerSimulation`'s rAF tick-coalescing (#747 item 2) and its
 * `resize` message dispatch (#747 item 1, main-thread side).
 *
 * The worker posts a full position array on EVERY tick (~300 ticks); applying
 * each immediately is the main-thread hot spot at 1-2k nodes. We coalesce to
 * one `applyPositions` per animation frame. `done` flushes synchronously so
 * the final settled layout is exact.
 *
 * We stub the global `Worker` with a controllable fake (so we can dispatch
 * `message` events to the listener `runWorkerSimulation` registers) and a
 * manual `requestAnimationFrame` queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import type { WorkerOutboundMessage } from '@/workers/graph-worker-types'

import { renderGraphElements, runWorkerSimulation, type SimulationCtx } from '../graph-sim-helpers'

// ── Controllable Worker stub ─────────────────────────────────────────

class FakeWorker {
  listeners: Record<string, Array<(e: Event) => void>> = {}
  posted: Array<{ type: string; [k: string]: unknown }> = []
  terminated = false

  addEventListener(type: string, fn: (e: Event) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg as { type: string })
  }
  terminate(): void {
    this.terminated = true
  }

  /** Deliver a worker → main message to the registered `message` listeners. */
  emit(data: WorkerOutboundMessage): void {
    const evt = { data } as MessageEvent<WorkerOutboundMessage>
    for (const l of this.listeners['message'] ?? []) l(evt as unknown as Event)
  }
}

let lastWorker: FakeWorker | null = null

// ── Manual rAF queue ─────────────────────────────────────────────────

let rafQueue: Array<() => void> = []
let rafSeq = 0
const rafIds = new Map<number, () => void>()

function flushFrame(): void {
  const pending = rafQueue
  rafQueue = []
  for (const cb of pending) cb()
}

function makeCtx(): { ctx: SimulationCtx; applyPositions: ReturnType<typeof vi.fn> } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  const nodes: GraphNode[] = [makeNode('a', 'A'), makeNode('b', 'B')]
  const edges: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]
  const rendered = renderGraphElements(svg, nodes, edges, () => {})
  const applyPositions = vi.fn()
  const ctx: SimulationCtx = {
    simNodes: rendered.simNodes,
    simEdges: rendered.simEdges,
    nodeById: rendered.nodeById,
    node: rendered.node,
    applyPositions,
    width: 800,
    height: 600,
    prefersReducedMotion: false,
  }
  return { ctx, applyPositions }
}

function makeNode(id: string, label: string): GraphNode {
  return {
    id,
    label,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    is_template: false,
    backlink_count: 0,
  }
}

describe('runWorkerSimulation — rAF tick coalescing (#747 item 2)', () => {
  beforeEach(() => {
    lastWorker = null
    rafQueue = []
    rafIds.clear()
    rafSeq = 0

    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          lastWorker = new FakeWorker()
          return lastWorker as unknown as Worker
        }
      },
    )
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafSeq
      const wrapped = (): void => {
        rafIds.delete(id)
        cb(performance.now())
      }
      rafIds.set(id, wrapped)
      rafQueue.push(wrapped)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const cb = rafIds.get(id)
      rafIds.delete(id)
      rafQueue = rafQueue.filter((c) => c !== cb)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coalesces multiple ticks within a frame into a single applyPositions', () => {
    const { ctx, applyPositions } = makeCtx()
    const handle = runWorkerSimulation({ ...ctx, onWorkerFailed: () => {} })
    const worker = lastWorker as unknown as FakeWorker

    // Three ticks arrive before the frame fires.
    worker.emit({
      type: 'tick',
      positions: [
        { id: 'a', x: 1, y: 1 },
        { id: 'b', x: 2, y: 2 },
      ],
    })
    worker.emit({
      type: 'tick',
      positions: [
        { id: 'a', x: 3, y: 3 },
        { id: 'b', x: 4, y: 4 },
      ],
    })
    worker.emit({
      type: 'tick',
      positions: [
        { id: 'a', x: 5, y: 5 },
        { id: 'b', x: 6, y: 6 },
      ],
    })

    // No DOM application yet — all batched into one pending frame.
    expect(applyPositions).not.toHaveBeenCalled()

    flushFrame()

    // Exactly one application for the three ticks, using the LATEST positions.
    expect(applyPositions).toHaveBeenCalledTimes(1)
    expect(ctx.nodeById.get('a')?.x).toBe(5)
    expect(ctx.nodeById.get('b')?.y).toBe(6)

    handle.cleanup()
  })

  it('applies once per frame across multiple frames', () => {
    const { ctx, applyPositions } = makeCtx()
    const handle = runWorkerSimulation({ ...ctx, onWorkerFailed: () => {} })
    const worker = lastWorker as unknown as FakeWorker

    worker.emit({ type: 'tick', positions: [{ id: 'a', x: 1, y: 1 }] })
    worker.emit({ type: 'tick', positions: [{ id: 'a', x: 2, y: 2 }] })
    flushFrame()
    expect(applyPositions).toHaveBeenCalledTimes(1)

    worker.emit({ type: 'tick', positions: [{ id: 'a', x: 3, y: 3 }] })
    flushFrame()
    expect(applyPositions).toHaveBeenCalledTimes(2)

    handle.cleanup()
  })

  it('done flushes synchronously with the final settled positions (cancels pending frame)', () => {
    const { ctx, applyPositions } = makeCtx()
    const handle = runWorkerSimulation({ ...ctx, onWorkerFailed: () => {} })
    const worker = lastWorker as unknown as FakeWorker

    // A tick schedules a frame...
    worker.emit({
      type: 'tick',
      positions: [
        { id: 'a', x: 9, y: 9 },
        { id: 'b', x: 9, y: 9 },
      ],
    })
    // ...then `done` arrives before the frame fires.
    worker.emit({
      type: 'done',
      positions: [
        { id: 'a', x: 100, y: 200 },
        { id: 'b', x: 300, y: 400 },
      ],
    })

    // `done` applied synchronously with the settled positions.
    expect(applyPositions).toHaveBeenCalledTimes(1)
    expect(ctx.nodeById.get('a')?.x).toBe(100)
    expect(ctx.nodeById.get('b')?.y).toBe(400)

    // The previously-scheduled tick frame was cancelled — flushing does nothing
    // (would otherwise clobber the settled layout with stale tick positions).
    flushFrame()
    expect(applyPositions).toHaveBeenCalledTimes(1)
    expect(ctx.nodeById.get('a')?.x).toBe(100)

    handle.cleanup()
  })

  it('cleanup cancels any pending animation frame', () => {
    const { ctx, applyPositions } = makeCtx()
    const handle = runWorkerSimulation({ ...ctx, onWorkerFailed: () => {} })
    const worker = lastWorker as unknown as FakeWorker

    worker.emit({ type: 'tick', positions: [{ id: 'a', x: 1, y: 1 }] })
    handle.cleanup()
    flushFrame()

    expect(applyPositions).not.toHaveBeenCalled()
    expect(worker.terminated).toBe(true)
  })

  it('onResize posts a `resize` message (not a full `start` re-seed)', () => {
    const { ctx } = makeCtx()
    const handle = runWorkerSimulation({ ...ctx, onWorkerFailed: () => {} })
    const worker = lastWorker as unknown as FakeWorker

    // First post is the initial `start`.
    expect(worker.posted[0]?.type).toBe('start')

    handle.onResize(1000, 400)

    const resize = worker.posted.find((m) => m.type === 'resize')
    expect(resize).toEqual({ type: 'resize', width: 1000, height: 400 })
    // Did NOT re-post `start` on resize (no second start message).
    expect(worker.posted.filter((m) => m.type === 'start')).toHaveLength(1)

    handle.cleanup()
  })
})
