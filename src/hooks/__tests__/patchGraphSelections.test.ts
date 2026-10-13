/**
 * DOM-level tests for `patchGraphSelections` (#758 item 4).
 *
 * The patch path re-joins edges/nodes on the persistent `g` group when a
 * filter toggle changes the data. Pre-fix, the edge join ran against the
 * whole `g`, so ENTERing `<line>` elements were appended AFTER the node
 * `<g>`s and painted over the nodes. The join is now scoped to the
 * dedicated `g.edges-layer` created by `renderGraphElements`, which always
 * precedes `g.nodes-layer` in document order.
 *
 * Uses real d3-selection against jsdom SVG (the sibling
 * `useGraphSimulation.test.ts` mocks d3 wholesale, so these assertions
 * live in their own file).
 */

import { describe, expect, it, vi } from 'vitest'

import type { GraphEdge, GraphNode } from '@/components/graph/GraphView.helpers'
import {
  applyRovingTabindex,
  patchGraphSelections,
  renderGraphElements,
} from '@/lib/graph-sim-helpers'

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
    is_journal: false,
    backlink_count: 0,
  }
}

describe('patchGraphSelections — edge z-order (#758 item 4)', () => {
  it('appends ENTERing edges inside g.edges-layer, before every node group', () => {
    const svg = makeSvg()
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C')]
    const edges: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]

    const rendered = renderGraphElements(svg, nodes, edges, () => {})

    // Patch with one EXISTING edge plus one NEW edge (e.g. a filter was
    // cleared and a previously hidden edge re-enters).
    const patchedEdges: GraphEdge[] = [
      { source: 'a', target: 'b', ref_count: 1 },
      { source: 'b', target: 'c', ref_count: 2 },
    ]
    patchGraphSelections(
      rendered.g,
      nodes.map((n) => Object.assign({}, n)),
      patchedEdges,
      () => {},
    )

    // Both lines (including the entering one) live inside the edge layer.
    const edgeLayer = svg.querySelector('g.edges-layer') as Element
    expect(edgeLayer.querySelectorAll('line')).toHaveLength(2)
    // No stray lines outside the layer.
    expect(svg.querySelectorAll('line')).toHaveLength(2)

    // Every line precedes every node group in document order, so nodes
    // paint on top of edges (SVG painter's order).
    const lines = Array.from(svg.querySelectorAll('line'))
    const nodeGroups = Array.from(svg.querySelectorAll('g.node'))
    expect(nodeGroups).toHaveLength(3)
    for (const line of lines) {
      for (const group of nodeGroups) {
        expect(line.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
    }
  })

  it('ENTERs new node groups inside g.nodes-layer and EXITs removed ones', () => {
    const svg = makeSvg()
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B')]
    const edges: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]

    const rendered = renderGraphElements(svg, nodes, edges, () => {})

    // Patch to a different node set: 'b' removed, 'c' added.
    patchGraphSelections(rendered.g, [makeNode('a', 'A'), makeNode('c', 'C')], [], () => {})

    const nodeLayer = svg.querySelector('g.nodes-layer') as Element
    const labels = Array.from(nodeLayer.querySelectorAll('g.node > title')).map(
      (t) => t.textContent,
    )
    expect(labels).toHaveLength(2)
    expect(labels).toContain('A')
    expect(labels).toContain('C')
    // No node groups leaked outside the layer.
    expect(svg.querySelectorAll('g.node')).toHaveLength(2)
    // The stale edge EXITed with the patch's empty edge data.
    expect(svg.querySelectorAll('line')).toHaveLength(0)
  })
})

describe('patchGraphSelections — #1725 accessible name on the filter-toggle path', () => {
  it('sets aria-label on ENTERing nodes and applyRovingTabindex yields one tab stop', () => {
    const svg = makeSvg()
    const rendered = renderGraphElements(svg, [makeNode('a', 'Alpha')], [], () => {})

    // Filter toggle reveals two more pages.
    const patchedNodes = [makeNode('a', 'Alpha'), makeNode('b', 'Beta'), makeNode('c', 'Gamma')]
    const { node } = patchGraphSelections(rendered.g, patchedNodes, [], () => {})

    const labels = Array.from(svg.querySelectorAll('g.node')).map((g) =>
      g.getAttribute('aria-label'),
    )
    expect(labels).toEqual(['Alpha', 'Beta', 'Gamma'])

    // The patch effect re-establishes roving tabindex on the merged selection.
    applyRovingTabindex(node)
    const tabindexes = Array.from(svg.querySelectorAll('g.node')).map((g) =>
      g.getAttribute('tabindex'),
    )
    expect(tabindexes.filter((t) => t === '0')).toHaveLength(1)
  })

  it('refreshes aria-label for renamed pages on UPDATE', () => {
    const svg = makeSvg()
    const rendered = renderGraphElements(svg, [makeNode('a', 'Old name')], [], () => {})

    patchGraphSelections(rendered.g, [makeNode('a', 'New name')], [], () => {})

    expect(svg.querySelector('g.node')?.getAttribute('aria-label')).toBe('New name')
  })
})

describe('patchGraphSelections — one draw path for the first render and patches (#5427)', () => {
  it('a node and edge ENTERed by a patch match the first render, in markup and in every listener', () => {
    const nodes = [makeNode('a', 'Alpha'), makeNode('b', 'A page title longer than twenty')]
    const edges: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 3 }]
    const firstNavigate = vi.fn()
    const patchNavigate = vi.fn()

    const first = makeSvg()
    renderGraphElements(first, nodes, edges, firstNavigate)

    // 'b' and the edge are absent from the first render and ENTER via the patch.
    const patched = makeSvg()
    const rendered = renderGraphElements(patched, [makeNode('a', 'Alpha')], [], patchNavigate)
    patchGraphSelections(rendered.g, nodes, edges, patchNavigate)

    expect(patched.innerHTML).toBe(first.innerHTML)

    const nodeB = (svg: SVGSVGElement): Element => svg.querySelectorAll('g.node')[1] as Element
    const events: Array<() => Event> = [
      () => new Event('focus'),
      () => new Event('mouseenter'),
      () => new Event('pointerdown'),
      () => new Event('pointerup'),
      () => new Event('mouseleave'),
      () => new Event('blur'),
      // Roving: End moves tabindex="0" from 'a' to 'b'.
      () => new KeyboardEvent('keydown', { key: 'End', cancelable: true }),
    ]
    for (const makeEvent of events) {
      const before = first.innerHTML
      nodeB(first).dispatchEvent(makeEvent())
      nodeB(patched).dispatchEvent(makeEvent())
      // Every replayed event restyles the graph, so equality below is not two no-ops.
      expect(first.innerHTML, makeEvent().type).not.toBe(before)
      expect(patched.innerHTML, makeEvent().type).toBe(first.innerHTML)
    }

    for (const svg of [first, patched]) {
      nodeB(svg).dispatchEvent(new Event('click'))
      nodeB(svg).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    }
    const opened = ['b', 'A page title longer than twenty']
    expect(firstNavigate.mock.calls).toEqual([opened, opened])
    expect(patchNavigate.mock.calls).toEqual([opened, opened])
  })

  it('every patch re-binds a kept node to the latest navigate, without stacking listeners', () => {
    const svg = makeSvg()
    const nodes = [makeNode('a', 'Alpha')]
    const [renderNavigate, patchNavigate, latestNavigate] = [vi.fn(), vi.fn(), vi.fn()]

    const rendered = renderGraphElements(svg, nodes, [], renderNavigate)
    patchGraphSelections(rendered.g, nodes, [], patchNavigate)
    patchGraphSelections(rendered.g, nodes, [], latestNavigate)

    const nodeA = svg.querySelector('g.node') as Element
    nodeA.dispatchEvent(new Event('click'))
    nodeA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))

    expect(renderNavigate).not.toHaveBeenCalled()
    expect(patchNavigate).not.toHaveBeenCalled()
    expect(latestNavigate.mock.calls).toEqual([
      ['a', 'Alpha'],
      ['a', 'Alpha'],
    ])
  })
})
