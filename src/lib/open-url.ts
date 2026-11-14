import { logger } from '@/lib/logger'
import { isAndroid } from '@/lib/platform'
import { isAllowedUrl } from '@/lib/url-validation'

/**
 * Opens `url` in the system browser. Returns `true` if the browser
 * actually opened (the Tauri opener succeeded OR `window.open` returned a
 * non-null handle). Returns `false` when both paths failed (Tauri
 * opener errored AND `window.open` was popup-blocked / returned
 * `null`), when the opener errored in the Android app, which has no
 * `window.open` fallback, OR when `url` carries a blocked scheme (see
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
    const opener = await import('@tauri-apps/plugin-opener')
    await opener.openUrl(url)
    return true
  } catch (err) {
    // The Android app has one web view, so `window.open` would load the site
    // over the app, where the back gesture cannot leave it (#6774).
    if (isAndroid() && '__TAURI_INTERNALS__' in window) {
      logger.warn('open-url', 'the opener refused the link', { url }, err)
      return false
    }
    const handle = window.open(url, '_blank', 'noopener,noreferrer')
    return Boolean(handle)
  }
}
