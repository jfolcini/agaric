/**
 * useGraphRenderElements — memoized renderer that materializes d3 node /
 * edge selections into the graph SVG. Extracted from `useGraphSimulation`
 * per MAINT-127.
 *
 * The hook returns a stable callback so the orchestrator's effect can
 * call `render(svg)` inside the same effect that sets up zoom and the
 * force simulation, without re-creating the closure on every render.
 */

import { useCallback } from 'react'
import type { GraphEdge, GraphNode } from '@/components/GraphView.helpers'
import { type RenderResult, renderGraphElements } from '@/lib/graph-sim-helpers'

export interface UseGraphRenderElementsArgs {
  nodes: GraphNode[]
  edges: GraphEdge[]
  navigateToPage: (id: string, label: string) => void
}

export type RenderGraphFn = (svg: SVGSVGElement) => RenderResult

export function useGraphRenderElements({
  nodes,
  edges,
  navigateToPage,
}: UseGraphRenderElementsArgs): RenderGraphFn {
  return useCallback(
    (svg: SVGSVGElement) => renderGraphElements(svg, nodes, edges, navigateToPage),
    [nodes, edges, navigateToPage],
  )
}
