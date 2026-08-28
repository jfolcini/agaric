/**
 * Shared graph-view data types (#761).
 *
 * `GraphNode`/`GraphEdge` were previously declared in
 * `@/components/graph/GraphView.helpers.ts`, which forced `lib/graph-sim-helpers.ts` to
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
  /**
   * Inbound-link count for this node, computed from the (possibly
   * server-capped) edge list. `undefined` — rather than `0` — when the
   * fetch's edge list was truncated (#3314 finding 3): above the cap the
   * backend drops the WEAKEST edges first, so a page with exactly one
   * inbound link can be cut entirely and would otherwise be miscounted
   * as zero. `undefined` here makes `nodeMatchesFilter`'s `hasBacklinks`
   * case (`@/lib/graph-filters`) treat the dimension as unavailable
   * (pass-through) instead of silently lying about orphan/non-orphan
   * status.
   */
  backlink_count: number | undefined
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
  ref_count: number
}

export interface GraphFetchResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /**
   * TRUE count of page-link edges matching the fetch filters, computed
   * independently of the backend edge cap (#2298 count-then-cap).
   * `edges.length` can be smaller both because the cap fired and because
   * edges touching unknown nodes are dropped client-side.
   */
  edgesTotal: number
  /**
   * True when the backend `PAGE_LINKS_EDGE_CAP` fired and the fetched
   * edge set is partial — the UI surfaces a non-blocking
   * "showing N of M links" notice (#2298).
   */
  edgesTruncated: boolean
}
