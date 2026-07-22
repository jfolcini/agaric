import { isAllowedUrl } from '@/lib/url-validation'

/**
 * Opens `url` in the system browser. Returns `true` if the browser
 * actually opened (Tauri shell succeeded OR `window.open` returned a
 * non-null handle). Returns `false` when both paths failed (Tauri
 * shell errored AND `window.open` was popup-blocked / returned
 * `null`) OR when `url` carries a blocked scheme (see
 * `isAllowedUrl`). Never rejects — callers can gate UI feedback on the
 * boolean without try/catch.
 *
 * Previously returned `Promise<void>`; the BugReportDialog
 * success toast now gates on the returned boolean to avoid claiming
 * "issue opened" when neither path actually opened a tab.
 *
 * #2960 — this is the single choke point every caller (context menu,
 * long-press "Open link", editor click sinks, dialogs) funnels through
 * before handing a URL to the OS shell / a new tab. Individual call
 * sites (e.g. the static render sink in `RichContentRenderer/marks/text.tsx`,
 * the `ExternalLink` TipTap extension) may ALSO re-check `isAllowedUrl`
 * closer to the user gesture so a disallowed link never even renders as
 * clickable — but this check makes the guard unconditional so no future
 * caller can accidentally skip it.
 */
export async function openUrl(url: string): Promise<boolean> {
  if (!isAllowedUrl(url)) return false
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return true
  } catch {
    const handle = window.open(url, '_blank', 'noopener,noreferrer')
    return Boolean(handle)
  }
}
