/**
 * Labels are chosen where the layout or the zoom comes to rest (#5430): the
 * overlap pass runs when the simulation settles and when a zoom ends, never per
 * tick. Real d3 against the DOM, as in `useGraphSimulation.restore.test.tsx`;
 * the worker is a recorder the test drives, and `visibleLabels` is wrapped in a
 * spy that counts the passes.
 */

import { act, render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type GraphLayoutStore, useGraphSimulation } from '@/hooks/useGraphSimulation'
import { visibleLabels } from '@/lib/graph-labels'
import { fitTransform, type GraphLayout } from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'

vi.mock('@/lib/graph-labels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph-labels')>()
  return { ...actual, visibleLabels: vi.fn(actual.visibleLabels) }
})

class RecordingWorker {
  static last: RecordingWorker | null = null
  private onMessage: ((event: { data: unknown }) => void) | null = null
  constructor() {
    RecordingWorker.last = this
  }
  postMessage(): void {}
  addEventListener(type: string, handler: (event: { data: unknown }) => void): void {
    if (type === 'message') this.onMessage = handler
  }
  removeEventListener(): void {}
  terminate(): void {}
  emit(type: 'tick' | 'done', points: Array<[number, number]>): void {
    this.onMessage?.({
      data: { type, positions: new Float32Array(points.flat()), count: points.length },
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

const NODES = [makeNode('a', 'Alpha'), makeNode('b', 'Beta'), makeNode('c', 'Gamma')]
const EDGES: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]
const NO_ACTIONS = { select() {}, open() {}, openInNewTab() {} }

function noLayout(): GraphLayoutStore {
  return { read: (): GraphLayout | null => null, keep() {} }
}

function Graph(): React.ReactElement {
  const svgRef = useRef<SVGSVGElement>(null)
  useGraphSimulation({
    svgRef,
    nodes: NODES,
    edges: EDGES,
    actions: NO_ACTIONS,
    currentPageId: null,
    selectedPageId: null,
    layout: noLayout(),
  })
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- GraphView's canvas: the d3-drawn nodes are its options
  return <svg ref={svgRef} role="listbox" aria-label="Graph" />
}

let frames: FrameRequestCallback[] = []

function flushFrames(): void {
  const due = frames
  frames = []
  for (const frame of due) frame(0)
}

beforeEach(() => {
  RecordingWorker.last = null
  frames = []
  vi.stubGlobal('Worker', RecordingWorker)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.mocked(visibleLabels).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useGraphSimulation — when labels are chosen (#5430)', () => {
  it('chooses labels when the layout settles and when the fit that follows ends, never per tick', async () => {
    const { container } = render(<Graph />)
    const worker = RecordingWorker.last as RecordingWorker
    const atMount = vi.mocked(visibleLabels).mock.calls.length
    expect(atMount).toBeGreaterThan(0)

    for (let i = 1; i <= 30; i++) {
      act(() => {
        worker.emit('tick', [
          [i, i],
          [100, 2 * i],
          [3 * i, 200],
        ])
        flushFrames()
      })
    }
    expect(container.querySelector('g.node')?.getAttribute('transform')).toBe('translate(30,30)')
    expect(visibleLabels).toHaveBeenCalledTimes(atMount)

    const settled: Array<[number, number]> = [
      [0, 0],
      [100, 60],
      [90, 200],
    ]
    act(() => worker.emit('done', settled))
    expect(visibleLabels).toHaveBeenCalledTimes(atMount + 1)

    const fitted = fitTransform(
      settled.map(([x, y]) => ({ x, y })),
      800,
      600,
    )
    await waitFor(() => expect(visibleLabels).toHaveBeenCalledTimes(atMount + 2))
    expect(vi.mocked(visibleLabels).mock.lastCall?.[1]).toBeCloseTo(fitted.k)
    expect(Number(container.querySelector('g.nodes-layer')?.getAttribute('font-size'))).toBeCloseTo(
      12 / fitted.k,
    )
  })
})
