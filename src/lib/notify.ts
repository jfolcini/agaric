/**
 * `notify` — single chokepoint for user-facing toast notifications.
 *
 * Before Phase 3a (design-system-maintainability), every component imported
 * `toast` directly from `sonner` and called `toast.success(...)` /
 * `toast.error(...)` inline at the call site. ~86 production files, ~275
 * call sites. That made it impossible to change the underlying provider,
 * enforce i18n on the message string, or dedup repeated errors without
 * touching every consumer.
 *
 * The wrapper is intentionally a thin pass-through to sonner's API. Each
 * method's signature mirrors sonner's so the codemod from
 * `toast.METHOD(args)` → `notify.METHOD(args)` is mechanical, and the
 * underlying sonner mock in `src/__tests__/mocks/sonner.ts` keeps
 * observing every call (existing `vi.mocked(toast.error).toHaveBeenCalledWith(...)`
 * assertions still match because the wrapper forwards args with the
 * same arity — `opts` is spread, never explicitly passed as
 * `undefined`).
 *
 * Future cross-cutting concerns (i18n fallback, dedup, provider swap,
 * durations) land here in one place. A prek hook bans `from 'sonner'`
 * outside this file + the `Toaster` UI primitive + test scaffolding so
 * the chokepoint stays durable.
 */

import type { ExternalToast } from 'sonner'
import { toast } from 'sonner'

/** Re-export sonner's option shape so callers don't need to import it from sonner directly. */
export type NotifyOptions = ExternalToast

/** Message accepted by `notify` family methods. Strings only (i18n callers must call `t()` first). */
type NotifyMessage = string | number

/** Rest-arg shape that forwards `opts` only when the caller actually supplied it. */
type OptionalOpts = [ExternalToast?]

/**
 * `notify.error` accepts either a string or an `Error`. When given an
 * Error, the `.message` is shown and the original Error is logged via
 * `console.error` for debugging. Anything else (number, object) is
 * coerced via `String(...)` so the toast always shows something
 * actionable. The opts arg is forwarded to sonner unchanged.
 */
function notifyError(
  messageOrError: string | number | Error,
  ...rest: OptionalOpts
): string | number {
  if (messageOrError instanceof Error) {
    console.error(messageOrError)
    return toast.error(messageOrError.message, ...rest)
  }
  return toast.error(String(messageOrError), ...rest)
}

/** Default callable: `notify('plain message', opts?)` mirrors `toast('plain message', opts?)`. */
function notifyDefault(message: NotifyMessage, ...rest: OptionalOpts): string | number {
  return toast(String(message), ...rest)
}

/**
 * `notify.retry(message, onRetry, opts?)` — standard helper for the
 * "error with a Retry action" pattern (sync loops, network blips,
 * upload retries). Wraps `notify.error` with an `action` shaped the
 * same way across every call site:
 *
 *   notify.retry('Sync failed', () => syncNow())
 *   notify.retry(err, () => syncNow(), { id: 'sync-retry' })
 *
 * The `id` is auto-set to `'retry'` when the caller omits one so
 * repeated identical errors collapse into a single toast (sonner
 * dedupes by `id`). Pass an explicit `id` to scope dedup more
 * narrowly (e.g., one per failing endpoint).
 *
 * `label` defaults to `'Retry'`; pass `opts.action.label` to override
 * (callers can route through `t('common.retry')` etc.).
 */
function notifyRetry(
  messageOrError: string | number | Error,
  onRetry: () => void,
  opts?: Omit<ExternalToast, 'action'> & { action?: { label?: string } },
): string | number {
  const { action: actionOverride, id, ...rest } = opts ?? {}
  const label = actionOverride?.label ?? 'Retry'
  return methods.error(messageOrError, {
    id: id ?? 'retry',
    action: { label, onClick: onRetry },
    ...rest,
  })
}

interface NotifyMethods {
  success: (message: NotifyMessage, ...rest: OptionalOpts) => string | number
  error: typeof notifyError
  warning: (message: NotifyMessage, ...rest: OptionalOpts) => string | number
  info: (message: NotifyMessage, ...rest: OptionalOpts) => string | number
  message: (message: NotifyMessage, ...rest: OptionalOpts) => string | number
  loading: (message: NotifyMessage, ...rest: OptionalOpts) => string | number
  promise: typeof toast.promise
  custom: typeof toast.custom
  dismiss: typeof toast.dismiss
  /**
   * Convenience for the "error + Retry action" pattern. See `notifyRetry`
   * above for the full contract; opt out of auto-dedup by passing an
   * explicit `id`.
   */
  retry: typeof notifyRetry
}

// Lazy delegates for `promise` / `custom` / `dismiss` — per-test
// `vi.mock('sonner', ...)` overrides don't always include these
// methods, and capturing `.bind(toast)` at module load fails with
// "Cannot read properties of undefined". The lazy form reads from the
// live `toast` import every call, so partial mocks are tolerated.
//
// Deduplication note: sonner natively dedupes by the `id` field on
// `ExternalToast`. To collapse repeated errors (e.g., sync-loop noise)
// pass a stable `id` in the opts: `notify.error('Sync failed', { id:
// 'sync-error' })`. The `notify.retry(...)` helper below auto-sets a
// generic `id` so the common retry pattern dedupes by default.
const methods: NotifyMethods = {
  success: (message, ...rest) => toast.success(String(message), ...rest),
  error: notifyError,
  warning: (message, ...rest) => toast.warning(String(message), ...rest),
  info: (message, ...rest) => toast.info(String(message), ...rest),
  message: (message, ...rest) => toast.message(String(message), ...rest),
  loading: (message, ...rest) => toast.loading(String(message), ...rest),
  promise: (...args) => toast.promise(...args),
  custom: (...args) => toast.custom(...args),
  dismiss: (...args) => toast.dismiss(...args),
  retry: notifyRetry,
}

/**
 * Single import surface for toast notifications. Callable for the bare
 * `notify('text')` form; carries typed methods for the variant family.
 */
export const notify: typeof notifyDefault & NotifyMethods = Object.assign(notifyDefault, methods)
