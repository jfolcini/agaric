# Session 1204 — Co-locate BlockTree-private hooks under one directory + convention

**Date:** 2026-07-23
**Branch:** `refactor/blocktree-hooks-colocate`
**Closes:** #2904

## Summary

The BlockTree-private React hooks were scattered across `src/hooks/` and `src/components/editor/`
under two naming conventions (camelCase `useBlockDnD.ts` vs the kebab-case already implicit in
`src/components/block-tree/`, e.g. `use-block-flush.ts`). This consolidates the genuinely
BlockTree-private `useBlock*` hooks into `src/components/block-tree/` with the kebab-case
convention that directory already uses. Purely mechanical, behavior-preserving — only file
location, filename, and import specifiers changed; zero hook implementation logic changed.

## The change

- **19 hooks moved** `src/hooks/` (+ `src/components/editor/`) → `src/components/block-tree/`,
  renamed to kebab-case: `useBlockActionOrchestration`, `useBlockActions`, `useBlockCollapse`,
  `useBlockContextMenu`, `useBlockDatePicker`, `useBlockDnD`, `useBlockLinkResolve`,
  `useBlockMountLimit`, `useBlockMultiSelect`, `useBlockNavigateToLink`, `useBlockProperties`,
  `useBlockResolvers`, `useBlockResolve`, `useBlockSlashCommands` (+ its private
  `useBlockSlashCommands/` submodule dir), `useBlockSwipeActions`, `useBlockTouchLongPress`,
  `useBlockTreeEventListeners`, `useBlockTreeKeyboardShortcuts`, `useBlockZoom`.
- **20 co-located `__tests__` files moved** alongside, kebab-cased. (No `axe()` audits existed in
  any of these hook tests, so none were dropped.)
- **15 importer files** had import specifiers updated (incl. `vi.mock('@/hooks/useBlock…')` mock
  specifiers, which must match the new path exactly or the mock silently stops intercepting):
  `BlockTree.tsx`, `SortableBlock.tsx`, `BlockZoomBar.tsx`, `block-context-menu/types.ts`,
  `TestBlockActionsOverride.{tsx,test.tsx}`, and 9 test files.

## Scoping (verified both directions)

**Left in `src/hooks/`** as genuinely cross-feature (consumed outside the BlockTree tree —
agenda/journal/backlinks/pages/attachments/properties): `useBlockAttachments`, `useBlockNavigation`,
`useBlockPropertyEvents`, `useBlockPropertyIpc`, `useBlockReschedule`, `useBlockTags`. Core editor
infra (`use-roving-editor.ts`, `use-block-keyboard.ts`, `use-editor-event-dispatch.ts`) also left
alone — used by 15+ modules beyond BlockTree and out of the issue's `useBlock*`-only scope.

## Verification

Independent adversarial review: byte-for-byte diff of all 19 moved hooks + the submodule against
`origin/main` — zero non-import-line changes; scoping correct both directions
(`find_referencing_symbols` on all 6 left-behind hooks = genuinely cross-feature; every moved hook
imported only by BlockTree/its tests); no stale `vi.mock` specifier for any moved hook; no dropped
`axe()` audit. `tsc -b --noEmit` clean, `check-import-cycles` **0 cycles** (1517 modules), `oxlint`
clean (no new violations), `vitest` **1467 pass** across 45 files.
