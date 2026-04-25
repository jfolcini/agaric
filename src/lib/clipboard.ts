import { logger } from './logger'

/**
 * Write text to the system clipboard.
 *
 * Uses Tauri clipboard plugin when available (desktop + Android),
 * falls back to navigator.clipboard.writeText for browser dev mode.
 *
 * If the Tauri plugin import or call fails (e.g., running in a plain
 * browser without `__TAURI_INTERNALS__`), we log a warning and degrade
 * to the Web Clipboard API. Any rejection from the navigator path is
 * propagated to the caller so existing UI can surface a "copy failed"
 * toast unchanged.
 */
export async function writeText(text: string): Promise<void> {
  try {
    const { writeText: pluginWriteText } = await import('@tauri-apps/plugin-clipboard-manager')
    await pluginWriteText(text)
  } catch (err) {
    logger.warn('clipboard', 'plugin unavailable, falling back to navigator', undefined, err)
    await navigator.clipboard.writeText(text)
  }
}
