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
 * Applies a row-count ceiling AFTER the caller's collapse/zoom filtering,
 * using the exact same
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

import { useCallback, useEffect, useState } from 'react'

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

export interface UseBlockMountLimitReturn<L extends FlatBlock[] = FlatBlock[]> {
  /** `visibleBlocks`, truncated to the current mount limit. */
  mounted: L
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
   * Scope key (normally the page root id; BlockTree also includes its active
   * zoom root) — the limit resets to `initialLimit` whenever this changes.
   * BlockTree is NOT remounted on page/zoom navigation, so without this an
   * expanded limit in one projection would leak into the next one. Mirrors
   * `useBlockCollapse`'s page-scoped reset (#752).
   */
  pageKey?: string | null
}

/**
 * #3344 — generic in the ARRAY type, not just the element type, so the
 * zoom-scope brand (`ZoomedBlocks`, see `use-block-zoom.ts`) survives the cap:
 * BlockTree feeds this the zoom projection and needs the capped result to stay
 * a legal argument for the command-path hooks. `L` is inferred from the
 * argument, so this propagates a brand it is given and can never mint one —
 * passing an un-scoped list still yields an un-scoped list.
 */
export function useBlockMountLimit<L extends FlatBlock[]>(
  visibleBlocks: L,
  options: UseBlockMountLimitOptions = {},
): UseBlockMountLimitReturn<L> {
  const { initialLimit = INITIAL_MOUNT_LIMIT, step = MOUNT_LIMIT_STEP, pageKey = null } = options

  const [mountScope, setMountScope] = useState(() => ({ pageKey, limit: initialLimit }))

  // A changed scope must use the initial cap during the render that observes
  // it. Waiting for the effect below would commit one render with the previous
  // scope's expanded limit, briefly mounting the very rows this envelope is
  // meant to keep out of the React tree.
  const mountLimit = mountScope.pageKey === pageKey ? mountScope.limit : initialLimit
  useEffect(() => {
    if (mountScope.pageKey === pageKey) return
    setMountScope({ pageKey, limit: initialLimit })
  }, [mountScope.pageKey, pageKey, initialLimit])

  const expandMountLimit = useCallback(() => {
    setMountScope((previous) => ({
      pageKey,
      limit: (previous.pageKey === pageKey ? previous.limit : initialLimit) + step,
    }))
  }, [initialLimit, pageKey, step])

  const hiddenCount = Math.max(0, visibleBlocks.length - mountLimit)
  // Reference-stable when nothing is hidden — keeps identity churn out of
  // the mount-cap-free (common) case, same discipline as
  // `useBlockCollapse.visibleBlocks` returning `blocks` as-is.
  // The truncation is a NARROWING of `visibleBlocks` — every element came from
  // it — so re-asserting `L` preserves whatever contract the input carried.
  const mounted = (hiddenCount > 0 ? visibleBlocks.slice(0, mountLimit) : visibleBlocks) as L

  return { mounted, hiddenCount, expandMountLimit }
}
