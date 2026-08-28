import { logger } from '@/lib/logger'

/**
 * Ensure the OS notification permission is granted.
 *
 * On Android 13+ a runtime `POST_NOTIFICATIONS` grant is required before
 * `commands.notifyTask` (`@/lib/bindings` — the lib/tauri/notifications
 * wrapper it used to be reached through was a dead wrapper, removed in
 * #4410, so that module name is deliberately left as prose: there is no
 * live path left to cite) can surface anything; on desktop the capability
 * grant is sufficient
 * and this resolves `true`
 * without prompting. The `@tauri-apps/plugin-notification` JS API is
 * imported dynamically so this module stays usable (and testable) in plain
 * web / test contexts where the plugin is unavailable — a failed import
 * resolves `false` rather than throwing.
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
