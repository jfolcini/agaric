/**
 * WebWorker — d3-force simulation off the main thread.
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

import type { NodePosition, WorkerErrorMessage, WorkerInboundMessage } from './graph-worker-types'

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
  try {
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

      case 'resize': {
        // #747 item 1: update centering/bounds forces in place WITHOUT
        // re-seeding positions. Re-posting `start` rebuilds the sim from
        // scratch (positions stripped to {id,label}) → full re-scatter +
        // re-converge on every container resize. Mirror the main-thread
        // `applyResizeForces` path: swap center/x/y, then nudge alpha so the
        // existing layout drifts to the new center instead of restarting.
        if (!simulation) break

        const { width, height } = msg
        simulation.force('center', forceCenter(width / 2, height / 2))
        simulation.force('x', forceX(width / 2).strength(0.05))
        simulation.force('y', forceY(height / 2).strength(0.05))
        simulation.alpha(0.3).restart()
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
  } catch (err) {
    // #1614: post a single structured error message back so the main thread
    // gets a richer signal than "unknown failure". We deliberately do NOT
    // re-throw: re-throwing surfaced at the worker boundary as a global `error`
    // event, which posted a SECOND `{type:'error'}` message and fanned one
    // handler failure into multiple signals. The main thread routes this
    // structured post through the same `reportFailure` fallback path as a
    // boundary error, so a single post is sufficient. The global
    // `error`/`unhandledrejection` listeners below remain the fallback for
    // failures that genuinely escape this handler (e.g. future async paths).
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerErrorMessage)
  }
})

// #1614: belt-and-braces global handlers for failures that escape the
// dispatcher try/catch (e.g., unhandled rejections from a future async path).
// Normal handler failures are reported by the catch above and never reach
// here, so a single handler failure yields exactly one structured error post.
self.addEventListener('error', (e) => {
  self.postMessage({
    type: 'error',
    message: e.message ?? 'worker error',
  } satisfies WorkerErrorMessage)
})

self.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  self.postMessage({
    type: 'error',
    message: reason instanceof Error ? reason.message : String(reason),
  } satisfies WorkerErrorMessage)
})
