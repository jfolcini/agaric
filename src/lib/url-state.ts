/**
 * Tiny URL query-param helpers for view state that should be deep-linkable.
 *
 * Agaric does not use a router (Tauri WebView, no react-router). The
 * Settings panel however benefits from `?settings=keyboard` style links
 * for support / sharing / bookmarking purposes (UX-276). These helpers
 * implement the smallest viable surface — read + write a single
 * `settings` query param via `history.replaceState`, never push.
 *
 * Replace-only is deliberate: clicking through Settings tabs should not
 * pollute the back/forward stack with N entries the user has to bounce
 * through to escape the panel.
 *
 * Both helpers are total — corrupted URLs, missing `window`, or thrown
 * `URL` parsing errors degrade to "no value" / "no-op" with a warn log.
 */

import { logger } from './logger'

const SETTINGS_PARAM = 'settings'

/**
 * Read the `settings` query param from the current URL and validate it
 * against the caller-supplied `allowed` list (typically `TAB_IDS`).
 * Returns the value if present and known, otherwise `null`.
 *
 * Never throws — corrupted query strings degrade to `null`.
 */
export function getSettingsTabFromUrl(allowed: readonly string[]): string | null {
  try {
    if (typeof window === 'undefined') return null
    const url = new URL(window.location.href)
    const value = url.searchParams.get(SETTINGS_PARAM)
    if (value === null) return null
    return allowed.includes(value) ? value : null
  } catch (err) {
    logger.warn('url-state', 'failed to parse settings query param', undefined, err)
    return null
  }
}

/**
 * Write (or clear) the `settings` query param on the current URL via
 * `history.replaceState`. Pass `null` to remove the param entirely
 * (e.g. when SettingsView unmounts so the URL no longer claims the
 * user is on a specific Settings tab).
 *
 * Other query params on the URL are preserved.
 */
export function setSettingsTabInUrl(tab: string | null): void {
  try {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (tab === null) {
      if (!url.searchParams.has(SETTINGS_PARAM)) return
      url.searchParams.delete(SETTINGS_PARAM)
    } else {
      if (url.searchParams.get(SETTINGS_PARAM) === tab) return
      url.searchParams.set(SETTINGS_PARAM, tab)
    }
    const next = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState(window.history.state, '', next)
  } catch (err) {
    logger.warn('url-state', 'failed to update settings query param', { tab }, err)
  }
}
