/**
 * useGraphMainThreadSim — exposes a stable `runMainThread` callback that
 * runs the d3-force simulation on the main thread. Extracted from
 * `useGraphSimulation` per MAINT-127.
 *
 * Used both as the no-Worker fallback (jsdom, older runtimes) and as the
 * post-failure recovery path when the worker dispatches `error` /
 * `messageerror` (BUG-45).
 */

import { useCallback } from 'react'
import {
  runMainThreadSimulation,
  type SimulationCtx,
  type SimulationHandle,
} from '@/lib/graph-sim-helpers'

export type RunMainThreadFn = (ctx: SimulationCtx) => SimulationHandle

export function useGraphMainThreadSim(): RunMainThreadFn {
  return useCallback<RunMainThreadFn>((ctx) => runMainThreadSimulation(ctx), [])
}
