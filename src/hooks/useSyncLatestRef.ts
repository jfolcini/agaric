/**
 * useSyncLatestRef — the latest-value mirror, in one place with one argument.
 *
 * Background (#4377 phase 2). oxlint 1.79 turned on the React Compiler's
 * `react/refs` rule: 168 findings, of which 81 are the *write* half of a
 * single idiom — `xRef.current = someProp` executed at hook/component top
 * level so a later effect, event handler or plugin closure can read the
 * CURRENT value without listing it as a dependency. 72 of those 81 are
 * provably that idiom (see the call sites); this hook is where their write
 * lives, and where the argument for it is made once instead of 72 times.
 *
 * Why the write is safe — the three properties `react/refs` exists to
 * protect, stated so they can be checked rather than assumed:
 *
 *  1. **The write is idempotent.** `ref.current = value` with the same
 *     `value` leaves the ref in a state indistinguishable from before. It is
 *     not `ref.current++`, not a push, not a merge: running it twice on
 *     identical inputs is identical to running it once.
 *  2. **The value is never read during render.** Nothing here reads
 *     `ref.current`. Whether a given CALL SITE reads it during render is the
 *     call site's obligation — see the eligibility rule below.
 *  3. **StrictMode's double-invoke is therefore inert.** React runs the
 *     render body twice in development to surface impurity. By (1) the second
 *     pass writes the same value the first did, and by (2) neither pass can
 *     observe the difference. Rendered output is a function of `value`, not
 *     of when the ref happened to be written.
 *
 * ── Read this before adopting it at a new site ──────────────────────────
 *
 * This hook does not *suppress* `react/refs`; it moves the write across a
 * hook boundary, and the React Compiler's analysis stops there (it cannot see
 * through a custom hook — that is the same opacity that makes hooks the unit
 * of composition, and the same reason upstream ships `useEffectEvent`). The
 * consequence is deliberate and worth naming: **the linter can no longer
 * check these sites**, so properties (1)–(3) above are guarded by this
 * docblock, by `__tests__/useSyncLatestRef.test.ts`, and by nothing else.
 *
 * Eligibility, therefore, is not a matter of taste. A site qualifies iff its
 * ref is **never read during render** — not in the component body, not in a
 * `useMemo`, not in JSX. A ref that IS read during render is a different
 * pattern with a different proof obligation: a render-time ref reuse is safe
 * iff the gate that admits a cached entry compares every input the cached
 * value closes over. `use-block-zoom.ts`'s `rebaseCacheRef`,
 * `useUnlinkedReferences.ts`'s `carriedRef` and `usePageBrowserData.ts`'s
 * `lastGoodPagesRef` are all that second pattern; they keep their own local
 * reasoning and their own findings. Do not route them through this hook —
 * doing so would hide a real finding behind an argument that does not cover
 * it.
 *
 * Two mechanical requirements, both load-bearing:
 *
 *  - **Call it unconditionally**, at the top level of the component or hook.
 *    It calls no hooks itself, so `rules-of-hooks` will not catch a
 *    conditional call, but a mirror that skips a render is a stale mirror.
 *  - **Keep the `useRef` at the call site.** It is not an implementation
 *    detail that this hook takes the ref instead of creating and returning
 *    one. `react-hooks/exhaustive-deps` (an `error` here, unlike the
 *    warn-level React Compiler rules) recognises ref stability only from a
 *    syntactically literal `useRef(…)` in the same function. A
 *    `useLatestRef(value): RefObject<T>` that created the ref internally was
 *    measured on the full tree: it cleared 72 `react/refs` warnings and
 *    raised **68 `exhaustive-deps` errors** in their place, 44 of whose
 *    demanded dependencies were `xRef.current…` chains that cannot be added
 *    without reintroducing exactly the per-render churn the mirror exists to
 *    avoid.
 *
 * Usage:
 *   const onSelectRef = useRef(onSelect)
 *   useSyncLatestRef(onSelectRef, onSelect)
 *   // …later, inside an effect / handler / plugin closure only:
 *   onSelectRef.current(item)
 */

import type { RefObject } from 'react'

/**
 * @param ref   An identity-stable ref from a literal `useRef(…)` at the call
 *              site. Its `.current` must never be read during render.
 * @param value The value to mirror. Written on every render, so `.current`
 *              always holds the value from the most recent one.
 */
export function useSyncLatestRef<T>(ref: RefObject<T>, value: T): void {
  ref.current = value
}
