/**
 * useDayMountWindow — bounds the set of journal days StreamView keeps
 * mounted, LRU-style (#2670).
 *
 * ## Problem
 * `StreamView` renders every loaded day through `DaySection` with
 * `lazyMount`, which defers mounting a day's `BlockTree` until it first
 * enters the viewport (`useEnteredViewport` inside `DaySection`) — but that
 * gate is one-shot and never flips back. A day scrolled past therefore keeps
 * its `BlockTree` (a live TipTap editor + ~10 document-level keydown
 * listeners, see `useBlockTreeKeyboardShortcuts`) mounted for the rest of the
 * session. `WeeklyView` uses the same one-shot gate but is bounded at 7 days;
 * `StreamView`'s day count is bounded only by `MIN_JOURNAL_DATE` — i.e. the
 * entire journal history — so a long backward-scrolling session accumulates
 * unbounded editors and listeners.
 *
 * ## What this does
 * Tracks the least-recently-visible day key(s) and caps the mounted set at
 * `windowSize`. `markVisible(key)` reports that a day's section entered the
 * viewport (called on EVERY entry, not just the first — see `DaySection`'s
 * controlled-mount path); it bumps `key` to most-recently-visible and, if the
 * mounted set now exceeds the cap, evicts the least-recently-visible day(s).
 * An evicted day's `isMounted` flips back to `false`, which `DaySection`
 * reads to unmount its `BlockTree` back to the same height-preserving
 * placeholder it uses pre-entry (no new placeholder invented) — releasing
 * the editor and its document listeners via the normal React unmount +
 * effect-cleanup path (`useBlockTreeKeyboardShortcuts` already removes its
 * listeners on unmount; nothing extra needed there).
 *
 * Because days are visited in scroll order, the mounted set naturally tracks
 * the `windowSize` days nearest the current scroll position: entering day N
 * only evicts a day once N-`windowSize` distinct days have been visited,
 * which requires the evicted day to already be well outside the viewport.
 *
 * ## Focus safety
 * An optional `canEvict` predicate lets the caller protect a day from
 * eviction (e.g. it currently has DOM focus inside it — unmounting mid-edit
 * would silently drop the cursor). When every over-the-cap candidate is
 * protected, the window is temporarily allowed to exceed `windowSize` rather
 * than evict a focused day; it settles back down once focus moves on and a
 * later `markVisible` call retries the eviction.
 *
 * ## Scope note (#2580)
 * This bounds *day-level* mounting for StreamView only. It does not touch
 * `useBlockMountLimit` (row-level mount ceiling within one page) or
 * `useViewportObserver`/`useViewportWindow` (row-level virtualization within
 * one `BlockTree`) — those already exist and are orthogonal. It also does
 * not consolidate `useBlockTreeKeyboardShortcuts`' per-tree listener count;
 * that is a separate, independent follow-up noted on #2670.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

/** Default day-count ceiling — keeps the ~10 days nearest the viewport mounted. */
export const STREAM_MOUNT_WINDOW = 10

/** Always-evict predicate used when the caller doesn't supply `canEvict`. */
function alwaysEvictable(): boolean {
  return true
}

export interface DayMountWindow {
  /** True if `key` is currently within the mounted window. */
  isMounted: (key: string) => boolean
  /**
   * Report that `key`'s day section entered the viewport. Call on every
   * entry (not just the first) — including re-entries after eviction — so
   * scrolling back to a previously-evicted day remounts it.
   */
  markVisible: (key: string) => void
}

export interface UseDayMountWindowOptions {
  /** Day-count ceiling. Defaults to `STREAM_MOUNT_WINDOW`. */
  windowSize?: number
  /**
   * Called with an eviction candidate (the least-recently-visible day still
   * over the cap); return `false` to protect it. When protected, the next
   * least-recently-visible candidate is tried instead. Defaults to always
   * evictable.
   */
  canEvict?: (key: string) => boolean
}

export function useDayMountWindow(options: UseDayMountWindowOptions = {}): DayMountWindow {
  const { windowSize = STREAM_MOUNT_WINDOW, canEvict = alwaysEvictable } = options

  /** Recency order, oldest first. Mirrors `mountedIds` 1:1 (same membership). */
  const orderRef = useRef<string[]>([])
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => new Set())

  const markVisible = useCallback(
    (key: string) => {
      const order = orderRef.current
      const idx = order.indexOf(key)
      if (idx !== -1) order.splice(idx, 1)
      order.push(key)

      setMountedIds((prev) => {
        const alreadyMounted = prev.has(key)
        // No new member and no overflow (order only grows on a brand-new
        // key) — bail with the same reference so unaffected days don't
        // re-render.
        if (alreadyMounted && order.length <= windowSize) return prev

        const next = new Set(prev)
        next.add(key)

        // Evict oldest-first until back within budget, skipping protected
        // (e.g. focused) candidates. `i` only advances past a protected
        // candidate; an evicted candidate is spliced out, shifting the rest
        // left, so `i` stays put to re-check the new element at that index.
        let i = 0
        while (order.length > windowSize && i < order.length) {
          const candidate = order[i]
          if (candidate === undefined) break
          if (canEvict(candidate)) {
            order.splice(i, 1)
            next.delete(candidate)
          } else {
            i += 1
          }
        }

        return next
      })
    },
    [windowSize, canEvict],
  )

  const isMounted = useCallback((key: string) => mountedIds.has(key), [mountedIds])

  return useMemo(() => ({ isMounted, markVisible }), [isMounted, markVisible])
}
