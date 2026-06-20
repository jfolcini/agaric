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

// ── Outbound messages (worker → main) ────────────────────────────────

export interface NodePosition {
  id: string
  x: number
  y: number
}

export interface WorkerTickMessage {
  type: 'tick'
  positions: NodePosition[]
}

export interface WorkerDoneMessage {
  type: 'done'
  positions: NodePosition[]
}

export interface WorkerErrorMessage {
  type: 'error'
  message: string
}

export type WorkerOutboundMessage = WorkerTickMessage | WorkerDoneMessage | WorkerErrorMessage
