/**
 * Opens `url` in the system browser. Returns `true` if the browser
 * actually opened (Tauri shell succeeded OR `window.open` returned a
 * non-null handle). Returns `false` when both paths failed (Tauri
 * shell errored AND `window.open` was popup-blocked / returned
 * `null`). Never rejects — callers can gate UI feedback on the
 * boolean without try/catch.
 *
 * Previously returned `Promise<void>`; the BugReportDialog
 * success toast now gates on the returned boolean to avoid claiming
 * "issue opened" when neither path actually opened a tab.
 */
export async function openUrl(url: string): Promise<boolean> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return true
  } catch {
    const handle = window.open(url, '_blank', 'noopener,noreferrer')
    return Boolean(handle)
  }
}
