/**
 * Pure d3 / worker / main-thread helpers for the graph force simulation.
 *
 * Extracted from `src/hooks/useGraphSimulation.ts`. These
 * helpers have no React state — they are referentially-transparent
 * builders, drawers, and runners that the hooks compose into the
 * orchestrator's effect. Keep new pure graph helpers here.
 */

import { drag } from 'd3-drag'
import { forceLink, forceSimulation, type Simulation } from 'd3-force'
import { type Selection, select } from 'd3-selection'
import { type ZoomBehavior, zoom, zoomIdentity } from 'd3-zoom'

import { applyGraphForces, applyResizeForces, RESIZE_ALPHA } from '@/lib/graph-forces'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import type { NodePosition, WorkerOutboundMessage } from '@/workers/graph-worker-types'

// ── Constants ────────────────────────────────────────────────────────

export const DEFAULT_WIDTH = 800
export const DEFAULT_HEIGHT = 600
const NODE_HIT_RADIUS = 22
const NODE_RADIUS = 6
const NODE_HOVER_RADIUS = 8
const NODE_ACTIVE_RADIUS = 5
const EDGE_WIDTH_MAX = 6
const EDGE_WIDTH_BASE = 1
const EDGE_OPACITY_BASE = 0.5
const EDGE_OPACITY_STEP = 0.1
const DIMMED_NODE_OPACITY = '0.3'
const DIMMED_EDGE_OPACITY = '0.15'
export const ZOOM_BUTTON_DURATION_MS = 200
export const ZOOM_RESET_DURATION_MS = 300
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
  width: number
  height: number
}

export interface SimulationCtx {
  simNodes: GraphNode[]
  simEdges: GraphEdge[]
  nodeById: Map<string, GraphNode>
  node: NodeSel
  applyPositions: () => void
  width: number
  height: number
  prefersReducedMotion: boolean
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
}

// ── SVG / d3 setup ───────────────────────────────────────────────────

function drawEdges(g: GSel, simEdges: GraphEdge[]): LinkSel {
  return g
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(simEdges)
    .join('line')
    .attr('stroke', 'var(--muted-foreground)')
    .attr('stroke-opacity', (d: GraphEdge) => {
      const count = Math.max(1, d.ref_count ?? 1)
      return Math.min(EDGE_OPACITY_BASE + EDGE_OPACITY_STEP * count, 1)
    })
    .attr('stroke-width', (d: GraphEdge) => {
      const count = Math.max(1, d.ref_count ?? 1)
      return Math.min(EDGE_WIDTH_BASE + Math.log2(count), EDGE_WIDTH_MAX)
    })
}

function drawNodes(g: GSel, simNodes: GraphNode[]): NodeSel {
  const node = g
    .selectAll<SVGGElement, GraphNode>('g.node')
    .data(simNodes)
    .join('g')
    .attr('class', 'node')
    // #1725 — roving tabindex: only ONE node is in the page tab order at a
    // time (the first; thereafter the last-focused). All others are
    // `tabindex="-1"` and reached via Arrow keys, so a large graph is a
    // single Tab stop instead of hundreds. `applyRovingTabindex` sets the
    // initial -1/0 split; `attachNodeRovingKeys` handles Arrow/Home/End.
    .attr('role', 'button')
    // #1725 — explicit accessible name per node (don't rely solely on the
    // child <title>, whose name computation is inconsistent across screen
    // readers under role="button").
    .attr('aria-label', (d) => d.label)
    .style('cursor', 'pointer')

  applyRovingTabindex(node)

  // Hit-area circle for touch targets (44px diameter).
  node
    .append('circle')
    .attr('r', NODE_HIT_RADIUS)
    .attr('fill', 'transparent')
    .style('pointer-events', 'all')
    .attr('class', 'hit-area')

  node.append('circle').attr('r', NODE_RADIUS).attr('fill', 'var(--primary)')

  node
    .append('text')
    .text((d) => (d.label.length > 20 ? `${d.label.slice(0, 20)}…` : d.label))
    .attr('dx', 10)
    .attr('dy', 4)
    .attr('fill', 'var(--foreground)')
    .attr('font-size', '12px')
    .style('pointer-events', 'none')
    .style('user-select', 'none')

  // Native SVG <title> tooltip carries the full label so truncated
  // names ("prefix…") are still discoverable on hover.
  node.append('title').text((d) => d.label)

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

/**
 * Arrow/Home/End navigation across the node selection (roving tabindex).
 * Bound under the `.roving` keydown namespace so it coexists with the
 * activation handler in `attachNodeClickAndKeyboard`.
 */
export function attachNodeRovingKeys(node: NodeSel): void {
  node.on('keydown.roving', function (event: KeyboardEvent) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const all = node.nodes()
    if (all.length === 0) return
    const current = all.indexOf(this as SVGGElement)
    if (current === -1) return
    event.preventDefault()
    let next = current
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': {
        next = (current + 1) % all.length
        break
      }
      case 'ArrowLeft':
      case 'ArrowUp': {
        next = (current - 1 + all.length) % all.length
        break
      }
      case 'Home': {
        next = 0
        break
      }
      case 'End': {
        next = all.length - 1
        break
      }
    }
    const target = all[next]
    if (target) focusRovingNode(node, target)
  })
}

/**
 * Attach click + keyboard activation to graph nodes.
 *
 * Each node `<g>` has `role="button"` (set in `drawNodes`) and a roving
 * `tabindex` (#1725). This handler mirrors the native button activation
 * contract: Enter and Space both navigate to the underlying page (with
 * `preventDefault` on Space to suppress page-scroll). Click parity comes
 * from the `click` listener so pointer + keyboard paths converge on
 * `navigateToPage`.
 */
function attachNodeClickAndKeyboard(
  node: NodeSel,
  navigateToPage: (id: string, label: string) => void,
): void {
  node.on('click', (_event, d) => {
    navigateToPage(d.id, d.label)
  })

  node.on('keydown', (event, d) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      navigateToPage(d.id, d.label)
    }
  })
}

function attachNodeFocusStyles(node: NodeSel): void {
  node.on('focus', function () {
    select(this).select('circle:nth-child(2)').attr('stroke', 'var(--ring)').attr('stroke-width', 2)
    select(this).select('text').attr('font-size', '14px').attr('font-weight', '600')
  })
  node.on('blur', function () {
    select(this).select('circle:nth-child(2)').attr('stroke', null).attr('stroke-width', null)
    select(this).select('text').attr('font-size', '12px').attr('font-weight', null)
  })
}

function attachNodeHover(node: NodeSel, link: LinkSel): void {
  node.on('mouseenter', function () {
    const self = select(this)
    self.select('circle:nth-child(2)').attr('r', NODE_HOVER_RADIUS)
    self
      .select('text')
      .attr('font-size', '14px')
      .attr('font-weight', '600')
      .style('paint-order', 'stroke')
      .attr('stroke', 'var(--background)')
      .attr('stroke-width', '3px')
    node
      .filter(function () {
        return this !== self.node()
      })
      .style('opacity', DIMMED_NODE_OPACITY)
    link.style('opacity', (d: GraphEdge) => {
      const src = typeof d.source === 'string' ? d.source : (d.source as GraphNode).id
      const tgt = typeof d.target === 'string' ? d.target : (d.target as GraphNode).id
      const nodeId = self.datum() as GraphNode
      return src === nodeId.id || tgt === nodeId.id ? '1' : DIMMED_EDGE_OPACITY
    })
  })

  node.on('mouseleave', function () {
    const self = select(this)
    self.select('circle:nth-child(2)').attr('r', NODE_RADIUS)
    self
      .select('text')
      .attr('font-size', '12px')
      .attr('font-weight', null)
      .style('paint-order', null)
      .attr('stroke', null)
      .attr('stroke-width', null)
    node.style('opacity', null)
    link.style('opacity', null)
  })

  node.on('pointerdown', function () {
    select(this).select('circle:nth-child(2)').attr('r', NODE_ACTIVE_RADIUS)
  })
  node.on('pointerup', function () {
    select(this).select('circle:nth-child(2)').attr('r', NODE_HOVER_RADIUS)
  })
}

export function renderGraphElements(
  svg: SVGSVGElement,
  nodes: GraphNode[],
  edges: GraphEdge[],
  navigateToPage: (id: string, label: string) => void,
): RenderResult {
  const width = svg.clientWidth || DEFAULT_WIDTH
  const height = svg.clientHeight || DEFAULT_HEIGHT

  const svgSel = select(svg)
  svgSel.selectAll('*').remove()
  const g: GSel = svgSel.append('g')

  // Dedicated paint layers (#758 item 4): edges always render in a group that
  // precedes the node group in document order, so SVG painter's-order keeps
  // every edge under every node. Without the layers, a later data-join that
  // ENTERs new <line> elements (the patch path in useGraphSimulation) would
  // append them after the node <g>s and paint them over the nodes.
  const edgeLayer: GSel = g.append('g').attr('class', 'edges-layer')
  const nodeLayer: GSel = g.append('g').attr('class', 'nodes-layer')

  // Clone nodes/edges so d3 can mutate them without React state issues.
  const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }))
  const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }))

  const nodeById = new Map<string, GraphNode>()
  for (const n of simNodes) {
    nodeById.set(n.id, n)
  }

  const link = drawEdges(edgeLayer, simEdges)
  const node = drawNodes(nodeLayer, simNodes)

  attachNodeClickAndKeyboard(node, navigateToPage)
  attachNodeRovingKeys(node)
  attachNodeFocusStyles(node)
  attachNodeHover(node, link)

  return { g, simNodes, simEdges, nodeById, link, node, width, height }
}

// ── Zoom + keyboard zoom ─────────────────────────────────────────────

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

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
}

export function createZoomKeyHandler(
  svg: SVGSVGElement,
  zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return
    const svgSelection = select(svg)
    if (matchesShortcutBinding(e, 'graphZoomIn')) {
      e.preventDefault()
      zoomBehavior.scaleBy(svgSelection.transition().duration(ZOOM_BUTTON_DURATION_MS), ZOOM_STEP)
    } else if (matchesShortcutBinding(e, 'graphZoomOut')) {
      e.preventDefault()
      zoomBehavior.scaleBy(
        svgSelection.transition().duration(ZOOM_BUTTON_DURATION_MS),
        1 / ZOOM_STEP,
      )
    } else if (matchesShortcutBinding(e, 'graphZoomReset')) {
      e.preventDefault()
      zoomBehavior.transform(
        svgSelection.transition().duration(ZOOM_RESET_DURATION_MS),
        zoomIdentity,
      )
    }
  }
}

/** Re-export `zoomIdentity` for the orchestrator's zoom-reset callback. */
export { zoomIdentity }

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

// ── Worker simulation ────────────────────────────────────────────────

interface WorkerRunArgs extends SimulationCtx {
  onWorkerFailed: () => void
}

function postWorkerStart(worker: Worker, ctx: SimulationCtx): void {
  worker.postMessage({
    type: 'start',
    nodes: ctx.simNodes.map((n) => ({ id: n.id, label: n.label })),
    edges: ctx.simEdges.map((e) => ({
      source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      ref_count: e.ref_count,
    })),
    width: ctx.width,
    height: ctx.height,
  })
}

/**
 * Post an `update` message (#2194) that swaps the worker simulation's
 * node/edge set in place. Carries each node's last-known `x`/`y`/`vx`/`vy`
 * (when present) so persisting nodes drift instead of re-scattering; a
 * brand-new node with undefined coords is sent without position fields so the
 * worker leaves d3 to seed it. Node order matches `ctx.simNodes`, which the
 * main thread also uses as the tick index→id mapping.
 */
function postWorkerUpdate(worker: Worker, ctx: SimulationCtx): void {
  worker.postMessage({
    type: 'update',
    nodes: ctx.simNodes.map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.x !== undefined ? { x: n.x } : {}),
      ...(n.y !== undefined ? { y: n.y } : {}),
      ...(n.vx !== undefined ? { vx: n.vx } : {}),
      ...(n.vy !== undefined ? { vy: n.vy } : {}),
    })),
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
  if (!worker) return { cleanup: noop, onResize: noop, onUpdate: noop }

  let tickCount = 0

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

  const handleMessage = (evt: MessageEvent<WorkerOutboundMessage>): void => {
    if (failed) return
    const msg = evt.data
    if (msg.type === 'tick') {
      tickCount++
      scheduleFlush(msg.positions, msg.count)
      if (ctx.prefersReducedMotion && tickCount >= REDUCED_MOTION_TICK_LIMIT) {
        worker.postMessage({ type: 'stop' })
      }
    } else if (msg.type === 'done') {
      // Final settled positions: cancel any pending frame and apply now so the
      // last frame never clobbers the converged layout.
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      pendingPositions = null
      applyTick(msg.positions, msg.count)
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
  }
}

// ── Main-thread simulation ───────────────────────────────────────────

function createMainThreadDrag(
  sim: Simulation<GraphNode, GraphEdge>,
): ReturnType<typeof drag<SVGGElement, GraphNode>> {
  return drag<SVGGElement, GraphNode>()
    .on('start', (event, d) => {
      if (!event.active) sim.alpha(0.3).restart()
      d.fx = d.x
      d.fy = d.y
    })
    .on('drag', (event, d) => {
      d.fx = event.x
      d.fy = event.y
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alpha(0).restart()
      d.fx = null
      d.fy = null
    })
}

function buildMainThreadSim(ctx: SimulationCtx): Simulation<GraphNode, GraphEdge> {
  return applyGraphForces(forceSimulation<GraphNode, GraphEdge>(ctx.simNodes), {
    edges: ctx.simEdges,
    width: ctx.width,
    height: ctx.height,
  })
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
    }
  }

  sim.on('tick', () => {
    live.applyPositions()
  })
  return {
    cleanup: () => {
      sim.stop()
    },
    onResize: (width, height) => {
      if (width === current.width && height === current.height) return
      current.width = width
      current.height = height
      applyResizeForces(sim, { width, height })
      sim.alpha(RESIZE_ALPHA).restart()
    },
    onUpdate: (next) => {
      live.applyPositions = next.applyPositions
      next.node.call(createMainThreadDrag(sim))
      applyMainThreadUpdate(sim, next)
    },
  }
}
