/**
 * useBlockLinkResolve — scans loaded blocks for `[[ULID]]` link tokens and
 * batch-resolves any ids not yet in the resolve cache.
 *
 * Pages + tags are preloaded by App.tsx via `useResolveStore.preload()`;
 * this hook fills the gap for block-link references (e.g. links to
 * content blocks). FEAT-3p7 — `spaceId` is threaded through both the
 * cache-membership check and the `batchResolve` IPC so foreign-space
 * targets are filtered out and rendered as broken-link chips. Extracted
 * from BlockTree.tsx for MAINT-128.
 */

import { useEffect } from 'react'
import { logger } from '../lib/logger'
import { batchResolve } from '../lib/tauri'
import { keyFor, useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

/** Matches the `[[ULID]]` block-link token. */
const ULID_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g

/**
 * Scan the provided blocks for `[[ULID]]` tokens whose ids are not yet
 * cached for the active space. The cache is keyed by
 * `${spaceId}::${ulid}` (FEAT-3p7) so the membership check has to use
 * the same composite key — a bare-id lookup would treat a previous-
 * space cache hit as "already cached" and skip the (now space-scoped)
 * batch resolve, leaking the foreign title into the chip render.
 */
export function collectUncachedLinkIds(
  blocks: ReadonlyArray<{ content: string | null }>,
  spaceId: string | null,
): Set<string> {
  const uncached = new Set<string>()
  const currentCache = useResolveStore.getState().cache
  for (const b of blocks) {
    if (!b.content) continue
    for (const m of b.content.matchAll(ULID_LINK_RE)) {
      const id = m[1] as string
      if (!currentCache.has(keyFor(spaceId, id))) uncached.add(id)
    }
  }
  return uncached
}

/**
 * Batch-resolve the given ids and write results back to the resolve store.
 * Logs and swallows transport errors; honours a cancellation predicate so
 * the caller can abort on unmount without an extra flag at the call site.
 *
 * FEAT-3p7 — pass `spaceId` to scope the resolve to the active space.
 * Foreign-space targets are filtered out by the backend; we mark them
 * as `deleted: true` placeholders here so the chip's `resolveStatus`
 * lookup hits a cached entry and renders via the broken-link UX
 * instead of the active default.
 */
export async function fetchAndCacheLinks(
  ids: ReadonlySet<string>,
  spaceId: string | null,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    const resolved = await batchResolve([...ids], spaceId ?? undefined)
    if (isCancelled()) return
    const store = useResolveStore.getState()
    const resolvedIds = new Set(resolved.map((r) => r.id))
    for (const r of resolved) {
      store.set(r.id, r.title?.slice(0, 60) || `[[${r.id.slice(0, 8)}...]]`, r.deleted)
    }
    // FEAT-3p7 — every requested id the backend did not return is a
    // foreign-space (or genuinely unknown) target. Cache a deleted
    // placeholder so the chip's resolveStatus hits and the broken-link
    // styling fires; without this, an unknown id falls through to the
    // 'active' default and the chip silently renders as live.
    for (const id of ids) {
      if (resolvedIds.has(id)) continue
      store.set(id, `[[${id.slice(0, 8)}...]]`, true)
    }
  } catch (err) {
    logger.warn('BlockTree', 'Batch resolve failed for uncached block links', undefined, err)
  }
}

/**
 * Effect-only hook: every time `blocks` changes, scan for uncached
 * `[[ULID]]` references and trigger a batch resolve. Returns nothing —
 * results land in `useResolveStore` and are read by chip renderers.
 */
export function useBlockLinkResolve(blocks: ReadonlyArray<{ content: string | null }>): void {
  useEffect(() => {
    let cancelled = false
    async function resolveUncachedLinks(): Promise<void> {
      try {
        const spaceId = useSpaceStore.getState().currentSpaceId
        const uncached = collectUncachedLinkIds(blocks, spaceId)
        if (uncached.size === 0) return
        await fetchAndCacheLinks(uncached, spaceId, () => cancelled)
      } catch (err) {
        logger.warn(
          'BlockTree',
          'Failed to scan blocks for uncached link references',
          undefined,
          err,
        )
      }
    }
    resolveUncachedLinks()
    return () => {
      cancelled = true
    }
  }, [blocks])
}
