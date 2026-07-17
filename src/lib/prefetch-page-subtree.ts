/**
 * prefetch-page-subtree — one-shot speculative prefetch handoff (#2850).
 *
 * NOT a persistent cache. Page subtrees are the write-path — `page-blocks.ts`
 * `load()` is the sole owner of the mutable block state and re-runs
 * `loadPageSubtree` on every reload signal (sync, undo, header ops,
 * post-move). Layering a persistent cache (e.g. the read-only `queryClient`,
 * see `@/lib/query-client`'s guardrail) over that would require wiring
 * invalidation into every one of those reload paths, or risk serving stale
 * block content — see the maintainer decision on #2850 for the full
 * reasoning. This module sidesteps that entirely: a hover/focus intent
 * kicks off the SAME IPC `load()` would eventually make, parks the promise
 * for a few seconds, and `load()` consumes it (once) if it is still live
 * when the click lands. A page nobody clicks just lets its entry expire —
 * there is no invalidation obligation because nothing here is ever read
 * twice.
 *
 * ## Semantics
 *  - Keyed by `"${spaceId}:${pageId}"`.
 *  - `prefetchPageSubtree` dedupes (a live entry is reused, not re-fetched)
 *    and caps concurrent in-flight speculative fetches — past the cap, new
 *    intent is DROPPED (not queued), so a fast hover-sweep across a long
 *    list or command-palette arrow-key traversal can't fan out unbounded
 *    IPCs.
 *  - `consumePrefetchedPageSubtree` is single-consumption: it returns the
 *    live promise AND deletes the entry, so a later reload can never
 *    observe (let alone replay) a promise `load()` already consumed once.
 *  - Expiry is checked lazily on read (no timers) — an entry past its TTL
 *    is treated as absent and swept on the next read that touches it.
 */

import { logger } from '@/lib/logger'
import type { PageSubtree } from '@/lib/tauri'
import { loadPageSubtree } from '@/lib/tauri'

/**
 * TTL for a parked prefetch promise, ms. Deliberately short — this bridges
 * the couple of seconds between hover/focus intent and the click that
 * usually follows a beat later, not a cache lifetime. Anything older is
 * worthless: `load()` will fetch fresh anyway once the entry expires, so a
 * longer TTL only risks handing `load()` a snapshot that's staler than a
 * fresh fetch would be, for no benefit.
 */
export const PREFETCH_TTL_MS = 8000

/**
 * Max concurrent in-flight (non-expired) speculative prefetches. Past this
 * cap, `prefetchPageSubtree` drops the new intent rather than queuing it —
 * queuing would just delay warming the page the user is ACTUALLY hovering
 * now behind a backlog of intents for rows the cursor already swept past.
 */
export const MAX_INFLIGHT_PREFETCHES = 4

/**
 * Shared hover/focus dwell threshold (ms) before an intent handler actually
 * calls {@link prefetchPageSubtree}. Every intent surface (`PageLink`,
 * `DensityRow`, `CommandPalette`, `LinkedReferences`) debounces on this same
 * constant via `useDebouncedCallback` so a cursor sweeping across a list (or
 * arrow-key traversal in the palette) doesn't fan out one IPC per row.
 */
export const PAGE_PREFETCH_DWELL_MS = 120

interface PrefetchEntry {
  promise: Promise<PageSubtree>
  expiresAt: number
}

const prefetchMap = new Map<string, PrefetchEntry>()

function keyFor(spaceId: string, pageId: string): string {
  return `${spaceId}:${pageId}`
}

function isLive(entry: PrefetchEntry | undefined, now: number): entry is PrefetchEntry {
  return entry != null && entry.expiresAt > now
}

/**
 * Delete every expired entry, then return the count of what remains (all
 * live). This is the ONLY place the concurrency cap is measured, and it
 * DELETES rather than merely counting — otherwise an entry that is prefetched,
 * expires after {@link PREFETCH_TTL_MS}, and is never re-hovered nor consumed
 * would linger in the Map forever, pinning a full `Promise<PageSubtree>`
 * (#2850 review: unbounded growth while scrolling a long Pages list or
 * hovering many inline links over a long-lived session). Because
 * `prefetchPageSubtree` calls this before every park, the resident set is
 * bounded to {@link MAX_INFLIGHT_PREFETCHES} live entries plus at most the
 * handful parked since the last call once the user goes idle.
 */
function sweepExpiredAndCountLive(now: number): number {
  for (const [key, entry] of prefetchMap) {
    if (entry.expiresAt <= now) prefetchMap.delete(key)
  }
  return prefetchMap.size
}

/**
 * Kick off (or join) a speculative `loadPageSubtree` fetch for
 * `(spaceId, pageId)` on hover/focus intent, and park its promise for
 * {@link PREFETCH_TTL_MS}. No-op when:
 *  - a live entry already exists for this key (the in-flight/parked fetch
 *    is reused — a second hover of the same row fires no second IPC), or
 *  - {@link MAX_INFLIGHT_PREFETCHES} live entries already exist (the new
 *    intent is dropped).
 *
 * Never throws and never produces an unhandled rejection: a speculative
 * fetch that nobody ends up consuming (the common case — most hovers don't
 * turn into clicks before the TTL) must not surface as an unhandled
 * rejection just because no `.catch`/`await` ever observed it. A rejected
 * prefetch simply means `load()` finds no live entry (or a since-expired
 * one) and fetches fresh, exactly as if nothing had been prefetched.
 */
export function prefetchPageSubtree(spaceId: string, pageId: string): void {
  const now = Date.now()
  // Sweep expired entries first so the Map can't grow unbounded with
  // parked-but-never-consumed pages, and so the cap/dedup below see only
  // live entries.
  const liveCount = sweepExpiredAndCountLive(now)
  const key = keyFor(spaceId, pageId)
  if (prefetchMap.has(key)) return // dedup — post-sweep, any present entry is live
  if (liveCount >= MAX_INFLIGHT_PREFETCHES) return // cap — drop this intent

  const promise = loadPageSubtree(pageId, spaceId)
  promise.catch((err: unknown) => {
    // #2850 — swallow so an unconsumed rejected speculative fetch (the
    // common case) never becomes an unhandled rejection. `warn` (not
    // `error`) — a failed prefetch is expected/benign; `load()` just
    // fetches fresh instead.
    logger.warn(
      'prefetch-page-subtree',
      'speculative prefetch failed — load() will fetch fresh instead',
      { spaceId, pageId },
      err,
    )
  })
  prefetchMap.set(key, { promise, expiresAt: now + PREFETCH_TTL_MS })
}

/**
 * Single-consumption read for `page-blocks.ts` `load()`. Returns the live
 * parked promise for `(spaceId, pageId)` and DELETES the entry so no other
 * consumer can observe it again — a later reload (sync/undo/blocks:changed)
 * always finds the entry gone and fetches fresh. Returns `null` when no
 * entry exists, or the entry has expired (swept here, lazily, on read).
 */
export function consumePrefetchedPageSubtree(
  spaceId: string,
  pageId: string,
): Promise<PageSubtree> | null {
  const key = keyFor(spaceId, pageId)
  const entry = prefetchMap.get(key)
  if (!isLive(entry, Date.now())) {
    if (entry) prefetchMap.delete(key) // lazy sweep of a stale entry
    return null
  }
  prefetchMap.delete(key) // single-consumption
  return entry.promise
}

/**
 * Test-only reset. Clears every parked entry so tests don't leak
 * in-flight/parked promises across cases via this module-level `Map`.
 */
export function _resetPrefetchPageSubtreeForTest(): void {
  prefetchMap.clear()
}

/** Test-only: current number of parked entries (live + not-yet-swept). */
export function _prefetchMapSizeForTest(): number {
  return prefetchMap.size
}
