/**
 * Local-graph neighborhood computation (#1429).
 *
 * Given the full link graph (the same `{ nodes, edges }` the global
 * `GraphView` already fetches client-side) and a seed page id, returns the
 * subgraph containing the seed plus every node reachable within `hops`
 * undirected steps over the existing link/backlink edges.
 *
 * The traversal is **undirected**: an edge `A → B` connects A and B in both
 * directions so the neighborhood includes both outgoing links (`[[B]]` on the
 * seed) and backlinks (pages that link *to* the seed). This matches the
 * "focus on this page" mental model — you want everything related to the
 * page, not just what it points at.
 *
 * Pure and renderer-agnostic so it can be unit-tested in isolation and reused
 * by `GraphView` to drive the existing `useGraphSimulation` with a filtered
 * node/edge set (no backend query — the full graph is already in memory).
 */

import type { GraphEdge, GraphNode } from '@/lib/graph-types'

/** Default neighborhood radius. 2 hops captures direct links/backlinks plus
 * their immediate neighbors — the Logseq-equivalent local-graph default. */
export const DEFAULT_LOCAL_GRAPH_HOPS = 2

/** Allowed hop-depth choices surfaced by the depth control. */
export const LOCAL_GRAPH_HOP_OPTIONS = [1, 2] as const

export type LocalGraphHops = (typeof LOCAL_GRAPH_HOP_OPTIONS)[number]

/** Resolve an edge endpoint (string id or hydrated `GraphNode`) to its id. */
function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id
}

/**
 * Build an undirected adjacency map keyed by node id. Edges whose endpoints
 * are identical (self-links) contribute a node to the map but no neighbor,
 * which is harmless for the BFS.
 */
function buildAdjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const set = adjacency.get(a) ?? new Set<string>()
    if (a !== b) set.add(b)
    adjacency.set(a, set)
  }
  for (const edge of edges) {
    const source = endpointId(edge.source)
    const target = endpointId(edge.target)
    link(source, target)
    link(target, source)
  }
  return adjacency
}

/**
 * Compute the set of node ids within `hops` undirected steps of `seedId`
 * (inclusive of the seed). Returns just the seed id if it has no edges, and
 * an empty set if the seed is not present in `nodes` at all.
 */
export function computeNeighborhoodIds(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  seedId: string,
  hops: number,
): Set<string> {
  const present = new Set(nodes.map((n) => n.id))
  if (!present.has(seedId)) return new Set<string>()

  const visited = new Set<string>([seedId])
  if (hops <= 0) return visited

  const adjacency = buildAdjacency(edges)
  // Standard BFS by depth. `frontier` holds the nodes discovered at the
  // current depth; each round expands to the next ring until `hops` is hit.
  let frontier: string[] = [seedId]
  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const nodeId of frontier) {
      const neighbors = adjacency.get(nodeId)
      if (!neighbors) continue
      for (const neighbor of neighbors) {
        // Only traverse to nodes that actually exist in the visible node set
        // (edges can dangle if a target was filtered out upstream).
        if (!present.has(neighbor) || visited.has(neighbor)) continue
        visited.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return visited
}

export interface LocalGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Filter the full graph down to the `hops`-neighborhood of `seedId`,
 * reusing the same node/edge shapes the renderer already consumes.
 *
 * Edge cases:
 *  - Seed with no links → `{ nodes: [seed], edges: [] }` (graceful empty
 *    neighborhood: the seed node still renders).
 *  - Seed absent from `nodes` (e.g. a non-page tab, or stale id) →
 *    `{ nodes: [], edges: [] }`, which the caller surfaces as an empty state.
 */
export function computeLocalGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  seedId: string,
  hops: number,
): LocalGraph {
  const ids = computeNeighborhoodIds(nodes, edges, seedId, hops)
  const filteredNodes = nodes.filter((n) => ids.has(n.id))
  const filteredEdges = edges.filter(
    (e) => ids.has(endpointId(e.source)) && ids.has(endpointId(e.target)),
  )
  return { nodes: filteredNodes, edges: filteredEdges }
}
