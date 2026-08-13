/**
 * Phase 2 — frontend-side type narrowing for the Tauri-IPC
 * `AppError` wire shape.
 *
 * #2251 — the backend's `AppError` (src-tauri/src/error.rs) serialises to
 * `{ kind, message, code? }`, and its specta schema now types `kind` as the
 * generated `AppErrorKind` string-literal union (and `code` as the
 * `ValidationCode` union) in `bindings.ts`. The hand-maintained mirror
 * union that used to live here is gone: the Rust `AppErrorKind` enum is the
 * single source of truth, `bindings.ts` is its generated projection, and a
 * typo'd kind comparison (`err.kind === 'cancelation'`) is now a
 * type-check error instead of a silently-false branch.
 */

import type { AppError, ValidationCode } from '@/lib/bindings'

// Re-export the generated unions under their canonical names so consumers
// keep importing error vocabulary from `@/lib/app-error` (the narrowing
// module) rather than reaching into the generated bindings directly.
export type { AppError, AppErrorKind, ValidationCode } from '@/lib/bindings'

/**
 * The IPC error shape. Since #2251 the generated `AppError` already carries
 * the narrow `kind: AppErrorKind` literal union, so this is a plain alias —
 * kept because the name is established across consumers and tests.
 */
export type TypedAppError = AppError

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
 * Was the request cancelled (backend cancellation OR a
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
 * Was this a business-rule / input validation rejection? #2251 — coded
 * validation errors additionally carry a structured `code` field
 * (`ValidationCode` union); use {@link validationCode} to read it.
 */
export function isValidation(err: unknown): err is TypedAppError & { kind: 'validation' } {
  return isAppError(err) && err.kind === 'validation'
}

/**
 * Was this a "the request conflicts with the current state" rejection?
 * #3835 — `purge_blocks_by_ids` (#3832) rejects a batch containing a live
 * (non-deleted) id with this kind rather than silently skipping it, and its
 * JSDoc tells callers the rejection means their listing is stale (an id was
 * restored elsewhere between the listing render and the purge). A caller
 * sourcing ids from a cached listing should use this predicate to refresh
 * that listing and tell the user why, instead of showing the same generic
 * failure toast a retry would also hit.
 *
 * Today that caller is `TrashView.handleBatchPurge`, and only it. "Empty
 * trash" deliberately does NOT use this: `purgeAllDeletedInSpace` re-collects
 * ids via `collectAllTrashRootIds` immediately before purging, so its stale
 * window is far narrower, and a rejection on the FIRST chunk arrives as
 * `PartialPurgeError` with `affectedCount === 0` and falls through to the
 * generic `emptyTrashFailed` toast. That is a defensible trade, but it is a
 * trade — this doc previously named "empty trash" as a caller that should
 * use the predicate, describing a call site that does not exist.
 */
export function isInvalidOperation(
  err: unknown,
): err is TypedAppError & { kind: 'invalid_operation' } {
  return isAppError(err) && err.kind === 'invalid_operation'
}

/**
 * Was this an "op has no applicable inverse" rejection? #3353 —
 * `undoOp`/`undoOps`/`redoPageOp` reject with this kind when the backend
 * cannot reverse the target: `purge_block` has no inverse at all
 * (`src-tauri/src/reverse/mod.rs`), an `edit_block` whose prior text is
 * unreconstructible has none either (`reverse/block_ops.rs`), and the
 * reverse-move preflight (`src-tauri/src/commands/history.rs`) refuses a
 * move whose prior parent is gone/soft-deleted or has become a descendant
 * of the block being moved back.
 *
 * #3546 — do NOT read this as "will fail identically forever". Two of
 * those arms are functions of the CURRENT tree, not of immutable op-log
 * history: a soft-deleted prior parent can be revived from trash, and a
 * cycle can be broken by a later move. The wire envelope is the bare
 * `{ kind, message }` (no `code` sub-kind, unlike `validation`), and the
 * `op_type` in the message is `"move_block"` for the state-dependent AND
 * the permanent move arms alike, so callers cannot tell them apart. See
 * `isPermanentRevertFailure` in `stores/undo.ts` for what the undo store
 * does with that, and why.
 */
export function isNonReversible(err: unknown): err is TypedAppError & { kind: 'non_reversible' } {
  return isAppError(err) && err.kind === 'non_reversible'
}

/**
 * The structured validation sub-kind of an IPC error, or `null` when the
 * value is not a validation `AppError` or carries no code. #2251 — replaces
 * the old `parseValidationReason` message-prefix regexing: the backend now
 * ships the code as data, so discrimination is a typed compare
 * (`validationCode(err) === ValidationCode.InvalidRegex`) with no string
 * parsing on either side.
 */
export function validationCode(err: unknown): ValidationCode | null {
  return isValidation(err) ? (err.code ?? null) : null
}

/**
 * Unwrap a `commands.*` result, throwing on error to preserve the
 * reject-based semantics of the legacy `invoke()` wrappers. Helper for
 * the staged migration off the hand-written `@/lib/tauri` wrappers to the
 * generated `@/lib/bindings` layer (#2927): component call sites — which
 * cannot use the raw `invoke()` bypass, per the `no-raw-invoke` guard —
 * adopt the `commands.foo(...).then(unwrap)` / `unwrap(await commands.foo())`
 * convention instead of a bespoke wrapper.
 *
 * Lives here (the tauri-free IPC-error module) rather than in `tauri.ts`
 * so a migrated file can drop its `@/lib/tauri` import entirely. Still
 * re-exported from `@/lib/tauri` for backward compatibility with existing
 * importers.
 */
export function unwrap<T>(
  result: { status: 'ok'; data: T } | { status: 'error'; error: unknown },
): T {
  if (result.status === 'ok') return result.data
  throw result.error
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
