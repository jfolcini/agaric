/**
 * Shared d3-force tuning for the graph layout (#2225).
 *
 * The worker (`src/workers/graph-worker.ts`) and the main-thread fallback
 * (`src/lib/graph-sim-helpers.ts`) run the SAME d3-force simulation — one off
 * the main thread, one on it when the worker is unavailable. Their force
 * configuration (link distance, charge, centering, collision, gravity) must
 * stay byte-identical so the two code paths produce the same layout. This
 * module is the single source of truth for that configuration.
 *
 * DOM-free by construction: it imports only from `d3-force` so both the worker
 * scope and the main thread can share it.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

// ── Tuning constants ─────────────────────────────────────────────────

/** Target length of each link (`forceLink.distance`). */
export const LINK_DISTANCE = 60

/**
 * Repulsion is `-(CHARGE_BASE + CHARGE_PER_SQRT_DEGREE·√degree)`, so a hub
 * clears room for its neighbours while an unlinked page stays close.
 */
const CHARGE_BASE = 60
const CHARGE_PER_SQRT_DEGREE = 40

/** Beyond this distance nodes stop repelling, so gravity keeps separate clusters together. */
const CHARGE_DISTANCE_MAX = 180

/** Space kept clear around each node's disc (`forceCollide`). */
const COLLIDE_PADDING = 10

const NODE_RADIUS_MIN = 3
const NODE_RADIUS_MAX = 12
const NODE_RADIUS_PER_SQRT_DEGREE = 1.5

/** Strength of the x/y forces pulling nodes toward the centre (`forceX/forceY.strength`). */
export const GRAVITY_STRENGTH = 0.05

/**
 * Alpha to nudge the simulation with after a resize (or an in-place topology
 * swap, or a kept layout coming back) so the existing layout DRIFTS to the new
 * centre instead of restarting cold. Callers apply it
 * (`sim.alpha(RESIZE_ALPHA).restart()`) — the force helpers below only
 * reconfigure forces, never touch alpha.
 */
export const RESIZE_ALPHA = 0.3

/**
 * Ticks a reduced-motion layout runs synchronously before it is shown once,
 * on both paths, so the user never watches it settle.
 */
export const REDUCED_MOTION_TICK_LIMIT = 300

/**
 * Alpha a fresh simulation starts at. Nodes that arrive with positions are a
 * kept layout coming back (#5434): one that had stopped, with nothing new in
 * it (`keptSettled`), starts at rest; otherwise it starts warm, so it appears
 * settled and only new nodes drift in. With no positions, d3's full-strength
 * start lays it out.
 */
export function startAlpha(nodes: readonly SimulationNodeDatum[], keptSettled: boolean): number {
  if (keptSettled) return 0
  return nodes.some((n) => n.x !== undefined) ? RESIZE_ALPHA : 1
}

// ── Types ────────────────────────────────────────────────────────────

/** Minimum node shape the link force's `.id` accessor needs. */
export interface ForceNode extends SimulationNodeDatum {
  id: string
  /** Links on screen, in and out. */
  degree?: number
}

export interface GraphForceDimensions {
  width: number
  height: number
}

// ── Force builders ───────────────────────────────────────────────────

/**
 * Node radius from its link count: area tracks degree, so `r` grows with
 * √degree, from 3 for an unlinked page up to 12 (#5429).
 */
export function nodeRadius(degree: number): number {
  return Math.min(
    NODE_RADIUS_MIN + NODE_RADIUS_PER_SQRT_DEGREE * Math.sqrt(degree),
    NODE_RADIUS_MAX,
  )
}

/**
 * Configure the full set of layout forces on `sim` (link, charge, centre,
 * collide, x/y gravity) using the shared tuning constants. Charge and
 * collision read each node's `degree`, so both paths must carry it (#5432).
 * Returns `sim` so it can be chained onto a fresh `forceSimulation(...)`.
 *
 * `edges` is bound to the link force with an id accessor, so string
 * `source`/`target` ids resolve against the simulation's current node array.
 */
export function applyGraphForces<N extends ForceNode, E extends SimulationLinkDatum<N>>(
  sim: Simulation<N, E>,
  options: { edges: E[] } & GraphForceDimensions,
): Simulation<N, E> {
  const { edges, width, height } = options
  return sim
    .force(
      'link',
      forceLink<N, E>(edges)
        .id((d) => d.id)
        .distance(LINK_DISTANCE),
    )
    .force(
      'charge',
      forceManyBody<N>()
        .strength((d) => -(CHARGE_BASE + CHARGE_PER_SQRT_DEGREE * Math.sqrt(d.degree ?? 0)))
        .distanceMax(CHARGE_DISTANCE_MAX),
    )
    .force('center', forceCenter<N>(width / 2, height / 2))
    .force(
      'collide',
      forceCollide<N>((d) => nodeRadius(d.degree ?? 0) + COLLIDE_PADDING),
    )
    .force('x', forceX<N>(width / 2).strength(GRAVITY_STRENGTH))
    .force('y', forceY<N>(height / 2).strength(GRAVITY_STRENGTH))
}

/**
 * Re-anchor the centring/bounds forces (centre + x/y gravity) to new canvas
 * dimensions IN PLACE, without re-seeding node positions. Mirrors the worker's
 * `resize` handler and the main-thread `applyResizeForces` path. Does NOT touch
 * alpha — the caller nudges with {@link RESIZE_ALPHA} as appropriate for its
 * (animated vs. reduced-motion) path.
 */
export function applyResizeForces<N extends ForceNode, E extends SimulationLinkDatum<N>>(
  sim: Simulation<N, E>,
  dimensions: GraphForceDimensions,
): void {
  const { width, height } = dimensions
  sim.force('center', forceCenter<N>(width / 2, height / 2))
  sim.force('x', forceX<N>(width / 2).strength(GRAVITY_STRENGTH))
  sim.force('y', forceY<N>(height / 2).strength(GRAVITY_STRENGTH))
}
