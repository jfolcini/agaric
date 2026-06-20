/**
 * useDeepLinkRouter — listens for routed deep-link events from the Rust
 * `deeplink::register_deeplink_handlers` router and translates
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
 * On Android the same routes arrive as App Links
 * (`https://agaric.app/o/<host>/<id>`); both shapes are handled identically
 * on the launch path by `dispatchLaunchUrl` (#741).
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

import { useEffect } from 'react'

import { logger } from '@/lib/logger'
import { getBlock, getCurrentDeepLink } from '@/lib/tauri'
import { SETTINGS_ACTIVE_TAB_KEY } from '@/lib/url-state'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

import { useTauriEventListener } from './useTauriEventListener'

/** Backend `deeplink:navigate-to-block` / `deeplink:navigate-to-page` payload. */
export interface BlockNavigatePayload {
  id: string
}

/** Backend `deeplink:open-settings` payload. */
export interface OpenSettingsPayload {
  tab: string
}

/** The localStorage key the Settings panel reads on mount so a deep link
 *  selects the right tab on first render. #754 — canonical definition
 *  lives in `@/lib/url-state`; re-exported here for existing consumers. */
export { SETTINGS_ACTIVE_TAB_KEY } from '@/lib/url-state'

/** Outbound event name constants — must mirror
 *  `src-tauri/src/deeplink/mod.rs`. */
export const DEEPLINK_EVENT_NAVIGATE_TO_BLOCK = 'deeplink:navigate-to-block'
export const DEEPLINK_EVENT_NAVIGATE_TO_PAGE = 'deeplink:navigate-to-page'
export const DEEPLINK_EVENT_OPEN_SETTINGS = 'deeplink:open-settings'

/** HTTPS authority registered for Android App Links — must mirror
 *  `APP_LINK_HOST` in `src-tauri/src/deeplink/mod.rs` and the
 *  `plugins.deep-link.mobile[].host` entry in `tauri.conf.json`. */
export const APP_LINK_HOST = 'agaric.app'
/** First path segment of an Android App Link (`https://agaric.app/o/…`) —
 *  mirrors `APP_LINK_PREFIX` in `src-tauri/src/deeplink/mod.rs` and the
 *  `plugins.deep-link.mobile[].pathPrefix` `"/o/"` entry. */
export const APP_LINK_PREFIX = 'o'

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

/** Distinguishes the two navigate events — a BLOCK id needs containing-
 *  page resolution before it can be fed to `navigateToPage`. */
export type NavigateTargetKind = 'block' | 'page'

/**
 * #734 — upper bound on the parent-chain walk when resolving a block's
 * containing page. Real trees are a handful of levels deep; the cap only
 * exists so a corrupt / cyclic `parent_id` chain can't loop the router
 * forever.
 */
const MAX_ANCESTOR_HOPS = 100

/** Forward to the tabs store, logging (never throwing) on failure. */
function safeNavigateToPage(
  eventName: string,
  pageId: string,
  title: string,
  blockId?: string,
): void {
  try {
    if (blockId === undefined) {
      useTabsStore.getState().navigateToPage(pageId, title)
    } else {
      useTabsStore.getState().navigateToPage(pageId, title, blockId)
    }
  } catch (err) {
    logger.warn('deeplink', `${eventName} navigateToPage threw`, undefined, err)
  }
}

/**
 * Apply a `deeplink:navigate-to-block` / `deeplink:navigate-to-page` event.
 *
 * #734 — both events used to share a blind `navigateToPage(id, '')`:
 * a BLOCK link opened the block's own ULID as if it were a page (no
 * containing-page resolution, no scroll-and-highlight), and a DATE-titled
 * page bypassed the journal redirect because `tabs.ts` keys it on the
 * TITLE — which was always `''` here. The handler now resolves the
 * target through `getBlock`:
 *
 *   - `kind === 'page'` → fetch the page's title so the journal redirect
 * And the tab label work like every in-app navigation.
 *   - `kind === 'block'` → resolve the containing page via the
 *     denormalized `blocks.page_id` column (maintained by the
 *     materializer: `page_id_self_for_pages` CHECK for pages, cross-page
 *     moves reparent it — the same column AlertSection / AgendaResults
 *     already navigate through) and navigate THERE, passing the original
 *     block id as the third arg so the editor scrolls to and highlights
 *     it (same contract as in-app `[[ULID]]` links). Rows without a
 *     `page_id` (orphaned subtrees / legacy data) fall back to walking
 *     `parent_id` to the nearest `page`-typed ancestor.
 *
 * IPC failures degrade to the legacy `navigateToPage(id, '')` so a
 * deep link is never silently dropped. Never rejects.
 */
export async function handleNavigatePayload(
  payload: unknown,
  eventName: string,
  kind: NavigateTargetKind,
): Promise<void> {
  if (!isBlockNavigatePayload(payload)) {
    logger.warn('deeplink', `${eventName} payload missing valid id`, {
      payload: JSON.stringify(payload),
    })
    return
  }
  try {
    let block = await getBlock(payload.id)
    if (kind === 'page' || block.block_type === 'page') {
      safeNavigateToPage(eventName, payload.id, block.content ?? '')
      return
    }
    // BLOCK target — prefer the denormalized `page_id` column: ONE extra
    // IPC fetch (for the page title) instead of an O(depth) sequential
    // parent walk, and immune to a soft-deleted intermediate ancestor
    // killing the chain mid-walk.
    if (block.page_id !== null && block.page_id !== payload.id) {
      const page = await getBlock(block.page_id)
      safeNavigateToPage(eventName, page.id, page.content ?? '', payload.id)
      return
    }
    // No usable `page_id` (orphaned subtree / legacy rows) — walk the
    // parent chain. Stop at the first `page`-typed ancestor; if the chain
    // ends without one, fall back to the topmost ancestor reached so the
    // user still lands as close to the block as possible.
    for (let hop = 0; block.parent_id !== null && hop < MAX_ANCESTOR_HOPS; hop++) {
      block = await getBlock(block.parent_id)
      if (block.block_type === 'page') {
        safeNavigateToPage(eventName, block.id, block.content ?? '', payload.id)
        return
      }
    }
    safeNavigateToPage(
      eventName,
      block.id,
      block.content ?? '',
      block.id === payload.id ? undefined : payload.id,
    )
  } catch (err) {
    // Target fetch failed (unknown id, IPC down, …) — preserve the
    // pre-#734 behaviour so the link still opens SOMETHING the views
    // can re-resolve on mount.
    logger.warn('deeplink', `${eventName} target resolution failed`, { id: payload.id }, err)
    safeNavigateToPage(eventName, payload.id, '')
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
    // #734 — ALSO write the store handoff slot SettingsView subscribes to
    // while mounted. The localStorage write above only matters on a fresh
    // mount; when Settings is already the current view (or the panel
    // mounts with a stale `?settings=` URL param that outranks
    // localStorage in `readActiveTab`), the slot is what actually flips
    // the tab. Validation lives in SettingsView — unknown names are
    // dropped there.
    useNavigationStore.getState().setPendingSettingsTab(payload.tab)
    useNavigationStore.getState().setView('settings')
  } catch (err) {
    logger.warn('deeplink', 'setView("settings") threw', undefined, err)
  }
}

/**
 * Mount once at the app root.  Registers three Tauri event listeners
 * that translate routed deep-link events into navigation-store /
 * settings-tab side effects.  Cleans up listeners on unmount.
 *
 * Listener lifecycle (`listen()` → `unlisten()` + unmount
 * race) lives in `useTauriEventListener`; this hook owns the per-event
 * payload-validation + dispatch wrappers, the launch-URL backfill, and
 * the Tauri-only gate (`enabled`).
 */
export function useDeepLinkRouter(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useTauriEventListener<unknown>(
    DEEPLINK_EVENT_NAVIGATE_TO_BLOCK,
    (event) => {
      try {
        // Async (block→page resolution) but never rejects — see handler.
        void handleNavigatePayload(event.payload, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK, 'block')
      } catch (err) {
        logger.error(
          'deeplink',
          `${DEEPLINK_EVENT_NAVIGATE_TO_BLOCK} handler threw`,
          undefined,
          err,
        )
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'deeplink',
          `Failed to listen to ${DEEPLINK_EVENT_NAVIGATE_TO_BLOCK}`,
          undefined,
          err,
        )
      },
    },
  )

  useTauriEventListener<unknown>(
    DEEPLINK_EVENT_NAVIGATE_TO_PAGE,
    (event) => {
      try {
        void handleNavigatePayload(event.payload, DEEPLINK_EVENT_NAVIGATE_TO_PAGE, 'page')
      } catch (err) {
        logger.error('deeplink', `${DEEPLINK_EVENT_NAVIGATE_TO_PAGE} handler threw`, undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'deeplink',
          `Failed to listen to ${DEEPLINK_EVENT_NAVIGATE_TO_PAGE}`,
          undefined,
          err,
        )
      },
    },
  )

  useTauriEventListener<unknown>(
    DEEPLINK_EVENT_OPEN_SETTINGS,
    (event) => {
      try {
        handleOpenSettingsPayload(event.payload)
      } catch (err) {
        logger.error('deeplink', `${DEEPLINK_EVENT_OPEN_SETTINGS} handler threw`, undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'deeplink',
          `Failed to listen to ${DEEPLINK_EVENT_OPEN_SETTINGS}`,
          undefined,
          err,
        )
      },
    },
  )

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

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
    }
  }, [enabled])
}

/**
 * Parse a launch-time deep-link URL and dispatch through the same handlers
 * as live events.  Mirrors the Rust `parse_deep_link` / `dispatch_url` pair
 * exactly so behaviour stays consistent across the two paths and both URL
 * shapes:
 *
 *   - `agaric://<host>/<id>`              — custom scheme (desktop launch args)
 *   - `https://agaric.app/o/<host>/<id>`  — Android App Link (cold-start, #741)
 *
 * Without the `https` arm an Android App Link that cold-starts the app would
 * be captured by `getCurrent()` and silently dropped here, re-creating the
 * #741 no-op on the launch path even though live events route fine.  Logs at
 * `warn` level on every rejection.
 */
export function dispatchLaunchUrl(raw: string): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (err) {
    logger.warn('deeplink', 'launch URL did not parse', { url: raw }, err)
    return
  }

  // Normalise the two accepted shapes into (host, identifier).  `URL` strips
  // the leading `/` from `pathname`; split and keep only non-empty segments
  // so a trailing/doubled slash doesn't shift the mapping.
  let host: string
  let identifier: string | undefined
  if (parsed.protocol === 'agaric:') {
    host = parsed.hostname.toLowerCase()
    // First non-empty segment is the identifier (matches the Rust router).
    identifier = parsed.pathname.split('/').find((s) => s.length > 0)
  } else if (parsed.protocol === 'https:') {
    // Only `https://agaric.app/o/<host>/<id>` is a deep link; any other
    // https authority is an ordinary web URL and must not be routed.
    if (parsed.hostname.toLowerCase() !== APP_LINK_HOST) {
      logger.warn('deeplink', 'launch URL has wrong scheme', {
        url: raw,
        protocol: parsed.protocol,
      })
      return
    }
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
    if (segments[0] !== APP_LINK_PREFIX) {
      logger.warn('deeplink', 'launch URL has unknown host', {
        url: raw,
        host: segments[0] ?? '',
      })
      return
    }
    host = (segments[1] ?? '').toLowerCase()
    identifier = segments[2]
  } else {
    logger.warn('deeplink', 'launch URL has wrong scheme', {
      url: raw,
      protocol: parsed.protocol,
    })
    return
  }

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
    case 'block': {
      void handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK, 'block')
      return
    }
    case 'page': {
      void handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_PAGE, 'page')
      return
    }
    case 'settings': {
      // Settings tab names are not ULIDs — pass through as-is.
      handleOpenSettingsPayload({ tab: identifier })
      return
    }
    default: {
      logger.warn('deeplink', 'launch URL has unknown host', { url: raw, host })
    }
  }
}
