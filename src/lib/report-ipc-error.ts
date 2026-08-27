import type { TFunction } from 'i18next'

import { isValidation } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

/**
 * Unified IPC error reporting helper.
 *
 * Logs a structured error (with stack, cause chain, and context) AND shows a
 * user-visible toast translated via i18n. Replaces the `catch { notify.error(...) }`
 * Pattern that previously lacked any logging —.
 *
 * @param module    - Logger module name (typically the component / hook name).
 * @param messageKey - i18n key whose translation is shown to the user.
 * @param err       - The thrown value from the failed IPC call.
 * @param t         - The i18n `t` function from `useTranslation()`.
 * @param context   - Optional structured context for the log line (block ids, etc).
 */
export function reportIpcError(
  module: string,
  messageKey: string,
  err: unknown,
  t: TFunction,
  context?: Record<string, unknown>,
): void {
  logger.error(module, `${messageKey} (IPC error)`, context, err)
  notify.error(t(messageKey))
}

/**
 * {@link reportIpcError} for rejections whose REASON is the useful part.
 *
 * A `validation` `AppError` is a business-rule refusal the backend wrote for
 * a human: it names the thing that is wrong and what to do about it, and
 * `sanitize_internal_error` passes it to the frontend verbatim (only
 * `database` / `io` / `internal` kinds are replaced with a correlation id).
 * Every other kind is either not actionable by the user or already
 * correlation-id'd, so those keep the localized generic toast.
 *
 * #4399 is the case that motivated it: `create_property_def` now refuses to
 * declare a global type over a key whose existing values contradict it, and
 * the refusal carries the key, how many values are in the way and what shape
 * they are stored in. A bare "Failed to create property definition" leaves
 * the user with a dialog that will not close and nothing to act on — the
 * declaration is vault-wide, so the offending values are usually on blocks
 * the user is not looking at.
 *
 * Deliberately narrower than `err instanceof Error ? err.message : …`, which
 * is how `PagePropertyTable` used to spell this and which finds precisely the
 * wrong half. `typedError` (`bindings.ts`) RETHROWS a real `Error` — a
 * transport-level failure whose text was never written for a user — and
 * returns everything else as data, which `unwrap` throws as the deserialized
 * `AppError` OBJECT. So `instanceof Error` is true only for the failures
 * worth hiding behind a localized toast, and false for every backend refusal.
 * `validation` is the one kind that is both human-authored and unsanitized;
 * a bare string, a `pool_busy`, an `internal` whose text is only a
 * correlation id all fall back to `messageKey`.
 */
export function reportIpcErrorWithReason(
  module: string,
  messageKey: string,
  err: unknown,
  t: TFunction,
  context?: Record<string, unknown>,
): void {
  logger.error(module, `${messageKey} (IPC error)`, context, err)
  const reason = isValidation(err) && err.message.trim() !== '' ? err.message : null
  notify.error(reason ?? t(messageKey))
}
