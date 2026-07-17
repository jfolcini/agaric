# Session 1177 — Hover/focus-intent page-subtree prefetch (#2850)

## Scope

Remove the perceived load latency when opening a page: warm the page's block subtree on
navigation *intent* (hover / focus / viewport-approach) so the block tree is present on
click instead of showing the `loading: true` flash. Implements the maintainer's approved
**option (b)** from the #2850 decision comment — a one-shot speculative prefetch handoff,
**not** a persistent cache. Frontend-only; no store/op/schema/sync-type, no backend, no
`queryClient` involvement (option (a) was explicitly rejected against the read-path-only
guardrail).

## Design (option b — a handoff, not a cache)

A module-level memo parks an in-flight `loadPageSubtree` promise keyed by `(space, page)`,
consumed exactly once by the page store's `load()`. Because entries are single-consumption
and expire in seconds, no reload path can ever be served stale data and **no invalidation
wiring is needed** — the data's true lifetime is the couple of seconds between intent and
click.

- `src/lib/prefetch-page-subtree.ts` (new) — `Map<"space:page", { promise, expiresAt }>`.
  - `prefetchPageSubtree(spaceId, pageId)` — dedups a live entry; else kicks off
    `loadPageSubtree` and parks it. `PREFETCH_TTL_MS = 8000`. Concurrency bounded by
    `MAX_INFLIGHT_PREFETCHES = 4`, derived by re-scanning live entries (`countLiveEntries`)
    so there is no mutable counter to leak. A rejected speculative fetch is swallowed
    (`.catch` → warn) and simply yields a fresh fetch at `load()` time.
  - `consumePrefetchedPageSubtree(spaceId, pageId)` — returns the live promise **and
    deletes it** (single-consumption); lazily sweeps expired entries → returns null.
  - `_resetPrefetchPageSubtreeForTest()`.
- `src/hooks/usePagePrefetchIntent.ts` (new) — shared `{ schedule, cancel }` built on the
  existing `useDebouncedCallback` (`PAGE_PREFETCH_DWELL_MS = 120`); resolves `spaceId` from
  `useSpaceStore.getState()` at fire time (not hover-start).

## The one seam in `page-blocks.ts` `load()`

The only change is the *source* of the subtree:
`consumePrefetchedPageSubtree(spaceId, rootParentId) ?? loadPageSubtree(rootParentId, spaceId)`,
inside the existing `traceInteraction(PAGE_OPEN, …)`. The generation claim
(`++loadGeneration`) is taken *before* the await, so the resolved snapshot flows unchanged
through every existing guard: the `#753` load-generation guard, focused-block preservation
during sync reload, the `#798` selection prune, and the `PageNotInSpace` space-membership
rejection/heal. A prefetch warmed for a different space can never be served to a load
scoped to the active space (keys differ → null → fresh fetch); a page moved out of the
active space still hits the rejection/heal (the prefetch IPC's `PageNotInSpace` rejection
is preserved in the parked promise and re-thrown on `await`).

## Intent surfaces

Hover (`onMouseEnter`) + keyboard (`onFocus`) schedule; `onMouseLeave`/`onBlur` cancel:

- `src/components/pages/PageLink.tsx` — inline page links (backlinks, query results, tags,
  agenda — 20+ surfaces).
- `src/components/PageBrowser/DensityRow.tsx` (+ `PageBrowserRowRenderer.tsx`,
  `PageBrowser.tsx`) — Pages-list rows, plus a **mobile/no-hover** fallback reusing the
  existing `useViewportObserver` IntersectionObserver (one shared instance per list).
- `src/components/common/CommandPalette.tsx` — `onValueChange` warms only the highlighted
  `page:`/`recent:` result (arrow-key or hover); other row kinds call `cancel()`.
  Arrow-key traversal coalesces on one shared debounce timer, backstopped by the memo cap.
- `src/components/backlinks/BacklinkGroupRenderer.tsx` — reference rows key off
  `block.page_id` (the actual `handleBlockClick` navigation target), null-guarded.

## Tests

- `src/lib/__tests__/prefetch-page-subtree.test.ts` — dedup, cross-key independence,
  concurrency cap + slot release on expiry, rejection-swallowed (no unhandled rejection),
  consume-falls-back-to-null, single-consumption, TTL expiry (fake timers).
- `src/stores/__tests__/page-blocks.test.ts` — consumed prefetch skips a second IPC; falls
  through to fresh when nothing parked; unrelated page untouched; **the `#753` guard
  discards a late-resolving prefetched promise when a newer load wins**; **a prefetched
  snapshot for a page moved out of the active space still hits the `PageNotInSpace` heal**
  (asserted via IPC call counts + heal side effects: toast, tab-stack pop, recents prune).
- `PageLink` / `DensityRow` / `PageBrowserRowRenderer` test updates.

## Review & result

Reviewed by a separate stronger-model reviewer (adversarial). All six load-bearing checks
verified true — guard preservation, drift-free single-consumption, late-prefetch vs
generation-guard race, structurally-impossible concurrency-slot leak, per-surface intent
wiring, non-vacuous tests. No defects; no fixes needed. Full frontend suite **15255 tests
pass**, `tsc --noEmit -p tsconfig.app.json` exit 0, `oxlint` clean. `docs/FEATURE-MAP.md`
updated with the (correctly framed) one-shot handoff entry.

Closes #2850.
