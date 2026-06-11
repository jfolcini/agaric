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

/**
 * Read text from the system clipboard.
 *
 * Mirror of {@link writeText}: prefers the Tauri clipboard plugin (desktop +
 * Android) and degrades to `navigator.clipboard.readText` in browser dev mode.
 * Any rejection from the navigator path is propagated to the caller (block
 * paste surfaces a "paste failed" notice rather than silently doing nothing).
 */
export async function readText(): Promise<string> {
  try {
    const { readText: pluginReadText } = await import('@tauri-apps/plugin-clipboard-manager')
    return await pluginReadText()
  } catch (err) {
    logger.warn('clipboard', 'plugin unavailable, falling back to navigator', undefined, err)
    return await navigator.clipboard.readText()
  }
}
