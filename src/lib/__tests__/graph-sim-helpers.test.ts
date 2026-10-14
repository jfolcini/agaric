/**
 * Tests for graph-sim-helpers — focuses on observable DOM output of the
 * pure d3 helpers. Uses real d3-selection against jsdom SVG elements
 * (not mocked) so we can assert on the resulting `<g>` / `<title>` /
 * `<text>` tree directly.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { zoomIdentity } from 'd3-zoom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { nodeRadius } from '@/lib/graph-forces'
import {
  createZoomKeyHandler,
  fitTransform,
  packPositions,
  patchGraphSelections,
  reducedMotionDuration,
  renderGraphElements,
  unpackPositions,
  ZOOM_BUTTON_DURATION_MS,
  ZOOM_FIT_DURATION_MS,
  ZOOM_STEP,
} from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import { resetAllShortcuts } from '@/lib/keyboard-config'

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

describe('renderGraphElements — edges recede (#5428)', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeNode(id, id.toUpperCase()))
  const edges: GraphEdge[] = [
    { source: 'a', target: 'b', ref_count: 1 },
    { source: 'a', target: 'c', ref_count: 2 },
    { source: 'a', target: 'd', ref_count: 5 },
    { source: 'a', target: 'e', ref_count: 6 },
    { source: 'a', target: 'f', ref_count: 40 },
  ]

  it('draws every edge as a 1 px hairline that zooming does not thicken', () => {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {})

    const lines = Array.from(svg.querySelectorAll('line'))
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(line.getAttribute('stroke')).toBe('var(--graph-edge)')
      expect(line.getAttribute('stroke-width')).toBe('1')
      expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    }
  })

  it('starts faint and lets ref_count darken an edge a little, capped at 0.45', () => {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {})

    const opacities = Array.from(svg.querySelectorAll('line')).map((line) =>
      Number(line.getAttribute('stroke-opacity')),
    )
    const expected = [0.2, 0.25, 0.4, 0.45, 0.45]
    expect(opacities).toHaveLength(expected.length)
    expected.forEach((opacity, i) => expect(opacities[i]).toBeCloseTo(opacity))
  })
})

describe('nodeRadius — node size from link count (#5429)', () => {
  it('an unlinked page is the smallest node, and the scale caps at 12', () => {
    expect(nodeRadius(0)).toBe(3)
    expect(nodeRadius(36)).toBe(12)
    expect(nodeRadius(10_000)).toBe(12)
  })

  it('grows with every link up to the cap, so area tracks the link count', () => {
    for (let degree = 0; degree < 36; degree++) {
      expect(nodeRadius(degree + 1)).toBeGreaterThan(nodeRadius(degree))
    }
    // Four times the links, twice the growth: the radius grows with √degree.
    expect(nodeRadius(16) - 3).toBeCloseTo(2 * (nodeRadius(4) - 3))
  })
})

describe('fitTransform — fit the graph to the view (#5432)', () => {
  /** Where a graph point lands on screen under transform `t`. */
  function onScreen(t: ReturnType<typeof fitTransform>, x: number, y: number): [number, number] {
    return t.apply([x, y])
  }

  it('centres the bounding box and fills the tighter side up to the padding', () => {
    const t = fitTransform(
      [
        { x: -100, y: -50 },
        { x: 300, y: 150 },
        { x: 0, y: 0 },
      ],
      800,
      600,
    )

    // Width is the tighter side: (800 - 2·64) / 400.
    expect(t.k).toBeCloseTo(1.68)
    expect(onScreen(t, 100, 50)).toEqual([400, 300])
    const [left, top] = onScreen(t, -100, -50)
    const [right, bottom] = onScreen(t, 300, 150)
    expect(left).toBeCloseTo(64)
    expect(right).toBeCloseTo(736)
    expect(top).toBeCloseTo(132)
    expect(bottom).toBeCloseTo(468)
  })

  it('caps the scale at 2, so a small graph is not blown up', () => {
    const t = fitTransform(
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
      800,
      600,
    )
    expect(t.k).toBe(2)
    expect(onScreen(t, 5, 10)).toEqual([400, 300])
  })

  it('centres a single node at the cap', () => {
    const t = fitTransform([{ x: 70, y: -30 }], 800, 600)
    expect(t.k).toBe(2)
    expect(onScreen(t, 70, -30)).toEqual([400, 300])
  })

  it('ignores nodes without a position, and is the identity with none placed', () => {
    expect(fitTransform([{ x: 70, y: -30 }, {}], 800, 600)).toEqual(
      fitTransform([{ x: 70, y: -30 }], 800, 600),
    )
    expect(fitTransform([{}], 800, 600)).toEqual(zoomIdentity)
    expect(fitTransform([], 800, 600)).toEqual(zoomIdentity)
  })
})

describe('renderGraphElements — node size and the current-page accent (#5429)', () => {
  // Hub links out to A and B and in from C: three links, in and out.
  const nodes = [
    makeNode('hub', 'Hub'),
    makeNode('a', 'A'),
    makeNode('b', 'B'),
    makeNode('c', 'C'),
    makeNode('orphan', 'Orphan'),
  ]
  const edges: GraphEdge[] = [
    { source: 'hub', target: 'a', ref_count: 1 },
    { source: 'hub', target: 'b', ref_count: 1 },
    { source: 'c', target: 'hub', ref_count: 1 },
  ]

  function dot(svg: SVGSVGElement, label: string): Element {
    const circle = svg.querySelector(`g.node[aria-label="${label}"] > circle:nth-child(2)`)
    if (!circle) throw new Error(`no node labelled ${label}`)
    return circle
  }

  const radius = (svg: SVGSVGElement, label: string): number =>
    Number(dot(svg, label).getAttribute('r'))

  function paint(svg: SVGSVGElement): Array<[string | null, string | null, string | null]> {
    return Array.from(svg.querySelectorAll('g.node')).map((g) => [
      g.getAttribute('aria-label'),
      g.querySelector('circle:nth-child(2)')?.getAttribute('fill') ?? null,
      g.getAttribute('aria-current'),
    ])
  }

  it('sizes each node by the links it has on screen, in and out', () => {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {})

    expect(radius(svg, 'Hub')).toBe(nodeRadius(3))
    expect(radius(svg, 'A')).toBe(nodeRadius(1))
    expect(radius(svg, 'C')).toBe(nodeRadius(1))
    expect(radius(svg, 'Orphan')).toBe(nodeRadius(0))
  })

  it('a patch that drops links shrinks the nodes that lost them', () => {
    const svg = makeSvg()
    const rendered = renderGraphElements(svg, nodes, edges, () => {})

    patchGraphSelections(rendered.g, nodes, [], () => {})

    expect(radius(svg, 'Hub')).toBe(nodeRadius(0))
  })

  it('gives the current page the accent and every other node the neutral tone', () => {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {}, 'a')

    expect(paint(svg)).toEqual([
      ['Hub', 'var(--graph-node)', null],
      ['A', 'var(--graph-accent)', 'page'],
      ['B', 'var(--graph-node)', null],
      ['C', 'var(--graph-node)', null],
      ['Orphan', 'var(--graph-node)', null],
    ])
  })

  it('accents no node when the active tab has no page open', () => {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {}, null)

    expect(paint(svg).map(([, fill, current]) => [fill, current])).toEqual(
      nodes.map(() => ['var(--graph-node)', null]),
    )
  })

  it("starts a hub's label clear of its node, hovered or not", () => {
    const leaves = Array.from({ length: 36 }, (_, i) => makeNode(`leaf${i}`, `Leaf ${i}`))
    const spokes: GraphEdge[] = leaves.map((leaf) => ({
      source: 'hub',
      target: leaf.id,
      ref_count: 1,
    }))
    const svg = makeSvg()
    renderGraphElements(svg, [makeNode('hub', 'Hub'), ...leaves], spokes, () => {})

    const label = svg.querySelector('g.node[aria-label="Hub"] > text')
    expect(radius(svg, 'Hub')).toBe(12)
    expect(Number(label?.getAttribute('dx'))).toBeGreaterThan(12 + 2)
  })

  it('hover and press resize a node from its own radius, so hover never shrinks a hub', () => {
    const leaves = Array.from({ length: 16 }, (_, i) => makeNode(`leaf${i}`, `Leaf ${i}`))
    const spokes: GraphEdge[] = leaves.map((leaf) => ({
      source: 'hub',
      target: leaf.id,
      ref_count: 1,
    }))
    const svg = makeSvg()
    renderGraphElements(svg, [makeNode('hub', 'Hub'), ...leaves], spokes, () => {})
    const hub = svg.querySelector('g.node[aria-label="Hub"]') as Element
    const at = nodeRadius(16)
    expect(at).toBeGreaterThan(8)

    const radii = ['mouseenter', 'pointerdown', 'pointerup', 'mouseleave'].map((type) => {
      hub.dispatchEvent(new Event(type))
      return radius(svg, 'Hub')
    })

    expect(radii).toEqual([at + 2, at - 1, at + 2, at])
  })
})

describe('renderGraphElements — neighbourhood highlight on hover and focus (#5431)', () => {
  // Hub's neighbours are A, B and C; Far hangs off A, so it is two hops from Hub.
  const nodes = [
    makeNode('hub', 'Hub'),
    makeNode('a', 'A'),
    makeNode('b', 'B'),
    makeNode('c', 'C'),
    makeNode('far', 'Far'),
  ]
  const edges: GraphEdge[] = [
    { source: 'hub', target: 'a', ref_count: 1 },
    { source: 'hub', target: 'b', ref_count: 1 },
    { source: 'c', target: 'hub', ref_count: 1 },
    { source: 'a', target: 'far', ref_count: 1 },
  ]
  const edgeNames = ['hub-a', 'hub-b', 'c-hub', 'a-far']

  function render(): SVGSVGElement {
    const svg = makeSvg()
    renderGraphElements(svg, nodes, edges, () => {})
    return svg
  }

  const group = (svg: SVGSVGElement, label: string): Element =>
    svg.querySelector(`g.node[aria-label="${label}"]`) as Element

  /** Inline opacity per node and per edge; '' is undimmed. */
  function opacities(svg: SVGSVGElement): Record<string, string> {
    const out: Record<string, string> = {}
    for (const g of svg.querySelectorAll<SVGGElement>('g.node')) {
      out[g.getAttribute('aria-label') as string] = g.style.opacity
    }
    svg.querySelectorAll<SVGLineElement>('line').forEach((line, i) => {
      out[edgeNames[i] as string] = line.style.opacity
    })
    return out
  }

  const strokeOpacities = (svg: SVGSVGElement): string[] =>
    Array.from(svg.querySelectorAll<SVGLineElement>('line')).map((l) => l.style.strokeOpacity)

  const RESTING = {
    Hub: '',
    A: '',
    B: '',
    C: '',
    Far: '',
    'hub-a': '',
    'hub-b': '',
    'c-hub': '',
    'a-far': '',
  }

  it('hovering a node leaves exactly it, its neighbours and their edges undimmed; leaving restores all', () => {
    const svg = render()

    group(svg, 'Hub').dispatchEvent(new Event('mouseenter'))
    expect(opacities(svg)).toEqual({ ...RESTING, Far: '0.15', 'a-far': '0.15' })
    expect(strokeOpacities(svg)).toEqual(['0.8', '0.8', '0.8', ''])

    group(svg, 'Hub').dispatchEvent(new Event('mouseleave'))
    expect(opacities(svg)).toEqual(RESTING)
    expect(strokeOpacities(svg)).toEqual(['', '', '', ''])
  })

  it('focusing a node highlights its neighbourhood the same way; blur restores all', () => {
    const svg = render()

    group(svg, 'Far').dispatchEvent(new Event('focus'))
    expect(opacities(svg)).toEqual({
      ...RESTING,
      Hub: '0.15',
      B: '0.15',
      C: '0.15',
      'hub-a': '0.15',
      'hub-b': '0.15',
      'c-hub': '0.15',
    })
    expect(strokeOpacities(svg)).toEqual(['', '', '', '0.8'])

    group(svg, 'Far').dispatchEvent(new Event('blur'))
    expect(opacities(svg)).toEqual(RESTING)
    expect(strokeOpacities(svg)).toEqual(['', '', '', ''])
  })

  it('leaving a hovered node falls back to the focused node instead of clearing', () => {
    const svg = render()
    group(svg, 'Far').dispatchEvent(new Event('focus'))
    const focusedOnly = opacities(svg)
    expect(focusedOnly['Hub']).toBe('0.15')

    group(svg, 'Hub').dispatchEvent(new Event('mouseenter'))
    expect(opacities(svg)['B']).toBe('')
    group(svg, 'Hub').dispatchEvent(new Event('mouseleave'))

    expect(opacities(svg)).toEqual(focusedOnly)
  })

  it('hovering a node outside the focused neighbourhood never dims the focused node', () => {
    const svg = render()
    group(svg, 'Far').dispatchEvent(new Event('focus'))
    group(svg, 'B').dispatchEvent(new Event('mouseenter'))

    expect(opacities(svg)).toMatchObject({ Far: '', A: '0.15', C: '0.15' })
  })

  it('hover and focus leave the label size and weight alone', () => {
    const svg = render()
    const label = group(svg, 'Hub').querySelector('text') as SVGTextElement
    const typography = (): Array<string | null> => [
      label.getAttribute('font-size'),
      label.getAttribute('font-weight'),
      label.style.fontSize,
      label.style.fontWeight,
    ]
    const resting = typography()

    group(svg, 'Hub').dispatchEvent(new Event('focus'))
    expect(typography()).toEqual(resting)
    group(svg, 'Hub').dispatchEvent(new Event('mouseenter'))
    expect(typography()).toEqual(resting)
  })

  // happy-dom evaluates neither `@media (prefers-reduced-motion)` nor `var()`,
  // so this pins the stylesheet instead: the transition rule matches the
  // rendered nodes and edges, and its duration is a token that reduced motion
  // scales to zero.
  it('eases opacity with a token duration that reduced motion zeroes', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const rule = /([^{}]+)\{([^}]*transition-property:\s*opacity[^}]*)\}/.exec(css)
    if (!rule) throw new Error('no opacity transition rule in index.css')
    const [, rawSelector, body] = rule as unknown as [string, string, string]
    const selector = rawSelector.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const svg = render()

    expect(group(svg, 'Hub').matches(selector)).toBe(true)
    expect(svg.querySelector('line')?.matches(selector)).toBe(true)
    const token = /transition-duration:\s*var\((--duration-[a-z]+)\)/.exec(body)?.[1]
    expect(token).toBeDefined()
    expect(css).toMatch(new RegExp(`${token}:\\s*calc\\([^;]*var\\(--motion-scale`))
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{\s*--motion-scale:\s*0;/,
    )
  })
})

describe('renderGraphElements —  native SVG <title> tooltip', () => {
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

describe('renderGraphElements \u2014 #1725 accessible name + roving tabindex', () => {
  it('sets an explicit aria-label per node (not only the child <title>)', () => {
    const svg = makeSvg()
    const nodes: GraphNode[] = [makeNode('a', 'Alpha'), makeNode('b', 'Beta')]

    renderGraphElements(svg, nodes, [], () => {})

    const labels = Array.from(svg.querySelectorAll('g.node')).map((g) =>
      g.getAttribute('aria-label'),
    )
    expect(labels).toEqual(['Alpha', 'Beta'])
  })

  it('makes exactly one node tabbable (roving tabindex), the rest -1', () => {
    const svg = makeSvg()
    const nodes: GraphNode[] = [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C')]

    renderGraphElements(svg, nodes, [], () => {})

    const tabindexes = Array.from(svg.querySelectorAll('g.node')).map((g) =>
      g.getAttribute('tabindex'),
    )
    expect(tabindexes.filter((t) => t === '0')).toHaveLength(1)
    expect(tabindexes).toEqual(['0', '-1', '-1'])
  })

  it('ArrowDown moves the roving tabindex to the next node', () => {
    const svg = makeSvg()
    // Attach to the document so .focus() / dispatchEvent behave.
    document.body.append(svg)
    const nodes: GraphNode[] = [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C')]

    renderGraphElements(svg, nodes, [], () => {})

    const groups = Array.from(svg.querySelectorAll('g.node')) as SVGGElement[]
    groups[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )

    expect(groups.map((g) => g.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    expect(document.activeElement).toBe(groups[1])

    svg.remove()
  })

  it('ArrowUp from the first node wraps to the last (roving)', () => {
    const svg = makeSvg()
    document.body.append(svg)
    const nodes: GraphNode[] = [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C')]

    renderGraphElements(svg, nodes, [], () => {})

    const groups = Array.from(svg.querySelectorAll('g.node')) as SVGGElement[]
    groups[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )

    expect(groups.map((g) => g.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    expect(document.activeElement).toBe(groups[2])

    svg.remove()
  })
})

// \u2500\u2500 createZoomKeyHandler \u2014 keyboard zoom (graphZoomIn/Out/Reset, #1172) \u2500\u2500\u2500\u2500\u2500\u2500
//
// Moved the graph zoom chords out of GraphView into rebindable catalog
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
    // assert the second arg (the zoom factor).
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
    const handler = createZoomKeyHandler(svg, zb as any, vi.fn())

    press(handler, { key: '+' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBe(ZOOM_STEP)
  })

  it('graphZoomIn also fires on the `=` alternative (`+ / =`)', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    const handler = createZoomKeyHandler(svg, zb as any, vi.fn())

    press(handler, { key: '=' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBe(ZOOM_STEP)
  })

  it('graphZoomOut (`-`) scales by the inverse step', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    const handler = createZoomKeyHandler(svg, zb as any, vi.fn())

    press(handler, { key: '-' })

    expect(zb.scaleBy).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy.mock.calls[0]?.[1]).toBeCloseTo(1 / ZOOM_STEP)
    expect(zb.transform).not.toHaveBeenCalled()
  })

  it('graphZoomReset (`0`) fits the graph to the view', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    const fitToView = vi.fn()
    const handler = createZoomKeyHandler(svg, zb as any, fitToView)

    press(handler, { key: '0' })

    expect(fitToView).toHaveBeenCalledTimes(1)
    expect(zb.scaleBy).not.toHaveBeenCalled()
  })

  it('ignores the zoom keys when focus is in an editable target', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    const fitToView = vi.fn()
    const handler = createZoomKeyHandler(svg, zb as any, fitToView)

    const input = document.createElement('input')
    document.body.append(input)
    try {
      // Re-target the event at the editable element.
      const e = new KeyboardEvent('keydown', { key: '0' })
      Object.defineProperty(e, 'target', { value: input })
      handler(e)
      expect(fitToView).not.toHaveBeenCalled()
      expect(zb.scaleBy).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })

  it('ignores unrelated keys', () => {
    const svg = makeSvg()
    const zb = makeZoomBehavior()
    const fitToView = vi.fn()
    const handler = createZoomKeyHandler(svg, zb as any, fitToView)

    press(handler, { key: 'x' })

    expect(zb.scaleBy).not.toHaveBeenCalled()
    expect(fitToView).not.toHaveBeenCalled()
  })
})

// ── #3308 finding 3: graph zoom transitions honour prefers-reduced-motion ──
//
// d3 transitions are rAF-driven JavaScript, so the app's global
// `@media (prefers-reduced-motion: reduce)` CSS rule cannot suppress them.
// `reducedMotionDuration` collapses the duration to 0 (the transform is
// still applied — it just jumps), and every keyboard-zoom call site routes
// its duration through it.
describe('reduced-motion graph zoom (#3308)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetAllShortcuts()
  })

  function setReducedMotion(matches: boolean): void {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches, media: query }) as MediaQueryList,
    )
  }

  /** The `duration()` of the transition selection handed to d3-zoom. */
  function transitionDuration(call: unknown[] | undefined): number {
    const transition = call?.[0] as { duration: () => number }
    return transition.duration()
  }

  function makeZoomBehavior() {
    return { scaleBy: vi.fn(), transform: vi.fn() }
  }

  it('#3308: reducedMotionDuration returns 0 when reduced motion is requested', () => {
    setReducedMotion(true)
    expect(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)).toBe(0)
    expect(reducedMotionDuration(ZOOM_FIT_DURATION_MS)).toBe(0)
  })

  it('#3308: reducedMotionDuration passes the duration through otherwise', () => {
    setReducedMotion(false)
    expect(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)).toBe(ZOOM_BUTTON_DURATION_MS)
    expect(reducedMotionDuration(ZOOM_FIT_DURATION_MS)).toBe(ZOOM_FIT_DURATION_MS)
  })

  it('#3308: reducedMotionDuration reads matchMedia at call time, not module load', () => {
    setReducedMotion(false)
    expect(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)).toBe(ZOOM_BUTTON_DURATION_MS)
    // The OS preference flips mid-session — the next call must honour it.
    setReducedMotion(true)
    expect(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)).toBe(0)
  })

  it('#3308: keyboard zoom in/out transitions have duration 0 under reduced motion', () => {
    setReducedMotion(true)
    const svg = makeSvg()

    const zoomIn = makeZoomBehavior()
    createZoomKeyHandler(svg, zoomIn as never, vi.fn())(new KeyboardEvent('keydown', { key: '+' }))
    expect(transitionDuration(zoomIn.scaleBy.mock.calls[0])).toBe(0)

    const zoomOut = makeZoomBehavior()
    createZoomKeyHandler(svg, zoomOut as never, vi.fn())(new KeyboardEvent('keydown', { key: '-' }))
    expect(transitionDuration(zoomOut.scaleBy.mock.calls[0])).toBe(0)
  })

  it('#3308: keyboard zoom transitions keep their animated durations otherwise', () => {
    setReducedMotion(false)
    const svg = makeSvg()

    const zoomIn = makeZoomBehavior()
    createZoomKeyHandler(svg, zoomIn as never, vi.fn())(new KeyboardEvent('keydown', { key: '+' }))
    expect(transitionDuration(zoomIn.scaleBy.mock.calls[0])).toBe(ZOOM_BUTTON_DURATION_MS)
  })
})

// ── #2194: transferable Float32Array position (un)packing ──────────────

describe('packPositions / unpackPositions — transferable tick round-trip (#2194)', () => {
  it('packs {x,y}[] into a flat Float32Array [x0,y0,x1,y1,…]', () => {
    const buf = packPositions([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ])
    expect(buf).toBeInstanceOf(Float32Array)
    expect(buf).toHaveLength(6)
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('coalesces undefined x/y to 0 (a node d3 has not yet placed)', () => {
    const buf = packPositions([{}, { x: 7 }, { y: 9 }])
    expect(Array.from(buf)).toEqual([0, 0, 7, 0, 0, 9])
  })

  it('round-trips pack → unpack back to {id,x,y}[] given the fixed id order', () => {
    const nodes = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]
    const ids = ['a', 'b']
    const buf = packPositions(nodes)
    // Whole-number floats survive Float32 exactly.
    expect(unpackPositions(buf, ids)).toEqual([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 30, y: 40 },
    ])
  })

  it('unpacks only as many entries as the shorter of ids / buffer length', () => {
    // A tick packed for 3 nodes but only 2 ids known (e.g. a stale tick that
    // raced an `update` shrinking the set): read the safe prefix, no overrun.
    const buf = Float32Array.from([1, 1, 2, 2, 3, 3])
    expect(unpackPositions(buf, ['a', 'b'])).toEqual([
      { id: 'a', x: 1, y: 1 },
      { id: 'b', x: 2, y: 2 },
    ])
    // Fewer buffer entries than ids: only the covered ids come back.
    expect(unpackPositions(Float32Array.from([9, 8]), ['a', 'b', 'c'])).toEqual([
      { id: 'a', x: 9, y: 8 },
    ])
  })

  it('an empty node set packs to a zero-length buffer and unpacks to []', () => {
    const buf = packPositions([])
    expect(buf).toHaveLength(0)
    expect(unpackPositions(buf, [])).toEqual([])
  })
})
