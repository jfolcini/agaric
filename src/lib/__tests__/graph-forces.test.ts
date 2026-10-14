/**
 * The layout forces both simulation paths share (#5432): charge and collision
 * weigh each node by its degree. Real d3-force, read back through its accessors.
 */

import { type ForceCollide, type ForceManyBody, forceSimulation } from 'd3-force'
import { describe, expect, it } from 'vitest'

import { applyGraphForces, type ForceNode, nodeRadius } from '@/lib/graph-forces'

function forcesFor(nodes: ForceNode[]): {
  charge: ForceManyBody<ForceNode>
  collide: ForceCollide<ForceNode>
} {
  const sim = applyGraphForces(forceSimulation<ForceNode>(nodes).stop(), {
    edges: [],
    width: 800,
    height: 600,
  })
  return {
    charge: sim.force('charge') as ForceManyBody<ForceNode>,
    collide: sim.force('collide') as ForceCollide<ForceNode>,
  }
}

describe('applyGraphForces — degree-aware layout (#5432)', () => {
  const orphan: ForceNode = { id: 'orphan', degree: 0 }
  const leaf: ForceNode = { id: 'leaf', degree: 1 }
  const hub: ForceNode = { id: 'hub', degree: 16 }
  const nodes = [orphan, leaf, hub]

  it('a node repels harder the more links it has', () => {
    const { charge } = forcesFor(nodes)
    const strength = (n: ForceNode): number => charge.strength()(n, nodes.indexOf(n), nodes)

    expect(strength(orphan)).toBeLessThan(0)
    expect(strength(leaf)).toBeLessThan(strength(orphan))
    expect(strength(hub)).toBeLessThan(strength(leaf))
    // The extra pull grows with √degree: 16 links push 4× what one link adds.
    expect(strength(hub) - strength(orphan)).toBeCloseTo(4 * (strength(leaf) - strength(orphan)))
  })

  it('repulsion has a reach, so distant clusters stop pushing each other apart', () => {
    expect(forcesFor(nodes).charge.distanceMax()).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('collision keeps the same clearance around every disc, whatever its size', () => {
    const { collide } = forcesFor(nodes)
    const clearance = (n: ForceNode): number =>
      collide.radius()(n, nodes.indexOf(n), nodes) - nodeRadius(n.degree ?? 0)

    expect(clearance(orphan)).toBeGreaterThan(0)
    expect(clearance(leaf)).toBe(clearance(orphan))
    expect(clearance(hub)).toBe(clearance(orphan))
  })
})
