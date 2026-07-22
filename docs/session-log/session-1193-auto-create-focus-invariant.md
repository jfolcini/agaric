# Session 1193 — Auto-create-first-block focus via setFocused (restore #2465 invariant)

**Date:** 2026-07-22
**Branch:** `fix/auto-create-focus-invariant`
**Closes:** #2915

## Summary

`use-block-auto-create-first-block.ts` set focus with a raw
`useBlockStore.setState({ focusedBlockId: result.id })`, bypassing the #2465
focus/selection invariant. A raw `setState` writes `focusedBlockId` while leaving
`selectedBlockIds` / `selectionAnchorId` / `selectionFocusId` untouched, so a stale
multi-selection could persist alongside the newly-focused block.

## The fix

One line: replace the raw `setState` with
`useBlockStore.getState().setFocused(result.id)` (blocks.ts:86-93). `setFocused`
does the single atomic write the invariant requires —
`set({ focusedBlockId, selectedBlockIds: [], selectionAnchorId: null,
selectionFocusId: null })` — clearing any prior selection as it focuses. No other
behavior changes; `result.id` is already narrowed non-null by the preceding
`if (!result?.id) return` guard.

## Tests

`use-block-auto-create-first-block.test.ts` — 7 pass. The added test seeds a stale
`selectedBlockIds` before auto-create and asserts it is cleared once the new block
is focused. Non-tautological: reverting the call to the raw `setState` fails the
new assertion with `expected [ 'STALE_1', 'STALE_2' ] to deeply equal []`.
`tsc -b --noEmit` + `oxlint` clean.
