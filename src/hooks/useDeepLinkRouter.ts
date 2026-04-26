/**
 * useDeepLinkRouter — listens for routed deep-link events from the Rust
 * `deeplink::register_deeplink_handlers` router (FEAT-10) and translates
 * them into navigation-store / settings-tab actions.
 *
 * Backend contract (`src-tauri/src/deeplink/mod.rs`):
 *   - `agaric://block/<ULID>` → emits `deeplink:navigate-to-block`
 *     with `{ id: <canonical uppercase ULID> }`.
 *   - `agaric://page/<ULID>` → emits `deeplink:navigate-to-page`
 *     with `{ id: <canonical uppercase ULID> }`.
 *   - `agaric://settings/<tab>` → emits `deeplink:open-settings`
 *     with `{ tab: <tab name> }`.
 *
 * The Rust router validates ULIDs (uppercase Crockford base32) and
 * non-empty tab names before emitting; the defensive checks here are
 * defense-in-depth so a malformed payload from a future source can't
 * crash the navigation store.  Logs `logger.warn` on every rejection.
 *
 * On mount the hook also calls `getCurrentDeepLink()` and re-emits the
 * URL through the same dispatch path: on Linux / Windows the OS delivers
 * launch-time URLs as CLI args, which the Rust plugin parses BEFORE the
 * React listener is registered.  Without this backfill, the very first
 * deep-link of a session would be silently dropped.  The launch URL
 * passes through Rust parsing — `getCurrent()` returns the raw URL
 * string the plugin captured at startup, so we route it through the
 * same client-side parser used for live updates.
 *
 * No-op outside Tauri (browser dev sessions without
 * `__TAURI_INTERNALS__`).  Mount once in `App.tsx`.
 */

import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { logger } from '@/lib/logger'
import { getCurrentDeepLink } from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'

/** Backend `deeplink:navigate-to-block` / `deeplink:navigate-to-page` payload. */
export interface BlockNavigatePayload {
  id: string
}

/** Backend `deeplink:open-settings` payload. */
export interface OpenSettingsPayload {
  tab: string
}

/** Mirrors `SettingsView.ACTIVE_TAB_KEY` — the localStorage key the
 *  panel reads on mount so a deep link selects the right tab on first
 *  render.  Kept in sync with `src/components/SettingsView.tsx`. */
export const SETTINGS_ACTIVE_TAB_KEY = 'agaric-settings-active-tab'

/** Outbound event name constants — must mirror
 *  `src-tauri/src/deeplink/mod.rs`. */
export const DEEPLINK_EVENT_NAVIGATE_TO_BLOCK = 'deeplink:navigate-to-block'
export const DEEPLINK_EVENT_NAVIGATE_TO_PAGE = 'deeplink:navigate-to-page'
export const DEEPLINK_EVENT_OPEN_SETTINGS = 'deeplink:open-settings'

/** Defensive shape check for `BlockNavigatePayload`. */
function isBlockNavigatePayload(p: unknown): p is BlockNavigatePayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    'id' in p &&
    typeof (p as { id: unknown }).id === 'string' &&
    (p as { id: string }).id.length > 0
  )
}

/** Defensive shape check for `OpenSettingsPayload`. */
function isOpenSettingsPayload(p: unknown): p is OpenSettingsPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    'tab' in p &&
    typeof (p as { tab: unknown }).tab === 'string' &&
    (p as { tab: string }).tab.length > 0
  )
}

/** Apply a `deeplink:navigate-to-block` / `deeplink:navigate-to-page` event. */
export function handleNavigatePayload(payload: unknown, eventName: string): void {
  if (!isBlockNavigatePayload(payload)) {
    logger.warn('deeplink', `${eventName} payload missing valid id`, {
      payload: JSON.stringify(payload),
    })
    return
  }
  // The backend already validates the ULID via `BlockId::from_string`;
  // the navigation store uses ULIDs for both block and page IDs (every
  // page IS a block in the op log).  The router passes through to
  // `navigateToPage(pageId, title, blockId?)` — we don't have a title
  // at the URL-routing layer, so we pass an empty string and rely on
  // the resolve cache to populate the breadcrumb label after the
  // navigation lands.  The page-editor view re-resolves the title on
  // mount.
  try {
    useNavigationStore.getState().navigateToPage(payload.id, '')
  } catch (err) {
    logger.warn('deeplink', `${eventName} navigateToPage threw`, undefined, err)
  }
}

/** Apply a `deeplink:open-settings` event. */
export function handleOpenSettingsPayload(payload: unknown): void {
  if (!isOpenSettingsPayload(payload)) {
    logger.warn('deeplink', 'deeplink:open-settings payload missing valid tab', {
      payload: JSON.stringify(payload),
    })
    return
  }
  // Persist the tab selection BEFORE switching views so SettingsView's
  // initial-state reader (`readActiveTab` -> localStorage) picks up the
  // requested tab on first render.  Tab-name validation lives in
  // `readActiveTab` — an unknown tab safely falls back to `'general'`.
  try {
    localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, payload.tab)
  } catch (err) {
    logger.warn('deeplink', 'localStorage setItem failed for settings tab', undefined, err)
    // Not fatal — the view still mounts on `'general'`.
  }
  try {
    useNavigationStore.getState().setView('settings')
  } catch (err) {
    logger.warn('deeplink', 'setView("settings") threw', undefined, err)
  }
}

/**
 * Mount once at the app root.  Registers three Tauri event listeners
 * that translate routed deep-link events into navigation-store /
 * settings-tab side effects.  Cleans up listeners on unmount.
 */
export function useDeepLinkRouter(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return

    const cleanups: Array<() => void> = []
    let cancelled = false

    function attachListener(eventName: string, handler: (payload: unknown) => void) {
      listen<unknown>(eventName, (event) => {
        try {
          handler(event.payload)
        } catch (err) {
          logger.error('deeplink', `${eventName} handler threw`, undefined, err)
        }
      })
        .then((unlisten) => {
          if (cancelled) unlisten()
          else cleanups.push(unlisten)
        })
        .catch((err: unknown) => {
          logger.warn('deeplink', `Failed to listen to ${eventName}`, undefined, err)
        })
    }

    attachListener(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK, (payload) =>
      handleNavigatePayload(payload, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK),
    )
    attachListener(DEEPLINK_EVENT_NAVIGATE_TO_PAGE, (payload) =>
      handleNavigatePayload(payload, DEEPLINK_EVENT_NAVIGATE_TO_PAGE),
    )
    attachListener(DEEPLINK_EVENT_OPEN_SETTINGS, (payload) => handleOpenSettingsPayload(payload))

    // Backfill: read the launch URL the OS used to open Agaric, if any.
    // The router on the Rust side already emits `deep-link://new-url`
    // during plugin setup; on platforms where the listener races with
    // that emission the event is lost, so we ask the plugin for the
    // current URL and dispatch through the same code path.  Routing
    // happens here on the frontend by parsing `agaric://<host>/<id>`
    // — this avoids a second IPC hop just to re-emit the typed event.
    getCurrentDeepLink()
      .then((urls) => {
        if (cancelled || !urls || urls.length === 0) return
        for (const url of urls) {
          dispatchLaunchUrl(url)
        }
      })
      .catch((err: unknown) => {
        logger.warn('deeplink', 'getCurrent() rejected', undefined, err)
      })

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [])
}

/**
 * Parse a launch-time `agaric://…` URL and dispatch through the same
 * handlers as live events.  Mirrors the Rust `parse_deep_link` /
 * `dispatch_url` pair exactly so behaviour stays consistent across the
 * two paths.  Logs at `warn` level on every rejection.
 */
export function dispatchLaunchUrl(raw: string): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (err) {
    logger.warn('deeplink', 'launch URL did not parse', { url: raw }, err)
    return
  }
  if (parsed.protocol !== 'agaric:') {
    logger.warn('deeplink', 'launch URL has wrong scheme', {
      url: raw,
      protocol: parsed.protocol,
    })
    return
  }
  const host = parsed.host.toLowerCase()
  // `URL` strips the leading `/` from `pathname`; split and keep only
  // non-empty segments.  Use the first non-empty segment as the
  // identifier (matches the Rust router's behaviour).
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  const identifier = segments[0]
  if (identifier == null || identifier.length === 0) {
    logger.warn('deeplink', 'launch URL missing identifier', { url: raw, host })
    return
  }
  // Mirror the Rust router (deeplink/mod.rs `parse_block_or_page`) which
  // normalises ULID identifiers to uppercase before validation. Without
  // this, an OS-delivered lowercase ULID would skip the case-sensitive
  // canonical form that blake3-hash determinism depends on.
  const normalisedId = identifier.toUpperCase()
  switch (host) {
    case 'block':
      handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      return
    case 'page':
      handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
      return
    case 'settings':
      // Settings tab names are not ULIDs — pass through as-is.
      handleOpenSettingsPayload({ tab: identifier })
      return
    default:
      logger.warn('deeplink', 'launch URL has unknown host', { url: raw, host })
  }
}
