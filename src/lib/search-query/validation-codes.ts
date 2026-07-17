/**
 * #1061 / #2251 — the `AppError::Validation` sub-kind vocabulary.
 *
 * The Rust enum `error::ValidationCode` is the single source of truth; the
 * specta-generated `ValidationCode` string-literal union in `bindings.ts` is
 * its projection, and coded validation errors arrive over IPC as
 * `{ kind: 'validation', message, code }` — the code is **data**, not a
 * `"<Code>: <reason>"` message prefix. IPC consumers discriminate with
 * `validationCode(err)` from `@/lib/app-error`; the old `prefixToken` /
 * `parseValidationReason` message-regexing helpers are gone.
 *
 * This module provides the **runtime** mirror of the generated (type-only)
 * union: a const object whose keys AND values are pinned to the union by the
 * `satisfies` clause below, so adding/renaming a variant on the Rust side
 * fails TypeScript compilation here after bindings regeneration — the
 * cross-language contract check is now by construction rather than by a
 * pair of string-pinning tests.
 */

import type { ValidationCode as GeneratedValidationCode } from '@/lib/bindings'

/** The specta-generated string-literal union (see `bindings.ts`). */
export type ValidationCode = GeneratedValidationCode

/** Runtime value mirror of the generated `ValidationCode` union. */
export const ValidationCode = {
  /** Invalid page-name glob filter. */
  InvalidGlob: 'InvalidGlob',
  /** Invalid user-supplied regex. */
  InvalidRegex: 'InvalidRegex',
  /** Invalid / unparseable date-filter bound. */
  InvalidDateFilter: 'InvalidDateFilter',
  /** Filter primitive not allowed / unsupported on the queried surface. */
  InvalidFilter: 'InvalidFilter',
  /** Stale pagination cursor — retry once without a cursor. */
  RequiresRefresh: 'RequiresRefresh',
  /** Requested page/root block does not belong to the requesting space. */
  PageNotInSpace: 'PageNotInSpace',
} as const satisfies { [K in GeneratedValidationCode]: K }

/**
 * Build the `"<code>: <reason>"` display string used by the frontend-side
 * validators (`glob-validate.ts`, `register.ts`) for the invalid-chip UX.
 *
 * #2251 — this is **display copy only** (chip tooltips / the shared
 * `role="alert"` row in `FilterChipRow`). Nothing parses it back out:
 * IPC validation errors carry the code as a structured field, and the
 * client-side validators keep this label purely so the chip error text
 * matches the established `InvalidGlob: unbalanced bracket` copy.
 */
export function prefixed(code: ValidationCode, reason: string): string {
  return `${code}: ${reason}`
}
