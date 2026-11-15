import { logFrontend } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { PREFERENCES, readPreference } from '@/lib/preferences'

export type LatencyAction = 'enter-split' | 'enter-create' | 'merge'

/**
 * With debug mode on, one log line per Enter or merge (#6559): milliseconds
 * from the key to the block taking focus, and to the backend's answer. The
 * real-backend measurement (`e2e-tauri/enter-merge-latency.e2e.ts`) reads
 * these lines from the app's log; on a phone `adb logcat` shows them.
 */
export function logLatencySample(
  action: LatencyAction,
  startedAt: number,
  focusedAt: number,
  ok: boolean,
): void {
  if (!readPreference(PREFERENCES.debugMode)) return
  const answeredAt = performance.now()
  const message =
    `${action} focus_ms=${(focusedAt - startedAt).toFixed(1)} ` +
    `answered_ms=${(answeredAt - startedAt).toFixed(1)} ok=${ok}`
  logFrontend('info', 'latency', message).catch((error: unknown) => {
    logger.warn('latency', 'latency sample not logged', { action }, error)
  })
}
