/**
 * Viewport Intersection Observer — virtualization lite (p15-t13).
 *
 * Off-screen blocks render as empty divs with preserved height.
 * IntersectionObserver drives the visible window with a 200px
 * rootMargin buffer for smooth scrolling. Zero TipTap overhead
 * for off-screen blocks.
 *
 * A block the observer has not reported yet counts as on-screen, so a page
 * used to render every block in full once and then swap most of them for
 * placeholders (#5329). A caller that knows a row sits past its initial
 * window asks `isOffscreen(id, true)` instead and renders the placeholder
 * with a `data-placeholder` marker; a row that attaches as a placeholder is
 * seeded off-screen, so the first callback only has to hydrate the rows that
 * actually intersect. Hydration is spread over frames,
 * `HYDRATION_ROWS_PER_FRAME` rows per `requestAnimationFrame`, so a scroll
 * tick that reveals thirty rows no longer renders all thirty in one task
 * (#5330).
 *
 * API: factory-per-id. `createObserveRef(id)` returns a memoized
 * ref callback scoped to that block id. When React calls the ref
 * with `null` (unmount) we unobserve the exact element that was
 * observed for that id, so detached DOM nodes are released
 * immediately instead of lingering in the observer's internal
 * Strong-ref set until the hook itself unmounts.
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
 *     () => viewport.isOffscreen(id, pastInitialWindow),
 *   )
 *   offscreen
 *     ? <div ref={viewport.createObserveRef(id)} data-block-id={id} data-placeholder=""
 *            style={{ minHeight: viewport.getHeight(id) }} />
 *     : <div ref={viewport.createObserveRef(id)} data-block-id={id}><Block /></div>
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { scrollParentY } from '@/lib/scroll-parent'

/**
 * Rows hydrated (placeholder → full block) per animation frame (#5330). A
 * wheel tick over a 500-block page revealed ~30 rows at 2.3–4.7 ms each,
 * rendered in one task; four rows keep a frame at or under ~16 ms at 1× CPU.
 */
export const HYDRATION_ROWS_PER_FRAME = 4

export interface ViewportObserver {
  /**
   * Returns a memoized ref callback scoped to `id`. Calling
   * `createObserveRef('X')` repeatedly returns the *same* function
   * reference, so React does not perceive the ref as changing and
   * won't churn observe/unobserve across renders.
   */
  createObserveRef: (id: string) => (el: HTMLElement | null) => void
  /**
   * True if the block has been measured and is outside the viewport + margin.
   *
   * `startsOffscreen` (#5329): true for a row that mounts as a placeholder
   * because it sits past the caller's initial window. Until its element has
   * attached there is no measurement to read, so it counts as off-screen
   * rather than on-screen; once attached the usual membership applies.
   */
  isOffscreen: (id: string, startsOffscreen?: boolean) => boolean
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
  /**
   * Subscribe to *any* off-screen membership change across all blocks
   * (#1268). Unlike `subscribe(id, …)`, this fires once — coalesced into a
   * microtask — after a batch of flips settles, regardless of which ids
   * flipped. Pairs with `getWindowVersion()` as a `useSyncExternalStore`
   * source for a single BlockTree-level consumer (the metadata windowing
   * hook) that needs to recompute the visible id set when scrolling reveals
   * or hides rows. Coalescing keeps a single scroll tick (which flips many
   * ids) from firing the global subscriber N times — it fires at most once
   * per microtask. Returns an unsubscribe function. Per-id `subscribe`
   * remains the path for per-row re-renders; this does NOT replace it.
   */
  subscribeWindow: (callback: () => void) => () => void
  /**
   * Monotonic counter that increments whenever off-screen membership
   * changes (#1268). Use as the `getSnapshot` for `subscribeWindow` in
   * `useSyncExternalStore`: a stable primitive that changes iff the window
   * moved, so the consumer recomputes only on real viewport movement, not
   * on every render.
   */
  getWindowVersion: () => number
}

export function useViewportObserver(rootMargin = '200px 0px'): ViewportObserver {
  /**
   * #1067 — off-screen membership is held in a ref, NOT React state, so it
   * never perturbs this hook's render or the memoized `viewport` identity.
   * Per-id subscribers (one `useSyncExternalStore` per mounted wrapper) are
   * notified individually, so a single block's flip re-renders only that row.
   */
  const offscreenIdsRef = useRef<Set<string>>(new Set())
  /**
   * The scroll container the observer uses as its root — the nearest VERTICAL
   * scroller above a mounted row, or `null` for the viewport.
   *
   * Re-derived on every attach rather than latched on the first one. Radix's
   * `ScrollArea` viewport is `overflow-y: hidden` whenever no scrollbar is
   * enabled, and `scroll-area.tsx` hardcodes `type="hover"`, so
   * `ScrollAreaScrollbarHover` enables it on pointerenter and drops it again on
   * leave. A row attaching while it is hidden walks straight past it to
   * whatever scroller sits ABOVE it, and that answer would otherwise pin the
   * observer to the wrong box for the rest of the session with no event able to
   * correct it. The walk is one `getComputedStyle` pass per commit (see
   * `commitScrollParentRef`); only a CHANGED answer rebuilds the observer,
   * which is what makes the rebuild rare rather than the walk.
   */
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null)
  /**
   * The scroll-parent answer shared by every row attaching in the same commit
   * (#5330): the rows of one tree are siblings, so one `getComputedStyle` walk
   * stands for all of them — 500 attaches used to walk 500 times, ~110 ms.
   * Dropped on a microtask, so the next commit walks again; see `rootEl`.
   */
  const commitScrollParentRef = useRef<{ found: HTMLElement | null } | null>(null)
  const heightsRef = useRef<Map<string, number>>(new Map())
  /**
   * Rows the observer has reported intersecting but not yet flipped on-screen
   * (#5330). Drained `HYDRATION_ROWS_PER_FRAME` at a time, in report order, by
   * the frame scheduled in `scheduleHydrationFrame`.
   */
  const pendingHydrationRef = useRef<Set<string>>(new Set())
  const hydrationFrameRef = useRef<number | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  /** id → currently-observed element. Lets the null-transition unobserve precisely. */
  const elementsByIdRef = useRef<Map<string, HTMLElement>>(new Map())
  /** id → memoized ref callback. Guarantees stable identity per id across renders. */
  const refCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map())
  /** ids with a deferred callback-memo prune pending. Lets a re-attach cancel it. */
  const pendingPruneRef = useRef<Set<string>>(new Set())
  /** id → per-id `useSyncExternalStore` subscribers to notify on a membership flip. */
  const subscribersRef = useRef<Map<string, Set<() => void>>>(new Map())
  /**
   * #1268 — BlockTree-level subscribers fired (coalesced) on *any* membership
   * flip, so the metadata windowing hook can recompute the visible id set when
   * scrolling reveals/hides rows. Kept separate from the per-id `subscribers`
   * so a single block's flip still re-renders only that row (#1067).
   */
  const windowSubscribersRef = useRef<Set<() => void>>(new Set())
  /** Monotonic window-version; bumped on every membership flip (#1268). */
  const windowVersionRef = useRef(0)
  /** True while a coalesced window-notification microtask is already queued. */
  const windowNotifyScheduledRef = useRef(false)

  /**
   * Bump the window version and schedule a single coalesced notification of
   * the global window subscribers (#1268). A scroll tick flips many ids at
   * once; we want the windowing hook to recompute the visible set ONCE after
   * the batch settles, not once per flipped id. The version bumps
   * synchronously (so a `getSnapshot` read after the flip is fresh), but the
   * subscriber callbacks fire on a microtask, deduped via the scheduled flag.
   */
  const notifyWindow = useCallback((): void => {
    windowVersionRef.current += 1
    if (windowNotifyScheduledRef.current) return
    windowNotifyScheduledRef.current = true
    queueMicrotask(() => {
      windowNotifyScheduledRef.current = false
      for (const cb of windowSubscribersRef.current) cb()
    })
  }, [])

  /** Notify only the subscribers registered for `id` (a single flipped block). */
  const notify = useCallback(
    (id: string): void => {
      // Every per-id flip is also a window movement (#1268).
      notifyWindow()
      const subs = subscribersRef.current.get(id)
      if (!subs) return
      for (const cb of subs) cb()
    },
    [notifyWindow],
  )

  /**
   * Flip the queued rows on-screen, `HYDRATION_ROWS_PER_FRAME` per frame
   * (#5330). One observer callback flipped a whole scroll tick's worth of rows
   * in a single task, and each flipped row renders its full block in that same
   * task: 70–140 ms frames at 1× CPU, 1.3 s at 4×. The 200 px `rootMargin` is
   * the lead time that lets the queue drain before a row reaches the screen.
   */
  const scheduleHydrationFrame = useCallback((): void => {
    if (hydrationFrameRef.current !== null) return
    hydrationFrameRef.current = requestAnimationFrame(function drain() {
      hydrationFrameRef.current = null
      const pending = pendingHydrationRef.current
      let flipped = 0
      for (const id of pending) {
        if (flipped === HYDRATION_ROWS_PER_FRAME) break
        pending.delete(id)
        offscreenIdsRef.current.delete(id)
        notify(id)
        flipped += 1
      }
      if (pending.size > 0) hydrationFrameRef.current = requestAnimationFrame(drain)
    })
  }, [notify])

  useEffect(() => {
    // Capture the (stable) pending-prune set for the cleanup closure — the ref
    // never reassigns `.current`, so this is the same Set throughout, and it
    // keeps the linter from flagging a ref read inside cleanup.
    const pendingPrune = pendingPruneRef.current
    const pendingHydration = pendingHydrationRef.current
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Mutate the ref-backed membership in place and notify only the ids
        // that actually flipped. No React state → no all-rows invalidation.
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['blockId']
          if (!id) continue
          const set = offscreenIdsRef.current
          if (entry.isIntersecting && set.has(id)) {
            pendingHydration.add(id)
            scheduleHydrationFrame()
          } else if (!entry.isIntersecting) {
            // A row scrolled back out before its frame came up stays a placeholder.
            pendingHydration.delete(id)
            if (!set.has(id)) {
              heightsRef.current.set(id, entry.boundingClientRect.height)
              set.add(id)
              notify(id)
            }
          }
        }
      },
      { root: rootEl, rootMargin },
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
      // A rebuilt observer re-reports every element it observes, so dropping
      // the queue here loses nothing; on unmount there is nothing to flip.
      pendingHydration.clear()
      if (hydrationFrameRef.current !== null) {
        cancelAnimationFrame(hydrationFrameRef.current)
        hydrationFrameRef.current = null
      }
    }
  }, [rootMargin, notify, rootEl, scheduleHydrationFrame])

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
          // A row that attaches as a placeholder (past the initial window,
          // #5329) is off-screen until the observer's first callback says
          // otherwise. Seeding it here is what lets that callback hydrate only
          // the rows that intersect instead of flipping the rest off.
          if (el.dataset['placeholder'] !== undefined) offscreenIdsRef.current.add(id)
          if (commitScrollParentRef.current === null) {
            const found = scrollParentY(el)
            commitScrollParentRef.current = { found }
            queueMicrotask(() => {
              commitScrollParentRef.current = null
            })
            // A row that finds no scroller says nothing about the container a
            // previous row found — it may simply have mounted outside it — so
            // an empty answer never downgrades an adopted root to the viewport.
            // An unchanged one is React's own `Object.is` bail-out, not ours.
            if (found !== null) setRootEl(found)
          }
          observerRef.current?.observe(el)
        } else if (previous) {
          observerRef.current?.unobserve(previous)
          elementsByIdRef.current.delete(id)
          heightsRef.current.delete(id)
          pendingHydrationRef.current.delete(id)
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

  const isOffscreen = useCallback(
    (id: string, startsOffscreen = false) =>
      offscreenIdsRef.current.has(id) || (startsOffscreen && !elementsByIdRef.current.has(id)),
    [],
  )

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

  const subscribeWindow = useCallback((callback: () => void) => {
    windowSubscribersRef.current.add(callback)
    return () => {
      windowSubscribersRef.current.delete(callback)
    }
  }, [])

  const getWindowVersion = useCallback(() => windowVersionRef.current, [])

  // Memoize the returned observer object so its identity is PERMANENTLY stable
  // across renders (#1067). All four members are `[]`/`[notify]`-keyed and
  // `notify` itself is `[]`-keyed, so nothing here ever changes after the first
  // render. Off-screen membership now lives in a ref + per-id subscription
  // (useSyncExternalStore in SortableBlockWrapper), so a flip of block X
  // notifies only X's subscriber and re-renders only X's wrapper — instead of
  // churning this object's identity and invalidating ALL N `React.memo`'d
  // wrappers every scroll tick (design-system-perf-review-2026-05-09.md item 5).
  return useMemo<ViewportObserver>(
    () => ({
      createObserveRef,
      isOffscreen,
      getHeight,
      subscribe,
      subscribeWindow,
      getWindowVersion,
    }),
    [createObserveRef, isOffscreen, getHeight, subscribe, subscribeWindow, getWindowVersion],
  )
}
