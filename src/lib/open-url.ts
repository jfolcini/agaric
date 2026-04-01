/**
 * Open a URL in the system browser.
 *
 * Uses Tauri shell plugin when available (desktop + Android),
 * falls back to window.open() for browser dev mode.
 */
export async function openUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
