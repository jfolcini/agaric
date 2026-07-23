# Session 1203 — Make the #713 block-ownership listener gate structural

**Date:** 2026-07-23
**Branch:** `refactor/owned-block-listener-helper`
**Closes:** #2903

## Summary

The #713 ownership gate (a non-owning BlockTree's document listener must return WITHOUT side
effects and WITHOUT `preventDefault()`, so only the tree that owns the focused block reacts)
survived only by hand-applied convention across the per-tree keydown listeners in
`useBlockTreeKeyboardShortcuts.ts`. This makes the invariant **structural** via an
`addOwnedBlockListener` helper and routes the simple single-block ownership-gated listeners
through it.

## The change (`src/stores/page-blocks.ts` + `useBlockTreeKeyboardShortcuts.ts`)

- **`addOwnedBlockListener(store, blockId, type, handler, options?)`** (co-located with
  `storeOwnsBlock`): wraps `document.addEventListener` so the handler runs only when
  `storeOwnsBlock(store, blockId)` holds; a non-owning tree (or `null` id) returns before the
  handler — no side effects, no `preventDefault()`. Returns a cleanup removing the exact
  listener. The gate id is the **caller-supplied `blockId` captured at registration** (the
  render-prop `focusedBlockId` / selection anchor), NOT a live `useBlockStore` read — mandatory,
  since the multi-tree tests gate on the render prop.
- **7 sites converted** (collapse, zoomIn, taskKey Ctrl+Enter, dateShortcut, heading,
  extendSelection Shift+Arrow, toggleSelected Ctrl+Space). Each moves the ownership gate ahead
  of its pre-gate predicates — all pure/side-effect-free — so it's observationally identical.
  The `selectedBlockIds.length === 0` guard becomes `selectedBlockIds.at(-1) ?? null` failing
  the gate.
- **4 sites left raw** (documented): Ctrl+A/clearSelection (ungated, selection-store only),
  copy/cut/paste #913 (gate is a filter over the owned SET, not one id), unfocusedEscape
  (deliberately live-reads the focused id), zoomOut Escape #774 (tie-breaks on
  `isLastInteractedTree`).

## Leak safety

Every converted `useEffect` returns the helper's cleanup with **byte-identical dependency
arrays** and unchanged add/remove timing — no listener leak across the many BlockTrees a journal
week/month mounts (the highest-risk regression, verified clean).

## Tests

New standalone `src/stores/__tests__/page-blocks-owned-listener.test.ts` (5 tests: owning→runs
with typed id, non-owning→not-called + `defaultPrevented===false`, null id→not-called, cleanup
removes, multi-tree→only owner fires+preventDefaults). Placed in a dash-named standalone file so
it does not collide with the parallel #2929 split of `page-blocks.test.ts`. Non-tautological (the
non-owning/multi-tree handlers call `preventDefault()`, so dropping the gate flips the
assertions).

## Verification

Adversarial review confirmed gate semantics, per-site behavior identity (no pre-gate side
effect), the raw-site rationale, and leak-safety (dep arrays identical). `tsc -b --noEmit` clean,
`oxlint` clean (incl. exhaustive-deps), `vitest` **64 pass** (5 new + 59 existing keyboard,
unchanged). Playwright deferred (28 GB box shared with a Rust build); the multi-tree unit test
covers the #713 invariant.
