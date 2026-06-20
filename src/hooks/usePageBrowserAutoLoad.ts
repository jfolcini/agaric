/**
 * usePageBrowserAutoLoad — infinite-scroll auto-load triggers for the
 * Pages view's virtualized list.
 *
 * Two complementary triggers fire `loadMore()` as the user nears the end
 * of the list:
 *
 *  - Index-based: the last *visible* virtual item is within ~5 rows of
 *    the end. Works in flat view.
 *  - Pixel-based: the viewport's bottom edge is within
 *    `INFINITE_SCROLL_BOTTOM_THRESHOLD_PX` of the scroll container's full
 *    height. Complements the index trigger for tree view, where one
 *    expanded `tree-page` row can wrap hundreds of descendant nodes so
 *    `lastVisibleIndex` stays pinned at a low index.
 *
 * Both triggers short-circuit on `!hasMore || loading` so concurrent
 * firings collapse to one `loadMore()` call (which `usePaginatedQuery`
 * additionally guards on `nextCursor && !loading`). The
 * `<LoadMoreButton>` stays rendered as the a11y / no-JS / reduced-motion
 * fallback.
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same timing.
 */

import { type RefObject, useEffect, useRef } from 'react'

/// Bottom-of-list proximity in CSS pixels at which the auto-load
/// pixel-trigger fires. Picked to give ~5-7 rows of headroom at the
/// 44px regular-density row so the next page lands before the user
/// Hits the LoadMoreButton fallback. Phase 3 left this as a
/// regular-density assumption: compact (32 px) gets one extra row of
/// headroom, expanded (68 px) gets one fewer — both well inside the
/// LoadMoreButton fallback envelope.
const INFINITE_SCROLL_BOTTOM_THRESHOLD_PX = 300

interface UsePageBrowserAutoLoadParams {
  listRef: RefObject<HTMLDivElement | null>
  hasMore: boolean
  loading: boolean
  loadMore: () => void
  /** Index of the last virtual item currently rendered, or `undefined`. */
  lastVisibleIndex: number | undefined
  virtualItemCount: number
}

export function usePageBrowserAutoLoad({
  listRef,
  hasMore,
  loading,
  loadMore,
  lastVisibleIndex,
  virtualItemCount,
}: UsePageBrowserAutoLoadParams): void {
  useEffect(() => {
    if (!hasMore || loading) return
    if (lastVisibleIndex == null) return
    if (lastVisibleIndex >= virtualItemCount - 5) {
      loadMore()
    }
  }, [lastVisibleIndex, hasMore, loading, loadMore, virtualItemCount])

  // Pixel-based bottom-proximity trigger — fires when the viewport's
  // bottom edge is within `INFINITE_SCROLL_BOTTOM_THRESHOLD_PX` of
  // the scroll container's full height. Complements the index-based
  // trigger above for tree view (one expanded tree-page row may
  // exceed the viewport vertically; the index-based check never
  // advances past that row even as the user scrolls inside it).
  const hasMoreRef = useRef(hasMore)
  const loadingRef = useRef(loading)
  const loadMoreRef = useRef(loadMore)
  hasMoreRef.current = hasMore
  loadingRef.current = loading
  loadMoreRef.current = loadMore
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    function handleScroll() {
      if (!hasMoreRef.current || loadingRef.current) return
      if (el == null) return
      const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (remaining <= INFINITE_SCROLL_BOTTOM_THRESHOLD_PX) {
        loadMoreRef.current()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
    // Empty deps + refs above: listener attaches once per mount, and
    // the refs always carry the latest hasMore/loading/loadMore.
    // `listRef` is a stable ref, so it does not belong in the dep array.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- attach once per mount; latest values read via refs
  }, [])
}
