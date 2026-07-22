# Session 1194 — Split-block partial-failure rollback + Enter/split race

**Date:** 2026-07-22
**Branch:** `fix/splitblock-rollback-race`
**Closes:** #2913, #2914

Two CONFIRMED split-block correctness bugs (2026-07-22 deep analysis), both in the
page-blocks store family.

## #2913 — partial-failure rollback diverged store from backend

In `splitBlock` (`page-blocks-reducers.ts`), the multi-line path runs
`edit(blockId, plan.first)`, which **durably commits** the truncated first line. If the
first `createBelow` then failed, the reducer did a **local-only `set()`** restore of
`previousContent` — the backend still held only `plan.first`, so the next `load()` (sync
tick, navigation, `blocks:changed`) silently truncated the block and lost `plan.rest`.

**Fix:** on first-create failure *after* the committed first-line edit, issue a
compensating `await get().edit(blockId, previousContent)` so store and backend
re-converge; if that also fails, fall back to `await get().load()` (exact backend
restore), mirroring `remove()`'s failure convention. Compensation fires only when the
first-line edit actually committed (an earlier `edit` failure returns before the loop);
later-iteration failures leave the partial-valid state alone. The guard was tightened
`!== undefined` → `!= null` (content is `string | null`; a splittable block always has
non-null content, so behavior is unchanged) to narrow to `string` for `edit()`.

## #2914 — Enter on multi-block content raced unawaited splitBlock vs createBelow

`handleFlush` fired an **unawaited** `splitBlock` on multi-block content, then
`handleEnterSave` immediately `createBelow`'d an empty Enter block. The split's chained
`createBelow` calls and the concurrent create each computed `siblingSlot` from overlapping
pre-await snapshots (`splitInProgress` guards only re-entrant `splitBlock`), yielding a
stray empty 4th block.

**Fix:** `useBlockFlush` publishes the in-flight split via a module-level `pendingSplits`
registry (keyed by block id, mirroring the `bumpFlushSeq`/`readFlushSeq` idiom), resolving
to the split's last-created block. `handleEnterSave` consumes it (`consumePendingSplit`),
**awaits** the split, focuses that last block, and **skips** the parallel empty-block
create. The single-block (non-split) path registers nothing → consume returns null →
falls through to the unchanged `createBelow` + focus path. The `splitBlock` param type was
tightened `=> void` → `=> Promise<boolean>` so it can be chained. Registry entries
self-clean via an identity-guarded `promise.finally`, so non-Enter flushes that register
but aren't consumed don't leak.

## Tests

`page-blocks.test.ts` (compensating-edit + load fallback for #2913) and new
`useBlockKeyboardHandlers.enter-split-race.test.ts` (#2914 final-order assertion).
Non-tautological: reverting #2913 to the local-only restore fails both new tests
(`edit {toText:'original'}` never called, `load_page_subtree` never called); reverting
#2914 to the racing path yields `['alpha','bravo','charlie','']` instead of
`['alpha','bravo','charlie']`. 300 vitest pass; tsc + oxlint clean.
