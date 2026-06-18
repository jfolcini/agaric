/**
 * useGraphSimulation — orchestrator for GraphView's d3-force simulation
 * (MAINT-57 + BUG-45). Decomposed per MAINT-127 into:
 *
 *   - `useGraphZoom` — zoom behavior + keyboard zoom + zoomIn/Out/Reset.
 *   - `useGraphRenderElements` — d3 selections + node/edge rendering.
 *   - `useGraphWorkerSimulation` — worker path with failure recovery.
 *   - `useGraphMainThreadSim` — main-thread fallback simulation.
 *   - `src/lib/graph-sim-helpers.ts` — pure d3 / worker helpers.
 *
 * Effect lifecycle (PERF-Tier2 item 8): split into two effects so filter
 * toggles patch the live SVG instead of tearing it down.
 *
 *   - **Setup-or-patch effect**: keyed on `[svgRef, workerFailed,
 *     attachZoom, renderElements, runWorker, runMainThread]`. Only
 *     fires when the simulation *kind* changes (mount, worker-fallback
 *     flip, or a zoom/runner/render callback identity change). Builds
 *     the SVG layer, attaches zoom, observes the canvas, runs the
 *     simulation. `nodes`/`edges` are consumed via refs so this effect
 *     does not re-fire on filter toggles.
 *   - **Patch effect**: keyed on `[nodes, edges]`. On filter toggle
 *     this effect runs alone: it does d3's `selection.data(...)
 *     .join(...)` on the persistent `g` group (so existing node/edge
 *     DOM survives), re-binds click/keyboard/hover handlers on the
 *     merged selection, and re-runs the simulation against the patched
 *     ctx — without rebuilding the zoom layer or the ResizeObserver
 *     attached to the SVG. Existing node x/y positions are carried
 *     into the fresh `simNodes`, so visible nodes don't snap back to
 *     the centre.
 *
 * Pre-PERF-Tier2-8 this was a single effect with `[svgRef, nodes,
 * workerFailed, attachZoom, renderElements, runWorker, runMainThread]`
 * deps. `nodes`/`renderElements` flipped identity on every filter
 * change, tearing down the worker + SVG + zoom + ResizeObserver and
 * rebuilding them all (visible as flicker on every filter click).
 */

import { select } from 'd3-selection'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'

import { useGraphMainThreadSim } from '@/hooks/useGraphMainThreadSim'
import { useGraphRenderElements } from '@/hooks/useGraphRenderElements'
import { useGraphWorkerSimulation } from '@/hooks/useGraphWorkerSimulation'
import { useGraphZoom } from '@/hooks/useGraphZoom'
import {
  applyRovingTabindex,
  attachNodeRovingKeys,
  createApplyPositions,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  type LinkSel,
  type NodeSel,
  type RenderResult,
  type SimulationCtx,
  type SimulationHandle,
} from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'

export interface UseGraphSimulationArgs {
  svgRef: React.RefObject<SVGSVGElement | null>
  nodes: GraphNode[]
  edges: GraphEdge[]
  navigateToPage: (id: string, label: string) => void
}

export interface UseGraphSimulationResult {
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

/**
 * SVG attribute constants — kept in sync with `graph-sim-helpers.ts`'s
 * `drawEdges`/`drawNodes`. Duplicated here because the patch effect
 * cannot reuse those private helpers (they live behind
 * `renderGraphElements` which `selectAll('*').remove()`s the SVG —
 * exactly what the patch must avoid). If `graph-sim-helpers.ts`'s
 * drawing constants change, mirror them here.
 */
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
const LABEL_TRUNCATE_LEN = 20

function truncateLabel(label: string): string {
  return label.length > LABEL_TRUNCATE_LEN ? `${label.slice(0, LABEL_TRUNCATE_LEN)}…` : label
}

/**
 * Patch the persistent `g` selection with new nodes/edges via d3's
 * data-join, keyed by node id so existing DOM elements survive filter
 * changes. Returns refreshed `LinkSel`/`NodeSel` for the caller to feed
 * the new simulation context.
 *
 * The UPDATE branch keeps existing children (hit-area, circle, text,
 * title) intact; only the label `<text>`/`<title>` text content is
 * refreshed for renamed pages. The ENTER branch recreates the same
 * sub-tree as `drawNodes` in graph-sim-helpers. EXIT removes
 * filtered-out nodes.
 *
 * Listeners (click, keydown, focus, blur, mouseenter/leave,
 * pointerdown/up) are re-bound on the merged selection so handler
 * closures pick up the latest `navigateToPage`.
 *
 * Joins are scoped to the dedicated layer groups created by
 * `renderGraphElements` (`g.edges-layer` / `g.nodes-layer`) so ENTERing
 * `<line>` elements append inside the edge layer — which precedes the
 * node layer in document order — and never paint over nodes
 * (#758 item 4).
 *
 * @internal exported for direct DOM-level tests only.
 */
export function patchGraphSelections(
  g: RenderResult['g'],
  simNodes: GraphNode[],
  simEdges: GraphEdge[],
  navigateToPage: (id: string, label: string) => void,
): { link: LinkSel; node: NodeSel } {
  const edgeLayer = g.select<SVGGElement>('g.edges-layer')
  const nodeLayer = g.select<SVGGElement>('g.nodes-layer')

  // ── Edges ────────────────────────────────────────────────────────
  const link: LinkSel = edgeLayer
    .selectAll<SVGLineElement, GraphEdge>('line')
    .data(simEdges, (d: GraphEdge) => {
      const s = typeof d.source === 'string' ? d.source : (d.source as GraphNode).id
      const t = typeof d.target === 'string' ? d.target : (d.target as GraphNode).id
      return `${s}->${t}`
    })
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

  // ── Nodes ────────────────────────────────────────────────────────
  const node: NodeSel = nodeLayer
    .selectAll<SVGGElement, GraphNode>('g.node')
    .data(simNodes, (d: GraphNode) => d.id)
    .join(
      (enter) => {
        const grp = enter
          .append('g')
          .attr('class', 'node')
          // #1725 — roving tabindex (set below via applyRovingTabindex) +
          // explicit per-node aria-label so the accessible name doesn't rely
          // solely on the child <title>.
          .attr('role', 'button')
          .attr('aria-label', (d) => d.label)
          .style('cursor', 'pointer')

        grp
          .append('circle')
          .attr('r', NODE_HIT_RADIUS)
          .attr('fill', 'transparent')
          .style('pointer-events', 'all')
          .attr('class', 'hit-area')

        grp.append('circle').attr('r', NODE_RADIUS).attr('fill', 'var(--primary)')

        grp
          .append('text')
          .text((d) => truncateLabel(d.label))
          .attr('dx', 10)
          .attr('dy', 4)
          .attr('fill', 'var(--foreground)')
          .attr('font-size', '12px')
          .style('pointer-events', 'none')
          .style('user-select', 'none')

        grp.append('title').text((d) => d.label)
        return grp
      },
      (update) => {
        // Refresh label text for renamed pages — datum reference
        // changed, even though the DOM element is the same.
        update.select<SVGTextElement>('text').text((d) => truncateLabel(d.label))
        update.select<SVGTitleElement>('title').text((d) => d.label)
        // #1725 — keep the explicit accessible name in sync on rename.
        update.attr('aria-label', (d) => d.label)
        return update
      },
      (exit) => exit.remove(),
    )

  // #1725 — (re)establish the roving tabindex on the merged selection and
  // bind Arrow/Home/End navigation. Mirrors `renderGraphElements` so the
  // patch path (filter toggles) keeps the single-Tab-stop behaviour. Run
  // before the activation/focus listeners below so all handlers attach to
  // the same merged selection.
  applyRovingTabindex(node)
  attachNodeRovingKeys(node)

  // ── Listeners (re-bound each patch so closures pick up the latest
  // `navigateToPage`). d3's `.on()` replaces existing handlers, so this
  // does not accumulate listeners across patches.
  node.on('click', (_event, d) => {
    navigateToPage(d.id, d.label)
  })
  node.on('keydown', (event, d) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      navigateToPage(d.id, d.label)
    }
  })

  node.on('focus', function () {
    select(this).select('circle:nth-child(2)').attr('stroke', 'var(--ring)').attr('stroke-width', 2)
    select(this).select('text').attr('font-size', '14px').attr('font-weight', '600')
  })
  node.on('blur', function () {
    select(this).select('circle:nth-child(2)').attr('stroke', null).attr('stroke-width', null)
    select(this).select('text').attr('font-size', '12px').attr('font-weight', null)
  })

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

  return { link, node }
}

/**
 * Container for state that survives between effect runs. Mutated in
 * place inside the setup effect and the patch effect.
 *
 * `handledNodes`/`handledEdges` snapshot the array identities the
 * setup effect (or a previous patch) already wired up. The patch
 * effect compares against these to skip a redundant patch on the same
 * render tick that setup ran on — without this guard both effects
 * fire on mount and would double-spawn the worker/simulation.
 */
interface PersistentSimState {
  rendered: RenderResult
  handle: SimulationHandle
  prefersReducedMotion: boolean
  handledNodes: GraphNode[]
  handledEdges: GraphEdge[]
}

export function useGraphSimulation({
  svgRef,
  nodes,
  edges,
  navigateToPage,
}: UseGraphSimulationArgs): UseGraphSimulationResult {
  const { attach: attachZoom, zoomIn, zoomOut, zoomReset } = useGraphZoom(svgRef)
  const renderElements = useGraphRenderElements({ nodes, edges, navigateToPage })
  const { workerFailed, runWorker } = useGraphWorkerSimulation()
  const runMainThread = useGraphMainThreadSim()

  // ── Persistent state across effect runs ──────────────────────────
  const stateRef = useRef<PersistentSimState | null>(null)

  // `setupKey` is bumped by the patch effect when it detects that
  // setup has not yet run (initial empty-nodes render followed by
  // nodes arriving). Listing it in the setup effect's deps lets that
  // effect re-fire with the now-non-empty nodes (read via ref). This
  // is the React-idiomatic way to chain "do setup once data is
  // ready" without putting `nodes` itself in the setup deps (which
  // would re-fire on every filter toggle).
  const [setupKey, setSetupKey] = useState(0)

  // Refs for the latest data + nav callback + renderElements so the
  // setup effect can build the simulation context without listing
  // them in its deps. Filter-induced identity flips of `nodes`/
  // `edges`/`navigateToPage` propagate into `renderElements`'s
  // useCallback identity — listing `renderElements` in the setup
  // effect's deps would re-fire setup on every filter toggle (which
  // is precisely what PERF-Tier2 item 8 is fixing).
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const navigateToPageRef = useRef(navigateToPage)
  const renderElementsRef = useRef(renderElements)
  nodesRef.current = nodes
  edgesRef.current = edges
  navigateToPageRef.current = navigateToPage
  renderElementsRef.current = renderElements

  // ── Setup effect ─────────────────────────────────────────────────
  // Runs only when the simulation *kind* changes (mount, worker
  // failure flip, or a zoom/runner callback identity change). Reads
  // the latest data + renderElements via refs so filter toggles do
  // not re-fire this effect. (nodes/edges/navigateToPage/renderElements
  // are intentionally consumed via refs; the exhaustive-deps directive
  // lives on the deps array below where oxlint anchors the diagnostic.)
  useEffect(() => {
    if (nodesRef.current.length === 0 || !svgRef.current) return
    const svg = svgRef.current

    const rendered = renderElementsRef.current(svg)
    const applyPositions = createApplyPositions(rendered.link, rendered.node)
    const detachZoom = attachZoom(svg, rendered.g)

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const ctx: SimulationCtx = {
      simNodes: rendered.simNodes,
      simEdges: rendered.simEdges,
      nodeById: rendered.nodeById,
      node: rendered.node,
      applyPositions,
      width: rendered.width,
      height: rendered.height,
      prefersReducedMotion,
    }

    const useWorker = typeof Worker !== 'undefined' && !workerFailed
    const handle = useWorker ? runWorker(ctx) : runMainThread(ctx)

    // ── ResizeObserver: re-anchor centering forces on SVG resize ──
    //
    // UX-238: before this, the simulation read `svg.clientWidth /
    // clientHeight` exactly once at mount. When the view container
    // resized (window resize, sidebar toggle, orientation change), the
    // simulation's `forceCenter` / `forceX` / `forceY` stayed anchored
    // to the initial dimensions and nodes drifted off-center.
    //
    // The observer reads from `stateRef.current.handle` so resize
    // events after a patch hit the *current* simulation handle, not
    // the one captured at observer-construction time.
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const width = svg.clientWidth || DEFAULT_WIDTH
        const height = svg.clientHeight || DEFAULT_HEIGHT
        const current = stateRef.current
        if (current) current.handle.onResize(width, height)
      })
      resizeObserver.observe(svg)
    }

    stateRef.current = {
      rendered,
      handle,
      prefersReducedMotion,
      handledNodes: nodesRef.current,
      handledEdges: edgesRef.current,
    }

    return () => {
      resizeObserver?.disconnect()
      const current = stateRef.current
      if (current) {
        current.handle.cleanup()
      }
      detachZoom()
      stateRef.current = null
    }
  }, [svgRef, workerFailed, attachZoom, runWorker, runMainThread, setupKey])

  // ── Patch effect ─────────────────────────────────────────────────
  // Runs on filter changes (any `nodes`/`edges` identity flip without
  // a simulation-kind change). Patches the persistent `g` selection
  // via d3's data-join keyed by node id, then re-runs the simulation
  // against the new ctx. The same `g` element survives so zoom +
  // ResizeObserver stay attached and the SVG does not repaint from
  // scratch — only the diffed nodes/edges enter/exit.
  //
  // Also handles the "nodes arrived late" case: when the setup effect
  // ran with empty `nodes` (returning early before building anything),
  // this effect catches the first non-empty render and triggers the
  // setup effect by bumping `setupKey`. See `setupKey` below.
  // Note: workerFailed/runWorker/runMainThread are consumed via closure
  // but intentionally NOT listed in this effect's deps — when they flip,
  // the setup effect re-fires and rebuilds everything, so the patch
  // effect must not also fire on those changes. (The functional
  // exhaustive-deps directive for that omission lives on the deps array
  // below, where oxlint anchors the diagnostic.)
  useEffect(() => {
    const state = stateRef.current
    if (!svgRef.current) return
    if (nodes.length === 0) {
      // BUG #746: a filter combination that matches nothing leaves the
      // previous graph painted with its worker/main-thread simulation
      // still ticking. Pre-fix this branch early-returned BEFORE the
      // exit join and BEFORE handle.cleanup(), so the stale graph + live
      // simulation persisted. Now: clear the rendered node/edge layers
      // (the exit join with an empty data set removes every element) and
      // tear down the simulation handle. The persistent `g` group, zoom
      // behavior, and ResizeObserver stay attached so a later non-empty
      // filter re-populates without rebuilding the SVG layer.
      if (state && (state.handledNodes.length > 0 || state.handledEdges.length > 0)) {
        patchGraphSelections(state.rendered.g, [], [], navigateToPageRef.current)
        state.handle.cleanup()
        state.handle = { cleanup: () => {}, onResize: () => {} }
        state.rendered = {
          ...state.rendered,
          simNodes: [],
          simEdges: [],
          nodeById: new Map(),
        }
        state.handledNodes = nodes
        state.handledEdges = edges
      }
      return
    }
    if (!state) {
      // Setup hasn't run yet (mount happened with empty nodes, or
      // the previous setup bailed). Trigger setup by bumping the
      // version state — the setup effect will re-fire with the new
      // `setupKey` dep and pick up the now-non-empty nodes via refs.
      setSetupKey((k) => k + 1)
      return
    }

    // Skip if the setup effect (or a prior patch) already wired up
    // this exact `nodes`/`edges` identity. Without this guard, both
    // effects fire on mount and would double-spawn the worker.
    if (state.handledNodes === nodes && state.handledEdges === edges) return

    const svg = svgRef.current

    // Build fresh simNodes/simEdges (cloned so d3-force can mutate
    // them without React state issues — same convention as
    // `renderGraphElements`). Preserve x/y/vx/vy from the existing
    // simulation when ids match, so visible nodes don't snap back to
    // the centre on filter toggle.
    const prevById = state.rendered.nodeById
    const simNodes: GraphNode[] = nodes.map((n) => {
      const prev = prevById.get(n.id)
      return prev ? { ...n, x: prev.x, y: prev.y, vx: prev.vx, vy: prev.vy } : { ...n }
    })
    const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }))
    const nodeById = new Map<string, GraphNode>()
    for (const n of simNodes) {
      nodeById.set(n.id, n)
    }

    // Patch SVG selections in place via .data(...).join(...).
    const { link, node } = patchGraphSelections(
      state.rendered.g,
      simNodes,
      simEdges,
      navigateToPageRef.current,
    )

    // Dispose the previous simulation handle BUT not the zoom or
    // ResizeObserver — those stay attached to the persistent `g`/svg.
    // The runners (runWorkerSimulation / runMainThreadSimulation)
    // take a full SimulationCtx, so the new simulation gets a fresh
    // ctx pointing at the patched selections. The worker IS
    // re-spawned on each filter change because graph-sim-helpers
    // doesn't expose an "update data" message on the worker protocol
    // — that's an opportunity for a future tier, but the SVG/zoom/
    // observer preservation already eliminates the user-visible
    // flicker.
    state.handle.cleanup()

    const applyPositions = createApplyPositions(link, node)
    const width = svg.clientWidth || DEFAULT_WIDTH
    const height = svg.clientHeight || DEFAULT_HEIGHT

    const ctx: SimulationCtx = {
      simNodes,
      simEdges,
      nodeById,
      node,
      applyPositions,
      width,
      height,
      prefersReducedMotion: state.prefersReducedMotion,
    }

    const useWorker = typeof Worker !== 'undefined' && !workerFailed
    const handle = useWorker ? runWorker(ctx) : runMainThread(ctx)

    // Update persistent state in place. The `g` selection itself is
    // unchanged, but the rendered link/node selections + simNodes
    // refs need refreshing so the next patch builds on the latest.
    state.rendered = {
      ...state.rendered,
      simNodes,
      simEdges,
      nodeById,
      link,
      node,
      width,
      height,
    }
    state.handle = handle
    state.handledNodes = nodes
    state.handledEdges = edges

    // No cleanup return — disposal of `state.handle` happens in the
    // setup effect's cleanup (on unmount or simulation-kind change)
    // and in the next patch (which calls `state.handle.cleanup()`
    // above).
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- workerFailed/runWorker/runMainThread are consumed via closure but intentionally NOT listed: when they flip, the setup effect re-fires and rebuilds everything, so the patch effect must not also fire on those changes.
  }, [nodes, edges, svgRef])

  return { zoomIn, zoomOut, zoomReset }
}
