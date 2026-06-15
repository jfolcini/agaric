/**
 * PEND-73 Phase 2 — frontend-side type narrowing for the Tauri-IPC
 * `AppError` wire shape.
 *
 * The backend's `AppError` (src-tauri/src/error.rs) serialises to
 * `{ kind, message }` via a manual `Serialize` impl. The generated
 * `bindings.ts` types `AppError` as `{ kind: string, message: string }`
 * because the specta-derived schema struct is intentionally open
 * (it's the wire-format contract, not the variant taxonomy).
 *
 * This module narrows that open shape into the actual variant kinds
 * emitted by the manual `Serialize` impl, so consumers can match on
 * `err.kind` with type assistance instead of comparing raw strings
 * inline. Adding a new variant on the backend side requires touching
 * `AppErrorKind` here too — that coupling is intentional and is what
 * keeps the two ends aligned without regenerating `bindings.ts`.
 *
 * Why not regenerate bindings.ts? Two reasons:
 *   1. `bindings.ts` is the auto-generated tauri-specta artifact; the
 *      tauri-bindings-parity prek hook keeps it in sync with the Rust
 *      side, and hand-edits there have to be re-applied on every
 *      `cargo test -- specta_tests --ignored` regeneration.
 *   2. A TS-side narrowing union doesn't need specta enum support
 *      (which is patchy across `#[serde(tag = "kind")]` enum
 *      representations); the wire shape stays whatever specta emits.
 */

import type { AppError } from './bindings'

/**
 * The exact `kind` literals the manual `AppError` `Serialize` impl
 * emits. Mirror of the `match` arms in `src-tauri/src/error.rs`.
 * Adding a variant here without adding it on the Rust side (or vice
 * versa) is a silent drift bug — keep them aligned.
 *
 * Issue #106 added `pool_busy` (transient back-pressure from the
 * sqlx connection pool — callers should retry) and `conflict`
 * (unique-constraint violation — surface distinctly so the user sees
 * "already exists" rather than a generic DB error toast). `database`
 * stays as the catch-all fallback for any sqlx error that isn't
 * pool-exhaustion or constraint violation.
 */
export type AppErrorKind =
  | 'database'
  | 'migration'
  | 'io'
  | 'json'
  | 'ulid'
  | 'not_found'
  | 'pool_busy'
  | 'conflict'
  | 'invalid_operation'
  | 'channel'
  | 'snapshot'
  | 'validation'
  | 'non_reversible'
  | 'cancelled'

/**
 * Narrowed `AppError` shape. Same fields as the bindings.ts type,
 * but `kind` is a known literal union. Open-ended so a forward-compat
 * variant from the backend doesn't make consumers fail to compile.
 */
export type TypedAppError = AppError & { kind: AppErrorKind | (string & {}) }

/**
 * Predicate: did this error come from the IPC layer? Tauri rejects
 * with the serialised `AppError` shape, but `.catch(err)` types `err`
 * as `unknown` — so callers need a guard before reading `.kind`.
 */
export function isAppError(err: unknown): err is TypedAppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    'message' in err &&
    typeof (err as { kind: unknown }).kind === 'string' &&
    typeof (err as { message: unknown }).message === 'string'
  )
}

/**
 * Was the request cancelled (PEND-70 backend cancellation OR a
 * client-side abort)? Cancellation is the EXPECTED case when a fast
 * typist fires a fresh keystroke before the previous IPC completes —
 * consumers should swallow it silently (no toast, no error counter)
 * and rely on their stale-discard guard (`generationRef` or
 * `AbortController`) to ignore the dropped response.
 */
export function isCancellation(err: unknown): err is TypedAppError & { kind: 'cancelled' } {
  return isAppError(err) && err.kind === 'cancelled'
}

/**
 * Was the resource not found? Issue #106 — this is an EXPECTED empty
 * state for pickers / resolvers (the page just doesn't exist yet, the
 * alias points nowhere). Callers should suppress the error toast and
 * treat the result as "no data" rather than "operation failed".
 */
export function isNotFound(err: unknown): err is TypedAppError & { kind: 'not_found' } {
  return isAppError(err) && err.kind === 'not_found'
}

/**
 * Was this a sqlx connection-pool back-pressure error? Issue #106 —
 * the backend emits this when every pool connection is checked out
 * AND the acquire timed out. It is transient: the next attempt has a
 * good chance of succeeding once an in-flight query completes.
 *
 * Callers MUST NOT hand-roll a retry loop; route through the shared
 * {@link retryOnPoolBusy} helper so the backoff schedule is uniform
 * across the app (autosave hooks, batch writes, etc.).
 */
export function isPoolBusy(err: unknown): err is TypedAppError & { kind: 'pool_busy' } {
  return isAppError(err) && err.kind === 'pool_busy'
}

/**
 * Was this a unique-constraint violation? Issue #106 — the backend
 * disambiguates duplicate-key sqlx errors from generic DB errors so
 * the frontend can show the user "already exists" instead of the
 * generic DB error toast. Caller-specific UX (which field, which
 * i18n key) is up to the consumer; this predicate just narrows the
 * branch.
 */
export function isConflict(err: unknown): err is TypedAppError & { kind: 'conflict' } {
  return isAppError(err) && err.kind === 'conflict'
}

/**
 * Was this the generic-fallback database error? Issue #106 — kept
 * for callers that explicitly want to branch on the catch-all DB
 * variant. Most callers should use the more specific predicates
 * above instead.
 */
export function isDatabaseError(err: unknown): err is TypedAppError & { kind: 'database' } {
  return isAppError(err) && err.kind === 'database'
}

/**
 * Default retry schedule for {@link retryOnPoolBusy}.
 *
 * Three attempts, with delays measured from the start of each attempt:
 *   - try 1: immediate
 *   - try 2: +50ms
 *   - try 3: +150ms (50 * 3)
 *
 * Total wall time on a pathological all-busy run is bounded at
 * ~200ms — short enough to feel synchronous for autosave, long enough
 * to let a typical in-flight query finish and free a connection.
 * Tunable per-call via {@link RetryOnPoolBusyOptions}.
 */
const DEFAULT_POOL_BUSY_DELAYS_MS: ReadonlyArray<number> = [50, 150]

export interface RetryOnPoolBusyOptions {
  /**
   * Inter-attempt delays in milliseconds. The number of attempts is
   * `delaysMs.length + 1` (the first attempt is immediate).
   */
  delaysMs?: ReadonlyArray<number>
  /**
   * Optional hook fired before each retry; useful for tests and for
   * structured logging. Receives the 1-based retry attempt number
   * (the second total attempt is `1`, the third is `2`, …).
   */
  onRetry?: (attempt: number, err: TypedAppError) => void
  /**
   * Sleep function — defaults to `setTimeout`-backed. Override in
   * tests with `vi.useFakeTimers()` semantics or a synchronous stub.
   */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Single shared retry helper for the `pool_busy` IPC error. Issue
 * #106 — wraps any IPC-returning thunk so a transient pool-exhaustion
 * blip is retried with a short backoff before bubbling up.
 *
 * The wrapper RE-THROWS any non-`pool_busy` error immediately (no
 * exponential retry on `database`, `conflict`, etc.) so the
 * consumer's existing error handling stays unchanged for the cases
 * where retry doesn't help.
 *
 * Call sites should funnel through this helper rather than hand-
 * rolling timers — keeps the backoff schedule uniform and makes it
 * trivial to tune from one place when production telemetry suggests
 * a different curve.
 */
export async function retryOnPoolBusy<T>(
  thunk: () => Promise<T>,
  opts: RetryOnPoolBusyOptions = {},
): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_POOL_BUSY_DELAYS_MS
  const sleep = opts.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await thunk()
    } catch (err) {
      if (!isPoolBusy(err)) throw err
      lastErr = err
      const delayIdx = attempt
      if (delayIdx < delays.length) {
        opts.onRetry?.(attempt + 1, err)
        const ms = delays[delayIdx] ?? 0
        await sleep(ms)
      }
    }
  }
  // Exhausted all retries — bubble the last `pool_busy` so the caller
  // can decide whether to surface a "try again later" toast or queue
  // the work for a later flush.
  throw lastErr
}
