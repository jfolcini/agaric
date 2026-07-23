import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { TaskNotification } from '@/lib/bindings'
import { logger } from '@/lib/logger'

/**
 * Fire a native OS notification for a due / scheduled task.
 *
 * Thin wrapper over the `notify_task` IPC command. `title` is required and
 * must be non-empty (the backend rejects a blank title with a validation
 * error); `body` and `blockId` are optional. `blockId` is carried only for
 * caller-side dedupe correlation — it is never shown to the OS.
 *
 * Desktop fires immediately once the `notification:default` capability is
 * granted. On Android 13+ the caller must first obtain the
 * `POST_NOTIFICATIONS` runtime grant (see {@link ensureNotificationPermission}).
 */
export async function notifyTask(notification: TaskNotification): Promise<void> {
  // The command resolves `Result<(), AppError>` (bindings type `null`);
  // discard the null payload and surface only success / rejection.
  unwrap(await commands.notifyTask(notification))
}

/**
 * Ensure the OS notification permission is granted.
 *
 * On Android 13+ a runtime `POST_NOTIFICATIONS` grant is required before
 * {@link notifyTask} can surface anything; on desktop the capability grant
 * is sufficient and this resolves `true` without prompting. The
 * `@tauri-apps/plugin-notification` JS API is imported dynamically so this
 * module stays usable (and testable) in plain web / test contexts where the
 * plugin is unavailable — a failed import resolves `false` rather than
 * throwing.
 *
 * @returns `true` if notifications may be shown, `false` if denied or the
 *   plugin is unavailable.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission } =
      await import('@tauri-apps/plugin-notification')
    if (await isPermissionGranted()) {
      return true
    }
    const permission = await requestPermission()
    return permission === 'granted'
  } catch (error) {
    logger.warn('tauri', 'notification plugin unavailable for permission check', undefined, error)
    return false
  }
}
