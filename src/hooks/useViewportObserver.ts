/**
 * Viewport Intersection Observer — virtualization lite (p15-t13).
 *
 * Off-screen blocks render as empty divs with preserved height.
 * IntersectionObserver drives the visible window with a 200px
 * rootMargin buffer for smooth scrolling. Zero TipTap overhead
 * for off-screen blocks.
 *
 * API: factory-per-id. `createObserveRef(id)` returns a memoized
 * ref callback scoped to that block id. When React calls the ref
 * with `null` (unmount) we unobserve the exact element that was
 * observed for that id, so detached DOM nodes are released
 * immediately instead of lingering in the observer's internal
 * strong-ref set until the hook itself unmounts (BUG-29).
 *
 * Identity stability (#1067): off-screen membership lives in a
 * ref-backed external store, NOT React state. The returned
 * `viewport` object therefore has a permanently stable identity —
 * a scroll tick that flips block X's membership notifies only X's
 * per-id subscriber, so only X's wrapper re-renders. Previously
 * `offscreenIds` was React state that fed `isOffscreen`'s
 * `useCallback` dep, which churned the memoized `viewport` object on
 * every flip and invalidated ALL N `React.memo`'d wrappers per tick.
 *
 * Usage:
 *   const viewport = useViewportObserver()
 *   // inside a per-row component:
 *   const offscreen = useSyncExternalStore(
 *     useCallback((cb) => viewport.subscribe(id, cb), [viewport, id]),
 *     () => viewport.isOffscreen(id),
 *   )
 *   <div ref={viewport.createObserveRef(id)} data-block-id={id}>
 *     {offscreen ? <Placeholder height={viewport.getHeight(id)} /> : <Block />}
 *   </div>
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface ViewportObserver {
  /**
   * Returns a memoized ref callback scoped to `id`. Calling
   * `createObserveRef('X')` repeatedly returns the *same* function
   * reference, so React does not perceive the ref as changing and
   * won't churn observe/unobserve across renders.
   */
  createObserveRef: (id: string) => (el: HTMLElement | null) => void
  /** True if the block has been measured and is outside the viewport + margin. */
  isOffscreen: (id: string) => boolean
  /** Cached height for an off-screen block (px), or undefined if unknown. */
  getHeight: (id: string) => number | undefined
  /**
   * Subscribe to off-screen membership changes for a single block id.
   * Pairs with `isOffscreen(id)` as a `useSyncExternalStore` source so a
   * row re-renders *only* when its own membership flips (#1067). Returns an
   * unsubscribe function. The callback fires on every flip of that id's
   * off-screen state and on unmount-driven clears for that id.
   */
  subscribe: (id: string, callback: () => void) => () => void
}

export function useViewportObserver(rootMargin = '200px 0px'): ViewportObserver {
  /**
   * #1067 — off-screen membership is held in a ref, NOT React state, so it
   * never perturbs this hook's render or the memoized `viewport` identity.
   * Per-id subscribers (one `useSyncExternalStore` per mounted wrapper) are
   * notified individually, so a single block's flip re-renders only that row.
   */
  const offscreenIdsRef = useRef<Set<string>>(new Set())
  const heightsRef = useRef<Map<string, number>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)
  /** id → currently-observed element. Lets the null-transition unobserve precisely. */
  const elementsByIdRef = useRef<Map<string, HTMLElement>>(new Map())
  /** id → memoized ref callback. Guarantees stable identity per id across renders. */
  const refCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map())
  /** ids with a deferred callback-memo prune pending. Lets a re-attach cancel it. */
  const pendingPruneRef = useRef<Set<string>>(new Set())
  /** id → per-id `useSyncExternalStore` subscribers to notify on a membership flip. */
  const subscribersRef = useRef<Map<string, Set<() => void>>>(new Map())

  /** Notify only the subscribers registered for `id` (a single flipped block). */
  const notify = useCallback((id: string): void => {
    const subs = subscribersRef.current.get(id)
    if (!subs) return
    for (const cb of subs) cb()
  }, [])

  useEffect(() => {
    // Capture the (stable) pending-prune set for the cleanup closure — the ref
    // never reassigns `.current`, so this is the same Set throughout, and it
    // keeps the linter from flagging a ref read inside cleanup.
    const pendingPrune = pendingPruneRef.current
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Mutate the ref-backed membership in place and notify only the ids
        // that actually flipped. No React state → no all-rows invalidation.
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['blockId']
          if (!id) continue
          const set = offscreenIdsRef.current
          if (entry.isIntersecting && set.has(id)) {
            set.delete(id)
            notify(id)
          } else if (!entry.isIntersecting && !set.has(id)) {
            heightsRef.current.set(id, entry.boundingClientRect.height)
            set.add(id)
            notify(id)
          }
        }
      },
      { rootMargin },
    )

    // Ref callbacks run during commit, *before* this passive effect, so
    // elements mounted in the hook's first commit (or while the observer
    // is being rebuilt after a `rootMargin` change) land in
    // `elementsByIdRef` while `observerRef.current` is still null and
    // would otherwise never be observed. Catch them up here (#755).
    for (const el of elementsByIdRef.current.values()) {
      observerRef.current.observe(el)
    }

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      // Drop any deferred prunes — the whole hook is tearing down, so the
      // maps go with it; no microtask needs to fire after unmount.
      pendingPrune.clear()
    }
  }, [rootMargin, notify])

  const createObserveRef = useCallback(
    (id: string) => {
      const cached = refCallbacksRef.current.get(id)
      if (cached) return cached

      const cb = (el: HTMLElement | null): void => {
        const previous = elementsByIdRef.current.get(id)
        if (el) {
          // A re-attach: cancel any deferred callback-memo prune for this id.
          // This is what makes a transient `null` (StrictMode dev remount, keyed
          // reconciliation) safe — the element comes back synchronously, before
          // the deferred prune runs, so the memoized callback survives and its
          // identity stays stable (#838).
          pendingPruneRef.current.delete(id)
          // Defensive: if React hands us a new element without first
          // calling the ref with null for the previous one, unobserve
          // the stale element so the observer doesn't retain it.
          if (previous && previous !== el) {
            observerRef.current?.unobserve(previous)
          }
          elementsByIdRef.current.set(id, el)
          observerRef.current?.observe(el)
        } else if (previous) {
          observerRef.current?.unobserve(previous)
          elementsByIdRef.current.delete(id)
          heightsRef.current.delete(id)
          // Defer pruning the memoized callback. A synchronous `null` is NOT a
          // reliable "the block left the tree" signal: React fires el→null→el for
          // a STILL-PRESENT node under StrictMode (dev) and during keyed-list /
          // suspense reconciliation. Deleting the memo here would hand React a
          // fresh callback identity on the next render → ref churn and a broken
          // stable-identity contract (#838). Instead, schedule the prune; if the
          // element re-attaches first (the `if (el)` branch above clears the
          // pending flag), we keep the callback. Only a *genuine* unmount — no
          // re-attach by the time the microtask runs — drops the entry, which is
          // exactly when the id is truly absent from the current id set.
          pendingPruneRef.current.add(id)
          queueMicrotask(() => {
            if (!pendingPruneRef.current.delete(id)) return
            // Re-check liveness: only prune if the element is still gone.
            if (!elementsByIdRef.current.has(id)) {
              refCallbacksRef.current.delete(id)
            }
          })
          // Clear stale off-screen membership for the gone block and notify its
          // (still-mounted, if any) subscriber so its snapshot updates.
          if (offscreenIdsRef.current.delete(id)) {
            notify(id)
          }
        }
      }
      refCallbacksRef.current.set(id, cb)
      return cb
    },
    [notify],
  )

  const isOffscreen = useCallback((id: string) => offscreenIdsRef.current.has(id), [])

  const getHeight = useCallback((id: string) => heightsRef.current.get(id), [])

  const subscribe = useCallback((id: string, callback: () => void) => {
    let subs = subscribersRef.current.get(id)
    if (!subs) {
      subs = new Set()
      subscribersRef.current.set(id, subs)
    }
    subs.add(callback)
    return () => {
      const current = subscribersRef.current.get(id)
      if (!current) return
      current.delete(callback)
      if (current.size === 0) subscribersRef.current.delete(id)
    }
  }, [])

  // Memoize the returned observer object so its identity is PERMANENTLY stable
  // across renders (#1067). All four members are `[]`/`[notify]`-keyed and
  // `notify` itself is `[]`-keyed, so nothing here ever changes after the first
  // render. Off-screen membership now lives in a ref + per-id subscription
  // (useSyncExternalStore in SortableBlockWrapper), so a flip of block X
  // notifies only X's subscriber and re-renders only X's wrapper — instead of
  // churning this object's identity and invalidating ALL N `React.memo`'d
  // wrappers every scroll tick (design-system-perf-review-2026-05-09.md item 5).
  return useMemo<ViewportObserver>(
    () => ({ createObserveRef, isOffscreen, getHeight, subscribe }),
    [createObserveRef, isOffscreen, getHeight, subscribe],
  )
}
