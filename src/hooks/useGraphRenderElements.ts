/**
 * useGraphRenderElements — memoized renderer that materializes d3 node /
 * edge selections into the graph SVG. Extracted from `useGraphSimulation`
 *.
 *
 * The hook returns a stable callback so the orchestrator's effect can
 * call `render(svg)` inside the same effect that sets up zoom and the
 * force simulation, without re-creating the closure on every render.
 */

import { useCallback } from 'react'

import {
  type NodeActions,
  type NodeMarks,
  type RenderResult,
  renderGraphElements,
} from '@/lib/graph-sim-helpers'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'

export interface UseGraphRenderElementsArgs {
  nodes: GraphNode[]
  edges: GraphEdge[]
  actions: NodeActions
  marks: NodeMarks
}

export type RenderGraphFn = (svg: SVGSVGElement) => RenderResult

export function useGraphRenderElements({
  nodes,
  edges,
  actions,
  marks,
}: UseGraphRenderElementsArgs): RenderGraphFn {
  return useCallback(
    (svg: SVGSVGElement) => renderGraphElements(svg, nodes, edges, actions, marks),
    [nodes, edges, actions, marks],
  )
}
