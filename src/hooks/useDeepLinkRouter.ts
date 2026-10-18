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

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getCurrentDeepLink } from '@/lib/platform/deep-link'
import { PREFERENCES, writePreference } from '@/lib/preferences'
import { requireActiveScope } from '@/lib/space-scope'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

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

/**
 * #734 — upper bound on the parent-chain walk when resolving a block's
 * containing page. Real trees are a handful of levels deep; the cap only
 * exists so a corrupt / cyclic `parent_id` chain can't loop the router
 * forever.
 */
const MAX_ANCESTOR_HOPS = 100

/**
 * #5415 — the space `pageId` lives in, or `null` when no listed space holds
 * it (space-less row, or the IPC failed). A link carries no space, so each
 * known space is asked with its own active scope; `batchResolve` returns the
 * id only from the space that owns it.
 */
async function resolveSpaceOf(pageId: string): Promise<string | null> {
  const hits = await Promise.all(
    useSpaceStore.getState().availableSpaces.map(async (space) => {
      const rows = unwrap(await commands.batchResolve([pageId], requireActiveScope(space.id)))
      return rows.some((r) => r.id === pageId) ? space.id : null
    }),
  )
  return hits.find((id) => id !== null) ?? null
}

/**
 * Switch to the page's own space, then forward to the tabs store, logging
 * (never throwing) on failure. The switch happens BEFORE `navigateToPage`
 * because tabs are partitioned per space: navigating first would open the
 * page in the outgoing space's tab list, where its load is refused.
 */
async function safeNavigateToPage(
  eventName: string,
  pageId: string,
  title: string,
  blockId?: string,
): Promise<void> {
  try {
    const targetSpace = await resolveSpaceOf(pageId)
    const { currentSpaceId, setCurrentSpace } = useSpaceStore.getState()
    if (targetSpace === null) {
      logger.warn('deeplink', `${eventName} target space unresolved`, { pageId })
    } else if (targetSpace !== currentSpaceId) {
      setCurrentSpace(targetSpace)
    }
  } catch (err) {
    logger.warn('deeplink', `${eventName} target space resolution failed`, { pageId }, err)
  }
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
 * The row's `block_type` decides, not the link's kind: a link from an agent
 * or a hand edit can carry the wrong one (#5899).
 *
 *   - A `page` or `tag` row opens as itself, with its title so the journal
 *     redirect and the tab label work like every in-app navigation (#734).
 *   - A `content` row opens its containing page, found through the
 *     denormalized `blocks.page_id` column, or for rows without one
 *     (orphaned subtrees, legacy data) by walking `parent_id` to the nearest
 *     `page`-typed ancestor. The block id goes along as the third arg so the
 *     editor scrolls to and highlights it, as in-app `[[ULID]]` links do.
 *
 * A content block is never opened as a page: `PageEditor` would find it
 * childless and seed an empty child under it on every visit (#5899). So a
 * target that cannot be read, or a chain that ends without a page, navigates
 * nowhere and shows the same "Link target not found" toast as an in-app link
 * to a missing block. `get_block` is not space-scoped, so a failed
 * read means the row is gone, trashed, or the IPC is down: nothing a page
 * view could show. Never rejects.
 */
export async function handleNavigatePayload(payload: unknown, eventName: string): Promise<void> {
  if (!isBlockNavigatePayload(payload)) {
    logger.warn('deeplink', `${eventName} payload missing valid id`, {
      payload: JSON.stringify(payload),
    })
    return
  }
  try {
    let block = unwrap(await commands.getBlock(payload.id))
    if (block.block_type === 'page' || block.block_type === 'tag') {
      await safeNavigateToPage(eventName, payload.id, block.content ?? '')
      return
    }
    // Prefer the denormalized `page_id` column: ONE extra IPC fetch (for
    // the page title) instead of an O(depth) sequential parent walk, and
    // immune to a soft-deleted intermediate ancestor killing the chain
    // mid-walk.
    if (block.page_id !== null && block.page_id !== payload.id) {
      const page = unwrap(await commands.getBlock(block.page_id))
      await safeNavigateToPage(eventName, page.id, page.content ?? '', payload.id)
      return
    }
    for (let hop = 0; block.parent_id !== null && hop < MAX_ANCESTOR_HOPS; hop++) {
      block = unwrap(await commands.getBlock(block.parent_id))
      if (block.block_type === 'page') {
        await safeNavigateToPage(eventName, block.id, block.content ?? '', payload.id)
        return
      }
    }
    logger.warn('deeplink', `${eventName} target has no containing page`, { id: payload.id })
    notify.error(t('blockTree.linkTargetNotFound'))
  } catch (err) {
    logger.warn('deeplink', `${eventName} target resolution failed`, { id: payload.id }, err)
    notify.error(t('blockTree.linkTargetNotFound'))
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
  // A write failure (Not fatal — the view still mounts on `'general'`) is
  // logged and swallowed by writePreference.
  writePreference(PREFERENCES.settingsActiveTab, payload.tab)
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
        void handleNavigatePayload(event.payload, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
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
        void handleNavigatePayload(event.payload, DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
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
      void handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      return
    }
    case 'page': {
      void handleNavigatePayload({ id: normalisedId }, DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
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
