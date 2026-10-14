/**
 * Coming back to the graph restores it (#5434): unmounting keeps where each
 * node settled and the zoom transform; the next mount seeds them. Real d3
 * against the DOM, as in `useGraphSimulation.currentPage.test.tsx`. The worker
 * is a recorder whose `start` payload is what the simulation starts from.
 */

import { act, render } from '@testing-library/react'
import { zoomIdentity } from 'd3-zoom'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type GraphLayoutStore, useGraphSimulation } from '@/hooks/useGraphSimulation'
import type { GraphLayout } from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import type { WorkerStartMessage } from '@/workers/graph-worker-types'

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
  /** The worker reports the layout it settled on, packed in node order. */
  settle(points: Array<[number, number]>): void {
    this.onMessage?.({
      data: { type: 'done', positions: new Float32Array(points.flat()), count: points.length },
    })
  }
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
    is_journal: false,
    backlink_count: 0,
  }
}

const A = makeNode('a', 'Alpha')
const B = makeNode('b', 'Beta')
const C = makeNode('c', 'Gamma')
const EDGES: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]

function memoryLayout(initial: GraphLayout | null = null): GraphLayoutStore & {
  kept: GraphLayout | null
} {
  const store = {
    kept: initial,
    read: () => store.kept,
    keep: (layout: GraphLayout) => {
      store.kept = layout
    },
  }
  return store
}

function Graph({
  nodes,
  layout,
}: {
  nodes: GraphNode[]
  layout: GraphLayoutStore
}): React.ReactElement {
  const svgRef = useRef<SVGSVGElement>(null)
  useGraphSimulation({
    svgRef,
    nodes,
    edges: EDGES,
    navigateToPage: () => {},
    currentPageId: null,
    layout,
  })
  return <svg ref={svgRef} aria-label="Graph" />
}

function startMessage(): WorkerStartMessage {
  const start = RecordingWorker.last?.posted.find((m) => m.type === 'start')
  if (!start) throw new Error('no start posted')
  return start as WorkerStartMessage
}

function paintedAt(container: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(
    Array.from(container.querySelectorAll('g.node')).map((g) => [
      g.getAttribute('aria-label'),
      g.getAttribute('transform'),
    ]),
  )
}

const KEPT: GraphLayout = {
  positions: new Map([
    ['a', { x: 120, y: 80 }],
    ['b', { x: 300, y: 210 }],
  ]),
  transform: zoomIdentity.translate(40, -25).scale(1.69),
  settled: false,
}

beforeEach(() => {
  RecordingWorker.last = null
  vi.stubGlobal('Worker', RecordingWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useGraphSimulation — coming back to the graph (#5434)', () => {
  it('lays a graph with nothing kept out from scratch', () => {
    const { container } = render(<Graph nodes={[A, B]} layout={memoryLayout()} />)

    expect(startMessage().nodes).toEqual([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ])
    expect(container.querySelector('svg > g')?.getAttribute('transform')).toBeNull()
  })

  it('keeps where the nodes settled and the zoom when it unmounts', () => {
    const layout = memoryLayout()
    const { unmount } = render(<Graph nodes={[A, B]} layout={layout} />)
    act(() =>
      RecordingWorker.last?.settle([
        [10, 20],
        [30, 40],
      ]),
    )

    unmount()

    expect(layout.kept?.positions).toEqual(
      new Map([
        ['a', { x: 10, y: 20 }],
        ['b', { x: 30, y: 40 }],
      ]),
    )
    expect(layout.kept?.transform).toEqual(zoomIdentity)
    expect(layout.kept?.settled).toBe(true)
  })

  it('tells the simulation whether the kept layout had settled', () => {
    render(<Graph nodes={[A, B]} layout={memoryLayout({ ...KEPT, settled: true })} />)
    expect(startMessage().keptSettled).toBe(true)
  })

  it('comes back where it was left: positions, first paint and transform', () => {
    const layout = memoryLayout(KEPT)
    const { container, unmount } = render(<Graph nodes={[A, B]} layout={layout} />)

    expect(startMessage().nodes).toEqual([
      { id: 'a', label: 'Alpha', x: 120, y: 80 },
      { id: 'b', label: 'Beta', x: 300, y: 210 },
    ])
    expect(startMessage().keptSettled).toBe(false)
    expect(paintedAt(container)).toEqual({
      Alpha: 'translate(120,80)',
      Beta: 'translate(300,210)',
    })
    const edge = container.querySelector('line')
    expect([1, 2].map((i) => edge?.getAttribute(`x${i}`))).toEqual(['120', '300'])
    expect(container.querySelector('svg > g')?.getAttribute('transform')).toBe(
      KEPT.transform.toString(),
    )

    unmount()
    expect(layout.kept?.positions).toEqual(KEPT.positions)
    expect(layout.kept?.transform).toEqual(KEPT.transform)
  })

  it('a node added in between arrives without a position, so only it drifts in', () => {
    render(<Graph nodes={[A, B, C]} layout={memoryLayout(KEPT)} />)

    expect(startMessage().nodes).toEqual([
      { id: 'a', label: 'Alpha', x: 120, y: 80 },
      { id: 'b', label: 'Beta', x: 300, y: 210 },
      { id: 'c', label: 'Gamma' },
    ])
  })

  it('the main-thread fallback starts from the kept positions too', () => {
    vi.stubGlobal('Worker', undefined)
    const { container } = render(<Graph nodes={[A, B]} layout={memoryLayout(KEPT)} />)

    expect(RecordingWorker.last).toBeNull()
    expect(paintedAt(container)).toEqual({
      Alpha: 'translate(120,80)',
      Beta: 'translate(300,210)',
    })
    expect(container.querySelector('svg > g')?.getAttribute('transform')).toBe(
      KEPT.transform.toString(),
    )
  })
})
