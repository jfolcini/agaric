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
 * emits. Mirror of the `match` arms in `src-tauri/src/error.rs:162-176`.
 * Adding a variant here without adding it on the Rust side (or vice
 * versa) is a silent drift bug — keep them aligned.
 */
export type AppErrorKind =
  | 'database'
  | 'migration'
  | 'io'
  | 'json'
  | 'ulid'
  | 'not_found'
  | 'invalid_operation'
  | 'channel'
  | 'snapshot'
  | 'validation'
  | 'non_reversible'
  | 'cancelled'
  | 'gcal'

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
