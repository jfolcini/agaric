/**
 * useBacklinkResolution -- resolve [[ULID]] and #[ULID] tokens in backlink content.
 *
 * Manages a TTL cache of resolved page titles and tag names, batch-resolving
 * unknown IDs via the backend and providing stable resolver callbacks for rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '../lib/logger'
import type { BacklinkGroup, ResolvedBlock } from '../lib/tauri'
import { batchResolve } from '../lib/tauri'
import { keyFor } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

export interface ResolveCacheEntry {
  title: string
  deleted: boolean
  cachedAt: number
}

export const TTL_MS = 5 * 60 * 1000
export const MAX_CACHE_SIZE = 1000

export interface UseBacklinkResolutionResult {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  clearCache: () => void
}

type ResolveCache = Map<string, ResolveCacheEntry>

// ---------------------------------------------------------------------------
// Pure cache maintenance helpers (module-scope so the hook body stays simple).
// ---------------------------------------------------------------------------

/** Drop entries whose `cachedAt` is older than TTL_MS before `now`. */
function evictExpiredEntries(cache: ResolveCache, now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > TTL_MS) cache.delete(key)
  }
}

/**
 * Evict oldest entries (insertion order) to keep `cache.size + pendingCount`
 * under `MAX_CACHE_SIZE`. Map iteration order is insertion order in ES2015+.
 */
function evictOverflow(cache: ResolveCache, pendingCount: number): void {
  const overflow = cache.size + pendingCount - MAX_CACHE_SIZE
  if (overflow <= 0) return
  const keys = cache.keys()
  for (let i = 0; i < overflow; i++) {
    const next = keys.next()
    if (next.done) break
    cache.delete(next.value)
  }
}

/** Compute the display title for a resolved entry, with tag/page fallbacks. */
function computeTitle(r: ResolvedBlock): string {
  if (r.title) {
    const trimmed = r.title.slice(0, 60)
    if (trimmed.length > 0) return trimmed
  }
  return r.block_type === 'tag' ? `#${r.id.slice(0, 8)}...` : `[[${r.id.slice(0, 8)}...]]`
}

/** Write resolved entries into the cache with the current timestamp. */
function storeResolvedEntries(
  cache: ResolveCache,
  resolved: ResolvedBlock[],
  spaceId: string | null,
): void {
  const now = Date.now()
  for (const r of resolved) {
    cache.set(keyFor(spaceId, r.id), { title: computeTitle(r), deleted: r.deleted, cachedAt: now })
  }
}

/** For every requested id the backend did not return, store a deleted-placeholder. */
function fillUnresolvedPlaceholders(
  cache: ResolveCache,
  requestedIds: Iterable<string>,
  spaceId: string | null,
): void {
  const now = Date.now()
  for (const id of requestedIds) {
    const key = keyFor(spaceId, id)
    if (cache.has(key)) continue
    cache.set(key, { title: `[[${id.slice(0, 8)}...]]`, deleted: true, cachedAt: now })
  }
}

/** Collect all [[ULID]] and #[ULID] token ids that aren't fresh in the cache. */
function collectIdsToResolve(
  groups: BacklinkGroup[],
  cache: ResolveCache,
  spaceId: string | null,
): Set<string> {
  const ULID_RE = /\[\[([0-9A-Z]{26})\]\]/g
  const TAG_RE = /#\[([0-9A-Z]{26})\]/g
  const ids = new Set<string>()
  const now = Date.now()
  for (const g of groups) {
    for (const block of g.blocks) {
      if (!block.content) continue
      for (const m of block.content.matchAll(ULID_RE)) ids.add(m[1] as string)
      for (const m of block.content.matchAll(TAG_RE)) ids.add(m[1] as string)
    }
  }
  for (const id of ids) {
    const cached = cache.get(keyFor(spaceId, id))
    if (cached && now - cached.cachedAt <= TTL_MS) ids.delete(id)
  }
  return ids
}

/**
 * Merge a batch of resolved blocks into the cache, evicting stale + overflowed
 * entries, and backfilling placeholders for any id the backend did not return.
 */
function mergeResolvedIntoCache(
  cache: ResolveCache,
  resolved: ResolvedBlock[],
  requestedIds: Set<string>,
  spaceId: string | null,
): void {
  evictExpiredEntries(cache, Date.now())
  evictOverflow(cache, requestedIds.size)
  storeResolvedEntries(cache, resolved, spaceId)
  fillUnresolvedPlaceholders(cache, requestedIds, spaceId)
}

export function useBacklinkResolution(groups: BacklinkGroup[]): UseBacklinkResolutionResult {
  const [resolveVersion, setResolveVersion] = useState(0)
  const resolveCache = useRef<ResolveCache>(new Map())
  // PEND-30 L-2: include `currentSpaceId` in cache keys so two spaces with
  // the same ULID (or — under PEND-15 — the same backlink existing in
  // both spaces with different titles) don't bleed across the 5-minute
  // TTL. Matches the `${spaceId}::${ulid}` convention from
  // `useResolveStore` (`stores/resolve.ts`).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // Resolve [[ULID]] and #[ULID] tokens in block content
  useEffect(() => {
    const allBlocks = groups.flatMap((g) => g.blocks)
    if (allBlocks.length === 0) return

    const idsToResolve = collectIdsToResolve(groups, resolveCache.current, currentSpaceId)

    if (idsToResolve.size === 0) {
      setResolveVersion((v) => v + 1)
      return
    }

    let cancelled = false

    batchResolve([...idsToResolve])
      .then((resolved) => {
        if (cancelled) return
        mergeResolvedIntoCache(resolveCache.current, resolved, idsToResolve, currentSpaceId)
        setResolveVersion((v) => v + 1)
      })
      .catch((err) => {
        logger.warn('useBacklinkResolution', 'batch resolve failed', undefined, err)
        if (!cancelled) setResolveVersion((v) => v + 1)
      })

    return () => {
      cancelled = true
    }
  }, [groups, currentSpaceId])

  const resolveBlockTitle = useCallback(
    (id: string): string => {
      return (
        resolveCache.current.get(keyFor(currentSpaceId, id))?.title ?? `[[${id.slice(0, 8)}...]]`
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally listed (though unused in the body) to bust the memo when the ref cache mutates, so renders pick up resolved titles
    [resolveVersion, currentSpaceId],
  )

  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      return resolveCache.current.get(keyFor(currentSpaceId, id))?.deleted ? 'deleted' : 'active'
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally listed (though unused in the body) to bust the memo when the ref cache mutates, so renders pick up resolved statuses
    [resolveVersion, currentSpaceId],
  )

  const resolveTagName = useCallback(
    (id: string): string => {
      return resolveCache.current.get(keyFor(currentSpaceId, id))?.title ?? `#${id.slice(0, 8)}...`
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally listed (though unused in the body) to bust the memo when the ref cache mutates, so renders pick up resolved tag names
    [resolveVersion, currentSpaceId],
  )

  const clearCache = useCallback(() => {
    resolveCache.current.clear()
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    clearCache,
  }
}
