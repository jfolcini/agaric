/**
 * useGenerationGuard — race-discard pattern for stale async responses.
 *
 * Use when an effect fires async work whose response can arrive AFTER
 * a subsequent effect run has already started newer work. The classic
 * shape is a debounced search where keystroke N+1 lands while
 * keystroke N's IPC is still in flight — the older response would
 * clobber the newer one (or trigger a state update for a query the
 * user no longer cares about).
 *
 * Pattern:
 *
 *   const gen = useGenerationGuard()
 *   useEffect(() => {
 *     const id = gen.next()
 *     fetchSomething(query).then((data) => {
 *       if (!gen.isCurrent(id)) return  // stale — drop on the floor
 *       setData(data)
 *     })
 *   }, [query])
 *
 * Notes:
 *   - `next()` increments AND returns the new id in one step; do not
 *     call it twice in the same effect run.
 *   - `isCurrent(id)` returns `true` only if `id` was the most recent
 *     value returned from `next()`. On unmount, the latest id stays
 *     stable, so a late-resolving handler that races unmount will
 *     still pass the guard — combine with a separate `isMountedRef`
 *     if that matters (it usually does not, because setState on an
 *     unmounted component is a no-op in React 18+).
 *
 * PEND-73 Phase 4.M3 — extracted from CommandPalette + SearchPanel +
 * useAutocompleteSources. With Phase 2's `AbortController` plumbing
 * (PEND-73 R4) the IPC sites can drop this in favour of signal-based
 * cancellation, but the autocomplete tag-debounce path stays the
 * same shape (the debounce is the race, not the IPC), so the hook
 * earns its keep there indefinitely.
 */

import { useMemo, useRef } from 'react'

export interface GenerationGuard {
  /** Increment the internal counter and return the new id. */
  next: () => number
  /** True iff `id` is the most recent value returned from `next()`. */
  isCurrent: (id: number) => boolean
}

export function useGenerationGuard(): GenerationGuard {
  const ref = useRef(0)
  // Memoise the wrapper so consumers can safely include the returned
  // object in `useEffect` dependency arrays without triggering a
  // spurious effect re-run on every render. The closures read
  // `ref.current` lazily, so the memo's identity is independent of
  // the counter's value.
  return useMemo<GenerationGuard>(
    () => ({
      next: () => ++ref.current,
      isCurrent: (id) => id === ref.current,
    }),
    [],
  )
}
