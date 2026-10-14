/**
 * useGraphZoom — owns the d3 zoom behavior + keyboard zoom shortcut for
 * The graph canvas. Extracted from `useGraphSimulation`.
 *
 * Returns the imperative zoom callbacks (used by GraphView's zoom
 * buttons) plus an `attach` function the orchestrator calls inside its
 * effect to wire the zoom behavior to a freshly-rendered `g` selection.
 */

import type { SimulationNodeDatum } from 'd3-force'
import { select } from 'd3-selection'
import { type ZoomBehavior, type ZoomTransform, zoomTransform } from 'd3-zoom'
import type React from 'react'
import { useCallback, useRef } from 'react'

import {
  createZoomKeyHandler,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  fitTransform,
  type GSel,
  reducedMotionDuration,
  revealTransform,
  setupZoomBehavior,
  ZOOM_BUTTON_DURATION_MS,
  ZOOM_FIT_DURATION_MS,
  ZOOM_STEP,
} from '@/lib/graph-sim-helpers'

export interface UseGraphZoomResult {
  /**
   * Wire the zoom behavior + keyboard shortcut to the rendered SVG/`g`
   * selection, starting from `initial` when the view comes back (#5434).
   * The fit shortcut calls `fitShortcut`, and every zoom that ends calls
   * `onZoomEnd`. Call inside the orchestrator's effect after render and
   * invoke the returned cleanup on effect teardown.
   */
  attach: (
    svg: SVGSVGElement,
    g: GSel,
    fitShortcut: () => void,
    onZoomEnd: () => void,
    initial?: ZoomTransform,
  ) => () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Zoom and pan so every node in `nodes` is in view. */
  fitToView: (nodes: readonly SimulationNodeDatum[]) => void
  /** Pan, at the current scale, to centre `node` when it is off screen. */
  reveal: (node: SimulationNodeDatum) => void
}

export function useGraphZoom(svgRef: React.RefObject<SVGSVGElement | null>): UseGraphZoomResult {
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)

  const attach = useCallback<UseGraphZoomResult['attach']>(
    (svg, g, fitShortcut, onZoomEnd, initial) => {
      const zoomBehavior = setupZoomBehavior(svg, g, onZoomEnd)
      if (initial) zoomBehavior.transform(select(svg), initial)
      zoomBehaviorRef.current = zoomBehavior
      const handleZoomKey = createZoomKeyHandler(svg, zoomBehavior, fitShortcut)
      svg.addEventListener('keydown', handleZoomKey)
      return () => {
        svg.removeEventListener('keydown', handleZoomKey)
      }
    },
    [],
  )

  const zoomIn = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(
      svgSel.transition().duration(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)),
      ZOOM_STEP,
    )
  }, [svgRef])

  const zoomOut = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(
      svgSel.transition().duration(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)),
      1 / ZOOM_STEP,
    )
  }, [svgRef])

  const fitToView = useCallback<UseGraphZoomResult['fitToView']>(
    (nodes) => {
      const svg = svgRef.current
      if (!svg) return
      zoomBehaviorRef.current?.transform(
        select(svg).transition().duration(reducedMotionDuration(ZOOM_FIT_DURATION_MS)),
        fitTransform(nodes, svg.clientWidth || DEFAULT_WIDTH, svg.clientHeight || DEFAULT_HEIGHT),
      )
    },
    [svgRef],
  )

  const reveal = useCallback<UseGraphZoomResult['reveal']>(
    (node) => {
      const svg = svgRef.current
      if (!svg) return
      const target = revealTransform(
        zoomTransform(svg),
        node,
        svg.clientWidth || DEFAULT_WIDTH,
        svg.clientHeight || DEFAULT_HEIGHT,
      )
      if (target === null) return
      zoomBehaviorRef.current?.transform(
        select(svg).transition().duration(reducedMotionDuration(ZOOM_BUTTON_DURATION_MS)),
        target,
      )
    },
    [svgRef],
  )

  return { attach, zoomIn, zoomOut, fitToView, reveal }
}
