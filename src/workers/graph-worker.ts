/**
 * WebWorker — d3-force simulation off the main thread.
 *
 * Receives graph data from the main thread, runs the force simulation,
 * and posts back node positions on every tick and when the simulation
 * converges.
 */

import {
  forceLink,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

import { applyGraphForces, applyResizeForces, RESIZE_ALPHA } from '@/lib/graph-forces'
import type {
  WorkerErrorMessage,
  WorkerInboundMessage,
  WorkerNodeUpdate,
} from '@/workers/graph-worker-types'

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

/**
 * Timestamp (`performance.now()`, ms) of the last emitted `tick` post. #2273:
 * tick emission is throttled to at most one per ~animation-frame interval so
 * the worker doesn't structured-transfer ~300 buffers per convergence when the
 * main thread already coalesces to a single rAF per frame (most posts would be
 * discarded). Reset to `-Infinity` on every (re)start/update so the first tick
 * of a fresh session posts immediately.
 */
let lastTickEmit = Number.NEGATIVE_INFINITY

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Minimum interval (ms) between emitted `tick` posts — roughly one animation
 * frame at 60Hz. Workers lack a reliable `requestAnimationFrame`, so we gate
 * tick emission on a timestamp delta instead (#2273). The `done`/settle post
 * bypasses this so the converged layout is always sent exactly.
 */
export const TICK_THROTTLE_MS = 16

/**
 * Pure throttle decision for tick emission (#2273): emit only when at least
 * `minIntervalMs` has elapsed since the last emit. Exported so the throttle
 * gate can be unit-tested with explicit timestamps independent of the wall
 * clock. `-Infinity` as `lastEmit` (the session-reset sentinel) always emits.
 */
export function shouldEmitTick(now: number, lastEmit: number, minIntervalMs: number): boolean {
  return now - lastEmit >= minIntervalMs
}

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

        // #2273: fresh session → the first tick posts immediately (not throttled).
        lastTickEmit = Number.NEGATIVE_INFINITY

        simNodes = nodes.map((n) => Object.assign({}, n))
        const simEdges: SimEdge[] = edges.map((e) => Object.assign({}, e))

        simulation = applyGraphForces(forceSimulation<SimNode, SimEdge>(simNodes), {
          edges: simEdges,
          width,
          height,
        })

        simulation.on('tick', () => {
          // #2273: throttle tick emission to ~one per animation-frame interval.
          // Workers have no reliable rAF, so gate on a `performance.now()` delta.
          // The main thread already coalesces to one rAF/frame, so posting (and
          // structured-transferring a fresh buffer) on every one of the ~300
          // convergence ticks is wasted work — most posts are discarded there.
          const now = performance.now()
          if (!shouldEmitTick(now, lastTickEmit, TICK_THROTTLE_MS)) return
          lastTickEmit = now
          postPositions('tick')
        })

        simulation.on('end', () => {
          // #2273: the final settled layout ALWAYS posts, bypassing the throttle,
          // so convergence is exact even when the preceding tick was throttled.
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

        // #2273: new topology → let its first drift tick post immediately.
        lastTickEmit = Number.NEGATIVE_INFINITY

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
        applyResizeForces(simulation, { width, height })
        simulation.alpha(RESIZE_ALPHA).restart()
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
