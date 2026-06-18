/**
 * usePageBrowserScrollRestoration — sessionStorage-backed scroll
 * restoration for the Pages view's virtualized list.
 *
 * The user clicks a page → editor → Back, and `PageBrowser` remounts;
 * without this they land at row 0 even when they were halfway down a
 * 300-page list. The save side debounces via a ref-tracked timeout (no
 * `requestIdleCallback` because not every test/browser has it and the
 * cost is the same single setTimeout); the restore side fires once per
 * mount AFTER the first batch hydrates so the virtualizer has a non-zero
 * total size to scroll inside of.
 *
 * Key is per-space so switching spaces and back restores each space's
 * last position independently. Filter / sort / density changes clear the
 * saved offset because the saved position is meaningless against a
 * re-ordered or re-filtered set.
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same timing.
 */

import { type RefObject, useEffect, useRef } from 'react'

import type { DensityMode } from './usePageBrowserDensity'
import type { SortOption } from './usePageBrowserSort'

interface VirtualizerLike {
  getTotalSize: () => number
  scrollToOffset: (
    offset: number,
    options?: { align?: 'start' | 'center' | 'end' | 'auto' },
  ) => void
}

interface UsePageBrowserScrollRestorationParams {
  listRef: RefObject<HTMLDivElement | null>
  currentSpaceId: string | null
  pagesLength: number
  virtualizer: VirtualizerLike
  filterText: string
  sortOption: SortOption
  density: DensityMode
  wireFiltersKey: string
}

export function usePageBrowserScrollRestoration({
  listRef,
  currentSpaceId,
  pagesLength,
  virtualizer,
  filterText,
  sortOption,
  density,
  wireFiltersKey,
}: UsePageBrowserScrollRestorationParams): void {
  const scrollStorageKey =
    currentSpaceId != null ? `pageBrowser:scrollOffset:${currentSpaceId}` : null
  const restoredRef = useRef(false)
  const scrollSaveTimerRef = useRef<number | null>(null)

  // Reset the restore-once latch when the storage key changes (space
  // switch). Each space gets its own first-batch restoration; without
  // this, switching to space B and back to space A would skip
  // restoration for A because `restoredRef.current` was set during
  // A's first mount in this session.
  useEffect(() => {
    restoredRef.current = false
  }, [scrollStorageKey])

  // Restore once per (mount, space) tuple, after items hydrate.
  useEffect(() => {
    if (restoredRef.current) return
    if (scrollStorageKey == null) return
    if (pagesLength === 0) return
    const totalSize = virtualizer.getTotalSize()
    if (totalSize <= 0) return
    const raw = sessionStorage.getItem(scrollStorageKey)
    if (raw == null) {
      restoredRef.current = true
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      restoredRef.current = true
      return
    }
    // Bound to [0, totalSize] in case the list shrank between
    // sessions (pages deleted in another tab, etc.).
    const bounded = Math.min(parsed, totalSize)
    virtualizer.scrollToOffset(bounded, { align: 'start' })
    restoredRef.current = true
  }, [pagesLength, virtualizer, scrollStorageKey])

  // Save scroll offset on scroll (debounced ~150ms).
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    if (scrollStorageKey == null) return
    function handleScroll() {
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
      }
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null
        // Read at flush time, not at scroll time, so the saved
        // value reflects the user's final resting offset rather
        // than every intermediate frame.
        if (el == null || scrollStorageKey == null) return
        sessionStorage.setItem(scrollStorageKey, String(el.scrollTop))
      }, 150)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
        scrollSaveTimerRef.current = null
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `listRef` is a stable ref; re-attach only on storage-key (space) change
  }, [scrollStorageKey])

  // Clear saved offset when filter / sort / density / space changes —
  // the saved offset is keyed only by space, so a filter / sort /
  // density change against the same space would otherwise restore a
  // meaningless position the next time the user revisits this view.
  // Density is included because the per-row pixel height changed
  // wholesale (32 / 44 / 68 px), so the saved scrollTop no longer
  // points at the same row index. Allow restoration again on next
  // mount by leaving `restoredRef` intact within this mount but
  // dropping the stored value.
  useEffect(() => {
    if (scrollStorageKey == null) return
    // Skip the very first run (mount) — that's when we want to
    // restore, not clear. `restoredRef.current === false` means we
    // haven't tried yet; the restore effect will handle it. After
    // restoration completes, any subsequent change clears.
    if (!restoredRef.current) return
    sessionStorage.removeItem(scrollStorageKey)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- scrollStorageKey already covers space changes; filterText, sortOption, density, and the compound-filter set are the explicit triggers
  }, [filterText, sortOption, density, wireFiltersKey])
}
