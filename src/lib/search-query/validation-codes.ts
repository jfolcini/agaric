/**
 * #1061 — Single TS-side source of truth for the `AppError::Validation`
 * sub-kind prefixes.
 *
 * The Rust backend serialises validation errors as an untagged
 * `{ kind: "validation", message: "<Prefix>: <reason>" }` envelope, where
 * `<Prefix>` is one of the stable codes below. The frontend both:
 *   1. re-emits the same prefixes when it does cheap client-side validation
 *      ahead of an IPC round-trip (`glob-validate.ts`, `register.ts`), and
 *   2. parses the prefix back out of the raw IPC `message` to surface an
 *      inline, sub-kind-specific UX (`useSearchResults.ts`).
 *
 * Historically these prefixes were hand-spelled as raw literals at every one
 * of those sites — triplicated across Rust-emit / TS-emit / TS-parse with
 * nothing enforcing they stayed identical. A rename or typo on any side
 * silently degraded the inline validation to the generic-error toast.
 *
 * This module is the canonical TS list. The matching Rust source of truth is
 * `src-tauri/src/error.rs::validation_code`; the two are pinned to identical
 * string values by tests on each side (`validation-codes.test.ts` here and the
 * `*_1061` Rust tests), which is the cross-language contract check. The wire
 * envelope is unchanged — the prefix is still part of `message`.
 */

/** Stable validation sub-kind codes — must match `error.rs::validation_code`. */
export const ValidationCode = {
  /** Invalid page-name glob filter. */
  InvalidGlob: 'InvalidGlob',
  /** Invalid user-supplied regex. */
  InvalidRegex: 'InvalidRegex',
  /** Invalid / unparseable date-filter bound. */
  InvalidDateFilter: 'InvalidDateFilter',
} as const

export type ValidationCode = (typeof ValidationCode)[keyof typeof ValidationCode]

/**
 * Build the `"<code>: <reason>"` message body that mirrors what
 * `AppError::Validation` carries over the wire. Used by the TS-side
 * re-emitters so they never hand-spell the prefix.
 */
export function prefixed(code: ValidationCode, reason: string): string {
  return `${code}: ${reason}`
}

/**
 * The literal prefix token (including the trailing `:`) the backend message
 * starts with for a given code, e.g. `"InvalidRegex:"`. Used by the IPC-error
 * parser to locate and strip the sub-kind off the raw `message`.
 */
export function prefixToken(code: ValidationCode): string {
  return `${code}:`
}

/**
 * If `message` carries the given validation code's prefix, return the trimmed
 * reason that follows it; otherwise `null`. Mirrors the backend `"<code>: …"`
 * layout in one place so callers don't re-spell `indexOf('InvalidRegex:')`.
 */
export function parseValidationReason(message: string, code: ValidationCode): string | null {
  const token = prefixToken(code)
  const idx = message.indexOf(token)
  if (idx < 0) return null
  return message.slice(idx + token.length).trim()
}
