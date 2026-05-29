/**
 * Tests for graph-sim-helpers — focuses on observable DOM output of the
 * pure d3 helpers. Uses real d3-selection against jsdom SVG elements
 * (not mocked) so we can assert on the resulting `<g>` / `<title>` /
 * `<text>` tree directly.
 */

import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '@/components/GraphView.helpers'

import { renderGraphElements } from '../graph-sim-helpers'

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
