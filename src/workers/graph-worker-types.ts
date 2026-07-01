/**
 * Shared message types for the graph force-simulation WebWorker protocol.
 *
 * Imported by both `graph-worker.ts` (worker thread) and `GraphView.tsx` (main thread).
 */

// ── Inbound messages (main → worker) ─────────────────────────────────

export interface WorkerNodeInput {
  id: string
  label: string
}

export interface WorkerEdgeInput {
  source: string
  target: string
  ref_count: number
}

export interface WorkerStartMessage {
  type: 'start'
  nodes: WorkerNodeInput[]
  edges: WorkerEdgeInput[]
  width: number
  height: number
}

export interface WorkerStopMessage {
  type: 'stop'
}

/**
 * Update the live simulation's node/edge set IN PLACE (#2194) instead of
 * tearing the worker down and re-posting `start`. Mirrors the `resize`
 * philosophy: swap `simulation.nodes(newNodes)` + the link force's
 * `forceLink.links(newEdges)`, then nudge alpha so the existing layout
 * DRIFTS to the new topology rather than re-scattering from scratch.
 *
 * `nodes` carry any known `x`/`y`/`vx`/`vy` from the main thread so nodes
 * that persist across a filter toggle keep their position; brand-new nodes
 * (no prior position) are left for d3 to initialise. Nodes dropped by the
 * filter simply fall out of the array.
 *
 * Node order is authoritative: the worker's `simNodes` is rebuilt in this
 * exact order, so the transferable tick's `Float32Array` index→id mapping
 * stays consistent between worker and main thread.
 */
export interface WorkerUpdateMessage {
  type: 'update'
  nodes: WorkerNodeUpdate[]
  edges: WorkerEdgeInput[]
}

/**
 * A node in an `update` payload. Unlike `WorkerNodeInput` (used by `start`,
 * which strips positions), this carries the last-known simulation state so
 * persisting nodes drift rather than re-scatter. All position fields are
 * optional — omit them for a brand-new node so d3 seeds it.
 */
export interface WorkerNodeUpdate {
  id: string
  label: string
  x?: number
  y?: number
  vx?: number
  vy?: number
}

export interface WorkerDragMessage {
  type: 'drag'
  nodeId: string
  x: number
  y: number
  phase: 'start' | 'drag' | 'end'
}

/**
 * Resize the simulation's centering/bounds forces to new canvas dimensions
 * WITHOUT re-seeding node positions (#747 item 1). Mirrors the main-thread
 * `applyResizeForces` path: swaps `center`/`x`/`y` in place and nudges alpha
 * so the existing layout re-settles around the new center instead of
 * re-scattering from scratch (which is what re-posting `start` would do).
 */
export interface WorkerResizeMessage {
  type: 'resize'
  width: number
  height: number
}

export type WorkerInboundMessage =
  | WorkerStartMessage
  | WorkerStopMessage
  | WorkerDragMessage
  | WorkerResizeMessage
  | WorkerUpdateMessage

// ── Outbound messages (worker → main) ────────────────────────────────

export interface NodePosition {
  id: string
  x: number
  y: number
}

/**
 * Positions are shipped as a packed `Float32Array` transferable (#2194):
 * `[x0, y0, x1, y1, …]` in the worker's current `simNodes` order. The buffer
 * is posted as a transferable (`postMessage(msg, [buf.buffer])`) so the
 * ~300 per-tick posts hand off ownership zero-copy instead of structure-
 * cloning a fresh `{id,x,y}[]` each frame.
 *
 * The main thread maps `index → id` from its own current node ordering,
 * which is kept in lock-step with the worker's `simNodes` (the same array
 * order is posted on `start`/`update`). `count` is the number of nodes
 * (`positions.length === count * 2`).
 */
export interface WorkerTickMessage {
  type: 'tick'
  positions: Float32Array
  count: number
}

export interface WorkerDoneMessage {
  type: 'done'
  positions: Float32Array
  count: number
}

export interface WorkerErrorMessage {
  type: 'error'
  message: string
}

export type WorkerOutboundMessage = WorkerTickMessage | WorkerDoneMessage | WorkerErrorMessage
