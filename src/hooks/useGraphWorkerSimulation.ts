/**
 * useGraphWorkerSimulation — owns the `workerFailed` flag and exposes a
 * stable `runWorker` callback. Extracted from `useGraphSimulation` per
 * MAINT-127 (originally BUG-45's runtime-failure recovery).
 *
 * When the worker dispatches `error` / `messageerror`, `runWorker`'s
 * internal failure callback flips `workerFailed` to `true`; the
 * orchestrator re-runs its effect and falls back to the main-thread
 * simulation. Once flipped, the flag stays `true` for the session.
 */

import { useCallback, useState } from 'react'
import {
  runWorkerSimulation,
  type SimulationCtx,
  type SimulationHandle,
} from '@/lib/graph-sim-helpers'

export type RunWorkerFn = (ctx: SimulationCtx) => SimulationHandle

export interface UseGraphWorkerSimulationResult {
  workerFailed: boolean
  runWorker: RunWorkerFn
}

export function useGraphWorkerSimulation(): UseGraphWorkerSimulationResult {
  // Once the worker fails in a session we stay on the main-thread path.
  const [workerFailed, setWorkerFailed] = useState(false)

  const runWorker = useCallback<RunWorkerFn>(
    (ctx) =>
      runWorkerSimulation({
        ...ctx,
        onWorkerFailed: () => setWorkerFailed(true),
      }),
    [],
  )

  return { workerFailed, runWorker }
}
