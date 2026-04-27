import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { logger } from './logger'

/**
 * Unified IPC error reporting helper.
 *
 * Logs a structured error (with stack, cause chain, and context) AND shows a
 * user-visible toast translated via i18n. Replaces the `catch { toast.error(...) }`
 * pattern that previously lacked any logging — see MAINT-115.
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
  toast.error(t(messageKey))
}
