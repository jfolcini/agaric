/**
 * useViewportWindow — narrows a page's full block list to the rows actually
 * inside the rendered viewport window, so BlockTree-level batch metadata IPCs
 * (`useExtraBlockProperties`, `useBlockLinkResolve`, the batch-attachments
 * provider) fetch for the ~visible rows instead of every block on the page
 * (#1268).
 *
 * Rendering is already windowed by `useViewportObserver`: off-screen rows
 * collapse to placeholders. But the metadata hooks received the entire
 * `blocks` list, so a single structural edit on a 10K-block page re-issued an
 * O(N) batch IPC + O(N) reconciliation for the whole page even though only the
 * viewport rows display their chips. This hook reuses the *same* viewport
 * source (no parallel windowing mechanism) to scope those fetches.
 *
 * ## Window definition (conservative, lazy-correct)
 *
 * The viewport observer only knows a block is off-screen once that block's
 * element has mounted AND the IntersectionObserver has measured it. Until then
 * the block is treated as IN the window. This is deliberately conservative:
 *
 *   windowed = { id ∈ blocks : NOT viewport.isOffscreen(id) }
 *
 * - A block that has never been measured (just mounted, fetch pending) is
 *   included → its metadata resolves immediately. No "blank chip until the
 *   observer fires" gap.
 * - A block scrolled out of view flips to off-screen → it drops from the
 *   window on the next recompute. Already-fetched data is retained by the
 *   downstream hooks' reference-stable maps (e.g. `useExtraBlockProperties`
 *   keeps prior arrays), so it isn't re-fetched and isn't lost; it just stops
 *   being part of the next IPC's id set.
 * - A block scrolled back into view flips on-screen → it re-enters the window
 *   and is re-fetched lazily. This is what makes a newly-visible block resolve.
 *
 * ## Mount-cap exclusion (#2580)
 *
 * The conservative "never-measured ⇒ in-window" rule above assumes a
 * never-measured block is merely *pending its first measurement* — it's
 * mounted, the observer just hasn't ticked yet. That assumption breaks for a
 * block `useBlockMountLimit` excluded from the mounted React tree entirely
 * (#2467's row-count ceiling): that block will NEVER mount, so it will NEVER
 * be measured, so the conservative rule would keep it "in window" forever —
 * a permanent, wasted metadata IPC for a row that isn't on the DOM.
 *
 * The optional `excludedIds` parameter lets the caller (BlockTree) name that
 * exact set — the ids the mount cap dropped — so this hook can subtract them
 * from the window regardless of `isOffscreen`:
 *
 *   windowed = { id ∈ blocks : id ∉ excludedIds AND NOT viewport.isOffscreen(id) }
 *
 * This does NOT touch the conservative rule for genuinely-mounted rows —
 * `isOffscreen` keeps meaning exactly what it meant before. `excludedIds` is
 * a caller-provided allowlist-complement layered on top, recomputed whenever
 * the caller's mounted set changes (e.g. the mount cap expands), so a row
 * that becomes newly mounted drops out of `excludedIds` and re-enters the
 * window on the very next recompute — see `useBlockMountLimit` and
 * `BlockTree`'s `mountCapExcludedIds`.
 *
 * ## Re-render scope (#1067-safe)
 *
 * Off-screen membership lives in a ref inside `useViewportObserver`; a per-id
 * flip notifies only that row. This hook subscribes to the *coalesced* global
 * window channel (`subscribeWindow` / `getWindowVersion`) so it recomputes the
 * windowed id list at most once per microtask after a scroll batch settles —
 * NOT once per flipped id, and NOT by churning every memoized row wrapper. The
 * recompute happens in a single BlockTree-level component; the resulting id
 * list is signature-guarded by the downstream batch hooks, so it only triggers
 * an IPC when the windowed *set* actually changes.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type { ViewportObserver } from './useViewportObserver'

/**
 * Returns the subset of `blocks` whose rows are currently within the rendered
 * viewport window (on-screen, or not-yet-measured). Recomputed when the page's
 * block set changes (via `blocks` identity) or when the viewport window moves.
 *
 * Generic over the block shape so it composes with whatever fields the caller
 * threads downstream (id-only for properties; id+content for link resolve).
 *
 * @param excludedIds — Optional caller-provided set of ids to force OUT of the
 * window regardless of `isOffscreen` (#2580). Intended for ids the caller
 * knows will never mount (today: rows beyond `useBlockMountLimit`'s cap) —
 * NOT a substitute for `isOffscreen`'s scroll-driven membership. Pass `null`/
 * `undefined` (or omit) for the original unscoped behavior.
 */
export function useViewportWindow<T extends { id: string }>(
  viewport: ViewportObserver,
  blocks: ReadonlyArray<T>,
  excludedIds?: ReadonlySet<string> | null,
): T[] {
  // useSyncExternalStore over the coalesced window channel: `getWindowVersion`
  // is a monotonic counter that bumps on every membership flip, so React
  // re-renders this hook's host only when the viewport window actually moved.
  const subscribe = useCallback(
    (onStoreChange: () => void) => viewport.subscribeWindow(onStoreChange),
    [viewport],
  )
  const windowVersion = useSyncExternalStore(
    subscribe,
    viewport.getWindowVersion,
    // Server snapshot (SSR / no-DOM) — version 0; the client effect catches up.
    () => 0,
  )

  return useMemo(
    () => blocks.filter((b) => !excludedIds?.has(b.id) && !viewport.isOffscreen(b.id)),
    // `windowVersion` is the membership-change SIGNAL: off-screen membership
    // lives in a ref (#1067), so it isn't read structurally here — the memo
    // must re-run when the version bumps to re-read the current ref-backed set
    // via `viewport.isOffscreen`. oxlint flags it as "unnecessary" because it's
    // not referenced in the body, but dropping it would freeze the window at
    // mount. `blocks` re-windows on page edits; `viewport` identity is
    // permanently stable (#1067). `excludedIds` re-windows when the caller's
    // mount-cap-excluded set changes (#2580) — e.g. `expandMountLimit()`
    // shrinks it, and the newly-uncapped ids must re-enter on this recompute.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- windowVersion is the intentional recompute trigger for the ref-backed off-screen set; it is read indirectly via viewport.isOffscreen, not structurally.
    [blocks, viewport, windowVersion, excludedIds],
  )
}
