/**
 * connectErrorMessage — map an `AppError` payload from `begin_gcal_oauth`
 * onto a user-facing toast string.
 *
 * The backend serializes errors as
 * `{ kind: 'validation', message: 'oauth.<key>: …' }`
 * (see `src-tauri/src/error.rs` and
 * `src-tauri/src/gcal_push/oauth.rs:451`). We pattern-match the prefix
 * so an unrecognised payload falls back to the generic
 * `gcal.connectFailed` rather than leaking the raw key.
 *
 * Extracted from `GoogleCalendarSettingsTab.tsx` per Phase 3b
 * (`pending/design-system-maintainability-2026-05-09.md`) so the
 * orchestrator stays under the 450-line budget.
 */

interface AppErrorPayload {
  kind: string
  message: string
}

function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value &&
    typeof (value as Record<string, unknown>)['kind'] === 'string' &&
    typeof (value as Record<string, unknown>)['message'] === 'string'
  )
}

export function connectErrorMessage(err: unknown, t: (key: string) => string): string {
  if (!isAppErrorPayload(err)) {
    return t('gcal.connectFailed')
  }
  // Validation messages from the OAuth path are dotted keys like
  // `oauth.timeout` or `oauth.exchange_failed: 400 Bad Request`. Match
  // the leading key; anything else collapses to the generic notify.
  const msg = err.message
  if (msg.startsWith('oauth.timeout')) return t('gcal.connect.timeout')
  if (msg.startsWith('oauth.invalid_state')) return t('gcal.connect.invalidState')
  if (msg.startsWith('oauth.exchange_failed')) return t('gcal.connect.exchangeFailed')
  if (msg.startsWith('oauth.client_misconfigured') || msg.startsWith('oauth.open_browser_failed')) {
    return t('gcal.connect.clientMisconfigured')
  }
  return t('gcal.connectFailed')
}
