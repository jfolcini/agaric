/**
 * Pure d3 / worker / main-thread helpers for the graph force simulation.
 *
 * Extracted from `src/hooks/useGraphSimulation.ts` per MAINT-127. These
 * helpers have no React state — they are referentially-transparent
 * builders, drawers, and runners that the hooks compose into the
 * orchestrator's effect. Keep new pure graph helpers here.
 */

import { drag } from 'd3-drag'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force'
import { type Selection, select } from 'd3-selection'
import { type ZoomBehavior, zoom, zoomIdentity } from 'd3-zoom'

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
 * so the graph stays centered when the view container resizes (UX-238).
 */
export interface SimulationHandle {
  cleanup: () => void
  onResize: (width: number, height: number) => void
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

  // UX-357: native SVG <title> tooltip carries the full label so truncated
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
      case 'ArrowDown':
        next = (current + 1) % all.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + all.length) % all.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = all.length - 1
        break
    }
    const target = all[next]
    if (target) focusRovingNode(node, target)
  })
}

/**
 * Attach click + keyboard activation to graph nodes (UX-270).
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
 * Update simNodes from worker-reported positions and materialise edge
 * endpoints so `applyPositions` can read `(source as GraphNode).x`.
 * Kept small so cognitive complexity stays well under threshold.
 */
function updateNodePositions(
  nodeById: ReadonlyMap<string, GraphNode>,
  positions: ReadonlyArray<NodePosition>,
): void {
  for (const pos of positions) {
    const n = nodeById.get(pos.id)
    if (n) {
      n.x = pos.x
      n.y = pos.y
    }
  }
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
  if (!worker) return { cleanup: noop, onResize: noop }

  let tickCount = 0

  // #747 item 2: coalesce per-tick DOM application to one rAF per frame.
  // The worker posts a full position array on EVERY tick (~300 ticks);
  // applying each immediately is the main-thread hot spot at 1-2k nodes on
  // mobile. We keep only the latest tick's positions and flush them once per
  // animation frame, so multiple ticks landing within a frame collapse to a
  // single `applyPositions` (DOM write). The `done` message still flushes
  // synchronously so the final settled layout is always exact.
  let pendingPositions: ReadonlyArray<NodePosition> | null = null
  let rafId: number | null = null

  const flushPending = (): void => {
    rafId = null
    if (failed || pendingPositions === null) return
    updateNodePositions(ctx.nodeById, pendingPositions)
    pendingPositions = null
    resolveEdgeEndpoints(ctx.simEdges, ctx.nodeById)
    ctx.applyPositions()
  }

  const scheduleFlush = (positions: ReadonlyArray<NodePosition>): void => {
    pendingPositions = positions
    if (rafId !== null) return
    rafId = requestAnimationFrame(flushPending)
  }

  const handleMessage = (evt: MessageEvent<WorkerOutboundMessage>): void => {
    if (failed) return
    const msg = evt.data
    if (msg.type === 'tick') {
      tickCount++
      scheduleFlush(msg.positions)
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
      updateNodePositions(ctx.nodeById, msg.positions)
      resolveEdgeEndpoints(ctx.simEdges, ctx.nodeById)
      ctx.applyPositions()
    } else if (msg.type === 'error') {
      // PEND-22: structured error from the worker dispatcher's try/catch (or
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
  return forceSimulation(ctx.simNodes)
    .force(
      'link',
      forceLink<GraphNode, GraphEdge>(ctx.simEdges)
        .id((d) => d.id)
        .distance(60),
    )
    .force('charge', forceManyBody().strength(-100))
    .force('center', forceCenter(ctx.width / 2, ctx.height / 2))
    .force('collide', forceCollide(20))
    .force('x', forceX(ctx.width / 2).strength(0.05))
    .force('y', forceY(ctx.height / 2).strength(0.05))
}

export function runMainThreadSimulation(ctx: SimulationCtx): SimulationHandle {
  const sim = buildMainThreadSim(ctx)
  ctx.node.call(createMainThreadDrag(sim))

  const current = { width: ctx.width, height: ctx.height }
  const applyResizeForces = (width: number, height: number): void => {
    sim.force('center', forceCenter(width / 2, height / 2))
    sim.force('x', forceX(width / 2).strength(0.05))
    sim.force('y', forceY(height / 2).strength(0.05))
  }

  if (ctx.prefersReducedMotion) {
    sim.alphaDecay(1)
    sim.tick(REDUCED_MOTION_TICK_LIMIT)
    ctx.applyPositions()
    sim.stop()
    return {
      cleanup: () => {
        sim.stop()
      },
      onResize: (width, height) => {
        if (width === current.width && height === current.height) return
        current.width = width
        current.height = height
        applyResizeForces(width, height)
        sim.alpha(0.3)
        sim.tick(REDUCED_MOTION_TICK_LIMIT)
        ctx.applyPositions()
        sim.stop()
      },
    }
  }

  sim.on('tick', () => {
    ctx.applyPositions()
  })
  return {
    cleanup: () => {
      sim.stop()
    },
    onResize: (width, height) => {
      if (width === current.width && height === current.height) return
      current.width = width
      current.height = height
      applyResizeForces(width, height)
      sim.alpha(0.3).restart()
    },
  }
}
