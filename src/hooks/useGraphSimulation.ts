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
 * This hook composes those pieces inside a single `useEffect` so the
 * lifecycle (render → zoom → simulation → resize observer → cleanup)
 * stays in one place. Public API is unchanged from before the split.
 */

import type React from 'react'
import { useEffect } from 'react'
import type { GraphEdge, GraphNode } from '@/components/GraphView.helpers'
import { useGraphMainThreadSim } from '@/hooks/useGraphMainThreadSim'
import { useGraphRenderElements } from '@/hooks/useGraphRenderElements'
import { useGraphWorkerSimulation } from '@/hooks/useGraphWorkerSimulation'
import { useGraphZoom } from '@/hooks/useGraphZoom'
import {
  createApplyPositions,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  type SimulationCtx,
} from '@/lib/graph-sim-helpers'

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

  useEffect(() => {
    if (nodes.length === 0 || !svgRef.current) return
    const svg = svgRef.current

    const rendered = renderElements(svg)
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
    // Guarded for jsdom and older runtimes where `ResizeObserver` may
    // not exist. The observer also fires once at `observe()` time with
    // the current dimensions — the `onResize` handlers short-circuit
    // when the dimensions haven't changed so that fire is a no-op.
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const width = svg.clientWidth || DEFAULT_WIDTH
        const height = svg.clientHeight || DEFAULT_HEIGHT
        handle.onResize(width, height)
      })
      resizeObserver.observe(svg)
    }

    return () => {
      resizeObserver?.disconnect()
      handle.cleanup()
      detachZoom()
    }
    // `edges` is intentionally omitted: when nodes/edges change, the
    // `renderElements` callback changes too, which already triggers the
    // effect re-run via its own dep.
  }, [svgRef, nodes, workerFailed, attachZoom, renderElements, runWorker, runMainThread])

  return { zoomIn, zoomOut, zoomReset }
}
