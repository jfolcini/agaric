/**
 * useBlockMountLimit — bounds how many rows of a page's flat, collapse-
 * filtered block list actually mount as React components (#2467).
 *
 * ## Problem
 * `useBlockCollapse`'s `visibleBlocks` already keeps a collapsed subtree's
 * descendants OUT of the mounted React tree entirely — they are filtered
 * before ever reaching `BlockListRenderer` (see `useBlockCollapse.ts`). But
 * that only helps pages the user has manually collapsed. A large FLAT page
 * (or one the user hasn't collapsed yet) still mounts every row:
 * `useViewportObserver` ("virtualization lite") only stops *painting*
 * offscreen rows — the `SortableBlockWrapper` fiber, its hooks, and its
 * listeners stay mounted (`docs/architecture/editor-and-content.md` §
 * Viewport rendering). At thousands of blocks that is thousands of mounted
 * fibers regardless of viewport — the "full-tree mounting" half of #2467.
 *
 * ## What this does
 * Applies a row-count ceiling AFTER collapse filtering, using the exact same
 * "don't put it in the array `BlockListRenderer` maps over" mechanism
 * collapse already relies on: the excess rows are not placeholders, they are
 * simply absent from the mounted tree. A boundary row below the last mounted
 * block lets the user reveal the next batch on demand — mirroring the
 * semantics of expanding a collapsed block (nothing renders until asked
 * for), just keyed on position instead of collapse state.
 *
 * ## Envelope (provisional — see docs/architecture/editor-and-content.md
 * § Mount envelope)
 * `INITIAL_MOUNT_LIMIT` rows mount on first render; `MOUNT_LIMIT_STEP` more
 * mount per "Show more" click. These numbers are a conservative safety
 * rail, NOT a measured cliff — #2467's "Measure" phase (bench fixture at
 * 1K/5K/10K blocks/page) has not been run. Do not treat them as tuned;
 * revisit once real mount-time / keystroke-latency numbers exist.
 *
 * ## What this deliberately does NOT do
 * - No true virtualization (DOM recycling for offscreen-but-mounted rows
 *   within the cap) — this only bounds the CEILING, it doesn't shrink
 *   steady-state cost below it.
 * - No change to `load_page_subtree` or the per-page store — the backend
 *   already loads (and the store already holds) every block up to
 *   `PAGE_SUBTREE_MAX_BLOCKS`; this hook only bounds what MOUNTS from that
 *   already-loaded set.
 * - Collapse-hidden and zoomed-out-of-view rows are still included in
 *   `useViewportWindow`'s `windowedBlocks` (that hook conservatively treats
 *   any never-measured block as "in window" — see its own doc comment).
 *   Cap-excluded rows are no longer part of that over-inclusion (#2580):
 *   `BlockTree` derives `mountCapExcludedIds` from this hook's `mounted` vs.
 *   its input and passes it to `useViewportWindow` so mount-cap-excluded
 *   rows are subtracted from the window. The collapse/zoom cases remain a
 *   separate, not-yet-addressed instance of the same over-inclusion.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { FlatBlock } from '@/lib/tree-utils'

/**
 * Provisional per-page mount ceiling (#2467). Unmeasured — see file header.
 * Chosen well below the ~10K-mounted-fiber cliff the architecture review
 * flagged, and comfortably above typical page sizes so it stays invisible
 * for the vast majority of pages.
 */
export const INITIAL_MOUNT_LIMIT = 500

/** Rows revealed per `expandMountLimit()` call once the ceiling is hit. */
export const MOUNT_LIMIT_STEP = 500

export interface UseBlockMountLimitReturn {
  /** `visibleBlocks`, truncated to the current mount limit. */
  mounted: FlatBlock[]
  /** Count of `visibleBlocks` rows beyond the current mount limit. */
  hiddenCount: number
  /** Reveal (mount) the next batch of rows. */
  expandMountLimit: () => void
}

export interface UseBlockMountLimitOptions {
  /** Row-count ceiling for the first mount. Defaults to `INITIAL_MOUNT_LIMIT`. */
  initialLimit?: number
  /** Rows added per `expandMountLimit()` call. Defaults to `MOUNT_LIMIT_STEP`. */
  step?: number
  /**
   * Scope key (the page root id) — the limit resets to `initialLimit`
   * whenever this changes. BlockTree is NOT remounted on page switch (the
   * journal week/month views swap pages in place), so without this an
   * expanded limit on one large page would leak into the next page.
   * Mirrors `useBlockCollapse`'s `pageKey` reset (#752).
   */
  pageKey?: string | null
}

export function useBlockMountLimit(
  visibleBlocks: FlatBlock[],
  options: UseBlockMountLimitOptions = {},
): UseBlockMountLimitReturn {
  const { initialLimit = INITIAL_MOUNT_LIMIT, step = MOUNT_LIMIT_STEP, pageKey = null } = options

  const [mountLimit, setMountLimit] = useState(initialLimit)

  const prevPageKeyRef = useRef(pageKey)
  useEffect(() => {
    if (prevPageKeyRef.current === pageKey) return
    prevPageKeyRef.current = pageKey
    setMountLimit(initialLimit)
  }, [pageKey, initialLimit])

  const expandMountLimit = useCallback(() => {
    setMountLimit((prev) => prev + step)
  }, [step])

  const hiddenCount = Math.max(0, visibleBlocks.length - mountLimit)
  // Reference-stable when nothing is hidden — keeps identity churn out of
  // the mount-cap-free (common) case, same discipline as
  // `useBlockCollapse.visibleBlocks` returning `blocks` as-is.
  const mounted = hiddenCount > 0 ? visibleBlocks.slice(0, mountLimit) : visibleBlocks

  return { mounted, hiddenCount, expandMountLimit }
}
