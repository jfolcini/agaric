/**
 * Tests for the local-graph neighborhood computation (#1429).
 */

import { describe, expect, it } from 'vitest'

import {
  computeLocalGraph,
  computeNeighborhoodIds,
  DEFAULT_LOCAL_GRAPH_HOPS,
  LOCAL_GRAPH_HOP_OPTIONS,
} from '@/lib/graph-neighborhood'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'

function node(id: string): GraphNode {
  return {
    id,
    label: id,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    is_template: false,
    backlink_count: 0,
  }
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, ref_count: 1 }
}

// Graph used for most cases:
//   A — B — C — D        (a chain)
//   A — E                (A also links E)
//   F                    (isolated node, no edges)
const NODES = ['A', 'B', 'C', 'D', 'E', 'F'].map(node)
const EDGES = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('A', 'E')]

describe('computeNeighborhoodIds', () => {
  it('returns only the seed at 0 hops', () => {
    const ids = computeNeighborhoodIds(NODES, EDGES, 'A', 0)
    expect([...ids].sort()).toEqual(['A'])
  })

  it('returns seed + direct neighbors at 1 hop (both links and backlinks)', () => {
    // From B: A (backlink-ish — A→B) and C (B→C). Undirected traversal.
    const ids = computeNeighborhoodIds(NODES, EDGES, 'B', 1)
    expect([...ids].sort()).toEqual(['A', 'B', 'C'])
  })

  it('includes the seeds own outgoing links and backlinks at 1 hop', () => {
    // A links B and E; nothing links to A → 1-hop = {A, B, E}.
    const ids = computeNeighborhoodIds(NODES, EDGES, 'A', 1)
    expect([...ids].sort()).toEqual(['A', 'B', 'E'])
  })

  it('expands to 2-hop neighbors', () => {
    // A(0) → B,E(1) → C(2). D is 3 hops away, excluded.
    const ids = computeNeighborhoodIds(NODES, EDGES, 'A', 2)
    expect([...ids].sort()).toEqual(['A', 'B', 'C', 'E'])
  })

  it('reaches farther nodes only with more hops', () => {
    expect(computeNeighborhoodIds(NODES, EDGES, 'A', 2).has('D')).toBe(false)
    expect(computeNeighborhoodIds(NODES, EDGES, 'A', 3).has('D')).toBe(true)
  })

  it('returns just the seed for an isolated page (no links)', () => {
    const ids = computeNeighborhoodIds(NODES, EDGES, 'F', 2)
    expect([...ids]).toEqual(['F'])
  })

  it('returns an empty set when the seed is not a known node', () => {
    const ids = computeNeighborhoodIds(NODES, EDGES, 'ZZZ', 2)
    expect(ids.size).toBe(0)
  })

  it('does not traverse through edges whose endpoint is missing from nodes', () => {
    // Edge B→GHOST where GHOST is not a node: BFS must not include it.
    const ids = computeNeighborhoodIds(NODES, [...EDGES, edge('B', 'GHOST')], 'B', 1)
    expect(ids.has('GHOST')).toBe(false)
  })

  it('handles cycles without infinite loops', () => {
    const cyclic = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')]
    const ids = computeNeighborhoodIds(['A', 'B', 'C'].map(node), cyclic, 'A', 5)
    expect([...ids].sort()).toEqual(['A', 'B', 'C'])
  })

  it('treats edges as undirected (hydrated GraphNode endpoints resolved)', () => {
    const hydrated: GraphEdge[] = [{ source: node('A'), target: node('B'), ref_count: 1 }]
    const ids = computeNeighborhoodIds(['A', 'B'].map(node), hydrated, 'B', 1)
    expect([...ids].sort()).toEqual(['A', 'B'])
  })
})

describe('computeLocalGraph', () => {
  it('returns the seed node alone (no edges) for an isolated page', () => {
    const local = computeLocalGraph(NODES, EDGES, 'F', DEFAULT_LOCAL_GRAPH_HOPS)
    expect(local.nodes.map((n) => n.id)).toEqual(['F'])
    expect(local.edges).toEqual([])
  })

  it('returns the 1-hop subgraph with only internal edges', () => {
    const local = computeLocalGraph(NODES, EDGES, 'A', 1)
    expect(local.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'E'])
    // Edges within {A,B,E}: A-B and A-E. B-C is dropped (C excluded).
    const edgeKeys = local.edges.map((e) => `${e.source as string}-${e.target as string}`).sort()
    expect(edgeKeys).toEqual(['A-B', 'A-E'])
  })

  it('returns an empty graph when the seed is absent', () => {
    const local = computeLocalGraph(NODES, EDGES, 'nope', 2)
    expect(local.nodes).toEqual([])
    expect(local.edges).toEqual([])
  })

  it('exposes a sensible default depth and hop options', () => {
    expect(DEFAULT_LOCAL_GRAPH_HOPS).toBe(2)
    expect(LOCAL_GRAPH_HOP_OPTIONS).toEqual([1, 2])
  })
})
