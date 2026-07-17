/**
 * usePagePrefetchIntent — shared hover/focus intent scheduler for #2850's
 * speculative page-subtree prefetch.
 *
 * Every navigation surface (`PageLink`, `DensityRow`, `CommandPalette`,
 * `LinkedReferences`) wants the same shape: debounce a dwell timer on
 * `onMouseEnter`/`onFocus`, clear it on `onMouseLeave`/`onBlur`, and — when
 * the dwell elapses — kick off `prefetchPageSubtree` for whatever the
 * ACTIVE space is at that moment (not at hover-start, so a space switch
 * mid-hover can't warm the wrong space). Resolved centrally here so each
 * surface just calls `schedule(pageId)` / `cancel()`.
 *
 * Built on the existing `useDebouncedCallback` (timer + unmount cleanup
 * already handled there) rather than a bespoke timer — this hook only adds
 * the space-resolution + prefetch call as the debounced callback body.
 */

import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { PAGE_PREFETCH_DWELL_MS, prefetchPageSubtree } from '@/lib/prefetch-page-subtree'
import { useSpaceStore } from '@/stores/space'

export interface PagePrefetchIntent {
  /** (Re)start the dwell timer for `pageId`. Call on hover/focus enter. */
  schedule: (pageId: string) => void
  /** Cancel any pending dwell timer. Call on hover/focus leave. */
  cancel: () => void
}

export function usePagePrefetchIntent(
  dwellMs: number = PAGE_PREFETCH_DWELL_MS,
): PagePrefetchIntent {
  const { schedule, cancel } = useDebouncedCallback((pageId: string) => {
    const spaceId = useSpaceStore.getState().currentSpaceId
    if (spaceId == null) return
    prefetchPageSubtree(spaceId, pageId)
  }, dwellMs)

  return { schedule, cancel }
}
