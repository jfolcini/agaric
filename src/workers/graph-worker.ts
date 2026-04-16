/**
 * WebWorker — d3-force simulation off the main thread (PERF-9b).
 *
 * Receives graph data from the main thread, runs the force simulation,
 * and posts back node positions on every tick and when the simulation
 * converges.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

import type { NodePosition, WorkerInboundMessage } from './graph-worker-types'

// ── Internal node / edge types (d3-mutated) ──────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string
  label: string
}

interface SimEdge extends SimulationLinkDatum<SimNode> {
  source: string | SimNode
  target: string | SimNode
  ref_count: number
}

// ── State ────────────────────────────────────────────────────────────

let simulation: Simulation<SimNode, SimEdge> | null = null
let simNodes: SimNode[] = []

// ── Helpers ──────────────────────────────────────────────────────────

function collectPositions(): NodePosition[] {
  return simNodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
  }))
}

// ── Message handler ──────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data

  switch (msg.type) {
    case 'start': {
      // Tear down any previous simulation
      if (simulation) {
        simulation.stop()
        simulation = null
      }

      const { nodes, edges, width, height } = msg

      simNodes = nodes.map((n) => ({ ...n }))
      const simEdges: SimEdge[] = edges.map((e) => ({ ...e }))

      simulation = forceSimulation<SimNode, SimEdge>(simNodes)
        .force(
          'link',
          forceLink<SimNode, SimEdge>(simEdges)
            .id((d) => d.id)
            .distance(60),
        )
        .force('charge', forceManyBody().strength(-100))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collide', forceCollide(20))
        .force('x', forceX(width / 2).strength(0.05))
        .force('y', forceY(height / 2).strength(0.05))

      simulation.on('tick', () => {
        self.postMessage({ type: 'tick', positions: collectPositions() })
      })

      simulation.on('end', () => {
        self.postMessage({ type: 'done', positions: collectPositions() })
      })

      break
    }

    case 'stop': {
      if (simulation) {
        simulation.stop()
        simulation = null
      }
      break
    }

    case 'drag': {
      if (!simulation) break

      const node = simNodes.find((n) => n.id === msg.nodeId)
      if (!node) break

      switch (msg.phase) {
        case 'start':
          simulation.alphaTarget(0.3).restart()
          node.fx = msg.x
          node.fy = msg.y
          break
        case 'drag':
          node.fx = msg.x
          node.fy = msg.y
          break
        case 'end':
          simulation.alphaTarget(0)
          node.fx = null
          node.fy = null
          break
      }
      break
    }
  }
})
