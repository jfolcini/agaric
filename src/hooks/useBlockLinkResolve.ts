/**
 * useBlockLinkResolve — scans loaded blocks for `[[ULID]]` link tokens and
 * batch-resolves any ids not yet in the resolve cache.
 *
 * Pages + tags are preloaded by App.tsx via `useResolveStore.preload()`;
 * this hook fills the gap for block-link references (e.g. links to
 * Content blocks). `spaceId` is threaded through both the
 * cache-membership check and the `batchResolve` IPC so foreign-space
 * targets are filtered out and rendered as broken-link chips. Extracted
 * From BlockTree.tsx for.
 */

import { useEffect, useMemo } from 'react'

import { logger } from '../lib/logger'
import { batchResolve } from '../lib/tauri'
import { keyFor, useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

/** Matches the `[[ULID]]` block-link token. */
const ULID_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g

/**
 * Scan the provided blocks for `[[ULID]]` tokens whose ids are not yet
 * cached for the active space. The cache is keyed by
 * `${spaceId}::${ulid}` so the membership check has to use
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
 * Pass `spaceId` to scope the resolve to the active space.
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
    // #1072 — collapse the per-id writeback into a single batchSet so the
    // resolve cache is cloned and `version` is bumped at most once for the
    // whole batch (zero when everything was already cached), instead of
    // K+M full-Map clones + K+M version bumps. batchSet diffs-once /
    // clones-once / bumps-once (#753) and, like `set`, writes under
    // activeSpaceId() and caps via evictOldest — behaviour is preserved.
    const entries: Array<{ id: string; title: string; deleted: boolean }> = []
    for (const r of resolved) {
      entries.push({
        id: r.id,
        title: r.title?.slice(0, 60) || `[[${r.id.slice(0, 8)}...]]`,
        deleted: r.deleted,
      })
    }
    // Every requested id the backend did not return is a
    // foreign-space (or genuinely unknown) target. Cache a deleted
    // placeholder so the chip's resolveStatus hits and the broken-link
    // styling fires; without this, an unknown id falls through to the
    // 'active' default and the chip silently renders as live.
    for (const id of ids) {
      if (resolvedIds.has(id)) continue
      entries.push({ id, title: `[[${id.slice(0, 8)}...]]`, deleted: true })
    }
    store.batchSet(entries)
  } catch (err) {
    logger.warn('BlockTree', 'Batch resolve failed for uncached block links', undefined, err)
  }
}

/**
 * Effect-only hook: scans loaded blocks for uncached `[[ULID]]`
 * references and triggers a batch resolve. Returns nothing — results
 * land in `useResolveStore` and are read by chip renderers.
 *
 * Identity invariants (#1266): the effect re-fires only when the
 * blocks' ids+content actually change, NOT on every fresh `blocks`
 * array. The page store reallocates `s.blocks` to a new outer array on
 * every edit / reorder / indent, but `collectUncachedLinkIds` runs an
 * O(N x content-length) `matchAll(ULID_LINK_RE)` scan over every block;
 * re-running that on identity churn alone is wasted CPU. So we derive a
 * stable `contentSignature` (id + content per block) in a memo and key
 * the effect on it — mirroring `useBlockPropertiesBatch`'s `idSignature`
 * guard, but including content because `[[ULID]]` tokens live there.
 */
export function useBlockLinkResolve(
  blocks: ReadonlyArray<{ id: string; content: string | null }>,
): void {
  // `\0` (NUL) separates a block's id from its content and `\x01` (SOH)
  // separates blocks, so the join is unambiguous for any id/content —
  // no real content can collide a boundary. The signature is stable
  // across reallocations that change neither ids nor content (the common
  // keystroke-flush / indent / no-op refresh churn the page store emits),
  // so the full-page regex scan is skipped on those. It changes when any
  // block's id or content changes — including edits to blocks *without*
  // links, but that re-scan stays purely local CPU and the IPC remains
  // guarded by the uncached-id check.
  const contentSignature = useMemo(
    () => blocks.map((b) => b.id + '\0' + (b.content ?? '')).join('\x01'),
    [blocks],
  )

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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `blocks` is read inside the effect but keyed via `contentSignature`, which is recomputed from `blocks` in the memo above and changes iff some block's id/content changes. Depending on raw `blocks` would defeat the signature guard (#1266); a same-id/content reorder reallocation must NOT re-run the full-page scan.
  }, [contentSignature])
}
