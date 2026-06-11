/**
 * Shared graph-view data types (#761).
 *
 * `GraphNode`/`GraphEdge` were previously declared in
 * `@/components/GraphView.helpers`, which forced `lib/graph-sim-helpers.ts` to
 * type-import from `components/` — a lib→components layering inversion. Hoisting
 * the types into this leaf (a sibling of `graph-sim-helpers`) lets the lib and
 * hook layers depend only on `lib/`, while `GraphView.helpers` re-exports them
 * for its existing consumers.
 */

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

export interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
  todo_state: string | null
  priority: string | null
  due_date: string | null
  scheduled_date: string | null
  is_template: boolean
  backlink_count: number
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
  ref_count: number
}

export interface GraphFetchResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
