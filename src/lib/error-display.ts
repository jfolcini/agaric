/**
 * `formatErrorForDisplay` — the single place that turns an arbitrary
 * caught value into the string shown on a user-facing error surface
 * (toast or inline banner), honouring the debug-mode toggle (#1987).
 *
 * Behaviour:
 * - **Plain strings/numbers pass through untouched.** Most call sites
 *   already hand `notify.error` a translated human string (`t('…')`);
 *   those must render verbatim regardless of debug mode.
 * - **A coded validation error, or a sanitized internal error, renders its
 *   translated sentence** ({@link translatedErrorSentence}), because the
 *   backend writes its messages in English. The internal sentence keeps the
 *   `(err: <id>)` correlation code `sanitize_internal_error` embeds, so a
 *   user can read it back and an operator can grep the daily log.
 * - **Every other error renders its own message**, with the cosmetic Rust
 *   `Xxx error:` display prefix stripped: it explains this one failure in a
 *   way no generic sentence could.
 * - **Debug mode on** appends the machine details: the backend's raw message
 *   after a translated sentence, then the structured `kind` (and validation
 *   `code`), e.g. `· code: invalid_operation`.
 *
 * This is intentionally the only formatter: routing the `notify`
 * chokepoint and the inline banners through it is what makes "every error
 * surface respects the toggle" true by construction rather than by
 * per-call-site discipline.
 */

import { isAppError, type ValidationCode } from '@/lib/app-error'
import { t } from '@/lib/i18n'
import { PREFERENCES, readPreference } from '@/lib/preferences'

/**
 * The i18n key of the sentence each validation code renders as, or `null` to
 * keep the backend's message. `tsc` fails here when the backend adds a code.
 */
export const VALIDATION_CODE_KEYS: Record<ValidationCode, string | null> = {
  InvalidGlob: 'errorCode.invalidGlob',
  InvalidRegex: 'errorCode.invalidRegex',
  InvalidDateFilter: 'errorCode.invalidDateFilter',
  InvalidFilter: 'pageBrowser.filter.invalidFilter',
  RequiresRefresh: 'errorCode.requiresRefresh',
  PageNotInSpace: 'error.pageNotInCurrentSpace',
  InvalidRepeatRule: 'errorCode.invalidRepeatRule',
  // Only the English message names the clashing title, which a batch move,
  // restore or revert needs (#6051, #6099); translating it needs the title
  // as structured data from the backend.
  DuplicatePageTitle: null,
  DuplicatePageAlias: 'pageHeader.aliasTaken',
  InvalidAgentName: 'agentAccess.agents.invalidName',
  DuplicateAgentName: 'errorCode.duplicateAgentName',
  BuiltinPropertyLocked: 'errorCode.builtinPropertyLocked',
  UnacknowledgedPropertyLoss: 'errorCode.unacknowledgedPropertyLoss',
  TagNameWhitespace: 'tags.nameHasWhitespace',
}

/** The `(err: <id>)` that ends a message `sanitize_internal_error` wrote. */
const CORRELATION_ID = /\(err: (\w+)\)$/

/**
 * The translated sentence for a backend error, or `null` when it has none
 * and its own message is what to show.
 */
function translatedErrorSentence(err: unknown): string | null {
  if (!isAppError(err)) return null
  if (err.code != null) {
    const key = VALIDATION_CODE_KEYS[err.code]
    return key === null ? null : t(key)
  }
  if (err.kind !== 'internal') return null
  const id = CORRELATION_ID.exec(err.message)?.[1]
  return id === undefined ? null : t('error.internal', { id })
}

/**
 * Leading `AppError` Display prefixes (mirrors the `#[error("… : {0}")]`
 * attributes in `src-tauri/agaric-core/src/error.rs`). Stripped for readability; the
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
   * Override the debug flag (tests, or callers that already read it).
   * Defaults to the stored `PREFERENCES.debugMode` value.
   */
  debug?: boolean
  /**
   * Shown when `err` is not a recognisable error — a thrown non-`Error`
   * value such as `undefined`, `null`, or a bare object. Lets a call site
   * keep its context-specific copy (`'Failed to rename'`) instead of
   * surfacing a useless `String(err)` like `"undefined"` /
   * `"[object Object]"`. Ignored for strings/numbers (rendered verbatim)
   * and for real `Error` / IPC `AppError` values (which carry a message).
   */
  fallback?: string
}

export function formatErrorForDisplay(err: unknown, opts: FormatErrorOptions = {}): string {
  // Pre-built human strings/numbers render verbatim.
  if (typeof err === 'string' || typeof err === 'number') return String(err)

  let kind: string | undefined
  let message: string
  if (isAppError(err)) {
    // #2251 — coded validation errors carry a structured sub-kind; in debug
    // mode surface it alongside the kind (`code: validation/InvalidRegex`).
    kind = err.code != null ? `${err.kind}/${err.code}` : err.kind
    message = err.message
  } else if (err instanceof Error) {
    message = err.message
  } else {
    // Unrecognised throw (bare object, null, undefined): prefer the
    // caller's fallback over a useless String(err).
    return opts.fallback ?? String(err)
  }

  const debug = opts.debug ?? readPreference(PREFERENCES.debugMode)
  const base = stripErrorPrefix(message)
  const sentence = translatedErrorSentence(err)
  if (sentence !== null) return debug ? `${sentence} · ${base} · code: ${kind}` : sentence
  if (!debug || !kind) return base
  return `${base} · code: ${kind}`
}
