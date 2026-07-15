/**
 * useBacklinkResolution -- resolve [[ULID]] and #[ULID] tokens in backlink content.
 *
 * #2635 — real title/status resolution is DELEGATED to the shared
 * `useResolveStore` (the single app-wide `[[ULID]]`/`#[ULID]` title cache).
 * This hook no longer owns a private resolved-title Map (nor its TTL/LRU); it
 * keeps ONLY the backlink-specific bookkeeping local:
 *
 *   - `attemptedRef` — a `Set` of "attempted-but-unresolved" ids: link TARGETS
 *     the backend did not return (foreign-space / soft-deleted). These render
 *     as broken links WITHOUT being written into the shared store, so the
 *     app-wide cache is never polluted with backlink-only deleted placeholders.
 *   - `forceReresolveRef` — a latch set by `clearCache()` so the next resolve
 *     pass re-fetches the current content ids even when they are already cached
 *     in the store. This preserves #2628: a renamed linked target RE-resolves
 *     (its fresh title is written back to the store) instead of serving the
 *     stale cached entry.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '../lib/logger'
import type { BacklinkGroup, ResolvedBlock } from '../lib/tauri'
import { batchResolve } from '../lib/tauri'
import { keyFor, useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

export interface UseBacklinkResolutionResult {
  resolveBlockTitle: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagName: (id: string) => string
  clearCache: () => void
}

const ULID_RE = /\[\[([0-9A-Z]{26})\]\]/g
const TAG_RE = /#\[([0-9A-Z]{26})\]/g

/** Collect every [[ULID]] and #[ULID] token id present in the groups' content. */
function collectContentIds(groups: BacklinkGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const g of groups) {
    for (const block of g.blocks) {
      if (!block.content) continue
      for (const m of block.content.matchAll(ULID_RE)) ids.add(m[1] as string)
      for (const m of block.content.matchAll(TAG_RE)) ids.add(m[1] as string)
    }
  }
  return ids
}

/**
 * Display title to persist in the shared store for a resolved row. A real
 * (non-empty) backend title is stored verbatim, matching the store's own
 * convention (preload writes raw page/tag titles). An empty/absent title falls
 * back to the tag/page placeholder so the row still carries a stable label AND
 * `has()` stays true for it — otherwise a name-less-but-real row would be
 * re-fetched on every pass.
 */
function storeTitle(r: ResolvedBlock): string {
  if (r.title && r.title.length > 0) return r.title
  return r.block_type === 'tag' ? `#${r.id.slice(0, 8)}...` : `[[${r.id.slice(0, 8)}...]]`
}

export function useBacklinkResolution(groups: BacklinkGroup[]): UseBacklinkResolutionResult {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // Re-render when the shared store lands new resolutions (replaces the old
  // private `resolveVersion` counter).
  const storeVersion = useResolveStore((s) => s.version)
  // Bumped after a batchResolve settles so the memoised resolver callbacks
  // recompute even when the store itself did not change — e.g. every requested
  // id was unresolved, so `batchSet([])` is a no-op and never bumps
  // `storeVersion`, yet `attemptedRef` (a ref) did change.
  const [localVersion, setLocalVersion] = useState(0)

  // Backlink-LOCAL "attempted-but-unresolved" ids, composite-keyed by space
  // (`keyFor`) so two spaces don't share broken-link state. These are link
  // TARGETS the backend did not return — the broken-link UX. Kept local so the
  // app-wide store is never polluted with backlink-only deleted placeholders
  // (#2635), mirroring `attemptedBreadcrumbIdsRef` in useSearchResults.
  const attemptedRef = useRef<Set<string>>(new Set<string>())
  // Latch set by `clearCache()`: forces the next resolve pass to re-fetch the
  // current content ids even when already cached in the store, so a renamed
  // target re-resolves (#2628) instead of serving the stale store entry.
  const forceReresolveRef = useRef(false)

  // Resolve [[ULID]] and #[ULID] tokens in block content against the store.
  useEffect(() => {
    const contentIds = collectContentIds(groups)
    if (contentIds.size === 0) return

    const store = useResolveStore.getState()
    // Consume the `clearCache()` latch: when set, re-resolve ALL current
    // content ids (ignore the store cache) so a renamed target refreshes.
    const force = forceReresolveRef.current
    forceReresolveRef.current = false

    const idsToResolve = [...contentIds].filter((id) =>
      force ? true : !store.has(id) && !attemptedRef.current.has(keyFor(currentSpaceId, id)),
    )
    if (idsToResolve.length === 0) return

    let cancelled = false

    // #2543 — scope resolution to the CURRENT space (foreign-space targets then
    // fall into the broken-link UX via the attempted-unresolved set below),
    // falling back to the literal 'global' only when no space is active
    // (pre-bootstrap / trash-like surfaces), mirroring useBlockLinkResolve.ts.
    batchResolve(idsToResolve, currentSpaceId ?? 'global')
      .then((resolved) => {
        if (cancelled) return
        const returnedIds = new Set(resolved.map((r) => r.id))
        // Real resolutions → shared store (verbatim titles + real deleted flag).
        if (resolved.length > 0) {
          useResolveStore
            .getState()
            .batchSet(resolved.map((r) => ({ id: r.id, title: storeTitle(r), deleted: r.deleted })))
        }
        // Requested but NOT returned → backlink-local broken-link set (never the
        // shared store). A returned id is cleared from the set in case a prior
        // pass had marked it unresolved.
        for (const id of idsToResolve) {
          const key = keyFor(currentSpaceId, id)
          if (returnedIds.has(id)) attemptedRef.current.delete(key)
          else attemptedRef.current.add(key)
        }
        setLocalVersion((v) => v + 1)
      })
      .catch((err) => {
        logger.warn('useBacklinkResolution', 'batch resolve failed', undefined, err)
        // Nothing is cached and nothing is marked unresolved on error, so the
        // ids keep their plain (active) fallback and a later groups change
        // re-attempts resolution.
        if (!cancelled) setLocalVersion((v) => v + 1)
      })

    return () => {
      cancelled = true
    }
  }, [groups, currentSpaceId])

  const resolveBlockTitle = useCallback(
    (id: string): string => {
      const store = useResolveStore.getState()
      return store.has(id) ? store.resolveTitle(id) : `[[${id.slice(0, 8)}...]]`
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- storeVersion/localVersion (unused in the body) are listed to bust the memo when resolutions land in the store or the attempted set changes
    [storeVersion, localVersion, currentSpaceId],
  )

  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      const store = useResolveStore.getState()
      if (store.has(id)) return store.resolveStatus(id)
      return attemptedRef.current.has(keyFor(currentSpaceId, id)) ? 'deleted' : 'active'
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- storeVersion/localVersion (unused in the body) are listed to bust the memo when resolutions land in the store or the attempted set changes
    [storeVersion, localVersion, currentSpaceId],
  )

  const resolveTagName = useCallback(
    (id: string): string => {
      const store = useResolveStore.getState()
      return store.has(id) ? store.resolveTitle(id) : `#${id.slice(0, 8)}...`
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- storeVersion/localVersion (unused in the body) are listed to bust the memo when resolutions land in the store or the attempted set changes
    [storeVersion, localVersion, currentSpaceId],
  )

  const clearCache = useCallback(() => {
    // #2635 — do NOT clear the shared store (that would nuke every other
    // consumer's cache). Clear only the backlink-local attempted set and latch
    // a forced re-resolve so the current content ids are re-fetched against the
    // store — preserving #2628 (a renamed linked target re-resolves rather than
    // staying stale) without a private TTL.
    attemptedRef.current.clear()
    forceReresolveRef.current = true
    setLocalVersion((v) => v + 1)
  }, [])

  return {
    resolveBlockTitle,
    resolveBlockStatus,
    resolveTagName,
    clearCache,
  }
}
