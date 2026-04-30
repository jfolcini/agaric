/**
 * useIpcCommand — collapses the recurring "try/await IPC/catch + logger.<level>
 * + optional optimistic update + revert" boilerplate that settings + dialog
 * components carried inline (MAINT-120).
 *
 * The hook owns:
 *  - the try/catch/finally lifecycle around the IPC adapter,
 *  - the optimistic update (fired before the call) + revert (fired on
 *    rejection, before `onError`),
 *  - the structured `logger.<level>` entry with module + message + optional
 *    context + thrown value,
 *  - tracking `loading` for the most-recent in-flight call.
 *
 * Display of the error to the user is delegated to `onError` so each
 * call-site keeps its existing semantics: a toast, a `setError`, a
 * template-literal inline message, or nothing at all. The hook does NOT
 * call `toast.error` itself — that decision lives at the component layer.
 *
 * Errors thrown by `onSuccess` callbacks are caught and logged at warn
 * level but do NOT trigger revert/onError — a successful IPC followed by
 * a failed callback is not the same shape as a failed IPC, and reverting
 * the optimistic update would be incorrect (the backend already saw the
 * mutation succeed).
 *
 * Suggested adapter shapes:
 *
 *   call: (args) => invoke<T>('cmd', args)        // raw Tauri command
 *   call: (args) => myBinding(args.id, args.name) // pre-bound binding
 *
 * Mirrors the style of `usePaginatedQuery` (caller-supplied `queryFn`,
 * options held in a ref so the returned `execute` stays stable).
 */

import { useCallback, useRef, useState } from 'react'
import { logger } from '@/lib/logger'

type LogLevel = 'error' | 'warn'

export interface UseIpcCommandOptions<TArgs, TResult> {
  /** Adapter that performs the IPC call. */
  call: (args: TArgs) => Promise<TResult>
  /** Logger module name (e.g. component name). */
  module: string
  /** Message string passed as the second arg to `logger.<logLevel>`. */
  errorLogMessage: string
  /**
   * Optional structured data passed as the `data` arg to the logger. The
   * function form receives the `execute` args so callers can include the
   * payload that was sent to the IPC.
   */
  errorLogContext?: Record<string, unknown> | ((args: TArgs) => Record<string, unknown> | undefined)
  /** Logger level — defaults to `'error'`. */
  logLevel?: LogLevel
  /** Optimistic UI update fired BEFORE the IPC call. */
  optimistic?: (args: TArgs) => void
  /** Revert fired if the IPC call rejects. Runs AFTER logger and BEFORE `onError`. */
  revert?: (args: TArgs, err: unknown) => void
  /** Success-path callback (e.g. `toast.success`, refetch). */
  onSuccess?: (result: TResult, args: TArgs) => void | Promise<void>
  /**
   * Error-path callback (e.g. `toast.error(t(key))` or `setError(...)`).
   * Runs AFTER logger and revert. Omit for sites that surface the error
   * elsewhere (or not at all).
   */
  onError?: (err: unknown, args: TArgs) => void
}

export interface UseIpcCommandResult<TArgs, TResult> {
  /**
   * Run the IPC call. Resolves to the IPC result on success, or `undefined`
   * if the call rejected (the rejection is consumed by the hook).
   */
  execute: (args: TArgs) => Promise<TResult | undefined>
  /** True while the most-recently-started `execute` is in flight. */
  loading: boolean
}

export function useIpcCommand<TArgs = void, TResult = void>(
  options: UseIpcCommandOptions<TArgs, TResult>,
): UseIpcCommandResult<TArgs, TResult> {
  const [loading, setLoading] = useState<boolean>(false)
  // Hold the latest options in a ref so `execute` can stay stable across
  // renders — matches usePaginatedQuery's optionsRef pattern.
  const optionsRef = useRef(options)
  optionsRef.current = options
  // Per-call id so concurrent executes only clear `loading` on the most
  // recent one (avoids a stale early-resolver flipping loading off while a
  // later execute is still pending).
  const inFlightIdRef = useRef(0)

  const execute = useCallback(async (args: TArgs): Promise<TResult | undefined> => {
    const opts = optionsRef.current
    const myId = ++inFlightIdRef.current

    setLoading(true)

    if (opts.optimistic) opts.optimistic(args)

    try {
      const result = await opts.call(args)
      // onSuccess errors must NOT trigger revert/onError. A successful IPC
      // followed by a failed callback (e.g. toast library throws, refetch
      // fails) is not the same as a failed IPC — the backend already saw
      // the mutation succeed and reverting the optimistic update would
      // diverge UI from server state. Catch + warn-log only.
      if (opts.onSuccess) {
        try {
          await opts.onSuccess(result, args)
        } catch (successErr) {
          logger.warn(opts.module, 'onSuccess callback threw', undefined, successErr)
        }
      }
      return result
    } catch (err) {
      const ctx =
        typeof opts.errorLogContext === 'function'
          ? opts.errorLogContext(args)
          : opts.errorLogContext
      const log = opts.logLevel === 'warn' ? logger.warn : logger.error
      log(opts.module, opts.errorLogMessage, ctx, err)

      if (opts.revert) opts.revert(args, err)
      if (opts.onError) opts.onError(err, args)
      return undefined
    } finally {
      // Only clear loading if this is the most recent in-flight call —
      // otherwise an earlier resolution can race a later one and toggle
      // loading off prematurely.
      if (inFlightIdRef.current === myId) setLoading(false)
    }
  }, [])

  return { execute, loading }
}
