import { useEffect } from 'react'

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

/**
 * A ref property's target title as the resolve cache holds it now, so a rename
 * shows at once; null when there is no target. The boot preload caches the
 * active space's pages and tags, so a ref to a block, to another space's page or
 * to an evicted entry is asked for the way a `[[link]]` chip's target is.
 */
export function useRefTitle(targetId: string | null): string | null {
  const title = useResolveStore((s) => (targetId === null ? null : s.resolveTitle(targetId)))
  const cached = useResolveStore((s) => targetId === null || s.has(targetId))
  useEffect(() => {
    if (cached || targetId === null) return
    const spaceId = useSpaceStore.getState().currentSpaceId
    void fetchAndCacheLinks(
      new Set([targetId]),
      spaceId,
      () => useSpaceStore.getState().currentSpaceId !== spaceId,
    )
  }, [targetId, cached])
  return title
}

/**
 * The titles of a ref list's targets (#6741), each as {@link useRefTitle}
 * reads it, joined by `, `. A target the cache lacks is asked for the same way.
 */
export function useRefTitles(targetIds: readonly string[]): string {
  const titles = useResolveStore((s) => targetIds.map((id) => s.resolveTitle(id)).join(', '))
  const missing = useResolveStore((s) => targetIds.filter((id) => !s.has(id)).join('\0'))
  useEffect(() => {
    if (missing === '') return
    const spaceId = useSpaceStore.getState().currentSpaceId
    void fetchAndCacheLinks(
      new Set(missing.split('\0')),
      spaceId,
      () => useSpaceStore.getState().currentSpaceId !== spaceId,
    )
  }, [missing])
  return titles
}
