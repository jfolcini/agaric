# Session 1020 — Keyboard multi-block selection (#922 finding 1)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#922 f1 — Shift+ArrowUp/Down extend a block selection.** Block multi-selection was mouse-only
  (Ctrl+Click / Shift+Click). Added a fixed-anchor + moving-focus range model to the block store
  (`selectionAnchorId`/`selectionFocusId` + `extendSelection(direction, visibleIds)`) mirroring
  Shift+Click range semantics, and a Shift+Arrow keydown handler in `useBlockTreeKeyboardShortcuts`.
  Growing past / shrinking back toward the anchor (and crossing it) all work; clamps at list
  edges. Gated on block-select mode (`!focusedBlockId`, Shift only, non-empty selection) + the
  #713 ownership gate. The batch-action toolbar reads `selectedBlockIds`, so it lights up with no
  extra wiring. All discrete selection paths reset the anchor so keyboard + mouse never desync.

## Tests

`extendSelection` store suite (seed/grow/shrink/cross-anchor/edge-clamp/empty/re-seed/resets);
keyboard-handler suite (direction + visibleIds, no-op when editing / empty / bad modifiers,
#713 gate). 2366 touched-area tests green; `tsc -b` clean. New e2e `block-keyboard-select.spec.ts`.
