/**
 * useGraphSimulation — orchestrator for GraphView's d3-force simulation
 * (+). Decomposed into:
 *
 *   - `useGraphZoom` — zoom behavior + keyboard zoom + zoomIn/Out + fit to view.
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

import { zoomTransform } from 'd3-zoom'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGraphMainThreadSim } from '@/hooks/useGraphMainThreadSim'
import { useGraphRenderElements } from '@/hooks/useGraphRenderElements'
import { useGraphWorkerSimulation } from '@/hooks/useGraphWorkerSimulation'
import { useGraphZoom } from '@/hooks/useGraphZoom'
import {
  createApplyPositions,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  type GraphLayout,
  keptPositions,
  markNodes,
  type NodeActions,
  type NodeMarks,
  patchGraphSelections,
  type RenderResult,
  seedPositions,
  seedUnplaced,
  type SimulationCtx,
  type SimulationHandle,
} from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'
import { shouldReduceMotion } from '@/lib/preferences'

export interface UseGraphSimulationArgs {
  svgRef: React.RefObject<SVGSVGElement | null>
  nodes: GraphNode[]
  edges: GraphEdge[]
  actions: GraphPageActions
  /** The page open in the active tab; its node takes the accent unless another is selected. */
  currentPageId: string | null
  selectedPageId: string | null
  /** Where the graph's layout is kept while it is unmounted (#5434). */
  layout: GraphLayoutStore
}

/** What selecting or opening a node does to the page it stands for. */
export type GraphPageActions = Omit<NodeActions, 'reveal'>

export interface GraphLayoutStore {
  read: () => GraphLayout | null
  keep: (layout: GraphLayout) => void
}

export interface UseGraphSimulationResult {
  zoomIn: () => void
  zoomOut: () => void
  fitToView: () => void
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
  /**
   * Whether `handle` is a LIVE simulation (worker/main-thread) vs a torn-down
   * no-op placeholder. The empty-filter branch cleans the sim up and installs
   * a no-op handle; a later non-empty filter must then RESPAWN (cold start)
   * rather than post an `update` to a dead handle (#2194). While a live sim is
   * present, filter toggles post an in-place `update` instead of respawning.
   */
  simActive: boolean
}

export function useGraphSimulation({
  svgRef,
  nodes,
  edges,
  actions,
  currentPageId,
  selectedPageId,
  layout,
}: UseGraphSimulationArgs): UseGraphSimulationResult {
  const {
    attach: attachZoom,
    zoomIn,
    zoomOut,
    fitToView: fitNodesToView,
    reveal,
  } = useGraphZoom(svgRef)
  const nodeActions = useMemo<NodeActions>(() => ({ ...actions, reveal }), [actions, reveal])
  const marks = useMemo<NodeMarks>(
    () => ({ currentPageId, selectedId: selectedPageId }),
    [currentPageId, selectedPageId],
  )
  const renderElements = useGraphRenderElements({ nodes, edges, actions: nodeActions, marks })
  const { workerFailed, runWorker } = useGraphWorkerSimulation()
  const runMainThread = useGraphMainThreadSim()

  // ── Persistent state across effect runs ──────────────────────────
  const stateRef = useRef<PersistentSimState | null>(null)

  const fitToView = useCallback(() => {
    fitNodesToView(stateRef.current?.rendered.simNodes ?? [])
  }, [fitNodesToView])

  // Labels are chosen again where the layout or the zoom comes to rest, never
  // per tick or per zoom frame (#5430).
  const placeLabels = useCallback(() => {
    stateRef.current?.rendered.highlight.placeLabels()
  }, [])

  // A first layout is fitted once it settles; a kept one comes back with the
  // viewport it was left with, which the fit must not override (#5434). The
  // fit's zoom end chooses the labels, so none flash in at the pre-fit zoom.
  const fitOnSettleRef = useRef(false)
  const onSettled = useCallback(
    (settledNodes: readonly GraphNode[]) => {
      if (!fitOnSettleRef.current) {
        placeLabels()
        return
      }
      fitOnSettleRef.current = false
      fitNodesToView(settledNodes)
    },
    [fitNodesToView, placeLabels],
  )

  // `setupKey` is bumped by the patch effect when it detects that
  // setup has not yet run (initial empty-nodes render followed by
  // nodes arriving). Listing it in the setup effect's deps lets that
  // effect re-fire with the now-non-empty nodes (read via ref). This
  // is the React-idiomatic way to chain "do setup once data is
  // ready" without putting `nodes` itself in the setup deps (which
  // would re-fire on every filter toggle).
  const [setupKey, setSetupKey] = useState(0)

  // Refs for the latest data + node actions + renderElements so the
  // setup effect can build the simulation context without listing
  // them in its deps. Filter-induced identity flips of `nodes`/
  // `edges`/`actions` propagate into `renderElements`'s
  // useCallback identity — listing `renderElements` in the setup
  // effect's deps would re-fire setup on every filter toggle (which
  // is precisely what PERF-Tier2 item 8 is fixing).
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const nodeActionsRef = useRef(nodeActions)
  const marksRef = useRef(marks)
  const renderElementsRef = useRef(renderElements)
  const layoutRef = useRef(layout)
  nodesRef.current = nodes
  edgesRef.current = edges
  nodeActionsRef.current = nodeActions
  marksRef.current = marks
  renderElementsRef.current = renderElements
  layoutRef.current = layout

  // ── Setup effect ─────────────────────────────────────────────────
  // Runs only when the simulation *kind* changes (mount, worker
  // failure flip, or a zoom/runner callback identity change). Reads
  // the latest data + renderElements via refs so filter toggles do
  // not re-fire this effect. (nodes/edges/actions/renderElements
  // are intentionally consumed via refs; the exhaustive-deps directive
  // lives on the deps array below where oxlint anchors the diagnostic.)
  useEffect(() => {
    if (nodesRef.current.length === 0 || !svgRef.current) return
    const svg = svgRef.current

    const rendered = renderElementsRef.current(svg)
    const applyPositions = createApplyPositions(rendered.link, rendered.node)
    const layoutStore = layoutRef.current
    const kept = layoutStore.read()
    let keptSettled = false
    if (kept) {
      keptSettled = seedPositions(rendered, kept.positions) && kept.settled
      applyPositions()
    }
    const detachZoom = attachZoom(svg, rendered.g, fitToView, placeLabels, kept?.transform)
    // A re-setup after a worker failure reads back the layout it kept; a fit still owed stays owed.
    if (kept === null) fitOnSettleRef.current = true

    const prefersReducedMotion = shouldReduceMotion()

    const ctx: SimulationCtx = {
      simNodes: rendered.simNodes,
      simEdges: rendered.simEdges,
      nodeById: rendered.nodeById,
      node: rendered.node,
      applyPositions,
      width: rendered.width,
      height: rendered.height,
      prefersReducedMotion,
      keptSettled,
      onSettled,
    }

    const useWorker = typeof Worker !== 'undefined' && !workerFailed
    const handle = useWorker ? runWorker(ctx) : runMainThread(ctx)

    // ── ResizeObserver: re-anchor centering forces on SVG resize ──
    //
    // Before this, the simulation read `svg.clientWidth /
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
        // Leaving the view hides the canvas first; re-centring on its zero
        // size would move the layout the graph is about to keep (#5434).
        if (svg.clientWidth === 0 || svg.clientHeight === 0) return
        stateRef.current?.handle.onResize(svg.clientWidth, svg.clientHeight)
      })
      resizeObserver.observe(svg)
    }

    stateRef.current = {
      rendered,
      handle,
      prefersReducedMotion,
      handledNodes: nodesRef.current,
      handledEdges: edgesRef.current,
      simActive: true,
    }
    rendered.highlight.placeLabels()

    return () => {
      resizeObserver?.disconnect()
      const current = stateRef.current
      if (current) {
        layoutStore.keep({
          positions: keptPositions(current.rendered.simNodes),
          transform: zoomTransform(svg),
          settled: current.handle.settled(),
        })
        current.handle.cleanup()
      }
      detachZoom()
      stateRef.current = null
    }
  }, [
    svgRef,
    workerFailed,
    attachZoom,
    runWorker,
    runMainThread,
    setupKey,
    fitToView,
    placeLabels,
    onSettled,
  ])

  // ── Patch effect ─────────────────────────────────────────────────
  // Runs on filter changes (any `nodes`/`edges` identity flip without
  // a simulation-kind change). Patches the persistent `g` selection
  // via d3's data-join keyed by node id, then swaps the LIVE
  // simulation's node/edge set in place via `handle.onUpdate` (#2194)
  // instead of tearing it down and respawning. The same `g` element
  // survives so zoom + ResizeObserver stay attached and the SVG does
  // not repaint from scratch — only the diffed nodes/edges enter/exit,
  // and the running layout drifts to the new topology.
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
        patchGraphSelections(state.rendered.g, [], [], nodeActionsRef.current)
        state.handle.cleanup()
        state.handle = {
          cleanup: () => {},
          onResize: () => {},
          onUpdate: () => {},
          settled: () => false,
        }
        state.simActive = false
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

    const width = svg.clientWidth || DEFAULT_WIDTH
    const height = svg.clientHeight || DEFAULT_HEIGHT

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
    seedUnplaced(simNodes, width, height)
    const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }))
    const nodeById = new Map<string, GraphNode>()
    for (const n of simNodes) {
      nodeById.set(n.id, n)
    }

    // Patch SVG selections in place via .data(...).join(...).
    const { link, node, highlight } = patchGraphSelections(
      state.rendered.g,
      simNodes,
      simEdges,
      nodeActionsRef.current,
      marksRef.current,
    )

    const applyPositions = createApplyPositions(link, node)

    const ctx: SimulationCtx = {
      simNodes,
      simEdges,
      nodeById,
      node,
      applyPositions,
      width,
      height,
      prefersReducedMotion: state.prefersReducedMotion,
      keptSettled: false,
      onSettled,
    }

    // #2194: if a simulation is already LIVE, swap its node/edge set in place
    // via `onUpdate` — the worker keeps running and its layout DRIFTS to the
    // new topology (carried x/y/vx/vy preserve persisting nodes) instead of
    // being terminated and respawned (which stripped positions to {id,label}
    // and re-scattered + re-converged ~300 ticks on every filter click). The
    // handle stays the same; only the ctx it points at is refreshed. The
    // genuine cold-start path (setup ran with empty nodes, or the empty-filter
    // branch tore the sim down) still respawns via runWorker/runMainThread.
    if (state.simActive) {
      state.handle.onUpdate(ctx)
    } else {
      const useWorker = typeof Worker !== 'undefined' && !workerFailed
      state.handle = useWorker ? runWorker(ctx) : runMainThread(ctx)
      state.simActive = true
    }

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
      highlight,
      width,
      height,
    }
    state.handledNodes = nodes
    state.handledEdges = edges
    highlight.placeLabels()

    // No cleanup return — disposal of `state.handle` happens in the
    // setup effect's cleanup (on unmount or simulation-kind change).
    // Filter toggles now post an in-place `update` (#2194) rather than
    // tearing the handle down, so the live worker/sim persists across
    // toggles; only a cold-start branch spawns a fresh handle.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- workerFailed/runWorker/runMainThread are consumed via closure but intentionally NOT listed: when they flip, the setup effect re-fires and rebuilds everything, so the patch effect must not also fire on those changes.
  }, [nodes, edges, svgRef])

  // A new active-tab page or selection moves the accent without a patch, which
  // would reheat the layout.
  useEffect(() => {
    const state = stateRef.current
    if (!state) return
    markNodes(state.rendered.node, marks)
    state.rendered.highlight.mark(marks)
  }, [marks])

  return { zoomIn, zoomOut, fitToView }
}
