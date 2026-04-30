/**
 * useGraphZoom — owns the d3 zoom behavior + keyboard zoom shortcut for
 * the graph canvas. Extracted from `useGraphSimulation` per MAINT-127.
 *
 * Returns three imperative zoom callbacks (used by GraphView's zoom
 * buttons) plus an `attach` function the orchestrator calls inside its
 * effect to wire the zoom behavior to a freshly-rendered `g` selection.
 */

import { select } from 'd3-selection'
import { type ZoomBehavior, zoomIdentity } from 'd3-zoom'
import type React from 'react'
import { useCallback, useRef } from 'react'
import {
  createZoomKeyHandler,
  type GSel,
  setupZoomBehavior,
  ZOOM_BUTTON_DURATION_MS,
  ZOOM_RESET_DURATION_MS,
  ZOOM_STEP,
} from '@/lib/graph-sim-helpers'

export interface UseGraphZoomResult {
  /**
   * Wire the zoom behavior + keyboard shortcut to the rendered SVG/`g`
   * selection. Call inside the orchestrator's effect after render and
   * invoke the returned cleanup on effect teardown.
   */
  attach: (svg: SVGSVGElement, g: GSel) => () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

export function useGraphZoom(svgRef: React.RefObject<SVGSVGElement | null>): UseGraphZoomResult {
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)

  const attach = useCallback((svg: SVGSVGElement, g: GSel) => {
    const zoomBehavior = setupZoomBehavior(svg, g)
    zoomBehaviorRef.current = zoomBehavior
    const handleZoomKey = createZoomKeyHandler(svg, zoomBehavior)
    svg.addEventListener('keydown', handleZoomKey)
    return () => {
      svg.removeEventListener('keydown', handleZoomKey)
    }
  }, [])

  const zoomIn = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(
      svgSel.transition().duration(ZOOM_BUTTON_DURATION_MS),
      ZOOM_STEP,
    )
  }, [svgRef])

  const zoomOut = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(
      svgSel.transition().duration(ZOOM_BUTTON_DURATION_MS),
      1 / ZOOM_STEP,
    )
  }, [svgRef])

  const zoomReset = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.transform(
      svgSel.transition().duration(ZOOM_RESET_DURATION_MS),
      zoomIdentity,
    )
  }, [svgRef])

  return { attach, zoomIn, zoomOut, zoomReset }
}
