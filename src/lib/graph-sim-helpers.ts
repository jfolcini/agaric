/**
 * Pure d3 / worker / main-thread helpers for the graph force simulation.
 *
 * Extracted from `src/hooks/useGraphSimulation.ts`. These
 * helpers have no React state — they are referentially-transparent
 * builders, drawers, and runners that the hooks compose into the
 * orchestrator's effect. Keep new pure graph helpers here.
 */

import { drag } from 'd3-drag'
import { forceLink, forceSimulation, type Simulation, type SimulationNodeDatum } from 'd3-force'
import { type Selection, select } from 'd3-selection'
import { type ZoomBehavior, type ZoomTransform, zoom, zoomIdentity } from 'd3-zoom'

import {
  applyGraphForces,
  applyResizeForces,
  nodeRadius,
  RESIZE_ALPHA,
  startAlpha,
} from '@/lib/graph-forces'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import { isEditableTarget, matchesShortcutBinding } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { shouldReduceMotion } from '@/lib/preferences'
import type { NodePosition, WorkerNode, WorkerOutboundMessage } from '@/workers/graph-worker-types'

// ── Constants ────────────────────────────────────────────────────────

export const DEFAULT_WIDTH = 800
export const DEFAULT_HEIGHT = 600
/** 44 px touch target; it already covers the largest hovered node (12 + 2). */
const NODE_HIT_RADIUS = 22
const NODE_HOVER_GROWTH = 2
const NODE_PRESS_SHRINK = 1
// Edges are context: a hairline that ref_count only darkens a little (#5428).
const EDGE_WIDTH = 1
const EDGE_OPACITY_BASE = 0.2
const EDGE_OPACITY_STEP = 0.05
const EDGE_OPACITY_MAX = 0.45
const DIMMED_OPACITY = '0.15'
const HIGHLIGHTED_EDGE_OPACITY = '0.8'
const LABEL_TRUNCATE_LEN = 20
const LABEL_GAP = 4
export const ZOOM_BUTTON_DURATION_MS = 200
export const ZOOM_FIT_DURATION_MS = 300
/** Screen pixels kept clear around the graph when it is fitted, and around a node panned into view. */
const FIT_PADDING = 64
/** A fitted graph is never zoomed past this, so a handful of nodes is not blown up. */
const FIT_MAX_SCALE = 2
export const ZOOM_STEP = 1.3
const REDUCED_MOTION_TICK_LIMIT = 300

// ── Types ────────────────────────────────────────────────────────────

export type LinkSel = Selection<SVGLineElement, GraphEdge, SVGGElement, unknown>
export type NodeSel = Selection<SVGGElement, GraphNode, SVGGElement, unknown>
export type GSel = Selection<SVGGElement, unknown, null, undefined>

export interface RenderResult {
  g: GSel
  simNodes: GraphNode[]
  simEdges: GraphEdge[]
  nodeById: Map<string, GraphNode>
  link: LinkSel
  node: NodeSel
  highlight: NeighbourhoodHighlight
  width: number
  height: number
}

/** What a node does when it is selected, opened, or reached by the keyboard. */
export interface NodeActions {
  select: (id: string, label: string) => void
  open: (id: string, label: string) => void
  openInNewTab: (id: string, label: string) => void
  /** Pan so a node reached by the keyboard is in view. */
  reveal: (node: GraphNode) => void
}

/** The page open in the active tab, and the node the user selected. */
export interface NodeMarks {
  currentPageId: string | null
  selectedId: string | null
}

const NO_MARKS: NodeMarks = { currentPageId: null, selectedId: null }

export interface SimulationCtx {
  simNodes: GraphNode[]
  simEdges: GraphEdge[]
  nodeById: Map<string, GraphNode>
  node: NodeSel
  applyPositions: () => void
  width: number
  height: number
  prefersReducedMotion: boolean
  /** The kept layout the nodes' positions come from had stopped moving (#5434). */
  keptSettled: boolean
  /** Called with the nodes each time the layout comes to rest. */
  onSettled: (nodes: readonly GraphNode[]) => void
}

/** Where each node settled and how the view was zoomed, kept so the graph comes back as it was left (#5434). */
export interface GraphLayout {
  positions: ReadonlyMap<string, { x: number; y: number }>
  transform: ZoomTransform
  /** The simulation had stopped moving when the layout was kept. */
  settled: boolean
}

/**
 * Handle returned from the worker/main-thread simulation runners.
 *
 * `cleanup` tears down the simulation (called on effect cleanup).
 * `onResize` re-anchors the simulation's centering forces to the new
 * canvas dimensions. Called from the `ResizeObserver` on `svgRef.current`
 * So the graph stays centered when the view container resizes.
 * `onUpdate` swaps the node/edge set on the LIVE simulation in place
 * (#2194) — used on filter toggles so the layout drifts instead of the
 * whole simulation being torn down and respawned. The worker path posts an
 * `update` message; the main-thread path re-seeds the existing sim's
 * `nodes()`/link force. `ctx` carries the fresh (position-preserving)
 * simNodes/simEdges/nodeById + refreshed selections for the new topology.
 */
export interface SimulationHandle {
  cleanup: () => void
  onResize: (width: number, height: number) => void
  onUpdate: (ctx: SimulationCtx) => void
  /** Whether the simulation has stopped moving, so its layout is settled (#5434). */
  settled: () => boolean
}

// ── SVG / d3 setup ───────────────────────────────────────────────────

/**
 * Links per page among the edges on screen, in and out. Not `backlink_count`,
 * which is inbound only and `undefined` once the edge fetch was capped.
 */
function countDegrees(simEdges: GraphEdge[]): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const { source, target } of simEdges) {
    for (const end of [source, target]) {
      const id = endId(end)
      degrees.set(id, (degrees.get(id) ?? 0) + 1)
    }
  }
  return degrees
}

function endId(end: string | GraphNode): string {
  return typeof end === 'string' ? end : end.id
}

function buildAdjacency(simEdges: GraphEdge[]): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>()
  const link = (from: string, to: string): void => {
    const set = neighbours.get(from) ?? new Set<string>()
    set.add(to)
    neighbours.set(from, set)
  }
  for (const { source, target } of simEdges) {
    link(endId(source), endId(target))
    link(endId(target), endId(source))
  }
  return neighbours
}

/**
 * The selected node, else the page open in the active tab, takes the one
 * accent; every other node is the neutral tone. Only the selected node shows
 * its full title.
 */
export function markNodes(node: NodeSel, { currentPageId, selectedId }: NodeMarks): void {
  const accented = selectedId ?? currentPageId
  node.attr('aria-current', (d) => (d.id === currentPageId ? 'page' : null))
  node.attr('aria-selected', (d) => String(d.id === selectedId))
  node
    .select('circle:nth-child(2)')
    .attr('fill', (d) => (d.id === accented ? 'var(--graph-accent)' : 'var(--graph-node)'))
  node
    .select<SVGTextElement>('text')
    .text((d) =>
      d.id !== selectedId && d.label.length > LABEL_TRUNCATE_LEN
        ? `${d.label.slice(0, LABEL_TRUNCATE_LEN)}…`
        : d.label,
    )
}

function drawEdges(edgeLayer: GSel, simEdges: GraphEdge[]): LinkSel {
  return edgeLayer
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(simEdges, (d: GraphEdge) => {
      const s = typeof d.source === 'string' ? d.source : (d.source as GraphNode).id
      const t = typeof d.target === 'string' ? d.target : (d.target as GraphNode).id
      return `${s}->${t}`
    })
    .join('line')
    .attr('stroke', 'var(--graph-edge)')
    .attr('stroke-opacity', (d: GraphEdge) => {
      const count = Math.max(1, d.ref_count ?? 1)
      return Math.min(EDGE_OPACITY_BASE + EDGE_OPACITY_STEP * (count - 1), EDGE_OPACITY_MAX)
    })
    .attr('stroke-width', EDGE_WIDTH)
    .attr('vector-effect', 'non-scaling-stroke')
}

/**
 * The sub-tree is built once, on ENTER, so a patch does not undo the focus or
 * hover styling of a node it keeps. The label, accessible name, radius and
 * fill are set on every patch, so a renamed page shows its new title and a
 * filter that drops links shrinks the nodes that lost them; a node hovered
 * through a patch is back at its resting radius until the pointer re-enters.
 */
function drawNodes(
  nodeLayer: GSel,
  simNodes: GraphNode[],
  radiusOf: (d: GraphNode) => number,
  marks: NodeMarks,
): NodeSel {
  const node = nodeLayer
    .selectAll<SVGGElement, GraphNode>('g.node')
    .data(simNodes, (d: GraphNode) => d.id)
    .join((enter) => {
      const grp = enter
        .append('g')
        .attr('class', 'node')
        .attr('role', 'option')
        .style('cursor', 'pointer')

      // Hit-area circle for touch targets (44px diameter).
      grp
        .append('circle')
        .attr('r', NODE_HIT_RADIUS)
        .attr('fill', 'transparent')
        .style('pointer-events', 'all')
        .attr('class', 'hit-area')

      grp.append('circle')

      grp
        .append('text')
        .attr('dy', 4)
        .attr('fill', 'var(--foreground)')
        .attr('font-size', '12px')
        .style('pointer-events', 'none')
        .style('user-select', 'none')

      // Native SVG <title> tooltip carries the full label so truncated
      // names ("prefix…") are still discoverable on hover.
      grp.append('title')
      return grp
    })
    // #1725 — explicit accessible name per node (don't rely solely on the
    // child <title>, whose name computation is inconsistent across screen
    // readers).
    .attr('aria-label', (d) => d.label)

  node.select<SVGTitleElement>('title').text((d) => d.label)
  node.select<SVGCircleElement>('circle:nth-child(2)').attr('r', radiusOf)
  node.select<SVGTextElement>('text').attr('dx', (d) => radiusOf(d) + LABEL_GAP)
  markNodes(node, marks)

  // #1725 — roving tabindex: only ONE node is in the page tab order at a
  // time (the first; thereafter the last-focused). All others are
  // `tabindex="-1"` and reached via Arrow keys, so a large graph is a
  // single Tab stop instead of hundreds. `applyRovingTabindex` sets the
  // initial -1/0 split; `attachNodeRovingKeys` handles Arrow/Home/End.
  applyRovingTabindex(node)

  return node
}

/**
 * #1725 — roving tabindex helpers.
 *
 * A graph can hold hundreds of nodes; making every node `tabindex="0"`
 * turned the graph into hundreds of sequential Tab stops. Instead we adopt
 * the standard roving-tabindex pattern (as for toolbars/listboxes):
 *
 *   - exactly one node carries `tabindex="0"` (the rest are `"-1"`), so a
 *     single Tab enters the graph and a single Tab leaves it;
 *   - Arrow keys (and Home/End) move focus *within* the node group,
 *     transferring the `0` to the newly-focused node.
 *
 * `applyRovingTabindex` sets the initial split (first node `0`, others
 * `-1`). It is idempotent and safe to re-run after a data-join patch.
 */
export function applyRovingTabindex(node: NodeSel): void {
  // If a node is already the roving target (tabindex="0") and still in the
  // selection, keep it; otherwise anoint the first node. This preserves the
  // focused node across filter-toggle patches.
  const nodes = node.nodes()
  if (nodes.length === 0) return
  const hasRovingTarget = nodes.some((el) => el.getAttribute('tabindex') === '0')
  const firstNode = nodes[0]
  node.attr('tabindex', function () {
    if (hasRovingTarget) {
      return this.getAttribute('tabindex') === '0' ? '0' : '-1'
    }
    return this === firstNode ? '0' : '-1'
  })
}

/**
 * Move the roving `tabindex="0"` to `target` (others → `-1`) and focus it.
 */
function focusRovingNode(node: NodeSel, target: SVGGElement): void {
  node.attr('tabindex', function () {
    return this === target ? '0' : '-1'
  })
  target.focus()
}

/** Screen direction of each arrow key; the zoom transform never rotates, so it holds in graph space too. */
const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
}

/**
 * The index of the node nearest to `from` on the arrow's side of it, or `-1`.
 * Distance off the arrow's axis weighs extra, so a node straight ahead beats a
 * nearer one far to the side.
 */
function nearestInDirection(
  nodes: readonly GraphNode[],
  from: GraphNode,
  [dx, dy]: readonly [number, number],
): number {
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  nodes.forEach((n, i) => {
    const x = (n.x ?? 0) - (from.x ?? 0)
    const y = (n.y ?? 0) - (from.y ?? 0)
    const ahead = x * dx + y * dy
    if (ahead <= 0) return
    const aside = Math.abs(x * dy - y * dx)
    const score = Math.hypot(ahead, aside) + 2 * aside
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  })
  return best
}

/**
 * Arrow keys move to the nearest node in that direction on screen; Home and
 * End go to the first and last node. The node moved to is panned into view; a
 * node focused by a click is already on screen. Bound under the `.roving`
 * keydown namespace so it coexists with the handler in `attachNodeActions`.
 */
function attachNodeRovingKeys(node: NodeSel, reveal: NodeActions['reveal']): void {
  node.on('keydown.roving', (event: KeyboardEvent, d) => {
    const direction = ARROW_DIRECTIONS[event.key]
    if (direction === undefined && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const all = node.nodes()
    const data = node.data()
    let next: number
    if (direction !== undefined) next = nearestInDirection(data, d, direction)
    else next = event.key === 'Home' ? 0 : all.length - 1
    const target = all[next]
    const targetDatum = data[next]
    if (!target || !targetDatum) return
    focusRovingNode(node, target)
    reveal(targetDatum)
  })
}

/**
 * A click selects a node and a click on the selected node opens it; Space
 * selects and Enter opens. Ctrl/Cmd-click and middle-click open a new tab.
 * Whether a node is selected is read from the DOM, which `markNodes` keeps in
 * step with the selection between patches. A double-click is two clicks that
 * open the node, so it must not also reach d3-zoom's double-click zoom, which
 * would change the view the graph is kept with.
 */
function attachNodeActions(node: NodeSel, actions: NodeActions): void {
  node.on('click', function (event: MouseEvent, d) {
    if (event.ctrlKey || event.metaKey) actions.openInNewTab(d.id, d.label)
    else if (this.getAttribute('aria-selected') === 'true') actions.open(d.id, d.label)
    else actions.select(d.id, d.label)
  })

  node.on('dblclick', (event: MouseEvent) => {
    event.stopPropagation()
  })

  node.on('auxclick', (event: MouseEvent, d) => {
    if (event.button !== 1) return
    event.preventDefault()
    actions.openInNewTab(d.id, d.label)
  })

  node.on('keydown', (event: KeyboardEvent, d) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      actions.open(d.id, d.label)
    } else if (event.key === ' ') {
      event.preventDefault()
      actions.select(d.id, d.label)
    }
  })
}

interface NeighbourhoodHighlight {
  hover: (id: string | null) => void
  focus: (id: string | null) => void
  select: (id: string | null) => void
}

/**
 * Hover wins over focus, and focus over the selection; leaving a hovered or
 * focused node falls back to the next one's neighbourhood instead of clearing
 * it. The focused and selected nodes are never dimmed, so the focus ring and
 * the accent stay legible. The opacity easing is a CSS transition in
 * `index.css`, so reduced motion zeroes it.
 */
function createNeighbourhoodHighlight(
  node: NodeSel,
  link: LinkSel,
  simEdges: GraphEdge[],
  selectedId: string | null,
): NeighbourhoodHighlight {
  const neighbours = buildAdjacency(simEdges)
  let hovered: string | null = null
  let focused: string | null = null
  let selected = selectedId

  const apply = (): void => {
    const centre = hovered ?? focused ?? selected
    const lit = centre === null ? null : (neighbours.get(centre) ?? new Set<string>())
    const touchesCentre = (d: GraphEdge): boolean =>
      endId(d.source) === centre || endId(d.target) === centre
    node.style('opacity', (d) =>
      lit === null || d.id === centre || d.id === focused || d.id === selected || lit.has(d.id)
        ? null
        : DIMMED_OPACITY,
    )
    link
      .style('opacity', (d) => (lit === null || touchesCentre(d) ? null : DIMMED_OPACITY))
      .style('stroke-opacity', (d) =>
        lit !== null && touchesCentre(d) ? HIGHLIGHTED_EDGE_OPACITY : null,
      )
  }
  if (selected !== null) apply()

  return {
    hover: (id) => {
      hovered = id
      apply()
    },
    focus: (id) => {
      focused = id
      apply()
    },
    select: (id) => {
      selected = id
      apply()
    },
  }
}

/** The label keeps its size and weight, so focus never moves the text. */
function attachNodeFocusStyles(node: NodeSel, highlight: NeighbourhoodHighlight): void {
  node.on('focus', function (_event, d) {
    select(this).select('circle:nth-child(2)').attr('stroke', 'var(--ring)').attr('stroke-width', 2)
    highlight.focus(d.id)
  })
  node.on('blur', function () {
    select(this).select('circle:nth-child(2)').attr('stroke', null).attr('stroke-width', null)
    highlight.focus(null)
  })
}

/** Hover and press radii are relative to the node's own, so hover never shrinks a hub. */
function attachNodeHover(
  node: NodeSel,
  highlight: NeighbourhoodHighlight,
  radiusOf: (d: GraphNode) => number,
): void {
  node.on('mouseenter', function (_event, hovered) {
    const self = select(this)
    self.select('circle:nth-child(2)').attr('r', radiusOf(hovered) + NODE_HOVER_GROWTH)
    self
      .select('text')
      .style('paint-order', 'stroke')
      .attr('stroke', 'var(--background)')
      .attr('stroke-width', '3px')
    highlight.hover(hovered.id)
  })

  node.on('mouseleave', function (_event, d) {
    const self = select(this)
    self.select('circle:nth-child(2)').attr('r', radiusOf(d))
    self.select('text').style('paint-order', null).attr('stroke', null).attr('stroke-width', null)
    highlight.hover(null)
  })

  node.on('pointerdown', function (_event, d) {
    select(this)
      .select('circle:nth-child(2)')
      .attr('r', radiusOf(d) - NODE_PRESS_SHRINK)
  })
  node.on('pointerup', function (_event, d) {
    select(this)
      .select('circle:nth-child(2)')
      .attr('r', radiusOf(d) + NODE_HOVER_GROWTH)
  })
}

/**
 * The one draw path: the first render (onto empty layers) and every filter
 * patch join `simNodes`/`simEdges` into the layer groups under `g`. Keyed
 * joins keep the DOM of persisting nodes and edges; EXIT removes the rest.
 * Listeners are re-bound on the merged selection so their closures see the
 * latest `actions` and selections; d3's `.on()` replaces a handler instead of
 * stacking it.
 *
 * Joins are scoped to `g.edges-layer` / `g.nodes-layer`, so an ENTERing
 * `<line>` lands in the edge layer, which precedes the node layer, and never
 * paints over a node (#758 item 4).
 *
 * Every simulation's nodes pass through here, so this is where each node's
 * `degree` is stamped for the layout forces of both paths (#5432).
 */
export function patchGraphSelections(
  g: GSel,
  simNodes: GraphNode[],
  simEdges: GraphEdge[],
  actions: NodeActions,
  marks: NodeMarks = NO_MARKS,
): Pick<RenderResult, 'link' | 'node' | 'highlight'> {
  const degrees = countDegrees(simEdges)
  for (const n of simNodes) n.degree = degrees.get(n.id) ?? 0
  const radiusOf = (d: GraphNode): number => nodeRadius(d.degree ?? 0)

  const link = drawEdges(g.select<SVGGElement>('g.edges-layer'), simEdges)
  const node = drawNodes(g.select<SVGGElement>('g.nodes-layer'), simNodes, radiusOf, marks)

  attachNodeActions(node, actions)
  attachNodeRovingKeys(node, actions.reveal)
  const highlight = createNeighbourhoodHighlight(node, link, simEdges, marks.selectedId)
  attachNodeFocusStyles(node, highlight)
  attachNodeHover(node, highlight, radiusOf)

  return { link, node, highlight }
}

export function renderGraphElements(
  svg: SVGSVGElement,
  nodes: GraphNode[],
  edges: GraphEdge[],
  actions: NodeActions,
  marks: NodeMarks = NO_MARKS,
): RenderResult {
  const width = svg.clientWidth || DEFAULT_WIDTH
  const height = svg.clientHeight || DEFAULT_HEIGHT

  const svgSel = select(svg)
  svgSel.selectAll('*').remove()
  const g: GSel = svgSel.append('g')

  // Dedicated paint layers (#758 item 4): edges always render in a group that
  // precedes the node group in document order, so SVG painter's-order keeps
  // every edge under every node. Without the layers, a filter patch that
  // ENTERs new <line> elements would append them after the node <g>s and
  // paint them over the nodes.
  g.append('g').attr('class', 'edges-layer')
  g.append('g').attr('class', 'nodes-layer')

  // Clone nodes/edges so d3 can mutate them without React state issues.
  const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }))
  const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }))

  const nodeById = new Map<string, GraphNode>()
  for (const n of simNodes) {
    nodeById.set(n.id, n)
  }

  const { link, node, highlight } = patchGraphSelections(g, simNodes, simEdges, actions, marks)

  return { g, simNodes, simEdges, nodeById, link, node, highlight, width, height }
}

// ── Zoom + keyboard zoom ─────────────────────────────────────────────

/**
 * Duration for a d3 zoom transition, collapsed to `0` when the user asks for
 * reduced motion (#3308 finding 3).
 *
 * d3 transitions are rAF-driven JS, so the app's global
 * `@media (prefers-reduced-motion: reduce)` CSS rule cannot suppress them —
 * per `docs/UX.md`, JS-driven motion must consult `shouldReduceMotion()`
 * itself. A zero-duration transition still APPLIES the transform, it just
 * jumps straight to the end state, so the zoom keeps working.
 *
 * Resolved at CALL time (not cached at module load) so an OS or preference
 * change mid-session takes effect immediately.
 */
export function reducedMotionDuration(ms: number): number {
  return shouldReduceMotion() ? 0 : ms
}

export function setupZoomBehavior(
  svg: SVGSVGElement,
  g: GSel,
): ZoomBehavior<SVGSVGElement, unknown> {
  const svgSel = select(svg)
  const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform)
    })
  svgSel.call(zoomBehavior)
  svg.setAttribute('tabindex', '0')
  return zoomBehavior
}

export function createZoomKeyHandler(
  svg: SVGSVGElement,
  zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>,
  fitToView: () => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return
    const svgSelection = select(svg)
    if (matchesShortcutBinding(e, 'graphZoomIn')) {
      e.preventDefault()
      zoomBehavior.scaleBy(
        svgSelection.transition().duration(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)),
        ZOOM_STEP,
      )
    } else if (matchesShortcutBinding(e, 'graphZoomOut')) {
      e.preventDefault()
      zoomBehavior.scaleBy(
        svgSelection.transition().duration(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)),
        1 / ZOOM_STEP,
      )
    } else if (matchesShortcutBinding(e, 'graphZoomReset')) {
      e.preventDefault()
      fitToView()
    }
  }
}

/**
 * The zoom that frames every placed node, centred, with `FIT_PADDING` screen
 * pixels to spare and the scale capped at `FIT_MAX_SCALE`.
 */
export function fitTransform(
  nodes: readonly SimulationNodeDatum[],
  width: number,
  height: number,
): ZoomTransform {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const { x, y } of nodes) {
    if (x === undefined || y === undefined) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (minX > maxX) return zoomIdentity
  const scale = Math.min(
    (width - 2 * FIT_PADDING) / (maxX - minX),
    (height - 2 * FIT_PADDING) / (maxY - minY),
    FIT_MAX_SCALE,
  )
  return zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-(minX + maxX) / 2, -(minY + maxY) / 2)
}

/**
 * The zoom that centres `point` at the current scale, or `null` when the point
 * is already on screen with `FIT_PADDING` pixels to spare.
 */
export function revealTransform(
  transform: ZoomTransform,
  point: SimulationNodeDatum,
  width: number,
  height: number,
): ZoomTransform | null {
  const x = point.x ?? 0
  const y = point.y ?? 0
  const [screenX, screenY] = transform.apply([x, y])
  const inView =
    screenX >= FIT_PADDING &&
    screenX <= width - FIT_PADDING &&
    screenY >= FIT_PADDING &&
    screenY <= height - FIT_PADDING
  if (inView) return null
  return zoomIdentity
    .translate(width / 2, height / 2)
    .scale(transform.k)
    .translate(-x, -y)
}

// ── Position application ─────────────────────────────────────────────

/**
 * Update simNodes from a worker-reported packed `Float32Array` (#2194):
 * `[x0,y0,x1,y1,…]` in `order`'s index order (which mirrors the worker's
 * `simNodes`). Reading by index avoids per-node id lookups on the hot tick
 * path. `count` guards against a length mismatch (e.g. a tick that raced a
 * pending `update` posted with the previous node count).
 */
function applyPackedPositions(
  order: ReadonlyArray<GraphNode>,
  positions: Float32Array,
  count: number,
): void {
  const n = Math.min(count, order.length)
  for (let i = 0; i < n; i++) {
    const node = order[i]
    if (node) {
      node.x = positions[i * 2] ?? 0
      node.y = positions[i * 2 + 1] ?? 0
    }
  }
}

/**
 * Pure round-trippable position (un)packing (#2194) — exported for unit
 * tests. `packPositions` mirrors the worker's packing; `unpackPositions`
 * reads a packed buffer back into an `{id,x,y}[]` given the fixed id order.
 */
export function packPositions(nodes: ReadonlyArray<{ x?: number; y?: number }>): Float32Array {
  const buf = new Float32Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    buf[i * 2] = node?.x ?? 0
    buf[i * 2 + 1] = node?.y ?? 0
  }
  return buf
}

export function unpackPositions(
  positions: Float32Array,
  ids: ReadonlyArray<string>,
): NodePosition[] {
  const out: NodePosition[] = []
  const n = Math.min(ids.length, Math.floor(positions.length / 2))
  for (let i = 0; i < n; i++) {
    const id = ids[i]
    if (id !== undefined) {
      out.push({ id, x: positions[i * 2] ?? 0, y: positions[i * 2 + 1] ?? 0 })
    }
  }
  return out
}

function resolveEdgeEndpoints(
  simEdges: GraphEdge[],
  nodeById: ReadonlyMap<string, GraphNode>,
): void {
  for (const e of simEdges) {
    if (typeof e.source === 'string') {
      const src = nodeById.get(e.source)
      if (src) e.source = src
    }
    if (typeof e.target === 'string') {
      const tgt = nodeById.get(e.target)
      if (tgt) e.target = tgt
    }
  }
}

export function createApplyPositions(link: LinkSel, node: NodeSel): () => void {
  return () => {
    link
      .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
      .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
      .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
      .attr('y2', (d) => (d.target as GraphNode).y ?? 0)

    node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
  }
}

/** The position of every node the simulation has placed, by id. */
export function keptPositions(
  simNodes: readonly GraphNode[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  for (const n of simNodes) {
    if (n.x !== undefined && n.y !== undefined) positions.set(n.id, { x: n.x, y: n.y })
  }
  return positions
}

const SEED_SPACING = 10
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * In a layout with nodes already placed, start each node without a position on
 * d3's seed spiral, but from the centre rather than the corner. Not all on one
 * point: d3's charge kicks coincident nodes apart in proportion to how many
 * there are. With nothing placed, d3's own cold start lays every node out.
 */
export function seedUnplaced(nodes: readonly GraphNode[], width: number, height: number): void {
  if (nodes.every((n) => n.x === undefined)) return
  let i = 0
  for (const n of nodes) {
    if (n.x !== undefined) continue
    const radius = SEED_SPACING * Math.sqrt(i)
    n.x = width / 2 + radius * Math.cos(i * GOLDEN_ANGLE)
    n.y = height / 2 + radius * Math.sin(i * GOLDEN_ANGLE)
    i++
  }
}

/**
 * Put every node back where the kept layout had it and start a node new since
 * then from the centre (`seedUnplaced`), then resolve the edges to their nodes so
 * the first paint draws the layout before any tick lands. Returns whether every
 * node was kept.
 */
export function seedPositions(
  rendered: Pick<RenderResult, 'simNodes' | 'simEdges' | 'nodeById' | 'width' | 'height'>,
  positions: GraphLayout['positions'],
): boolean {
  let everyKept = true
  for (const n of rendered.simNodes) {
    const kept = positions.get(n.id)
    if (!kept) {
      everyKept = false
      continue
    }
    n.x = kept.x
    n.y = kept.y
  }
  seedUnplaced(rendered.simNodes, rendered.width, rendered.height)
  resolveEdgeEndpoints(rendered.simEdges, rendered.nodeById)
  return everyKept
}

// ── Worker simulation ────────────────────────────────────────────────

interface WorkerRunArgs extends SimulationCtx {
  onWorkerFailed: () => void
}

/**
 * A node as the worker gets it: its degree for the forces, and its last-known
 * `x`/`y`/`vx`/`vy` when it has them, so it keeps its place; without, so d3
 * seeds a brand-new node.
 */
function toWorkerNode(n: GraphNode): WorkerNode {
  return {
    id: n.id,
    label: n.label,
    degree: n.degree ?? 0,
    ...(n.x !== undefined ? { x: n.x } : {}),
    ...(n.y !== undefined ? { y: n.y } : {}),
    ...(n.vx !== undefined ? { vx: n.vx } : {}),
    ...(n.vy !== undefined ? { vy: n.vy } : {}),
  }
}

function postWorkerStart(worker: Worker, ctx: SimulationCtx): void {
  worker.postMessage({
    type: 'start',
    nodes: ctx.simNodes.map(toWorkerNode),
    edges: ctx.simEdges.map((e) => ({
      source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      ref_count: e.ref_count,
    })),
    width: ctx.width,
    height: ctx.height,
    keptSettled: ctx.keptSettled,
  })
}

/**
 * Post an `update` message (#2194) that swaps the worker simulation's
 * node/edge set in place, so persisting nodes drift instead of re-scattering.
 * Node order matches `ctx.simNodes`, which the main thread also uses as the
 * tick index→id mapping.
 */
function postWorkerUpdate(worker: Worker, ctx: SimulationCtx): void {
  worker.postMessage({
    type: 'update',
    nodes: ctx.simNodes.map(toWorkerNode),
    edges: ctx.simEdges.map((e) => ({
      source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      ref_count: e.ref_count,
    })),
  })
}

function createWorkerDrag(worker: Worker): ReturnType<typeof drag<SVGGElement, GraphNode>> {
  return drag<SVGGElement, GraphNode>()
    .on('start', (event, d) => {
      if (!event.active) {
        worker.postMessage({
          type: 'drag',
          nodeId: d.id,
          x: event.x,
          y: event.y,
          phase: 'start' as const,
        })
      }
      d.fx = d.x
      d.fy = d.y
    })
    .on('drag', (event, d) => {
      worker.postMessage({
        type: 'drag',
        nodeId: d.id,
        x: event.x,
        y: event.y,
        phase: 'drag' as const,
      })
      d.fx = event.x
      d.fy = event.y
    })
    .on('end', (event, d) => {
      if (!event.active) {
        worker.postMessage({
          type: 'drag',
          nodeId: d.id,
          x: event.x,
          y: event.y,
          phase: 'end' as const,
        })
      }
      d.fx = null
      d.fy = null
    })
}

function instantiateWorker(onFailure: (err: unknown) => void): Worker | null {
  try {
    return new Worker(new URL('../workers/graph-worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch (err) {
    onFailure(err)
    return null
  }
}

/**
 * Pull a useful cause out of a worker error event. Handles real `ErrorEvent`
 * instances (browsers) and duck-typed payloads (test mocks / edge runtimes).
 */
function extractErrorCause(event: Event): unknown {
  const candidate = event as Event & { error?: unknown; message?: unknown }
  if (candidate.error != null) return candidate.error
  if (typeof candidate.message === 'string' && candidate.message.length > 0) {
    return new Error(candidate.message)
  }
  return new Error(`worker ${event.type} event`)
}

export function runWorkerSimulation(args: WorkerRunArgs): SimulationHandle {
  const { onWorkerFailed, ...ctx } = args
  const noop = (): void => {}

  let failed = false
  const reportFailure = (eventType: string, cause: unknown): void => {
    if (failed) return
    failed = true
    logger.warn('GraphView', 'worker failed', { event: eventType }, cause)
    onWorkerFailed()
  }

  const worker = instantiateWorker((err) => reportFailure('construction', err))
  if (!worker) return { cleanup: noop, onResize: noop, onUpdate: noop, settled: () => false }

  let tickCount = 0
  // Only a new topology or canvas size unsettles a layout. A click on a node is
  // a drag without motion: it reheats the worker, and its ticks can land before
  // the click navigates away, so a tick must not unsettle a layout that ended.
  let settled = startAlpha(ctx.simNodes, ctx.keptSettled) === 0

  // Mutable ctx: `onUpdate` (#2194) swaps the live node/edge set in place
  // rather than tearing the worker down and respawning. The tick handler,
  // edge resolution, and DOM application all read from `live` so a post-update
  // tick lands on the CURRENT selections/ordering. `order` fixes the
  // index→id mapping for the packed `Float32Array` tick: it mirrors the
  // worker's `simNodes` order (the same order posted on `start`/`update`).
  const live = {
    order: ctx.simNodes,
    simEdges: ctx.simEdges,
    nodeById: ctx.nodeById,
    applyPositions: ctx.applyPositions,
    node: ctx.node,
  }

  // #747 item 2: coalesce per-tick DOM application to one rAF per frame.
  // The worker posts a full position array on EVERY tick (~300 ticks);
  // applying each immediately is the main-thread hot spot at 1-2k nodes on
  // mobile. We keep only the latest tick's positions and flush them once per
  // animation frame, so multiple ticks landing within a frame collapse to a
  // single `applyPositions` (DOM write). The `done` message still flushes
  // synchronously so the final settled layout is always exact.
  //
  // #2194: positions arrive as a packed `Float32Array` transferable; we keep
  // the latest {buffer,count} and unpack by index into `live.order`.
  let pendingPositions: { positions: Float32Array; count: number } | null = null
  let rafId: number | null = null

  const applyTick = (positions: Float32Array, count: number): void => {
    applyPackedPositions(live.order, positions, count)
    resolveEdgeEndpoints(live.simEdges, live.nodeById)
    live.applyPositions()
  }

  const flushPending = (): void => {
    rafId = null
    if (failed || pendingPositions === null) return
    const { positions, count } = pendingPositions
    pendingPositions = null
    applyTick(positions, count)
  }

  const scheduleFlush = (positions: Float32Array, count: number): void => {
    pendingPositions = { positions, count }
    if (rafId !== null) return
    rafId = requestAnimationFrame(flushPending)
  }

  // Final positions: cancel any pending frame and apply now so the last frame
  // never clobbers the converged layout.
  const settle = (positions: Float32Array, count: number): void => {
    settled = true
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    pendingPositions = null
    applyTick(positions, count)
    ctx.onSettled(live.order)
  }

  const handleMessage = (evt: MessageEvent<WorkerOutboundMessage>): void => {
    if (failed) return
    const msg = evt.data
    if (msg.type === 'tick') {
      tickCount++
      if (ctx.prefersReducedMotion && tickCount >= REDUCED_MOTION_TICK_LIMIT) {
        worker.postMessage({ type: 'stop' })
        settle(msg.positions, msg.count)
      } else {
        scheduleFlush(msg.positions, msg.count)
      }
    } else if (msg.type === 'done') {
      settle(msg.positions, msg.count)
    } else if (msg.type === 'error') {
      // Structured error from the worker dispatcher's try/catch (or
      // the worker's global error/unhandledrejection handlers). Route through
      // the same `reportFailure` path as boundary `error` events so the
      // orchestrator falls back to the main-thread simulation.
      reportFailure('worker-reported', new Error(msg.message))
      worker.terminate()
    }
  }

  const handleError = (event: Event): void => {
    const cause = extractErrorCause(event)
    reportFailure(event.type, cause)
    worker.terminate()
  }

  worker.addEventListener('message', handleMessage)
  worker.addEventListener('error', handleError)
  worker.addEventListener('messageerror', handleError)

  // Mutable dimensions so ResizeObserver re-posts can update them.
  // On resize we now send a dedicated `resize` message (#747 item 1): the
  // worker swaps its centering/bounds forces in place and nudges alpha,
  // keeping the current node positions instead of re-seeding from scratch
  // (which is what re-posting `start` did — a full re-scatter + re-converge
  // on every sidebar toggle / orientation change). Mirrors the
  // main-thread `applyResizeForces` path below.
  const current = { width: ctx.width, height: ctx.height }
  postWorkerStart(worker, { ...ctx, width: current.width, height: current.height })
  ctx.node.call(createWorkerDrag(worker))

  return {
    cleanup: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)
      worker.removeEventListener('messageerror', handleError)
      worker.terminate()
    },
    onResize: (width, height) => {
      if (failed) return
      if (width === current.width && height === current.height) return
      current.width = width
      current.height = height
      settled = false
      worker.postMessage({ type: 'resize', width, height })
    },
    onUpdate: (nextCtx) => {
      if (failed) return
      // #2194: swap the node/edge set on the LIVE worker simulation in place.
      // A pending tick was packed for the PREVIOUS node ordering — drop it so
      // it can't land on the new `live.order` (the next tick from the worker
      // will be packed for the new order).
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      pendingPositions = null
      settled = false

      postWorkerUpdate(worker, nextCtx)

      // Re-point the tick pipeline at the new selections/ordering and re-bind
      // drag to the refreshed node selection (its data + closures changed).
      live.order = nextCtx.simNodes
      live.simEdges = nextCtx.simEdges
      live.nodeById = nextCtx.nodeById
      live.applyPositions = nextCtx.applyPositions
      live.node = nextCtx.node
      nextCtx.node.call(createWorkerDrag(worker))
    },
    settled: () => settled,
  }
}

// ── Main-thread simulation ───────────────────────────────────────────

function createMainThreadDrag(
  sim: Simulation<GraphNode, GraphEdge>,
): ReturnType<typeof drag<SVGGElement, GraphNode>> {
  return drag<SVGGElement, GraphNode>()
    .on('start', (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart()
      d.fx = d.x
      d.fy = d.y
    })
    .on('drag', (event, d) => {
      d.fx = event.x
      d.fy = event.y
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0)
      d.fx = null
      d.fy = null
    })
}

function buildMainThreadSim(ctx: SimulationCtx): Simulation<GraphNode, GraphEdge> {
  return applyGraphForces(forceSimulation<GraphNode, GraphEdge>(ctx.simNodes), {
    edges: ctx.simEdges,
    width: ctx.width,
    height: ctx.height,
  }).alpha(startAlpha(ctx.simNodes, ctx.keptSettled))
}

/**
 * Swap the node/edge set on a live main-thread simulation IN PLACE (#2194).
 * Mirrors the worker `update` handler: re-bind `sim.nodes(...)` and the link
 * force's `links(...)` (which re-resolves string source/target ids against
 * the new node array via the `.id` accessor), then nudge alpha so the
 * existing layout drifts rather than re-scattering. Persisting nodes keep
 * their carried x/y/vx/vy; brand-new nodes are seeded by d3.
 */
function applyMainThreadUpdate(sim: Simulation<GraphNode, GraphEdge>, next: SimulationCtx): void {
  sim.nodes(next.simNodes)
  const linkForce = sim.force('link') as ReturnType<typeof forceLink<GraphNode, GraphEdge>> | null
  if (linkForce && typeof linkForce.links === 'function') linkForce.links(next.simEdges)
  sim.alpha(0.3).restart()
}

export function runMainThreadSimulation(ctx: SimulationCtx): SimulationHandle {
  const sim = buildMainThreadSim(ctx)
  ctx.node.call(createMainThreadDrag(sim))

  // Mutable `applyPositions` so the tick closure + `onUpdate` (#2194) read the
  // CURRENT patched selections after a filter toggle.
  const live = { applyPositions: ctx.applyPositions }

  const current = { width: ctx.width, height: ctx.height }

  if (ctx.prefersReducedMotion) {
    sim.alphaDecay(1)
    sim.tick(REDUCED_MOTION_TICK_LIMIT)
    live.applyPositions()
    sim.stop()
    ctx.onSettled(sim.nodes())
    return {
      cleanup: () => {
        sim.stop()
      },
      onResize: (width, height) => {
        if (width === current.width && height === current.height) return
        current.width = width
        current.height = height
        applyResizeForces(sim, { width, height })
        sim.alpha(RESIZE_ALPHA)
        sim.tick(REDUCED_MOTION_TICK_LIMIT)
        live.applyPositions()
        sim.stop()
      },
      onUpdate: (next) => {
        live.applyPositions = next.applyPositions
        next.node.call(createMainThreadDrag(sim))
        // Reduced-motion: run the sim synchronously to a settled layout and
        // apply once, matching the mount-time behaviour above.
        sim.alphaDecay(1)
        applyMainThreadUpdate(sim, next)
        sim.tick(REDUCED_MOTION_TICK_LIMIT)
        live.applyPositions()
        sim.stop()
      },
      settled: () => true,
    }
  }

  // Only a new topology or canvas size unsettles a layout; a click on a node
  // reheats the simulation through d3-drag, so a tick must not.
  let settled = startAlpha(ctx.simNodes, ctx.keptSettled) === 0
  sim.on('tick', () => {
    live.applyPositions()
  })
  sim.on('end', () => {
    settled = true
    ctx.onSettled(sim.nodes())
  })
  return {
    cleanup: () => {
      sim.stop()
    },
    onResize: (width, height) => {
      if (width === current.width && height === current.height) return
      current.width = width
      current.height = height
      settled = false
      applyResizeForces(sim, { width, height })
      sim.alpha(RESIZE_ALPHA).restart()
    },
    onUpdate: (next) => {
      settled = false
      live.applyPositions = next.applyPositions
      next.node.call(createMainThreadDrag(sim))
      applyMainThreadUpdate(sim, next)
    },
    settled: () => settled,
  }
}
