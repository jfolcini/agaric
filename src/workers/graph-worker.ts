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

import type {
  WorkerErrorMessage,
  WorkerInboundMessage,
  WorkerNodeUpdate,
} from './graph-worker-types'

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

/**
 * Pack the current `simNodes` positions into a fresh `Float32Array`
 * (`[x0,y0,x1,y1,…]`) in `simNodes` order (#2194). A fresh buffer is
 * allocated per call because the caller transfers ownership to the main
 * thread — a transferred buffer is detached and cannot be reused. The win is
 * the zero-copy transfer plus the elimination of the per-node `{id,x,y}`
 * object allocation the old structured-clone path incurred every tick.
 *
 * Index→id mapping lives with the main thread, which holds the same node
 * ordering (posted on `start`/`update`); id order is fixed to `simNodes`.
 */
export function packPositions(nodes: readonly SimNode[]): Float32Array {
  const buf = new Float32Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    buf[i * 2] = n?.x ?? 0
    buf[i * 2 + 1] = n?.y ?? 0
  }
  return buf
}

/**
 * `self.postMessage` narrowed to the worker-scope `(message, transfer)` form.
 * The project's tsconfig uses the `DOM` lib (not `WebWorker`), so `self` is
 * typed as `Window`, whose `postMessage` overloads don't include the transfer
 * list. Resolve it at call time (NOT bound once at module load) so test spies
 * on `self.postMessage` are honoured.
 */
type PostWithTransfer = (message: unknown, transfer: Transferable[]) => void

function postPositions(type: 'tick' | 'done'): void {
  const positions = packPositions(simNodes)
  const post = self.postMessage as unknown as PostWithTransfer
  post({ type, positions, count: simNodes.length }, [positions.buffer])
}

/**
 * Build a fresh `SimNode` from an `update` payload node, carrying any known
 * `x`/`y`/`vx`/`vy` so persisting nodes drift rather than re-scatter. Position
 * fields are only set when present: a brand-new node (no prior position)
 * leaves them `undefined` so d3 seeds it on the next tick (#2194).
 */
function assignUpdateNode(n: WorkerNodeUpdate): SimNode {
  const node: SimNode = { id: n.id, label: n.label }
  if (n.x !== undefined) node.x = n.x
  if (n.y !== undefined) node.y = n.y
  if (n.vx !== undefined) node.vx = n.vx
  if (n.vy !== undefined) node.vy = n.vy
  return node
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

        simNodes = nodes.map((n) => Object.assign({}, n))
        const simEdges: SimEdge[] = edges.map((e) => Object.assign({}, e))

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
          postPositions('tick')
        })

        simulation.on('end', () => {
          postPositions('done')
        })

        break
      }

      case 'update': {
        // #2194: swap the node/edge set on the EXISTING simulation instead of
        // tearing the worker down and re-posting `start` (which strips
        // positions → full re-scatter + re-converge, ~300 ticks, on every
        // filter toggle). Mirrors the `resize` philosophy: mutate the live sim
        // in place, then nudge alpha so the layout DRIFTS to the new topology.
        //
        // Positions carried in `msg.nodes` (x/y/vx/vy) are applied to persisting
        // nodes so they keep their spot; brand-new nodes arrive without
        // positions and d3 seeds them on the next tick. Nodes removed by the
        // filter simply drop out of the rebuilt array.
        if (!simulation) break

        simNodes = msg.nodes.map((n) => assignUpdateNode(n))

        // Re-bind the node set. d3 assigns each node a fresh `.index` here and
        // reuses carried x/y/vx/vy from the plain objects above.
        simulation.nodes(simNodes)

        // Re-bind the link force to the new edges. `forceLink.links(...)`
        // re-resolves string source/target ids against the *current* node
        // array (via the `.id` accessor set on `start`), so edge endpoints and
        // d3's internal `index` bookkeeping stay consistent after the swap.
        const linkForce = simulation.force('link') as ReturnType<
          typeof forceLink<SimNode, SimEdge>
        > | null
        if (linkForce) {
          const simEdges: SimEdge[] = msg.edges.map((e) => Object.assign({}, e))
          linkForce.links(simEdges)
        }

        // Nudge alpha so the existing layout re-settles around the new
        // topology instead of restarting cold (mirror `resize`).
        simulation.alpha(0.3).restart()
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
          case 'start': {
            simulation.alphaTarget(0.3).restart()
            node.fx = msg.x
            node.fy = msg.y
            break
          }
          case 'drag': {
            node.fx = msg.x
            node.fy = msg.y
            break
          }
          case 'end': {
            simulation.alphaTarget(0)
            node.fx = null
            node.fy = null
            break
          }
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
