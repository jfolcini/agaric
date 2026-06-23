/**
 * `formatErrorForDisplay` — the single place that turns an arbitrary
 * caught value into the string shown on a user-facing error surface
 * (toast or inline banner), honouring the debug-mode toggle (#1987).
 *
 * Behaviour:
 * - **Plain strings/numbers pass through untouched.** Most call sites
 *   already hand `notify.error` a translated human string (`t('…')`);
 *   those must render verbatim regardless of debug mode.
 * - **Errors and IPC `AppError` objects** are reduced to their message
 *   with the cosmetic Rust `Xxx error:` display prefix stripped. Any
 *   `(err: <id>)` correlation code embedded by the backend's
 *   `sanitize_internal_error` is preserved in **both** modes, so a user
 *   can always read the code back and an operator can grep the daily log.
 * - **Debug mode on** additionally appends the structured `kind` (the
 *   machine-readable "error code"), e.g. `· code: invalid_operation`.
 *
 * This is intentionally the only formatter: routing the `notify`
 * chokepoint and the inline banners through it is what makes "every error
 * surface respects the toggle" true by construction rather than by
 * per-call-site discipline.
 */

import { getDebugMode } from '@/stores/useDebugStore'

import { isAppError } from './app-error'

/**
 * Leading `AppError` Display prefixes (mirrors the `#[error("… : {0}")]`
 * attributes in `src-tauri/src/error.rs`). Stripped for readability; the
 * informative remainder — including any embedded validation code or
 * `(err: <id>)` suffix — is kept.
 */
const ERROR_PREFIXES: readonly string[] = [
  'Database error: ',
  'Migration error: ',
  'IO error: ',
  'JSON error: ',
  'ULID error: ',
  'Invalid operation: ',
  'Channel error: ',
  'Internal error: ',
  'Snapshot error: ',
  'Validation error: ',
  'Not found: ',
  'Conflict: ',
]

function stripErrorPrefix(message: string): string {
  for (const prefix of ERROR_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length)
  }
  return message
}

export interface FormatErrorOptions {
  /**
   * Override the debug flag (tests, or callers that already read the
   * store). Defaults to the live `getDebugMode()` value.
   */
  debug?: boolean
}

/**
 * Normalise an unknown caught value to `{ kind?, message }`. Returns
 * `null` for plain string/number values, signalling "render verbatim".
 */
function describe(err: unknown): { kind?: string; message: string } | null {
  if (typeof err === 'string' || typeof err === 'number') return null
  if (isAppError(err)) return { kind: err.kind, message: err.message }
  if (err instanceof Error) return { message: err.message }
  return { message: String(err) }
}

export function formatErrorForDisplay(err: unknown, opts: FormatErrorOptions = {}): string {
  const described = describe(err)
  if (described === null) return String(err)

  const debug = opts.debug ?? getDebugMode()
  const base = stripErrorPrefix(described.message)

  if (!debug || !described.kind) return base
  return `${base} · code: ${described.kind}`
}
