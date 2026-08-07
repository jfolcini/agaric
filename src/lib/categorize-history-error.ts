/**
 * categorizeHistoryError — classify a `listPageHistory` failure into a
 * user-meaningful bucket so the History error banner can show
 * actionable context instead of a generic message.
 *
 *  - `network` — reserved for a future structured transport discriminator
 *  - `server`  — selected typed IPC backend failures
 *  - `unknown` — anything else
 *  - `null`    — expected cancellation; the caller suppresses error UX
 *
 * Tauri command failures are serialized `AppError`s, so their `kind` is the
 * authoritative discriminator. Opaque values and native `Error` instances
 * remain unknown: message text is not a stable transport discriminator.
 */

import { isAppError, type AppErrorKind } from '@/lib/app-error'

export type HistoryErrorCategory = 'network' | 'server' | 'unknown'

const appErrorCategories = {
  database: 'server',
  not_found: 'unknown',
  pool_busy: 'server',
  conflict: 'unknown',
  migration: 'unknown',
  io: 'unknown',
  json: 'unknown',
  ulid: 'unknown',
  invalid_operation: 'unknown',
  channel: 'unknown',
  internal: 'server',
  snapshot: 'server',
  validation: 'unknown',
  non_reversible: 'unknown',
  cancelled: null,
} satisfies Record<AppErrorKind, HistoryErrorCategory | null>

export function categorizeHistoryError(err: unknown): HistoryErrorCategory | null {
  if (isAppError(err)) {
    // `isAppError` validates the envelope, while the generated union validates
    // known kinds at compile time. Keep a runtime fallback for a newer backend
    // introducing a kind before this frontend has regenerated its bindings.
    const category = appErrorCategories[err.kind]
    return category === undefined ? 'unknown' : category
  }

  return 'unknown'
}
