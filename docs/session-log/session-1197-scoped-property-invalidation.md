# Session 1197 — Scope BlockTree batch-property invalidation to owned blocks

**Date:** 2026-07-23
**Branch:** `perf/scoped-property-invalidation`
**Closes:** #2905

## Summary

`BlockTree` folded the app-global `useBlockPropertyEvents` invalidation counter into its
`BatchPropertiesProvider` key, so a `block:properties-changed` event for ONE block
re-issued the `getBatchProperties` IPC for EVERY mounted tree — 7+ concurrent refetches in
journal week/month views for an edit that may touch none of them. This scopes the
invalidation to the tree(s) that actually own the changed block.

## The change

- **`src/hooks/useBlockPropertyEvents.ts`** — new exported hook
  `useScopedBlockPropertyEvents({ ownsBlock })` alongside the unchanged
  `useBlockPropertyEvents()`. It registers its own target on the existing shared fan-out
  dispatcher (`property-change-dispatch.ts`, #2507) and keeps a per-instance debounced
  counter (same 150ms `DEBOUNCE_MS`). Per event: `payload === undefined` (non-attributable
  / future bulk) always bumps (fail-open); otherwise it bumps only when
  `ownsBlock(payload.block_id)` is true. `ownsBlock` is read from a ref so a new callback
  identity per render doesn't re-register the listener.
- **`src/components/editor/BlockTree.tsx`** — swapped the global hook for
  `useScopedBlockPropertyEvents({ ownsBlock: (id) => storeOwnsBlock(pageStore, id) })`
  (added `storeOwnsBlock` to the existing `@/stores/page-blocks` import).

## Correctness

- Every `block:properties-changed` event carries a scalar `block_id`
  (`PropertyChangedEvent { block_id: String, changed_keys: Vec<String> }`) — verified
  across all 8 `emit_property_changed_event` call sites + the MCP write path; no bulk
  variant exists, so scoping can't silently drop an invalidation. The `undefined`-payload
  fallback covers any hypothetical non-attributable event.
- Ownership is tested against the tree's **full** `blocksById` (`storeOwnsBlock`), NOT the
  rendered/windowed subset — so an edit to an owned-but-off-window block still bumps the
  key; `BatchPropertiesProvider` purges the off-window cache entry on invalidation, so it
  re-fetches fresh on scroll-into-view (never stale).
- The 5 other consumers of the blanket `useBlockPropertyEvents()` (AgendaResults,
  DonePanel, useDuePanelData, GraphView, useSearchResults) are untouched.

## Tests

`BlockTree.scoped-property-invalidation.test.tsx` (new): owned-block event refetches;
not-owned-block event does NOT refetch (the core fix); bulk/`undefined`-payload event
still invalidates (fallback). Non-tautological: reverting BlockTree to the global hook
makes the not-owned test fail (the non-owner tree refetches). 276 vitest pass across
BlockTree/property suites; tsc + oxlint clean.
