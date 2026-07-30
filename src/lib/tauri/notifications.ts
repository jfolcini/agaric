import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { TaskNotification } from '@/lib/bindings'

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
 * `POST_NOTIFICATIONS` runtime grant (see `ensureNotificationPermission` in
 * `@/lib/platform/notifications`).
 */
export async function notifyTask(notification: TaskNotification): Promise<void> {
  // The command resolves `Result<(), AppError>` (bindings type `null`);
  // discard the null payload and surface only success / rejection.
  unwrap(await commands.notifyTask(notification))
}
