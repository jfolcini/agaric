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

/** Many-body charge strength; negative = mutual repulsion (`forceManyBody.strength`). */
export const CHARGE_STRENGTH = -100

/** Collision radius keeping node discs from overlapping (`forceCollide`). */
export const COLLIDE_RADIUS = 20

/** Strength of the x/y forces pulling nodes toward the centre (`forceX/forceY.strength`). */
export const GRAVITY_STRENGTH = 0.05

/**
 * Alpha to nudge the simulation with after a resize (or an in-place topology
 * swap) so the existing layout DRIFTS to the new centre instead of restarting
 * cold. Callers apply it (`sim.alpha(RESIZE_ALPHA).restart()`) — the force
 * helpers below only reconfigure forces, never touch alpha.
 */
export const RESIZE_ALPHA = 0.3

// ── Types ────────────────────────────────────────────────────────────

/** Minimum node shape the link force's `.id` accessor needs. */
export interface ForceNode extends SimulationNodeDatum {
  id: string
}

export interface GraphForceDimensions {
  width: number
  height: number
}

// ── Force builders ───────────────────────────────────────────────────

/**
 * Configure the full set of layout forces on `sim` (link, charge, centre,
 * collide, x/y gravity) using the shared tuning constants. Returns `sim` so it
 * can be chained onto a fresh `forceSimulation(...)`.
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
    .force('charge', forceManyBody<N>().strength(CHARGE_STRENGTH))
    .force('center', forceCenter<N>(width / 2, height / 2))
    .force('collide', forceCollide<N>(COLLIDE_RADIUS))
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
