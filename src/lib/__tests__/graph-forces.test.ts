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

describe('applyGraphForces — the layout takes the canvas shape (#7040)', () => {
  /** Width and height of the settled layout of six star clusters and some unlinked pages. */
  function layoutSpan(width: number, height: number): { x: number; y: number } {
    const nodes: ForceNode[] = []
    const edges: Array<{ source: string; target: string }> = []
    for (let hub = 0; hub < 6; hub++) {
      nodes.push({ id: `hub${hub}`, degree: 6 })
      for (let leaf = 0; leaf < 6; leaf++) {
        nodes.push({ id: `leaf${hub}.${leaf}`, degree: 1 })
        edges.push({ source: `hub${hub}`, target: `leaf${hub}.${leaf}` })
      }
    }
    for (let i = 0; i < 10; i++) nodes.push({ id: `loose${i}`, degree: 0 })
    // d3's phyllotaxis start, centred: the same for every canvas, so only the forces differ.
    nodes.forEach((n, i) => {
      const r = 10 * Math.sqrt(0.5 + i)
      const a = i * Math.PI * (3 - Math.sqrt(5))
      n.x = width / 2 + r * Math.cos(a)
      n.y = height / 2 + r * Math.sin(a)
    })
    const sim = applyGraphForces(forceSimulation<ForceNode>(nodes).stop(), {
      edges,
      width,
      height,
    })
    sim.tick(300)
    const xs = nodes.map((n) => n.x ?? 0)
    const ys = nodes.map((n) => n.y ?? 0)
    return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) }
  }
  const layoutAspect = (width: number, height: number): number => {
    const span = layoutSpan(width, height)
    return span.x / span.y
  }

  it('lays a tall canvas out taller than wide, and a wide one wider than tall', () => {
    expect(layoutAspect(400, 800)).toBeLessThan(0.8)
    expect(layoutAspect(800, 400)).toBeGreaterThan(1.25)
  })

  it('keeps the layout on a long thin strip of canvas instead of flinging it away', () => {
    const span = layoutSpan(3000, 100)
    expect(span.x).toBeLessThan(1000)
    expect(span.y).toBeLessThan(1000)
  })
})
