/**
 * Shared message types for the graph force-simulation WebWorker protocol (PERF-9b).
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

export type WorkerInboundMessage = WorkerStartMessage | WorkerStopMessage | WorkerDragMessage

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

export type WorkerOutboundMessage = WorkerTickMessage | WorkerDoneMessage
