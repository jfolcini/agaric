/**
 * Tests for graph-sim-helpers — focuses on observable DOM output of the
 * pure d3 helpers. Uses real d3-selection against jsdom SVG elements
 * (not mocked) so we can assert on the resulting `<g>` / `<title>` /
 * `<text>` tree directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GraphEdge, GraphNode } from '@/lib/graph-types'

import {
  createZoomKeyHandler,
  renderGraphElements,
  ZOOM_STEP,
  zoomIdentity,
} from '../graph-sim-helpers'
import { resetAllShortcuts } from '../keyboard-config'

function makeSvg(): SVGSVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
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

describe('renderGraphElements — dedicated paint layers (#758 item 4)', () => {
  it('renders edges into g.edges-layer and nodes into g.nodes-layer, edges first', () => {
    const svg = makeSvg()
    const nodes: GraphNode[] = [makeNode('a', 'A'), makeNode('b', 'B')]
    const edges: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]

    renderGraphElements(svg, nodes, edges, () => {})

    const edgeLayer = svg.querySelector('g.edges-layer')
    const nodeLayer = svg.querySelector('g.nodes-layer')
    expect(edgeLayer).not.toBeNull()
    expect(nodeLayer).not.toBeNull()

    // All lines live in the edge layer, all node groups in the node layer.
    expect(edgeLayer?.querySelectorAll('line')).toHaveLength(1)
    expect(nodeLayer?.querySelectorAll('g.node')).toHaveLength(2)

    // Edge layer precedes the node layer in document order — SVG painter's
    // order keeps every edge under every node.
    expect(
      (edgeLayer as Element).compareDocumentPosition(nodeLayer as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('renderGraphElements — UX-357 native SVG <title> tooltip', () => {
  it('appends a <title> child carrying the full label inside each node <g>', () => {
    const svg = makeSvg()
    const longLabel = 'A very long page title that exceeds twenty characters'
    const nodes: GraphNode[] = [makeNode('a', 'Short'), makeNode('b', longLabel)]
    const edges: GraphEdge[] = []

    renderGraphElements(svg, nodes, edges, () => {})

    const groups = svg.querySelectorAll('g.node')
    expect(groups).toHaveLength(2)

    const titleTexts = Array.from(svg.querySelectorAll('g.node > title')).map((t) => t.textContent)
    expect(titleTexts).toHaveLength(2)
    expect(titleTexts).toContain('Short')
    expect(titleTexts).toContain(longLabel)
  })

  it('renders the truncated label in <text> while <title> keeps the full label', () => {
    const svg = makeSvg()
    const longLabel = 'This particular page has a very long title beyond twenty chars'
    const nodes: GraphNode[] = [makeNode('a', longLabel)]

    renderGraphElements(svg, nodes, [], () => {})

    const text = svg.querySelector('g.node > text')
    const title = svg.querySelector('g.node > title')
    expect(text?.textContent).toBe(`${longLabel.slice(0, 20)}\u2026`)
    expect(title?.textContent).toBe(longLabel)
  })
})

// \u2500\u2500 createZoomKeyHandler \u2014 keyboard zoom (graphZoomIn/Out/Reset, #1172) \u2500\u2500\u2500\u2500\u2500\u2500
//
// BUG-18 moved the graph zoom chords out of GraphView into rebindable catalog
// entries (`graphZoomIn = '+ / =', graphZoomOut = '-', graphZoomReset = '0'`).
// `createZoomKeyHandler` is the keydown listener that routes each catalog
// binding to the matching d3-zoom transform. We drive real KeyboardEvents
// through it and assert the zoom-behaviour dispatch for every binding (the
// key\u2192action contract), including the `+ / =` alternative and the
// editable-target guard.
describe('createZoomKeyHandler \u2014 keyboard zoom dispatch (#1172)', () => {
  afterEach(() => {
    resetAllShortcuts()
  })

  /** A d3-zoom behaviour stub exposing the two methods the handler calls. */
  function makeZoomBehavior() {
    // `scaleBy` / `transform` receive the transition selection as their first
    // arg; the handler builds that from `select(svg).transition()`. We only
    // assert the second arg (the zoom factor / identity transform).
    return {
      scaleBy: vi.fn(),
      transform: vi.fn(),
    }
  }

  function press(handler: (e: KeyboardEvent) => void, init: KeyboardEventInit): void {
    handler(new KeyboardEvent('keydown', init))
  }

  it('graphZoomIn (`+`) scales by the zoom step', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    press(handler, { key: '+' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBe(ZOOM_STEP)
  })

  it('graphZoomIn also fires on the `=` alternative (`+ / =`)', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    press(handler, { key: '=' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBe(ZOOM_STEP)
  })

  it('graphZoomOut (`-`) scales by the inverse step', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    press(handler, { key: '-' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBeCloseTo(1 / ZOOM_STEP)
    expect(zb.transform).not.toHaveBeenCalled()
  })

  it('graphZoomReset (`0`) transforms to the identity zoom', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    press(handler, { key: '0' })

    expect(zb.transform).toHaveBeenCalledTimes(1)
    expect(zb.transform.mock.calls[0]?.[1]).toBe(zoomIdentity)
    expect(zb.scaleBy).not.toHaveBeenCalled()
  })

  it('ignores the zoom keys when focus is in an editable target', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      // Re-target the event at the editable element.
      const e = new KeyboardEvent('keydown', { key: '0' })
      Object.defineProperty(e, 'target', { value: input })
      handler(e)
      expect(zb.transform).not.toHaveBeenCalled()
      expect(zb.scaleBy).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })

  it('ignores unrelated keys', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal d3 stub
    const handler = createZoomKeyHandler(svg, zb as any)

    press(handler, { key: 'x' })

    expect(zb.scaleBy).not.toHaveBeenCalled()
    expect(zb.transform).not.toHaveBeenCalled()
  })
})
