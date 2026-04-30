/**
 * Tests for useGraphRenderElements (MAINT-127 split from useGraphSimulation).
 *
 * The hook returns a stable callback that materializes d3 node + edge
 * selections for the orchestrator. Tests focus on observable effects
 * (selection chain calls, nodeById population) and callback stability
 * across re-renders.
 */

import { renderHook } from '@testing-library/react'
import { select } from 'd3-selection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, GraphNode } from '../../components/GraphView.helpers'
import { useGraphRenderElements } from '../useGraphRenderElements'

vi.mock('d3-selection', () => ({
  select: vi.fn(() => ({
    selectAll: vi.fn().mockReturnThis(),
    data: vi.fn().mockReturnThis(),
    join: vi.fn().mockReturnThis(),
    attr: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    call: vi.fn().mockReturnThis(),
    append: vi.fn(() => ({
      selectAll: vi.fn().mockReturnThis(),
      data: vi.fn().mockReturnThis(),
      join: vi.fn().mockReturnThis(),
      attr: vi.fn().mockReturnThis(),
      text: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      call: vi.fn().mockReturnThis(),
      append: vi.fn().mockReturnThis(),
      style: vi.fn().mockReturnThis(),
      filter: vi.fn().mockReturnThis(),
      datum: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      node: vi.fn().mockReturnValue(null),
    })),
    remove: vi.fn().mockReturnThis(),
    style: vi.fn().mockReturnThis(),
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
    {
      id: 'b',
      label: 'B',
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
  return [{ source: 'a', target: 'b', ref_count: 1 }]
}

function makeFakeSvg(width = 800, height = 600): SVGSVGElement {
  // jsdom's clientWidth/clientHeight default to 0 — set explicit values so
  // renderGraphElements stops short-circuiting to DEFAULT_WIDTH/HEIGHT.
  return { clientWidth: width, clientHeight: height } as unknown as SVGSVGElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useGraphRenderElements', () => {
  it('returns a callable render function', () => {
    const { result } = renderHook(() =>
      useGraphRenderElements({
        nodes: makeNodes(),
        edges: makeEdges(),
        navigateToPage: () => {},
      }),
    )
    expect(typeof result.current).toBe('function')
  })

  it('rendering invokes d3-selection chain on the SVG', () => {
    const { result } = renderHook(() =>
      useGraphRenderElements({
        nodes: makeNodes(),
        edges: makeEdges(),
        navigateToPage: () => {},
      }),
    )
    const svg = makeFakeSvg()
    const out = result.current(svg)
    expect(select).toHaveBeenCalledWith(svg)
    expect(out.simNodes).toHaveLength(2)
    expect(out.simEdges).toHaveLength(1)
  })

  it('builds nodeById map keyed by node id', () => {
    const { result } = renderHook(() =>
      useGraphRenderElements({
        nodes: makeNodes(),
        edges: makeEdges(),
        navigateToPage: () => {},
      }),
    )
    const out = result.current(makeFakeSvg())
    expect(out.nodeById.get('a')?.id).toBe('a')
    expect(out.nodeById.get('b')?.id).toBe('b')
    expect(out.nodeById.size).toBe(2)
  })

  it('clones nodes/edges so d3 mutations do not leak into props', () => {
    const nodes = makeNodes()
    const edges = makeEdges()
    const { result } = renderHook(() =>
      useGraphRenderElements({ nodes, edges, navigateToPage: () => {} }),
    )
    const out = result.current(makeFakeSvg())
    expect(out.simNodes[0]).not.toBe(nodes[0])
    expect(out.simEdges[0]).not.toBe(edges[0])
  })

  it('returns the same callback identity when nodes/edges/navigate are stable', () => {
    const nodes = makeNodes()
    const edges = makeEdges()
    const navigateToPage = vi.fn()
    const { result, rerender } = renderHook(() =>
      useGraphRenderElements({ nodes, edges, navigateToPage }),
    )
    const before = result.current
    rerender()
    expect(result.current).toBe(before)
  })

  it('returns dimensions from the SVG (or defaults when zero)', () => {
    const { result } = renderHook(() =>
      useGraphRenderElements({
        nodes: makeNodes(),
        edges: makeEdges(),
        navigateToPage: () => {},
      }),
    )
    const out = result.current(makeFakeSvg(1024, 768))
    expect(out.width).toBe(1024)
    expect(out.height).toBe(768)

    // clientWidth=0 falls back to DEFAULT_WIDTH (800).
    const zeroSvg = makeFakeSvg(0, 0)
    const out2 = result.current(zeroSvg)
    expect(out2.width).toBe(800)
    expect(out2.height).toBe(600)
  })
})
